<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import {
  ElButton,
  ElTable,
  ElTableColumn,
  ElTag,
  ElDialog,
} from "element-plus";
import { api } from "../api";
const props = defineProps<{ projectId: string; canBuild: boolean }>();
type Build = {
  id: string;
  branch: string;
  source_sha: string;
  status: string;
  created_at: string;
  artifact_size: number | null;
  log: string;
  error: string | null;
};
const rows = ref<Build[]>([]),
  busy = ref(false),
  error = ref(""),
  selected = ref<Build | null>(null);
const labels: Record<string, string> = {
  queued: "排队中",
  running: "编译中",
  succeeded: "可下载",
  failed: "失败",
  cancelled: "已取消",
};
let alive = true,
  timer: ReturnType<typeof setInterval> | undefined;
async function load() {
  const result = await api<{ builds: Build[] }>(
    `/api/collaboration/${props.projectId}/builds`,
  );
  if (alive) {
    rows.value = result.builds;
    if (selected.value)
      selected.value =
        rows.value.find((r) => r.id === selected.value?.id) ?? null;
  }
}
async function act(generate = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (generate)
      await api(`/api/collaboration/${props.projectId}/builds`, {
        method: "POST",
        body: "{}",
      });
    await load();
  } catch (e) {
    if (alive) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void act();
  timer = setInterval(() => void act(), 5000);
});
onUnmounted(() => {
  alive = false;
  clearInterval(timer);
});
</script>

<template>
  <section class="build-center">
    <header class="build-center__heading">
      <div>
        <span>DESKTOP DELIVERY</span>
        <h3>测试版本</h3>
        <p>从当前个人分支生成可下载的桌面测试包。</p>
      </div>
      <div class="build-center__actions">
        <ElButton :disabled="busy" @click="act()">刷新</ElButton
        ><ElButton
          v-if="canBuild"
          type="primary"
          :loading="busy"
          @click="act(true)"
          >生成测试版</ElButton
        >
      </div>
    </header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div class="build-metrics">
      <div>
        <strong>{{ rows.length }}</strong
        ><span>版本记录</span>
      </div>
      <div>
        <strong>{{
          rows.filter((row) => row.status === "succeeded").length
        }}</strong
        ><span>可供下载</span>
      </div>
      <div>
        <strong>{{
          rows.filter((row) => ["queued", "running"].includes(row.status))
            .length
        }}</strong
        ><span>正在构建</span>
      </div>
    </div>
    <ElTable
      :data="rows"
      row-key="id"
      empty-text="暂无测试版本，点击生成测试版开始"
      class="build-table"
    >
      <ElTableColumn label="版本 / 分支" min-width="180"
        ><template #default="{ row }"
          ><div class="build-version">
            <span aria-hidden="true">▣</span>
            <div>
              <code>{{ row.source_sha.slice(0, 10) }}</code
              ><small>{{ row.branch }}</small>
            </div>
          </div></template
        ></ElTableColumn
      >
      <ElTableColumn label="构建状态" width="130"
        ><template #default="{ row }"
          ><ElTag
            effect="light"
            :type="
              row.status === 'succeeded'
                ? 'success'
                : row.status === 'failed'
                  ? 'danger'
                  : 'info'
            "
            >{{ labels[row.status] ?? row.status }}</ElTag
          ></template
        ></ElTableColumn
      >
      <ElTableColumn label="生成时间" min-width="180"
        ><template #default="{ row }">{{
          new Date(row.created_at).toLocaleString()
        }}</template></ElTableColumn
      >
      <ElTableColumn label="文件大小" width="110"
        ><template #default="{ row }">{{
          row.artifact_size
            ? (row.artifact_size / 1048576).toFixed(1) + " MB"
            : "—"
        }}</template></ElTableColumn
      >
      <ElTableColumn label="操作" width="160" align="right"
        ><template #default="{ row }"
          ><ElButton
            v-if="row.status === 'succeeded'"
            tag="a"
            :href="`/api/project-builds/${row.id}/download`"
            type="primary"
            link
            >下载</ElButton
          ><ElButton link @click="selected = row as Build"
            >日志</ElButton
          ></template
        ></ElTableColumn
      >
    </ElTable>
    <ElDialog
      :model-value="!!selected"
      title="构建日志"
      width="min(900px,94vw)"
      @close="selected = null"
      ><div class="build-log-heading">
        <ElTag v-if="selected">{{
          labels[selected.status] ?? selected.status
        }}</ElTag
        ><code>{{ selected?.source_sha.slice(0, 12) }}</code>
      </div>
      <p v-if="selected?.error" class="error">{{ selected.error }}</p>
      <pre tabindex="0">{{ selected?.log || "等待构建" }}</pre>
    </ElDialog>
  </section>
</template>

<style scoped>
.build-center {
  display: grid;
  gap: 22px;
  padding: 8px 0;
}
.build-center__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.build-center__heading span {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: #8a96ae;
}
.build-center h3 {
  font-size: 20px;
  margin: 6px 0 8px;
}
.build-center__heading p {
  font-size: 12px;
  color: #8a96ab;
  margin: 0;
}
.build-center__actions {
  display: flex;
  gap: 8px;
}
.build-center__actions .el-button + .el-button {
  margin: 0;
}
.build-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid #e6eaf3;
  border-radius: 12px;
  background: #f8faff;
}
.build-metrics > div {
  padding: 20px 24px;
  border-right: 1px solid #e6eaf3;
}
.build-metrics > div:last-child {
  border: 0;
}
.build-metrics strong {
  display: block;
  font-size: 26px;
  font-weight: 600;
  color: #344a78;
}
.build-metrics span {
  display: block;
  font-size: 11px;
  color: #8a96ab;
  margin-top: 6px;
}
.build-version {
  display: flex;
  gap: 12px;
  align-items: center;
}
.build-version > span {
  display: grid;
  place-items: center;
  width: 34px;
  height: 38px;
  border-radius: 9px;
  background: #eff3ff;
  color: #365cf5;
  font-size: 20px;
}
.build-version small {
  display: block;
  color: #8c98ac;
  font-size: 11px;
  margin-top: 5px;
}
.build-log-heading {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}
.error {
  color: #b42318;
  font-size: 13px;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 60vh;
  overflow: auto;
  background: #172239;
  color: #dce9f6;
  padding: 20px;
  border-radius: 12px;
  font: 12px/1.8 monospace;
}
@media (max-width: 650px) {
  .build-center__heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .build-metrics > div {
    padding: 14px;
  }
  .build-metrics strong {
    font-size: 22px;
  }
}
</style>
