<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { bytesBase64, extractDocument, isDocument, readBase64, rejectLegacyDocument } from '../lib/documentAttachments';
import { useAuthStore } from '../stores/auth';
import StationModeSwitch from '../components/StationModeSwitch.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import TokenQuotaPanel from '../components/TokenQuotaPanel.vue';
interface Conversation { id: string; title: string }
interface Attachment { name: string; mime_type: string; data_base64: string; warnings?: string[] }
interface Message { id: string; role: string; content: string; attachments?: { name: string; size: number }[] }
const auth = useAuthStore(); const route = useRoute(); const router = useRouter(); const { locale, t } = useI18n();
const en = computed(() => locale.value === 'en');
const conversations = ref<Conversation[]>([]); const messages = ref<Message[]>([]); const selected = ref('');
const draft = ref(''); const files = ref<Attachment[]>([]); const error = ref(''); const busy = ref(false); const reading = ref(false);
let epoch = 0; let controller = new AbortController(); let retry: { fingerprint: string; id: string } | undefined;
const base = '/api/chat/conversations';
const accept = '.txt,.md,.csv,.js,.html,.css,.json,.xml,.png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.pptx';
function reset() { epoch++; controller.abort(); controller = new AbortController(); selected.value = ''; messages.value = []; draft.value = ''; files.value = []; error.value = ''; busy.value = false; reading.value = false; retry = undefined; }
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
  const token = epoch; busy.value = true; error.value = '';
  const content = draft.value; const attachments = files.value.slice();
  const fingerprint = JSON.stringify({ content, attachments });
  if (retry?.fingerprint !== fingerprint) retry = { fingerprint, id: crypto.randomUUID() };
  const request_id = retry.id;
  try {
    if (!selected.value) {
      const result = await api<{ conversation: Conversation }>(base, { method: 'POST', signal: controller.signal, body: '{}' });
      if (token !== epoch) return;
      selected.value = result.conversation.id; conversations.value.unshift(result.conversation);
      await router.replace(`/chat/${encodeURIComponent(selected.value)}`);
    }
    if (token !== epoch) return;
    await api(`${base}/${encodeURIComponent(selected.value)}/messages`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ content, attachments, request_id }) });
    if (token !== epoch) return;
    draft.value = ''; files.value = []; retry = undefined;
    // Reload canonical history: a retry may have been committed before the browser lost its response.
    const result = await api<{ messages: Message[] }>(`${base}/${encodeURIComponent(selected.value)}`, { signal: controller.signal });
    if (token === epoch) messages.value = result.messages;
    await refreshList(token);
  } catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
async function logout() { reset(); conversations.value = []; await auth.logout(); await router.replace('/login'); }
onUnmounted(reset);
</script>
<template>
  <div class="station-chat flex h-screen flex-col">
    <header class="station-header flex flex-wrap items-center gap-3">
      <StationModeSwitch mode="chat" /><h1 class="station-wordmark">FDE Station</h1><span class="flex-1"></span>
      <router-link to="/mode-settings" class="text-sm underline">{{ en ? 'API settings' : 'API 设置' }}</router-link>
      <router-link v-if="auth.user?.role === 'admin'" to="/admin" class="text-sm underline">{{ t('common.adminConsole') }}</router-link>
      <TokenQuotaPanel /><LocaleSwitch /><button class="text-sm underline" @click="logout">{{ t('common.logout') }}</button>
    </header>
    <main class="chat-main mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 overflow-hidden px-4 py-5">
      <div class="flex gap-3">
        <button class="station-secondary rounded-xl px-4 py-2 disabled:opacity-40" :disabled="busy" @click="newChat">{{ en ? 'New chat' : '新对话' }}</button>
        <select :value="selected" :disabled="busy" :aria-label="en ? 'Conversation history' : '历史对话'" class="chat-history min-w-0 flex-1 rounded-xl px-3" @change="choose"><option value="">{{ en ? 'New conversation' : '新的对话' }}</option><option v-for="c in conversations" :key="c.id" :value="c.id">{{ c.title || (en ? 'Untitled conversation' : '未命名对话') }}</option></select>
      </div>
      <section class="chat-stream min-h-0 flex-1 space-y-4 overflow-auto" aria-live="polite" :aria-busy="busy">
        <div v-if="!messages.length" class="chat-empty"><div class="station-emblem" aria-hidden="true">✳</div><h2>{{ en ? 'Let’s talk.' : '开始一段新对话' }}</h2></div>
        <article v-for="message in messages" :key="message.id" class="chat-message rounded-2xl p-5" :class="message.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'">
          <h3 class="mb-2 text-sm font-semibold">{{ message.role === 'user' ? (en ? 'You' : '你') : 'FDE Station' }}</h3>
          <p class="whitespace-pre-wrap break-words">{{ message.content }}</p>
          <ul v-if="message.attachments?.length" class="mt-2 text-sm text-black/60"><li v-for="(f, index) in message.attachments" :key="index">📎 {{ f.name }}</li></ul>
        </article>
        <p v-if="busy" role="status" class="text-black/60">{{ en ? 'Please wait…' : '请稍候…' }}</p>
      </section>
      <form class="station-composer space-y-3 rounded-2xl p-4" @submit.prevent="send">
        <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
        <ul v-if="files.length" class="flex flex-wrap gap-2"><li v-for="(f,index) in files" :key="index" class="rounded bg-black/5 px-2 py-1 text-sm">📎 {{ f.name }} <button type="button" :disabled="busy || reading" :aria-label="`${en ? 'Remove' : '移除'} ${f.name}`" @click="files.splice(index,1)">×</button></li></ul>
        <p v-for="warning in files.flatMap(file => (file.warnings ?? []).map(w => `${file.name}: ${w}`))" :key="warning" role="status" class="text-sm text-amber-700">{{ warning }}</p>
        <textarea v-model="draft" :disabled="busy" maxlength="100000" rows="3" :aria-label="en ? 'Message' : '消息'" :placeholder="en ? 'Write a message…' : '输入消息…'" class="w-full resize-none bg-transparent p-1 outline-none"></textarea>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <label class="station-secondary cursor-pointer rounded-lg px-3 py-2 text-sm">{{ reading ? (en ? 'Reading…' : '读取中…') : (en ? 'Attach files' : '上传文件') }}<input type="file" multiple :accept="accept" :disabled="busy || reading" class="sr-only" @change="upload" /></label>
          <button class="station-primary rounded-xl px-5 py-2 text-white disabled:opacity-40" :disabled="busy || reading || (!draft.trim() && !files.length)">{{ en ? 'Send' : '发送' }}</button>
        </div>
        <p class="text-xs text-black/50">{{ en ? 'Text / images / PDF / DOCX / XLSX / PPTX · 5 files · documents 8 MiB each, extracted text 64 KiB each · text/images 1 MiB each · total 4 MiB · No scanned PDF OCR' : '文本 / 图片 / PDF / DOCX / XLSX / PPTX · 最多 5 个 · 文档单个 8 MiB，提取文本 64 KiB · 文本/图片单个 1 MiB · 总计 4 MiB · 扫描 PDF 暂无 OCR' }}</p>
      </form>
    </main>
  </div>
</template>
