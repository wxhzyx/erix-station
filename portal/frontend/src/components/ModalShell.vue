<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { ElDialog } from 'element-plus';
const props = withDefaults(defineProps<{ label:string; dialogClass?:string }>(), { dialogClass:'md:w-[26rem]' });
const emit = defineEmits<{ (e:'close'):void }>();
const width = computed(() => /(?:48|56|64)rem/.test(props.dialogClass) ? 'min(900px, calc(100vw - 32px))' : 'min(640px, calc(100vw - 32px))');
// Parent controls close permission (busy forms may refuse). Element supplies focus trapping; this wrapper preserves parent-controlled closing and scroll restoration.
function close() { emit('close'); }
const host = ref<HTMLElement>();
let previousFocus:HTMLElement|null = null;
let previousOverflow = '';
async function focusInput() {
  await nextTick();
  await nextTick();
  const firstInput = host.value?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
  (firstInput ?? host.value?.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
}
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
  await nextTick(); focusInput();
});
onUnmounted(() => { document.body.style.overflow = previousOverflow; previousFocus?.focus(); });
</script>
<template>
  <div ref="host" @keydown.esc.stop.prevent="close"><ElDialog :model-value="true" :title="label" :width="width" :append-to-body="false" :show-close="false" :lock-scroll="false" :close-on-press-escape="false" @open-auto-focus="focusInput" :before-close="close" align-center class="station-dialog">
    <div :class="dialogClass"><slot /></div>
  </ElDialog></div>
</template>
