<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import StationModeSwitch from '../components/StationModeSwitch.vue';
interface Model { id: string; model_name?: string; display_name?: string; type: string; tool_calling?: boolean; enabled?: boolean }
interface Provider { id: string; name: string; models: Model[] }
interface Selection { provider_id: string; main: { model_id: string }; embedding?: { model_id: string } | null; vision?: { model_id: string } | null }
interface Settings { providers: Provider[]; chat: Selection | null; work: Selection | null }
const auth = useAuthStore();
const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const settings = ref<Settings | null>(null);
const mode = ref<'chat' | 'work'>('chat');
const provider = ref(''); const main = ref(''); const embedding = ref(''); const vision = ref('');
const error = ref(''); const saved = ref(false); const busy = ref(false);
let epoch = 0; let controller: AbortController | undefined;
const models = computed(() => settings.value?.providers.find(p => p.id === provider.value)?.models.filter(m => m.enabled !== false) ?? []);
const mainModels = computed(() => models.value.filter(m => mode.value === 'chat' ? ['text', 'vision'].includes(m.type) : m.type === 'text' && m.tool_calling));
function fill() { const s = settings.value?.[mode.value]; provider.value = s?.provider_id ?? ''; main.value = s?.main.model_id ?? ''; embedding.value = s?.embedding?.model_id ?? ''; vision.value = s?.vision?.model_id ?? ''; saved.value = false; }
function providerChanged() { main.value = ''; embedding.value = ''; vision.value = ''; saved.value = false; }
async function load() {
  controller?.abort(); controller = new AbortController(); const token = ++epoch;
  settings.value = null; error.value = ''; fill();
  if (!auth.user) return;
  busy.value = true;
  try { const result = await api<Settings>('/api/me/mode-settings', { signal: controller.signal }); if (token === epoch) { settings.value = result; fill(); } }
  catch (e) { if (token === epoch && !controller.signal.aborted) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
async function save() {
  if (busy.value || !main.value || !provider.value) return;
  const token = epoch; busy.value = true; error.value = ''; saved.value = false;
  try {
    const result = await api<Selection>(`/api/me/mode-settings/${mode.value}`, { method: 'PUT', signal: controller?.signal, body: JSON.stringify({ provider_id: provider.value, main_model_id: main.value, ...(mode.value === 'work' ? { embedding_model_id: embedding.value || null, vision_model_id: vision.value || null } : {}) }) });
    if (token === epoch && settings.value) { settings.value[mode.value] = result; saved.value = true; }
  } catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
watch(mode, fill);
watch(() => auth.user?.id, load, { immediate: true });
onUnmounted(() => { epoch++; controller?.abort(); });
</script>
<template>
  <div class="station-settings min-h-screen">
    <header class="station-header flex flex-wrap items-center gap-3"><StationModeSwitch :mode="mode" /><h1 class="text-xl">{{ en ? 'API settings' : 'API 设置' }}</h1></header>
    <main class="settings-main mx-auto max-w-2xl space-y-5 p-6">
      <form class="settings-card space-y-5" @submit.prevent="save">
        <label class="settings-field">{{ en ? 'Mode' : '模式' }}<select v-model="mode" :disabled="busy" class="settings-select"><option value="chat">{{ en ? 'Chat' : '聊天模式' }}</option><option value="work">{{ en ? 'Work' : '工作模式' }}</option></select></label>
        <label class="settings-field">{{ en ? 'API provider' : 'API 供应商' }}<select v-model="provider" :disabled="busy" class="settings-select" @change="providerChanged"><option value="">{{ en ? 'Select a provider' : '选择供应商' }}</option><option v-for="p in settings?.providers" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
        <label class="settings-field">{{ en ? 'Main model' : '主模型' }}<select v-model="main" :disabled="busy" class="settings-select"><option value="">{{ en ? 'Select a model' : '选择模型' }}</option><option v-for="m in mainModels" :key="m.id" :value="m.id">{{ m.display_name || m.model_name }}</option></select></label>
        <template v-if="mode === 'work'">
          <label class="settings-field">Embedding<select v-model="embedding" :disabled="busy" class="settings-select"><option value="">{{ en ? 'Not configured' : '不配置' }}</option><option v-for="m in models.filter(m => m.type === 'embedding')" :key="m.id" :value="m.id">{{ m.display_name || m.model_name }}</option></select></label>
          <label class="settings-field">{{ en ? 'Vision model' : '视觉模型' }}<select v-model="vision" :disabled="busy" class="settings-select"><option value="">{{ en ? 'Not configured' : '不配置' }}</option><option v-for="m in models.filter(m => m.type === 'vision')" :key="m.id" :value="m.id">{{ m.display_name || m.model_name }}</option></select></label>
        </template>
        <p v-if="error" role="alert" class="text-red-700">{{ error }}</p><p v-if="saved" role="status" class="text-green-700">{{ en ? 'Saved' : '已保存' }}</p>
        <button class="station-primary rounded-xl px-5 py-2 text-white disabled:opacity-40" :disabled="busy || !provider || !main">{{ busy ? (en ? 'Please wait…' : '请稍候…') : (en ? 'Save' : '保存') }}</button>
      </form>
    </main>
  </div>
</template>
