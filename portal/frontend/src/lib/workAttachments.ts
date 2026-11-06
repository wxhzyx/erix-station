import { extractDocument, isDocument, rejectLegacyDocument } from './documentAttachments';
export interface WorkAttachment { kind: 'file'; path: string; name: string; text: string; warnings?: string[] }
export async function readWorkFiles(files: File[], existing: WorkAttachment[] = [], signal?: AbortSignal): Promise<WorkAttachment[]> {
  if (existing.length + files.length > 8) throw new Error('最多上传 8 个文件');
  const result = [...existing];
  for (const file of files) {
    signal?.throwIfAborted();
    rejectLegacyDocument(file.name);
    if (!isDocument(file.name) && file.size > 65536) throw new Error('单个文件不能超过 64 KiB');
    if (!file.name || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) throw new Error('文件名无效');
    if (isDocument(file.name)) {
      const extracted = await extractDocument(file, signal, 'work');
      result.push({ kind: 'file', path: `upload:${file.name}`, name: file.name, text: extracted.text, warnings: extracted.warnings });
      continue;
    }
    const buffer = await file.arrayBuffer();
    signal?.throwIfAborted();
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new Error('仅支持 UTF-8 文本或源代码文件'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(text)) throw new Error('仅支持 UTF-8 文本或源代码文件');
    result.push({ kind: 'file', path: `upload:${file.name}`, name: file.name, text });
  }
  if (result.reduce((sum, a) => sum + new TextEncoder().encode(a.text).length, 0) > 262144) throw new Error('文件合计不能超过 256 KiB');
  return result;
}
