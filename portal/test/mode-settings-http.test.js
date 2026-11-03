import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http.js';
import { cookieSettings, loadConfig } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
const userId = '11111111-1111-1111-1111-111111111111';
const secret = 'synthetic-private-upstream-secret';
async function fixture(t,{restricted=false,catalogFailure=false}={}) {
  const user={id:userId,login:'settings-test',display_name:'Settings',role:'admin',fde_name:null,status:'active',must_change_password:restricted};
  const pool=new FakePool({users:[user]});
  const token='synthetic-mode-session';
  pool.sessions.push({id:'session-test',user_id:userId,token_hash:hashToken(token),created_at:new Date(),expires_at:new Date(Date.now()+3600000),last_seen_at:new Date(),revoked_at:null});
  const original=pool.query.bind(pool); const ownerQueries=[];
  pool.query=async(sql,args=[])=>{
    if(sql.includes('FROM users WHERE id')&&sql.includes("status = 'active'")) {ownerQueries.push(args[0]); return {rows:args[0]===userId?[user]:[]};}
    if(sql.includes('chat_llm_bindings')) {ownerQueries.push(args[0]); return {rows:[]};}
    return original(sql,args);
  };
  const gateway={listCredentials:async()=>{if(catalogFailure)throw new Error(secret);return {credentials:[{credential_name:'provider',credential_values:{api_key:secret}}]};},listModels:async()=>({data:[]})};
  const config={...loadConfig({}),cookie:cookieSettings('dev-http',604800),sessionTtlSeconds:604800,sessionRenewIntervalSeconds:3600,maxBodyBytes:65536};
  const server=createServer({pool,config,llmGateway:gateway,log:{log(){},warn(){},error(){}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  return {base:`http://127.0.0.1:${server.address().port}`,headers:{cookie:`${config.cookie.name}=${token}`,'content-type':'application/json'},ownerQueries};
}
test('settings requires login and allows seatless authenticated own settings',async(t)=>{
  const f=await fixture(t);
  assert.equal((await fetch(`${f.base}/api/me/mode-settings`)).status,401);
  const res=await fetch(`${f.base}/api/me/mode-settings?user_id=another`,{headers:f.headers});
  assert.equal(res.status,200);
  const body=await res.json(); assert.equal(body.chat,null); assert.equal(body.work,null);
  assert.ok(!JSON.stringify(body).includes(secret));
  assert.ok(f.ownerQueries.length>0); assert.ok(f.ownerQueries.every(id=>id===userId));
});
test('settings mandatory password restriction blocks before reading settings',async(t)=>{
  const f=await fixture(t,{restricted:true});
  assert.equal((await fetch(`${f.base}/api/me/mode-settings`,{headers:f.headers})).status,403);
  assert.equal(f.ownerQueries.length,0);
});
test('settings rejects cross-origin writes before reads or writes',async(t)=>{
  const f=await fixture(t);
  const res=await fetch(`${f.base}/api/me/mode-settings/chat`,{method:'PUT',headers:{...f.headers,origin:'https://evil.invalid'},body:'{}'});
  assert.equal(res.status,403); assert.equal(f.ownerQueries.length,0);
});
test('settings rejects caller-supplied owner and sanitizes gateway failure',async(t)=>{
  const f=await fixture(t,{catalogFailure:true});
  const res=await fetch(`${f.base}/api/me/mode-settings/chat`,{method:'PUT',headers:f.headers,body:JSON.stringify({provider_id:'provider',main_model_id:'model',user_id:'another'})});
  assert.equal(res.status,400); assert.equal(f.ownerQueries.length,0);
  const get=await fetch(`${f.base}/api/me/mode-settings`,{headers:f.headers});
  assert.equal(get.status,503); assert.ok(!(await get.text()).includes(secret));
});
