import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { failure, loadCollaborationConfig, segment } from './collaboration-gitea.js';
import { readDeliveryPackage, MAX_PACKAGE_BYTES } from './delivery-package.js';
import { validateDeliveryTarget } from './delivery-target.js';

export const MAX_BUILD_BYTES = 512 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const buildArtifactPath = (root, id) => {
  if (!UUID.test(id)) throw failure('not_found', '构建不存在', 404);
  return path.join(root, 'project-builds', `${id}.bin`);
};
const PUBLIC = 'id,project_id,requester_id,branch,source_sha,status,log,error,artifact_name,artifact_size,artifact_sha256,created_at,started_at,finished_at';

export async function reconcileBuilds(pool) {
  await pool.query(`UPDATE project_builds b SET status='cancelled',error='项目或成员已停用',finished_at=now(),lease_hash=NULL
    WHERE status IN ('queued','running') AND NOT EXISTS (
      SELECT 1 FROM collaboration_projects p JOIN project_memberships m ON m.project_id=p.id JOIN users u ON u.id=m.user_id
      WHERE p.id=b.project_id AND p.state='active' AND m.user_id=b.requester_id AND m.state='active'
        AND u.status='active' AND u.deleted_at IS NULL)`);
  await pool.query(`UPDATE project_builds SET status='failed',error='构建进程中断，请重新生成',finished_at=now(),lease_hash=NULL
    WHERE status='running' AND lease_expires_at<now()`);
}

export async function requestBuild(db, { project, member, user, api, repo }) {
  if (project.state !== 'active' || member?.state !== 'active') throw failure('forbidden', '只有项目的有效成员可以生成测试版', 403);
  const target = validateDeliveryTarget(project.delivery_target);
  if (target.type !== 'desktop') throw failure('not_desktop', '网页项目请使用在线预览');
  const commit = await api('GET', `${repo}/branches/${segment(member.branch)}`);
  const sha = commit?.commit?.id;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw failure('invalid_commit', '个人分支尚未推送有效版本');
  const result = await db.query(`INSERT INTO project_builds(id,project_id,requester_id,branch,source_sha,delivery_target)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,requester_id) WHERE status IN ('queued','running') DO NOTHING
    RETURNING ${PUBLIC}`, [crypto.randomUUID(), project.id, user.id, member.branch, sha, JSON.stringify(target)]);
  if (!result.rows.length) throw failure('build_in_progress', '当前测试版正在生成');
  await db.query(`INSERT INTO audit_log(actor_id,action,target,details) VALUES($1,'project_build.requested',$2,$3)`,
    [user.id, project.id, JSON.stringify({ build_id: result.rows[0].id, branch: member.branch, sha })]);
  return result.rows[0];
}

export async function listBuilds(db, projectId) {
  return { builds: (await db.query(`SELECT ${PUBLIC} FROM project_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100`, [projectId])).rows };
}

// A container may execute only its own user's builds. Tokens never enter build subprocesses.
export async function claimBuild(pool, userId) {
  await pool.query(`UPDATE project_builds SET status='failed',error='构建进程中断，请重新生成',finished_at=now(),lease_hash=NULL
    WHERE requester_id=$1 AND status='running' AND lease_expires_at<now()`, [userId]);
  await pool.query(`UPDATE project_builds b SET status='cancelled',error='项目或成员已停用',finished_at=now()
    WHERE requester_id=$1 AND status='queued' AND NOT EXISTS (
      SELECT 1 FROM collaboration_projects p JOIN project_memberships m ON m.project_id=p.id
      WHERE p.id=b.project_id AND p.state='active' AND m.user_id=b.requester_id AND m.state='active')`, [userId]);
  const token = crypto.randomBytes(32).toString('hex');
  const result = await pool.query(`UPDATE project_builds b SET status='running',lease_hash=$2,
    lease_expires_at=now()+interval '90 seconds',started_at=now()
    WHERE b.id=(SELECT id FROM project_builds WHERE requester_id=$1 AND status='queued'
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,project_id,source_sha,delivery_target`, [userId, digest(token)]);
  return result.rows[0] ? { ...result.rows[0], lease: token } : null;
}

export async function leasedBuild(pool, userId, id, token) {
  if (!UUID.test(id) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw failure('build_lease_lost', '构建租约已失效');
  const row = (await pool.query(`SELECT b.*,p.repo_name FROM project_builds b
    JOIN collaboration_projects p ON p.id=b.project_id JOIN project_memberships m ON m.project_id=p.id AND m.user_id=b.requester_id
    WHERE b.id=$1 AND b.requester_id=$2 AND b.status='running' AND b.lease_hash=$3 AND b.lease_expires_at>now()
      AND p.state='active' AND m.state='active'`, [id, userId, digest(token)])).rows[0];
  if (!row) throw failure('build_lease_lost', '构建租约已失效');
  return row;
}

export async function buildSource(pool, config, userId, id, token, fetchImpl = fetch) {
  const job = await leasedBuild(pool, userId, id, token), c = await loadCollaborationConfig(config);
  const response = await fetchImpl(`${c.baseUrl}/api/v1/repos/${segment(c.organization)}/${segment(job.repo_name)}/archive/${job.source_sha}.zip`,
    { headers: { Authorization: `token ${c.token}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw failure('build_source_unavailable', '无法读取本次提交的源码', 502);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_PACKAGE_BYTES) throw failure('build_source_too_large', '源码归档超过 50 MB');
    chunks.push(chunk);
  }
  const files = await readDeliveryPackage(Buffer.concat(chunks));
  // Same bounded archive rules as delivery packages: no links, traversal or .git credentials.
  return { files: files.map(f => ({ name: f.name, data: f.data.toString('base64') })) };
}

export async function updateBuild(pool, userId, id, token, body) {
  await leasedBuild(pool, userId, id, token);
  const log = typeof body.log === 'string' ? body.log.slice(-32000).replace(/\x1b\[[0-9;]*m/g, '') : '';
  const failed = body.failed === true;
  const row = (await pool.query(`UPDATE project_builds SET log=$4,lease_expires_at=now()+interval '90 seconds',
    status=CASE WHEN $5 THEN 'failed' ELSE status END,error=CASE WHEN $5 THEN '编译失败，请查看构建日志' ELSE NULL END,
    finished_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1 AND requester_id=$2 AND lease_hash=$3 AND status='running' RETURNING id`,
    [id, userId, digest(token), log, failed])).rows[0];
  if (!row) throw failure('build_lease_lost', '构建租约已失效');
  return { ok: true };
}

export async function saveBuildArtifact(pool, config, userId, id, token, stream) {
  const job = await leasedBuild(pool, userId, id, token);
  const dest = buildArtifactPath(config.artifactsRoot, id), tmp = `${dest}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let handle, size = 0; const hash = crypto.createHash('sha256');
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > MAX_BUILD_BYTES) throw failure('artifact_too_large', '测试版超过 512 MB', 413);
      hash.update(chunk); await handle.writeFile(chunk);
    }
    await handle.close(); handle = null;
    if (!size) throw failure('artifact_empty', '没有生成可下载的程序', 400);
    await leasedBuild(pool, userId, id, token);
    // Exclusive link: retries never overwrite an already published binary.
    await fs.link(tmp, dest);
    const row = (await pool.query(`UPDATE project_builds SET status='succeeded',finished_at=now(),lease_hash=NULL,
      artifact_name=$4,artifact_size=$5,artifact_sha256=$6 WHERE id=$1 AND requester_id=$2 AND lease_hash=$3 AND status='running' RETURNING id`,
      [id, userId, digest(token), path.posix.basename(job.delivery_target.build.output), size, hash.digest('hex')])).rows[0];
    if (!row) { await fs.unlink(dest); throw failure('build_lease_lost', '构建租约已失效'); }
    return { ok: true };
  } finally { await handle?.close(); await fs.unlink(tmp).catch(() => {}); }
}

export async function downloadableBuild(pool, config, user, id) {
  if (!UUID.test(id)) throw failure('not_found', '测试版不存在', 404);
  const row = (await pool.query(`SELECT b.* FROM project_builds b JOIN collaboration_projects p ON p.id=b.project_id
    WHERE b.id=$1 AND b.status='succeeded' AND ($3::boolean OR (p.state='active' AND EXISTS (
      SELECT 1 FROM project_memberships m WHERE m.project_id=p.id AND m.user_id=$2 AND m.state='active')))`,
    [id, user.id, user.role === 'admin'])).rows[0];
  if (!row) throw failure('not_found', '测试版不存在或没有下载权限', 404);
  return { row, filePath: buildArtifactPath(config.artifactsRoot, id) };
}
