<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import ModalShell from './ModalShell.vue';
import ProjectApprovalPanel from './ProjectApprovalPanel.vue';
const props = defineProps<{cwd:string; initialTab?: 'submit' | 'history' | 'versions'}>();
const emit = defineEmits<{(event:'close'):void}>();
const {locale} = useI18n(); const en = computed(() => locale.value === 'en'); const auth = useAuthStore();
const tab = ref(props.initialTab ?? 'submit'); const source = ref(''); const target = ref(''); const busy = ref(false); const error = ref(''); const submitted = ref(false);
let epoch = 0; const controller = new AbortController();
async function submit() {
  if (busy.value || !source.value.trim() || !target.value.trim()) return;
  if (source.value.trim() === target.value.trim()) { error.value = en.value ? 'Choose different source and target branches.' : '来源分支与目标分支不能相同。'; return; }
  const token = epoch; busy.value = true; error.value = '';
  try {
    await api('/api/project-approvals', {method:'POST',signal:controller.signal,body:JSON.stringify({cwd:props.cwd,source_ref:source.value.trim(),target_ref:target.value.trim()})});
    if (token === epoch) { submitted.value = true; source.value = ''; target.value = ''; tab.value = 'history'; }
  } catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) busy.value = false; }
}
watch(() => auth.user?.id, (_id, previous) => { if (previous) { epoch++; controller.abort(); emit('close'); } });
onUnmounted(() => {epoch++; controller.abort();});
</script>
<template>
  <ModalShell :label="en ? 'Project approvals' : '项目审批'" dialog-class="md:w-[min(62rem,94vw)] max-h-[88dvh] overflow-auto" @close="emit('close')">
    <header class="flex items-center justify-between gap-3 border-b border-black/10 p-4"><div class="min-w-0"><h2 class="font-semibold">{{ cwd.split('/').pop() }}</h2><p class="truncate text-xs text-black/50">{{ cwd }}</p></div><button :aria-label="en ? 'Close' : '关闭'" class="rounded px-2 py-1" @click="emit('close')">×</button></header>
    <div class="p-4 md:p-6">
      <nav class="mb-5 flex gap-2" :aria-label="en ? 'Approval sections' : '审批功能'"><button v-for="item in (['submit','history','versions'] as const)" :key="item" class="rounded-lg px-3 py-2 text-sm" :class="tab === item ? 'bg-green-50 text-brand font-semibold' : 'text-black/60'" :disabled="busy" @click="tab=item">{{ item === 'submit' ? (en ? 'Request approval' : '发起审批') : item === 'history' ? (en ? 'History' : '审批记录') : (en ? 'Versions' : '合并版本') }}</button></nav>
      <form v-if="tab === 'submit'" class="mx-auto max-w-lg space-y-4" @submit.prevent="submit">
        <label class="settings-field">{{ en ? 'Source branch' : '来源分支' }}<input v-model="source" name="source_ref" required maxlength="200" :disabled="busy" class="settings-select" :placeholder="en ? 'Branch to review' : '需要审查的分支'" /></label>
        <label class="settings-field">{{ en ? 'Target branch' : '合并目标分支' }}<input v-model="target" name="target_ref" required maxlength="200" :disabled="busy" class="settings-select" :placeholder="en ? 'Target branch' : '合并到哪个分支'" /></label>
        <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
        <button class="station-primary rounded-xl px-4 py-2 text-sm text-white disabled:opacity-50" :disabled="busy || !source.trim() || !target.trim()">{{ busy ? (en ? 'Submitting…' : '提交中…') : (en ? 'Request approval' : '发起审批') }}</button>
      </form>
      <template v-else><p v-if="submitted" role="status" class="mb-3 text-sm text-brand">{{ en ? 'Request submitted' : '审批已提交' }}</p><ProjectApprovalPanel :key="tab" :cwd="cwd" :versions="tab === 'versions'" /></template>
    </div>
  </ModalShell>
</template>
