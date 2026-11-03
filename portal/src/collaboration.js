import crypto from 'node:crypto';
import { validateAssignment, deleteAssignment, lockMemberProjects } from './managed-projects.js';
import { stopSession } from './sessions.js';
import { failure, segment, branchFor, protectionRules, loadCollaborationConfig, gitea, personalIdentity, applyProtections, withStationAuthors } from './collaboration-gitea.js';
import { initializeRepository, prepareWorkspace } from './collaboration-workspace.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const requireId=id=>{if(!UUID.test(id??''))throw failure('not_found','项目或成员不存在',404);return id;};
const repoPath=(c,p)=>`/repos/${segment(c.organization)}/${segment(p.repo_name)}`;
async function audit(db,user,project,action,details={}) {
  await db.query(`INSERT INTO audit_log(actor_id,action,target,details) VALUES($1,$2,$3,$4)`,[user,`collaboration.${action}`,project,JSON.stringify(details)]);
}
async function projectLock(pool,id,fn) {
  const db=await pool.connect();
  try { await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`collaboration:${id}`]);return await fn(db); }
  finally {await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`collaboration:${id}`]);db.release();}
}
async function transaction(db,fn) {
  await db.query('BEGIN');try {const result=await fn();await db.query('COMMIT');return result;}
  catch(e){await db.query('ROLLBACK');throw e;}
}
async function members(db,id) {
  return (await db.query(`SELECT m.*,u.login,u.display_name,u.fde_name,u.status AS user_status,u.deleted_at AS user_deleted_at,
    a.name AS workspace,a.cleanup_completed_at FROM project_memberships m JOIN users u ON u.id=m.user_id
    LEFT JOIN project_assignments a ON a.id=m.assignment_id WHERE m.project_id=$1 ORDER BY m.updated_at`,[id])).rows;
}
async function projectFor(db,id,user) {
  const p=(await db.query(`SELECT p.*,u.login AS owner_login,u.display_name AS owner_name,d.name AS package_name
    FROM collaboration_projects p JOIN users u ON u.id=p.owner_user_id JOIN delivery_packages d ON d.id=p.package_id WHERE p.id=$1`,[requireId(id)])).rows[0];
  if(!p)throw failure('not_found','项目不存在',404);
  const ms=await members(db,id),mine=ms.find(m=>m.user_id===user.id);
  const manage=user.role==='admin'||p.owner_user_id===user.id;
  if(!manage && !['active','invited','provisioning','failed'].includes(mine?.state))throw failure('forbidden','没有此项目权限',403);
  return {p,ms,mine,manage};
}
async function eligible(db,c,userId) {
  const row=(await db.query(`SELECT u.id,u.login,g.remote_login FROM users u JOIN fde_git_accounts g ON g.fde_id=u.id
    JOIN git_hosts h ON h.id=g.git_host_id WHERE u.id=$1 AND u.status='active' AND u.deleted_at IS NULL
    AND u.fde_name IS NOT NULL AND g.remote_login IS NOT NULL AND h.enabled=true AND rtrim(h.base_url,'/')=$2`,[requireId(userId),c.baseUrl])).rows[0];
  if(!row)throw failure('member_not_ready','成员需先完成 SSO 登录和工位开通');return row;
}
async function reviewers(db,c,p) {
  return (await db.query(`SELECT u.id,g.remote_login FROM users u JOIN fde_git_accounts g ON g.fde_id=u.id
    JOIN git_hosts h ON h.id=g.git_host_id WHERE (u.role='admin' OR u.id=$1) AND u.status='active' AND u.deleted_at IS NULL
    AND g.remote_login IS NOT NULL AND h.enabled=true AND rtrim(h.base_url,'/')=$2`,[p.owner_user_id,c.baseUrl])).rows;
}
async function secureRepository(db,c,p,ms) {
  const api=gitea(c),repo=repoPath(c,p),reviewersList=await reviewers(db,c,p);
  if(!reviewersList.length)throw failure('reviewer_missing','缺少有效的项目审核人');
  await api('PATCH',repo,{has_actions:false,allow_manual_merge:false,allow_rebase:false,allow_rebase_explicit:false,allow_squash_merge:false,allow_merge_commits:true});
  // Install default deny before granting access. Gitea drops whitelist entries
  // for users who are not yet collaborators, so grant first, then verify exact rules.
  await applyProtections(api,repo,[protectionRules(c.login,[],[]).at(-1)]);
  for(const u of reviewersList)await api('PUT',`${repo}/collaborators/${segment(u.remote_login)}`,{permission:'write'});
  for(const m of ms.filter(m=>['provisioning','active','failed'].includes(m.state)&&m.user_status==='active'))await api('PUT',`${repo}/collaborators/${segment(m.remote_login)}`,{permission:'write'});
  await applyProtections(api,repo,protectionRules(c.login,reviewersList.map(u=>u.remote_login),ms.map(m=>m.state==='failed'?{...m,state:'provisioning'}:m)));
  return {api,repo};
}
async function allocateAssignment(db,p,m) {
  if(m.assignment_id)return m.assignment_id;
  const id=crypto.randomUUID();
  const inserted=await db.query(`INSERT INTO project_assignments(id,user_id,package_id,name,instructions,created_by,collaboration_project_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,name) DO NOTHING RETURNING id`,[id,m.user_id,p.package_id,p.name,p.instructions,p.created_by,p.id]);
  if(!inserted.rows.length)throw failure('workspace_conflict','成员已有同名项目，不能覆盖；请先处理原项目');
  await db.query('UPDATE project_memberships SET assignment_id=$2 WHERE id=$1',[m.id,id]);m.assignment_id=id;return id;
}
export async function createSharedProject(pool,config,user,body) {
  if(user.role!=='admin')throw failure('forbidden','只有管理员可以下发项目',403);
  const v=validateAssignment(body),c=await loadCollaborationConfig(config),id=crypto.randomUUID();
  const db=await pool.connect();
  try {await transaction(db,async()=>{
    const owner=await eligible(db,c,v.user_id);
    if(!(await db.query('SELECT id FROM delivery_packages WHERE id=$1',[v.package_id])).rows.length)throw failure('not_found','交付包不存在',404);
    await db.query(`INSERT INTO collaboration_projects(id,name,owner_user_id,package_id,instructions,repo_name,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,v.name,v.user_id,v.package_id,v.instructions,`${v.name}-${id.slice(0,8)}`,user.id]);
    await db.query(`INSERT INTO project_memberships(id,project_id,user_id,branch,remote_login,state,invited_by,accepted_at)
      VALUES($1,$2,$3,$4,$5,'provisioning',$6,now())`,[crypto.randomUUID(),id,owner.id,branchFor(owner.login,owner.id),owner.remote_login,user.id]);
    await audit(db,user.id,id,'created',{owner:owner.id,package_id:v.package_id});
  });}finally{db.release();}
  // Worker owns external side effects and retries after portal restarts.
  return {id,status:'provisioning',shared:true};
}

async function revokeMember(pool,db,config,c,p,m) {
  const api=gitea(c),repo=repoPath(c,p);
  if(p.repo_id) {
    const existing=await api('GET',`${repo}/collaborators/${segment(m.remote_login)}/permission`,undefined,{missing:true});
    if(existing && existing.permission!=='none')await api('DELETE',`${repo}/collaborators/${segment(m.remote_login)}`);
    const after=await api('GET',`${repo}/collaborators/${segment(m.remote_login)}/permission`,undefined,{missing:true});
    if(after && after.permission!=='none')throw failure('git_revoke_pending','Git 权限尚未撤销，等待重试',502);
  }
  if(m.assignment_id) {
    // Keep the assignment while stopSession settles running/claimed work, preserving its usage writes.
    const active=(await db.query(`SELECT DISTINCT s.id FROM chat_sessions s JOIN runs r ON r.session_id=s.id
      WHERE s.user_id=$1 AND s.cwd=$2 AND r.status IN ('queued','running','cancelling')`,[m.user_id,`~/projects/${p.name}`])).rows;
    for(const s of active)await stopSession(pool,{userId:m.user_id,sessionId:s.id,allowArchived:true});
    if(active.length)throw failure('project_stopping','正在停止本项目任务，稍后自动继续清理');
    const live=(await db.query("SELECT id FROM containers WHERE user_id=$1 AND status<>'removed' AND revoked_at IS NULL",[m.user_id])).rows;
    if(live.length&&!m.cleanup_ack)throw failure('project_stopping','正在停止该项目后台进程，等待工位确认');
    await deleteAssignment(pool,{id:m.assignment_id,actorId:p.created_by,confirmation:p.name,config,allowShared:true});
  }
  await db.query(`UPDATE project_memberships SET state='revoked',last_error=NULL,updated_at=now() WHERE id=$1`,[m.id]);
  await audit(db,p.created_by,p.id,'member_revoked',{user_id:m.user_id,repository_retained:true,usage_retained:true});
}

export async function reconcileProject(pool,config,id) {
  const c=await loadCollaborationConfig(config);
  return projectLock(pool,id,async db=>{
    let p=(await db.query('SELECT * FROM collaboration_projects WHERE id=$1',[id])).rows[0];
    if(!p||p.state==='deleted')return;
    try {
      let ms=await members(db,id);
      // Deleted/disabled identities never remain writable, including offboarding retries.
      for(const m of ms)if(m.user_status!=='active'||m.user_deleted_at) {
        await db.query(`UPDATE project_memberships SET state='revoking' WHERE id=$1 AND state NOT IN ('revoked','declined')`,[m.id]);
      }
      ms=await members(db,id);
      if(p.state!=='deleting') {
        const api=gitea(c),rp=repoPath(c,p),description=`FDE Station shared project ${p.id}`;
        let repo=await api('GET',rp,undefined,{missing:true});
        if(!repo)repo=await api('POST',`/orgs/${segment(c.organization)}/repos`,{name:p.repo_name,description,private:true,auto_init:false,default_branch:'main'});
        if(repo.description!==description||!repo.private||repo.owner?.login!==c.organization||(p.repo_id&&Number(p.repo_id)!==repo.id))throw failure('repository_conflict','仓库身份不符，拒绝接管');
        p={...p,repo_id:repo.id,repo_url:`${c.baseUrl}/${segment(c.organization)}/${segment(p.repo_name)}.git`};
        await db.query('UPDATE collaboration_projects SET repo_id=$2,repo_url=$3 WHERE id=$1',[id,p.repo_id,p.repo_url]);
        await initializeRepository(db,config,c,p);
        await secureRepository(db,c,p,ms);
        for(const m of ms.filter(x=>['provisioning','failed'].includes(x.state))) {
          try {
            await transaction(db,()=>allocateAssignment(db,p,m));
            // Create branch as repository owner, before granting the member write access.
            const branch=await api('GET',`${rp}/branches/${segment(m.branch)}`,undefined,{missing:true});
            if(!branch)await api('POST',`${rp}/branches`,{new_branch_name:m.branch,old_branch_name:'main'});
            await api('PUT',`${rp}/collaborators/${segment(m.remote_login)}`,{permission:'write'});
            await prepareWorkspace(config,c,p,m);
            await transaction(db,async()=>{
              // Same user-row -> member lock ordering as account deletion.
              const account=(await db.query('SELECT status,deleted_at FROM users WHERE id=$1 FOR UPDATE',[m.user_id])).rows[0];
              await lockMemberProjects(db,m.user_id);
              if(account?.status!=='active'||account.deleted_at) {
                await db.query("UPDATE project_memberships SET state='revoking' WHERE id=$1",[m.id]);return;
              }
              const ready=await db.query(`UPDATE project_memberships SET state='active',last_error=NULL,updated_at=now()
                WHERE id=$1 AND state IN ('provisioning','failed') RETURNING id`,[m.id]);
              if(ready.rows.length)await db.query(`UPDATE project_assignments SET status='ready',repo_url=$2,last_error=NULL WHERE id=$1 AND deleted_at IS NULL`,[m.assignment_id,p.repo_url]);
            });
          }catch(e){await db.query(`UPDATE project_memberships SET state='failed',last_error=$2,updated_at=now() WHERE id=$1 AND state IN ('provisioning','failed')`,[m.id,e.code?e.message:'工作空间准备失败，请重试']);}
        }
        await secureRepository(db,c,p,await members(db,id));
        await db.query(`UPDATE collaboration_projects SET state='active',last_error=NULL WHERE id=$1`,[id]);
      }
      for(const m of ms.filter(x=>x.state==='revoking')) {
        try{await revokeMember(pool,db,config,c,p,m);}
        catch(e){await db.query('UPDATE project_memberships SET last_error=$2,updated_at=now() WHERE id=$1',[m.id,e.code?e.message:'撤权清理未完成，系统将重试']);}
      }
      if(p.state==='deleting' && !(await members(db,id)).some(m=>!['revoked','declined'].includes(m.state))) {
        if(p.repo_id) {
          // Installed Gitea 28.2.0 returns 404 for historical PR APIs when
          // archived=true. Retain a protected read-only repo with its PR unit
          // enabled instead, so historical delivery remains inspectable.
          const rules=protectionRules(c.login,[],await members(db,id));
          rules[0].merge_whitelist_usernames=[];
          await applyProtections(gitea(c),repoPath(c,p),rules);
          await gitea(c)('PATCH',repoPath(c,p),{archived:false,has_actions:false});
        }
        await db.query(`UPDATE collaboration_projects SET state='deleted',last_error=NULL,deleted_at=COALESCE(deleted_at,now()) WHERE id=$1`,[id]);
      }
    }catch(e){await db.query(`UPDATE collaboration_projects SET state=CASE WHEN state='deleting' THEN state ELSE 'failed' END,last_error=$2 WHERE id=$1`,[id,e.code?e.message:'共享项目处理失败，系统将重试']);}
  });
}
export function startCollaborationLoop(pool,config,{intervalMs=15000,log=console}={}) {
  let stopped=false,timer;
  const tick=async()=>{
    if(stopped||!config.collaborationConfigFile)return;
    try {
      const rows=(await pool.query(`SELECT DISTINCT p.id FROM collaboration_projects p LEFT JOIN project_memberships m ON m.project_id=p.id
        JOIN users u ON u.id=m.user_id WHERE p.state<>'deleted' AND (p.state<>'active' OR m.state IN ('provisioning','failed','revoking') OR (u.status<>'active' AND m.state NOT IN ('revoked','declined'))) LIMIT 20`)).rows;
      for(const row of rows){if(stopped)break;await reconcileProject(pool,config,row.id);}
    }catch{log.warn?.('[collaboration] reconciliation failed; durable jobs will retry');}
    finally{if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref?.();}}
  };
  if(config.collaborationConfigFile){timer=setTimeout(tick,1000);timer.unref?.();}
  return {stop(){stopped=true;clearTimeout(timer);}};
}

async function beginRevoke(db,m) {
  if(['revoking','revoked'].includes(m.state))return;
  await lockMemberProjects(db,m.user_id);
  await db.query(`UPDATE project_memberships SET state='revoking',cleanup_ack=false,last_error=NULL,updated_at=now() WHERE id=$1`,[m.id]);
  if(m.assignment_id)await db.query(`UPDATE project_assignments SET status='pending' WHERE id=$1`,[m.assignment_id]);
  // Archive immediately, under the same lock as postMessage: no new run can slip in.
  if(m.assignment_id)await db.query(`UPDATE chat_sessions SET status='archived',updated_at=now() WHERE user_id=$1
    AND cwd=(SELECT '~/projects/'||name FROM project_assignments WHERE id=$2)`,[m.user_id,m.assignment_id]);
  if(m.assignment_id)await db.query(`UPDATE preview_grants SET state='revoked',revoked_at=COALESCE(revoked_at,now()) WHERE state='active' AND allocation_id IN (
    SELECT a.id FROM port_allocations a JOIN port_observations o ON o.fde_id=a.fde_id AND o.port=a.port
    JOIN project_assignments w ON w.user_id=a.fde_id WHERE w.id=$1 AND split_part(split_part(o.cwd,'/projects/',2),'/',1)=w.name)`,[m.assignment_id]);
}

/** Authenticated per-container heartbeat: never accepts another user's cleanup ACK. */
export async function collaborationHeartbeat(pool,user,body) {
  const pending=(await pool.query(`SELECT m.id,p.name FROM project_memberships m JOIN collaboration_projects p ON p.id=m.project_id
    WHERE m.user_id=$1 AND m.state='revoking' AND m.assignment_id IS NOT NULL AND NOT m.cleanup_ack
    AND NOT EXISTS(SELECT 1 FROM runs r JOIN chat_sessions s ON s.id=r.session_id
      WHERE s.user_id=m.user_id AND s.cwd='~/projects/'||p.name AND r.status IN ('queued','running','cancelling'))`,[user.id])).rows;
  const acks=Array.isArray(body?.collaboration_cleanup_acks)?body.collaboration_cleanup_acks.slice(0,100):[];
  for(const m of pending)if(acks.includes(m.id))await pool.query("UPDATE project_memberships SET cleanup_ack=true WHERE id=$1 AND user_id=$2 AND state='revoking'",[m.id,user.id]);
  return {cleanup_projects:pending.filter(m=>!acks.includes(m.id))};
}
export async function collaborationApi(pool,config,user,{method,parts,body={}}) {
  if(!parts.length && method==='GET') {
    if(!config.collaborationConfigFile)return {enabled:false,projects:[]};
    return {enabled:true,projects:(await pool.query(`SELECT p.*,u.login AS owner_login,u.display_name AS owner_name,
      m.state AS membership_state,m.branch,m.user_id AS member_user_id FROM collaboration_projects p JOIN users u ON u.id=p.owner_user_id
      LEFT JOIN project_memberships m ON m.project_id=p.id AND m.user_id=$1
      WHERE ($2::boolean OR p.owner_user_id=$1 OR m.state IN ('invited','provisioning','active','failed'))
      ORDER BY p.created_at DESC`,[user.id,user.role==='admin'])).rows};
  }
  if(!parts.length && method==='POST')return createSharedProject(pool,config,user,body);
  const c=await loadCollaborationConfig(config),id=requireId(parts[0]);
  return projectLock(pool,id,async db=>{
    const {p,ms,mine,manage}=await projectFor(db,id,user),action=parts[1],api=gitea(c),rp=repoPath(c,p);
    const requireManage=()=>{if(!manage)throw failure('forbidden','只有负责人和管理员可以管理成员',403);};
    const requireActive=()=>{if(p.state!=='active'||mine?.state!=='active')throw failure('project_not_ready','项目或成员尚未就绪');};
    if(method==='GET'&&!action) {
      const candidates=manage?(await db.query(`SELECT u.id,u.login,u.display_name FROM users u JOIN fde_git_accounts g ON g.fde_id=u.id
        JOIN git_hosts h ON h.id=g.git_host_id WHERE u.status='active' AND u.deleted_at IS NULL AND u.fde_name IS NOT NULL
        AND h.enabled=true AND rtrim(h.base_url,'/')=$1 ORDER BY u.login`,[c.baseUrl])).rows:[];
      return {project:p,members:ms.map(({fde_name,...m})=>m),mine,can_manage:manage,candidates};
    }
    if(method==='POST'&&action==='invite') {
      requireManage();if(p.state!=='active')throw failure('project_not_ready','项目尚未就绪');
      const target=await eligible(db,c,body.user_id),prior=ms.find(m=>m.user_id===target.id);
      if(prior) {
        if(['revoked','declined'].includes(prior.state)) {
          await transaction(db,async()=>{
            if(prior.assignment_id) {
              if(!prior.cleanup_completed_at)throw failure('cleanup_pending','上次工作空间清理尚未完成');
              await db.query("UPDATE project_assignments SET status='pending',deleted_at=NULL,cleanup_completed_at=NULL,last_error=NULL WHERE id=$1",[prior.assignment_id]);
            }
            await db.query("UPDATE project_memberships SET state='invited',invited_by=$2,accepted_at=NULL,cleanup_ack=false,last_error=NULL,updated_at=now() WHERE id=$1",[prior.id,user.id]);
            await audit(db,user.id,id,'reinvited',{user_id:target.id});
          });return {id:prior.id,state:'invited'};
        }
        return {id:prior.id,state:prior.state};
      }
      const mid=crypto.randomUUID();
      await db.query(`INSERT INTO project_memberships(id,project_id,user_id,branch,remote_login,state,invited_by) VALUES($1,$2,$3,$4,$5,'invited',$6)`,[mid,id,target.id,branchFor(target.login,target.id),target.remote_login,user.id]);
      await audit(db,user.id,id,'invited',{user_id:target.id});return {id:mid,state:'invited'};
    }
    if(method==='POST'&&action==='members') {
      const m=ms.find(x=>x.id===requireId(parts[2]));if(!m)throw failure('not_found','成员不存在',404);
      const operation=parts[3];
      if(['accept','decline'].includes(operation)) {
        if(m.user_id!==user.id)throw failure('forbidden','不能代替其他成员接受邀请',403);
        if(m.state!=='invited')return {state:m.state};
        if(p.state!=='active')throw failure('project_not_ready','项目不可加入');
        await eligible(db,c,user.id);
        await db.query(`UPDATE project_memberships SET state=$2,accepted_at=now(),updated_at=now() WHERE id=$1`,[m.id,operation==='accept'?'provisioning':'declined']);
      } else if(operation==='remove') {
        if(!manage&&m.user_id!==user.id)throw failure('forbidden','没有移除成员权限',403);
        if(m.user_id===p.owner_user_id)throw failure('owner_transfer_required','请先转交负责人');
        if(body.confirmation!==p.name)throw failure('confirmation_required','请输入项目名称确认清理本地目录');
        await transaction(db,()=>beginRevoke(db,m));
      } else throw failure('not_found','操作不存在',404);
      await audit(db,user.id,id,operation,{user_id:m.user_id});return {ok:true};
    }
    if(method==='POST'&&action==='transfer') {
      requireManage();const target=ms.find(x=>x.user_id===body.user_id&&x.state==='active');
      if(!target)throw failure('member_not_ready','请选择已就绪成员');
      await eligible(db,c,target.user_id);
      await db.query('UPDATE collaboration_projects SET owner_user_id=$2 WHERE id=$1',[id,target.user_id]);
      await secureRepository(db,c,{...p,owner_user_id:target.user_id},ms);
      await audit(db,user.id,id,'transferred',{owner:target.user_id});return {ok:true};
    }
    if(method==='POST'&&action==='retry') {
      requireManage();await db.query(`UPDATE project_memberships SET state='provisioning',last_error=NULL WHERE project_id=$1 AND state='failed'`,[id]);
      await db.query(`UPDATE collaboration_projects SET state='provisioning',last_error=NULL WHERE id=$1 AND state='failed'`,[id]);return {ok:true};
    }
    if(method==='DELETE'&&!action) {
      if(user.role!=='admin')throw failure('forbidden','只有管理员可以删除整个项目',403);
      if(body.confirmation!==p.name)throw failure('confirmation_required','请输入项目名称确认');
      await transaction(db,async()=>{
        await db.query(`UPDATE collaboration_projects SET state='deleting',deleted_at=COALESCE(deleted_at,now()) WHERE id=$1`,[id]);
        for(const m of [...ms].sort((a,b)=>a.user_id.localeCompare(b.user_id)))if(!['revoked','declined'].includes(m.state))await beginRevoke(db,m);
        await audit(db,user.id,id,'delete_requested',{repository_retained:true,usage_retained:true});
      });return {ok:true,state:'deleting'};
    }
    if(action==='pulls') {
      if(!manage)requireActive();
      if(p.state!=='active'&&method!=='GET')throw failure('project_not_ready','项目不可操作');
      if(!parts[2]) {
        if(method==='GET')return {pulls:await withStationAuthors(db,c,await api('GET',`${rp}/pulls?state=all&limit=50`))};
        if(method==='POST') {
          requireActive();
          if(typeof body.title!=='string'||!body.title.trim()||body.title.length>200||typeof(body.description??'')!=='string'||(body.description??'').length>10000)throw failure('validation_failed','请填写合并标题（最多 200 字）');
          const identity=await personalIdentity(db,config,c,user.id),personal=gitea(c,identity.token);
          const open=await api('GET',`${rp}/pulls?state=open&limit=100`),existing=open.find(x=>x.head?.ref===mine.branch);
          if(existing)return existing;
          const pr=await personal('POST',`${rp}/pulls`,{head:mine.branch,base:'main',title:body.title.trim(),body:body.description??'',allow_maintainer_edit:false});
          await audit(db,user.id,id,'pr_created',{number:pr.number,source_sha:pr.head.sha});return pr;
        }
      }
      const number=Number(parts[2]);if(!Number.isSafeInteger(number)||number<1)throw failure('not_found','PR 不存在',404);
      const pp=`${rp}/pulls/${number}`,pr=await api('GET',pp);
      if(pr.base?.ref!=='main'||Number(pr.head?.repo?.id)!==Number(p.repo_id)||!ms.some(m=>m.branch===pr.head?.ref&&m.remote_login===pr.user?.login))throw failure('unmanaged_pr','此 PR 不属于受管个人分支');
      const main=await api('GET',`${rp}/branches/main`),target=main.commit.id??main.commit.sha;
      if(method==='GET')return {pr:(await withStationAuthors(db,c,[pr]))[0],target_sha:target,diff:await api('GET',`${pp}.diff`,undefined,{text:true}),reviews:await withStationAuthors(db,c,await api('GET',`${pp}/reviews`))};
      if(pr.state!=='open'||pr.merged)throw failure('pr_closed','合并请求已经关闭');
      if(body.source_sha!==pr.head.sha||body.target_sha!==target)throw failure('review_outdated','代码已更新，请刷新差异并重新审核');
      const sourceMember=ms.find(m=>m.branch===pr.head.ref);
      if(sourceMember?.state!=='active'||sourceMember.user_status!=='active')throw failure('member_revoked','提交者权限已撤销');
      if(parts[3]==='review'&&method==='POST') {
        requireManage();if(sourceMember.user_id===user.id)throw failure('self_review','不能审核自己的合并请求',403);
        if(typeof body.approve!=='boolean')throw failure('validation_failed','请选择批准或退回');
        const files=await api('GET',`${pp}/files?limit=100`);
        if(user.role!=='admin'&&(files.length>=100||files.some(f=>/(^|\/)(\.gitea|\.github|Dockerfile[^/]*|package(-lock)?\.json|.*\.(sh|ps1)|deploy)(\/|$)/i.test(f.filename))))throw failure('admin_review_required','构建、依赖或部署文件变更需要管理员审核',403);
        await secureRepository(db,c,p,ms);
        const identity=await personalIdentity(db,config,c,user.id);
        await gitea(c,identity.token)('POST',`${pp}/reviews`,{event:body.approve?'APPROVED':'REQUEST_CHANGES',commit_id:pr.head.sha,body:String(body.note??'').slice(0,10000)|| (body.approve?'已审核':'请修改后重新提交')});
        await db.query(`INSERT INTO collaboration_reviews(project_id,pr_number,reviewer_id,source_sha,target_sha,approved)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,pr_number,reviewer_id) DO UPDATE SET source_sha=$4,target_sha=$5,approved=$6,reviewed_at=now()`,[id,number,user.id,pr.head.sha,target,body.approve]);
        await audit(db,user.id,id,'pr_reviewed',{number,source_sha:pr.head.sha,target_sha:target,approved:body.approve});return {ok:true};
      }
      if(parts[3]==='merge'&&method==='POST') {
        requireManage();
        await secureRepository(db,c,p,ms);
        const approval=(await db.query(`SELECT r.reviewer_id FROM collaboration_reviews r JOIN users u ON u.id=r.reviewer_id
          WHERE r.project_id=$1 AND r.pr_number=$2 AND r.source_sha=$3 AND r.target_sha=$4 AND r.approved=true
          AND r.reviewer_id<>$5 AND u.status='active' AND u.deleted_at IS NULL AND (u.role='admin' OR u.id=$6)`,[id,number,pr.head.sha,target,sourceMember.user_id,p.owner_user_id])).rows[0];
        if(!approval)throw failure('review_required','需要另一位负责人或管理员审核当前版本');
        const checks=await api('GET',`${rp}/commits/${segment(pr.head.sha)}/status`);
        if(checks.statuses?.length && checks.state!=='success')throw failure('checks_pending','提交检查尚未全部通过');
        // Exact source guard + Gitea outdated-branch rule + sole service merge whitelist + per-project lock.
        // No force_merge, direct push, manual merge, or asynchronous merge_when_checks_succeed.
        let mergeError;
        try {await api('POST',`${pp}/merge`,{do:'merge',head_commit_id:pr.head.sha,delete_branch_after_merge:false,force_merge:false});}
        catch(e){mergeError=e;}
        const final=await api('GET',pp);
        if(!final.merged)throw mergeError??failure('merge_pending','尚未合并，请检查冲突和审核状态');
        await audit(db,user.id,id,'pr_merged',{number,merge_sha:final.merge_commit_sha});return final;
      }
    }
    throw failure('not_found','操作不存在',404);
  });
}
