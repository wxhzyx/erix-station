<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { approvalStatus, approvalWebUrl, type ProjectApproval } from '../lib/projectApprovals';
const props = defineProps<{ cwd?: string; versions?: boolean; admin?: boolean }>();
const auth = useAuthStore(); const { locale } = useI18n(); const en = computed(() => locale.value === 'en');
const items = ref<ProjectApproval[]>([]); const selected = ref<ProjectApproval | null>(null); const loading = ref(false); const acting = ref(false); const loadingDetail = ref(false); const error = ref(''); const confirmed = ref(false); const hasMore = ref(false);
let epoch = 0; let detailEpoch = 0; let controller = new AbortController();
const visible = computed(() => items.value.filter(item => (!props.cwd || item.cwd === props.cwd) && (!props.versions || item.status === 'merged')));
const admin = computed(() => props.admin && auth.user?.role === 'admin');
const reviewEvidenceReady = computed(() => !!selected.value?.diff?.trim() && !!selected.value?.ai_review?.trim());
function reset() { epoch++; detailEpoch++; controller.abort(); controller = new AbortController(); items.value = []; hasMore.value = false; selected.value = null; error.value = ''; loading.value = false; acting.value = false; loadingDetail.value = false; confirmed.value = false; }
async function load() {
  if (acting.value) return;
  const token = ++epoch; detailEpoch++; loadingDetail.value = false; controller.abort(); controller = new AbortController(); loading.value = true; error.value = ''; confirmed.value = false;
  const query = new URLSearchParams(); if (props.cwd) query.set('cwd', props.cwd); if (props.versions) query.set('status', 'merged');
  try { const result = await api<{items:ProjectApproval[];has_more?:boolean}>(`/api/project-approvals${query.size ? '?' + query.toString() : ''}`, {signal:controller.signal}); if (token === epoch) { items.value = result.items; hasMore.value = result.has_more === true; if (selected.value) { const item = result.items.find(item => item.id === selected.value?.id); selected.value = null; if (item) { loading.value = false; await select(item); } } } }
  catch (e) { if (token === epoch) error.value = (e as Error).message; }
  finally { if (token === epoch) loading.value = false; }
}
async function select(item: ProjectApproval) {
  if (acting.value || loading.value) return;
  const token = epoch; const detail = ++detailEpoch; selected.value = item; confirmed.value = false; error.value = ''; loadingDetail.value = true;
  try { const result = await api<ProjectApproval>(`/api/project-approvals/${encodeURIComponent(item.id)}`, {signal:controller.signal}); if (token === epoch && detail === detailEpoch) selected.value = result; }
  catch (e) { if (token === epoch && detail === detailEpoch) { selected.value = null; error.value = (e as Error).message; } }
  finally { if (token === epoch && detail === detailEpoch) loadingDetail.value = false; }
}
async function act(action: 'review' | 'approve' | 'merge') {
  const item = selected.value;
  if (!admin.value || !item || acting.value || loading.value || loadingDetail.value) return;
  if (action === 'review' && !['pending','failed'].includes(item.status) && !(item.status === 'reviewing' && item.can_retry_review)) return;
  if (action === 'approve' && (item.status !== 'reviewed' || !confirmed.value || !reviewEvidenceReady.value)) return;
  if (action === 'merge' && item.status !== 'merging' && (item.status !== 'approved' || !confirmed.value || !reviewEvidenceReady.value)) return;
  const token = epoch; const detail = ++detailEpoch; acting.value = true; error.value = '';
  try {
    const result = await api<ProjectApproval>(`/api/admin/project-approvals/${encodeURIComponent(item.id)}/${action}`, {method:'POST',signal:controller.signal,body:JSON.stringify(action === 'review' ? {} : {confirm:true})});
    if (token === epoch && detail === detailEpoch) { selected.value = result; items.value = items.value.map(row => row.id === result.id ? result : row); confirmed.value = false; }
  } catch (e) {
    if (token === epoch && detail === detailEpoch) {
      error.value = (e as Error).message; confirmed.value = false;
      // Reconcile stale/uncertain actions from the server; never automatically retry a mutation.
      try { const current = await api<ProjectApproval>(`/api/project-approvals/${encodeURIComponent(item.id)}`, {signal:controller.signal}); if (token === epoch && detail === detailEpoch) { selected.value = current; items.value = items.value.map(row => row.id === current.id ? current : row); } } catch { /* Keep the original actionable error. */ }
    }
  } finally { if (token === epoch) acting.value = false; }
}
watch(() => [auth.user?.id, auth.user?.role, props.cwd, props.versions], () => { reset(); if (auth.user) void load(); }, {immediate:true});
onUnmounted(reset);
defineExpose({ refresh: load });
</script>
<template>
  <div class="approval-panel space-y-4">
    <div class="flex items-center justify-between gap-3"><h2 class="font-semibold">{{ versions ? (en ? 'Merged versions' : '合并版本') : (en ? 'Project approvals' : '项目审批') }}</h2><button class="station-secondary rounded-lg px-3 py-1.5 text-sm" :disabled="loading || acting" @click="load">{{ loading ? (en ? 'Loading…' : '加载中…') : (en ? 'Refresh' : '刷新') }}</button></div>
    <p v-if="error" role="alert" class="text-sm text-red-700">{{ error }}</p>
    <p v-if="!loading && !visible.length" class="py-8 text-center text-sm text-black/50">{{ versions ? (en ? 'No merged versions' : '暂无合并版本') : (en ? 'No approval requests' : '暂无审批') }}</p>
    <p v-if="hasMore" class="text-xs text-black/50">{{ en ? 'Showing the latest 100 requests' : '显示最近 100 条记录' }}</p>
    <div v-if="visible.length" class="approval-grid">
      <div class="space-y-2" :aria-label="en ? 'Approval requests' : '审批列表'">
        <button v-for="item in visible" :key="item.id" class="approval-row w-full rounded-xl border p-3 text-left" :class="selected?.id === item.id ? 'border-brand bg-green-50/50' : 'border-black/10 bg-white'" :disabled="acting || loading" @click="select(item)">
          <span class="block truncate text-sm font-medium">{{ item.repository || item.cwd.split('/').pop() }}</span><span class="mt-1 block break-all text-xs text-black/60">{{ item.source_ref }} → {{ item.target_ref }}</span><span class="mt-2 block text-xs text-brand">{{ approvalStatus(item.status, en) }}</span>
          <template v-if="versions"><code class="mt-2 block text-xs">{{ item.merge_sha?.slice(0,12) }}</code><span class="text-xs text-black/50">{{ en ? 'Deployment unverified' : '上线状态未确认' }}</span></template>
        </button>
      </div>
      <article v-if="selected" :aria-busy="loadingDetail" class="min-w-0 space-y-4 rounded-xl border border-black/10 bg-white p-4">
        <header class="flex flex-wrap items-center justify-between gap-2"><h3 class="font-semibold">{{ selected.repository }}</h3><span class="text-xs text-brand">{{ approvalStatus(selected.status, en) }}</span></header>
        <dl class="grid gap-2 text-xs"><div v-if="selected.requester_login"><dt class="inline text-black/50">{{ en ? 'Requested by' : '发起人' }} </dt><dd class="inline">{{ selected.requester_login }}</dd></div><div v-if="selected.approved_by_login"><dt class="inline text-black/50">{{ en ? 'Approved by' : '批准人' }} </dt><dd class="inline">{{ selected.approved_by_login }} · {{ selected.approved_at }}</dd></div><div><dt class="inline text-black/50">{{ en ? 'Source' : '来源' }} </dt><dd class="inline break-all">{{ selected.source_ref }} <code>{{ selected.source_sha }}</code></dd></div><div><dt class="inline text-black/50">{{ en ? 'Target' : '目标' }} </dt><dd class="inline break-all">{{ selected.target_ref }} <code>{{ selected.target_sha }}</code></dd></div></dl>
        <div v-if="selected.status === 'merged'" class="rounded-lg bg-green-50 p-3 text-sm"><p>{{ en ? 'Merge commit' : '合并提交' }} <code class="break-all">{{ selected.merge_sha }}</code></p><p class="mt-1 text-xs text-black/60">{{ selected.merged_by_login || '' }} {{ selected.merged_at || selected.updated_at }} · {{ en ? 'Deployment unverified' : '上线状态未确认' }}</p></div>
        <a v-if="approvalWebUrl(selected.web_url)" :href="approvalWebUrl(selected.web_url)" target="_blank" rel="noopener noreferrer" class="inline-block text-sm text-brand underline">{{ en ? 'Open repository' : '查看仓库' }}</a>
        <p v-if="selected.error" role="alert" class="text-sm text-red-700">{{ selected.error }}</p>
        <section><h4 class="mb-2 text-sm font-semibold">{{ en ? 'Changes' : '代码差异' }}</h4><pre class="approval-diff max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-6 text-slate-100">{{ loadingDetail ? (en ? 'Loading diff…' : '加载差异…') : selected.diff || (en ? 'No diff available' : '暂无差异') }}</pre></section>
        <section v-if="selected.ai_review"><h4 class="mb-2 text-sm font-semibold">{{ en ? 'AI review · advisory' : 'AI 审查 · 仅供参考' }}</h4><p class="whitespace-pre-wrap break-words text-sm leading-7">{{ selected.ai_review }}</p></section>
        <div v-if="admin && !loadingDetail && !loading" class="space-y-3 border-t border-black/10 pt-4">
          <button v-if="['pending','failed'].includes(selected.status) || (selected.status === 'reviewing' && selected.can_retry_review)" class="station-primary rounded-lg px-4 py-2 text-sm text-white disabled:opacity-50" :disabled="acting" @click="act('review')">{{ acting ? (en ? 'Reviewing…' : '审查中…') : selected.status === 'reviewing' ? (en ? 'Retry review' : '重新审查') : (en ? 'Run AI review' : '运行 AI 审查') }}</button>
          <template v-if="['reviewed','approved'].includes(selected.status)">
            <label class="flex items-start gap-2 text-sm"><input v-model="confirmed" type="checkbox" class="mt-1" :disabled="acting" /><span>{{ selected.status === 'approved' ? (en ? `Merge the reviewed commit into ${selected.target_ref}` : `将已审查的提交合并至 ${selected.target_ref}`) : (en ? 'I have checked the diff and AI review' : '我已核对代码差异与 AI 审查') }}</span></label>
            <button class="station-primary rounded-lg px-4 py-2 text-sm text-white disabled:opacity-50" :disabled="acting || !confirmed || !reviewEvidenceReady" @click="act(selected.status === 'approved' ? 'merge' : 'approve')">{{ acting ? (en ? 'Processing…' : '处理中…') : selected.status === 'approved' ? (en ? 'Confirm merge' : '确认合并') : (en ? 'Approve' : '批准') }}</button>
          </template>
          <button v-if="selected.status === 'merging'" class="station-secondary rounded-lg px-4 py-2 text-sm disabled:opacity-50" :disabled="acting" @click="act('merge')">{{ en ? 'Check merge result' : '核对合并结果' }}</button>
          <p v-if="selected.status === 'merging'" class="text-sm text-black/60">{{ en ? 'Merge pending confirmation. Refresh to reconcile; do not submit again.' : '合并结果待确认，请刷新核对，勿重复提交。' }}</p>
          <p v-if="selected.status === 'stale'" class="text-sm text-amber-700">{{ en ? 'The branches changed. Submit a new approval request.' : '分支已更新，请重新发起审批。' }}</p>
        </div>
      </article>
    </div>
  </div>
</template>
