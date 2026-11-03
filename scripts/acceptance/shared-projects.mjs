import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import {loadConfig} from '../../portal/src/config.js';
import {createSharedProject,reconcileProject,collaborationApi} from '../../portal/src/collaboration.js';
import {loadCollaborationConfig,gitea} from '../../portal/src/collaboration-gitea.js';
import {stageWorkspace} from '../../portal/src/collaboration-workspace.js';
import {assertAssigned} from '../../portal/src/managed-projects.js';

if(!process.env.FDE_COLLAB_ACCEPTANCE_CONFIG || !process.env.FDE_COLLAB_ACCEPTANCE_FIXTURES || !process.env.FDE_COLLAB_ACCEPTANCE_PACKAGE)throw new Error('Explicit isolated acceptance inputs required');
const base=loadConfig(),schema='collab_qa_'+Date.now(),root='/tmp/'+schema;
const adminPool=new pg.Pool({connectionString:base.bootstrapDatabaseUrl});
await adminPool.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:base.bootstrapDatabaseUrl,options:`-c search_path=${schema},public`});
const config={...base,collaborationConfigFile:process.env.FDE_COLLAB_ACCEPTANCE_CONFIG,userSpaceRoot:root};
const c=await loadCollaborationConfig(config),api=gitea(c);
const fixtures=JSON.parse(await fs.readFile(process.env.FDE_COLLAB_ACCEPTANCE_FIXTURES,'utf8'));
const users=fixtures.map((f,i)=>({...f,id:crypto.randomUUID(),role:i===0?'admin':'fde',fde_name:`collab-qa-${i}`}));
let project;
const call=(user,method,parts,body={})=>collaborationApi(pool,config,user,{method,parts,body});
try {
 for(const table of ['users','delivery_packages','project_assignments','git_hosts','fde_git_accounts','audit_log','chat_sessions','runs','containers','preview_grants','port_allocations','port_observations'])await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
 await pool.query(await fs.readFile('./deploy/migrations/0032-project-collaboration.sql','utf8'));
 const host=crypto.randomUUID();await pool.query("INSERT INTO git_hosts(id,name,provider,base_url,mode) VALUES($1,'collab-qa','gitea',$2,'per_fde_pat')",[host,c.baseUrl]);
 for(const user of users){
  await pool.query("INSERT INTO users(id,login,display_name,role,auth_source,status,fde_name) VALUES($1,$2,$2,$3,'local','active',$4)",[user.id,user.login,user.role,user.fde_name]);
  await pool.query('INSERT INTO fde_git_accounts(fde_id,git_host_id,remote_login) VALUES($1,$2,$3)',[user.id,host,user.login]);
  const home=path.join(root,user.fde_name);await fs.mkdir(path.join(home,'projects'),{recursive:true});await fs.mkdir(path.join(home,'platform','git'),{recursive:true});
  const u=new URL(c.baseUrl);u.username=user.login;u.password=user.token;
  await fs.writeFile(path.join(home,'platform','git','credentials'),u.href+'\n',{mode:0o600});
 }
 const packageId=crypto.randomUUID(),archive=await fs.readFile(process.env.FDE_COLLAB_ACCEPTANCE_PACKAGE);
 await pool.query('INSERT INTO delivery_packages(id,name,filename,sha256,archive,manifest,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[packageId,'QA kit','qa.zip',crypto.createHash('sha256').update(archive).digest('hex'),archive,'[]',users[0].id]);
 project=await createSharedProject(pool,config,users[0],{name:'collab-qa-'+Date.now(),user_id:users[0].id,package_id:packageId,instructions:'Isolated integration test'});
 await reconcileProject(pool,config,project.id);
 let detail=await call(users[0],'GET',[project.id]);
 console.log('PROVISION',JSON.stringify({project:detail.project.state,error:detail.project.last_error,members:detail.members.map(m=>({state:m.state,error:m.last_error}))}));
 assert.equal(detail.project.state,'active');assert.equal(detail.mine.state,'active');
 await assert.rejects(call(users[2],'GET',[project.id]),{code:'forbidden'});
 await call(users[0],'POST',[project.id,'invite'],{user_id:users[1].id});
 const invited=await call(users[1],'GET',[project.id]);
 await assert.rejects(call(users[0],'POST',[project.id,'members',invited.mine.id,'accept']),{code:'forbidden'});
 await call(users[1],'POST',[project.id,'members',invited.mine.id,'accept']);
 await call(users[1],'POST',[project.id,'members',invited.mine.id,'accept']);
 await pool.query("UPDATE project_memberships SET state='failed',last_error='simulated restart' WHERE id=$1",[invited.mine.id]);
 await reconcileProject(pool,config,project.id);detail=await call(users[1],'GET',[project.id]);
 console.log('ACCEPT',JSON.stringify(detail.members.map(m=>({state:m.state,error:m.last_error}))));assert.equal(detail.mine.state,'active');
 const repo='/repos/'+c.organization+'/'+detail.project.repo_name,branch=detail.mine.branch;
 async function commit(text) {
  await stageWorkspace(config,{login:users[1].login,token:users[1].token},detail.project.repo_url,async({git,staging,url})=>{
   await git(['clone','--branch',branch,url,'.']);await fs.writeFile(path.join(staging,'collaboration-check.txt'),text);
   await git(['add','collaboration-check.txt']);await git(['-c','user.name=QA Member','-c','user.email=qa@inteva.invalid','commit','-m',text]);await git(['push','origin',branch]);
  });
 }
 await commit('first review');
 const pr=await call(users[1],'POST',[project.id,'pulls'],{title:'Shared collaboration business acceptance'});
 let review=await call(users[0],'GET',[project.id,'pulls',String(pr.number)]);
 const stamp=()=>({source_sha:review.pr.head.sha,target_sha:review.target_sha});
 await assert.rejects(call(users[1],'POST',[project.id,'pulls',String(pr.number),'review'],{...stamp(),approve:true}),{code:'forbidden'});
 await assert.rejects(call(users[0],'POST',[project.id,'pulls',String(pr.number),'merge'],stamp()),{code:'review_required'});
 await call(users[0],'POST',[project.id,'pulls',String(pr.number),'review'],{...stamp(),approve:true});
 const old=stamp();await commit('second review invalidates first');
 await assert.rejects(call(users[0],'POST',[project.id,'pulls',String(pr.number),'merge'],old),{code:'review_outdated'});
 review=await call(users[0],'GET',[project.id,'pulls',String(pr.number)]);
 await assert.rejects(call(users[0],'POST',[project.id,'pulls',String(pr.number),'merge'],stamp()),{code:'review_required'});
 await call(users[0],'POST',[project.id,'pulls',String(pr.number),'review'],{...stamp(),approve:true});
 const merged=await call(users[0],'POST',[project.id,'pulls',String(pr.number),'merge'],stamp());assert.equal(merged.merged,true);
 const head=(await api('GET',repo+'/branches/main')).commit.id;
 console.log('MERGED',JSON.stringify({repo:detail.project.repo_name,number:pr.number,sha:merged.merge_commit_sha,head}));
 assert.equal(head,merged.merge_commit_sha);
 await call(users[0],'POST',[project.id,'members',detail.mine.id,'remove'],{confirmation:detail.project.name});
 await assert.rejects(assertAssigned(pool,users[1].id,'~/projects/'+detail.project.name),{code:'project_not_assigned'});
 const badPath=path.join(root,'invalid-service.json');await fs.writeFile(badPath,JSON.stringify({...c,token:'deliberately-invalid-test-token'}),{mode:0o600});
 await reconcileProject(pool,{...config,collaborationConfigFile:badPath},project.id);
 assert.equal((await call(users[0],'GET',[project.id])).members.find(m=>m.user_id===users[1].id).state,'revoking');
 await reconcileProject(pool,config,project.id);
 assert.equal((await call(users[0],'GET',[project.id])).members.find(m=>m.user_id===users[1].id).state,'revoked');
 assert.equal(await gitea(c,users[1].token)('GET',repo,undefined,{missing:true}),null);
 assert.equal((await api('GET',repo+'/branches/main')).commit.id,head);
 await fs.stat(path.join(root,users[0].fde_name,'projects',detail.project.name));
 await call(users[0],'POST',[project.id,'invite'],{user_id:users[1].id});
 await call(users[1],'POST',[project.id,'members',detail.mine.id,'accept']);await reconcileProject(pool,config,project.id);
 assert.equal((await call(users[1],'GET',[project.id])).mine.branch,branch);
 assert.equal((await api('GET',repo+'/branches/main')).commit.id,head);
 await call(users[0],'DELETE',[project.id],{confirmation:detail.project.name});await reconcileProject(pool,config,project.id);
 assert.equal((await call(users[0],'GET',[project.id])).project.state,'deleted');
 assert.equal((await api('GET',repo)).archived,false);assert.equal((await api('GET',repo+'/branches/main')).commit.id,head);
 assert.equal((await api('GET',repo+'/pulls/'+pr.number)).merged,true);
 console.log('PASS: two users, duplicate accept, independent workspaces, ACL, stale review, real PR merge, member removal, read-only repository, PRs and commits retained');
} finally {
 await pool.end();await adminPool.end();
 console.log('Isolated DB schema retained for diagnosis:',schema);
}
