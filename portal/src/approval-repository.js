// Repository approval boundary: only registered hosts, only owner credentials,
// no commands/config includes/hooks from the user's checkout are executed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateSessionCwd } from './sessions.js';
import { validateFdeName } from './projects.js';
import { assertSafePath } from './fsutil.js';
import { mergeReviewedGit } from './approval-git-merge.js';
import { getPlatformCredentialPath } from './git-credential.js';

export class ApprovalRepositoryError extends Error {
  constructor(code, message, { httpStatus = 400 } = {}) { super(message); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, message, status = 400) => { throw new ApprovalRepositoryError(code, message, { httpStatus: status }); };
const SHA = /^[a-f0-9]{40}$/;
const DIFF_LIMIT = 512 * 1024;
export function validateApprovalBranch(value) {
  if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('@{') || /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.split('/').some(s => !s || s.startsWith('.') || s.endsWith('.lock'))) fail('validation_failed', '分支名称无效');
  return value;
}
function readBoundedFile(root, target, max = 256 * 1024) {
  assertSafePath(root, target);
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) fail('repository_unavailable', '仓库元数据不可用或过大', 409);
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof ApprovalRepositoryError) throw error;
    fail('repository_unavailable', '仓库元数据或凭据文件不可用', 409);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function originFromConfig(text) {
  let origin = false; const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith('[')) { origin = /^\[remote\s+"origin"\]$/i.test(line); continue; }
    if (origin && /^url\s*=/i.test(line)) {
      let value = line.replace(/^url\s*=\s*/i, '').trim();
      if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { fail('repository_unavailable', 'origin URL 格式不支持', 409); } }
      values.push(value);
    }
  }
  if (values.length !== 1) fail('repository_unavailable', '需要一个明确配置的 origin 远程仓库', 409);
  return values[0];
}
export function parseApprovalRemote(value) {
  let url;
  const scp = /^git@([^/:]+):(.+)$/.exec(value);
  try { url = new URL(scp ? `ssh://git@${scp[1]}/${scp[2]}` : value); } catch { fail('repository_unavailable', '远程仓库 URL 格式不支持', 409); }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password || (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) || url.search || url.hash) fail('repository_unavailable', '远程 URL 不能含凭据或查询参数', 409);
  const pathname = url.pathname.replace(/\.git$/, '').replace(/^\//, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pathname) || pathname.split('/').some(p => p === '.' || p === '..')) fail('repository_unavailable', '仅支持 owner/repository 远程仓库', 409);
  return { host: url.host.toLowerCase(), repository: pathname, protocol: url.protocol };
}
function hostApi(host) {
  let base;
  try { base = new URL(host.base_url); } catch { fail('git_host_unavailable', 'Git 服务配置无效', 409); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) fail('git_host_unavailable', '审批仅支持根路径 Git 服务地址', 409);
  if (!['github', 'gitea'].includes(host.provider)) fail('provider_unsupported', '审批目前支持 GitHub 和 Gitea', 409);
  return host.provider === 'github' ? (base.host === 'github.com' ? 'https://api.github.com' : `${base.origin}/api/v3`) : `${base.origin}/api/v1`;
}
function ownerToken(config, user, host) {
  const { root, target } = getPlatformCredentialPath(config, user.fde_name);
  const data = readBoundedFile(root, target);
  const wanted = new URL(host.base_url);
  for (const line of data.split(/\r?\n/)) {
    let url;
    try { url = new URL(line); } catch { continue; }
    if (url.host.toLowerCase() !== wanted.host.toLowerCase() || url.protocol !== wanted.protocol) continue;
    let token; try { token = decodeURIComponent(url.password); } catch { continue; }
    let username; try { username = decodeURIComponent(url.username); } catch { continue; }
    if (token && token.length <= 4096 && !/[\x00-\x20\x7f]/.test(token) && username && !/[\x00-\x20\x7f]/.test(username)) return { token, username };
  }
  fail('git_credential_missing', '请先为此 Git 服务设置仓库凭据', 409);
}
export function createApprovalRepository({ pool, config, fetchImpl = fetch, executeGit } = {}) {
  async function resolveRepository(user, cwd) {
    if (config.collaborationConfigFile) {
      const shared = await pool.query('SELECT id FROM project_assignments WHERE user_id=$1 AND name=$2 AND collaboration_project_id IS NOT NULL',[user.id,cwd.replace(/^~\/projects\//,'')]);
      if(shared.rows.length) fail('shared_project','共享项目请使用项目协作中的 Gitea 合并请求',409);
    }
    if (!user?.id || !validateFdeName(user.fde_name).ok) fail('no_workstation', '此用户没有项目工作区', 409);
    const safeCwd = validateSessionCwd(cwd);
    const root = path.resolve(config.userSpaceRoot);
    const repoDir = path.join(root, user.fde_name, 'projects', safeCwd.slice('~/projects/'.length));
    assertSafePath(root, repoDir);
    const gitDir = path.join(repoDir, '.git');
    assertSafePath(root, gitDir);
    let st; try { st = fs.lstatSync(gitDir); } catch { fail('repository_unavailable', '目录不是 Git 仓库', 409); }
    if (!st.isDirectory() || st.isSymbolicLink()) fail('repository_unavailable', '审批需要普通 Git 工作区（不支持链接工作树）', 409);
    const remote = parseApprovalRemote(originFromConfig(readBoundedFile(root, path.join(gitDir, 'config'))));
    const head = readBoundedFile(root, path.join(gitDir, 'HEAD'), 1024).trim();
    if (!head.startsWith('ref: refs/heads/')) fail('repository_unavailable', '请先切换到本地分支', 409);
    const source_ref = validateApprovalBranch(head.slice('ref: refs/heads/'.length));
    const hosts = (await pool.query('SELECT id, provider, base_url FROM git_hosts WHERE enabled = true')).rows;
    const host = hosts.find(h => { try { return new URL(h.base_url).host.toLowerCase() === remote.host; } catch { return false; } });
    if (!host) fail('git_host_unavailable', 'origin 不属于已启用的 Git 服务', 409);
    hostApi(host);
    const web_url = `${new URL(host.base_url).origin}/${remote.repository}`;
    return { git_host_id: host.id, provider: host.provider, repository: remote.repository, source_ref, web_url };
  }
  async function context(args) {
    const user = (await pool.query("SELECT id, fde_name FROM users WHERE id = $1 AND status = 'active'", [args.userId])).rows[0];
    if (!user) fail('not_found', '项目所属用户不存在', 404);
    const identity = await resolveRepository(user, args.cwd);
    if (identity.git_host_id !== args.git_host_id || identity.repository !== args.repository) fail('repository_changed', '项目远程仓库已变化，请重新提交', 409);
    const host = (await pool.query('SELECT id, provider, base_url FROM git_hosts WHERE id = $1 AND enabled = true', [identity.git_host_id])).rows[0];
    if (!host) fail('git_host_unavailable', 'Git 服务已停用', 409);
    const base = hostApi(host);
    const { token, username } = ownerToken(config, user, host);
    return { identity, base, token, username, host };
  }
  async function request(ctx, suffix, { diff = false } = {}) {
    const controller = new AbortController(); let timer;
    const operation = (async () => {
      const response = await fetchImpl(`${ctx.base}/repos/${ctx.identity.repository.split('/').map(encodeURIComponent).join('/')}${suffix}`, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${ctx.token}`, Accept: diff && ctx.host.provider === 'github' ? 'application/vnd.github.diff' : 'application/json' },
      });
      if (!response.ok || response.status >= 300) fail('git_upstream_failed', 'Git 服务拒绝请求或返回重定向', 502);
      const chunks = []; let count = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try { while (true) { const item = await reader.read(); if (item.done) break; count += item.value.byteLength; if (count > DIFF_LIMIT) { controller.abort(); void reader.cancel().catch(() => {}); fail('diff_too_large', '变更过大，请拆分审批（最多 512 KiB）', 409); } chunks.push(Buffer.from(item.value)); } }
        finally { reader.releaseLock(); }
      } else { const text = await response.text(); if (Buffer.byteLength(text) > DIFF_LIMIT) fail('diff_too_large', '变更过大，请拆分审批（最多 512 KiB）', 409); chunks.push(Buffer.from(text)); }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.includes(ctx.token)) fail('git_upstream_failed', 'Git 服务返回敏感内容，已拒绝', 502);
      if (diff) return raw;
      try { return JSON.parse(raw); } catch { fail('git_upstream_failed', 'Git 服务返回无效数据', 502); }
    })();
    operation.catch(() => {});
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ApprovalRepositoryError('git_upstream_failed', 'Git 服务请求超时', { httpStatus: 502 })); }, 15000); })]); }
    catch (error) { if (error instanceof ApprovalRepositoryError) throw error; fail('git_upstream_failed', 'Git 服务请求失败', 502); }
    finally { clearTimeout(timer); }
  }
  async function snapshot(args) {
    validateApprovalBranch(args.source_ref); validateApprovalBranch(args.target_ref);
    if (args.source_ref === args.target_ref) fail('validation_failed', '来源与目标分支不能相同');
    const ctx = await context(args);
    const source = await request(ctx, `/branches/${encodeURIComponent(args.source_ref)}`);
    const target = await request(ctx, `/branches/${encodeURIComponent(args.target_ref)}`);
    const source_sha = source.commit?.sha ?? source.commit?.id;
    const target_sha = target.commit?.sha ?? target.commit?.id;
    if (!SHA.test(source_sha ?? '') || !SHA.test(target_sha ?? '')) fail('git_upstream_failed', 'Git 服务未返回有效分支版本', 502);
    if (source_sha === target_sha) fail('no_changes', '来源与目标分支没有变更', 409);
    const diff = await request(ctx, `/compare/${target_sha}...${source_sha}${ctx.host.provider === 'gitea' ? '?output=diff' : ''}`, { diff: true });
    if (!diff.startsWith('diff --git ')) fail('diff_unavailable', '服务未返回完整差异；旧版 Gitea 可能不支持 raw compare diff', 409);
    if (/^Binary files |^GIT binary patch/m.test(diff)) fail('diff_unsupported', '二进制变更需要人工检查，不能使用自动审批', 409);
    return { source_sha, target_sha, diff, diff_hash: createHash('sha256').update(diff).digest('hex'), web_url: `${ctx.identity.web_url}/compare/${target_sha}...${source_sha}` };
  }
  async function readTarget(args) {
    validateApprovalBranch(args.target_ref);
    const ctx = await context(args);
    const target = await request(ctx, `/branches/${encodeURIComponent(args.target_ref)}`);
    const target_sha = target.commit?.sha ?? target.commit?.id;
    if (!SHA.test(target_sha ?? '')) fail('git_upstream_failed', 'Git 服务未返回有效目标版本', 502);
    return { target_sha };
  }
  async function merge(args) {
    validateApprovalBranch(args.source_ref); validateApprovalBranch(args.target_ref);
    const ctx = await context(args);
    const result = await mergeReviewedGit({ remoteUrl: `${new URL(ctx.host.base_url).origin}/${ctx.identity.repository}.git`, sourceRef: args.source_ref, targetRef: args.target_ref, sourceSha: args.source_sha, targetSha: args.target_sha, token: ctx.token, username: ctx.username, beforePush: args.beforePush, execute: executeGit });
    return { ...result, web_url: `${ctx.identity.web_url}/commit/${result.merge_sha}` };
  }
  return { resolveRepository, snapshot, readTarget, merge };
}
