<script setup lang="ts">
import { ElButton, ElTag, ElEmpty, ElSkeleton, ElAlert } from "element-plus";
import ModalShell from "./ModalShell.vue";
// 会话选择 modal（issue #94，架构评审裁决瘦身版）：单次全量浏览（limit=100 一次拉全，弹窗内滚动）。
// 入口：① 侧栏固定头 🔍（无目录时 all）② Ctrl/⌘+K（scope='all' 跨目录找回）。
// 契约：props { scope: 'cwd'|'all', cwd? }；emits select(sessionId) / close。
// 交互（评审裁决：去搜索/分页/总数——搜索待 #88 标题自动生成后再评估）：
// 范围 segmented 恒可改；三态（加载中/无结果/失败保留旧列表+重试）；
// 键盘 ↑↓ 高亮、Enter 进入、Esc 关闭；焦点进 dialog 容器并归还触发按钮；
// dialog 语义（role/aria-modal）；移动端 max-md 全屏层锁背景滚动，桌面居中 dialog。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  useSessionBrowser,
  type PickerSession,
} from "../composables/useSessionBrowser";

// issue #101 P2：用户可见文案走 i18n（picker.* / common.*）；issue #105 ③：时间戳亦随 locale。
const { t, locale } = useI18n();

const props = withDefaults(
  defineProps<{ scope: "cwd" | "all"; cwd?: string }>(),
  { cwd: undefined },
);
const emit = defineEmits<{
  (e: "select", sessionId: string): void;
  (e: "close"): void;
}>();

// 范围 segmented：入口只给默认值，modal 内恒可改（扩大/缩小到当前目录）。
const scope = ref(props.scope);
const cwdRef = computed(() => props.cwd ?? null);
const dirShortName = computed(() => props.cwd?.split("/").pop() ?? "");
const { items, loading, error, empty, retry } = useSessionBrowser({
  scope,
  cwd: cwdRef,
});

// ---- 键盘高亮（↑↓ 移动、Enter 进入；列表刷新后回第一条）----
const activeIndex = ref(-1);
watch(items, (list) => {
  activeIndex.value = list.length > 0 ? 0 : -1;
});

function pick(s: PickerSession) {
  emit("select", String(s.id));
}

function onKeydown(e: KeyboardEvent) {
  const n = items.value.length;
  if (n === 0) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const delta = e.key === "ArrowDown" ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + n) % n;
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = items.value[activeIndex.value];
    if (item) pick(item);
  }
}

// 绝对本地时间（与侧栏 store.sessMeta 一致：按当前 locale 格式化；'zh-CN' 输出逐字不变，en 走英文格式）。
// locale 为响应式 ref → 模板内调用 abs() 时读取，切语言即时重渲染。
const abs = (iso?: string) => new Date(iso ?? 0).toLocaleString(locale.value);
</script>

<template>
  <ModalShell
    :label="t('picker.title')"
    dialog-class="picker-dialog"
    @keydown="onKeydown"
    @close="emit('close')"
  >
    <div class="session-browser">
      <header>
        <div>
          <small>FDE STATION</small>
          <h2>{{ t("picker.title") }}</h2>
        </div>
        <ElButton
          text
          circle
          :aria-label="t('common.close')"
          @click="emit('close')"
          >×</ElButton
        >
      </header>
      <div
        class="session-browser__scope"
        role="group"
        :aria-label="t('picker.scopeLabel')"
      >
        <ElButton
          :type="scope === 'cwd' ? 'primary' : 'default'"
          :plain="scope !== 'cwd'"
          :disabled="!cwd"
          :title="
            cwd
              ? t('picker.currentDirTitle', { cwd })
              : t('picker.noDirSelected')
          "
          @click="scope = 'cwd'"
          >{{ t("picker.currentDir", { name: dirShortName || "—" }) }}</ElButton
        >
        <ElButton
          :type="scope === 'all' ? 'primary' : 'default'"
          :plain="scope !== 'all'"
          @click="scope = 'all'"
          >{{ t("picker.allDirs") }}</ElButton
        >
      </div>
      <div class="session-browser__results">
        <ul role="listbox" :aria-label="t('picker.listLabel')" tabindex="0">
          <li
            v-for="(s, i) in items"
            :key="String(s.id)"
            :class="{ active: i === activeIndex }"
            role="option"
            :aria-selected="i === activeIndex"
            @click="pick(s)"
            @mouseenter="activeIndex = i"
          >
            <div>
              <strong>{{ s.title || t("common.unnamedSession") }}</strong>
              <p>
                <span v-if="scope === 'all'"
                  >{{ s.cwd?.split("/").pop() ?? t("common.noDir") }} · </span
                >{{ abs(s.updated_at) }}
              </p>
            </div>
            <ElTag v-if="s.active_run_id" size="small" type="success">{{
              t("common.runningBadge")
            }}</ElTag
            ><span aria-hidden="true">↗</span>
          </li>
        </ul>
        <ElSkeleton
          v-if="loading"
          :rows="4"
          animated
          :aria-label="t('common.loading')"
        />
        <ElEmpty
          v-else-if="empty"
          :description="t('picker.empty')"
          :image-size="70"
        />
        <div v-if="error" class="session-browser__error">
          <ElAlert
            :title="error + t('picker.staleListKept')"
            type="error"
            :closable="false"
            role="alert"
          /><ElButton @click="retry">{{ t("common.retry") }}</ElButton>
        </div>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.session-browser header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 26px 18px;
}
.session-browser header small {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: #8794ae;
}
.session-browser h2 {
  font-size: 20px;
  margin: 6px 0 0;
  color: #23314d;
}
.session-browser__scope {
  padding: 0 26px 20px;
  display: flex;
  gap: 8px;
  border-bottom: 1px solid #edf0f6;
}
.session-browser__scope .el-button + .el-button {
  margin: 0;
}
.session-browser__results {
  max-height: 56vh;
  overflow: auto;
  padding: 12px 18px 24px;
}
.session-browser ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.session-browser li {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  cursor: pointer;
}
.session-browser li.active {
  border-color: #dae3ff;
  background: #f3f6ff;
}
.session-browser li > div {
  flex: 1;
  min-width: 0;
}
.session-browser li strong {
  display: block;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 550;
}
.session-browser li p {
  font-size: 11px;
  color: #8a96aa;
  margin: 6px 0 0;
}
.session-browser li > span:last-child {
  color: #8794b0;
}
.session-browser__error {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}
</style>
