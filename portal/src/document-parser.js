import { ATTACHMENT_LIMITS } from './attachment-limits.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DOCUMENT_LIMITS = Object.freeze({ inputBytes: ATTACHMENT_LIMITS.fileBytes, textBytes: ATTACHMENT_LIMITS.fileBytes,
  entries: 2048, entryBytes: 16 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024,
  pages: 200, sheets: 50, slides: 200, cells: 100000, timeoutMs: 15000, workers: 2, addressSpaceBytes: 1024 * 1024 * 1024,
  imageCount: 5, imageBytes: 1024 * 1024, imagePixels: 16000000, imageSide: 1600 });
export function documentError(code, message, status = 422) {
  return Object.assign(new Error(message), { code: `document_${code}`, status });
}
let active = 0;
/** No disk persistence, credentials, URLs, or user-controlled paths enter the child process. */
export async function parseDocument({ name, data } = {}) {
  if (typeof name !== 'string' || !name || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name))
    throw documentError('name', '文件名无效', 400);
  const ext = name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx', 'xlsx', 'pptx'].includes(ext))
    throw documentError('unsupported', '仅支持 PDF、DOCX、XLSX、PPTX；旧版 DOC/XLS/PPT 请先另存为新版格式，宏文件不支持', 415);
  if (typeof data !== 'string' || data.length > Math.ceil(DOCUMENT_LIMITS.inputBytes / 3) * 4)
    throw documentError('size', '文档大小超限（最大 10 MiB）', 413);
  if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw documentError('encoding', '文档编码无效或文件为空', 400);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > DOCUMENT_LIMITS.inputBytes) throw documentError('size', '文档大小超限（最大 10 MiB）', 413);
  if (bytes.toString('base64') !== data) throw documentError('encoding', '文档编码无效', 400);
  if (active >= DOCUMENT_LIMITS.workers) throw documentError('busy', '文档解析繁忙，请稍后重试', 429);
  active++;
  try {
    return await runDocumentProcess({ name, data, ext });
  } finally { active--; }
}

// Internal process harness. Request handlers call only parseDocument; test options
// are never read from uploads. Used to prove kill/resource-error cleanup.
export function runDocumentProcess({ name, data, ext }, {
  scriptPath = fileURLToPath(new URL('./document-parser-worker.js', import.meta.url)),
  timeoutMs = DOCUMENT_LIMITS.timeoutMs,
} = {}) {
  return new Promise((resolve, reject) => {
      // Linux prlimit applies to the child before it reads any document. JIT-less
      // Node avoids multi-GiB executable reservations; AS caps native/ArrayBuffers too.
      // Fail closed if the limiter is absent; never fall back to an unbounded worker.
      const child = spawn('/usr/bin/prlimit', [
        `--as=${DOCUMENT_LIMITS.addressSpaceBytes}`, '--cpu=15', '--core=0', '--fsize=0', '--',
        process.execPath, '--jitless',
        ...(process.allowedNodeEnvironmentFlags.has('--no-experimental-fetch') ? ['--no-experimental-fetch'] : []), '--max-old-space-size=256', '--max-semi-space-size=16',
        scriptPath,
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production', MALLOC_ARENA_MAX: '2', UV_THREADPOOL_SIZE: '1', RAYON_NUM_THREADS: '1', DISABLE_SYSTEM_FONTS_LOAD: '1' } });
      child.stderr.resume(); // Do not log document contents or native diagnostics.
      let settled = false; let outputBytes = 0; const chunks = [];
      let failure;
      const kill = error => { failure ??= error; child.kill('SIGKILL'); };
      const timer = setTimeout(() => kill(documentError('timeout', '文档解析超时，请拆分文件后重试')), timeoutMs);
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > 2 * DOCUMENT_LIMITS.textBytes + DOCUMENT_LIMITS.imageCount * Math.ceil(DOCUMENT_LIMITS.imageBytes / 3) * 4 + 65536) kill(documentError('failed', '文档解析输出超限'));
        else chunks.push(chunk);
      });
      child.stdin.on('error', () => {}); // Early resource exits can close stdin (EPIPE).
      child.once('error', () => { failure ??= documentError('unavailable', '文档解析器不可用；需要 Linux prlimit（util-linux）', 503); });
      child.once('close', code => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (failure) return reject(failure);
        if (code !== 0) return reject(documentError('failed', '文档损坏、过于复杂或解析资源超限'));
        try {
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (message.error) reject(documentError(message.error.code, message.error.message, message.error.status));
          else if (typeof message.result?.text === 'string' && Buffer.byteLength(message.result.text) <= DOCUMENT_LIMITS.textBytes && Array.isArray(message.result.warnings)
            && (message.result.images === undefined || (Array.isArray(message.result.images) && message.result.images.length <= DOCUMENT_LIMITS.imageCount
              && message.result.images.every(image => image.mime_type === 'image/jpeg' && typeof image.data_base64 === 'string'
                && image.data_base64.length <= Math.ceil(DOCUMENT_LIMITS.imageBytes / 3) * 4 && typeof image.label === 'string'))))
            resolve({ name, ...message.result });
          else reject(documentError('failed', '文档解析结果无效'));
        } catch { reject(documentError('failed', '文档解析结果无效')); }
      });
      child.stdin.end(JSON.stringify({ data, ext }));
    });
}
