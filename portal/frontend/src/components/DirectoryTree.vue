<script setup lang="ts">
import { ElButton, ElAlert, ElSkeleton } from "element-plus";
// 目录树面板（issue #84 P5.4，设计文档 §4 左下段）：默认收起（▸ 目录树）；展开后按
// GET /api/files/tree?cwd=&path= 懒加载单层列表——初始只有根一层，点某目录项展开下一层；
// 不跨刷新记忆，reload()（↻ 按钮路径）后回到全折叠；切换 cwd 时树自动归位。
// 根 = 选中目录（= 会话 cwd = jail root，三锚合一）；P6（issue #84）：文件节点点击 emit
// file-click（相对路径），由 SidebarPanel 打开 FilePreviewModal；目录节点维持折叠语义不变。
import { ref, shallowReactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api";
import type { TreeEntry } from "../lib/tree";
import DirTreeNode from "./DirTreeNode.vue";

// issue #101 P2：用户可见文案走 i18n（tree.* / common.*）。
const { t } = useI18n();

const props = defineProps<{ cwd: string | null }>();
const emit = defineEmits<{
  (e: "file-click", path: string): void; // 文件节点相对路径（嵌套为 a/b/c）
}>();

const open = ref(false); // 面板展开开关（默认收起）
const childMap = shallowReactive(new Map<string, TreeEntry[]>()); // pathKey → 单层条目
const expandedSet = shallowReactive(new Set<string>()); // 已展开目录（pathKey）
const loadingSet = shallowReactive(new Set<string>()); // 加载中的 pathKey
const error = ref("");

async function load(path: string) {
  if (!props.cwd) return;
  loadingSet.add(path);
  try {
    const data = await api<{ entries?: TreeEntry[] }>(
      `/api/files/tree?cwd=${encodeURIComponent(props.cwd)}&path=${encodeURIComponent(path)}`,
    );
    childMap.set(path, data.entries ?? []);
  } catch (e) {
    expandedSet.delete(path); // 加载失败：展开态回滚，错误行留在面板顶部
    error.value = t("errors.treeLoadFailed", {
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    loadingSet.delete(path);
  }
}

/** 目录节点点击：展开/收起；首次展开触发下一层懒加载（点一级出一层）。 */
function toggleNode(pathKey: string) {
  error.value = "";
  if (expandedSet.has(pathKey)) {
    expandedSet.delete(pathKey);
    return;
  }
  expandedSet.add(pathKey);
  if (!childMap.has(pathKey)) void load(pathKey);
}

/** 文件节点点击：emit 相对路径（P6 预览，父级 SidebarPanel 打开 modal）。 */
function fileClick(pathKey: string) {
  emit("file-click", pathKey);
}

/** ↻ 双刷之一：清缓存与展开态（全折叠）；面板若开着则重载根层。SidebarPanel 经 ref 调用。 */
function reload() {
  childMap.clear();
  expandedSet.clear();
  loadingSet.clear();
  error.value = "";
  if (open.value) void load("");
}
defineExpose({ reload });

// 切目录：树归位（全折叠 + 清缓存），新目录的根层在面板下次展开时加载。
watch(
  () => props.cwd,
  () => reload(),
);
// 首次展开面板：加载根层（path=''）。
watch(open, (v) => {
  if (v && !childMap.has("") && !loadingSet.has("")) void load("");
});
</script>

<template>
  <section class="file-explorer">
    <ElButton
      text
      class="file-explorer__heading"
      :aria-expanded="open"
      @click="open = !open"
      ><span aria-hidden="true">{{ open ? "⌄" : "›" }}</span
      >{{ t("tree.title") }}</ElButton
    >
    <div v-if="open" class="file-explorer__body">
      <p v-if="!cwd" class="file-explorer__empty">
        {{ t("tree.selectDirFirst") }}
      </p>
      <ElAlert
        v-else-if="error"
        :title="error"
        type="error"
        :closable="false"
        role="alert"
      />
      <template v-else>
        <ElSkeleton
          v-if="loadingSet.has('')"
          :rows="3"
          animated
          :aria-label="t('common.loading')"
        />
        <p v-else-if="!childMap.get('')?.length" class="file-explorer__empty">
          {{ t("common.emptyDir") }}
        </p>
        <DirTreeNode
          v-for="e in childMap.get('') ?? []"
          :key="e.name"
          v-bind="e"
          path=""
          :depth="0"
          :child-map="childMap"
          :expanded-set="expandedSet"
          :loading-set="loadingSet"
          :toggle-node="toggleNode"
          :file-click="fileClick"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.file-explorer {
  border-top: 1px solid #e5eaf2;
  margin-top: 6px;
  padding-top: 4px;
}
.file-explorer__heading {
  width: 100%;
  justify-content: flex-start;
  padding: 10px 0 !important;
  font-size: 12px;
  font-weight: 600;
}
.file-explorer__heading :deep(> span) {
  display: flex;
  gap: 8px;
}
.file-explorer__body {
  padding: 4px 0 8px;
}
.file-explorer__empty {
  color: #8b95a8;
  font-size: 12px;
  padding: 10px 4px;
}
</style>
