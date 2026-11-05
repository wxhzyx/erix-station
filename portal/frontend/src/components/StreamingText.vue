<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { renderMarkdown } from '../lib/markdown';
const props = defineProps<{ text: string; active?: boolean; markdown?: boolean }>();
const shown = ref(props.text);
let frame = 0, started = 0;
function cancelFrame() { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); }
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function advance(now: number) {
  const remaining = props.text.length - shown.value.length;
  if (remaining <= 0) { frame = 0; return; }
  if (!started) started = now;
  let end = now - started >= 120 ? props.text.length : shown.value.length + Math.max(1, Math.ceil(remaining / 4));
  if (end < props.text.length && /[\uD800-\uDBFF]/.test(props.text[end - 1] ?? '')) end++;
  shown.value = props.text.slice(0, end);
  frame = requestAnimationFrame(advance);
}
watch(() => [props.text, props.active] as const, () => {
  if (!props.active || reducedMotion || !props.text.startsWith(shown.value) || typeof requestAnimationFrame !== 'function') {
    cancelFrame(); frame = 0; shown.value = props.text; return;
  }
  if (!frame) { started = 0; frame = requestAnimationFrame(advance); }
}, { flush: 'sync' });
onUnmounted(cancelFrame);
const html = computed(() => props.markdown ? renderMarkdown(shown.value) : '');
</script>
<template><div v-if="markdown" v-html="html"></div><p v-else class="whitespace-pre-wrap break-words">{{shown}}</p></template>
