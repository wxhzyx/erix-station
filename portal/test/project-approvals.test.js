import test from 'node:test';
import assert from 'node:assert/strict';
import { submitProjectApproval, listProjectApprovals, getProjectApproval, reviewProjectApproval, approveProjectApproval, mergeProjectApproval } from '../src/project-approvals.js';
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
function fixture() {
  const rows=new Map(); let seq=0;
  const user={id:'user',role:'fde',fde_name:'user'},admin={id:'admin',role:'admin',fde_name:null};
  const users=new Map([['user',user],['admin',admin],['other',{id:'other',role:'fde',fde_name:'other'}]]);
  const calls=[];
  const repository={resolveRepository:async()=>({git_host_id:'host',repository:'org/repo',source_ref:'feature'}),
    snapshot:async()=>({source_sha:A,target_sha:B,diff:'diff --git a/a.js b/a.js\n+const a=1;',web_url:'https://git.invalid/org/repo'}),
    merge:async(args)=>{calls.push(args);await args.beforePush(C);return {merged:true,merge_sha:C};}};
  const pool={hostEnabled:true,async query(sql,args=[]) {
    if(sql.startsWith('SELECT id FROM git_hosts'))return {rows:pool.hostEnabled?[{id:'host'}]:[]};
    if(sql.startsWith('SELECT id, role'))return {rows:users.has(args[0])?[users.get(args[0])]:[]};
    if(sql.startsWith('INSERT INTO project_approvals')) {
      if([...rows.values()].some(r=>r.requester_id===args[1]&&r.source_sha===args[7]&&r.target_sha===args[8]&&!['merged','stale','rejected'].includes(r.status)))return {rows:[]};
      const [id,requester_id,cwd,git_host_id,repository,source_ref,target_ref,source_sha,target_sha,diff,web_url]=args;
      const row={id,requester_id,cwd,git_host_id,repository,source_ref,target_ref,source_sha,target_sha,diff,web_url,status:'pending',created_at:++seq};rows.set(id,row);return {rows:[{...row}]};
    }
    if(sql.includes('WHERE a.id = $1')) {const r=rows.get(args[0]);return {rows:r&&(args[1]||r.requester_id===args[2])?[{...r}]:[]};}
    if(sql.includes('WHERE ($1::boolean OR a.requester_id'))return {rows:[...rows.values()].filter(r=>(args[0]||r.requester_id===args[1])&&(!args[2]||r.cwd===args[2])&&(!args[3]||r.status===args[3])).sort((a,b)=>(args[3]==='merged' ? ((b.merged_at??0)-(a.merged_at??0)) : 0)||b.created_at-a.created_at).slice(0,101).map(r=>({...r}))};
    if(sql.startsWith('UPDATE project_approvals')) {
      const r=rows.get(args[0]);if(!r)return {rows:[]};
      if(sql.includes('current_actor')) {
        const actorIndex=sql.includes('current_actor.id=$2')?1:sql.includes('current_actor.id=$3')?2:3;
        const currentActor=users.get(args[actorIndex]);
        if(!currentActor||currentActor.role!=='admin'||!users.has(r.requester_id)||!pool.hostEnabled)return {rows:[]};
      }
      if(sql.includes("status IN ('pending','failed')")){if(!['pending','failed'].includes(r.status)&&!(r.status==='reviewing'&&Date.now()-new Date(r.operation_started_at).getTime()>120000))return {rows:[]};r.status='reviewing';r.operation_token=args[1];r.operation_started_at=new Date();}
      else if(sql.includes("SET status='reviewed'")){if(r.status!=='reviewing'||r.operation_token!==args[1])return {rows:[]};Object.assign(r,{status:'reviewed',ai_review:args[2],reviewed_by:args[3],operation_token:null});}
      else if(sql.includes("SET status='approved',operation_token=NULL")){if(r.status!=='merging'||r.candidate_sha||r.operation_token!==args[1]||Date.now()-new Date(r.operation_started_at).getTime()<180000)return {rows:[]};Object.assign(r,{status:'approved',operation_token:null,operation_started_at:null});}
      else if(sql.includes("SET status='approved'")){if(r.status!=='reviewed')return {rows:[]};Object.assign(r,{status:'approved',approved_by:args[1],approved_at:++seq});}
      else if(sql.includes("SET status='merging'")){if(r.status!=='approved')return {rows:[]};Object.assign(r,{status:'merging',operation_token:args[1],operation_started_at:new Date(),candidate_sha:null});}
      else if(sql.includes('SET candidate_sha=')){if(r.status!=='merging'||r.operation_token!==args[1])return {rows:[]};Object.assign(r,{candidate_sha:args[2],merged_by:args[3]});}
      else if(sql.includes("SET status='merged'")){if(r.status!=='merging')return {rows:[]};if(sql.includes('merge_sha=candidate_sha')){if(r.candidate_sha!==args[2])return {rows:[]};r.merge_sha=r.candidate_sha;}else {if(r.operation_token!==args[1])return {rows:[]};r.merge_sha=args[2];}Object.assign(r,{status:'merged',merged_at:++seq,operation_token:null});}
      else if(sql.includes("SET status='stale'")){if(r.status!=='reviewed')return {rows:[]};Object.assign(r,{status:'stale',error:args[1]});}
      else if(sql.includes('SET status=$3')){if(r.operation_token!==args[1])return {rows:[]};Object.assign(r,{status:args[2],error:args[3]});}
      else throw new Error(sql);
      return {rows:[{...r}]};
    }
    throw new Error(sql);
  }};
  const options={repository,resolveProvider:async()=>({base_url:'https://fake.invalid',model:'fake',api_key:'secret-key'}),complete:async()=>({text:'发现一处潜在回归，请核实测试。'})};
  const submit=()=>submitProjectApproval(pool,'user',{cwd:'~/projects/demo',source_ref:'feature',target_ref:'main'},options);
  return {pool,rows,repository,calls,options,submit,users};
}
async function ready(f) {const r=await f.submit();await reviewProjectApproval(f.pool,'admin',r.id,f.options);await approveProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options);return r;}

test('submit pins exact branches and diff; list/detail enforce ownership',async()=>{
  const f=fixture(),r=await f.submit();assert.equal(r.source_sha,A);assert.equal(r.target_sha,B);assert.ok(r.diff.includes('const a'));
  assert.equal((await listProjectApprovals(f.pool,'other')).items.length,0);
  assert.equal((await listProjectApprovals(f.pool,'admin')).items.length,1);
  await assert.rejects(getProjectApproval(f.pool,'other',r.id),{code:'not_found'});
  await assert.rejects(f.submit(),{code:'approval_exists'});
});
test('rejects ownership overrides, traversal, identical refs and oversized diff',async()=>{
  const f=fixture();
  for(const input of [{cwd:'~/projects/../x',target_ref:'main'},{cwd:'~/projects/demo',source_ref:'main',target_ref:'main'},{cwd:'~/projects/demo',target_ref:'main',user_id:'other'}])await assert.rejects(submitProjectApproval(f.pool,'user',input,f.options),{code:'validation_failed'});
  f.repository.snapshot=async()=>({source_sha:A,target_sha:B,diff:'x'.repeat(120001)});
  await assert.rejects(f.submit(),{code:'diff_too_large'});
});
test('AI sees actual pinned diff but cannot approve; requires active admin and explicit confirmation',async()=>{
  const f=fixture(),r=await f.submit();let prompt;
  f.options.complete=async(args)=>{prompt=args;return {text:'AI: approve automatically secret-key'};};
  await assert.rejects(reviewProjectApproval(f.pool,'user',r.id,f.options),{code:'forbidden'});
  await assert.rejects(approveProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'approval_not_reviewed'});
  const reviewed=await reviewProjectApproval(f.pool,'admin',r.id,f.options);
  assert.equal(reviewed.status,'reviewed');assert.ok(prompt.messages[1].content.includes(r.diff));assert.ok(!reviewed.ai_review.includes('secret-key'));
  await assert.rejects(approveProjectApproval(f.pool,'admin',r.id,{},f.options),{code:'confirmation_required'});
  assert.equal(f.calls.length,0);
});
test('stale source or target prevents review and approval',async()=>{
  const f=fixture(),r=await f.submit();f.repository.snapshot=async()=>({source_sha:C,target_sha:B,diff:'changed'});
  await assert.rejects(reviewProjectApproval(f.pool,'admin',r.id,f.options),{code:'approval_stale'});assert.equal(f.rows.get(r.id).status,'stale');
  const g=fixture(),q=await g.submit();await reviewProjectApproval(g.pool,'admin',q.id,g.options);g.repository.snapshot=async()=>({source_sha:A,target_sha:C,diff:'changed'});
  await assert.rejects(approveProjectApproval(g.pool,'admin',q.id,{confirm:true},g.options),{code:'approval_stale'});
});
test('approved merge checkpoints candidate before remote write and records version audit',async()=>{
  const f=fixture(),r=await ready(f);
  f.repository.merge=async(args)=>{await args.beforePush(C);assert.equal(f.rows.get(r.id).candidate_sha,C);f.calls.push(args);return {merged:true,merge_sha:C};};
  const merged=await mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options);
  assert.equal(merged.status,'merged');assert.equal(merged.merge_sha,C);assert.equal(merged.merged_by,'admin');assert.ok(merged.merged_at);assert.equal(f.calls[0].source_sha,A);assert.equal(f.calls[0].target_sha,B);
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'approval_not_approved'});assert.equal(f.calls.length,1);
});
test('uncertain merge remains locked and is reconciled read-only from durable candidate',async()=>{
  const f=fixture(),r=await ready(f);
  f.repository.merge=async(args)=>{f.calls.push(args);await args.beforePush(C);throw new Error('secret-key transport unknown');};
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'merge_result_unknown'});
  assert.equal(f.rows.get(r.id).status,'merging');assert.ok(!f.rows.get(r.id).error.includes('secret-key'));
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'merge_result_unknown'});
  f.repository.snapshot=async()=>({source_sha:A,target_sha:C,diff:''});
  assert.equal((await mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options)).status,'merged');assert.equal(f.calls.length,1);
});
test('merge preflight target movement becomes stale without remote write',async()=>{
  const f=fixture(),r=await ready(f);f.repository.snapshot=async()=>({source_sha:A,target_sha:C,diff:'changed'});
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'approval_stale'});assert.equal(f.calls.length,0);assert.equal(f.rows.get(r.id).status,'stale');
});
test('concurrent review clicks issue only one AI request',async()=>{
  const f=fixture(),r=await f.submit();let release,started;
  const startedPromise=new Promise(resolve=>{started=resolve;});
  f.options.complete=()=>{started();return new Promise(resolve=>{release=()=>resolve({text:'review'});});};
  const first=reviewProjectApproval(f.pool,'admin',r.id,f.options);await startedPromise;
  await assert.rejects(reviewProjectApproval(f.pool,'admin',r.id,f.options),{code:'approval_busy'});
  release();assert.equal((await first).status,'reviewed');
});
test('remote merge success followed by DB failure reconciles without another remote write',async()=>{
  const f=fixture(),r=await ready(f);const query=f.pool.query.bind(f.pool);let failSave=true;
  f.pool.query=async(sql,args)=>{if(failSave&&sql.includes("SET status='merged'")&&sql.includes('merge_sha=$3')){failSave=false;throw new Error('database temporarily unavailable');}return query(sql,args);};
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'merge_result_unknown'});
  assert.equal(f.rows.get(r.id).candidate_sha,C);assert.equal(f.calls.length,1);
  f.repository.readTarget=async()=>({target_sha:C});
  assert.equal((await mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options)).status,'merged');assert.equal(f.calls.length,1);
});
test('definite merge conflict retains approval and never reports merged',async()=>{
  const f=fixture(),r=await ready(f);
  f.repository.merge=async()=>{throw Object.assign(new Error('provider internal details'),{code:'merge_conflict',httpStatus:409});};
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'merge_conflict'});
  assert.equal(f.rows.get(r.id).status,'approved');assert.equal(f.rows.get(r.id).merge_sha,undefined);
});

test('expired interrupted review can be reclaimed and late old completion cannot overwrite it',async()=>{
  const f=fixture(),r=await f.submit();let release,started;
  const began=new Promise(resolve=>{started=resolve;});let count=0;
  f.options.complete=async()=>{if(++count===1){started();return new Promise(resolve=>{release=()=>resolve({text:'obsolete review'});});}return {text:'new review'};};
  const old=reviewProjectApproval(f.pool,'admin',r.id,f.options);await began;
  f.rows.get(r.id).operation_started_at=new Date(Date.now()-121000);
  assert.equal((await getProjectApproval(f.pool,'admin',r.id)).can_retry_review,true);
  const current=await reviewProjectApproval(f.pool,'admin',r.id,f.options);assert.equal(current.ai_review,'new review');
  release();await assert.rejects(old,{code:'approval_busy'});
  assert.equal(f.rows.get(r.id).ai_review,'new review');assert.equal(f.rows.get(r.id).status,'reviewed');
});

test('project version filters run before the page limit and report truncation',async()=>{
  const f=fixture(),r=await f.submit();
  Object.assign(f.rows.get(r.id),{status:'merged',merge_sha:C,created_at:0});
  for(let i=1;i<=105;i++)f.rows.set(String(i),{...r,id:String(i),cwd:'~/projects/other',status:'pending',created_at:i});
  const versions=await listProjectApprovals(f.pool,'user',{cwd:'~/projects/demo',status:'merged'});
  assert.equal(versions.items.length,1);assert.equal(versions.items[0].merge_sha,C);assert.equal(versions.has_more,false);
  const all=await listProjectApprovals(f.pool,'user');assert.equal(all.items.length,100);assert.equal(all.has_more,true);
  assert.equal((await listProjectApprovals(f.pool,'other',{cwd:'~/projects/demo',status:'merged'})).items.length,0);
  await assert.rejects(listProjectApprovals(f.pool,'user',{cwd:'~/projects/../escape'}),{code:'validation_failed'});
  await assert.rejects(listProjectApprovals(f.pool,'user',{status:'anything'}),{code:'validation_failed'});
});
test('definite adapter credential failure leaves approved state retryable',async()=>{
  const f=fixture(),r=await ready(f);
  f.repository.merge=async()=>{throw Object.assign(new Error('never reveal credential internals'),{code:'git_credential_missing',httpStatus:409});};
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'git_credential_missing'});
  assert.equal(f.rows.get(r.id).status,'approved');
});

test('version history orders by merge confirmation time, not request creation time',async()=>{
  const f=fixture(),r=await f.submit();
  Object.assign(f.rows.get(r.id),{status:'merged',created_at:1,merged_at:30});
  f.rows.set('second',{...r,id:'second',status:'merged',created_at:20,merged_at:25});
  const query=f.pool.query.bind(f.pool);let ordering;
  f.pool.query=async(sql,args)=>{if(sql.includes('LIMIT 101'))ordering=sql;return query(sql,args);};
  const versions=await listProjectApprovals(f.pool,'user',{status:'merged'});
  assert.equal(versions.items[0].id,r.id);
  assert.match(ordering,/CASE WHEN \$4='merged' THEN a\.merged_at END DESC NULLS LAST/);
});

test('approval list excludes bulky evidence in SQL and DTO while detail preserves it',async()=>{
  const f=fixture(),r=await f.submit();
  f.rows.get(r.id).ai_review='review evidence';
  let sql;
  const query=f.pool.query.bind(f.pool);
  f.pool.query=async(statement,args)=>{if(statement.includes('LIMIT 101'))sql=statement;return query(statement,args);};
  const list=await listProjectApprovals(f.pool,'user');
  assert.equal(list.items[0].diff,'');assert.equal(list.items[0].ai_review,null);
  const projection=sql.slice(0,sql.indexOf(' FROM '));
  assert.ok(!projection.includes('a.*'));assert.ok(!projection.includes('a.diff'));assert.ok(!projection.includes('a.ai_review'));
  const detail=await getProjectApproval(f.pool,'user',r.id);assert.equal(detail.diff,r.diff);assert.equal(detail.ai_review,'review evidence');
});
test('admin role or requester/host revocation during preparation blocks push',async()=>{
  for(const revoke of ['admin','requester','host']) {
    const f=fixture(),r=await ready(f);let pushed=false;
    f.repository.merge=async(args)=>{
      if(revoke==='admin')f.users.get('admin').role='fde';
      if(revoke==='requester')f.users.delete('user');
      if(revoke==='host')f.pool.hostEnabled=false;
      await args.beforePush(C);pushed=true;return {merged:true,merge_sha:C};
    };
    await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:revoke==='admin'?'forbidden':revoke==='requester'?'unauthorized':'git_host_unavailable'});
    assert.equal(pushed,false);assert.equal(f.rows.get(r.id).status,'approved');assert.equal(f.rows.get(r.id).candidate_sha,null);
  }
});
test('approval freshness await cannot outlive revoked admin permission',async()=>{
  const f=fixture(),r=await f.submit();await reviewProjectApproval(f.pool,'admin',r.id,f.options);
  f.repository.snapshot=async()=>{f.users.get('admin').role='fde';return {source_sha:A,target_sha:B,diff:'diff'};};
  await assert.rejects(approveProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'forbidden'});
  assert.equal(f.rows.get(r.id).status,'reviewed');
});
test('completed AI review is not saved after requester disable',async()=>{
  const f=fixture(),r=await f.submit();
  f.options.complete=async()=>{f.users.delete('user');return {text:'review result'};};
  await assert.rejects(reviewProjectApproval(f.pool,'admin',r.id,f.options),{code:'unauthorized'});
  assert.equal(f.rows.get(r.id).status,'failed');assert.equal(f.rows.get(r.id).ai_review,undefined);
});
test('authorization predicates prevent write when revocation races the last check',async()=>{
  const f=fixture(),r=await ready(f);const query=f.pool.query.bind(f.pool);let pushed=false;
  f.pool.query=async(sql,args)=>{
    if(sql.includes('SET candidate_sha=')) {
      assert.match(sql,/current_actor\.status='active'/);assert.match(sql,/current_requester\.status='active'/);assert.match(sql,/current_host\.enabled=true/);
      f.users.delete('admin');
    }
    return query(sql,args);
  };
  f.repository.merge=async(args)=>{await args.beforePush(C);pushed=true;return {merged:true,merge_sha:C};};
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'approval_busy'});
  assert.equal(pushed,false);assert.equal(f.rows.get(r.id).status,'approved');
});

test('expired pre-push preparation resets approval and fences late old worker without push',async()=>{
  const f=fixture(),r=await ready(f);let resume,started,pushes=0;
  const began=new Promise(resolve=>{started=resolve;});
  f.repository.merge=async(args)=>{started();await new Promise(resolve=>{resume=resolve;});await args.beforePush(C);pushes++;return {merged:true,merge_sha:C};};
  const old=mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options);await began;
  // Active preparations cannot be reset.
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'merge_result_unknown'});
  f.rows.get(r.id).operation_started_at=new Date(Date.now()-181000);
  const reset=await mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options);
  assert.equal(reset.status,'approved');assert.equal(pushes,0);
  resume();await assert.rejects(old,{code:'approval_busy'});
  assert.equal(pushes,0);assert.equal(f.rows.get(r.id).status,'approved');assert.equal(f.rows.get(r.id).candidate_sha,null);
});
test('expired preparation with non-null candidate is never reset or pushed again',async()=>{
  const f=fixture(),r=await ready(f);
  Object.assign(f.rows.get(r.id),{status:'merging',operation_token:'old-token',candidate_sha:C,operation_started_at:new Date(Date.now()-181000)});
  f.repository.readTarget=async()=>({target_sha:B});
  await assert.rejects(mergeProjectApproval(f.pool,'admin',r.id,{confirm:true},f.options),{code:'merge_result_unknown'});
  assert.equal(f.rows.get(r.id).status,'merging');assert.equal(f.calls.length,0);
});

test('admin own-project filters cannot mix another users identical directory name',async()=>{
  const f=fixture(),r=await f.submit();
  Object.assign(f.rows.get(r.id),{status:'merged',requester_id:'user'});
  f.rows.set('admin-review',{...r,id:'admin-review',status:'merged',requester_id:'admin'});
  const own=await listProjectApprovals(f.pool,'admin',{cwd:'~/projects/demo',status:'merged'});
  assert.deepEqual(own.items.map(item=>item.id),['admin-review']);
  const global=await listProjectApprovals(f.pool,'admin',{status:'merged'});assert.equal(global.items.length,2);
});
