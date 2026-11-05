<script setup lang="ts">
import { ElButton, ElInput, ElAlert, ElTag } from "element-plus";
// composer（旧 #composer 平移）：发送/停止/禁用逻辑、Enter 发送（Shift+Enter 换行）。
// 失败回填输入与 llm_not_configured 409 指引在 store.send() 内（逐行平移）。
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useAuthStore } from "../stores/auth";
import { useFileDrop } from "../lib/useFileDrop";
import { readWorkFiles } from "../lib/workAttachments";
import { useI18n } from "vue-i18n";
import { useWorkbenchStore } from "../stores/workbench";

// issue #101 P2：用户可见文案走 i18n（composer.*；占位符来自 store.inputPlaceholder）。
const { t } = useI18n();
const store = useWorkbenchStore();
const auth = useAuthStore();
const uploadError = ref("");
const readingFiles = ref(false);
const fileDrop = useFileDrop(
  addFiles,
  () => store.sendDisabled || readingFiles.value,
  (message) => {
    uploadError.value = message;
  },
);
const attachmentLimitError = computed(() =>
  store.pendingAttachments.length > 8 ||
  store.pendingAttachments.reduce(
    (sum, file) => sum + new TextEncoder().encode(file.text).length,
    0,
  ) > 262144
    ? "取回的文件超出单次发送限制（8 个 / 256 KiB）。文件仍保留，请移除部分附件后分批发送。"
    : "",
);
let mounted = true;
let readGeneration = 0;
let readController = new AbortController();
watch(
  () => [auth.user?.id, store.sessionId, store.dirCwd],
  () => {
    fileDrop.reset();
    readGeneration++;
    readController.abort();
    readController = new AbortController();
    readingFiles.value = false;
    uploadError.value = "";
  },
  { flush: "sync" },
);
onBeforeUnmount(() => {
  mounted = false;
  readGeneration++;
  readController.abort();
});
async function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  await addFiles(files);
}
async function addFiles(files: File[]) {
  if (!files.length || readingFiles.value || store.sendDisabled) return;
  const generation = ++readGeneration;
  const owner = auth.user?.id;
  const sid = store.sessionId;
  const cwd = store.dirCwd;
  readingFiles.value = true;
  uploadError.value = "";
  try {
    const attachments = await readWorkFiles(
      files,
      store.pendingAttachments,
      readController.signal,
    );
    if (
      mounted &&
      generation === readGeneration &&
      owner === auth.user?.id &&
      sid === store.sessionId &&
      cwd === store.dirCwd
    )
      store.pendingAttachments = attachments;
  } catch (error) {
    if (mounted && generation === readGeneration)
      uploadError.value =
        error instanceof Error ? error.message : "文件读取失败";
  } finally {
    if (mounted && generation === readGeneration) readingFiles.value = false;
  }
}

// issue #370：运行中说话（转向 / 排队）与队列条。空值提交由 store 兜底，按钮 disable 只是体验层。

function onKeydown(event: Event | KeyboardEvent) {
  const e = event as KeyboardEvent;
  if (readingFiles.value) return;
  if (e.key !== "Enter") return;
  if (e.altKey) {
    // issue #370：Alt+Enter = 排队（照 pi ChatInput 的 alt+Enter → followUp）。必须先于 Shift 判：
    // 三键组合里 Alt 的语义要唯一，否则 macOS 上 Option+Enter 会落进「换行」那一支。
    e.preventDefault();
    void store.sendQueued("follow_up");
    return;
  }
  if (e.shiftKey) return; // 原生换行
  e.preventDefault();
  // issue #370：运行中 Enter = 转向，空闲 Enter = 发送。⚠ 这里选的只是**动作**（调哪个 action），
  // 「入队还是直发」的最终裁决永远在后端那个事务里（见 store.sendQueued 的注释）——前端判错
  // 最坏结果是多一次网络往返，绝不会把消息判丢。
  if (store.running) void store.sendQueued("steer");
  else void store.send();
}
</script>
<template>
  <div
    class="work-input-area file-drop-region"
    :class="{ 'file-dragging': fileDrop.dragging.value }"
    v-on="fileDrop.events"
  >
    <div v-if="fileDrop.dragging.value" class="file-drop-overlay" role="status">
      松开鼠标，添加附件
    </div>
    <div class="composer-card">
      <div class="work-attachments">
        <ElTag
          v-for="(file, index) in store.pendingAttachments"
          :key="index"
          type="info"
          >{{ file.name }}
          <ElButton
            text
            size="small"
            :disabled="store.sendDisabled || readingFiles"
            :aria-label="`移除 ${file.name}`"
            @click="store.pendingAttachments.splice(index, 1)"
            >×</ElButton
          ></ElTag
        >
      </div>
      <ElAlert
        v-if="attachmentLimitError || uploadError"
        :title="attachmentLimitError || uploadError"
        type="error"
        :closable="false"
        role="alert"
      />
      <p
        v-for="warning in store.pendingAttachments.flatMap((file) =>
          (file.warnings ?? []).map((w) => `${file.name}: ${w}`),
        )"
        :key="warning"
        class="attachment-warning"
        role="status"
      >
        {{ warning }}
      </p>
      <p v-if="readingFiles" role="status" class="attachment-warning">
        正在准备附件…
      </p>
      <ElInput
        v-model="store.inputValue"
        type="textarea"
        :rows="3"
        :placeholder="store.inputPlaceholder"
        :disabled="store.noDir"
        @keydown="onKeydown"
      />
      <div class="composer-toolbar">
        <label class="attachment-control"
          >＋ 上传文件<input
            aria-label="上传工作文件"
            type="file"
            multiple
            :disabled="store.sendDisabled || readingFiles"
            @change="selectFiles"
            class="sr-only"
        /></label>
        <div class="composer-actions">
          <ElButton
            v-if="
              !store.inputValue.trim() &&
              !store.pendingAttachments.length &&
              !store.running &&
              store.retryAvailable
            "
            :disabled="store.retryInFlight || readingFiles"
            @click="store.retryLast()"
            >{{ t("composer.retry") }}</ElButton
          >
          <template v-if="store.running"
            ><ElButton
              type="primary"
              data-queued-kind="steer"
              :disabled="
                (!store.inputValue.trim() &&
                  !store.pendingAttachments.length) ||
                store.sendDisabled ||
                readingFiles
              "
              :title="t('composer.steerHint')"
              @click="store.sendQueued('steer')"
              >{{ t("composer.steer") }}</ElButton
            ><ElButton
              data-queued-kind="follow_up"
              :disabled="
                (!store.inputValue.trim() &&
                  !store.pendingAttachments.length) ||
                store.sendDisabled ||
                readingFiles
              "
              :title="t('composer.followUpHint')"
              @click="store.sendQueued('follow_up')"
              >{{ t("composer.followUp") }}</ElButton
            ></template
          >
          <ElButton
            v-else
            type="primary"
            data-queued-kind="send"
            :disabled="store.sendDisabled || readingFiles"
            @click="store.send()"
            >{{ t("composer.send") }}</ElButton
          ><ElButton
            v-if="store.running"
            type="danger"
            plain
            @click="store.stop()"
            >{{ t("composer.stop") }}</ElButton
          >
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>
.file-drop-region {
  position: relative;
}
.file-drop-overlay {
  position: absolute;
  inset: 10px;
  z-index: 60;
  display: grid;
  place-items: center;
  border: 2px dashed #365cf5;
  border-radius: 18px;
  background: #eef2ffed;
  color: #365cf5;
  font-weight: 650;
  pointer-events: none;
}
.file-dragging {
  outline: 2px solid #365cf5;
  outline-offset: -2px;
}

.work-input-area {
  padding: 14px 22px 20px;
  background: #f7f9fd;
}
.composer-card {
  padding: 14px 16px;
  border: 1px solid #dfe5f0;
  border-radius: 18px;
  background: white;
  box-shadow: 0 8px 24px #24365a08;
}
.composer-card :deep(.el-textarea__inner) {
  box-shadow: none;
  resize: vertical;
  max-height: 240px;
  padding: 4px 0;
}
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
}
.composer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.composer-actions .el-button {
  margin: 0;
}
.attachment-control {
  font-size: 12px;
  color: #72839d;
  cursor: pointer;
  padding: 7px 9px;
  border-radius: 8px;
}
.attachment-control:hover {
  background: #f1f4fb;
}
.attachment-control:focus-within {
  outline: 2px solid #365cf5;
}
.work-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.attachment-warning {
  font-size: 12px;
  color: #a57422;
  margin: 6px 0;
}
@media (max-width: 600px) {
  .work-input-area {
    padding: 10px;
  }
  .composer-toolbar {
    align-items: flex-start;
  }
  .composer-actions {
    justify-content: flex-end;
  }
}
</style>
