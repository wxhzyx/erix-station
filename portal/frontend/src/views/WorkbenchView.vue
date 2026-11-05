<script setup lang="ts">
import { ElButton } from "element-plus";
// 工作台壳（P2）：侧栏（移动端抽屉）+ 消息流 + composer + 深链/自动跟随。
// 深链 #/session/<id> 已迁入 vue-router（/session/:id 路由，issue #55 B1 语义平移）：
//   列表内直开 / 跨项目切项目后打开（写回深链）/ 404 静默回退清路由 / 其他错误保留路由 + 报错。
// popstate（前进/后退）由 vue-router hash 模式驱动路由参数变化 → 本组件 watcher 等价旧 popstate 处理器。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { setWorkbenchHooks, useWorkbenchStore } from "../stores/workbench";
// issue #431：用户 scope 结束的接线（注册方，触发方在 stores/auth.ts）。
import { setUserScopeResetListener } from "../lib/userScope";
import { AUTO_FOLLOW_GAP } from "../lib/constants";
import {
  useSidebarWidth,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "../composables/useSidebarWidth";
import SidebarPanel from "../components/SidebarPanel.vue";
import StreamPanel from "../components/StreamPanel.vue";
// issue #282：输入框上方常驻动量状态条（run 级量化信号；消息级时刻在 StreamPanel 里）。
import RunStatusBar from "../components/RunStatusBar.vue";
import ComposerBar from "../components/ComposerBar.vue";
import QueuedInputsBar from "../components/QueuedInputsBar.vue";
import SessionPickerModal from "../components/SessionPickerModal.vue";
import StationShell from "../components/StationShell.vue";
// issue #359（决策 §7 D9）P0b：顶栏「收工灯」——只回答“你的活儿被 git 保护住了吗”，平台零 git 写。
import GitLightBadge from "../components/GitLightBadge.vue";
import { useGitLight } from "../composables/useGitLight";
import { toDisplayText } from "../api"; // issue #281：失败详情进文案前过一道收口（不渗 [object Object]/undefined）

// issue #101 P2：顶栏文案走 i18n（workbench.* / common.*）；LocaleSwitch 挂管理台/登出旁。
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useWorkbenchStore();

// ---- issue #90：侧栏宽度拖拽调整（钳制/持久化/键盘微调在 composable 内）----
const sidebar = useSidebarWidth();

// ---- 路由钩子注入（store 保持 router 无关，便于单测）----
setWorkbenchHooks({
  onClearRoute: () => router.replace("/"),
  onDeepLinkRestored: (sid) =>
    router.replace(`/session/${encodeURIComponent(sid)}`),
});

// issue #431：把「本轮用户结束 → 工作台不再归属任何人」注册到应用级信号上（`auth.logout()` / 会话
// 过期都会 notify）。**只注册不注销**：`onUnmounted` 里清掉就等于重新漏掉「从管理台登出」那条路径——
// 卸载后 listener 仍指向同一个 pinia 单例，正是需要的语义。口径详见 lib/userScope.ts。
setUserScopeResetListener(() => {
  store.claimOwnership(null);
});

// ---- 深链解析（resolveHashSession 语义平移；popstate = 路由参数变化）----
watch(
  () => route.params.id,
  async (sid) => {
    if (sid) {
      if (String(sid) === String(store.sessionId)) return;
      await store.resolveRouteSession(String(sid));
    } else if (store.sessionId) {
      store.resetSessionView();
    }
  },
);

async function onSelectSession(id: string) {
  // 评审修复：同会话重开只刷新（旧 replaceState 语义），不重复 push 历史
  if (String(id) === String(store.sessionId)) {
    await store.openSession(id);
    return;
  }
  drawerOpen.value = false; // issue #55 B4：移动端选中会话后自动收起抽屉
  await router.push(`/session/${encodeURIComponent(id)}`);
}

async function onNewSession() {
  const s = await store.createSession();
  if (s) await router.push(`/session/${encodeURIComponent(String(s.id))}`);
}

// ---- issue #94：Ctrl/⌘+K 全局快捷键打开会话浏览（scope='all' 跨目录找回）----
const pickerOpen = ref(false);
function onGlobalKeydown(e: KeyboardEvent) {
  // 组合键判定：Ctrl/⌘+K 且非输入法组合（e.isComposing）——普通键入不经此拦截，不与输入框冲突
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.key.toLowerCase() !== "k" || e.isComposing) return;
  e.preventDefault();
  pickerOpen.value = true;
}
onMounted(() => window.addEventListener("keydown", onGlobalKeydown));
onUnmounted(() => window.removeEventListener("keydown", onGlobalKeydown));
function onPickerSelect(id: string) {
  pickerOpen.value = false;
  void onSelectSession(id); // 复用现有深链逻辑（同会话刷新 / 跨目录 / 路由 push）
}

// ---- issue #308：预览端口段已从本视图的顶栏横条搬进左侧栏底部（SidebarPanel 内，与目录树各自折叠）----
// 数据所有权也跟着走：usePreviewPorts + onMounted(load) 现在在 SidebarPanel（侧栏在工作台挂载时恒在，
// 折叠只是不占位）⇒ 「进视图就拉一次、折叠也拉、ticket 绝不预取」的语义逐字不变，
// 只是不再占消息流上方的垂直空间。本视图不再碰 /api/me/ports。

onMounted(async () => {
  if (!auth.user) return; // 守卫保证已登录
  // issue #428：SPA 登出**不重载页面** ⇒ 本视图重挂载时 workbench store 还是上一个账号的。
  // 第一步就按当前登录者认领（身份变了则先全量复位），且必须在 `initWorkspace` 之前同步跑完。
  store.claimOwnership(String(auth.user.id));
  // issue #281：**Vue 不等 onMounted 返回的 Promise** ⇒ 里面每一个 `await` 都必须自己收尾，否则一次
  // /api/dirs 失败就是 Unhandled Rejection（代价真实发生过：v0.1.7 打 tag 时 CI 步骤④ 就红在这两个
  // 无 catch 的 await 上，AGENTS §4 与 §8.20）。本地 catch ≠ 加一层重试：**不重试**，只把失败变成
  // 界面上看得见的错误行（以前是「空着像服务没起」，只有控制台知道）。准入闸（lib/workbenchGate.ts，
  // #332/#334）不在本钩子里，本钩子只改失败的可观测性，不改谁能进来。
  try {
    await store.initWorkspace();
    if (
      typeof route.query.cwd === "string" &&
      store.dirs.some((d) => d.cwd === route.query.cwd)
    )
      await store.selectDir(route.query.cwd);
    if (typeof route.query.prompt === "string" && !store.inputValue)
      store.inputValue = route.query.prompt.slice(0, 2000);
  } catch (e) {
    store.pushStreamError(
      t("errors.workspaceLoadFailed", {
        message: toDisplayText(e instanceof Error ? e.message : e),
      }),
    );
    return; // 目录都没拉到，别再走深链（resolveRouteSession 依赖目录/会话列表）
  }
  // issue #55 B1：启动时若路由带 /session/<id>（旧 #/session/<id>），走统一深链解析
  if (!route.params.id) return;
  try {
    await store.resolveRouteSession(String(route.params.id));
  } catch (e) {
    // 深链自己内部已经处理了 404（静默回默认视图）与其他 ApiError（已推 syserr）；走到这里的是
    // **形状意外**（旧后端回包缺键等），同样不许演成未捕获拒绝（#281 的 `session.cwd` TypeError 就属这类）。
    store.pushStreamError(t("errors.sessionLoadFailed"));
    console.error("Failed to resolve route session", e);
  }
});

// ---- issue #55 B4：移动端抽屉（≤768px，Tailwind max-md: 变体替代旧 offcanvas 桥接）----
const drawerOpen = ref(false);
// 切目录/切会话（离开会话）时收起抽屉——旧 switchProject/openSession 的 classList.remove('drawer-open')。
watch([() => store.dirCwd, () => store.sessionId], () => {
  drawerOpen.value = false;
});

// ---- issue #84 P5.4：顶栏 cwd 徽标（📁 短名；hover 全路径；点击复制）----
const dirShortName = computed(
  () => store.currentDir?.name ?? store.dirCwd?.split("/").pop() ?? "",
);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyCwd() {
  if (!store.dirCwd) return;
  try {
    await navigator.clipboard.writeText(store.dirCwd);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    /* 剪贴板不可用（非安全上下文等）：静默降级，title 仍可看全路径 */
  }
}

// ---- issue #359 P0b：收工灯（数据层 useGitLight，显示口径 lib/gitLight.ts）----
// 刷新时机（**没有轮询以外的定时器**除外：composable 自带 30s 兵底 + 回前台即刷）：
//   ① 切目录 ⇒ 先 reset 再拉（旧目录的绿不得顶到新目录头上）；
//   ② **一个 run 结束的那一刻**（running 从 true 落 false）⇒ 重判——这是灯最需要新鲜的时刻，
//      用户刚让 AI 干完活，30s 轮询的拖尾在这里不可接受；
//   ③ onMounted 拉一次（initWorkspace 之后才有 dirCwd，所以给 watch 加 immediate）。
const gitLight = useGitLight({ cwd: () => store.dirCwd });
watch(
  () => store.dirCwd,
  (cwd) => {
    gitLight.reset();
    if (cwd) void gitLight.load();
  },
  { immediate: true },
);
watch(
  () => store.running,
  (now, prev) => {
    if (prev && !now) void gitLight.load();
  },
);
/** 「让 AI 收尾」/「问 AI」都只预填不发送（发送 = 一次 run，烧容量与 token，得用户自己按）。 */
function onGitLightPrefill(text: string) {
  store.inputValue = text;
}

// ---- issue #55 A2：自动跟随 + 「↓ 最新」悬浮按钮（AUTO_FOLLOW_GAP=80）----
const streamEl = ref<HTMLElement | null>(null);
const autoFollow = ref(true);
const showToLatest = ref(false);

function scrollDown() {
  if (!autoFollow.value) return;
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
// 旧 scrollDown() 挂点：消息/分隔行/工具卡片追加 + 流式增量追加（entries.length / deltaText 变化）。
watch(
  () => store.entries.length,
  () => nextTick(scrollDown),
);
watch(
  () => store.es.deltaText,
  () => nextTick(scrollDown),
);
// 试用台账 #10：「加载更早消息」整段前插后锚定滚动位置——新批次把原内容往下顶，不锚定
// 视口就会跳到顶。watch 在 pre-flush 跑：此刻 DOM 尚未重渲染，读到的是**旧**高度；
// nextTick 后新高度已知，把高度差补进 scrollTop 即保持原视觉位置。本 watcher 注册在
// scrollDown 之后 → 同一 flush 内它的 nextTick 回调后执行，锚定值最继覆盖自动贴底。
watch(
  () => store.olderPrependSeq,
  () => {
    const el = streamEl.value;
    if (!el) return;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    nextTick(() => {
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
    });
  },
);

function onStreamScroll() {
  const el = streamEl.value;
  if (!el) return;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (gap > AUTO_FOLLOW_GAP) {
    if (autoFollow.value) {
      autoFollow.value = false;
      showToLatest.value = true;
    }
  } else if (!autoFollow.value) {
    autoFollow.value = true;
    showToLatest.value = false;
  }
}

function jumpToLatest() {
  autoFollow.value = true;
  showToLatest.value = false;
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
</script>

<template>
  <StationShell area="work">
    <div
      class="workspace-layout"
      :class="{ 'select-none': sidebar.dragging.value }"
    >
      <div
        v-if="drawerOpen"
        class="workspace-backdrop"
        @click="drawerOpen = false"
      ></div>
      <aside
        class="workspace-explorer"
        :style="sidebar.asideStyle.value"
        :class="{ 'is-open': drawerOpen }"
      >
        <SidebarPanel
          @select-session="onSelectSession"
          @new-session="onNewSession"
        />
      </aside>
      <div
        class="workspace-resizer"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('workbench.resizeSidebar')"
        :aria-valuenow="sidebar.width.value"
        :aria-valuemin="SIDEBAR_MIN"
        :aria-valuemax="SIDEBAR_MAX"
        tabindex="0"
        @pointerdown="sidebar.onHandlePointerDown"
        @dblclick="sidebar.resetWidth"
        @keydown="sidebar.onHandleKeydown"
      ></div>
      <section class="workspace-canvas">
        <header class="workspace-toolbar">
          <ElButton
            class="workspace-drawer-toggle"
            :aria-label="
              locale === 'en' ? 'Projects and sessions' : '项目与会话'
            "
            @click="drawerOpen = !drawerOpen"
            >{{
              locale === "en" ? "Projects & sessions" : "项目与会话"
            }}</ElButton
          >
          <div class="workspace-title">
            <small>{{ locale === "en" ? "DEVELOPMENT" : "开发空间" }}</small>
            <h1>
              {{
                dirShortName || (locale === "en" ? "Workbench" : "开发工作台")
              }}
            </h1>
          </div>
          <div class="workspace-toolbar-actions">
            <ElButton
              v-if="store.dirCwd"
              text
              :title="t('workbench.cwdCopyTitle', { cwd: store.dirCwd })"
              @click="copyCwd"
              >{{
                copied
                  ? t("common.copied")
                  : locale === "en"
                    ? "Copy path"
                    : "复制路径"
              }}</ElButton
            >
            <GitLightBadge
              v-if="store.dirCwd"
              :payload="gitLight.payload.value"
              :loading="gitLight.loading.value"
              :error="gitLight.error.value"
              :cwd="store.dirCwd"
              @refresh="gitLight.load()"
              @prefill="onGitLightPrefill"
            />
            <ElButton @click="pickerOpen = true"
              >{{ locale === "en" ? "Find session" : "查找会话" }}
              <kbd>⌘ K</kbd></ElButton
            >
          </div>
        </header>
        <div ref="streamEl" class="workspace-stream" @scroll="onStreamScroll">
          <div class="workspace-transcript"><StreamPanel /></div>
        </div>
        <div class="workspace-input-region">
          <RunStatusBar v-if="store.sessionId" /><QueuedInputsBar
            v-if="store.sessionId"
          /><ComposerBar />
        </div>
        <ElButton
          v-if="showToLatest"
          class="jump-latest"
          round
          @click="jumpToLatest"
          >{{ t("workbench.toLatest") }}</ElButton
        >
      </section>
      <SessionPickerModal
        v-if="pickerOpen"
        scope="all"
        :cwd="store.dirCwd ?? undefined"
        @select="onPickerSelect"
        @close="pickerOpen = false"
      />
    </div>
  </StationShell>
</template>
