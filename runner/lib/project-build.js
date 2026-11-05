import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_BYTES = 512 * 1024 * 1024;
export function sourcePath(root, name) {
  if (typeof name !== 'string' || /[\\:\x00-\x1f\x7f]/.test(name)
    || name.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new Error('Invalid source path');
  return path.join(root, ...name.split('/'));
}
export function buildEnvironment(home) {
  // Explicit allowlist: never inherit station token, cloud/API credentials or host build secrets.
  return { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: home,
    LANG: 'C.UTF-8', CI: 'true', FDE_TEST_BUILD: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
}
export async function readBuildOutput(root, directory, output) {
  sourcePath(root, output); if (directory !== '.') sourcePath(root, directory);
  const parts = [...(directory === '.' ? [] : directory.split('/')), ...output.split('/')];
  const dirs = []; let handle;
  try {
    // Pin every directory FD with O_NOFOLLOW; realpath-then-open alone races an untrusted build.
    dirs.push(await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of parts.slice(0, -1)) dirs.push(await fs.open(`/proc/self/fd/${dirs.at(-1).fd}/${part}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    handle = await fs.open(`/proc/self/fd/${dirs.at(-1).fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > MAX_BYTES) throw new Error('Build output missing or exceeds 512 MB');
    // Bound actual reads too, in case a surviving untrusted descendant grows the file.
    const chunks = []; let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length; if (total > MAX_BYTES) throw new Error('Build output exceeds 512 MB'); chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await handle?.close(); for (const dir of dirs.reverse()) await dir.close(); }
}

/** Deterministic pipeline in the existing FDE trust boundary, separate from AI runs and live project files. */
export async function executeProjectBuild(job, { request, uid, gid, shouldStop = () => false }) {
  const headers = { 'X-Build-Lease': job.lease }, endpoint = `/project-builds/${job.id}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fde-test-build-'));
  let child, log = '', timer, timeout, checking = false, leaseLost = false;
  const kill = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  const addLog = text => { log = (log + text).slice(-32000); };
  const status = failed => request('POST', `${endpoint}/status`, { headers, body: { log, failed } });
  try {
    // Fetch immutable source through agentd; the subprocess never sees the container token or lease.
    const source = (await request('GET', `${endpoint}/source`, { headers, timeoutMs: 65000 })).data;
    for (const file of source.files) {
      const dest = sourcePath(root, file.name);
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o770 });
      await fs.writeFile(dest, Buffer.from(file.data, 'base64'), { mode: 0o660, flag: 'wx' });
    }
    const spec = job.delivery_target.build, cwd = spec.directory === '.' ? root : sourcePath(root, spec.directory);
    if (shouldStop()) throw new Error('Build interrupted');
    await status(false);
    await fs.chmod(root, 0o770); // Keep extraction private until all trusted writes are complete.
    child = spawn('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', spec.command],
      { cwd, uid, gid, env: buildEnvironment(root), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => addLog(d.toString())); child.stderr.on('data', d => addLog(d.toString()));
    let interrupt;
    const finished = new Promise((resolve, reject) => { interrupt = reject; child.once('error', reject); child.once('close', resolve); });
    timeout = setTimeout(() => { addLog('\n构建超时\n'); leaseLost = true; kill(); interrupt(new Error('Build timeout')); }, spec.timeout_seconds * 1000);
    timer = setInterval(async () => {
      if (shouldStop()) { leaseLost = true; kill(); interrupt(new Error('Build interrupted')); return; }
      if (checking) return; checking = true;
      try { await status(false); } catch { leaseLost = true; kill(); interrupt(new Error('Build lease lost')); } finally { checking = false; }
    }, 15000);
    const code = await finished;
    clearInterval(timer); clearTimeout(timeout); kill();
    if (code !== 0 || leaseLost) throw new Error(`Build exited: ${code}`);
    const binary = await readBuildOutput(root, spec.directory, spec.output);
    await status(false);
    await request('PUT', `${endpoint}/artifact`, { headers, body: binary, timeoutMs: 120000 });
  } catch (err) {
    addLog(`\n${err.message}\n`);
    await status(true).catch(() => {}); // Lost/revoked lease is settled by server expiry, never by forged success.
  } finally {
    clearInterval(timer); clearTimeout(timeout); kill();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
