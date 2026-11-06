<script setup lang="ts">
import { ElAlert, ElButton, ElCard, ElInput, ElTable, ElTableColumn } from 'element-plus';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';

type Quota = { day: string; used: number; reserved: number; daily_limit: number; remaining: number };
type Member = { id: string; login: string; display_name: string | null };
type Row = Member & { quota: Quota | null; state: 'loading' | 'ready' | 'failed' };
const { locale } = useI18n();
const en = computed(() => locale.value === 'en');
const rows = ref<Row[]>([]), search = ref(''), busy = ref(false), error = ref('');
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const day = ref(today());
const visibleRows = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return rows.value.filter(row => `${row.login} ${row.display_name ?? ''}`.toLocaleLowerCase().includes(query))
    .slice().sort((a, b) => (b.quota?.used ?? -1) - (a.quota?.used ?? -1) || a.login.localeCompare(b.login));
});
const format = (value: number | undefined) => value === undefined ? '—' : value.toLocaleString(en.value ? 'en-US' : 'zh-CN');
function validQuota(value: Quota) {
  return value?.day === day.value && ['used', 'reserved', 'daily_limit', 'remaining'].every(
    key => Number.isSafeInteger(value[key as keyof Quota]) && Number(value[key as keyof Quota]) >= 0,
  );
}
let controller: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
async function refresh() {
  if (busy.value || disposed) return;
  const abort = new AbortController();
  controller = abort;
  busy.value = true;
  error.value = '';
  day.value = today();
  rows.value = [];
  const options = () => ({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]) });
  try {
    const data = await api<{ items: Member[] }>('/api/admin/users', options());
    if (abort.signal.aborted) return;
    rows.value = data.items.map(member => ({ ...member, quota: null, state: 'loading' }));
    // Limit gateway fan-out; a failed member must not hide the other members' usage.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, rows.value.length) }, async () => {
      while (!abort.signal.aborted && next < rows.value.length) {
        const row = rows.value[next++];
        try {
          const quota = await api<Quota>(`/api/admin/users/${encodeURIComponent(row.id)}/token-quota`, options());
          if (abort.signal.aborted) return;
          if (!validQuota(quota)) throw new Error('Invalid daily usage');
          row.quota = quota;
          row.state = 'ready';
        } catch {
          if (!abort.signal.aborted) row.state = 'failed';
        }
      }
    }));
  } catch (e) {
    if (!abort.signal.aborted) error.value = (e as Error).message;
  } finally {
    if (!disposed) busy.value = false;
  }
}
function refreshVisible() {
  if (document.visibilityState === 'visible') void refresh();
}
onMounted(() => {
  void refresh();
  timer = setInterval(refreshVisible, 60000);
  document.addEventListener('visibilitychange', refreshVisible);
});
onUnmounted(() => {
  disposed = true;
  controller?.abort();
  clearInterval(timer);
  document.removeEventListener('visibilitychange', refreshVisible);
});
</script>

<template>
  <ElCard shadow="never" class="member-usage">
    <div class="usage-toolbar">
      <span>{{ day }} · {{ en ? 'Beijing time' : '北京时间' }}</span>
      <ElInput v-model="search" clearable :placeholder="en ? 'Search members' : '搜索成员'" :aria-label="en ? 'Search members' : '搜索成员'" />
      <ElButton :loading="busy" @click="refresh">{{ en ? 'Refresh' : '刷新' }}</ElButton>
    </div>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <ElTable :data="visibleRows" row-key="id" :aria-busy="busy" :empty-text="busy ? (en ? 'Loading…' : '加载中…') : error ? '—' : (en ? 'No members' : '暂无成员')">
      <ElTableColumn :label="en ? 'Member' : '成员'" min-width="160">
        <template #default="{ row }"><div class="member-identity"><span>{{ row.login }}</span><small :title="row.display_name || ''">{{ row.display_name || '—' }}</small></div></template>
      </ElTableColumn>
      <ElTableColumn :label="en ? 'Tokens used today' : '今日已用 Token'" min-width="150" align="right">
        <template #default="{ row }">
          <strong v-if="row.state === 'ready'">{{ format(row.quota.used) }}</strong>
          <span v-else :class="{ 'usage-failed': row.state === 'failed' }">{{ row.state === 'failed' ? (en ? 'Unavailable' : '读取失败') : (en ? 'Loading…' : '加载中…') }}</span>
        </template>
      </ElTableColumn>
      <ElTableColumn :label="en ? 'Reserved' : '调用中预留'" min-width="130" align="right">
        <template #default="{ row }">{{ format(row.quota?.reserved) }}</template>
      </ElTableColumn>
      <ElTableColumn :label="en ? 'Daily limit' : '每日额度'" min-width="130" align="right">
        <template #default="{ row }">{{ format(row.quota?.daily_limit) }}</template>
      </ElTableColumn>
      <ElTableColumn :label="en ? 'Remaining' : '剩余额度'" min-width="130" align="right">
        <template #default="{ row }">{{ format(row.quota?.remaining) }}</template>
      </ElTableColumn>
    </ElTable>
  </ElCard>
</template>

<style scoped>
.usage-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
.usage-toolbar > span { color: #65738b; font-size: 13px; margin-right: auto; }
.usage-toolbar .el-input { width: 220px; }
.usage-failed { color: var(--el-color-danger); }
.member-usage { min-width: 0; font-variant-numeric: tabular-nums; }
.member-identity { display: grid; gap: 2px; }
.member-identity small { color: #65738b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
