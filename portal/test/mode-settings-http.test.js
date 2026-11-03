import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http.js';
import { cookieSettings, loadConfig } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
const userId = '11111111-1111-1111-1111-111111111111';
const secret = 'synthetic-private-upstream-secret';
async function fixture(t,{restricted=false,catalogFailure=false,role='admin',validModel=false}={}) {
  const user={id:userId,login:'settings-test',display_name:'Settings',role,fde_name:null,status:'active',must_change_password:restricted};
  const pool=new FakePool({users:[user]});
  const token='synthetic-mode-session';
  pool.sessions.push({id:'session-test',user_id:userId,token_hash:hashToken(token),created_at:new Date(),expires_at:new Date(Date.now()+3600000),last_seen_at:new Date(),revoked_at:null});
  const original=pool.query.bind(pool); const ownerQueries=[], bindings=new Map(), generated=[];
  const memberId='22222222-2222-4222-8222-222222222222';
  pool.query=async(sql,args=[])=>{
    if(sql.includes('FROM users WHERE id')&&sql.includes("status = 'active'")) {ownerQueries.push(args[0]); return {rows:args[0]===userId?[user]:validModel&&args[0]===memberId?[{id:memberId,fde_name:null}]:[]};}
    if(sql.includes('pg_try_advisory_xact_lock')) return {rows:[{locked:true}]};
    if(sql.includes('INSERT INTO chat_llm_bindings')) {
      const [user_id,provider_id,model_id,model_name,model_type,api_key]=args;
      bindings.set(user_id,{user_id,provider_id,model_id,model_name,model_type,api_key});return {rows:[]};
    }
    if(sql.includes('chat_llm_bindings')) {ownerQueries.push(args[0]); return {rows:bindings.has(args[0])?[bindings.get(args[0])]:[]};}
    return original(sql,args);
  };
  const gateway={listCredentials:async()=>{if(catalogFailure)throw new Error(secret);return {credentials:[{credential_name:'provider',credential_values:{api_key:secret}}]};},listModels:async()=>({data:validModel?[{model_name:'chat-one',litellm_params:{litellm_credential_name:'provider'},model_info:{id:'model-1',type:'text'}}]:[]}),generateKey:async body=>{generated.push(body);return {key:secret};}};
  const config={...loadConfig({}),cookie:cookieSettings('dev-http',604800),sessionTtlSeconds:604800,sessionRenewIntervalSeconds:3600,maxBodyBytes:65536};
  const server=createServer({pool,config,llmGateway:gateway,log:{log(){},warn(){},error(){}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  return {base:`http://127.0.0.1:${server.address().port}`,headers:{cookie:`${config.cookie.name}=${token}`,'content-type':'application/json'},ownerQueries,bindings,generated,memberId,audit:pool.audit};
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


test('regular members cannot write configuration through old or admin URLs',async(t)=>{
  const f=await fixture(t,{role:'fde'});
  for(const path of ['/api/me/mode-settings/chat','/api/me/mode-settings/work',`/api/admin/users/${userId}/mode-settings/chat`,`/api/admin/users/${userId}/mode-settings/work`]) {
    const res=await fetch(`${f.base}${path}`,{method:'PUT',headers:f.headers,body:JSON.stringify({provider_id:'provider',main_model_id:'model'})});
    assert.equal(res.status,403,path);
  }
  assert.equal((await fetch(`${f.base}/api/admin/users/${userId}/mode-settings`,{headers:f.headers})).status,403);
  assert.equal(f.ownerQueries.length,0);
});

test('admin assignment reads validate the target and preserve credential redaction',async(t)=>{
  const f=await fixture(t);
  const res=await fetch(`${f.base}/api/admin/users/${userId}/mode-settings`,{headers:f.headers});
  assert.equal(res.status,200); assert.ok(!(await res.text()).includes(secret));
  assert.equal((await fetch(`${f.base}/api/admin/users/not-a-uuid/mode-settings`,{headers:f.headers})).status,404);
  assert.equal((await fetch(`${f.base}/api/admin/users/22222222-2222-2222-2222-222222222222/mode-settings`,{headers:f.headers})).status,404);
});

test('admin assigns another member a chat model without moving identity or audit ownership',async(t)=>{
  const f=await fixture(t,{validModel:true});
  const res=await fetch(`${f.base}/api/admin/users/${f.memberId}/mode-settings/chat`,{method:'PUT',headers:f.headers,body:JSON.stringify({provider_id:'provider',main_model_id:'model-1'})});
  assert.equal(res.status,200);assert.ok(!(await res.text()).includes(secret));
  assert.ok(f.bindings.has(f.memberId));assert.ok(!f.bindings.has(userId));
  assert.equal(f.generated[0].metadata.fde_id,f.memberId);
  const entry=f.audit.find(a=>a.action==='admin.model_assignment');
  assert.equal(entry.actor_id,userId);assert.equal(entry.target,f.memberId);
  assert.ok(!JSON.stringify(entry).includes(secret));
});
