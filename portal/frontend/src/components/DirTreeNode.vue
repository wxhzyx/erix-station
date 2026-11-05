<script setup lang="ts">
import { ElButton } from "element-plus";
// 目录树节点（递归组件，按文件名自引用）：行缩进按 depth；目录点击展开/收起下一层
// （懒加载由父级 DirectoryTree.toggleNode 触发：点一级出一层）；文件/目录图标区分；
// 文件节点点击 → 父级 DirectoryTree.fileClick（P6 issue #84：emit file-click 打开预览 modal）。
// 状态（childMap/expandedSet/loadingSet）由 DirectoryTree 持有并透传，保证 ↻ 与切目录时全树归位。
import { useI18n } from "vue-i18n";
import type { TreeEntry } from "../lib/tree";

// issue #101 P2：用户可见文案走 i18n（common.emptyDir）。
const { t } = useI18n();

const props = defineProps<
  TreeEntry & {
    path: string; // 父路径（'' = 根层）
    depth: number;
    childMap: Map<string, TreeEntry[]>;
    expandedSet: Set<string>;
    loadingSet: Set<string>;
    toggleNode: (pathKey: string) => void;
    fileClick: (pathKey: string) => void;
  }
>();

// 节点键 = 相对路径（根层子节点即名字；嵌套为 a/b/c）。节点生命周期内静态。
const nodeKey = props.path ? `${props.path}/${props.name}` : props.name;

/** 节点点击：目录维持折叠语义（toggleNode）；文件 emit 预览（fileClick）。 */
function onClick() {
  if (props.type === "dir") props.toggleNode(nodeKey);
  else props.fileClick(nodeKey);
}
</script>

<template>
  <div class="explorer-node">
    <ElButton
      text
      class="explorer-node__row"
      :style="{ paddingLeft: 6 + props.depth * 16 + 'px' }"
      :aria-expanded="
        props.type === 'dir' ? props.expandedSet.has(nodeKey) : undefined
      "
      :loading="props.loadingSet.has(nodeKey)"
      @click="onClick"
    >
      <svg
        v-if="props.type === 'dir'"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <path d="M3 7V5h7l2 2h9v13H3Z" />
      </svg>
      <svg
        v-else
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <path d="M5 3h9l5 5v13H5Z M14 3v6h5 M8 13h8 M8 17h6" />
      </svg>
      <span>{{ props.name }}</span>
    </ElButton>
    <div v-if="props.type === 'dir' && props.expandedSet.has(nodeKey)">
      <template v-if="!props.loadingSet.has(nodeKey)">
        <p
          v-if="!props.childMap.get(nodeKey)?.length"
          class="explorer-node__empty"
          :style="{ paddingLeft: 24 + props.depth * 16 + 'px' }"
        >
          {{ t("common.emptyDir") }}
        </p>
        <DirTreeNode
          v-for="c in props.childMap.get(nodeKey) ?? []"
          :key="nodeKey + '/' + c.name"
          v-bind="c"
          :path="nodeKey"
          :depth="props.depth + 1"
          :child-map="props.childMap"
          :expanded-set="props.expandedSet"
          :loading-set="props.loadingSet"
          :toggle-node="props.toggleNode"
          :file-click="props.fileClick"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.explorer-node__row {
  width: 100%;
  justify-content: flex-start;
  height: 32px;
  font-size: 12px;
  color: #61708c;
}
.explorer-node__row :deep(> span) {
  min-width: 0;
  display: flex;
  gap: 8px;
  align-items: center;
}
.explorer-node__row svg {
  flex-shrink: 0;
  color: #8494b5;
}
.explorer-node__row span span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.explorer-node__empty {
  font-size: 11px;
  color: #99a3b5;
  margin: 6px 0;
}
</style>
