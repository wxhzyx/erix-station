<script setup lang="ts">
import { ATTACHMENT_LIMITS } from "../lib/attachmentLimits";
import { ElButton, ElInput, ElTag, ElAlert } from "element-plus";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { api } from "../api";
import {
  bytesBase64,
  extractDocument,
  isDocument,
  readBase64,
  rejectLegacyDocument,
} from "../lib/documentAttachments";
import { useAuthStore } from "../stores/auth";
import { useFileDrop } from "../lib/useFileDrop";
import StreamingText from "../components/StreamingText.vue";
import StationShell from "../components/StationShell.vue";
interface Conversation {
  id: string;
  title: string;
}
interface Attachment {
  name: string;
  mime_type: string;
  data_base64: string;
  warnings?: string[];
}
interface Message {
  id: string;
  role: string;
  content: string;
  attachments?: { name: string; size: number }[];
}
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const { locale } = useI18n();
const en = computed(() => locale.value === "en");
const conversations = ref<Conversation[]>([]);
const messages = ref<Message[]>([]);
const selected = ref("");
const pending = ref<Message[]>([]),
  generating = ref(false),
  incomplete = ref(false);
const streamEl = ref<HTMLElement | null>(null);
let follow = true;
function trackScroll() {
  const el = streamEl.value;
  if (el) follow = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
watch(
  () => [messages.value.length, pending.value.at(-1)?.content],
  async () => {
    await nextTick();
    if (follow && streamEl.value)
      streamEl.value.scrollTop = streamEl.value.scrollHeight;
  },
);
function stop() {
  controller.abort();
}
const fileInput = ref<HTMLInputElement | null>(null);
const draft = ref("");
const files = ref<Attachment[]>([]);
const error = ref("");
const busy = ref(false);
const reading = ref(false);
let epoch = 0;
let controller = new AbortController();
let retry: { fingerprint: string; id: string } | undefined;
const fileDrop = useFileDrop(
  addFiles,
  () => busy.value || reading.value,
  (message) => {
    error.value = message;
  },
);
const base = "/api/chat/conversations";
const accept =
  ".txt,.md,.csv,.js,.html,.css,.json,.xml,.png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.pptx";
function reset() {
  pending.value = [];
  generating.value = false;
  incomplete.value = false;
  follow = true;
  fileDrop.reset();
  epoch++;
  controller.abort();
  controller = new AbortController();
  selected.value = "";
  messages.value = [];
  draft.value = "";
  files.value = [];
  error.value = "";
  busy.value = false;
  reading.value = false;
  retry = undefined;
}
async function refreshList(token: number) {
  const result = await api<{ conversations: Conversation[] }>(base, {
    signal: controller.signal,
  });
  if (token === epoch) conversations.value = result.conversations;
}
async function open() {
  const id = typeof route.params.id === "string" ? route.params.id : "";
  if (id && id === selected.value) return;
  reset();
  const token = epoch;
  selected.value = id;
  if (!auth.user) {
    conversations.value = [];
    return;
  }
  busy.value = true;
  try {
    await refreshList(token);
    if (id && token === epoch) {
      const result = await api<{ messages: Message[] }>(
        `${base}/${encodeURIComponent(id)}`,
        { signal: controller.signal },
      );
      if (token === epoch) messages.value = result.messages;
    }
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) busy.value = false;
  }
}
watch(
  () => [auth.user?.id, route.params.id],
  (_value, old) => {
    if (old && old[0] !== auth.user?.id) {
      reset();
      conversations.value = [];
    }
    void open();
  },
  { immediate: true, flush: "sync" },
);
async function newChat() {
  if (busy.value) return;
  if (route.params.id) await router.push("/chat");
  else reset();
}
function fileType(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    js: "text/javascript",
    html: "text/html",
    css: "text/css",
    json: "application/json",
    xml: "application/xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  return types[ext ?? ""] ?? file.type;
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const chosen = Array.from(input.files ?? []);
  input.value = "";
  await addFiles(chosen);
}
async function addFiles(chosen: File[]) {
  if (!chosen.length || reading.value || busy.value) return;
  const token = epoch;
  reading.value = true;
  error.value = "";
  try {
    if (files.value.length + chosen.length > ATTACHMENT_LIMITS.count)
      throw new Error("最多 10 个文件 / Maximum 10 files");
    const allowed = new Set([
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/javascript",
      "text/html",
      "text/css",
      "application/json",
      "application/xml",
      "text/xml",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    const attachments: Attachment[] = [];
    // Sequential extraction bounds uploads and checks account/navigation cancellation between files.
    const signal = controller.signal;
    for (const f of chosen) {
      signal.throwIfAborted();
      rejectLegacyDocument(f.name);
      if (isDocument(f.name)) {
        const extracted = await extractDocument(f, signal);
        attachments.push({
          name: f.name,
          mime_type: "text/plain",
          data_base64: bytesBase64(new TextEncoder().encode(extracted.text)),
          warnings: extracted.warnings,
        });
      } else {
        if (f.size > ATTACHMENT_LIMITS.fileBytes)
          throw new Error(
            "文本或图片单个最多 10 MiB / Maximum text/image size: 10 MiB",
          );
        if (!allowed.has(fileType(f)))
          throw new Error("暂不支持此文件格式 / Unsupported file format");
        attachments.push({
          name: f.name,
          mime_type: fileType(f),
          data_base64: await readBase64(f),
        });
      }
    }
    const byteLength = (f: Attachment) =>
      Math.floor((f.data_base64.length * 3) / 4) -
      (f.data_base64.endsWith("==") ? 2 : f.data_base64.endsWith("=") ? 1 : 0);
    if (
      [...files.value, ...attachments].reduce(
        (sum, f) => sum + byteLength(f),
        0,
      ) >
      ATTACHMENT_LIMITS.totalBytes
    )
      throw new Error(
        "附件提取后总计最多 100 MiB / Maximum extracted total: 100 MiB",
      );
    if (token === epoch) files.value.push(...attachments);
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) reading.value = false;
  }
}
async function send() {
  if (
    busy.value ||
    reading.value ||
    (!draft.value.trim() && !files.value.length)
  )
    return;
  const token = epoch;
  busy.value = true;
  generating.value = true;
  incomplete.value = false;
  error.value = "";
  pending.value = [];
  const content = draft.value;
  const attachments = files.value.slice();
  const fingerprint = JSON.stringify({ content, attachments });
  if (retry?.fingerprint !== fingerprint)
    retry = { fingerprint, id: crypto.randomUUID() };
  const request_id = retry.id;
  let committed = false;
  try {
    if (!selected.value) {
      const result = await api<{ conversation: Conversation }>(base, {
        method: "POST",
        signal: controller.signal,
        body: "{}",
      });
      if (token !== epoch) return;
      selected.value = result.conversation.id;
      conversations.value.unshift(result.conversation);
      await router.replace(`/chat/${encodeURIComponent(selected.value)}`);
    }
    if (token !== epoch) return;
    pending.value = [
      {
        id: "pending-user",
        role: "user",
        content,
        attachments: attachments.map((f) => ({ name: f.name, size: 0 })),
      },
      { id: "pending-assistant", role: "assistant", content: "" },
    ];
    follow = true;
    const completed = await api<{ messages: Message[] }>(
      `${base}/${encodeURIComponent(selected.value)}/messages`,
      {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ content, attachments, request_id }),
      },
      (delta) => {
        if (token === epoch && pending.value[1])
          pending.value[1].content += delta;
      },
    );
    if (token !== epoch) return;
    committed = true;
    generating.value = false;
    const savedIds = new Set(completed.messages.map((message) => message.id));
    messages.value = [
      ...messages.value.filter((message) => !savedIds.has(message.id)),
      ...completed.messages,
    ];
    pending.value = [];
    draft.value = "";
    files.value = [];
    retry = undefined;
    // Reload canonical history: a retry may have been committed before the browser lost its response.
    const result = await api<{ messages: Message[] }>(
      `${base}/${encodeURIComponent(selected.value)}`,
      { signal: controller.signal },
    );
    if (token === epoch) {
      messages.value = result.messages;
      pending.value = [];
    }
    await refreshList(token);
  } catch (e) {
    if (token === epoch) {
      incomplete.value = !committed;
      if (!pending.value[1]?.content) pending.value = [];
      error.value = controller.signal.aborted
        ? en.value
          ? "Stopped"
          : "已停止"
        : (e as Error).message;
    }
  } finally {
    if (token === epoch) {
      busy.value = false;
      generating.value = false;
      if (controller.signal.aborted) controller = new AbortController();
    }
  }
}
onUnmounted(reset);
</script>
<template>
  <StationShell area="chat"
    ><div
      class="chat-workspace file-drop-region"
      :class="{ 'file-dragging': fileDrop.dragging.value }"
      v-on="fileDrop.events"
    >
      <div
        v-if="fileDrop.dragging.value"
        class="file-drop-overlay"
        role="status"
      >
        {{ en ? "Drop files to attach" : "松开鼠标，添加附件" }}
      </div>
      <aside class="conversation-sidebar">
        <div class="conversation-sidebar-title">
          <h2>{{ en ? "Conversations" : "对话" }}</h2>
          <ElTag size="small" type="info" round>{{
            conversations.length
          }}</ElTag>
        </div>
        <ElButton type="primary" plain :disabled="busy" @click="newChat"
          >＋ {{ en ? "New chat" : "新对话" }}</ElButton
        >
        <nav :aria-label="en ? 'Conversation history' : '历史对话'">
          <ElButton
            v-for="c in conversations"
            :key="c.id"
            :class="{ selected: selected === c.id }"
            text
            :disabled="busy"
            @click="router.push(`/chat/${encodeURIComponent(c.id)}`)"
            >{{
              c.title || (en ? "Untitled conversation" : "未命名对话")
            }}</ElButton
          >
        </nav>
      </aside>
      <main class="chat-canvas">
        <header class="chat-topbar">
          <div>
            <h1>
              {{
                conversations.find((c) => c.id === selected)?.title ||
                (en ? "New conversation" : "新的对话")
              }}
            </h1>
          </div>
          <ElTag effect="plain" round>{{
            en ? "Chat mode" : "聊天模式"
          }}</ElTag>
        </header>
        <section
          ref="streamEl"
          @scroll="trackScroll"
          class="chat-stream"
          aria-live="polite"
          :aria-busy="busy"
        >
          <div v-if="!messages.length && !pending.length" class="chat-welcome">
            <div class="chat-mark">✳</div>
            <h2>{{ en ? "What’s on your mind?" : "今天，有什么新想法？" }}</h2>
          </div>
          <article
            v-for="message in [...messages, ...pending]"
            :key="message.id"
            class="conversation-message"
            :class="{ 'from-user': message.role === 'user' }"
          >
            <div class="message-avatar">
              {{ message.role === "user" ? "U" : "✳" }}
            </div>
            <div class="message-body">
              <h3>
                {{
                  message.role === "user" ? (en ? "You" : "你") : "FDE Station"
                }}
              </h3>
              <StreamingText
                :text="message.content"
                :active="generating && message.id === 'pending-assistant'"
              /><ElTag
                v-if="incomplete && message.id === 'pending-assistant'"
                type="warning"
                >{{ en ? "Incomplete" : "未完成" }}</ElTag
              >
              <div class="message-files">
                <ElTag
                  v-for="(f, index) in message.attachments"
                  :key="index"
                  type="info"
                  >{{ f.name }}</ElTag
                >
              </div>
            </div>
          </article>
          <p
            v-if="busy && !pending[1]?.content"
            role="status"
            class="chat-wait"
          >
            {{ en ? "Please wait…" : "请稍候…" }}
          </p>
        </section>
        <div class="chat-compose-wrap">
          <form class="chat-compose" @submit.prevent="send">
            <ElAlert
              v-if="error"
              :title="error"
              type="error"
              :closable="false"
              role="alert"
            />
            <div class="message-files">
              <ElTag v-for="(f, index) in files" :key="index"
                >{{ f.name }}
                <ElButton
                  text
                  size="small"
                  :disabled="busy || reading"
                  :aria-label="`${en ? 'Remove' : '移除'} ${f.name}`"
                  @click="files.splice(index, 1)"
                  >×</ElButton
                ></ElTag
              >
            </div>
            <p
              v-for="warning in files.flatMap((file) =>
                (file.warnings ?? []).map((w) => `${file.name}: ${w}`),
              )"
              :key="warning"
              role="status"
              class="file-warning"
            >
              {{ warning }}
            </p>
            <ElInput
              v-model="draft"
              type="textarea"
              :rows="3"
              :disabled="busy"
              maxlength="100000"
              :aria-label="en ? 'Message' : '消息'"
              :placeholder="en ? 'Write a message…' : '输入消息…'"
            />
            <div class="chat-compose-actions">
              <ElButton
                :disabled="busy || reading"
                :loading="reading"
                @click="fileInput?.click()"
                >＋ {{ en ? "Attach files" : "上传文件" }}</ElButton
              ><input
                ref="fileInput"
                type="file"
                multiple
                :accept="accept"
                :disabled="busy || reading"
                class="sr-only"
                @change="upload"
              /><ElButton v-if="generating" type="danger" plain @click="stop">{{
                en ? "Stop" : "停止"
              }}</ElButton
              ><ElButton
                v-else
                type="primary"
                native-type="submit"
                :loading="busy"
                :disabled="busy || reading || (!draft.trim() && !files.length)"
                >{{ en ? "Send" : "发送" }} ↑</ElButton
              >
            </div>
          </form>
        </div>
      </main>
    </div></StationShell
  >
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

.chat-workspace {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: #f7f9fd;
  color: #25314a;
}
.conversation-sidebar {
  width: 250px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 28px 16px;
  background: #f0f3fa;
  border-right: 1px solid #e1e7f1;
  gap: 20px;
}
.conversation-sidebar-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.conversation-sidebar h2 {
  font-size: 16px;
  font-weight: 650;
}
.conversation-sidebar nav {
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.conversation-sidebar nav .el-button {
  margin: 0;
  justify-content: flex-start;
  height: auto;
  min-height: 42px;
  text-align: left;
  white-space: nowrap;
}
.conversation-sidebar nav .selected {
  background: white;
  color: #365cf5;
  box-shadow: 0 2px 8px #182a4710;
}
.conversation-sidebar nav .el-button :deep(> span) {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-note {
  margin-top: auto;
  font-size: 12px;
  color: #8995a9;
}
.chat-canvas {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.chat-topbar {
  padding: 22px 36px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #e8ecf3;
  background: white;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 2px;
  font-weight: 700;
  color: #8c99ae;
}
.chat-topbar h1 {
  font-size: 18px;
  font-weight: 650;
  margin-top: 6px;
}
.chat-stream {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 28px max(24px, calc((100% - 820px) / 2));
}
.chat-welcome {
  min-height: 300px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  text-align: center;
}
.chat-mark {
  width: 72px;
  height: 72px;
  border-radius: 24px;
  background: #e9edff;
  color: #365cf5;
  font-size: 44px;
  margin-bottom: 24px;
}
.chat-welcome h2 {
  font-size: 30px;
  font-weight: 700;
  margin: 12px 0;
}
.chat-welcome p {
  color: #8290a7;
  font-size: 14px;
}
.conversation-message {
  display: flex;
  gap: 14px;
  margin: 12px 0 28px;
}
.message-avatar {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  background: #e6eaff;
  color: #365cf5;
  border-radius: 12px;
  font-weight: 700;
}
.message-body {
  min-width: 0;
  flex: 1;
  padding: 4px 0;
}
.message-body h3 {
  font-size: 12px;
  font-weight: 650;
  color: #8290a7;
  margin-bottom: 10px;
}
.message-body p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.9;
}
.from-user .message-body {
  background: white;
  padding: 16px 20px;
  border: 1px solid #e7ecf4;
  border-radius: 0 18px 18px 18px;
}
.from-user .message-avatar {
  background: #dde5f0;
  color: #5a6b84;
}
.message-files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0;
}
.chat-compose-wrap {
  padding: 12px 28px 18px;
  max-width: 880px;
  width: 100%;
  margin: auto;
}
.chat-compose {
  background: white;
  border: 1px solid #dce3ef;
  border-radius: 20px;
  padding: 14px;
  box-shadow: 0 8px 30px #25365a08;
}
.chat-compose :deep(.el-textarea__inner) {
  box-shadow: none;
  resize: vertical;
  max-height: 240px;
  padding: 6px;
}
.chat-compose-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 12px;
}
.attachment-note {
  font-size: 10px;
  text-align: center;
  color: #99a3b4;
  line-height: 1.7;
  margin: 10px 10px 0;
}
.file-warning {
  color: #b7791c;
  font-size: 12px;
}
.chat-wait {
  color: #8090a8;
  font-size: 13px;
}
@media (max-width: 900px) {
  .conversation-sidebar {
    width: 190px;
  }
  .chat-topbar {
    padding: 18px 22px;
  }
}
@media (max-width: 650px) {
  .conversation-sidebar {
    width: 100%;
    padding: 10px 16px;
    flex-direction: row;
    border-bottom: 1px solid #e1e7f1;
    align-items: center;
    gap: 12px;
  }
  .conversation-sidebar-title,
  .sidebar-note {
    display: none;
  }
  .conversation-sidebar nav {
    flex: 1;
    flex-direction: row;
    overflow: auto;
  }
  .conversation-sidebar nav .el-button {
    white-space: nowrap;
  }
  .chat-workspace {
    flex-direction: column;
  }
  .chat-welcome {
    min-height: 190px;
  }
  .chat-welcome h2 {
    font-size: 23px;
  }
  .chat-compose-wrap {
    padding: 10px 14px;
  }
  .chat-topbar {
    padding: 12px 18px;
  }
  .chat-stream {
    padding: 16px;
  }
}
</style>
