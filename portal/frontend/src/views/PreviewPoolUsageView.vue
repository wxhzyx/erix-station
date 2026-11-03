<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElButton, ElInput, ElTable, ElTableColumn, ElTag, ElAlert, ElEmpty } from 'element-plus';
import { Search, Refresh } from '@element-plus/icons-vue';
import { api } from '../api';
interface Listener { id:string; login:string; display_name:string|null; project:string|null; port:number; branch:string|null; routed:boolean; observed_at:string }
interface Snapshot { sampled_at:string; freshness_seconds:number; total:number; limit:number; items:Listener[] }
const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const snapshot = ref<Snapshot|null>(null), loading = ref(false), error = ref(''), search = ref('');
const clock = ref(0);
let receivedAt = 0, serverAge = 0, disposed = false;
let poll:ReturnType<typeof setInterval>, tick:ReturnType<typeof setInterval>;
const fresh = computed(() => snapshot.value?.items.filter(row => {
  const age = serverAge + clock.value - receivedAt - Date.parse(row.observed_at);
  return age >= 0 && age < snapshot.value!.freshness_seconds * 1000;
}) ?? []);
const rows = computed(() => fresh.value.filter(row =>
  [row.login, row.display_name, row.project, row.port, row.branch].join(' ').toLowerCase().includes(search.value.trim().toLowerCase())));
async function refresh() {
  if (loading.value || disposed) return;
  loading.value = true;
  const startedAt = performance.now();
  try {
    const result = await api<Snapshot>('/api/admin/preview-ports/runtime');
    if (disposed) return;
    snapshot.value = result; receivedAt = startedAt; clock.value = performance.now();
    serverAge = Date.parse(result.sampled_at); error.value = '';
  } catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : String(e); }
  finally { loading.value = false; }
}
onMounted(() => {
  void refresh();
  poll = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  tick = setInterval(() => { clock.value = performance.now(); }, 1000);
});
onBeforeUnmount(() => { disposed = true; clearInterval(poll); clearInterval(tick); });
</script>
<template>
  <section data-test="preview-pool-usage" class="runtime-panel">
    <div class="table-toolbar">
      <span class="result-count">{{ en ? 'Listening' : '正在监听' }} <strong>{{ fresh.length }}</strong></span>
      <ElInput v-model="search" :prefix-icon="Search" clearable :placeholder="en ? 'User, project or port' : '搜索用户、项目或端口'" :aria-label="en ? 'Search listeners' : '搜索运行端口'" />
      <ElButton :icon="Refresh" :loading="loading" @click="refresh">{{ en ? 'Refresh' : '刷新' }}</ElButton>
    </div>
    <ElAlert v-if="error" data-test="usage-error" :title="error" type="error" :closable="false" show-icon />
    <p v-if="loading && !snapshot" role="status">{{ en ? 'Loading…' : '正在读取…' }}</p>
    <ElTable v-else :data="rows" row-key="id" class="runtime-table" data-test="runtime-table">
      <ElTableColumn :label="en ? 'User' : '用户'" min-width="200"><template #default="{ row }"><div class="identity-cell"><strong>{{ row.login }}</strong><span>{{ row.display_name }}</span></div></template></ElTableColumn>
      <ElTableColumn :label="en ? 'Project' : '项目'" min-width="190"><template #default="{ row }"><strong>{{ row.project || (en ? 'Unidentified' : '未识别项目') }}</strong><div v-if="row.branch" class="cell-secondary">{{ row.branch }}</div></template></ElTableColumn>
      <ElTableColumn :label="en ? 'Port' : '端口'" width="110"><template #default="{ row }"><code class="port-number">{{ row.port }}</code></template></ElTableColumn>
      <ElTableColumn :label="en ? 'Status' : '状态'" width="125"><template #default><ElTag type="success" effect="light">{{ en ? 'Listening' : '监听中' }}</ElTag></template></ElTableColumn>
      <ElTableColumn :label="en ? 'Preview route' : '预览路由'" min-width="125"><template #default="{ row }"><span :class="{ 'cell-secondary': !row.routed }">{{ row.routed ? (en ? 'Allocated' : '已分配') : (en ? 'Not allocated' : '未分配') }}</span></template></ElTableColumn>
      <template #empty><ElEmpty :image-size="64" :description="search ? (en ? 'No matching listeners' : '没有匹配的记录') : (en ? 'No recent listener observations' : '暂无新鲜的端口监听记录')" /></template>
    </ElTable>
    <footer class="runtime-footer">{{ en ? 'Refreshes every 15s · Container ports' : '每 15 秒更新 · 容器内端口' }}<span v-if="snapshot && snapshot.total > snapshot.limit"> · {{ en ? 'Showing first' : '仅展示前' }} {{ snapshot.limit }} / {{ snapshot.total }}</span></footer>
  </section>
</template>
