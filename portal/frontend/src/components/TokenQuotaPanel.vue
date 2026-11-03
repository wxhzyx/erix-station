<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';
type Quota={daily_limit:number;used:number;reserved:number;remaining:number;requests:{id:string;requested_limit:number;status:string}[]};
const open=ref(false),quota=ref<Quota|null>(null),error=ref(''),busy=ref(false),requested=ref(4000000),reason=ref(''),sent=ref(false);
async function refresh(){quota.value=await api<Quota>('/api/me/token-quota');requested.value=Math.max(quota.value.daily_limit+1000000,4000000);}
async function show(){open.value=!open.value;if(!open.value)return;error.value='';busy.value=true;try{await refresh();}catch(e){error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}}
async function submit(){busy.value=true;error.value='';try{await api('/api/me/token-quota',{method:'POST',body:JSON.stringify({requested_limit:requested.value,reason:reason.value})});sent.value=true;await refresh();}catch(e){error.value=e instanceof Error?e.message:String(e);}finally{busy.value=false;}}
</script>
<template>
  <div class="relative"><button class="text-sm underline" @click="show">我的 Token 额度</button>
    <section v-if="open" class="absolute right-0 top-8 z-50 w-80 max-w-[90vw] rounded-lg border bg-white p-4 shadow-lg">
      <h2 class="font-semibold">每日 Token 额度</h2><p v-if="error" role="alert" class="text-red-700">{{error}}</p>
      <template v-if="quota"><p>今日已用 {{quota.used.toLocaleString()}} / {{quota.daily_limit.toLocaleString()}}</p><p>剩余 {{quota.remaining.toLocaleString()}}<span v-if="quota.reserved">（调用中预留 {{quota.reserved.toLocaleString()}}）</span></p>
        <p class="my-2 text-xs text-black/60">输入＋输出 Token，每天北京时间 00:00 重置。</p>
        <p v-if="quota.requests.some(r=>r.status==='pending')" role="status">额度升级申请待管理员审批</p>
        <form v-else class="grid gap-2" @submit.prevent="submit"><label>申请每日上限<input v-model.number="requested" class="w-full rounded border p-1" type="number" :min="quota.daily_limit+1" max="1000000000" required></label><label>申请原因<textarea v-model="reason" class="w-full rounded border p-1" maxlength="2000" required /></label><button class="rounded border p-2" :disabled="busy">申请提高额度</button></form>
        <p v-if="sent" role="status">申请已提交</p>
        <ul class="mt-2 text-xs"><li v-for="r in quota.requests.slice(0,3)" :key="r.id">{{Number(r.requested_limit).toLocaleString()}}：{{r.status==='approved'?'已批准':r.status==='rejected'?'已拒绝':'待审批'}}</li></ul>
      </template>
    </section>
  </div>
</template>
