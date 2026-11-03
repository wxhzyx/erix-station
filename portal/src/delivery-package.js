import yauzl from 'yauzl';
import { AdminError } from './admin.js';

export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED = 150 * 1024 * 1024;
export function validatePackagePath(name) {
  const parts = name.replace(/\/$/, '').split('/');
  if (!name || name.length > 500 || /[\\:\x00-\x1f\x7f]/.test(name)
    || parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new AdminError('invalid_package', '交付包含非法路径或 .git 目录');
  }
  return parts.join('/');
}

/** Bounded, sequential ZIP decoding. No archive paths are ever executed. */
export async function readDeliveryPackage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_PACKAGE_BYTES) {
    throw new AdminError('invalid_package', '请上传不超过 50 MB 的 ZIP 开发交付包');
  }
  let zip;
  try {
    zip = await new Promise((resolve, reject) => yauzl.fromBuffer(buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (e, z) => e ? reject(e) : resolve(z)));
    const files = []; const names = new Set(); let size = 0; let entries = 0;
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', async entry => {
        try {
          const name = validatePackagePath(entry.fileName);
          if (++entries > 2000) throw new Error('too many entries');
          const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (kind && kind !== 0o100000 && kind !== 0o040000) throw new Error('special file');
          if (entry.isEncrypted()) throw new Error('encrypted archive');
          if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
          if (names.has(name.toLowerCase())) throw new Error('duplicate path');
          names.add(name.toLowerCase()); size += entry.uncompressedSize;
          if (size > MAX_EXPANDED || entry.uncompressedSize > MAX_PACKAGE_BYTES) throw new Error('expanded limit');
          const stream = await new Promise((ok, no) => zip.openReadStream(entry, (e, s) => e ? no(e) : ok(s)));
          const chunks = []; let actual = 0;
          for await (const chunk of stream) {
            actual += chunk.length;
            if (actual > entry.uncompressedSize || actual > MAX_PACKAGE_BYTES) { stream.destroy(); throw new Error('size mismatch'); }
            chunks.push(chunk);
          }
          files.push({ name, data: Buffer.concat(chunks) }); zip.readEntry();
        } catch (e) { zip.close(); reject(e); }
      });
      zip.readEntry();
    });
    if (!files.length) throw new Error('empty');
    // A common ZIP wrapper folder is packaging, not part of the project layout.
    const top = files[0].name.split('/')[0];
    if (files.every(f => f.name.startsWith(`${top}/`))) {
      for (const file of files) file.name = file.name.slice(top.length + 1);
    }
    return files;
  } catch (e) {
    if (e instanceof AdminError) throw e;
    throw new AdminError('invalid_package', 'ZIP 无效，或包含重复路径、加密/链接文件、过多文件或超大解压内容');
  } finally { zip?.close(); }
}
