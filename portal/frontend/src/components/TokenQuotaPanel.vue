<script setup lang="ts">
import { ElButton } from 'element-plus';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
type Quota = {daily_limit:number;used:number;reserved:number;remaining:number;requests:{id:string;requested_limit:number;status:string}[]};
const props = defineProps<{ embedded?: boolean }>();
const auth = useAuthStore();
const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const open = ref(!!props.embedded), quota = ref<Quota|null>(null), error = ref(''), busy = ref(false), requested = ref(4000000), reason = ref(''), sent = ref(false);
let epoch = 0;
let controller = new AbortController();
const percent = computed(() => !quota.value ? 0 : quota.value.daily_limit === 0 ? 100 : Math.min(100, Math.max(0, (quota.value.used + quota.value.reserved) / quota.value.daily_limit * 100)));
async function refresh(token: number) {
  const data = await api<Quota>('/api/me/token-quota', { signal: controller.signal });
  if (token === epoch) { quota.value = data; requested.value = Math.max(data.daily_limit + 1000000, 4000000); }
}
async function load() {
  controller.abort(); controller = new AbortController(); const token = ++epoch;
  quota.value = null; reason.value = ''; sent.value = false; error.value = ''; busy.value = false;
  if (!auth.user || !open.value) return;
  busy.value = true;
  try { await refresh(token); } catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
async function show() { open.value = !open.value; await load(); }
async function submit() {
  if (busy.value) return;
  const token = epoch; busy.value = true; error.value = '';
  try { await api('/api/me/token-quota', {method:'POST', signal:controller.signal, body:JSON.stringify({requested_limit:requested.value,reason:reason.value})}); if (token !== epoch) return; sent.value = true; await refresh(token); }
  catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
watch(() => auth.user?.id, load, { immediate: true });
onUnmounted(() => { epoch++; controller.abort(); });
</script>
<template>
  <div class="quota-panel" :class="{ 'quota-embedded': embedded }">
    <ElButton native-type="submit" v-if="!embedded" class="station-secondary" @click="show">{{ en ? 'My token quota' : '我的 Token 额度' }}</ElButton>
    <section v-if="open" class="console-card">
      <div class="card-heading"><div><h2>{{ en ? 'Daily token usage' : '每日 Token 额度' }}</h2></div><ElButton native-type="submit" class="station-secondary" :disabled="busy" @click="load">{{ en ? 'Refresh' : '刷新' }}</ElButton></div>
      <p v-if="error" role="alert" class="console-error">{{ error }}</p><p v-if="busy" role="status" class="muted">{{ en ? 'Loading…' : '正在加载…' }}</p>
      <template v-if="quota">
        <div class="quota-total"><strong>{{ quota.used.toLocaleString() }}</strong><span>/ {{ quota.daily_limit.toLocaleString() }} Tokens</span></div>
        <div class="quota-meter" role="progressbar" :aria-label="en ? 'Daily quota used and reserved' : '今日已使用及预留额度'" :aria-valuenow="percent" :aria-valuemin="0" :aria-valuemax="100"><span :style="{ width: `${percent}%` }"></span></div>
        <div class="quota-facts"><p>{{ en ? 'Remaining' : '剩余额度' }} <strong>{{ quota.remaining.toLocaleString() }}</strong></p><p>{{ en ? 'Reserved' : '调用中预留' }} <strong>{{ quota.reserved.toLocaleString() }}</strong></p></div>
        <div class="quota-request"><h3>{{ en ? 'Quota request' : '额度申请' }}</h3>
          <p v-if="quota.requests.some(r => r.status === 'pending')" class="console-note" role="status">{{ en ? 'Your upgrade request is awaiting administrator approval.' : '额度升级申请已提交，等待管理员审批。' }}</p>
          <form v-else class="assignment-form" @submit.prevent="submit"><div class="form-grid"><label class="settings-field">{{ en ? 'Requested daily limit' : '申请每日上限' }}<input v-model.number="requested" class="settings-select" type="number" :min="quota.daily_limit+1" max="1000000000" required :disabled="busy"></label><label class="settings-field">{{ en ? 'Reason' : '申请原因' }}<textarea v-model="reason" class="settings-select" maxlength="2000" required :disabled="busy" :placeholder="en ? 'Describe your project needs' : '说明项目需要及使用场景'" /></label></div><ElButton native-type="submit" class="station-primary" :disabled="busy">{{ en ? 'Request higher limit' : '申请提高额度' }}</ElButton></form>
          <p v-if="sent" role="status" class="console-success">{{ en ? 'Request submitted' : '申请已提交' }}</p>
        </div>
        <div v-if="quota.requests.length" class="request-history"><h3>{{ en ? 'Recent requests' : '最近申请' }}</h3><div v-for="r in quota.requests.slice(0,3)" :key="r.id" class="setting-row"><strong>{{ Number(r.requested_limit).toLocaleString() }} Tokens</strong><span class="status-pill">{{ r.status==='approved' ? (en ? 'Approved' : '已批准') : r.status==='rejected' ? (en ? 'Rejected' : '已拒绝') : (en ? 'Pending' : '待审批') }}</span></div></div>
      </template>
    </section>
  </div>
</template>
