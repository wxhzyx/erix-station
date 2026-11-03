<script setup lang="ts">
import { ElButton } from 'element-plus';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
interface Model { id: string; model_name?: string; display_name?: string; type: string; tool_calling?: boolean; enabled?: boolean }
interface Provider { id: string; name: string; models: Model[] }
interface Selection { provider_id: string; main: { model_id: string }; embedding?: { model_id: string } | null; vision?: { model_id: string } | null }
interface Settings { providers: Provider[]; chat: Selection | null; work: Selection | null }
interface Member { id: string; login: string; display_name?: string; status: string; fde_name: string | null }
const auth = useAuthStore();
const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const users = ref<Member[]>([]), userId = ref('');
const settings = ref<Settings | null>(null);
const mode = ref<'chat' | 'work'>('chat');
const provider = ref(''), main = ref(''), embedding = ref(''), vision = ref('');
const error = ref(''), saved = ref(false), busy = ref(false);
let epoch = 0;
let controller = new AbortController();
const member = computed(() => users.value.find(u => u.id === userId.value));
const models = computed(() => settings.value?.providers.find(p => p.id === provider.value)?.models.filter(m => m.enabled !== false) ?? []);
const mainModels = computed(() => models.value.filter(m => mode.value === 'chat' ? ['text', 'vision'].includes(m.type) : m.type === 'text' && m.tool_calling));
function fill() { const s = settings.value?.[mode.value]; provider.value = s?.provider_id ?? ''; main.value = s?.main.model_id ?? ''; embedding.value = s?.embedding?.model_id ?? ''; vision.value = s?.vision?.model_id ?? ''; saved.value = false; }
function providerChanged() { main.value = ''; embedding.value = ''; vision.value = ''; saved.value = false; }
function begin() { controller.abort(); controller = new AbortController(); error.value = ''; saved.value = false; return ++epoch; }
async function loadSettings() {
  const token = begin(); settings.value = null; fill();
  if (!userId.value || auth.user?.role !== 'admin') { busy.value = false; return; }
  if (mode.value === 'work' && !member.value?.fde_name) mode.value = 'chat';
  busy.value = true;
  try { const data = await api<Settings>(`/api/admin/users/${encodeURIComponent(userId.value)}/mode-settings`, { signal: controller.signal }); if (token === epoch) { settings.value = data; fill(); } }
  catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
async function loadUsers() {
  const token = begin(); users.value = []; userId.value = ''; settings.value = null; fill(); busy.value = false;
  if (auth.user?.role !== 'admin') return;
  busy.value = true;
  try {
    const data = await api<{ items: Member[] }>('/api/admin/users', { signal: controller.signal });
    if (token !== epoch) return;
    users.value = data.items.filter(u => u.status === 'active');
    userId.value = users.value.find(u => u.id === auth.user?.id)?.id ?? users.value[0]?.id ?? '';
    await loadSettings();
  } catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
async function save() {
  if (busy.value || !main.value || !provider.value || auth.user?.role !== 'admin') return;
  const token = epoch, selectedMode = mode.value; busy.value = true; error.value = ''; saved.value = false;
  try {
    const result = await api<Selection>(`/api/admin/users/${encodeURIComponent(userId.value)}/mode-settings/${selectedMode}`, { method: 'PUT', signal: controller.signal, body: JSON.stringify({ provider_id: provider.value, main_model_id: main.value, ...(selectedMode === 'work' ? { embedding_model_id: embedding.value || null, vision_model_id: vision.value || null } : {}) }) });
    if (token === epoch && settings.value) { settings.value[selectedMode] = result; saved.value = true; }
  } catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
watch(mode, fill);
watch(() => [auth.user?.id, auth.user?.role], loadUsers, { immediate: true });
onUnmounted(() => { epoch++; controller.abort(); });
</script>
<template>
  <div class="model-assignment">
    <p v-if="auth.user?.role !== 'admin'" role="alert">{{ en ? 'Administrator access required.' : '仅管理员可配置模型。' }}</p>
    <template v-else>
      <form class="console-card assignment-form" @submit.prevent="save">
        <label class="settings-field">{{ en ? 'Member' : '配置用户' }}<select v-model="userId" :disabled="busy" class="settings-select" @change="loadSettings"><option value="" disabled>{{ en ? 'Select a member' : '选择用户' }}</option><option v-for="u in users" :key="u.id" :value="u.id">{{ u.display_name || u.login }} · {{ u.login }}</option></select></label>
        <div class="mode-config-tabs" role="group" :aria-label="en ? 'Model configuration mode' : '模型配置模式'"><ElButton native-type="button" :aria-pressed="mode === 'chat'" :disabled="busy" @click="mode = 'chat'">{{ en ? 'Chat model' : '聊天模型' }}</ElButton><ElButton native-type="button" :aria-pressed="mode === 'work'" :disabled="busy || !member?.fde_name" @click="mode = 'work'">{{ en ? 'Development model' : '开发模型' }}</ElButton></div>
        <p v-if="member && !member.fde_name" class="muted">{{ en ? 'This member has no development workstation.' : '此成员尚未分配开发工位，仅可配置聊天模型。' }}</p>
        <div class="form-grid">
          <label class="settings-field">{{ en ? 'API connection' : 'API 接入' }}<select v-model="provider" :disabled="busy || !settings" class="settings-select" @change="providerChanged"><option value="">{{ en ? 'Select a provider' : '选择供应商' }}</option><option v-for="p in settings?.providers" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
          <label class="settings-field">{{ en ? 'Main model' : '主模型' }}<select v-model="main" :disabled="busy || !settings" class="settings-select"><option value="">{{ en ? 'Select a model' : '选择模型' }}</option><option v-for="m in mainModels" :key="m.id" :value="m.id">{{ m.display_name || m.model_name }}</option></select></label>
        </div>
        <details v-if="mode === 'work'" class="advanced-settings"><summary>{{ en ? 'Optional capabilities' : '可选能力配置' }}</summary><div class="form-grid">
          <label class="settings-field">Embedding<select v-model="embedding" :disabled="busy" class="settings-select"><option value="">{{ en ? 'Not configured' : '不配置' }}</option><option v-for="m in models.filter(m => m.type === 'embedding')" :key="m.id" :value="m.id">{{ m.display_name || m.model_name }}</option></select></label>
          <label class="settings-field">{{ en ? 'Vision model' : '视觉模型' }}<select v-model="vision" :disabled="busy" class="settings-select"><option value="">{{ en ? 'Not configured' : '不配置' }}</option><option v-for="m in models.filter(m => m.type === 'vision')" :key="m.id" :value="m.id">{{ m.display_name || m.model_name }}</option></select></label>
        </div></details>
        <p v-if="error" role="alert" class="console-error">{{ error }}</p><p v-if="saved" role="status" class="console-success">{{ en ? 'Saved' : '已保存' }}</p>
        <div class="form-footer"><span class="muted">{{ en ? 'Changes apply to the selected member.' : '配置仅对当前所选用户生效。' }}</span><ElButton native-type="submit" class="station-primary" :disabled="busy || !provider || !main || !userId">{{ busy ? (en ? 'Please wait…' : '请稍候…') : (en ? 'Save assignment' : '保存模型分配') }}</ElButton></div>
      </form>
    </template>
  </div>
</template>
