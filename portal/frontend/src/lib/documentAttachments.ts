import { api } from '../api';

export const DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx'];
export const isDocument = (name: string) => DOCUMENT_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '');
export function rejectLegacyDocument(name: string) {
  if (/\.(doc|xls|ppt)$/i.test(name)) throw new Error('旧版 Office 文件请先转换为 DOCX、XLSX 或 PPTX / Convert legacy Office files first.');
}
export function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('文件读取失败 / Unable to read file'));
    reader.readAsDataURL(file);
  });
}
export async function extractDocument(file: File, signal?: AbortSignal): Promise<{ name: string; text: string; warnings: string[] }> {
  if (file.size > DOCUMENT_MAX_BYTES) throw new Error('文档单个最多 8 MiB / Maximum document size: 8 MiB');
  signal?.throwIfAborted();
  const data_base64 = await readBase64(file);
  // A completed file read must not send the previous user's data under a new login.
  signal?.throwIfAborted();
  const result = await api<{ name: string; text: string; warnings: string[] }>('/api/attachments/extract', {
    method: 'POST', signal, body: JSON.stringify({ name: file.name, data_base64 }),
  });
  signal?.throwIfAborted();
  if (typeof result.text !== 'string' || new TextEncoder().encode(result.text).length > 65536 || !Array.isArray(result.warnings)) throw new Error('文档解析响应无效 / Invalid extraction response');
  return result;
}
