<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../api';
type User = { id:string; login:string; display_name:string; fde_name:string|null; status:string };
type Package = { id:string; name:string; filename:string; manifest:{name:string;size:number}[] };
type Project = { id:string; name:string; login:string; package_name:string; status:string; last_error:string|null; repo_url:string|null };
type Quota = { daily_limit:number; used:number; reserved:number; remaining:number; day:string };
type Request = {id:string;login:string;requested_limit:number;reason:string;status:string};
const users=ref<User[]>([]), packages=ref<Package[]>([]), projects=ref<Project[]>([]), requests=ref<Request[]>([]);
const userId=ref(''), packageId=ref(''), projectName=ref(''), instructions=ref(''), packageName=ref('');
const archive=ref<File|null>(null), busy=ref(false), error=ref(''), message=ref('');
const quota=ref<Quota|null>(null), limit=ref(2000000);
async function load() {
  const [u,p,a,r]=await Promise.all([api<{items:User[]}>('/api/admin/users'),api<{packages:Package[]}>('/api/admin/delivery-packages'),
    api<{projects:Project[]}>('/api/admin/assigned-projects'),api<{requests:Request[]}>('/api/admin/token-quota-requests')]);
  users.value=u.items.filter(x=>x.status==='active'&&x.fde_name); packages.value=p.packages; projects.value=a.projects; requests.value=r.requests;
}
async function action(fn:()=>Promise<void>) {
  busy.value=true; error.value=''; message.value='';
  try { await fn(); } catch(e) {error.value=e instanceof Error?e.message:String(e);} finally {busy.value=false;}
}
onMounted(()=>action(load));
function pick(event:Event) { archive.value=(event.target as HTMLInputElement).files?.[0]??null; }
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
  await api(`/api/admin/token-quota-requests/${id}/review`,{method:'POST',body:JSON.stringify({approve})});await load();message.value=approve?'申请已批准':'申请已拒绝';
}); }
</script>
<template>
  <div class="delivery">
    <p v-if="error" role="alert" class="error">{{error}}</p><p v-if="message" role="status">{{message}}</p>
    <section><h2>开发交付包</h2><p>上传需求、开发规范、Agent 指令和调试资料。无需提供源码。</p>
      <form @submit.prevent="upload"><label>交付包名称<input v-model="packageName" required maxlength="150"></label>
        <label>ZIP 文件（最多 50 MB）<input type="file" accept=".zip" required @change="pick"></label><button :disabled="busy">上传交付包</button></form>
    </section>
    <section><h2>下发项目</h2><form @submit.prevent="assign">
      <label>接收用户<select v-model="userId" required @change="loadQuota"><option value="" disabled>选择用户</option><option v-for="u in users" :key="u.id" :value="u.id">{{u.display_name||u.login}} · {{u.login}}</option></select></label>
      <label>开发交付包<select v-model="packageId" required><option value="" disabled>选择交付包</option><option v-for="p in packages" :key="p.id" :value="p.id">{{p.name}}（{{p.manifest.length}} 个文件）</option></select></label>
      <label>项目名称<input v-model="projectName" required pattern="[a-z0-9][a-z0-9_-]{0,62}" placeholder="例如 crg-development"></label>
      <label>补充开发要求<textarea v-model="instructions" maxlength="10000" rows="3" /></label>
      <button :disabled="busy">下发并创建用户私有 Git 仓库</button></form>
    </section>
    <section v-if="userId"><h2>所选用户的每日 Token 上限</h2><p v-if="quota">今日已用 {{quota.used.toLocaleString()}}，调用中预留 {{quota.reserved.toLocaleString()}}。每天北京时间 00:00 重置。</p>
      <form @submit.prevent="saveQuota"><label>每日上限（输入＋输出 Token）<input v-model.number="limit" type="number" min="0" max="1000000000" step="1" required></label><button :disabled="busy||!quota">保存额度</button></form></section>
    <section><h2>额度申请</h2><p v-if="!requests.length">暂无申请</p><table v-else><thead><tr><th>用户</th><th>申请日额度</th><th>原因</th><th>状态</th><th>处理</th></tr></thead><tbody>
      <tr v-for="r in requests" :key="r.id"><td>{{r.login}}</td><td>{{Number(r.requested_limit).toLocaleString()}}</td><td>{{r.reason}}</td><td>{{r.status}}</td><td><template v-if="r.status==='pending'"><button :disabled="busy" @click="review(r.id,true)">批准</button><button :disabled="busy" @click="review(r.id,false)">拒绝</button></template></td></tr>
    </tbody></table></section>
    <section><h2>已下发项目</h2><p v-if="!projects.length">暂无下发项目</p><table v-else><thead><tr><th>用户 / 项目</th><th>交付包</th><th>状态</th><th>处理</th></tr></thead><tbody>
      <tr v-for="p in projects" :key="p.id"><td>{{p.login}} / {{p.name}}</td><td>{{p.package_name}}</td><td>{{p.status==='ready'?'已就绪':p.status==='failed'?'失败':'处理中'}}<p v-if="p.last_error" class="error">{{p.last_error}}</p></td><td><button v-if="p.status!=='ready'" :disabled="busy" @click="retry(p.id)">重试下发</button><a v-else :href="p.repo_url??undefined" target="_blank" rel="noopener">仓库</a></td></tr>
    </tbody></table></section>
  </div>
</template>
<style scoped>
.delivery{max-width:1100px;display:grid;gap:20px}section{border:1px solid #d8dee5;border-radius:8px;padding:20px}h2{font-size:18px;font-weight:600;margin-bottom:12px}form{display:grid;gap:12px;max-width:700px}label{display:grid;gap:4px;font-size:14px}input,select,textarea{border:1px solid #b9c2cd;border-radius:5px;padding:8px;background:white}button{border:1px solid #a9b5c2;border-radius:5px;padding:7px 12px;width:fit-content;margin-right:8px}button:disabled{opacity:.5}table{width:100%;text-align:left;font-size:14px}th,td{padding:9px;border-bottom:1px solid #e4e8ec;vertical-align:top}.error{color:#b42318}p{margin:4px 0 12px;overflow-wrap:anywhere}a{color:#165ca5}
</style>
