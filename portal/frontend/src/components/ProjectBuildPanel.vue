<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { ElButton, ElTable, ElTableColumn, ElTag, ElDialog } from 'element-plus';
import { api } from '../api';
const props=defineProps<{projectId:string;canBuild:boolean}>();
type Build={id:string;branch:string;source_sha:string;status:string;created_at:string;artifact_size:number|null;log:string;error:string|null};
const rows=ref<Build[]>([]),busy=ref(false),error=ref(''),selected=ref<Build|null>(null);
const labels:Record<string,string>={queued:'排队中',running:'编译中',succeeded:'可下载',failed:'失败',cancelled:'已取消'};
let alive=true,timer:ReturnType<typeof setInterval>|undefined;
async function load(){const result=await api<{builds:Build[]}>(`/api/collaboration/${props.projectId}/builds`);if(alive){rows.value=result.builds;if(selected.value)selected.value=rows.value.find(r=>r.id===selected.value?.id)??null;}}
async function act(generate=false){if(busy.value)return;busy.value=true;error.value='';try{if(generate)await api(`/api/collaboration/${props.projectId}/builds`,{method:'POST',body:'{}'});await load();}catch(e){if(alive)error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}}
onMounted(()=>{void act();timer=setInterval(()=>void act(),5000);});
onUnmounted(()=>{alive=false;clearInterval(timer);});
</script>
<template>
  <section class="test-builds">
    <div class="build-actions"><ElButton v-if="canBuild" type="primary" :loading="busy" @click="act(true)">生成测试版</ElButton><ElButton :disabled="busy" @click="act()">刷新</ElButton></div>
    <p v-if="error" role="alert" class="error">{{error}}</p>
    <ElTable :data="rows" row-key="id" empty-text="暂无测试版本">
      <ElTableColumn label="版本" min-width="150"><template #default="{row}"><code>{{row.source_sha.slice(0,10)}}</code><div>{{row.branch}}</div></template></ElTableColumn>
      <ElTableColumn label="状态" width="120"><template #default="{row}"><ElTag :type="row.status==='succeeded'?'success':row.status==='failed'?'danger':'info'">{{labels[row.status]}}</ElTag></template></ElTableColumn>
      <ElTableColumn label="生成时间" min-width="170"><template #default="{row}">{{new Date(row.created_at).toLocaleString()}}</template></ElTableColumn>
      <ElTableColumn label="文件大小" width="110"><template #default="{row}">{{row.artifact_size?(row.artifact_size/1048576).toFixed(1)+' MB':'—'}}</template></ElTableColumn>
      <ElTableColumn label="操作" width="170"><template #default="{row}"><a v-if="row.status==='succeeded'" :href="`/api/project-builds/${row.id}/download`">下载</a><ElButton link @click="selected=row as Build">日志</ElButton></template></ElTableColumn>
    </ElTable>
    <ElDialog :model-value="!!selected" title="构建日志" width="min(900px,94vw)" @close="selected=null"><p v-if="selected?.error" class="error">{{selected.error}}</p><pre>{{selected?.log||'等待构建'}}</pre></ElDialog>
  </section>
</template>
<style scoped>
.build-actions{display:flex;gap:8px;margin:8px 0 16px}a{color:var(--station-accent);margin-right:16px}.error{color:#b42318}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto;background:#101d2d;color:#dce9f6;padding:16px;border-radius:8px;font:12px/1.7 monospace}
</style>
