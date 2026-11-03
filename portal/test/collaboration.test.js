import test from 'node:test';
import assert from 'node:assert/strict';
import { branchFor, protectionRules, gitea, applyProtections } from '../src/collaboration-gitea.js';
import { collaborationApi, collaborationHeartbeat } from '../src/collaboration.js';

test('personal branches preserve domain login and deterministically encode unsafe names',()=>{
  assert.equal(branchFor('JXu14','id'),'dev/JXu14');
  assert.equal(branchFor('../../main','abc'),'dev/member-abc');
});
test('branch rules fail closed and never allow direct/force main pushes',()=>{
  const rules=protectionRules('service',['reviewer'],[
    {branch:'dev/a',remote_login:'a',state:'active'},
    {branch:'dev/b',remote_login:'b',state:'revoking'},
    {branch:'dev/c',remote_login:'c',state:'provisioning'},
  ]);
  assert.equal(rules[0].enable_push,false);assert.equal(rules[0].enable_force_push,false);
  assert.equal(rules[0].required_approvals,1);assert.equal(rules[0].block_admin_merge_override,true);
  assert.deepEqual(rules[0].merge_whitelist_usernames,['service']);
  assert.deepEqual(rules[1].push_whitelist_usernames,['a']);
  assert.deepEqual(rules[2].push_whitelist_usernames,[]);
  assert.deepEqual(rules[3].push_whitelist_usernames,['service']);
  assert.equal(rules.at(-1).enable_push,false);assert.ok(rules[1].priority<rules.at(-1).priority);
});
test('Gitea failures redact upstream response bodies and tokens',async()=>{
  const api=gitea({baseUrl:'http://test',token:'secret'},undefined,async()=>({ok:false,status:403,text:async()=> 'secret'}));
  await assert.rejects(api('POST','/repos/a/b',{}),e=>e.httpStatus===502&&!e.message.includes('secret'));
});
test('branch protections must read back exactly; a silent provider downgrade fails',async()=>{
  const rule=protectionRules('svc',['reviewer'],[])[0];let reads=0;
  const api=async(method)=>method==='GET'?(++reads===1?[]:[{...rule,enable_push:true}]):{};
  await assert.rejects(applyProtections(api,'/repos/a/b',[rule]),{code:'branch_protection_mismatch'});
});
test('ordinary users cannot create shared projects, including direct API calls',async()=>{
  await assert.rejects(collaborationApi({}, {}, {id:'user',role:'fde'},{method:'POST',parts:[],body:{}}),{code:'forbidden'});
});
test('unconfigured collaboration is explicitly unavailable, not an empty enabled product',async()=>{
  assert.deepEqual(await collaborationApi({}, {}, {id:'user'},{method:'GET',parts:[]}),{enabled:false,projects:[]});
});
test('cleanup ACKs are bound to authenticated user and current pending membership',async()=>{
  const writes=[];
  const db={query:async(sql,args)=>{if(sql.startsWith('SELECT'))return {rows:[{id:'own',name:'alpha'}]};writes.push(args);return {rows:[]};}};
  assert.deepEqual(await collaborationHeartbeat(db,{id:'A'},{collaboration_cleanup_acks:['B']}),{cleanup_projects:[{id:'own',name:'alpha'}]});
  assert.deepEqual(writes,[]);
  assert.deepEqual(await collaborationHeartbeat(db,{id:'A'},{collaboration_cleanup_acks:['own','B']}),{cleanup_projects:[]});
  assert.deepEqual(writes,[['own','A']]);
});
