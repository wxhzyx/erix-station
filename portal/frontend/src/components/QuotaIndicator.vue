<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElPopover } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
type Quota={daily_limit:number;used:number;reserved:number;remaining:number};
const auth=useAuthStore(),router=useRouter(),{locale}=useI18n();
const en=computed(()=>locale.value==='en'),quota=ref<Quota|null>(null),failed=ref(false);
let controller:AbortController|undefined,epoch=0,timer:ReturnType<typeof setInterval>|undefined;
const percent=computed(()=>{
  const q=quota.value;if(!q||q.daily_limit===0)return '—';
  const value=q.used/q.daily_limit*100;
  return value>0&&value<0.1?'<0.1%':`${Number(value.toFixed(1))}%`;
});
async function refresh(){
  controller?.abort();controller=new AbortController();const token=++epoch;
  if(!auth.user){quota.value=null;return;}
  try{
    const q=await api<Quota>('/api/me/token-quota',{signal:controller.signal});
    if(token!==epoch)return;
    if(![q.daily_limit,q.used,q.reserved,q.remaining].every(n=>Number.isFinite(n)&&n>=0))throw new Error('Invalid quota');
    quota.value=q;failed.value=false;
  }catch{if(token===epoch){quota.value=null;failed.value=true;}}
}
watch(()=>auth.user?.id,()=>{quota.value=null;failed.value=false;void refresh();},{immediate:true,flush:'sync'});
onMounted(()=>{timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},30000);window.addEventListener('focus',refresh);});
onUnmounted(()=>{++epoch;controller?.abort();clearInterval(timer);window.removeEventListener('focus',refresh);});
const format=(n:number)=>n.toLocaleString(en.value?'en-US':'zh-CN');
</script>
<template>
  <ElPopover placement="bottom-end" trigger="hover" :width="260" :show-after="150" :title="en?'Daily Token usage':'今日 Token 用量'">
    <template #reference><button type="button" class="quota-indicator" :aria-label="`${en?'Daily quota used':'今日额度已用'} ${percent}`" @click="router.push('/settings?tab=usage')"><span class="quota-dot" :class="{ depleted:quota&&quota.remaining===0 }" aria-hidden="true"></span>{{percent}}</button></template>
    <dl v-if="quota" class="quota-details"><div><dt>{{en?'Used':'已使用'}}</dt><dd>{{format(quota.used)}}</dd></div><div><dt>{{en?'Daily limit':'每日上限'}}</dt><dd>{{format(quota.daily_limit)}}</dd></div><div><dt>{{en?'In progress':'调用中预留'}}</dt><dd>{{format(quota.reserved)}}</dd></div><div><dt>{{en?'Remaining':'可用'}}</dt><dd>{{format(quota.remaining)}}</dd></div></dl>
    <span v-else>{{failed?(en?'Unavailable':'暂不可用'):(en?'Loading…':'加载中…')}}</span>
  </ElPopover>
</template>
<style scoped>
.quota-indicator{display:inline-flex;align-items:center;gap:7px;padding:7px 8px;background:transparent;border:0;border-radius:6px;color:var(--station-ink);font:600 12px/1.4 var(--el-font-family);white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums}.quota-indicator:hover{background:var(--station-soft)}.quota-indicator:focus-visible{outline:2px solid var(--station-accent);outline-offset:2px}.quota-dot{width:6px;height:6px;border-radius:50%;background:var(--station-accent)}.quota-dot.depleted{background:#b42318}.quota-details{display:grid;gap:10px;margin:8px 0}.quota-details div{display:flex;justify-content:space-between;gap:16px}.quota-details dt{color:var(--station-muted)}.quota-details dd{margin:0;font-variant-numeric:tabular-nums;font-weight:600}
</style>
