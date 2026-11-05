<script setup lang="ts">
import { ElButton, ElInput, ElEmpty, ElTag } from "element-plus";
// 侧栏（issue #84 P5.4，设计文档 §4 左栏竖排三段；issue #92 改 aside 内 flex-col 三段布局）：
// 侧栏（issue #84 P5.4，设计文档 §4 左栏竖排三段；issue #92 改 aside 内 flex-col 三段布局）：
//   ① 固定头：目录下拉（DirSelect：目录名 + ●N 运行态徽标 + ↻ 双刷；末项「＋ 新建目录」
//      选中新版弹 modal —— NewDirectoryModal，不再内联挤在头部）+ 「＋ 新会话」按钮 +
//      🔍 浏览会话（issue #94 入口；Ctrl/⌘+K 同语义）——不随列表滚动
//   ② 会话列表段：flex-1 min-h-0 overflow-y-auto，独立内部滚动（空态文案「先创建目录」/
//      「暂无会话」/平台管理员提示也放这里）——列表再长也不推挤头与树
//   ③ 底部堆叠区（issue #308）：**一个**滚动容器（shrink-0 max-h-[50vh] overflow-y-auto）里装
//      「预览端口段 + 目录树面板」，两段**各自一个折叠开关**（都默认折叠、不持久化、不共用总开关）。
//      高度/滚动预算只留这一层：树与端口面板都不再自带 overflow/max-h，否则三层滚动会抢滚轮。
//      底部栈恒在列表之下 ⇒ 任意会话数下端口段与目录树恒可达，而列表仍然独立可滚。
// issue #94（评审裁决瘦身版）：SessionPickerModal（单次全量浏览）挂在本组件与 WorkbenchView。
// 移动端抽屉（≤768px）由父级 WorkbenchView 以 Tailwind max-md: 变体实现（旧 offcanvas 桥接的等价），
// 三段结构在抽屉内同样成立（aside 高度由 max-md:inset-y-0 撑满，h-full 生效）。
//
// issue #308 的几何测试钩子（名字照工单 §五.7，不得自创）：
//   data-test="sidebar-aside"（根）/ "sidebar-session-list"（列表段）/ "sidebar-bottom-stack"（底部栈）。
import { computed, nextTick, onMounted, onScopeDispose, ref } from "vue";
import type { ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkbenchStore } from "../stores/workbench";
import type { Session } from "../stores/workbench";
import { SESSION_TITLE_MAX_LEN } from "../lib/constants";
import DirSelect from "./DirSelect.vue";
import DirectoryTree from "./DirectoryTree.vue";
import FilePreviewModal from "./FilePreviewModal.vue";
import NewDirectoryModal from "./NewDirectoryModal.vue";
import { runningPreviewPorts } from "../lib/previewPorts";
import PreviewPortsPanel from "./PreviewPortsPanel.vue";
import SessionPickerModal from "./SessionPickerModal.vue";
import { usePreviewPorts } from "../composables/usePreviewPorts";

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*；代码注释保持中文原文）。
const { t } = useI18n();
const store = useWorkbenchStore();
const emit = defineEmits<{
  (e: "select-session", id: string): void;
  (e: "new-session"): void;
}>();

// ---- ↻ 单按钮双刷：/api/dirs（store.refreshDirs）+ 目录树（组件 reload → 全折叠重载根层）----
// issue #308 §四：↻ 语义**不动**——它继续只刷「目录列表 + 目录树」，**不**扩到刷新预览端口
// （端口段有自己的「重试」按钮；且 usePreviewPorts.load() 没有 in-flight 守卫，扩功能要先自己加并发闸门，本单不做）。
const treeRef = ref<InstanceType<typeof DirectoryTree> | null>(null);
function onRefresh() {
  void store.refreshDirs().catch(() => {
    /* loadDirs 失败静默：下拉保留旧数据，下次刷新重试 */
  });
  treeRef.value?.reload();
}

// ---- issue #308：预览端口段（从工作台顶栏搬进侧栏底部，与目录树各自独立折叠）----
// 语义逐字保持 #246：进视图就拉一次 GET /api/me/ports（折叠也拉，aside 在移动端是「类隐藏」不是 v-if）；
// 但**预览 ticket 绝不预取**——60 秒过期且一次性，预取等于把它用废（点击当场才签，见 usePreviewPorts.openPreview）。
// #247 的批量签票同一条纪律：只在点「打开全部预览」时调 `openAllPreviews`（挂载不签、折叠不签）。
// 折叠态是纯本地 ref，**不持久化**（不写 localStorage、不发后端），刷新后回到折叠。
const ports = usePreviewPorts();
// Only fresh listener evidence counts as running; allocation/previous access is not activity.
const poolOpen = ref(false);
const observationNow = ref(Date.now());
const freshnessTimer = setInterval(() => {
  observationNow.value = Date.now();
}, 1000);
onScopeDispose(() => clearInterval(freshnessTimer));
const procItems = computed(() =>
  runningPreviewPorts(ports.items.value, observationNow.value),
);
const procToggleLabel = computed(() =>
  ports.listError.value
    ? t("previewPorts.procToggleFailed")
    : procItems.value.length
      ? t("previewPorts.procToggleCount", { count: procItems.value.length })
      : t("previewPorts.procToggle"),
);

// load() 自带 try/catch/finally（失败落 listError），不会产生未捕获拒绝（AGENTS §4 / #281）。
onMounted(() => {
  void ports.load();
});

// ---- issue #84 P6：目录树文件点击 → 文件预览 modal（cwd 上下文 = store.dirCwd）----
const previewTarget = ref<{ cwd: string; path: string } | null>(null);
function onFileClick(path: string) {
  if (!store.dirCwd) return; // 无目录时树面板本不可交互，防御性兜底
  previewTarget.value = { cwd: store.dirCwd, path };
}

// ---- issue #94：会话选择 modal（固定头 🔍 入口；Ctrl/⌘+K 由 WorkbenchView 提供）----
const pickerOpen = ref(false);
const pickerScope = ref<"cwd" | "all">("cwd");
function openPicker(scope: "cwd" | "all") {
  pickerScope.value = scope;
  pickerOpen.value = true;
}
function onPickerSelect(id: string) {
  pickerOpen.value = false;
  emit("select-session", id); // 路由 push/跨目录逻辑由视图 onSelectSession 统一处理
}

// ---- 「＋ 新建目录」modal（原内联表单迁出至 NewDirectoryModal，创建成功后打开新会话）----
const newDirOpen = ref(false);
function onNewDirCreated(sessionId: string) {
  newDirOpen.value = false;
  emit("select-session", sessionId); // 新目录 + 首个会话：路由 push 由视图做
}

// ---- issue #107：会话卡片内联重命名（PATCH /api/sessions/:id，零后端接口改动）----
// 交互：hover 卡片右端浮现铅笔按钮 → 点击原地换 <input>（不弹 modal；autofocus + 全选）；Enter 提交 /
// Esc 取消 / blur 提交；空串/纯空白前端拦截不发请求（空串落库会置 title_source='manual'，
// 永久关掉后续自动命名——宁可无操作）。同一时刻只允许一个卡片处于编辑态。
const editingId = ref<string | null>(null);
const editTitle = ref("");
const editError = ref<{ id: string; text: string } | null>(null); // 失败轻提示（卡片内 transient 行）
const editInput = ref<HTMLInputElement | null>(null);

/** 函数式 ref：v-for 内的字符串 ref 会退化为数组，函数 ref 对「同时只有一个编辑框」最直白。 */
function setEditInput(el: Element | ComponentPublicInstance | null) {
  editInput.value =
    el instanceof HTMLInputElement
      ? el
      : ((el as unknown as { input?: HTMLInputElement } | null)?.input ?? null);
}

async function startEdit(s: Session) {
  const id = String(s.id);
  editingId.value = id;
  editTitle.value = s.title ?? "";
  editError.value = null;
  await nextTick(); // input 挂载后聚焦 + 全选（改整个名字，而非在尾部追加）
  editInput.value?.focus();
  editInput.value?.select();
}

function cancelEdit() {
  editingId.value = null;
  editTitle.value = "";
}

/** Enter 提交 / Esc 取消；组词中的 Enter/Esc（中文输入法确认候选）不得当作提交/取消。 */
function onEditKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === "Enter") {
    e.preventDefault();
    void commitEdit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    cancelEdit();
  }
}

/**
 * 提交（Enter / blur）：先退出编辑态再发请求——blur 迟到不会重复提交；空串拦截不发请求。
 * 成功：store.renameSession 已原地更新列表项（title/title_source），无需整表刷新；
 * 失败：store 未被改动（卡片自动回退旧标题）+ 卡片内一条轻提示（项目无 toast 体系，沿用 .syserr 行内）。
 */
async function commitEdit() {
  const id = editingId.value;
  if (id == null) return; // 已取消 / 已提交（重复 blur）
  editingId.value = null;
  const raw = editTitle.value;
  editTitle.value = "";
  if (!raw.trim()) return;
  const { error } = await store.renameSession(id, raw);
  if (error)
    editError.value = {
      id,
      text: t("errors.renameFailed", { message: error }),
    };
}

// ---- issue #114：「AI 改名」按钮（铅笔旁同款 24px 浮现方块按钮）----
// 点击 → 行内 loading（按钮禁用 + 转圈）→ POST /api/sessions/:id/ai-title → 成功原地更新 store 标题；
// 失败走卡片内 `.syserr` 行内提示（沿用 #107 模式，无 toast 体系）。同一时刻只允许一个请求在飞。
const aiLoadingId = ref<string | null>(null);

async function aiRename(s: Session) {
  const id = String(s.id);
  if (aiLoadingId.value != null) return; // 已有一个在飞：忽略重复点击（含跨行）
  aiLoadingId.value = id;
  editError.value = null; // 清掉上一次的行内提示（重命名/AI 改名共用同一提示行）
  const { error } = await store.aiRenameSession(id);
  aiLoadingId.value = null;
  if (error)
    editError.value = {
      id,
      text: t("errors.aiRenameFailed", { message: error }),
    };
}

// ---- issue #112：左栏视觉收敛（向 pi-web 靠拢）----
// 行样式为纯呈现层：选中判定抽成函数供 class 绑定复用（与原内联表达式语义完全等价，不改选中逻辑）。
/** 该会话是否为当前选中（行样式：左 2px brand 竖条 + 浅绿底）。 */
function isActive(s: Session): boolean {
  return String(s.id) === String(store.sessionId);
}

/**
 * issue #197：列表项副行的消息数后缀（「 · N 条消息」，口径同头部状态行：后端 listSessions
 * COUNT 全量 messages 行含 synthetic）。缺失（旧后端/非列表来源）或 0（与头部状态行
 * messages > 0 才显示的阈值一致，新会话不显示「0 条」）→ 返回空串不渲染。
 */
function messageCountSuffix(s: Session): string {
  const n = s.message_count;
  return typeof n === "number" && n > 0
    ? ` · ${t("sidebar.messageCount", { count: n })}`
    : "";
}
</script>

<template>
  <section data-test="sidebar-aside" class="workspace-sidebar">
    <header class="workspace-sidebar__header">
      <p class="workspace-label">{{ t("sidebar.workspaceLabel") }}</p>
      <DirSelect @refresh="onRefresh" @new-dir="newDirOpen = true" />
      <div class="workspace-sidebar__actions">
        <ElButton
          type="primary"
          :disabled="store.newSessDisabled"
          @click="emit('new-session')"
          ><span aria-hidden="true">＋</span>
          {{ t("sidebar.newSession") }}</ElButton
        >
        <ElButton
          :title="t('sidebar.browseTitle')"
          :aria-label="t('sidebar.browse')"
          @click="openPicker(store.dirCwd ? 'cwd' : 'all')"
          ><svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 5 5" /></svg
        ></ElButton>
      </div>
    </header>
    <div data-test="sidebar-session-list" class="workspace-sidebar__sessions">
      <ElEmpty
        v-if="store.noDir || !store.sessions.length"
        :image-size="46"
        :description="
          store.noDir ? t('common.createFirstDir') : t('sidebar.noSessions')
        "
      />
      <article
        v-for="s in store.sessions"
        :key="String(s.id)"
        data-session-row
        class="session-card"
        :class="{ 'is-active': isActive(s) }"
        @click="emit('select-session', String(s.id))"
      >
        <ElInput
          v-if="editingId === String(s.id)"
          :ref="setEditInput"
          v-model="editTitle"
          :maxlength="SESSION_TITLE_MAX_LEN"
          :placeholder="t('sidebar.renamePlaceholder')"
          :aria-label="t('sidebar.rename')"
          @click.stop
          @keydown="onEditKeydown($event as KeyboardEvent)"
          @blur="commitEdit"
        />
        <template v-else>
          <button
            class="session-card__select"
            @click.stop="emit('select-session', String(s.id))"
          >
            <strong>{{ s.title || t("common.unnamedSession") }}</strong
            ><small>{{ store.sessMeta(s) }}{{ messageCountSuffix(s) }}</small>
          </button>
          <div class="session-card__tools">
            <ElButton
              text
              circle
              size="small"
              :loading="aiLoadingId === String(s.id)"
              :title="
                aiLoadingId === String(s.id)
                  ? t('sidebar.aiRenaming')
                  : t('sidebar.aiRename')
              "
              :aria-label="t('sidebar.aiRename')"
              :disabled="aiLoadingId === String(s.id)"
              @click.stop="aiRename(s)"
              >✦</ElButton
            >
            <ElButton
              text
              circle
              size="small"
              :title="t('sidebar.rename')"
              :aria-label="t('sidebar.rename')"
              @click.stop="startEdit(s)"
              ><svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
              >
                <path d="m16 4 4 4-12 12-5 1 1-5Z" /></svg
            ></ElButton>
          </div>
        </template>
        <p v-if="editError?.id === String(s.id)" class="syserr" role="alert">
          {{ editError.text }}
        </p>
      </article>
    </div>
    <div data-test="sidebar-bottom-stack" class="workspace-sidebar__resources">
      <section class="resource-section">
        <ElButton
          text
          data-test="preview-ports-toggle"
          class="resource-heading"
          :aria-expanded="poolOpen"
          aria-controls="preview-ports-disclosure"
          @click="poolOpen = !poolOpen"
          ><span aria-hidden="true">{{ poolOpen ? "⌄" : "›" }}</span
          ><span>{{ procToggleLabel }}</span
          ><ElTag v-if="procItems.length" size="small" effect="light">{{
            procItems.length
          }}</ElTag></ElButton
        >
        <div v-show="poolOpen" id="preview-ports-disclosure">
          <PreviewPortsPanel
            variant="list"
            :items="procItems"
            :current-cwd="store.dirCwd"
            :loading="ports.loading.value"
            :loaded="ports.loaded.value"
            :error="ports.listError.value"
            :ticket-busy-id="ports.ticketBusyId.value"
            :ticket-error="ports.ticketError.value"
            :popup-blocked-url="ports.popupBlockedUrl.value"
            :empty-label="t('previewPorts.procEmpty')"
            @open="(item) => void ports.openPreview(item)"
          />
        </div>
      </section>
      <DirectoryTree
        ref="treeRef"
        :cwd="store.dirCwd"
        @file-click="onFileClick"
      />
    </div>
    <FilePreviewModal
      v-if="previewTarget"
      :cwd="previewTarget.cwd"
      :path="previewTarget.path"
      @close="previewTarget = null"
    />
    <NewDirectoryModal
      v-if="newDirOpen"
      @created="onNewDirCreated"
      @close="newDirOpen = false"
    />
    <SessionPickerModal
      v-if="pickerOpen"
      :scope="pickerScope"
      :cwd="store.dirCwd ?? undefined"
      @select="onPickerSelect"
      @close="pickerOpen = false"
    />
  </section>
</template>

<style scoped>
.workspace-label {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.1em;
  color: #8b99b0;
  margin: 0 0 16px;
}
.workspace-sidebar {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: #28334c;
}
.workspace-sidebar__header {
  padding: 18px 14px 12px;
  flex-shrink: 0;
}
.workspace-admin-link {
  display: flex;
  justify-content: space-between;
  padding: 9px 12px;
  margin-bottom: 12px;
  color: #52617b;
  font-size: 12px;
  text-decoration: none;
  border: 1px solid #e3e8f1;
  border-radius: 9px;
  background: white;
}
.workspace-sidebar__actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.workspace-sidebar__actions > .el-button:first-child {
  flex: 1;
}
.workspace-sidebar__actions .el-button + .el-button {
  margin: 0;
}
.workspace-sidebar__sessions {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 12px;
}
.session-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 66px;
  padding: 8px 10px;
  margin: 4px 0;
  border: 1px solid transparent;
  border-radius: 11px;
  cursor: pointer;
}
.session-card:hover {
  background: #eef2f9;
}
.session-card.is-active {
  background: #fff;
  border-color: #dfe6ff;
  box-shadow: 0 3px 12px #253a6a08;
}
.session-card__select {
  border: 0;
  background: none;
  text-align: left;
  min-width: 0;
  flex: 1;
  padding: 2px 0;
  color: inherit;
  cursor: pointer;
}
.session-card__select strong,
.session-card__select small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-card__select strong {
  font-size: 13px;
  font-weight: 550;
  line-height: 1.6;
}
.session-card__select small {
  margin-top: 5px;
  font-size: 10px;
  color: #8791a5;
}
.is-active .session-card__select strong {
  color: #365cf5;
}
.session-card__tools {
  display: flex;
  opacity: 0;
}
.session-card:hover .session-card__tools,
.session-card:focus-within .session-card__tools {
  opacity: 1;
}
.session-card__tools .el-button + .el-button {
  margin: 0;
}
.session-card .syserr {
  width: 100%;
  font-size: 11px;
}
.workspace-sidebar__resources {
  flex-shrink: 0;
  max-height: 50vh;
  overflow-y: auto;
  padding: 4px 14px 12px;
  border-top: 1px solid #e5eaf2;
}
.resource-heading {
  width: 100%;
  justify-content: flex-start;
  padding: 10px 0 !important;
  font-size: 12px;
  font-weight: 600;
}
.resource-heading :deep(> span) {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
}
.resource-heading .el-tag {
  margin-left: auto;
}
@media (hover: none) {
  .session-card__tools {
    opacity: 1;
  }
}
</style>
