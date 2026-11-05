<script setup lang="ts">
import {
  ElButton,
  ElInput,
  ElCard,
  ElProgress,
  ElStatistic,
  ElForm,
  ElFormItem,
  ElTag,
  ElAlert,
} from "element-plus";
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
type Quota = {
  daily_limit: number;
  used: number;
  reserved: number;
  remaining: number;
  requests: { id: string; requested_limit: number; status: string }[];
};
const props = defineProps<{ embedded?: boolean }>();
const auth = useAuthStore();
const { locale } = useI18n();
const en = computed(() => locale.value === "en");
const open = ref(!!props.embedded),
  quota = ref<Quota | null>(null),
  error = ref(""),
  busy = ref(false),
  requested = ref(4000000),
  reason = ref(""),
  sent = ref(false);
let epoch = 0;
let controller = new AbortController();
const percent = computed(() =>
  !quota.value
    ? 0
    : quota.value.daily_limit === 0
      ? 100
      : Math.min(
          100,
          Math.max(
            0,
            ((quota.value.used + quota.value.reserved) /
              quota.value.daily_limit) *
              100,
          ),
        ),
);
async function refresh(token: number) {
  const data = await api<Quota>("/api/me/token-quota", {
    signal: controller.signal,
  });
  if (token === epoch) {
    quota.value = data;
    requested.value = Math.max(data.daily_limit + 1000000, 4000000);
  }
}
async function load() {
  controller.abort();
  controller = new AbortController();
  const token = ++epoch;
  quota.value = null;
  reason.value = "";
  sent.value = false;
  error.value = "";
  busy.value = false;
  if (!auth.user || !open.value) return;
  busy.value = true;
  try {
    await refresh(token);
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) busy.value = false;
  }
}
async function show() {
  open.value = !open.value;
  await load();
}
async function submit() {
  if (busy.value) return;
  const token = epoch;
  busy.value = true;
  error.value = "";
  try {
    await api("/api/me/token-quota", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        requested_limit: requested.value,
        reason: reason.value,
      }),
    });
    if (token !== epoch) return;
    sent.value = true;
    await refresh(token);
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) busy.value = false;
  }
}
watch(() => auth.user?.id, load, { immediate: true });
onUnmounted(() => {
  epoch++;
  controller.abort();
});
</script>
<template>
  <div class="quota-panel" :class="{ 'quota-embedded': embedded }">
    <ElButton v-if="!embedded" @click="show">{{
      en ? "My token quota" : "我的 Token 额度"
    }}</ElButton>
    <ElCard v-if="open" shadow="never" class="quota-card">
      <template #header
        ><div class="quota-heading">
          <div>
            <small>TOKEN USAGE</small>
            <h2>{{ en ? "Daily token usage" : "每日 Token 额度" }}</h2>
          </div>
          <ElButton :loading="busy" @click="load">{{
            en ? "Refresh" : "刷新"
          }}</ElButton>
        </div></template
      >
      <ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
      <p v-if="busy" role="status">{{ en ? "Loading…" : "正在加载…" }}</p>
      <template v-if="quota">
        <div class="quota-overview">
          <ElProgress
            type="dashboard"
            :percentage="percent"
            :width="150"
            :stroke-width="10"
            :color="percent > 90 ? '#e89549' : '#365cf5'"
            :aria-label="
              en ? 'Daily quota used and reserved' : '今日已使用及预留额度'
            "
          />
          <div class="quota-stats">
            <ElStatistic
              :title="en ? 'Used today' : '今日已用'"
              :value="quota.used"
            /><ElStatistic
              :title="en ? 'Daily limit' : '每日上限'"
              :value="quota.daily_limit"
            /><ElStatistic
              :title="en ? 'Remaining' : '剩余额度'"
              :value="quota.remaining"
            /><ElStatistic
              :title="en ? 'Reserved' : '调用中预留'"
              :value="quota.reserved"
            />
          </div>
        </div>
        <div class="quota-request">
          <h3>{{ en ? "Request a higher limit" : "申请提高额度" }}</h3>
          <ElAlert
            v-if="quota.requests.some((r) => r.status === 'pending')"
            :title="
              en
                ? 'Your upgrade request is awaiting administrator approval.'
                : '额度升级申请已提交，等待管理员审批。'
            "
            type="info"
            :closable="false"
            show-icon
          />
          <ElForm v-else label-position="top" @submit.prevent="submit"
            ><div class="quota-form">
              <ElFormItem :label="en ? 'Requested daily limit' : '申请每日上限'"
                ><ElInput
                  v-model.number="requested"
                  type="number"
                  :min="quota.daily_limit + 1"
                  max="1000000000"
                  required
                  :disabled="busy" /></ElFormItem
              ><ElFormItem :label="en ? 'Reason' : '申请原因'"
                ><ElInput
                  v-model="reason"
                  type="textarea"
                  :rows="3"
                  maxlength="2000"
                  show-word-limit
                  required
                  :disabled="busy"
                  :placeholder="
                    en
                      ? 'Describe your project needs'
                      : '说明项目需要及使用场景'
                  "
              /></ElFormItem>
            </div>
            <ElButton native-type="submit" type="primary" :loading="busy">{{
              en ? "Request higher limit" : "申请提高额度"
            }}</ElButton></ElForm
          >
          <ElAlert
            v-if="sent"
            :title="en ? 'Request submitted' : '申请已提交'"
            type="success"
            :closable="false"
          />
        </div>
        <div v-if="quota.requests.length" class="request-history">
          <h3>{{ en ? "Recent requests" : "最近申请" }}</h3>
          <div
            v-for="r in quota.requests.slice(0, 3)"
            :key="r.id"
            class="request-row"
          >
            <strong
              >{{ Number(r.requested_limit).toLocaleString() }} Tokens</strong
            ><ElTag
              :type="
                r.status === 'approved'
                  ? 'success'
                  : r.status === 'rejected'
                    ? 'danger'
                    : 'warning'
              "
              >{{
                r.status === "approved"
                  ? en
                    ? "Approved"
                    : "已批准"
                  : r.status === "rejected"
                    ? en
                      ? "Rejected"
                      : "已拒绝"
                    : en
                      ? "Pending"
                      : "待审批"
              }}</ElTag
            >
          </div>
        </div>
      </template>
    </ElCard>
  </div>
</template>
<style scoped>
.quota-card {
  border-radius: 18px;
}
.quota-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.quota-heading small {
  font-size: 10px;
  letter-spacing: 1.5px;
  color: #8b99af;
}
.quota-heading h2 {
  margin: 6px 0 0;
  font-size: 18px;
}
.quota-overview {
  display: flex;
  align-items: center;
  gap: 32px;
  padding: 24px 0;
}
.quota-stats {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}
.quota-request,
.request-history {
  border-top: 1px solid #edf0f6;
  padding-top: 24px;
  margin-top: 8px;
}
h3 {
  font-size: 14px;
  margin: 0 0 20px;
  color: #4d5c73;
}
.quota-form {
  display: grid;
  grid-template-columns: minmax(140px, 0.7fr) minmax(0, 1.3fr);
  gap: 20px;
}
.request-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid #f0f2f7;
  font-size: 13px;
}
@media (max-width: 600px) {
  .quota-overview {
    flex-direction: column;
    gap: 12px;
  }
  .quota-stats {
    width: 100%;
  }
  .quota-form {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
