<script setup lang="ts">
import { ElButton, ElInput, ElTabs, ElTabPane, ElAlert } from "element-plus";
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
import ModalShell from "./ModalShell.vue";
import ProjectApprovalPanel from "./ProjectApprovalPanel.vue";
const props = defineProps<{
  cwd: string;
  initialTab?: "submit" | "history" | "versions";
}>();
const emit = defineEmits<{ (event: "close"): void }>();
const { locale } = useI18n();
const en = computed(() => locale.value === "en");
const auth = useAuthStore();
const tab = ref(props.initialTab ?? "submit");
const source = ref("");
const target = ref("");
const busy = ref(false);
const error = ref("");
const submitted = ref(false);
let epoch = 0;
const controller = new AbortController();
async function submit() {
  if (busy.value || !source.value.trim() || !target.value.trim()) return;
  if (source.value.trim() === target.value.trim()) {
    error.value = en.value
      ? "Choose different source and target branches."
      : "来源分支与目标分支不能相同。";
    return;
  }
  const token = epoch;
  busy.value = true;
  error.value = "";
  try {
    await api("/api/project-approvals", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        cwd: props.cwd,
        source_ref: source.value.trim(),
        target_ref: target.value.trim(),
      }),
    });
    if (token === epoch) {
      submitted.value = true;
      source.value = "";
      target.value = "";
      tab.value = "history";
    }
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) busy.value = false;
  }
}
watch(
  () => auth.user?.id,
  (_id, previous) => {
    if (previous) {
      epoch++;
      controller.abort();
      emit("close");
    }
  },
);
onUnmounted(() => {
  epoch++;
  controller.abort();
});
</script>

<template>
  <ModalShell
    :label="en ? 'Project approvals' : '项目审批'"
    dialog-class="approval-dialog"
    @close="emit('close')"
  >
    <header class="approval-dialog-header">
      <div>
        <small>{{ en ? "PROJECT DELIVERY" : "项目交付" }}</small>
        <h2>{{ cwd.split("/").pop() }}</h2>
        <p>{{ cwd }}</p>
      </div>
      <ElButton
        text
        circle
        :aria-label="en ? 'Close' : '关闭'"
        @click="emit('close')"
        >×</ElButton
      >
    </header>
    <div class="approval-dialog-body">
      <ElTabs v-model="tab" :aria-label="en ? 'Approval sections' : '审批功能'"
        ><ElTabPane
          v-for="item in ['submit', 'history', 'versions'] as const"
          :key="item"
          :name="item"
          :disabled="busy"
          :label="
            item === 'submit'
              ? en
                ? 'Request approval'
                : '发起审批'
              : item === 'history'
                ? en
                  ? 'History'
                  : '审批记录'
                : en
                  ? 'Versions'
                  : '合并版本'
          "
      /></ElTabs>
      <form
        v-if="tab === 'submit'"
        class="approval-request-form"
        @submit.prevent="submit"
      >
        <div class="branch-flow">
          <label
            >{{ en ? "Source branch" : "来源分支"
            }}<ElInput
              v-model="source"
              name="source_ref"
              required
              maxlength="200"
              :disabled="busy"
              :placeholder="en ? 'Branch to review' : '需要审查的分支'"
              size="large" /></label
          ><span aria-hidden="true">→</span
          ><label
            >{{ en ? "Target branch" : "合并目标分支"
            }}<ElInput
              v-model="target"
              name="target_ref"
              required
              maxlength="200"
              :disabled="busy"
              :placeholder="en ? 'Target branch' : '合并到哪个分支'"
              size="large"
          /></label>
        </div>
        <ElAlert
          v-if="error"
          :title="error"
          type="error"
          :closable="false"
          role="alert"
        />
        <ElButton
          native-type="submit"
          type="primary"
          :loading="busy"
          :disabled="busy || !source.trim() || !target.trim()"
          >{{
            busy
              ? en
                ? "Submitting…"
                : "提交中…"
              : en
                ? "Request approval"
                : "发起审批"
          }}</ElButton
        >
      </form>
      <template v-else
        ><ElAlert
          v-if="submitted"
          :title="en ? 'Request submitted' : '审批已提交'"
          type="success"
          :closable="false"
          role="status" /><ProjectApprovalPanel
          :key="tab"
          :cwd="cwd"
          :versions="tab === 'versions'"
      /></template>
    </div>
  </ModalShell>
</template>

<style scoped>
.approval-dialog-header {
  padding: 24px 28px 20px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  border-bottom: 1px solid #e9edf5;
}
.approval-dialog-header small {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: #8a97b0;
}
.approval-dialog-header h2 {
  font-size: 22px;
  margin: 7px 0;
}
.approval-dialog-header p {
  font-size: 12px;
  color: #8a96a9;
  margin: 0;
  overflow-wrap: anywhere;
}
.approval-dialog-body {
  padding: 8px 28px 28px;
}
.approval-request-form {
  display: grid;
  justify-items: start;
  gap: 24px;
  padding: 26px 0;
}
.branch-flow {
  display: grid;
  grid-template-columns: 1fr 24px 1fr;
  gap: 20px;
  align-items: center;
  width: 100%;
}
.branch-flow label {
  display: grid;
  gap: 10px;
  font-size: 13px;
  font-weight: 550;
}
.branch-flow > span {
  margin-top: 25px;
  color: #94a0b8;
}
.approval-dialog-body .el-alert {
  margin-bottom: 16px;
}
@media (max-width: 600px) {
  .branch-flow {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .branch-flow > span {
    display: none;
  }
  .approval-dialog-body {
    padding: 8px 18px 20px;
  }
}
</style>
