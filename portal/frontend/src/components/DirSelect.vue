<script setup lang="ts">
import { ElSelect, ElOption, ElButton, ElTag } from "element-plus";
// 目录下拉（issue #84 P5.4）：替换原「项目下拉」。数据源 GET /api/dirs（~/projects/ 一级
// 目录 + running/queued 计数）；选项 = 目录名 + 运行态徽标（●N，N=running+queued，0 不显）；
// 末项「＋ 新建目录」选中即弹 NewDirectoryModal；↻ 一次双刷（/api/dirs + 目录树）。
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import ProjectApprovalDialog from "./ProjectApprovalDialog.vue";
import { useAuthStore } from "../stores/auth";
import { useI18n } from "vue-i18n";
import { useWorkbenchStore, type DirInfo } from "../stores/workbench";

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*）。
const { t, locale } = useI18n();
const store = useWorkbenchStore();
const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "new-dir"): void;
}>();

const auth = useAuthStore();
const menu = ref(false);
const menuCwd = ref("");
const menuEl = ref<HTMLElement | null>(null);
const actionButton = ref<HTMLButtonElement | null>(null);
const approvalCwd = ref("");
const approvalTab = ref<"submit" | "history" | "versions">("submit");
async function openMenu() {
  if (!store.dirCwd) return;
  menuCwd.value = store.dirCwd;
  menu.value = true;
  await nextTick();
  menuEl.value?.querySelector<HTMLElement>("button")?.focus();
}
function closeMenu(restore = false) {
  menu.value = false;
  if (restore)
    (
      actionButton.value as unknown as { $el?: HTMLButtonElement }
    )?.$el?.focus();
}
function contextKey(event: KeyboardEvent) {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    void openMenu();
  }
}
function menuKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  if (event.key === "Tab") {
    closeMenu();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = Array.from(
    menuEl.value?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  );
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length;
  buttons[next]?.focus();
}
async function closeApproval() {
  approvalCwd.value = "";
  await nextTick();
  (actionButton.value as unknown as { $el?: HTMLButtonElement })?.$el?.focus();
}
function request(tab: "submit" | "history" | "versions") {
  approvalTab.value = tab;
  approvalCwd.value = menuCwd.value;
  closeMenu();
}
function outside(event: PointerEvent) {
  if (
    menu.value &&
    !menuEl.value?.contains(event.target as Node) &&
    !(
      actionButton.value as unknown as { $el?: HTMLButtonElement }
    )?.$el?.contains(event.target as Node)
  )
    closeMenu();
}
watch(
  () => [auth.user?.id, store.dirCwd],
  () => {
    closeMenu();
    approvalCwd.value = "";
  },
);
onMounted(() => document.addEventListener("pointerdown", outside));
onUnmounted(() => document.removeEventListener("pointerdown", outside));

/** 运行态徽标数：跨目录活跃感知的唯一入口（设计文档 §4）。 */
function badge(d: DirInfo): number {
  return (d.running_count ?? 0) + (d.queued_count ?? 0);
}

function onChange(v: string) {
  if (v === "__new__") {
    emit("new-dir");
    return;
  }
  if (v && v !== store.dirCwd) store.selectDir(v);
}
</script>

<template>
  <div class="project-selector">
    <label class="project-selector__label" for="dirSel">{{
      t("sidebar.dirLabel")
    }}</label>
    <div
      class="project-selector__controls"
      @contextmenu.prevent="openMenu"
      @keydown="contextKey"
    >
      <ElSelect
        id="dirSel"
        :model-value="store.dirCwd ?? ''"
        :placeholder="t('common.noDir')"
        :teleported="true"
        @change="onChange"
      >
        <ElOption
          v-for="d in store.dirs"
          :key="d.cwd"
          :value="d.cwd"
          :label="d.name + (badge(d) ? ' ●' + badge(d) : '')"
          ><span>{{ d.name }}</span
          ><ElTag v-if="badge(d)" size="small" class="project-count">{{
            badge(d)
          }}</ElTag></ElOption
        >
        <ElOption
          v-if="store.canCreateProject"
          value="__new__"
          :label="t('sidebar.newDirOption')"
        />
      </ElSelect>
      <ElButton
        ref="actionButton"
        text
        :aria-label="locale === 'en' ? 'Project actions' : '项目操作'"
        aria-haspopup="menu"
        :aria-expanded="menu"
        :disabled="!store.dirCwd"
        @click="menu ? closeMenu() : openMenu()"
        >⋯</ElButton
      >
      <ElButton
        text
        :title="t('sidebar.refreshTitle')"
        :aria-label="t('sidebar.refreshTitle')"
        @click="emit('refresh')"
        >↻</ElButton
      >
    </div>
    <div
      v-if="menu"
      ref="menuEl"
      role="menu"
      class="project-action-menu"
      @keydown="menuKey"
    >
      <ElButton text role="menuitem" @click="request('submit')">{{
        locale === "en" ? "Request approval" : "发起审批"
      }}</ElButton>
      <ElButton text role="menuitem" @click="request('history')">{{
        locale === "en" ? "Approval history" : "审批记录"
      }}</ElButton>
      <ElButton text role="menuitem" @click="request('versions')">{{
        locale === "en" ? "Merged versions" : "合并版本"
      }}</ElButton>
    </div>
  </div>
  <ProjectApprovalDialog
    v-if="approvalCwd"
    :cwd="approvalCwd"
    :initial-tab="approvalTab"
    @close="closeApproval"
  />
</template>

<style scoped>
.project-selector {
  position: relative;
}
.project-selector__label {
  display: block;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #919bb0;
  margin-bottom: 9px;
}
.project-selector__controls {
  display: flex;
  gap: 2px;
  align-items: center;
}
.project-selector__controls .el-select {
  flex: 1;
  min-width: 0;
}
.project-selector__controls .el-button {
  padding: 7px;
  margin: 0;
  font-size: 19px;
}
.project-action-menu {
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  margin-top: 8px;
  z-index: 40;
  padding: 6px;
  background: white;
  border: 1px solid #e4e9f3;
  border-radius: 12px;
  box-shadow: 0 12px 35px #18294420;
}
.project-action-menu .el-button {
  width: 100%;
  margin: 0;
  justify-content: flex-start;
  font-size: 13px;
}
.project-count {
  float: right;
  margin-top: 6px;
}
</style>
