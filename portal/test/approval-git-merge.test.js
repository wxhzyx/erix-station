import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateApprovalBranch } from '../src/approval-repository.js';
import { mergeReviewedGit } from '../src/approval-git-merge.js';
const exec = promisify(execFile);
async function fixture(t, conflict = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'station-merge-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'); const remote = path.join(root, 'remote.git');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = async (...args) => (await exec('git', ['-C', work, ...args], { env })).stdout.trim();
  await fs.mkdir(work); await git('init', '-b', 'main');
  await fs.writeFile(path.join(work, 'base.txt'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'base');
  await git('checkout', '-b', 'feature');
  await fs.writeFile(path.join(work, conflict ? 'base.txt' : 'feature.txt'), 'feature\n'); await git('add', '.'); await git('commit', '-m', 'feature');
  const sourceSha = await git('rev-parse', 'HEAD');
  await git('checkout', 'main');
  await fs.writeFile(path.join(work, conflict ? 'base.txt' : 'main.txt'), 'main\n'); await git('add', '.'); await git('commit', '-m', 'main');
  const targetSha = await git('rev-parse', 'HEAD');
  await exec('git', ['clone', '--bare', work, remote], { env });
  const calls = [];
  const execute = async (cmd, args, opts) => {
    calls.push([...args]);
    const synthetic = args.map(arg => arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg === 'https://registered.invalid/owner/repo.git' ? remote : arg);
    return exec(cmd, synthetic, opts);
  };
  const args = { remoteUrl: 'https://registered.invalid/owner/repo.git', sourceRef: 'feature', targetRef: 'main', sourceSha, targetSha, token: 'synthetic-test-secret', execute };
  const target = async () => (await exec('git', [`--git-dir=${remote}`, 'rev-parse', 'refs/heads/main'], { env })).stdout.trim();
  return { args, calls, root, work, remote, env, git, target };
}
test('merges exact reviewed commits in scratch repo with durable checkpoint and target CAS', async t => {
  const f = await fixture(t); let checkpoint;
  const result = await mergeReviewedGit({ ...f.args, beforePush: async sha => { checkpoint = sha; assert.equal(await f.target(), f.args.targetSha); } });
  assert.equal(result.merged, true); assert.equal(await f.target(), checkpoint); assert.equal(result.merge_sha, checkpoint);
  const parents = (await exec('git', [`--git-dir=${f.remote}`, 'show', '-s', '--format=%P', checkpoint], { env: f.env })).stdout.trim().split(' ');
  assert.deepEqual(parents, [f.args.targetSha, f.args.sourceSha]);
  assert.ok(f.calls.some(args => args.includes(`--force-with-lease=refs/heads/main:${f.args.targetSha}`)));
  assert.ok(f.calls.every(args => !args.join(' ').includes(f.args.token)));
  assert.equal(await f.git('rev-parse', 'HEAD'), f.args.targetSha, 'user checkout untouched');
});
test('conflicts fail before checkpoint or remote mutation', async t => {
  const f = await fixture(t, true); let checkpoint = false;
  await assert.rejects(mergeReviewedGit({ ...f.args, beforePush: async () => { checkpoint = true; } }), { code: 'merge_conflict' });
  assert.equal(checkpoint, false); assert.equal(await f.target(), f.args.targetSha);
});
test('source/target changed since review fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(mergeReviewedGit({ ...f.args, sourceSha: '1'.repeat(40), beforePush: async () => {} }), { code: 'review_stale' });
  assert.equal(await f.target(), f.args.targetSha);
});
test('failed durable checkpoint cannot push', async t => {
  const f = await fixture(t);
  await assert.rejects(mergeReviewedGit({ ...f.args, beforePush: async () => { throw new Error('database unavailable'); } }), { code: 'merge_preparation_failed' });
  assert.equal(f.calls.some(args => args.includes('push')), false); assert.equal(await f.target(), f.args.targetSha);
});
test('target race after checkpoint is rejected by exact lease without rewriting history', async t => {
  const f = await fixture(t); let raced;
  await assert.rejects(mergeReviewedGit({ ...f.args, beforePush: async () => {
    await fs.writeFile(path.join(f.work, 'raced.txt'), 'raced'); await f.git('add', '.'); await f.git('commit', '-m', 'raced'); raced = await f.git('rev-parse', 'HEAD');
    await f.git('push', f.remote, 'main');
  } }), { code: 'merge_rejected' });
  assert.equal(await f.target(), raced);
});
test('ambiguous push failure is classified unknown, never auto-retried', async t => {
  const f = await fixture(t); let attempts = 0;
  await assert.rejects(mergeReviewedGit({ ...f.args, beforePush: async () => {}, execute: async (cmd, args, opts) => {
    if (args.includes('push')) { attempts++; throw new Error(`network ${f.args.token}`); }
    return f.args.execute(cmd, args, opts);
  } }), error => error.code === 'merge_outcome_unknown' && !error.message.includes(f.args.token));
  assert.equal(attempts, 1);
});

test('Unicode and internal-dot branches pass both validators and merge safely', async t => {
  const f = await fixture(t);
  const sourceRef = 'feature/修复.v1', targetRef = 'release/生产.v2';
  validateApprovalBranch(sourceRef); validateApprovalBranch(targetRef);
  await exec('git', [`--git-dir=${f.remote}`, 'branch', '-m', 'feature', sourceRef], { env: f.env });
  await exec('git', [`--git-dir=${f.remote}`, 'branch', '-m', 'main', targetRef], { env: f.env });
  const result = await mergeReviewedGit({ ...f.args, sourceRef, targetRef, beforePush: async () => {} });
  const actual = (await exec('git', [`--git-dir=${f.remote}`, 'rev-parse', `refs/heads/${targetRef}`], { env: f.env })).stdout.trim();
  assert.equal(actual, result.merge_sha);
});
test('both validation layers reject dangerous ref syntax before running Git', async () => {
  const invalid = ['', '-bad', '/bad', 'bad/', 'bad.', 'bad..ref', 'bad@{ref}', 'a/.hidden', 'a/b.lock', 'a//b', 'a:b', 'a?b', 'a*b', 'a[b', 'a~b', 'a^b', 'a\\b', 'a b', 'a\nb'];
  for (const ref of invalid) {
    assert.throws(() => validateApprovalBranch(ref), { code: 'validation_failed' });
    let ran = false;
    await assert.rejects(mergeReviewedGit({ remoteUrl: 'https://registered.invalid/owner/repo.git', sourceRef: ref, targetRef: 'main', sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), beforePush: async () => {}, execute: async () => { ran = true; } }), { code: 'validation_failed' });
    assert.equal(ran, false);
  }
});
