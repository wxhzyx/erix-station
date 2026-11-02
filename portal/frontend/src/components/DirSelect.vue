<script setup lang="ts">
// 目录下拉（issue #84 P5.4）：替换原「项目下拉」。数据源 GET /api/dirs（~/projects/ 一级
// 目录 + running/queued 计数）；选项 = 目录名 + 运行态徽标（●N，N=running+queued，0 不显）；
// 末项「＋ 新建目录」选中即弹 NewDirectoryModal；↻ 一次双刷（/api/dirs + 目录树）。
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import ProjectApprovalDialog from './ProjectApprovalDialog.vue';
import { useAuthStore } from '../stores/auth';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore, type DirInfo } from '../stores/workbench';

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*）。
const { t, locale } = useI18n();
const store = useWorkbenchStore();
const emit = defineEmits<{
  (e: 'refresh'): void;
  (e: 'new-dir'): void;
}>();

const auth = useAuthStore();
const menu = ref(false); const menuCwd = ref(''); const menuEl = ref<HTMLElement | null>(null); const actionButton = ref<HTMLButtonElement | null>(null);
const approvalCwd = ref(''); const approvalTab = ref<'submit' | 'history' | 'versions'>('submit');
async function openMenu() {
  if (!store.dirCwd) return;
  menuCwd.value = store.dirCwd; menu.value = true;
  await nextTick(); menuEl.value?.querySelector<HTMLElement>('button')?.focus();
}
function closeMenu(restore = false) { menu.value = false; if (restore) actionButton.value?.focus(); }
function contextKey(event: KeyboardEvent) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void openMenu(); }
}
function menuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); return; }
  if (event.key === 'Tab') { closeMenu(); return; }
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault(); const buttons = Array.from(menuEl.value?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
async function closeApproval() { approvalCwd.value = ''; await nextTick(); actionButton.value?.focus(); }
function request(tab: 'submit' | 'history' | 'versions') { approvalTab.value = tab; approvalCwd.value = menuCwd.value; closeMenu(); }
function outside(event: PointerEvent) { if (menu.value && !menuEl.value?.contains(event.target as Node) && !actionButton.value?.contains(event.target as Node)) closeMenu(); }
watch(() => [auth.user?.id, store.dirCwd], () => { closeMenu(); approvalCwd.value = ''; });
onMounted(() => document.addEventListener('pointerdown', outside));
onUnmounted(() => document.removeEventListener('pointerdown', outside));

/** 运行态徽标数：跨目录活跃感知的唯一入口（设计文档 §4）。 */
function badge(d: DirInfo): number {
  return (d.running_count ?? 0) + (d.queued_count ?? 0);
}

function onChange(e: Event) {
  const el = e.target as HTMLSelectElement;
  const v = el.value;
  if (v === '__new__') {
    el.value = store.dirCwd ?? ''; // 下拉弹回当前选中，modal 由 SidebarPanel 挂载
    emit('new-dir');
    return;
  }
  if (v && v !== store.dirCwd) store.selectDir(v);
}
</script>

<template>
  <!-- issue #112：控件收敛——32px 高 / 7px 圆角 / 12px 字号（label 11px）；仅 class 变动，交互不动 -->
  <div class="relative flex items-center gap-1">
    <label class="shrink-0 text-[11px] text-black/50" for="dirSel">{{ t('sidebar.dirLabel') }}</label>
    <select
      id="dirSel"
      class="h-8 min-w-0 flex-1 rounded-[7px] border border-black/20 bg-white px-2 text-[12px]"
      :value="store.dirCwd ?? ''"
      @change="onChange"
      @contextmenu.prevent="openMenu"
      @keydown="contextKey"
    >
      <option v-if="store.dirs.length === 0" value="">{{ t('common.noDir') }}</option>
      <option v-for="d in store.dirs" :key="d.cwd" :value="d.cwd">
        {{ d.name }}<template v-if="badge(d) > 0"> ●{{ badge(d) }}</template>
      </option>
      <!-- issue #332：原 `:disabled="store.newDirDisabled"`（平台管理员专用）已随入口拦截拆除——
           没有工位的平台管理员进不到工作台，这里对「有工位的人」恒可用。
           服务端仍有写闸（**2026-10-21 更正**：原先这里写「403」，与代码不符）：无 fde_name 的账号
           POST /api/sessions 返 400 `validation_failed` + `details.field='fde_name'`
           （portal/src/sessions.js:214-222，portal/test/sessions-cwd.test.js:99 钉着）。 -->
      <option value="__new__">{{ t('sidebar.newDirOption') }}</option>
    </select>
    <button ref="actionButton" type="button" class="h-8 w-7 shrink-0 rounded-lg text-sm hover:bg-black/5" :aria-label="locale === 'en' ? 'Project actions' : '项目操作'" aria-haspopup="menu" :aria-expanded="menu" :disabled="!store.dirCwd" @click="menu ? closeMenu() : openMenu()">⋯</button>
    <div v-if="menu" ref="menuEl" role="menu" class="absolute left-0 top-full z-40 mt-2 min-w-44 rounded-xl border border-black/10 bg-white p-1.5 shadow-lg" @keydown="menuKey">
      <button role="menuitem" class="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-green-50" @click="request('submit')">{{ locale === 'en' ? 'Request approval' : '发起审批' }}</button>
      <button role="menuitem" class="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-green-50" @click="request('history')">{{ locale === 'en' ? 'Approval history' : '审批记录' }}</button>
      <button role="menuitem" class="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-green-50" @click="request('versions')">{{ locale === 'en' ? 'Merged versions' : '合并版本' }}</button>
    </div>
    <!-- ↻ 单按钮双刷：store.refreshDirs()（/api/dirs）+ DirectoryTree.reload()（目录树），SidebarPanel 组装 -->
    <button
      type="button"
      :title="t('sidebar.refreshTitle')"
      class="h-8 w-8 shrink-0 rounded-[7px] border border-black/20 bg-black/[.03] text-[12px] hover:bg-black/10"
      @click="emit('refresh')"
    >↻</button>
  </div>
  <Teleport to="body"><ProjectApprovalDialog v-if="approvalCwd" :cwd="approvalCwd" :initial-tab="approvalTab" @close="closeApproval" /></Teleport>
</template>
