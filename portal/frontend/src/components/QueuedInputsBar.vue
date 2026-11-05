<script setup lang="ts">
import { ElButton, ElTag, ElAlert } from "element-plus";
// issue #370：待发送输入队列条（composer 上方）。
//
// 为什么它是「服务端快照的投影」而不是本地列表：队列的真相在 `queued_inputs` 表（不变式 3），
// SSE 的 `queue_update` 是**全量快照**、`GET /api/sessions/:id` 的 `session.queued_messages` 是
// 补齐入口。本组件只读 store，不做任何自己的排序/去重/计数逻辑——那样多标签页天然一致。
import { useI18n } from "vue-i18n";
import { useWorkbenchStore } from "../stores/workbench";

const { t } = useI18n();
const store = useWorkbenchStore();

// 折叠默认收起，展开后每条最多 3 行（line-clamp）。不做逐条删除：后端只有整队取回
//（pi `clear_queue` 的口径——单条删要和引擎的 pull 竞态，故只给「整队取回」这一个动作）。
import { ref } from "vue";
const expanded = ref(false);
</script>
<template>
  <section
    v-if="store.queuedCount > 0 || store.queueBlocked"
    data-testid="queued-inputs-bar"
    class="queue-panel"
  >
    <ElAlert
      v-if="store.queueBlocked"
      :title="t('queued.blocked.' + store.queueBlocked)"
      type="warning"
      :closable="false"
    />
    <div class="queue-heading">
      <ElTag type="warning" effect="light">{{
        t("queued.count", { n: store.queuedCount })
      }}</ElTag
      ><span v-if="store.queuedInputs.steering.length">{{
        t("queued.steerCount", { n: store.queuedInputs.steering.length })
      }}</span
      ><span v-if="store.queuedInputs.follow_up.length">{{
        t("queued.followUpCount", { n: store.queuedInputs.follow_up.length })
      }}</span>
      <div class="queue-actions">
        <ElButton
          v-if="store.queuedCount > 0"
          size="small"
          text
          :aria-expanded="expanded"
          @click="expanded = !expanded"
          >{{ expanded ? t("queued.collapse") : t("queued.expand") }}</ElButton
        ><ElButton
          v-if="store.queuedCount > 0"
          size="small"
          :disabled="store.queueSubmitting"
          :title="t('queued.recallHint')"
          @click="store.recallQueue()"
          >{{ t("queued.recall") }}</ElButton
        >
      </div>
    </div>
    <ol v-if="expanded">
      <li
        v-for="it in [
          ...store.queuedInputs.steering,
          ...store.queuedInputs.follow_up,
        ]"
        :key="it.id"
      >
        {{ it.content }}
      </li>
    </ol>
  </section>
</template>
<style scoped>
.queue-panel {
  padding: 12px 22px;
  background: #fffcf5;
  border-top: 1px solid #efe5cd;
}
.queue-heading {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
  color: #8d7c5e;
}
.queue-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.queue-actions .el-button {
  margin: 0;
}
.queue-panel ol {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  padding: 0;
  list-style: none;
}
.queue-panel li {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 5em;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid #eee6d5;
  border-radius: 10px;
  background: white;
  font-size: 12px;
  line-height: 1.5;
}
</style>
