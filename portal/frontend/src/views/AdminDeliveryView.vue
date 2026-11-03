<script setup lang="ts">
import { ElButton, ElCard, ElInput, ElSelect, ElOption, ElUpload, ElForm, ElFormItem, ElTable, ElTableColumn, ElTag } from 'element-plus';
import { onMounted, ref } from 'vue';
import { api } from '../api';
import ModalShell from '../components/ModalShell.vue';
const props = withDefaults(defineProps<{ view?: 'delivery' | 'quota' }>(), { view: 'delivery' });
type User = { id:string; login:string; display_name:string; fde_name:string|null; status:string };
type Package = { id:string; name:string; filename:string; manifest:{name:string;size:number}[] };
type Project = { id:string; name:string; login:string; package_name:string; status:string; last_error:string|null; repo_url:string|null; deleted_at?:string|null };
type Quota = { daily_limit:number; used:number; reserved:number; remaining:number; day:string };
type Request = {id:string;login:string;requested_limit:number;reason:string;status:string};
const users=ref<User[]>([]), packages=ref<Package[]>([]), projects=ref<Project[]>([]), requests=ref<Request[]>([]);
const userId=ref(''), packageId=ref(''), projectName=ref(''), instructions=ref(''), packageName=ref('');
const archive=ref<File|null>(null), busy=ref(false), error=ref(''), message=ref('');
const quota=ref<Quota|null>(null), limit=ref(2000000);
const deleting=ref<Project|null>(null), confirmation=ref('');
function confirmDelete(project:Project) { deleting.value=project; confirmation.value=''; }
async function removeProject() { await action(async()=>{
  if (!deleting.value || confirmation.value !== deleting.value.name) return;
  await api(`/api/admin/assigned-projects/${deleting.value.id}`, {method:'DELETE',body:JSON.stringify({confirmation:confirmation.value})});
  deleting.value=null; message.value='项目已删除，Gitea 仓库与历史用量已保留'; await load();
}); }
async function load() {
  const u = await api<{items:User[]}>('/api/admin/users');
  users.value = u.items.filter(x => x.status === 'active' && (props.view === 'quota' || x.fde_name));
  if (props.view === 'quota') {
    requests.value = (await api<{requests:Request[]}>('/api/admin/token-quota-requests')).requests;
  } else {
    const [p,a] = await Promise.all([api<{packages:Package[]}>('/api/admin/delivery-packages'), api<{projects:Project[]}>('/api/admin/assigned-projects')]);
    packages.value = p.packages; projects.value = a.projects;
  }
}
async function action(fn:()=>Promise<void>) {
  if (busy.value) return;
  busy.value=true; error.value=''; message.value='';
  try { await fn(); } catch(e) {error.value=e instanceof Error?e.message:String(e);} finally {busy.value=false;}
}
onMounted(()=>action(load));
async function upload() { await action(async()=>{
  if(!archive.value) throw new Error('请选择 ZIP 开发交付包');
  const response=await fetch(`/api/admin/delivery-packages?name=${encodeURIComponent(packageName.value)}&filename=${encodeURIComponent(archive.value.name)}`,
    {method:'POST',headers:{'Content-Type':'application/zip'},body:archive.value});
  const data=await response.json(); if(!response.ok) throw new Error(data.error?.message??'上传失败');
  packageId.value=data.id; message.value='交付包已保存'; await load();
}); }
async function assign() { await action(async()=>{
  await api('/api/admin/assigned-projects',{method:'POST',body:JSON.stringify({user_id:userId.value,package_id:packageId.value,name:projectName.value,instructions:instructions.value})});
  message.value='项目已下发，用户仓库已初始化'; await load();
}); }
async function retry(id:string) { await action(async()=>{await api(`/api/admin/assigned-projects/${id}/retry`,{method:'POST',body:'{}'});await load();}); }
async function loadQuota() { quota.value=null; if(!userId.value)return; await action(async()=>{
  quota.value=await api<Quota>(`/api/admin/users/${userId.value}/token-quota`);limit.value=quota.value.daily_limit;
}); }
async function saveQuota() { await action(async()=>{quota.value=await api<Quota>(`/api/admin/users/${userId.value}/token-quota`,{method:'PUT',body:JSON.stringify({daily_limit:limit.value})});message.value='每日额度已更新';}); }
async function review(id:string,approve:boolean) { await action(async()=>{
  await api(`/api/admin/token-quota-requests/${id}/review`,{method:'POST',body:JSON.stringify({approve})});await load();if(userId.value){quota.value=await api<Quota>(`/api/admin/users/${userId.value}/token-quota`);limit.value=quota.value.daily_limit;}message.value=approve?'申请已批准':'申请已拒绝';
}); }
</script>
<template>
  <div class="delivery">
    <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="message" role="status" class="console-success">{{message}}</p>
    <div v-if="view === 'delivery'" class="delivery-workflow">
      <ElCard shadow="never"><template #header><h2>开发交付包</h2></template>
        <ElForm label-position="top" @submit.prevent="upload">
          <ElFormItem label="交付包名称"><ElInput v-model="packageName" required maxlength="150" placeholder="例如：设备看板开发规范" /></ElFormItem>
          <ElFormItem label="ZIP 文件 · 最大 50 MB"><ElUpload class="package-upload" drag :auto-upload="false" :limit="1" accept=".zip" :on-change="file => archive = file.raw ?? null" :on-remove="() => archive = null"><div class="el-upload__text">拖入交付包，或<em>点击选择</em></div></ElUpload></ElFormItem>
          <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!archive || !packageName.trim()">上传交付包</ElButton>
        </ElForm>
      </ElCard>
      <ElCard shadow="never"><template #header><h2>下发项目</h2></template>
        <ElForm label-position="top" @submit.prevent="assign">
          <ElFormItem label="接收用户"><ElSelect v-model="userId" filterable :disabled="busy" placeholder="选择用户"><ElOption v-for="u in users" :key="u.id" :value="u.id" :label="`${u.display_name||u.login} · ${u.login}`" /></ElSelect></ElFormItem>
          <ElFormItem label="开发交付包"><ElSelect v-model="packageId" filterable placeholder="选择交付包"><ElOption v-for="p in packages" :key="p.id" :value="p.id" :label="`${p.name}（${p.manifest.length} 个文件）`" /></ElSelect></ElFormItem>
          <ElFormItem label="项目名称"><ElInput v-model="projectName" required pattern="[a-z0-9][a-z0-9_-]{0,62}" placeholder="例如 crg-development" /></ElFormItem>
          <ElFormItem label="补充开发要求"><ElInput v-model="instructions" type="textarea" maxlength="10000" :rows="3" /></ElFormItem>
          <ElButton type="primary" native-type="submit" :loading="busy" :disabled="!userId || !packageId || !projectName">下发项目</ElButton>
        </ElForm>
      </ElCard>
    </div>
    <ElCard v-if="view === 'quota'" shadow="never"><template #header><h2>用户每日额度</h2></template>
      <ElForm label-position="top" @submit.prevent="saveQuota">
        <ElFormItem label="配置用户"><ElSelect v-model="userId" filterable :disabled="busy" placeholder="选择用户" @change="loadQuota"><ElOption v-for="u in users" :key="u.id" :value="u.id" :label="`${u.display_name||u.login} · ${u.login}`" /></ElSelect></ElFormItem>
        <p v-if="quota">今日已用 {{quota.used.toLocaleString()}} · 调用中 {{quota.reserved.toLocaleString()}} · 每日 00:00 重置</p>
        <template v-if="userId"><ElFormItem label="每日 Token 上限"><ElInput :disabled="busy" v-model.number="limit" type="number" min="0" max="1000000000" step="1" required /></ElFormItem><ElButton type="primary" native-type="submit" :disabled="busy||!quota">保存额度</ElButton></template>
      </ElForm>
    </ElCard>
    <ElCard v-if="view === 'quota'" shadow="never"><template #header><h2>额度升级申请</h2></template>
      <ElTable :data="requests" empty-text="暂无申请">
        <ElTableColumn prop="login" label="用户" min-width="130" /><ElTableColumn label="申请日额度" min-width="150"><template #default="{row}">{{Number(row.requested_limit).toLocaleString()}}</template></ElTableColumn><ElTableColumn prop="reason" label="原因" min-width="180" />
        <ElTableColumn label="状态" width="110"><template #default="{row}"><ElTag :type="row.status==='approved'?'success':row.status==='pending'?'warning':'info'">{{row.status==='pending'?'待审批':row.status==='approved'?'已批准':'已拒绝'}}</ElTag></template></ElTableColumn>
        <ElTableColumn label="处理" width="160"><template #default="{row}"><template v-if="row.status==='pending'"><ElButton :disabled="busy" @click="review(row.id,true)">批准</ElButton><ElButton :disabled="busy" @click="review(row.id,false)">拒绝</ElButton></template></template></ElTableColumn>
      </ElTable>
    </ElCard>
    <ElCard v-if="view === 'delivery'" shadow="never"><template #header><h2>已下发项目</h2></template>
      <ElTable :data="projects" row-key="id" empty-text="暂无下发项目">
        <ElTableColumn label="用户 / 项目" min-width="200"><template #default="{row}"><strong>{{row.name}}</strong><div class="cell-secondary">{{row.login}}</div></template></ElTableColumn>
        <ElTableColumn prop="package_name" label="交付包" min-width="160" />
        <ElTableColumn label="状态" min-width="130"><template #default="{row}"><ElTag :type="row.deleted_at?'info':row.status==='ready'?'success':row.status==='failed'?'danger':'warning'">{{row.deleted_at?'待完成清理':row.status==='ready'?'已就绪':row.status==='failed'?'失败':'处理中'}}</ElTag><p v-if="row.last_error" class="error">{{row.last_error}}</p></template></ElTableColumn>
        <ElTableColumn label="处理" min-width="200"><template #default="{row}"><ElButton v-if="row.status!=='ready' && !row.deleted_at" :disabled="busy" @click="retry(row.id)">重试下发</ElButton><a v-if="row.repo_url" :href="row.repo_url" target="_blank" rel="noopener">仓库</a><ElButton data-test="delete-project" type="danger" link :disabled="busy" @click="confirmDelete(row as Project)">{{row.deleted_at?'重试删除':'删除'}}</ElButton></template></ElTableColumn>
      </ElTable>
    </ElCard>
  </div>
  <ModalShell v-if="deleting" dialog-class="md:w-[36rem] p-6" label="删除交付项目" @close="!busy && (deleting=null)">
    <form class="delivery" @submit.prevent="removeProject">
      <h2>删除 {{deleting.login}} / {{deleting.name}}</h2>
      <p>删除该项目的本地工作目录并归档会话，未推送的修改将丢失。保留 Gitea 仓库、提交历史和 LiteLLM 历史用量，不影响其他项目。正在执行的任务需要先停止。</p>
      <label>输入项目名称确认<input v-model="confirmation" data-test="project-delete-confirmation" :disabled="busy" autocomplete="off"></label>
      <p v-if="error" role="alert" class="error">{{error}}</p>
      <ElButton native-type="button" :disabled="busy" @click="deleting=null">取消</ElButton>
      <ElButton native-type="submit" data-test="confirm-project-delete" :disabled="busy || confirmation!==deleting.name">确认删除项目</ElButton>
    </form>
  </ModalShell>
</template>
<style scoped>
.delivery { display:grid; gap:20px; }
.delivery-workflow { display:grid; grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr); gap:20px; align-items:start; }
h2 { font-size:15px; font-weight:600; }
p { margin:8px 0; font-size:13px; color:var(--station-muted); overflow-wrap:anywhere; }
.error { color:#b42318; }
a { color:var(--station-accent); margin-right:16px; }
form.delivery label { display:grid; gap:8px; }
form.delivery input { border:1px solid var(--station-line); border-radius:6px; padding:8px; }
@media(max-width:900px) { .delivery-workflow { grid-template-columns:1fr; } }
</style>
