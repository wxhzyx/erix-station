<script setup lang="ts">
import { ElButton, ElInput, ElAlert } from "element-plus";
// 「＋ 新建目录」modal（自 SidebarPanel 内联表单迁出）：遮罩 + 居中 dialog，不再挤在侧栏头部。
// 「＋ 新建目录」modal（自 SidebarPanel 内联表单迁出）：遮罩 + 居中 dialog，不再挤在侧栏头部。
// 逻辑不变：DIR_NAME_RE 客户端校验 + store.createDir（服务端校验 + mkdir + 建首个会话）。
// 契约：emits created(sessionId) / close；错误展示在 modal 内，失败不关窗（可改名字重试）。
// 交互对齐 SessionPickerModal：Esc/点遮罩关闭、焦点进 dialog 归还触发按钮、锁背景滚动。
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkbenchStore } from "../stores/workbench";
import ModalShell from "./ModalShell.vue";

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*；代码注释保持中文原文）。
const { t } = useI18n();
const store = useWorkbenchStore();
const emit = defineEmits<{
  (e: "created", sessionId: string): void;
  (e: "close"): void;
}>();

// ---- 表单状态（原 SidebarPanel 内联表单逐字平移）----
const newDirName = ref("");
const newDirError = ref("");
const submitting = ref(false);
async function onSubmit() {
  if (submitting.value) return;
  newDirError.value = "";
  submitting.value = true;
  try {
    const { error, session } = await store.createDir(newDirName.value.trim());
    if (error) {
      newDirError.value = error;
      return;
    }
    if (session) emit("created", String(session.id)); // 路由 push 由视图统一处理
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <ModalShell :label="t('sidebar.newDirOption')" @close="emit('close')">
    <header class="panel-dialog-header">
      <div class="folder-mark" aria-hidden="true">＋</div>
      <h2>{{ t("sidebar.newDirTitle") }}</h2>
      <ElButton
        text
        circle
        :aria-label="t('common.close')"
        @click="emit('close')"
        >×</ElButton
      >
    </header>
    <form class="directory-form" novalidate @submit.prevent="onSubmit">
      <label for="newDirName">{{ t("sidebar.newDirLabel") }}</label>
      <ElInput
        id="newDirName"
        v-model="newDirName"
        required
        maxlength="63"
        :disabled="submitting"
        :placeholder="t('sidebar.newDirPlaceholder')"
        size="large"
      />
      <ElAlert
        v-if="newDirError"
        :title="newDirError"
        type="error"
        :closable="false"
        show-icon
        role="alert"
      />
      <footer>
        <ElButton @click="emit('close')">{{ t("common.cancel") }}</ElButton
        ><ElButton
          native-type="submit"
          type="primary"
          :loading="submitting"
          :disabled="submitting"
          >{{ t("common.create") }}</ElButton
        >
      </footer>
    </form>
  </ModalShell>
</template>

<style scoped>
.panel-dialog-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 24px;
  border-bottom: 1px solid #edf0f6;
}
.panel-dialog-header h2 {
  flex: 1;
  font-size: 17px;
  font-weight: 650;
  margin: 0;
}
.folder-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  background: #edf1ff;
  color: #365cf5;
  border-radius: 11px;
  font-size: 22px;
}
.directory-form {
  padding: 24px;
  display: grid;
  gap: 16px;
}
.directory-form label {
  font-size: 13px;
  font-weight: 550;
}
.directory-form footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
