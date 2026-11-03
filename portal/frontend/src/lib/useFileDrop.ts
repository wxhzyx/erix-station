import { onMounted, onUnmounted, ref } from 'vue';

/** Share the picker validation path; dropping never submits a message. */
export function useFileDrop(addFiles: (files: File[]) => Promise<void>, disabled: () => boolean, reportError: (message: string) => void) {
  const dragging = ref(false);
  let depth = 0;
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files') || !!event.dataTransfer?.files.length;
  function reset() { depth = 0; dragging.value = false; }
  function enter(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault(); depth++;
    dragging.value = !disabled();
  }
  function over(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = disabled() ? 'none' : 'copy';
  }
  function leave(event: DragEvent) {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) dragging.value = false;
  }
  async function drop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault(); reset();
    if (disabled()) return;
    const items = Array.from(event.dataTransfer?.items ?? []);
    if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
      reportError('请拖入文件，不支持文件夹 / Drop files, not folders');
      return;
    }
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) await addFiles(files);
  }
  // Avoid browser navigation/data loss when a file misses the upload region.
  function preventNavigation(event: DragEvent) { if (hasFiles(event)) event.preventDefault(); }
  function outsideDrop(event: DragEvent) { preventNavigation(event); reset(); }
  onMounted(() => {
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', outsideDrop);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
  });
  onUnmounted(() => {
    window.removeEventListener('dragover', preventNavigation);
    window.removeEventListener('drop', outsideDrop);
    window.removeEventListener('dragend', reset);
    window.removeEventListener('blur', reset);
  });
  return { dragging, reset, events: { dragenter: enter, dragover: over, dragleave: leave, drop } };
}
