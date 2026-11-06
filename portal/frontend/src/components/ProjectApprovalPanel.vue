<script setup lang="ts">
import {
  ElButton,
  ElCheckbox,
  ElTag,
  ElEmpty,
  ElAlert,
  ElSkeleton,
  ElDescriptions,
  ElDescriptionsItem,
} from "element-plus";
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api";
import { useAuthStore } from "../stores/auth";
import {
  approvalStatus,
  approvalWebUrl,
  type ProjectApproval,
} from "../lib/projectApprovals";
const props = defineProps<{
  cwd?: string;
  versions?: boolean;
  admin?: boolean;
}>();
const auth = useAuthStore();
const { locale } = useI18n();
const en = computed(() => locale.value === "en");
const items = ref<ProjectApproval[]>([]);
const selected = ref<ProjectApproval | null>(null);
const loading = ref(false);
const acting = ref(false);
const loadingDetail = ref(false);
const error = ref("");
const confirmed = ref(false);
const hasMore = ref(false);
let epoch = 0;
let detailEpoch = 0;
let controller = new AbortController();
const visible = computed(() =>
  items.value.filter(
    (item) =>
      (!props.cwd || item.cwd === props.cwd) &&
      (!props.versions || item.status === "merged"),
  ),
);
const admin = computed(() => props.admin && auth.user?.role === "admin");
const reviewEvidenceReady = computed(
  () => !!selected.value?.diff?.trim() && !!selected.value?.ai_review?.trim(),
);
function reset() {
  epoch++;
  detailEpoch++;
  controller.abort();
  controller = new AbortController();
  items.value = [];
  hasMore.value = false;
  selected.value = null;
  error.value = "";
  loading.value = false;
  acting.value = false;
  loadingDetail.value = false;
  confirmed.value = false;
}
async function load() {
  if (acting.value) return;
  const token = ++epoch;
  detailEpoch++;
  loadingDetail.value = false;
  controller.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  confirmed.value = false;
  const query = new URLSearchParams();
  if (props.cwd) query.set("cwd", props.cwd);
  if (props.versions) query.set("status", "merged");
  try {
    const result = await api<{ items: ProjectApproval[]; has_more?: boolean }>(
      `/api/project-approvals${query.size ? "?" + query.toString() : ""}`,
      { signal: controller.signal },
    );
    if (token === epoch) {
      items.value = result.items;
      hasMore.value = result.has_more === true;
      if (selected.value) {
        const item = result.items.find(
          (item) => item.id === selected.value?.id,
        );
        selected.value = null;
        if (item) {
          loading.value = false;
          await select(item);
        }
      }
    }
  } catch (e) {
    if (token === epoch) error.value = (e as Error).message;
  } finally {
    if (token === epoch) loading.value = false;
  }
}
async function select(item: ProjectApproval) {
  if (acting.value || loading.value) return;
  const token = epoch;
  const detail = ++detailEpoch;
  selected.value = item;
  confirmed.value = false;
  error.value = "";
  loadingDetail.value = true;
  try {
    const result = await api<ProjectApproval>(
      `/api/project-approvals/${encodeURIComponent(item.id)}`,
      { signal: controller.signal },
    );
    if (token === epoch && detail === detailEpoch) selected.value = result;
  } catch (e) {
    if (token === epoch && detail === detailEpoch) {
      selected.value = null;
      error.value = (e as Error).message;
    }
  } finally {
    if (token === epoch && detail === detailEpoch) loadingDetail.value = false;
  }
}
async function act(action: "review" | "approve" | "merge") {
  const item = selected.value;
  if (
    !admin.value ||
    !item ||
    acting.value ||
    loading.value ||
    loadingDetail.value
  )
    return;
  if (
    action === "review" &&
    !["pending", "failed"].includes(item.status) &&
    !(item.status === "reviewing" && item.can_retry_review)
  )
    return;
  if (
    action === "approve" &&
    (item.status !== "reviewed" ||
      !confirmed.value ||
      !reviewEvidenceReady.value)
  )
    return;
  if (
    action === "merge" &&
    item.status !== "merging" &&
    (item.status !== "approved" ||
      !confirmed.value ||
      !reviewEvidenceReady.value)
  )
    return;
  const token = epoch;
  const detail = ++detailEpoch;
  acting.value = true;
  error.value = "";
  try {
    const result = await api<ProjectApproval>(
      `/api/admin/project-approvals/${encodeURIComponent(item.id)}/${action}`,
      {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify(action === "review" ? {} : { confirm: true }),
      },
    );
    if (token === epoch && detail === detailEpoch) {
      selected.value = result;
      items.value = items.value.map((row) =>
        row.id === result.id ? result : row,
      );
      confirmed.value = false;
    }
  } catch (e) {
    if (token === epoch && detail === detailEpoch) {
      error.value = (e as Error).message;
      confirmed.value = false;
      // Reconcile stale/uncertain actions from the server; never automatically retry a mutation.
      try {
        const current = await api<ProjectApproval>(
          `/api/project-approvals/${encodeURIComponent(item.id)}`,
          { signal: controller.signal },
        );
        if (token === epoch && detail === detailEpoch) {
          selected.value = current;
          items.value = items.value.map((row) =>
            row.id === current.id ? current : row,
          );
        }
      } catch {
        /* Keep the original actionable error. */
      }
    }
  } finally {
    if (token === epoch) acting.value = false;
  }
}
watch(
  () => [auth.user?.id, auth.user?.role, props.cwd, props.versions],
  () => {
    reset();
    if (auth.user) void load();
  },
  { immediate: true },
);
onUnmounted(reset);
defineExpose({ refresh: load });
</script>

<template>
  <section class="approval-panel">
    <header class="approval-panel__heading">
      <div>
        <h2>
          {{
            versions
              ? en
                ? "Merged versions"
                : "合并版本"
              : en
                ? "Project approvals"
                : "项目审批"
          }}
        </h2>
        <p v-if="hasMore">
          {{ en ? "Showing the latest 100 requests" : "显示最近 100 条记录" }}
        </p>
      </div>
      <ElButton
        :loading="loading"
        :disabled="loading || acting"
        @click="load"
        >{{ en ? "Refresh" : "刷新" }}</ElButton
      >
    </header>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      role="alert"
    />
    <ElSkeleton v-if="loading && !visible.length" :rows="5" animated />
    <ElEmpty
      v-else-if="!visible.length"
      :description="
        versions
          ? en
            ? 'No merged versions'
            : '暂无合并版本'
          : en
            ? 'No approval requests'
            : '暂无审批'
      "
      :image-size="80"
    />
    <div v-if="visible.length" class="approval-workspace">
      <nav
        class="approval-queue"
        :aria-label="en ? 'Approval requests' : '审批列表'"
      >
        <ElButton
          v-for="item in visible"
          :key="item.id"
          class="approval-row"
          :class="{ selected: selected?.id === item.id }"
          :disabled="acting || loading"
          @click="select(item)"
        >
          <strong>{{ item.repository || item.cwd.split("/").pop() }}</strong
          ><small>{{ item.source_ref }} → {{ item.target_ref }}</small
          ><ElTag
            size="small"
            :type="item.status === 'merged' ? 'success' : 'info'"
            >{{ approvalStatus(item.status, en) }}</ElTag
          >
          <template v-if="versions"
            ><code>{{ item.merge_sha?.slice(0, 12) }}</code
            ><small>{{
              en ? "Deployment unverified" : "上线状态未确认"
            }}</small></template
          >
        </ElButton>
      </nav>
      <article
        v-if="selected"
        :aria-busy="loadingDetail"
        class="approval-detail"
      >
        <header>
          <h3>{{ selected.repository }}</h3>
          <ElTag>{{ approvalStatus(selected.status, en) }}</ElTag>
        </header>
        <ElDescriptions :column="1" size="small" border>
          <ElDescriptionsItem
            v-if="selected.requester_login"
            :label="en ? 'Requested by' : '发起人'"
            >{{ selected.requester_login }}</ElDescriptionsItem
          >
          <ElDescriptionsItem
            v-if="selected.approved_by_login"
            :label="en ? 'Approved by' : '批准人'"
            >{{ selected.approved_by_login }} ·
            {{ selected.approved_at }}</ElDescriptionsItem
          >
          <ElDescriptionsItem :label="en ? 'Source' : '来源'"
            ><span>{{ selected.source_ref }}</span
            ><code>{{ selected.source_sha }}</code></ElDescriptionsItem
          >
          <ElDescriptionsItem :label="en ? 'Target' : '目标'"
            ><span>{{ selected.target_ref }}</span
            ><code>{{ selected.target_sha }}</code></ElDescriptionsItem
          >
        </ElDescriptions>
        <ElAlert
          v-if="selected.status === 'merged'"
          type="success"
          :closable="false"
          ><p>
            {{ en ? "Merge commit" : "合并提交" }}
            <code>{{ selected.merge_sha }}</code>
          </p>
          <p>
            {{ selected.merged_by_login || "" }}
            {{ selected.merged_at || selected.updated_at }} ·
            {{ en ? "Deployment unverified" : "上线状态未确认" }}
          </p></ElAlert
        >
        <ElButton
          v-if="approvalWebUrl(selected.web_url)"
          tag="a"
          :href="approvalWebUrl(selected.web_url)"
          target="_blank"
          rel="noopener noreferrer"
          link
          type="primary"
          >{{ en ? "Open repository" : "查看仓库" }} ↗</ElButton
        >
        <ElAlert
          v-if="selected.error"
          :title="selected.error"
          type="error"
          :closable="false"
          role="alert"
        />
        <section class="review-section">
          <h4>{{ en ? "Changes" : "代码差异" }}</h4>
          <pre class="approval-diff" tabindex="0">{{
            loadingDetail
              ? en
                ? "Loading diff…"
                : "加载差异…"
              : selected.diff || (en ? "No diff available" : "暂无差异")
          }}</pre>
        </section>
        <section
          v-if="selected.ai_review"
          class="review-section review-advisory"
        >
          <h4>{{ en ? "AI review · advisory" : "AI 审查 · 仅供参考" }}</h4>
          <p>{{ selected.ai_review }}</p>
        </section>
        <footer
          v-if="admin && !loadingDetail && !loading"
          class="approval-decisions"
        >
          <ElButton
            v-if="
              ['pending', 'failed'].includes(selected.status) ||
              (selected.status === 'reviewing' && selected.can_retry_review)
            "
            type="primary"
            :loading="acting"
            :disabled="acting"
            @click="act('review')"
            >{{
              acting
                ? en
                  ? "Reviewing…"
                  : "审查中…"
                : selected.status === "reviewing"
                  ? en
                    ? "Retry review"
                    : "重新审查"
                  : en
                    ? "Run AI review"
                    : "运行 AI 审查"
            }}</ElButton
          >
          <template v-if="['reviewed', 'approved'].includes(selected.status)">
            <ElCheckbox v-model="confirmed" :disabled="acting">{{
              selected.status === "approved"
                ? en
                  ? `Merge the reviewed commit into ${selected.target_ref}`
                  : `将已审查的提交合并至 ${selected.target_ref}`
                : en
                  ? "I have checked the diff and AI review"
                  : "我已核对代码差异与 AI 审查"
            }}</ElCheckbox>
            <ElButton
              type="primary"
              :loading="acting"
              :disabled="acting || !confirmed || !reviewEvidenceReady"
              @click="act(selected.status === 'approved' ? 'merge' : 'approve')"
              >{{
                acting
                  ? en
                    ? "Processing…"
                    : "处理中…"
                  : selected.status === "approved"
                    ? en
                      ? "Confirm merge"
                      : "确认合并"
                    : en
                      ? "Approve"
                      : "批准"
              }}</ElButton
            >
          </template>
          <ElButton
            v-if="selected.status === 'merging'"
            :disabled="acting"
            @click="act('merge')"
            >{{ en ? "Check merge result" : "核对合并结果" }}</ElButton
          >
          <ElAlert
            v-if="selected.status === 'merging'"
            :title="
              en
                ? 'Merge pending confirmation. Refresh to reconcile; do not submit again.'
                : '合并结果待确认，请刷新核对，勿重复提交。'
            "
            type="info"
            :closable="false"
          />
          <ElAlert
            v-if="selected.status === 'stale'"
            :title="
              en
                ? 'The branches changed. Submit a new approval request.'
                : '分支已更新，请重新发起审批。'
            "
            type="warning"
            :closable="false"
          />
        </footer>
      </article>
      <ElEmpty
        v-else
        :description="
          en ? 'Select a request to review' : '选择一项审批查看详情'
        "
        :image-size="70"
      />
    </div>
  </section>
</template>

<style scoped>
.approval-panel {
  display: grid;
  gap: 18px;
}
.approval-panel__heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.approval-panel h2 {
  font-size: 17px;
  font-weight: 650;
  margin: 0;
}
.approval-panel__heading p {
  font-size: 12px;
  color: #8c96a8;
}
.approval-workspace {
  display: grid;
  grid-template-columns: minmax(180px, 27%) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.approval-queue {
  display: grid;
  gap: 10px;
}
.approval-row.el-button {
  margin: 0;
  width: 100%;
  height: auto;
  padding: 15px;
  text-align: left;
  white-space: normal;
  border-color: #e6eaf2;
  border-radius: 12px;
}
.approval-row :deep(> span) {
  display: grid;
  gap: 9px;
  width: 100%;
  justify-items: start;
}
.approval-row.selected {
  background: #f2f5ff;
  border-color: #9db0ff;
}
.approval-row strong {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.approval-row small {
  font-size: 11px;
  color: #7b89a1;
  overflow-wrap: anywhere;
}
.approval-detail {
  min-width: 0;
  border: 1px solid #e6eaf2;
  border-radius: 14px;
  padding: 22px;
  display: grid;
  gap: 20px;
  background: white;
}
.approval-detail > header {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.approval-detail h3 {
  font-size: 17px;
  margin: 0;
  overflow-wrap: anywhere;
}
.approval-detail code {
  display: block;
  font-size: 11px;
  overflow-wrap: anywhere;
  color: #6c7c98;
  margin-top: 3px;
}
.review-section h4 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 12px;
}
.approval-diff {
  max-height: 380px;
  overflow: auto;
  background: #172239;
  color: #d8e2f4;
  font:
    12px/1.8 ui-monospace,
    monospace;
  border-radius: 10px;
  padding: 18px;
  margin: 0;
}
.review-advisory {
  background: #f6f8fc;
  padding: 18px;
  border-radius: 10px;
}
.review-advisory p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.8;
  margin: 0;
}
.approval-decisions {
  border-top: 1px solid #e8edf5;
  padding-top: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
}
.approval-decisions .el-checkbox {
  height: auto;
  white-space: normal;
}
.approval-decisions :deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.6;
}
@media (max-width: 700px) {
  .approval-workspace {
    grid-template-columns: 1fr;
  }
  .approval-queue {
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    max-height: 220px;
    overflow: auto;
  }
  .approval-detail {
    padding: 16px;
  }
}
</style>
