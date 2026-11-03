import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApprovalRepository, parseApprovalRemote, validateApprovalBranch } from '../src/approval-repository.js';
const source = 'a'.repeat(40), target = 'b'.repeat(40);
const diff = 'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';
async function fixture(t, { provider = 'github', rawDiff = diff, remote = 'https://registered.invalid/owner/repo.git', status = 200 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'station-repo-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = path.join(root, 'alice/projects/demo/.git'); await fs.mkdir(git, { recursive: true });
  await fs.writeFile(path.join(git, 'config'), `[remote "origin"]\n url = ${remote}\n`);
  await fs.writeFile(path.join(git, 'HEAD'), 'ref: refs/heads/feature\n');
  await fs.mkdir(path.join(root, 'alice/platform/git'), { recursive: true });
  await fs.writeFile(path.join(root, 'alice/platform/git/credentials'), 'https://alice:synthetic-secret-token@registered.invalid\n');
  const host = { id: 'host-id', provider, base_url: 'https://registered.invalid' };
  const user = { id: 'user-id', fde_name: 'alice' };
  const pool = { async query(sql, args) {
    if (sql.includes('FROM users')) return { rows: args[0] === user.id ? [user] : [] };
    if (sql.includes('FROM git_hosts')) return { rows: [host] };
    throw new Error('Unexpected SQL');
  } };
  const calls = [];
  const adapter = createApprovalRepository({ pool, config: { userSpaceRoot: root }, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return new Response('upstream synthetic-secret-token', { status });
    if (url.includes('/branches/')) return new Response(JSON.stringify({ commit: { sha: url.endsWith('/feature') ? source : target } }));
    return new Response(rawDiff);
  } });
  const args = { userId: user.id, cwd: '~/projects/demo', git_host_id: host.id, repository: 'owner/repo', source_ref: 'feature', target_ref: 'main' };
  return { adapter, args, root, git, user, host, calls };
}
test('read-only origin identity resolved from jailed ordinary checkout, not request URL', async t => {
  const f = await fixture(t); const before = await fs.readdir(f.git);
  assert.deepEqual(await f.adapter.resolveRepository(f.user, f.args.cwd), { git_host_id: 'host-id', provider: 'github', repository: 'owner/repo', source_ref: 'feature', web_url: 'https://registered.invalid/owner/repo' });
  assert.deepEqual(await fs.readdir(f.git), before); assert.equal(f.calls.length, 0);
});
test('SHA-pinned diff and server-only token, no redirects', async t => {
  const f = await fixture(t); const result = await f.adapter.snapshot(f.args);
  assert.equal(result.source_sha, source); assert.equal(result.target_sha, target); assert.equal(result.diff, diff);
  assert.equal(result.diff_hash.length, 64);
  assert.ok(f.calls[2].url.endsWith(`/compare/${target}...${source}`));
  for (const call of f.calls) { assert.equal(call.init.redirect, 'manual'); assert.equal(call.init.method, 'GET'); assert.equal(call.init.headers.Authorization, 'Bearer synthetic-secret-token'); assert.ok(!call.url.includes('synthetic-secret-token')); }
  assert.ok(!JSON.stringify(result).includes('synthetic-secret-token'));
});
test('Gitea requests raw diff and rejects old servers returning JSON', async t => {
  const f = await fixture(t, { provider: 'gitea' }); await f.adapter.snapshot(f.args);
  assert.ok(f.calls[2].url.endsWith('?output=diff'));
  const old = await fixture(t, { provider: 'gitea', rawDiff: '{"commits":[]}' });
  await assert.rejects(old.adapter.snapshot(old.args), { code: 'diff_unavailable' });
});
test('unknown hosts, credential-bearing origins and path escapes never make network requests', async t => {
  for (const remote of ['https://evil.invalid/owner/repo', 'https://alice:secret@registered.invalid/owner/repo', 'https://registered.invalid/../../etc', 'ext::evil']) {
    const f = await fixture(t, { remote }); await assert.rejects(f.adapter.snapshot(f.args)); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t); await assert.rejects(f.adapter.resolveRepository(f.user, '~/projects/../demo')); assert.equal(f.calls.length, 0);
});
test('symlinked repo metadata fails closed without reading outside jail', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.git, 'config')); await fs.symlink('/etc/passwd', path.join(f.git, 'config'));
  await assert.rejects(f.adapter.resolveRepository(f.user, f.args.cwd)); assert.equal(f.calls.length, 0);
});
test('owner and requested repository identity are revalidated', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.snapshot({ ...f.args, userId: 'other' }), { code: 'not_found' });
  await assert.rejects(f.adapter.snapshot({ ...f.args, repository: 'other/repo' }), { code: 'repository_changed' });
  assert.equal(f.calls.length, 0);
});
test('raw API errors, redirects, binary or oversized diffs are not leaked/approved', async t => {
  const redirected = await fixture(t, { status: 302 });
  await assert.rejects(redirected.adapter.snapshot(redirected.args), err => err.code === 'git_upstream_failed' && !err.message.includes('synthetic-secret-token'));
  const binary = await fixture(t, { rawDiff: diff + 'Binary files a/image and b/image differ\n' });
  await assert.rejects(binary.adapter.snapshot(binary.args), { code: 'diff_unsupported' });
  const big = await fixture(t, { rawDiff: diff + 'x'.repeat(512 * 1024) });
  await assert.rejects(big.adapter.snapshot(big.args), { code: 'diff_too_large' });
});
test('readTarget supports uncertain merge reconciliation without a nonempty diff', async t => {
  const f = await fixture(t, { rawDiff: '' }); assert.deepEqual(await f.adapter.readTarget(f.args), { target_sha: target }); assert.equal(f.calls.length, 1);
});
test('remote and branch parser rejects command/ref injection', () => {
  assert.deepEqual(parseApprovalRemote('git@github.com:owner/repo.git'), { host: 'github.com', repository: 'owner/repo', protocol: 'ssh:' });
  for (const ref of ['-x', 'a..b', 'a@{x}', '../x', 'a.lock', 'x\nmain', 'x:y', 'a//b']) assert.throws(() => validateApprovalBranch(ref));
});
