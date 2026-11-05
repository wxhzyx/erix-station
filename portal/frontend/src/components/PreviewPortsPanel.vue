<script setup lang="ts">
import {
  ElButton,
  ElTag,
  ElAlert,
  ElSkeleton,
  ElTable,
  ElTableColumn,
} from "element-plus";
// 预览端口列表（#246 交付② 单 B）：工作台「预览端口」区块与管理台 FDE 详情共用同一块 UI。
// 无状态：数据与动作全在调用方（工作台侧栏用 usePreviewPorts 在进视图时拉；管理台在打开面板时拉），
// 本组件只画四态（加载中 / 空 / 失败带错误码 / 列表）+ 每行的「打开预览」「复制域名」。
//
// state 文案口径（§4.7a + 工单红线）：`active` 只代表**首次凭证放行过**，不代表容器里有应用在监听
// ⇒ 一律不写「健康 / 运行中」，未知取值原样透传（不猜语义）。
//
// issue #308：两种形态共用本组件（**状态/错误/空态口径只有一份**，防漂移）：
//   variant='table'（默认，管理台 FdePreviewPortsPane 与 #246 原形态）= 4 列表格；
//   variant='list'（工作台左侧栏紧凑形态）= 每行「端口 + 短状态标签 + 打开按钮」+ 第二行可截断
//   hostname（点击复制完整 url）。侧栏最窄档内容宽约 163px，表格装不下（工单 §3.1）⇒ 紧凑形态里
//   状态用短标签，**完整口径以 title/aria-label 可达**（不得只靠颜色传达），错误仍给「码 + 服务端原文」。
import { onScopeDispose, computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  asPreviewPortState,
  duplicateObservedGroups,
  formatStartedAgo,
  groupByProject,
  projectRootOf,
  retryAfterSeconds,
  type PreviewApiError,
  type PreviewObserved,
  type PreviewPortItem,
} from "../lib/previewPorts";

const props = withDefaults(
  defineProps<{
    items: PreviewPortItem[];
    loading: boolean;
    loaded: boolean;
    error?: PreviewApiError | null;
    ticketBusyId?: string | null;
    ticketError?: PreviewApiError | null;
    popupBlockedUrl?: string | null;
    // #247 的「打开全部预览」与批量签票链已整体下线（观测层时代用户裁定：10 标签页盲开是探测时代的遗产）；
    // composable/后端批量端点保留，面板不再接收批量态 props。
    /** 'me' = 本人端口（GET /api/me/ports）；'fde' = 管理员代看某个 FDE。 */
    scope?: "me" | "fde";
    fdeName?: string | null;
    /**
     * 形态：'table' = 宽容器（管理台，默认）；'list' = 侧栏紧凑行（#308，约 163px 宽）。
     * 两种形态共用状态文案、错误文案、空态与拦截兜底——只是行内布局分叉。
     */
    variant?: "table" | "list";
    /**
     * 观测层 MVP：当前目录（工作台 store.dirCwd，`~/projects/<name>` 形，与观测 cwd 同口径）。
     * 传了 ⇒ 本目录在用的端口排最前；不传（管理台代看）⇒ 只做「有观测优先」，组内维持后端 port ASC。
     */
    currentCwd?: string | null;
    /**
     * 双面板拆分（用户裁定）：侧栏不再按当前目录过滤，而是**按项目根分组**展示——
     * 面板①端口池（url 非空）、面板②进程监听（有观测）各自传子集；当前目录组排最前挂徒章，
     * 池内未用端口收进「空闲」组（仅池面板）。旧后端无观测 ⇒ 分组自动失效，退回平铺。
     */
    groupByProject?: boolean;
    /** 空态文案覆盖（进程面板需要自己的口径，不能拿「你还没有预览端口」凑数）。 */
    emptyLabel?: string | null;
  }>(),
  {
    error: null,
    ticketBusyId: null,
    ticketError: null,
    popupBlockedUrl: null,
    scope: "me",
    fdeName: null,
    variant: "table",
    currentCwd: null,
    groupByProject: false,
    emptyLabel: null,
  },
);

const emit = defineEmits<{
  (e: "open", item: PreviewPortItem): void;
}>();

const { t } = useI18n();

const copiedId = ref<string | null>(null);
const copyError = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

/** 复制的是完整 `url`（含 scheme 与 dev 端口后缀），显示的是 hostname（§4.7a 两字段各自用途）。 */
async function copyUrl(item: PreviewPortItem) {
  if (!item.url) return; // 观测合成行无地址可复制（本不该渲染按钮，防御性兜底）
  try {
    await navigator.clipboard.writeText(item.url);
    copiedId.value = item.id;
    copyError.value = "";
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedId.value = null;
    }, 1500);
  } catch (err) {
    copiedId.value = null;
    copyError.value =
      t("previewPorts.copyFailed") +
      (err instanceof Error ? err.message : String(err));
  }
}

function stateLabel(state: string): string {
  const known = asPreviewPortState(state);
  return known
    ? t(`previewPorts.state.${known}`)
    : t("previewPorts.stateUnknown", { state });
}

/**
 * 紧凑形态的**短**标签（#308 §3.1）：长口径「已放行过（仅表示首次放行过）」单格就 168px > 163px，
 * 装不进侧栏 ⇒ 行内只放短标签，完整口径挂在同一个元素的 title/aria-label 上（不靠颜色传达）。
 */
function stateShortLabel(state: string): string {
  const known = asPreviewPortState(state);
  return known
    ? t(`previewPorts.stateShort.${known}`)
    : t("previewPorts.stateShortUnknown");
}

/** 错误条文案：错误码 + 服务端 message 原文（不许吞成「操作失败」）。 */
function loadErrorText(error: PreviewApiError): string {
  return t("previewPorts.loadFailed", {
    code: error.code,
    message: error.message,
  });
}

/**
 * 签票错误文案（issue #256 交付②）：`Retry-After` 拿得到秒数就说「约 N 秒后可重试」，
 * 拿不到（缺头 / 不可解 / 非 429）退到不带秒数的既有文案——**绝不**显示 `undefined 秒` / `NaN`。
 */
function ticketErrorText(error: PreviewApiError): string {
  const seconds = retryAfterSeconds(error);
  return seconds === null
    ? t("previewPorts.ticketFailed", {
        code: error.code,
        message: error.message,
      })
    : t("previewPorts.ticketFailedRetry", {
        code: error.code,
        message: error.message,
        seconds,
      });
}

// ---------------------------------------------------------------------------
// 观测层 MVP（迁移 0022）：`observed` 只回答「此刻真有没有进程在听、在哪个目录/分支、起了多久」。
// ⚠ null ≠ 空闲（旧 agentd / 未跑 0022 的部署也是 null）⇒ 无观测的行**不加任何反向文案**。
// ---------------------------------------------------------------------------

function observedHere(item: PreviewPortItem): boolean {
  const dir = props.currentCwd?.replace(/\/+$/, "");
  const cwd = item.observed?.cwd;
  if (!dir || !cwd) return false;
  // 精确或子目录命中：agent 常在项目子目录里起服务（frontend/、apps/web/），
  // 只比全串会把「这个项目起的」误判成「与本目录无关」。
  return cwd === dir || cwd.startsWith(`${dir}/`);
}

/**
 * 旧后端（未跑 0022）的 DTO 里**没有** `observed` 键 ⇒ undefined；新后端恒有（可能为 null）。
 * 旧后端 ⇒ 分组自动失效（无观测可分），退回平铺全量。
 */
const observationsAvailable = computed(() =>
  props.items.some((i) => "observed" in i),
);

/** 当前目录的项目根（子目录/绝对形都归一到 `~/projects/<name>`；非项目目录为 null）。 */
const currentRoot = computed(() =>
  projectRootOf(props.currentCwd ?? undefined),
);

interface DisplayGroup {
  root: string | null;
  showHeader: boolean;
  isCurrent: boolean;
  items: PreviewPortItem[];
}

/**
 * 展示分组：分组模式（侧栏双面板）⇒ 在用目录组按项目根分桶，当前目录排最前挂徒章；
 * 池内未用（url 非空且无观测）收进尾部「空闲」组。非分组模式/旧后端 ⇒ 单平铺组（行为同前）。
 */
const displayGroups = computed<DisplayGroup[]>(() => {
  const rank = (item: PreviewPortItem) =>
    observedHere(item) ? 0 : item.observed ? 1 : 2;
  const flat = [...props.items].sort(
    (a, b) => rank(a) - rank(b) || a.port - b.port,
  );
  if (
    props.variant !== "list" ||
    !props.groupByProject ||
    !observationsAvailable.value
  ) {
    return [{ root: null, showHeader: false, isCurrent: false, items: flat }];
  }
  const observed = props.items.filter((i) => i.observed);
  const spare = props.items.filter((i) => !i.observed && i.url);
  const groups = groupByProject(observed).map((g) => ({
    root: g.root as string | null,
    showHeader: true,
    isCurrent: g.root === currentRoot.value,
    items: g.items,
  }));
  groups.sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) ||
      a.root!.localeCompare(b.root!),
  );
  if (spare.length > 0)
    groups.push({
      root: null,
      showHeader: true,
      isCurrent: false,
      items: spare.sort((a, b) => a.port - b.port),
    });
  return groups;
});

/** 行内观测文案：紧凑形态分组头已给目录，行内不重复报 cwd，只报 cmd/分支/已运行。 */
function rowObservedText(item: PreviewPortItem): string {
  return observedText(
    item.observed!,
    props.variant === "list" || observedHere(item),
  );
}

/** 分组头显示名：取目录段（~/projects/shop → shop），完整根挂 title。 */
function dirName(root: string): string {
  return root.split("/").pop() ?? root;
}

/**
 * 同项目根 ≥2 个监听 = 「两个分支各占一口 / 子目录又开一口」的现场；顶部显性警告不让人靠猜。
 * duplicateObservedGroups 已按项目根归并（含池外合成口）。
 */
const duplicateGroups = computed(() => duplicateObservedGroups(props.items));

function observedText(obs: PreviewObserved, hereContext = false): string {
  // 主区行（目录已定）：cmd 比 cwd 有信息量（vite 还是 uvicorn）；cwd 冗余就不重复报。
  const parts: string[] = [];
  if (hereContext) {
    if (obs.branch) parts.push(`@${obs.branch}`);
    if (obs.cmd) parts.push(obs.cmd);
    if (!parts.length)
      parts.push(obs.cwd ?? (obs.pid !== null ? `pid ${obs.pid}` : ""));
  } else {
    parts.push(obs.cwd ?? (obs.pid !== null ? `pid ${obs.pid}` : ""));
    if (obs.branch) parts.push(`@${obs.branch}`);
  }
  const ago = obs.started_at ? formatStartedAgo(obs.started_at) : null;
  if (ago) parts.push(t("previewPorts.observedUptime", { ago }));
  return parts.filter(Boolean).join(" ");
}

/** title 里给全量细节（紧凑行会被 truncate 掉）。 */
function observedTitle(obs: PreviewObserved): string {
  const bits = [t("previewPorts.observedTitle")];
  if (obs.cwd) bits.push(obs.cwd);
  if (obs.branch) bits.push(`@${obs.branch}`);
  if (obs.cmd) bits.push(obs.cmd);
  if (obs.started_at) bits.push(new Date(obs.started_at).toLocaleString());
  return bits.join(" · ");
}

// 卸载时收掉复制回显的定时器（复制提示是纯本地态，组件都没了就没必要再改 ref）
onScopeDispose(() => clearTimeout(copiedTimer));
</script>

<template>
  <section data-test="preview-ports-panel-body" class="ports-panel">
    <header v-if="props.variant === 'table'" class="ports-panel__heading">
      <h3>
        {{
          props.scope === "fde"
            ? t("previewPorts.adminTitle", { fde: props.fdeName ?? "" })
            : t("previewPorts.title")
        }}
      </h3>
      <ElTag size="small" type="info">{{ props.items.length }}</ElTag>
    </header>
    <div
      v-if="props.loading && !props.loaded"
      data-test="preview-ports-loading"
      role="status"
    >
      <p>{{ t("common.loading") }}</p>
      <ElSkeleton :rows="3" animated />
    </div>
    <ElAlert
      v-if="props.error"
      data-test="preview-ports-error"
      :title="loadErrorText(props.error)"
      type="error"
      :closable="false"
      role="alert"
    />
    <p
      v-if="!props.error && props.loaded && !props.items.length"
      data-test="preview-ports-empty"
      class="ports-empty"
      role="status"
    >
      {{
        props.emptyLabel ??
        (props.scope === "fde"
          ? t("previewPorts.emptyFde")
          : t("previewPorts.emptySelf"))
      }}
    </p>
    <template v-if="props.items.length">
      <ElAlert
        v-if="duplicateGroups.length"
        data-test="preview-observed-duplicates"
        type="warning"
        :closable="false"
        role="alert"
        ><p
          v-for="group in duplicateGroups"
          :key="group.cwd"
          data-test="preview-observed-duplicate-line"
        >
          {{
            t("previewPorts.duplicateWarn", {
              cwd: group.cwd,
              ports: group.ports.join(", "),
            })
          }}
        </p></ElAlert
      >
      <ElTable
        v-if="props.variant === 'table'"
        data-test="preview-ports-table"
        :data="displayGroups[0]?.items"
        row-key="id"
        row-class-name="preview-port-row"
        class="ports-table"
      >
        <ElTableColumn :label="t('previewPorts.colPort')" width="90"
          ><template #default="{ row: item }"
            ><strong data-test="preview-port-value">{{
              item.port
            }}</strong></template
          ></ElTableColumn
        >
        <ElTableColumn :label="t('previewPorts.colHostname')" min-width="210"
          ><template #default="{ row: item }"
            ><div>
              <ElButton
                v-if="item.url"
                link
                data-test="preview-port-hostname"
                class="port-hostname"
                :title="t('previewPorts.hostnameCopyTitle', { url: item.url })"
                @click="copyUrl(item as PreviewPortItem)"
                >{{ item.hostname }}</ElButton
              ><span v-else data-test="preview-port-unrouted">—</span>
              <p
                v-if="item.observed"
                data-test="preview-port-observed"
                class="port-observation"
                :title="observedTitle(item.observed)"
              >
                {{ rowObservedText(item as PreviewPortItem) }}
              </p>
            </div></template
          ></ElTableColumn
        >
        <ElTableColumn :label="t('previewPorts.colState')" min-width="140"
          ><template #default="{ row: item }"
            ><ElTag
              data-test="preview-port-state"
              :type="item.state === 'active' ? 'primary' : 'info'"
              size="small"
              >{{ stateLabel(item.state) }}</ElTag
            ></template
          ></ElTableColumn
        >
        <ElTableColumn
          :label="t('previewPorts.colActions')"
          width="110"
          align="right"
          ><template #default="{ row: item }"
            ><ElButton
              v-if="item.url"
              data-test="preview-port-open"
              type="primary"
              plain
              size="small"
              :loading="props.ticketBusyId === item.id"
              :disabled="props.ticketBusyId !== null"
              @click="emit('open', item as PreviewPortItem)"
              >{{
                props.ticketBusyId === item.id
                  ? t("previewPorts.signing")
                  : t("previewPorts.openAction")
              }}</ElButton
            ></template
          ></ElTableColumn
        >
      </ElTable>
      <ul v-else data-test="preview-ports-list" class="ports-list">
        <template
          v-for="group in displayGroups"
          :key="group.root ?? (group.showHeader ? 'spare' : 'flat')"
        >
          <li
            v-if="group.showHeader"
            data-test="preview-port-group-header"
            class="ports-group"
          >
            <span :title="group.root ?? undefined">{{
              group.root === null
                ? t("previewPorts.spareGroup", { count: group.items.length })
                : dirName(group.root)
            }}</span
            ><ElTag
              v-if="group.isCurrent"
              data-test="preview-port-group-current"
              size="small"
              >{{ t("previewPorts.currentBadge") }}</ElTag
            >
          </li>
          <li
            v-for="item in group.items"
            :key="item.id"
            data-test="preview-port-row"
            class="port-card"
          >
            <div class="port-card__heading">
              <strong data-test="preview-port-value">{{ item.port }}</strong
              ><ElTag
                v-if="item.url"
                data-test="preview-port-state"
                size="small"
                :type="item.state === 'active' ? 'primary' : 'info'"
                :title="stateLabel(item.state)"
                :aria-label="stateLabel(item.state)"
                >{{ stateShortLabel(item.state) }}</ElTag
              ><ElButton
                v-if="item.url"
                data-test="preview-port-open"
                text
                circle
                size="small"
                :loading="props.ticketBusyId === item.id"
                :disabled="props.ticketBusyId !== null"
                :title="
                  props.ticketBusyId === item.id
                    ? t('previewPorts.signing')
                    : t('previewPorts.openAction')
                "
                :aria-label="
                  props.ticketBusyId === item.id
                    ? t('previewPorts.signing')
                    : t('previewPorts.openAction')
                "
                @click="emit('open', item as PreviewPortItem)"
                ><svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  aria-hidden="true"
                >
                  <path d="M14 4h6v6M20 4 9 15M11 5H4v15h15v-7" /></svg
              ></ElButton>
            </div>
            <ElButton
              v-if="item.url"
              data-test="preview-port-hostname"
              class="port-hostname"
              link
              :title="t('previewPorts.hostnameCopyTitle', { url: item.url })"
              @click="copyUrl(item as PreviewPortItem)"
              >{{ item.hostname }}</ElButton
            >
            <p
              v-else
              data-test="preview-port-unrouted"
              class="port-observation"
            >
              {{ t("previewPorts.unroutedNote") }}
            </p>
            <p
              v-if="item.observed"
              data-test="preview-port-observed"
              class="port-observation"
              :title="observedTitle(item.observed)"
            >
              {{ rowObservedText(item as PreviewPortItem) }}
            </p>
          </li>
        </template>
      </ul>
      <p v-if="props.variant === 'table'" class="ports-footnote">
        {{ t("previewPorts.stateHint") }}
      </p>
      <ElAlert
        v-if="copyError"
        data-test="preview-port-copy-error"
        :title="copyError"
        type="error"
        :closable="false"
        role="alert"
      />
      <p
        v-else-if="copiedId"
        data-test="preview-port-copied"
        class="ports-copied"
        role="status"
      >
        {{ t("previewPorts.copiedUrl") }}
      </p>
    </template>
    <ElAlert
      v-if="props.ticketError"
      data-test="preview-ticket-error"
      :title="ticketErrorText(props.ticketError)"
      type="error"
      :closable="false"
      role="alert"
    />
    <ElAlert
      v-if="props.popupBlockedUrl"
      data-test="preview-popup-blocked"
      type="warning"
      :closable="false"
      role="status"
      >{{ t("previewPorts.popupBlocked") }}
      <a
        :href="props.popupBlockedUrl"
        target="_blank"
        rel="noopener"
        data-test="preview-popup-fallback-link"
        >{{ t("previewPorts.popupBlockedLink") }}</a
      ></ElAlert
    >
  </section>
</template>

<style scoped>
.ports-panel {
  min-width: 0;
  display: grid;
  gap: 10px;
}
.ports-panel__heading {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ports-panel h3 {
  font-size: 14px;
  margin: 0;
}
.ports-empty,
.ports-footnote {
  font-size: 12px;
  color: #8995aa;
  line-height: 1.6;
  margin: 4px 0;
}
.ports-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.port-card {
  padding: 10px;
  border: 1px solid #e5eaf3;
  border-radius: 10px;
  background: white;
  min-width: 0;
}
.port-card__heading {
  display: flex;
  align-items: center;
  gap: 8px;
}
.port-card__heading strong {
  font:
    600 12px ui-monospace,
    monospace;
  color: #344766;
}
.port-card__heading .el-button {
  margin-left: auto;
}
.port-card__heading .el-tag {
  max-width: 100%;
  overflow: hidden;
  font-size: 10px;
}
.port-hostname {
  max-width: 100%;
  font-size: 11px;
  text-align: left;
  justify-content: flex-start;
  overflow: hidden;
  color: #657999;
  margin-top: 4px;
}
.port-hostname :deep(span) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.port-observation {
  font-size: 10px;
  color: #8c98ac;
  margin: 5px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.6;
}
.ports-group {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  color: #6c7d96;
  margin-top: 8px;
}
.ports-group > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ports-copied {
  font-size: 11px;
  color: #188b68;
  margin: 0;
}
.ports-panel .el-alert {
  font-size: 11px;
  padding: 9px 10px;
}
.ports-panel :deep(.el-alert__title) {
  font-size: 11px;
  line-height: 1.6;
}
.ports-panel a {
  color: #365cf5;
}
</style>
