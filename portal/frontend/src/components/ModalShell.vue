<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { ElDialog } from "element-plus";
const props = withDefaults(
  defineProps<{ label: string; dialogClass?: string }>(),
  { dialogClass: "md:w-[26rem]" },
);
const emit = defineEmits<{ (e: "close"): void }>();
const width = computed(() =>
  /(?:48|56|62|64)rem|approval-dialog|file-dialog/.test(props.dialogClass)
    ? "min(1000px, 94vw)"
    : /picker-dialog/.test(props.dialogClass)
      ? "min(640px, 94vw)"
      : "min(520px, 92vw)",
);
// Parent controls close permission (busy forms may refuse). Element supplies focus trapping; this wrapper preserves parent-controlled closing and scroll restoration.
function close() {
  emit("close");
}
const host = ref<HTMLElement>();
let previousFocus: HTMLElement | null = null;
let previousOverflow = "";
async function focusInput() {
  await nextTick();
  await nextTick();
  const firstInput = host.value?.querySelector<HTMLElement>(
    "input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
  );
  (
    firstInput ??
    host.value?.querySelector<HTMLElement>("button:not([disabled])")
  )?.focus();
}
onMounted(async () => {
  previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  await nextTick();
  focusInput();
});
onUnmounted(() => {
  document.body.style.overflow = previousOverflow;
  previousFocus?.focus();
});
</script>
<template>
  <div ref="host" @keydown.esc.stop.prevent="close">
    <ElDialog
      :model-value="true"
      :title="label"
      :width="width"
      :append-to-body="false"
      :show-close="false"
      :lock-scroll="false"
      :close-on-press-escape="false"
      @open-auto-focus="focusInput"
      :before-close="close"
      align-center
      :class="['station-dialog', dialogClass]"
    >
      <template #header
        ><span class="sr-only">{{ label }}</span></template
      ><slot />
    </ElDialog>
  </div>
</template>

<style>
.station-dialog.el-dialog {
  padding: 0;
  border-radius: 18px;
  overflow: hidden;
  max-height: 90dvh;
  color: #28334c;
  box-shadow: 0 24px 100px #18294430;
}
.station-dialog > .el-dialog__header {
  padding: 0;
  margin: 0;
}
.station-dialog > .el-dialog__body {
  padding: 0;
  max-height: 90dvh;
  overflow: auto;
}
.station-dialog.approval-dialog {
  width: min(94vw, 1000px) !important;
}
.station-dialog.file-dialog {
  width: min(94vw, 1000px) !important;
}
.station-dialog.picker-dialog {
  width: min(94vw, 640px) !important;
}
</style>
