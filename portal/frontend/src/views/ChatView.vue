<script setup lang="ts">
import { ElButton } from 'element-plus';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { bytesBase64, extractDocument, isDocument, readBase64, rejectLegacyDocument } from '../lib/documentAttachments';
import { useAuthStore } from '../stores/auth';
import { useFileDrop } from '../lib/useFileDrop';
import StreamingText from '../components/StreamingText.vue';
import StationShell from '../components/StationShell.vue';
interface Conversation { id: string; title: string }
interface Attachment { name: string; mime_type: string; data_base64: string; warnings?: string[] }
interface Message { id: string; role: string; content: string; attachments?: { name: string; size: number }[] }
const auth = useAuthStore(); const route = useRoute(); const router = useRouter(); const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const conversations = ref<Conversation[]>([]); const messages = ref<Message[]>([]); const selected = ref('');
const pending = ref<Message[]>([]), generating = ref(false), incomplete = ref(false);
const streamEl = ref<HTMLElement|null>(null);
let follow = true;
function trackScroll() { const el = streamEl.value; if (el) follow = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }
watch(() => [messages.value.length, pending.value.at(-1)?.content], async () => { await nextTick(); if (follow && streamEl.value) streamEl.value.scrollTop = streamEl.value.scrollHeight; });
function stop() { controller.abort(); }
const draft = ref(''); const files = ref<Attachment[]>([]); const error = ref(''); const busy = ref(false); const reading = ref(false);
let epoch = 0; let controller = new AbortController(); let retry: { fingerprint: string; id: string } | undefined;
const fileDrop = useFileDrop(addFiles, () => busy.value || reading.value, message => { error.value = message; });
const base = '/api/chat/conversations';
const accept = '.txt,.md,.csv,.js,.html,.css,.json,.xml,.png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.pptx';
function reset() { pending.value = []; generating.value = false; incomplete.value = false; follow = true; fileDrop.reset(); epoch++; controller.abort(); controller = new AbortController(); selected.value = ''; messages.value = []; draft.value = ''; files.value = []; error.value = ''; busy.value = false; reading.value = false; retry = undefined; }
async function refreshList(token: number) { const result = await api<{ conversations: Conversation[] }>(base, { signal: controller.signal }); if (token === epoch) conversations.value = result.conversations; }
async function open() {
  const id = typeof route.params.id === 'string' ? route.params.id : '';
  if (id && id === selected.value) return;
  reset(); const token = epoch; selected.value = id;
  if (!auth.user) { conversations.value = []; return; }
  busy.value = true;
  try {
    await refreshList(token);
    if (id && token === epoch) { const result = await api<{ messages: Message[] }>(`${base}/${encodeURIComponent(id)}`, { signal: controller.signal }); if (token === epoch) messages.value = result.messages; }
  } catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
watch(() => [auth.user?.id, route.params.id], (_value, old) => { if (old && old[0] !== auth.user?.id) { reset(); conversations.value = []; } void open(); }, { immediate: true, flush: 'sync' });
async function choose(event: Event) { const value = (event.target as HTMLSelectElement).value; await router.push(value ? `/chat/${encodeURIComponent(value)}` : '/chat'); }
async function newChat() { if (busy.value) return; if (route.params.id) await router.push('/chat'); else reset(); }
function fileType(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = { txt:'text/plain',md:'text/markdown',csv:'text/csv',js:'text/javascript',html:'text/html',css:'text/css',json:'application/json',xml:'application/xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp' };
  return types[ext ?? ''] ?? file.type;
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement; const chosen = Array.from(input.files ?? []); input.value = '';
  await addFiles(chosen);
}
async function addFiles(chosen: File[]) {
  if (!chosen.length || reading.value || busy.value) return;
  const token = epoch; reading.value = true; error.value = '';
  try {
    if (files.value.length + chosen.length > 5) throw new Error('最多 5 个文件 / Maximum 5 files');
    const allowed = new Set(['text/plain','text/markdown','text/csv','text/javascript','text/html','text/css','application/json','application/xml','text/xml','image/png','image/jpeg','image/webp']);
    const attachments: Attachment[] = [];
    // Sequential extraction bounds uploads and checks account/navigation cancellation between files.
    const signal = controller.signal;
    for (const f of chosen) {
      signal.throwIfAborted();
      rejectLegacyDocument(f.name);
      if (isDocument(f.name)) {
        const extracted = await extractDocument(f, signal);
        attachments.push({ name: f.name, mime_type: 'text/plain', data_base64: bytesBase64(new TextEncoder().encode(extracted.text)), warnings: extracted.warnings });
      } else {
        if (f.size > 1024 * 1024) throw new Error('文本或图片单个最多 1 MiB / Maximum text/image size: 1 MiB');
        if (!allowed.has(fileType(f))) throw new Error('暂不支持此文件格式 / Unsupported file format');
        attachments.push({ name: f.name, mime_type: fileType(f), data_base64: await readBase64(f) });
      }
    }
    const byteLength = (f: Attachment) => Math.floor(f.data_base64.length * 3 / 4) - (f.data_base64.endsWith('==') ? 2 : f.data_base64.endsWith('=') ? 1 : 0);
    if ([...files.value, ...attachments].reduce((sum, f) => sum + byteLength(f), 0) > 4 * 1024 * 1024) throw new Error('附件提取后总计最多 4 MiB / Maximum extracted total: 4 MiB');
    if (token === epoch) files.value.push(...attachments);
  } catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) reading.value = false; }
}
async function send() {
  if (busy.value || reading.value || (!draft.value.trim() && !files.value.length)) return;
  const token = epoch; busy.value = true; generating.value = true; incomplete.value = false; error.value = ''; pending.value = [];
  const content = draft.value; const attachments = files.value.slice();
  const fingerprint = JSON.stringify({ content, attachments });
  if (retry?.fingerprint !== fingerprint) retry = { fingerprint, id: crypto.randomUUID() };
  const request_id = retry.id;
  let committed = false;
  try {
    if (!selected.value) {
      const result = await api<{ conversation: Conversation }>(base, { method: 'POST', signal: controller.signal, body: '{}' });
      if (token !== epoch) return;
      selected.value = result.conversation.id; conversations.value.unshift(result.conversation);
      await router.replace(`/chat/${encodeURIComponent(selected.value)}`);
    }
    if (token !== epoch) return;
    pending.value = [{ id: 'pending-user', role: 'user', content, attachments: attachments.map(f => ({name:f.name,size:0})) }, {id:'pending-assistant',role:'assistant',content:''}];
    follow = true;
    const completed = await api<{ messages: Message[] }>(`${base}/${encodeURIComponent(selected.value)}/messages`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ content, attachments, request_id }) }, delta => { if (token === epoch && pending.value[1]) pending.value[1].content += delta; });
    if (token !== epoch) return;
    committed = true; generating.value = false;
    const savedIds = new Set(completed.messages.map(message => message.id));
    messages.value = [...messages.value.filter(message => !savedIds.has(message.id)), ...completed.messages];
    pending.value = [];
    draft.value = ''; files.value = []; retry = undefined;
    // Reload canonical history: a retry may have been committed before the browser lost its response.
    const result = await api<{ messages: Message[] }>(`${base}/${encodeURIComponent(selected.value)}`, { signal: controller.signal });
    if (token === epoch) { messages.value = result.messages; pending.value = []; }
    await refreshList(token);
  } catch (e) { if (token === epoch) { incomplete.value = !committed; if (!pending.value[1]?.content) pending.value = []; error.value = controller.signal.aborted ? (en.value ? 'Stopped' : '已停止') : (e as Error).message; } }
  finally { if (token === epoch) { busy.value = false; generating.value = false; if (controller.signal.aborted) controller = new AbortController(); } }
}
onUnmounted(reset);
</script>
<template>
  <StationShell area="chat">
  <div class="station-chat file-drop-region flex h-screen flex-col" :class="{ 'file-dragging': fileDrop.dragging.value }" v-on="fileDrop.events">
    <div v-if="fileDrop.dragging.value" class="file-drop-overlay" role="status">{{ en ? 'Drop files to attach' : '松开鼠标，添加附件' }}</div>
    <header class="station-header flex flex-wrap items-center gap-3">
      <div><h1>{{ en ? 'AI conversation' : 'AI 对话' }}</h1></div><span class="flex-1"></span>
    </header>
    <main class="chat-main mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 overflow-hidden px-4 py-5">
      <div class="flex gap-3">
        <ElButton native-type="submit" class="station-secondary rounded-xl px-4 py-2 disabled:opacity-40" :disabled="busy" @click="newChat">{{ en ? 'New chat' : '新对话' }}</ElButton>
        <select :value="selected" :disabled="busy" :aria-label="en ? 'Conversation history' : '历史对话'" class="chat-history min-w-0 flex-1 rounded-xl px-3" @change="choose"><option value="">{{ en ? 'New conversation' : '新的对话' }}</option><option v-for="c in conversations" :key="c.id" :value="c.id">{{ c.title || (en ? 'Untitled conversation' : '未命名对话') }}</option></select>
      </div>
      <section ref="streamEl" @scroll="trackScroll" class="chat-stream min-h-0 flex-1 space-y-4 overflow-auto" aria-live="polite" :aria-busy="busy">
        <div v-if="!messages.length && !pending.length" class="chat-empty"><h2>{{ en ? 'New conversation' : '新对话' }}</h2></div>
        <article v-for="message in [...messages, ...pending]" :key="message.id" class="chat-message rounded-2xl p-5" :class="message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'">
          <h3 class="mb-2 text-sm font-semibold">{{ message.role === 'user' ? (en ? 'You' : '你') : 'FDE Station' }}</h3>
          <StreamingText :text="message.content" :active="generating && message.id === 'pending-assistant'" /><span v-if="incomplete && message.id === 'pending-assistant'" class="text-xs text-black/50">{{en ? 'Incomplete' : '未完成'}}</span>
          <ul v-if="message.attachments?.length" class="mt-2 text-sm text-black/60"><li v-for="(f, index) in message.attachments" :key="index">📎 {{ f.name }}</li></ul>
        </article>
        <p v-if="busy && !pending[1]?.content" role="status" class="text-black/60">{{ en ? 'Please wait…' : '请稍候…' }}</p>
      </section>
      <form class="station-composer space-y-3 rounded-2xl p-4" @submit.prevent="send">
        <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
        <ul v-if="files.length" class="flex flex-wrap gap-2"><li v-for="(f,index) in files" :key="index" class="rounded bg-black/5 px-2 py-1 text-sm">📎 {{ f.name }} <ElButton native-type="button" :disabled="busy || reading" :aria-label="`${en ? 'Remove' : '移除'} ${f.name}`" @click="files.splice(index,1)">×</ElButton></li></ul>
        <p v-for="warning in files.flatMap(file => (file.warnings ?? []).map(w => `${file.name}: ${w}`))" :key="warning" role="status" class="text-sm text-amber-700">{{ warning }}</p>
        <textarea v-model="draft" :disabled="busy" maxlength="100000" rows="3" :aria-label="en ? 'Message' : '消息'" :placeholder="en ? 'Write a message…' : '输入消息…'" class="w-full resize-none bg-transparent p-1 outline-none"></textarea>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <label class="station-secondary cursor-pointer rounded-lg px-3 py-2 text-sm">{{ reading ? (en ? 'Reading…' : '读取中…') : (en ? 'Attach files' : '上传文件') }}<input type="file" multiple :accept="accept" :disabled="busy || reading" class="sr-only" @change="upload" /></label>
          <ElButton v-if="generating" native-type="button" @click="stop">{{en ? 'Stop' : '停止'}}</ElButton>
          <ElButton v-else native-type="submit" class="station-primary rounded-xl px-5 py-2 text-white disabled:opacity-40" :disabled="busy || reading || (!draft.trim() && !files.length)">{{ en ? 'Send' : '发送' }}</ElButton>
        </div>
      </form>
    </main>
  </div>
  </StationShell>
</template>
