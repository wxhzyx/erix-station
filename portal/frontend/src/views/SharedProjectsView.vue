<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ElButton,
  ElCard,
  ElDialog,
  ElEmpty,
  ElInput,
  ElSelect,
  ElOption,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTabs,
  ElTabPane,
} from "element-plus";
import StationShell from "../components/StationShell.vue";
import ProjectBuildPanel from "../components/ProjectBuildPanel.vue";
import { useAuthStore } from "../stores/auth";
import { api } from "../api";
type Project = {
  id: string;
  name: string;
  owner_user_id: string;
  owner_login: string;
  owner_name: string;
  state: string;
  membership_state?: string;
  branch?: string;
  repo_url: string;
  last_error?: string;
  instructions?: string;
  package_name?: string;
  delivery_target?: { type: "web" | "desktop" };
};
type Member = {
  id: string;
  user_id: string;
  login: string;
  display_name: string;
  state: string;
  branch: string;
  last_error?: string;
};
type Candidate = { id: string; login: string; display_name: string };
type GitAuthor = {
  login: string;
  full_name?: string;
  station_login?: string;
  station_display_name?: string;
};
type Pull = {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  mergeable: boolean;
  merge_commit_sha?: string;
  user: GitAuthor;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  html_url: string;
};
type Detail = {
  project: Project;
  members: Member[];
  mine?: Member;
  can_manage: boolean;
  candidates: Candidate[];
};
type Review = {
  pr: Pull;
  target_sha: string;
  diff: string;
  reviews: {
    id: number;
    state: string;
    user: GitAuthor;
    body: string;
    commit_id: string;
  }[];
};
const authorName = (user: GitAuthor) =>
  user.station_display_name ||
  user.station_login ||
  user.full_name ||
  user.login;
const route = useRoute(),
  router = useRouter(),
  auth = useAuthStore();
defineProps<{ embedded?: boolean }>();
const projects = ref<Project[]>([]),
  detail = ref<Detail | null>(null),
  pulls = ref<Pull[]>([]),
  review = ref<Review | null>(null);
const busy = ref(false),
  error = ref(""),
  message = ref(""),
  enabled = ref(true),
  selected = ref(""),
  tab = ref("members");
const invitee = ref(""),
  title = ref(""),
  description = ref(""),
  note = ref(""),
  newPull = ref(false);
const removal = ref<Member | "project" | null>(null),
  confirmation = ref("");
const labels: Record<string, string> = {
  active: "已就绪",
  invited: "待接受",
  provisioning: "准备中",
  failed: "需要处理",
  revoking: "清理中",
  revoked: "已移除",
  declined: "已拒绝",
  deleting: "删除中",
  deleted: "已归档",
};
const canDevelop = computed(
  () =>
    detail.value?.mine?.state === "active" &&
    detail.value.project.state === "active",
);
const candidates = computed(
  () =>
    detail.value?.candidates.filter(
      (c) =>
        !detail.value?.members.some(
          (m) =>
            m.user_id === c.id && !["revoked", "declined"].includes(m.state),
        ),
    ) ?? [],
);
const canReview = computed(
  () =>
    detail.value?.can_manage &&
    detail.value.project.state === "active" &&
    review.value?.pr.head.ref !== detail.value?.mine?.branch &&
    !review.value?.pr.merged &&
    review.value?.pr.state === "open",
);
let timer: ReturnType<typeof setInterval> | undefined;
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
const endpoint = (suffix = "") =>
  `/api/collaboration/${selected.value}${suffix}`;
async function loadList() {
  const result = await api<{ enabled: boolean; projects: Project[] }>(
    "/api/collaboration",
  );
  enabled.value = result.enabled;
  projects.value = result.projects;
}
async function loadDetail() {
  if (!selected.value) return;
  const result = await api<Detail>(endpoint());
  detail.value = result;
  if (
    result.project.repo_url &&
    (result.can_manage || result.mine?.state === "active")
  )
    pulls.value = (await api<{ pulls: Pull[] }>(endpoint("/pulls"))).pulls;
  else pulls.value = [];
}
async function select(id: string) {
  await action(async () => {
    selected.value = id;
    review.value = null;
    detail.value = null;
    await router.replace({ path: route.path, query: { project: id } });
    await loadDetail();
  });
}
async function refresh() {
  await loadList();
  if (selected.value) await loadDetail();
}
onMounted(() => {
  void action(async () => {
    await loadList();
    const id =
      typeof route.query.project === "string"
        ? route.query.project
        : projects.value[0]?.id;
    if (id) {
      selected.value = id;
      await loadDetail();
    }
  });
  timer = setInterval(() => {
    if (!busy.value && !review.value && !removal.value && !newPull.value)
      void action(refresh);
  }, 15000);
});
onUnmounted(() => clearInterval(timer));
async function post(suffix: string, body: unknown = {}) {
  return api(endpoint(suffix), { method: "POST", body: JSON.stringify(body) });
}
async function invite() {
  await action(async () => {
    await post("/invite", { user_id: invitee.value });
    invitee.value = "";
    await refresh();
    message.value = "邀请已发送，等待本人接受";
  });
}
async function respond(m: Member, choice: "accept" | "decline") {
  await action(async () => {
    await post(`/members/${m.id}/${choice}`);
    await refresh();
  });
}
async function transfer(m: Member) {
  await action(async () => {
    await post("/transfer", { user_id: m.user_id });
    await refresh();
    message.value = "负责人已转交";
  });
}
function confirmRemoval(target: Member | "project") {
  removal.value = target;
  confirmation.value = "";
}
async function remove() {
  await action(async () => {
    if (confirmation.value !== detail.value?.project.name) return;
    if (removal.value === "project")
      await api(endpoint(), {
        method: "DELETE",
        body: JSON.stringify({ confirmation: confirmation.value }),
      });
    else if (removal.value)
      await post(`/members/${removal.value.id}/remove`, {
        confirmation: confirmation.value,
      });
    removal.value = null;
    message.value = "正在撤权和清理，Git 成果及历史用量保留";
    await refresh();
  });
}
async function enter(sync = false) {
  if (!detail.value) return;
  const query: Record<string, string> = {
    cwd: `~/projects/${detail.value.project.name}`,
  };
  if (sync)
    query.prompt =
      "请先检查本项目工作目录、当前分支和未提交修改。保留所有本地修改，确认没有运行中的开发任务后 fetch origin，再把 origin/main 合并到我的个人分支。遇到冲突向我说明并等待确认，不要 reset --hard、不强制推送。完成后正常提交并推送个人分支。";
  await router.push({ path: "/", query });
}
async function createPull() {
  await action(async () => {
    await post("/pulls", {
      title: title.value,
      description: description.value,
    });
    newPull.value = false;
    title.value = "";
    description.value = "";
    tab.value = "pulls";
    await refresh();
  });
}
async function openReview(pr: Pull) {
  await action(async () => {
    review.value = await api<Review>(endpoint(`/pulls/${pr.number}`));
    note.value = "";
  });
}
async function decide(approve: boolean) {
  await action(async () => {
    if (!review.value) return;
    const r = review.value;
    await post(`/pulls/${r.pr.number}/review`, {
      approve,
      note: note.value,
      source_sha: r.pr.head.sha,
      target_sha: r.target_sha,
    });
    review.value = await api<Review>(endpoint(`/pulls/${r.pr.number}`));
    message.value = approve ? "已批准当前版本" : "已退回，请提交者修改";
  });
}
async function merge() {
  await action(async () => {
    if (!review.value) return;
    const r = review.value;
    await post(`/pulls/${r.pr.number}/merge`, {
      source_sha: r.pr.head.sha,
      target_sha: r.target_sha,
    });
    review.value = await api<Review>(endpoint(`/pulls/${r.pr.number}`));
    await refresh();
    message.value = "Gitea 已确认合并";
  });
}
</script>
<template>
  <component
    :is="embedded ? 'div' : StationShell"
    :area="embedded ? undefined : 'work'"
    ><main class="collaboration-page" :class="{ embedded }">
      <header class="page-heading">
        <div>
          <span class="eyebrow">TEAM WORKSPACE</span>
          <h1>{{ embedded ? "项目协作" : "共享项目" }}</h1>
          <p>连接成员、分支与交付，让每一次协作都有清晰的进展。</p>
        </div>
        <ElButton :loading="busy" @click="action(refresh)">刷新项目</ElButton>
      </header>
      <nav
        v-if="projects.length"
        class="project-gallery"
        aria-label="选择共享项目"
      >
        <ElButton
          v-for="p in projects"
          :key="p.id"
          class="project-tile"
          :class="{ selected: selected === p.id }"
          :disabled="busy"
          @click="select(p.id)"
          ><span class="project-monogram">{{
            p.name.slice(0, 1).toUpperCase()
          }}</span
          ><span class="project-tile-copy"
            ><strong>{{ p.name }}</strong
            ><small
              >{{ p.owner_name || p.owner_login }} ·
              {{ labels[p.membership_state ?? p.state] ?? p.state }}</small
            ></span
          ><span class="project-tile-arrow" aria-hidden="true"
            >↗</span
          ></ElButton
        >
      </nav>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <p v-if="message" role="status" class="success">{{ message }}</p>
      <ElEmpty v-if="!enabled" description="共享项目服务尚未配置" />
      <ElEmpty v-else-if="!projects.length" description="暂无项目或邀请"
        ><router-link v-if="auth.user?.role === 'admin'" to="/admin/delivery"
          >下发开发交付包</router-link
        ></ElEmpty
      >
      <template v-else>
        <ElCard v-if="detail" shadow="never" class="project-summary"
          ><div class="summary-row">
            <div>
              <div class="project-summary-label">
                {{
                  detail.project.delivery_target?.type === "desktop"
                    ? "桌面应用交付"
                    : "Web 应用交付"
                }}
              </div>
              <h2>
                {{ detail.project.name }}
                <ElTag size="small">{{ labels[detail.project.state] }}</ElTag>
              </h2>
              <p>
                负责人
                {{ detail.project.owner_name || detail.project.owner_login }} ·
                {{ detail.project.owner_login }}
              </p>
              <p v-if="detail.mine">
                我的分支 <code>{{ detail.mine.branch }}</code> ·
                {{ labels[detail.mine.state] }}
              </p>
            </div>
            <div class="actions">
              <ElButton v-if="canDevelop" type="primary" @click="enter()"
                >进入项目</ElButton
              ><ElButton v-if="canDevelop" @click="newPull = true"
                >提交合并</ElButton
              ><ElButton v-if="canDevelop" @click="enter(true)"
                >同步主分支</ElButton
              ><a
                v-if="detail.project.repo_url"
                :href="detail.project.repo_url.replace(/\.git$/, '')"
                target="_blank"
                rel="noopener"
                >Gitea 仓库 ↗</a
              >
            </div>
          </div>
          <p v-if="detail.project.last_error" class="error">
            {{ detail.project.last_error }}
          </p>
          <div v-if="detail.mine?.state === 'invited'" class="invitation">
            <ElButton
              type="primary"
              :disabled="busy"
              @click="respond(detail.mine, 'accept')"
              >接受邀请</ElButton
            ><ElButton :disabled="busy" @click="respond(detail.mine, 'decline')"
              >拒绝</ElButton
            >
          </div>
        </ElCard>
        <ElCard v-if="detail" shadow="never" class="collaboration-details"
          ><ElTabs v-model="tab">
            <ElTabPane
              v-if="
                detail.project.delivery_target?.type === 'desktop' &&
                (detail.can_manage || canDevelop)
              "
              label="测试版本"
              name="builds"
              ><ProjectBuildPanel
                :key="detail.project.id"
                :project-id="detail.project.id"
                :can-build="canDevelop"
            /></ElTabPane>
            <ElTabPane label="成员" name="members"
              ><form
                v-if="detail.can_manage && detail.project.state === 'active'"
                class="invite-form"
                @submit.prevent="invite"
              >
                <ElSelect
                  v-model="invitee"
                  filterable
                  placeholder="选择已开通工位的成员"
                  aria-label="受邀成员"
                  ><ElOption
                    v-for="c in candidates"
                    :key="c.id"
                    :value="c.id"
                    :label="`${c.display_name || c.login} · ${c.login}`" /></ElSelect
                ><ElButton
                  type="primary"
                  native-type="submit"
                  :disabled="busy || !invitee"
                  >邀请成员</ElButton
                >
              </form>
              <ElTable :data="detail.members" row-key="id"
                ><ElTableColumn label="成员" min-width="180"
                  ><template #default="{ row }"
                    ><strong>{{ row.display_name || row.login }}</strong>
                    <div class="muted">
                      {{ row.login
                      }}{{
                        row.user_id === detail.project.owner_user_id
                          ? " · 负责人"
                          : ""
                      }}
                    </div></template
                  ></ElTableColumn
                ><ElTableColumn
                  prop="branch"
                  label="个人分支"
                  min-width="180"
                /><ElTableColumn label="状态" min-width="150"
                  ><template #default="{ row }"
                    ><ElTag
                      :type="
                        row.state === 'active'
                          ? 'success'
                          : row.state === 'failed'
                            ? 'danger'
                            : 'info'
                      "
                      >{{ labels[row.state] }}</ElTag
                    >
                    <p v-if="row.last_error" class="error">
                      {{ row.last_error }}
                    </p></template
                  ></ElTableColumn
                ><ElTableColumn label="操作" min-width="170"
                  ><template #default="{ row }"
                    ><template
                      v-if="
                        !['revoked', 'declined', 'revoking'].includes(
                          row.state,
                        ) && row.user_id !== detail.project.owner_user_id
                      "
                      ><ElButton
                        v-if="detail.can_manage && row.state === 'active'"
                        link
                        :disabled="busy"
                        @click="transfer(row as Member)"
                        >转交负责人</ElButton
                      ><ElButton
                        v-if="
                          detail.can_manage || row.user_id === auth.user?.id
                        "
                        type="danger"
                        link
                        :disabled="busy"
                        @click="confirmRemoval(row as Member)"
                        >{{
                          row.user_id === auth.user?.id ? "退出" : "移除"
                        }}</ElButton
                      ></template
                    ></template
                  ></ElTableColumn
                ></ElTable
              >
            </ElTabPane>
            <ElTabPane label="合并请求" name="pulls"
              ><ElTable :data="pulls" empty-text="暂无合并请求"
                ><ElTableColumn label="变更" min-width="260"
                  ><template #default="{ row }"
                    ><ElButton
                      link
                      type="primary"
                      @click="openReview(row as Pull)"
                      >#{{ row.number }} {{ row.title }}</ElButton
                    >
                    <div class="muted">
                      {{ authorName(row.user) }} · {{ row.head.ref }} → main
                    </div></template
                  ></ElTableColumn
                ><ElTableColumn label="状态" width="140"
                  ><template #default="{ row }"
                    ><ElTag :type="row.merged ? 'success' : 'info'">{{
                      row.merged
                        ? "已合并"
                        : row.state === "open"
                          ? "待处理"
                          : "已关闭"
                    }}</ElTag></template
                  ></ElTableColumn
                ></ElTable
              ></ElTabPane
            >
            <ElTabPane label="交付要求" name="delivery"
              ><section class="delivery-brief">
                <span class="eyebrow">DELIVERY BRIEF</span>
                <h3>{{ detail.project.package_name }}</h3>
                <p class="requirements">
                  {{
                    detail.project.instructions ||
                    "按工作目录中的交付文档和 AGENTS.md 开发。"
                  }}
                </p>
              </section></ElTabPane
            >
          </ElTabs>
          <footer v-if="detail.can_manage" class="project-footer">
            <ElButton
              :disabled="busy"
              @click="
                action(async () => {
                  await post('/retry');
                  await refresh();
                })
              "
              >重试未完成操作</ElButton
            ><ElButton
              v-if="
                auth.user?.role === 'admin' &&
                detail.project.state !== 'deleted'
              "
              type="danger"
              plain
              :disabled="busy"
              @click="confirmRemoval('project')"
              >删除项目工作空间</ElButton
            >
          </footer></ElCard
        >
      </template>
      <ElDialog
        v-model="newPull"
        title="提交合并请求"
        width="min(560px, 94vw)"
        :close-on-click-modal="false"
        ><form class="dialog-form" @submit.prevent="createPull">
          <label
            >标题<ElInput
              v-model="title"
              maxlength="200"
              placeholder="说明本次完成的内容" /></label
          ><label
            >说明<ElInput
              v-model="description"
              type="textarea"
              :rows="4"
              maxlength="10000"
          /></label>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <ElButton
            type="primary"
            native-type="submit"
            :disabled="busy || !title.trim()"
            >创建 Gitea PR</ElButton
          >
        </form></ElDialog
      >
      <ElDialog
        :model-value="!!review"
        title="审核与合并"
        width="min(1000px, 96vw)"
        :close-on-click-modal="false"
        @close="review = null"
        ><template v-if="review"
          ><h3>#{{ review.pr.number }} {{ review.pr.title }}</h3>
          <p>
            <code>{{ review.pr.head.sha.slice(0, 12) }}</code> → main
            <code>{{ review.target_sha.slice(0, 12) }}</code
            ><ElTag v-if="review.pr.merged" type="success"
              >已合并 {{ review.pr.merge_commit_sha?.slice(0, 12) }}</ElTag
            >
          </p>
          <pre class="diff" tabindex="0">{{ review.diff }}</pre>
          <p v-for="r in review.reviews" :key="r.id">
            {{ authorName(r.user) }} · {{ r.state }} · {{ r.body }}
          </p>
          <p v-if="error" role="alert" class="error">{{ error }}</p>
          <template v-if="canReview"
            ><ElInput
              v-model="note"
              type="textarea"
              :rows="2"
              placeholder="审核意见"
            />
            <div class="actions review-actions">
              <ElButton :disabled="busy" @click="decide(false)"
                >退回修改</ElButton
              ><ElButton :disabled="busy" @click="decide(true)"
                >批准当前版本</ElButton
              ><ElButton type="primary" :disabled="busy" @click="merge"
                >合并到 main</ElButton
              >
            </div></template
          ></template
        ></ElDialog
      >
      <ElDialog
        :model-value="!!removal"
        title="确认清理工作空间"
        width="min(560px, 94vw)"
        :close-on-click-modal="false"
        @close="!busy && (removal = null)"
        ><p>
          {{
            removal === "project"
              ? "清理所有成员在本项目的工作目录，并将远端仓库归档。"
              : "撤销该成员在本项目的权限并清理其本地目录，其他项目不受影响。"
          }}
          未推送的修改将丢失。
        </p>
        <p>保留 Gitea 提交、PR 和历史模型用量。</p>
        <ElInput
          v-model="confirmation"
          :placeholder="`输入 ${detail?.project.name} 确认`"
          aria-label="删除确认项目名"
        />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <template #footer
          ><ElButton :disabled="busy" @click="removal = null">取消</ElButton
          ><ElButton
            type="danger"
            :disabled="busy || confirmation !== detail?.project.name"
            @click="remove"
            >确认清理</ElButton
          ></template
        ></ElDialog
      >
    </main></component
  >
</template>
<style scoped>
.collaboration-page {
  max-width: 1400px;
  margin: auto;
  padding: 32px;
  display: grid;
  gap: 24px;
}
.collaboration-page.embedded {
  padding: 0;
  max-width: none;
}
.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
}
.eyebrow {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  color: #8191ae;
}
.page-heading h1 {
  font-size: 28px;
  font-weight: 650;
  letter-spacing: -0.04em;
  margin: 8px 0;
}
.page-heading p {
  font-size: 13px;
  color: #8794aa;
  margin: 0;
}
.project-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
}
.project-tile.el-button {
  height: auto;
  padding: 18px;
  margin: 0;
  text-align: left;
  border-color: #e3e9f3;
  border-radius: 13px;
  background: white;
}
.project-tile.selected {
  border-color: #9caefa;
  background: #f5f7ff;
  box-shadow: 0 5px 18px #365cf50a;
}
.project-tile :deep(> span) {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
}
.project-monogram {
  height: 42px;
  width: 42px;
  border-radius: 11px;
  background: #edf1fc;
  color: #5573c4;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  font-size: 18px;
  font-weight: 650;
}
.project-tile-copy {
  display: grid;
  gap: 7px;
  min-width: 0;
  flex: 1;
}
.project-tile-copy strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-tile-copy small {
  font-size: 11px;
  font-weight: 400;
  color: #8a97ad;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-tile-arrow {
  color: #8c9ab1;
}
.project-summary {
  border-radius: 16px;
  border-color: #e6ebf4;
  background: linear-gradient(115deg, #fff 45%, #f3f6ff);
}
.project-summary :deep(.el-card__body) {
  padding: 28px;
}
.project-summary-label {
  font-size: 11px;
  color: #8393af;
  letter-spacing: 0.06em;
}
.summary-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
}
.summary-row h2 {
  font-size: 23px;
  margin: 10px 0 12px;
  display: flex;
  gap: 12px;
  align-items: center;
}
.summary-row p {
  font-size: 12px;
  color: #8090a8;
  margin: 7px 0;
}
.summary-row code {
  color: #506686;
  background: #eaf0fa;
  border-radius: 5px;
  padding: 3px 6px;
}
.actions {
  display: flex;
  gap: 9px;
  align-items: center;
  flex-wrap: wrap;
}
.actions .el-button + .el-button {
  margin: 0;
}
.actions a {
  font-size: 12px;
  width: 100%;
  text-align: right;
  margin-top: 8px;
}
.collaboration-details {
  border-radius: 16px;
  border-color: #e6ebf4;
}
.collaboration-details :deep(.el-card__body) {
  padding: 12px 26px 26px;
}
.collaboration-details :deep(.el-tabs__item) {
  height: 56px;
  font-size: 13px;
}
.collaboration-details :deep(.el-tabs__nav-wrap:after) {
  height: 1px;
  background: #e8edf5;
}
.collaboration-details :deep(.el-table) {
  --el-table-header-bg-color: #f8faff;
  --el-table-border-color: #edf1f7;
  --el-table-row-hover-bg-color: #f8faff;
}
.collaboration-details :deep(.el-table .cell) {
  padding: 12px;
  font-size: 12px;
}
.invite-form {
  display: flex;
  gap: 12px;
  max-width: 560px;
  margin: 18px 0 24px;
}
.muted {
  color: #8d99ad;
  font-size: 11px;
  margin-top: 5px;
}
.project-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 26px;
  padding-top: 20px;
  border-top: 1px solid #e8edf5;
}
.dialog-form {
  display: grid;
  gap: 18px;
}
.dialog-form label {
  display: grid;
  gap: 8px;
  font-size: 13px;
}
.diff {
  background: #172239;
  color: #dce9f6;
  padding: 22px;
  border-radius: 12px;
  max-height: 48vh;
  overflow: auto;
  font: 12px/1.8 monospace;
  white-space: pre;
}
.error {
  color: #b42318;
  font-size: 13px;
}
.success {
  color: #16845d;
  font-size: 13px;
}
a {
  color: #365cf5;
}
.requirements {
  white-space: pre-wrap;
  line-height: 1.9;
  font-size: 14px;
  color: #60718d;
}
.delivery-brief {
  max-width: 820px;
  padding: 24px;
  background: #fafbfe;
  border: 1px solid #e9edf5;
  border-radius: 12px;
  margin-top: 12px;
}
.delivery-brief h3 {
  font-size: 20px;
  margin: 12px 0;
}
.review-actions {
  margin-top: 16px;
}
.invitation {
  padding: 18px;
  background: #edf3ff;
  border-radius: 10px;
  margin-top: 20px;
}
@media (max-width: 768px) {
  .collaboration-page {
    padding: 20px 14px;
    gap: 18px;
  }
  .summary-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .page-heading {
    align-items: flex-start;
    gap: 12px;
  }
  .page-heading h1 {
    font-size: 23px;
  }
  .page-heading p {
    line-height: 1.7;
  }
  .project-gallery {
    grid-template-columns: 1fr;
    max-height: 220px;
    overflow: auto;
  }
  .project-tile.el-button {
    padding: 12px 15px;
  }
  .project-summary :deep(.el-card__body) {
    padding: 20px;
  }
  .collaboration-details :deep(.el-card__body) {
    padding: 8px 14px 20px;
  }
  .invite-form {
    flex-direction: column;
  }
  .project-footer {
    flex-wrap: wrap;
  }
  .actions a {
    text-align: left;
  }
}
</style>
