// Scratch-only merge builder. No checkout, hooks, credential persistence, source
// branch mutation or project-directory writes. The target update uses an exact
// lease, while the candidate has both reviewed commits as parents (no rewrite).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const executeFile = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
export class ApprovalMergeError extends Error {
  constructor(code, message, httpStatus = 409) { super(message); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, message, status) => { throw new ApprovalMergeError(code, message, status); };

export async function mergeReviewedGit({ remoteUrl, sourceRef, targetRef, sourceSha, targetSha, token, username = 'x-access-token', beforePush, execute = executeFile } = {}) {
  let remote;
  try { remote = new URL(remoteUrl); } catch { fail('validation_failed', '仓库地址无效'); }
  if (!['https:', 'http:'].includes(remote.protocol) || remote.username || remote.password || remote.search || remote.hash || !SHA.test(sourceSha ?? '') || !SHA.test(targetSha ?? '') || typeof beforePush !== 'function') fail('validation_failed', '合并参数或持久化回调无效');
  // Defense in depth for callers other than approval-repository.js.
  // Match validateApprovalBranch: Unicode and internal dots are valid Git refs.
  // Arguments go directly to execFile; never interpolate them into a shell.
  for (const ref of [sourceRef, targetRef]) if (typeof ref !== 'string' || !ref || ref.length > 200 || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.includes('..') || ref.includes('@{') || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.lock'))) fail('validation_failed', '分支名称无效');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'station-approved-merge-'));
  await fs.chmod(tmp, 0o700);
  let pushing = false;
  try {
    const askpass = path.join(tmp, 'askpass');
    await fs.writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s" "$STATION_REVIEW_USERNAME" ;; *) printf "%s" "$STATION_REVIEW_TOKEN" ;; esac\n', { mode: 0o700 });
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass,
      STATION_REVIEW_TOKEN: token, STATION_REVIEW_USERNAME: username, GIT_AUTHOR_NAME: 'FDE Station approval', GIT_AUTHOR_EMAIL: 'approval@station.invalid',
      GIT_COMMITTER_NAME: 'FDE Station approval', GIT_COMMITTER_EMAIL: 'approval@station.invalid' };
    const gitDir = path.join(tmp, 'repo.git');
    const common = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'core.attributesFile=/dev/null'];
    const deadline = Date.now() + 120000;
    async function git(args, options = {}) {
      const timeout = Math.min(45000, deadline - Date.now());
      if (timeout <= 0) fail('merge_preparation_failed', '合并准备超时，请稍后重新检查');
      return execute('git', [...common, `--git-dir=${gitDir}`, ...args], { env, timeout, maxBuffer: 1024 * 1024, ...options });
    }
    await git(['init', '--bare', '--template=', gitDir]);
    await git(['remote', 'add', 'origin', remote.href]);
    // Bounded history: old/diverged branches beyond this range fail closed. No
    // automatic unbounded deepening, submodules, LFS, custom merge drivers/hooks.
    await git(['fetch', '--no-tags', '--depth=128', '--filter=blob:none', 'origin', `refs/heads/${sourceRef}:refs/review/source`, `refs/heads/${targetRef}:refs/review/target`]);
    const fetchedSource = (await git(['rev-parse', '--verify', 'refs/review/source'])).stdout.trim();
    const fetchedTarget = (await git(['rev-parse', '--verify', 'refs/review/target'])).stdout.trim();
    if (fetchedSource !== sourceSha || fetchedTarget !== targetSha) fail('review_stale', '分支已变化，请重新提交审批');
    let tree;
    try { tree = (await git(['merge-tree', '--write-tree', targetSha, sourceSha])).stdout.split('\n')[0].trim(); }
    catch { fail('merge_conflict', '分支存在冲突或历史不足，未执行合并'); }
    if (!SHA.test(tree)) fail('merge_preparation_failed', '无法构建安全的合并树');
    const candidate = (await git(['commit-tree', tree, '-p', targetSha, '-p', sourceSha, '-m', 'Merge reviewed project changes via FDE Station'])).stdout.trim();
    if (!SHA.test(candidate)) fail('merge_preparation_failed', '无法构建合并提交');
    await git(['merge-base', '--is-ancestor', targetSha, candidate]);
    await git(['merge-base', '--is-ancestor', sourceSha, candidate]);
    const heads = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${sourceRef}`, `refs/heads/${targetRef}`])).stdout;
    const refs = new Map(heads.trim().split('\n').map(line => line.split(/\s+/)).map(([sha, ref]) => [ref, sha]));
    if (refs.get(`refs/heads/${sourceRef}`) !== sourceSha || refs.get(`refs/heads/${targetRef}`) !== targetSha) fail('review_stale', '分支已变化，请重新提交审批');
    // The workflow records candidate BEFORE network mutation. If the response or
    // DB commit is lost, it can reconcile this exact SHA without a second push.
    await beforePush(candidate);
    pushing = true;
    try {
      await git(['push', '--porcelain', `--force-with-lease=refs/heads/${targetRef}:${targetSha}`, 'origin', `${candidate}:refs/heads/${targetRef}`]);
    } catch (error) {
      if (/\[rejected\]|\[remote rejected\]/.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)) fail('merge_rejected', '目标分支已变化或仓库保护规则拒绝合并，未覆盖远程历史');
      fail('merge_outcome_unknown', '合并结果暂时无法确认，请刷新核对；不要重复推送', 502);
    }
    const result = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${targetRef}`])).stdout.trim().split(/\s+/)[0];
    if (result !== candidate) fail('merge_outcome_unknown', '合并后目标版本已变化，需人工核对', 502);
    return { merged: true, merge_sha: candidate };
  } catch (error) {
    if (error instanceof ApprovalMergeError) throw error;
    fail(pushing ? 'merge_outcome_unknown' : 'merge_preparation_failed', pushing ? '合并结果暂时无法确认，请刷新核对；不要重复推送' : '合并准备失败，请检查凭据、权限、Git 版本和分支历史', pushing ? 502 : 409);
  } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
}
