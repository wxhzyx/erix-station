import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http.js';
import { cookieSettings, loadConfig } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
const approvalId='33333333-3333-4333-8333-333333333333';
async function fixture(t,{role='fde',restricted=false,flow=false}={}) {
  const user={id:'11111111-1111-4111-8111-111111111111',login:'approval-test',display_name:'Approval',role,fde_name:role==='fde'||flow?'approval-test':null,status:'active',must_change_password:restricted};
  const pool=new FakePool({users:[user]});const token='synthetic-approval-session';
  pool.sessions.push({id:'test-session',user_id:user.id,token_hash:hashToken(token),created_at:new Date(),expires_at:new Date(Date.now()+3600000),last_seen_at:new Date(),revoked_at:null});
  const original=pool.query.bind(pool),queries=[];
  let approval=null;
  const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),sideEffects=[];
  const repository={resolveRepository:async()=>({git_host_id:'host',repository:'org/repo',source_ref:'feature'}),snapshot:async()=>({source_sha:A,target_sha:B,diff:'diff --git a/a.js b/a.js\n+const a=1;'}),merge:async(args)=>{await args.beforePush(C);sideEffects.push('merge');return {merged:true,merge_sha:C};}};

  pool.query=async(sql,args=[])=>{
    if(sql.startsWith('SELECT id, role, fde_name FROM users'))return {rows:args[0]===user.id?[user]:[]};
    if(flow&&sql.startsWith('SELECT id FROM git_hosts'))return {rows:[{id:'host'}]};
    if(flow&&sql.startsWith('SELECT id, fde_name FROM users'))return {rows:[user]};
    if(flow&&sql.includes('FROM chat_llm_bindings'))return {rows:[{provider_id:'provider',model_id:'model',model_name:'chat-model',api_key:'synthetic-private-key'}]};
    if(sql.includes('project_approvals')) {
      queries.push({sql,args});
      if(!flow)return {rows:[]};
      if(sql.startsWith('INSERT')) {
        const [id,requester_id,cwd,git_host_id,repository,source_ref,target_ref,source_sha,target_sha,diff,web_url]=args;
        approval={id,requester_id,cwd,git_host_id,repository,source_ref,target_ref,source_sha,target_sha,diff,web_url,status:'pending'};
      } else if(sql.startsWith('UPDATE')&&approval) {
        if(sql.includes("SET status='reviewing'"))Object.assign(approval,{status:'reviewing',operation_token:args[1]});
        else if(sql.includes("SET status='reviewed'"))Object.assign(approval,{status:'reviewed',ai_review:args[2]});
        else if(sql.includes("SET status='approved'"))Object.assign(approval,{status:'approved',approved_by:args[1]});
        else if(sql.includes("SET status='merging'"))Object.assign(approval,{status:'merging',operation_token:args[1]});
        else if(sql.includes('SET candidate_sha='))Object.assign(approval,{candidate_sha:args[2],merged_by:args[3]});
        else if(sql.includes("SET status='merged'"))Object.assign(approval,{status:'merged',merge_sha:args[2],merged_at:new Date()});
        else throw new Error('unexpected approval update');
      }
      return {rows:approval?[{...approval}]:[]};
    }
    return original(sql,args);
  };
  const config={...loadConfig({}),cookie:cookieSettings('dev-http',604800),sessionTtlSeconds:604800,sessionRenewIntervalSeconds:3600,maxBodyBytes:65536};
  const gateway={listCredentials:async()=>({credentials:[{credential_name:'provider'}]}),listModels:async()=>({data:[{model_name:'chat-model',litellm_params:{litellm_credential_name:'provider'},model_info:{id:'model',type:'text'}}]})};
  const server=createServer({pool,config,approvalRepository:repository,approvalComplete:async(args)=>{sideEffects.push('ai');assert.ok(args.messages[1].content.includes('const a=1'));return {text:'请补充边界条件测试。'};},llmGateway:gateway,log:{log(){},warn(){},error(){}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  return {base:`http://127.0.0.1:${server.address().port}`,headers:{cookie:`${config.cookie.name}=${token}`,'content-type':'application/json'},queries,user,sideEffects};
}
test('approval HTTP requires login; list owner is session user and filters reach SQL before limit',async(t)=>{
  const f=await fixture(t);
  assert.equal((await fetch(`${f.base}/api/project-approvals`)).status,401);
  const response=await fetch(`${f.base}/api/project-approvals?cwd=${encodeURIComponent('~/projects/demo')}&status=merged&user_id=another`,{headers:f.headers});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{items:[],has_more:false});
  assert.deepEqual(f.queries[0].args,[false,f.user.id,'~/projects/demo','merged']);
  assert.ok(f.queries[0].sql.indexOf('a.cwd=$3')<f.queries[0].sql.indexOf('LIMIT'));
});
test('approval HTTP enforces forced password change before reading reviews',async(t)=>{
  const f=await fixture(t,{restricted:true});
  assert.equal((await fetch(`${f.base}/api/project-approvals`,{headers:f.headers})).status,403);
  assert.equal(f.queries.length,0);
});
test('approval HTTP rejects non-admin AI, approval and merge actions',async(t)=>{
  const f=await fixture(t);
  for(const action of ['review','approve','merge']) {
    const response=await fetch(`${f.base}/api/admin/project-approvals/${approvalId}/${action}`,{method:'POST',headers:f.headers,body:JSON.stringify({confirm:true})});
    assert.equal(response.status,403,action);
  }
  assert.equal(f.queries.length,0);
});
test('approval HTTP rejects cross-origin submissions before repository or DB mutation',async(t)=>{
  const f=await fixture(t);
  const response=await fetch(`${f.base}/api/project-approvals`,{method:'POST',headers:{...f.headers,origin:'https://evil.invalid'},body:JSON.stringify({cwd:'~/projects/demo',source_ref:'feature',target_ref:'main'})});
  assert.equal(response.status,403);assert.equal(f.queries.length,0);
});
test('approval HTTP foreign/missing review is 404 and list rejects unsafe cwd filter',async(t)=>{
  const f=await fixture(t);
  const response=await fetch(`${f.base}/api/project-approvals/${approvalId}`,{headers:f.headers});
  assert.equal(response.status,404);assert.deepEqual(f.queries[0].args,[approvalId,false,f.user.id]);
  assert.equal((await fetch(`${f.base}/api/project-approvals?cwd=${encodeURIComponent('~/projects/../escape')}`,{headers:f.headers})).status,400);
});
test('approval HTTP admin sees admin-scoped list but receives 404 for missing mutation target',async(t)=>{
  const f=await fixture(t,{role:'admin'});
  assert.equal((await fetch(`${f.base}/api/project-approvals`,{headers:f.headers})).status,200);
  assert.equal(f.queries[0].args[0],true);
  const response=await fetch(`${f.base}/api/admin/project-approvals/${approvalId}/approve`,{method:'POST',headers:f.headers,body:JSON.stringify({confirm:true})});
  assert.equal(response.status,404);
});

test('approval HTTP synthetic submit → AI review → explicit approve → merge persists version',async(t)=>{
  const f=await fixture(t,{role:'admin',flow:true});
  const request=(path,body)=>fetch(f.base+path,{method:'POST',headers:f.headers,body:JSON.stringify(body)});
  const submitted=await request('/api/project-approvals',{cwd:'~/projects/demo',source_ref:'feature',target_ref:'main'});
  assert.equal(submitted.status,201);const row=await submitted.json();assert.equal(row.status,'pending');
  assert.deepEqual(f.sideEffects,[]);
  const path=`/api/admin/project-approvals/${row.id}`;
  const reviewed=await request(path+'/review',{});assert.equal(reviewed.status,200);assert.equal((await reviewed.json()).status,'reviewed');
  assert.deepEqual(f.sideEffects,['ai']);
  const approved=await request(path+'/approve',{confirm:true});assert.equal(approved.status,200);assert.equal((await approved.json()).status,'approved');
  assert.deepEqual(f.sideEffects,['ai']);
  const merged=await request(path+'/merge',{confirm:true});assert.equal(merged.status,200);const version=await merged.json();
  assert.equal(version.status,'merged');assert.equal(version.merge_sha,'c'.repeat(40));assert.deepEqual(f.sideEffects,['ai','merge']);
  assert.ok(!JSON.stringify(version).includes('synthetic-private-key'));
});
