<script setup lang="ts">
import { ElButton } from "element-plus";
// 语言切换菜单（issue #101 P1）：小号下拉——按钮显示当前语言，菜单两项「中文」/「English」。
// 切换即调 setLocale（i18n 响应式生效 + localStorage 持久化 + <html lang> 同步）；
// 文案走 locale.* 命名空间（语言名用母语自名，两语言下取值一致）。
// 组件自带外部点击收起；当前挂载点：LoginView 卡片头部 + WorkbenchView 顶栏（AdminView 为次级页面，不挂）。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { setLocale, type AppLocale } from "../i18n";

const { t, locale } = useI18n();

const OPTIONS: readonly {
  value: AppLocale;
  labelKey: "locale.zhCN" | "locale.en";
}[] = [
  { value: "zh-CN", labelKey: "locale.zhCN" },
  { value: "en", labelKey: "locale.en" },
];

const open = ref(false);
const root = ref<HTMLElement | null>(null);

// 当前语言按钮文案：读 locale.value 保证切语言后响应式更新。
const currentLabel = computed(() => {
  const current = OPTIONS.find((o) => o.value === locale.value) ?? OPTIONS[0];
  return t(current.labelKey);
});

function select(value: AppLocale) {
  setLocale(value);
  open.value = false;
}

// 外部点击收起（点击组件内部元素不收起；mousedown 之外用 click 以兼容键盘触发）。
function onDocumentClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener("click", onDocumentClick));
onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));
</script>
<template>
  <div ref="root" class="language-switch" @keydown.esc="open = false">
    <ElButton
      size="small"
      text
      :aria-label="t('locale.label')"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
      ><span class="language-icon" aria-hidden="true">◎</span>{{ currentLabel
      }}<span aria-hidden="true">⌄</span></ElButton
    >
    <ul v-if="open" role="menu">
      <li v-for="opt in OPTIONS" :key="opt.value" role="none">
        <ElButton
          text
          role="menuitem"
          :class="{ selected: opt.value === locale }"
          @click="select(opt.value)"
          >{{ t(opt.labelKey) }}</ElButton
        >
      </li>
    </ul>
  </div>
</template>
<style scoped>
.language-switch {
  position: relative;
  display: inline-block;
}
.language-icon {
  margin-right: 5px;
}
.language-switch ul {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 100;
  min-width: 130px;
  padding: 6px;
  background: white;
  border: 1px solid #e3e8f1;
  border-radius: 12px;
  box-shadow: 0 10px 30px #20314f16;
  list-style: none;
}
.language-switch li .el-button {
  width: 100%;
  display: flex;
  justify-content: space-between;
}
.selected {
  color: #365cf5;
  background: #edf1ff;
}
</style>
