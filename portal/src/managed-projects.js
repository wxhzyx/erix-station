import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AdminError } from './admin.js';
import { assertSafePath } from './fsutil.js';
import { readDeliveryPackage } from './delivery-package.js';
import { validateFdeName } from './projects.js';

const runFile = promisify(execFile);
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateAssignment(body) {
  if (!ID.test(body?.user_id) || !ID.test(body?.package_id)
    || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(body?.name ?? '')
    || typeof (body.instructions ?? '') !== 'string' || (body.instructions ?? '').length > 10000) {
    throw new AdminError('validation_failed', '请选择用户和交付包；项目名使用小写字母、数字、下划线或连字符（最多 63 字符）');
  }
  return { ...body, instructions: body.instructions ?? '' };
}

export async function uploadPackage(pool, { actorId, name, filename, archive }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 150) throw new AdminError('validation_failed', '交付包名称必填（最多 150 字符）');
  const files = await readDeliveryPackage(archive);
  const id = crypto.randomUUID(); const sha = crypto.createHash('sha256').update(archive).digest('hex');
  const manifest = files.map(f => ({ name: f.name, size: f.data.length }));
  await pool.query(`INSERT INTO delivery_packages(id,name,filename,sha256,archive,manifest,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, name.trim(), String(filename ?? 'delivery.zip').slice(0,200), sha, archive, JSON.stringify(manifest), actorId]);
  return { id, name: name.trim(), sha256: sha, manifest };
}

export async function listPackages(pool) {
  return (await pool.query(`SELECT id,name,filename,sha256,manifest,created_at FROM delivery_packages ORDER BY created_at DESC`)).rows;
}
export async function listAssignments(pool, userId = null) {
  return (await pool.query(`SELECT a.id,a.user_id,a.package_id,a.name,a.instructions,a.status,a.repo_url,a.last_error,
    a.created_at,a.deleted_at,a.collaboration_project_id,u.login,p.name AS package_name FROM project_assignments a
    JOIN users u ON u.id=a.user_id JOIN delivery_packages p ON p.id=a.package_id
    WHERE u.deleted_at IS NULL AND (a.deleted_at IS NULL OR a.cleanup_completed_at IS NULL)
    ${userId ? `AND a.user_id=$1 AND a.deleted_at IS NULL AND (a.collaboration_project_id IS NULL OR EXISTS (
      SELECT 1 FROM project_memberships m JOIN collaboration_projects cp ON cp.id=m.project_id
      WHERE m.assignment_id=a.id AND m.state='active' AND cp.state='active'))` : ''} ORDER BY a.created_at DESC`, userId ? [userId] : [])).rows;
}
export async function assertAssigned(pool, userId, cwd) {
  const row = (await pool.query(`SELECT id FROM project_assignments WHERE user_id=$1 AND name=$2 AND status='ready' AND deleted_at IS NULL
    AND (collaboration_project_id IS NULL OR EXISTS (SELECT 1 FROM project_memberships m JOIN collaboration_projects cp ON cp.id=m.project_id
      WHERE m.assignment_id=project_assignments.id AND m.state='active' AND cp.state='active'))`,
    [userId, cwd.replace(/^~\/projects\//, '')])).rows[0];
  if (!row) throw new AdminError('project_not_assigned', '该项目尚未由管理员下发', { httpStatus: 403 });
}

/** Serializes session creation/sends with assignment removal, across replicas. */
export async function lockMemberProjects(client, userId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`member-projects:${userId}`]);
}

/** Retain the assignment and upstream repository. Only remove its local directory. */
export async function deleteAssignment(pool, { id, actorId, confirmation, config, allowShared = false }) {
  if (!ID.test(id)) throw new AdminError('not_found', '项目不存在', { httpStatus: 404 });
  const client = await pool.connect();
  let a;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`assignment:${id}`]);
    await client.query('BEGIN');
    a = (await client.query(`SELECT a.*,u.fde_name FROM project_assignments a
      JOIN users u ON u.id=a.user_id WHERE a.id=$1 FOR UPDATE OF a`, [id])).rows[0];
    if (!a) throw new AdminError('not_found', '项目不存在', { httpStatus: 404 });
    if (a.collaboration_project_id && !allowShared) throw new AdminError('shared_project', '请在共享项目中移除成员或删除项目', {httpStatus:409});
    if (confirmation !== a.name) throw new AdminError('confirmation_required', '请输入完整项目名称确认删除');
    if (a.cleanup_completed_at) { await client.query('COMMIT'); return { ok: true }; }
    await lockMemberProjects(client, a.user_id);
    const cwd = `~/projects/${a.name}`;
    const active = await client.query(`SELECT r.id FROM runs r JOIN chat_sessions s ON s.id=r.session_id
      WHERE s.user_id=$1 AND s.cwd=$2 AND r.status IN ('queued','running','cancelling') LIMIT 1`, [a.user_id, cwd]);
    if (active.rows.length) throw new AdminError('project_busy', '请先停止该项目正在执行的任务，再删除项目', { httpStatus: 409 });
    await client.query(`UPDATE project_assignments SET deleted_at=COALESCE(deleted_at,now()),last_error=NULL WHERE id=$1`, [id]);
    await client.query(`UPDATE chat_sessions SET status='archived',updated_at=now() WHERE user_id=$1 AND cwd=$2`, [a.user_id, cwd]);
    await client.query(`INSERT INTO audit_log(actor_id,action,target,details) VALUES($1,'admin.project_deleted',$2,$3)`,
      [actorId, id, JSON.stringify({ user_id: a.user_id, name: a.name, repository_retained: true })]);
    await client.query('COMMIT');
    // The durable tombstone prevents new sessions before touching the filesystem.
    if (!validateFdeName(a.fde_name).ok || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(a.name) || !config.userSpaceRoot) {
      throw new Error('Unsafe project directory');
    }
    const root = path.resolve(config.userSpaceRoot);
    const target = path.join(root, a.fde_name, 'projects', a.name);
    // Stay in the member's inherited XFS project quota while quarantining
    // outside the home/projects mounts exposed to the container.
    const trashRoot = path.join(root, a.fde_name, '.deleted-projects');
    const trash = path.join(trashRoot, id);
    assertSafePath(root, target); assertSafePath(root, trash);
    await fs.mkdir(trashRoot, { recursive: true, mode: 0o700 });
    // Quarantine outside the user's mounted home before recursive cleanup.
    // Retries use the immutable assignment id, never an arbitrary supplied path.
    let exists = true;
    try { await fs.lstat(target); }
    catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
    if (exists) {
      const markerPath = path.join(target, '.fde-assignment.json');
      assertSafePath(root, markerPath);
      let marker;
      try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); }
      catch (error) {
        // Legacy ready assignments were registered from existing member-owned
        // directories. DB ownership is authoritative for those; failed/pending
        // deliveries may instead point at a pre-existing conflicting directory.
        if (error.code !== 'ENOENT' || a.status !== 'ready') throw error;
      }
      if (marker !== undefined && (!marker || marker.id !== id || marker.package_id !== a.package_id)) throw new Error('Project ownership marker mismatch');
      try { await fs.lstat(trash); throw new Error('Project cleanup conflict'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      assertSafePath(root, target);
      await fs.rename(target, trash);
    }
    assertSafePath(root, trash);
    await fs.rm(trash, { recursive: true, force: true });
    await client.query(`UPDATE project_assignments SET cleanup_completed_at=now(),last_error=NULL WHERE id=$1`, [id]);
    return { ok: true, repository_retained: true };
  } catch (error) {
    await client.query('ROLLBACK');
    if (a) await client.query(`UPDATE project_assignments SET last_error=$2 WHERE id=$1 AND deleted_at IS NOT NULL`,
      [id, '本地项目清理未完成，请重试删除；Git 仓库和历史用量保留']);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`assignment:${id}`]);
    client.release();
  }
}

export async function createAssignment(pool, { actorId, body, config, fetchImpl = fetch, run = runFile }) {
  const v = validateAssignment(body);
  const u = (await pool.query(`SELECT id FROM users WHERE id=$1 AND status='active' AND fde_name IS NOT NULL`, [v.user_id])).rows[0];
  const p = (await pool.query(`SELECT id FROM delivery_packages WHERE id=$1`, [v.package_id])).rows[0];
  if (!u || !p) throw new AdminError('not_found', '用户尚未开通工位，或交付包不存在', { httpStatus: 404 });
  const id = crypto.randomUUID();
  const inserted = await pool.query(`INSERT INTO project_assignments(id,user_id,package_id,name,instructions,created_by)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,name) DO NOTHING RETURNING id`,
  [id,v.user_id,v.package_id,v.name,v.instructions,actorId]);
  if (!inserted.rows.length) throw new AdminError('project_exists', '该用户已有同名项目，请在失败项目上点击重试', { httpStatus: 409 });
  return provisionAssignment(pool, { id, config, fetchImpl, run });
}

/** Retry is serialized across portal replicas. Never overwrite a user's existing directory/repository. */
export async function provisionAssignment(pool, { id, config, fetchImpl = fetch, run = runFile }) {
  if (!ID.test(id)) throw new AdminError('not_found', '项目不存在', { httpStatus: 404 });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`assignment:${id}`]);
    const a = (await client.query(`SELECT a.*,u.fde_name,u.status AS user_status,p.archive,g.remote_login,h.base_url,h.enabled
      FROM project_assignments a JOIN users u ON u.id=a.user_id JOIN delivery_packages p ON p.id=a.package_id
      LEFT JOIN fde_git_accounts g ON g.fde_id=a.user_id LEFT JOIN git_hosts h ON h.id=g.git_host_id WHERE a.id=$1`, [id])).rows[0];
    if (!a) throw new AdminError('not_found', '项目不存在', { httpStatus: 404 });
    if (a.collaboration_project_id) throw new AdminError('shared_project', '请在共享项目中重试准备工作空间', {httpStatus:409});
    if (a.deleted_at) throw new AdminError('project_deleted', '项目已删除，不能重新下发', { httpStatus: 409 });
    if (a.status === 'ready') return { id, status: 'ready', repo_url: a.repo_url };
    if (a.user_status !== 'active' || !a.remote_login || !a.enabled) throw new AdminError('git_not_ready', '用户的 Gitea 账号尚未就绪', { httpStatus: 409 });
    const root = path.resolve(config.userSpaceRoot);
    const target = path.join(root, a.fde_name, 'projects', a.name);
    assertSafePath(root, target);
    // A persisted marker allows recovery if the final rename succeeded before the DB update.
    const marker = path.join(target, '.fde-assignment.json');
    try {
      const existing = JSON.parse(await fs.readFile(marker, 'utf8'));
      if (existing.id !== id || existing.package_id !== a.package_id || !a.repo_url) throw new Error('conflict');
      await client.query(`UPDATE project_assignments SET status='ready',last_error=NULL,updated_at=now() WHERE id=$1`, [id]);
      return { id, status: 'ready', repo_url: a.repo_url };
    } catch (e) { if (e.code !== 'ENOENT') throw new AdminError('project_directory_conflict', '项目目录已存在，拒绝覆盖', { httpStatus: 409 }); }
    try { await fs.lstat(target); throw new AdminError('project_directory_conflict', '项目目录已存在，拒绝覆盖', { httpStatus: 409 }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const credentialPath = path.join(root, a.fde_name, 'platform', 'git', 'credentials');
    assertSafePath(root, credentialPath);
    const base = new URL(a.base_url);
    const credentials = (await fs.readFile(credentialPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => new URL(line));
    const credential = credentials.find(c => c.host === base.host && decodeURIComponent(c.username) === a.remote_login);
    if (!credential?.password) throw new AdminError('git_not_ready', '用户 Git 凭据尚未就绪', { httpStatus: 409 });
    const authorization = `token ${decodeURIComponent(credential.password)}`;
    const api = async (method, url, body) => {
      const response = await fetchImpl(`${a.base_url.replace(/\/$/,'')}/api/v1${url}`, {
        method, headers: { Authorization: authorization, 'Content-Type':'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      if (response.status === 404 && method === 'GET') return null;
      if (!response.ok) throw new AdminError('git_delivery_failed', `创建用户仓库失败（HTTP ${response.status}）`, { httpStatus: 502 });
      return response.json();
    };
    const repoPath = `/repos/${encodeURIComponent(a.remote_login)}/${a.name}`;
    const description = `FDE Station assignment ${id}`;
    let repo = await api('GET', repoPath);
    if (!repo) repo = await api('POST', '/user/repos', { name:a.name, private:true, auto_init:false, description });
    if (repo.description !== description || repo.owner?.login !== a.remote_login || !repo.private) {
      throw new AdminError('git_repo_conflict', '已有同名仓库并非本次下发创建，拒绝接管', { httpStatus:409 });
    }
    const repoUrl = `${a.base_url.replace(/\/$/,'')}/${encodeURIComponent(a.remote_login)}/${a.name}.git`;
    await client.query(`UPDATE project_assignments SET repo_url=$2,status='pending',last_error=NULL,updated_at=now() WHERE id=$1`, [id,repoUrl]);
    const stagingRoot = path.join(root, a.fde_name, '.delivery-staging');
    assertSafePath(root, stagingRoot); await fs.mkdir(stagingRoot,{recursive:true,mode:0o700});
    const staging = await fs.mkdtemp(path.join(stagingRoot, `${id}-`));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0',
      GIT_CONFIG_COUNT:'3', GIT_CONFIG_KEY_0:'http.extraHeader', GIT_CONFIG_VALUE_0:`Authorization: Basic ${Buffer.from(`${a.remote_login}:${decodeURIComponent(credential.password)}`).toString('base64')}`,
      GIT_CONFIG_KEY_1:'core.hooksPath', GIT_CONFIG_VALUE_1:'/dev/null', GIT_CONFIG_KEY_2:'http.followRedirects',GIT_CONFIG_VALUE_2:'false' };
    const git = async args => { try { return await run('git', args, { cwd:staging, env, timeout:120000,maxBuffer:1024*1024 }); }
      catch { throw new AdminError('git_delivery_failed','项目 Git 初始化失败，可重试；详细凭据不会写入日志',{httpStatus:502}); } };
    try {
      await git(['init','-b','main']); await git(['remote','add','origin',repoUrl]);
      const refs = await git(['ls-remote','--heads','origin']);
      if (refs.stdout.trim()) {
        await git(['fetch','origin','main']); await git(['reset','--hard','FETCH_HEAD']);
      } else {
        for (const file of await readDeliveryPackage(a.archive)) {
          const destination = path.join(staging,file.name); assertSafePath(staging,destination);
          await fs.mkdir(path.dirname(destination),{recursive:true}); await fs.writeFile(destination,file.data,{flag:'wx',mode:0o660});
        }
        const agentFile = path.join(staging,'AGENTS.md');
        const intro = `\n\n## 本次下发项目\n\n按交付包中的需求、规范和验收标准开发。先阅读 README、开发文档和目录内的 AGENTS.md。\n${a.instructions}\n`;
        await fs.appendFile(agentFile,intro);
        await fs.writeFile(path.join(staging,'.fde-assignment.json'),JSON.stringify({id,package_id:a.package_id}));
        // The administrator explicitly delivers the complete archive. Preserve it
        // in the private repository even when a template .gitignore excludes it.
        await git(['add','--all','--force']); await git(['-c','user.name=FDE Station','-c','user.email=station@inteva.invalid','commit','-m','chore: 初始化管理员下发的开发交付包']);
        await git(['push','-u','origin','main']);
      }
      const recovered = JSON.parse(await fs.readFile(path.join(staging,'.fde-assignment.json'),'utf8'));
      if (recovered.id !== id) throw new AdminError('git_repo_conflict','仓库的下发标记不匹配',{httpStatus:409});
      // Transfer ownership before the single atomic publish into the user's workspace.
      const own = async dir => { for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
        const f = path.join(dir,entry.name); if (entry.isSymbolicLink()) throw new Error('symlink');
        if(entry.isDirectory()) await own(f);
        await fs.chown(f,config.workerUid??1002,config.fdeGid??1000); await fs.chmod(f,entry.isDirectory()?0o770:0o660);
      } };
      await own(staging); await fs.chown(staging,config.workerUid??1002,config.fdeGid??1000); await fs.chmod(staging,0o770);
      const active = await client.query("SELECT id FROM users WHERE id=$1 AND status='active'",[a.user_id]);
      if (!active.rows.length) throw new AdminError('user_disabled','用户已停用，下发暂停',{httpStatus:409});
      assertSafePath(root,target); await fs.rename(staging,target);
      await client.query(`UPDATE project_assignments SET status='ready',last_error=NULL,updated_at=now() WHERE id=$1`,[id]);
      return { id,status:'ready',repo_url:repoUrl };
    } finally { await fs.rm(staging,{recursive:true,force:true}); }
  } catch(e) {
    await client.query(`UPDATE project_assignments SET status='failed',last_error=$2,updated_at=now() WHERE id=$1 AND status<>'ready' AND deleted_at IS NULL`,
      [id,e instanceof AdminError?e.message:'下发失败，请重试或联系管理员']);
    throw e;
  } finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`assignment:${id}`]); client.release(); }
}
