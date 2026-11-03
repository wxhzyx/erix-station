import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { readWorkFiles } from './workAttachments';
vi.mock('../api', () => ({ api: vi.fn() }));
afterEach(() => vi.mocked(api).mockReset());
it.each(['pdf', 'docx', 'xlsx', 'pptx'])('work %s extraction preserves text, filename and warnings', async ext => {
  vi.mocked(api).mockResolvedValue({ text: 'synthetic extracted data', warnings: ['layout warning'] });
  const files = await readWorkFiles([new File(['synthetic'], `report.${ext}`)]);
  expect(files[0]).toEqual({ kind:'file',path:`upload:report.${ext}`,name:`report.${ext}`,text:'synthetic extracted data',warnings:['layout warning'] });
  expect(vi.mocked(api).mock.calls[0]?.[0]).toBe('/api/attachments/extract');
});
it('cancels before dispatch after a file read when the owner changes', async () => {
  const controller = new AbortController();
  const pending = readWorkFiles([new File(['synthetic'], 'report.pdf')], [], controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(api).not.toHaveBeenCalled();
});
it('enforces extracted output and aggregate budgets', async () => {
  vi.mocked(api).mockResolvedValue({ text: 'a'.repeat(65537), warnings: [] });
  await expect(readWorkFiles([new File(['x'], 'report.pdf')])).rejects.toThrow('响应');
  vi.mocked(api).mockResolvedValue({ text: 'a'.repeat(65536), warnings: [] });
  await expect(readWorkFiles(Array.from({length:5},(_,i) => new File(['x'], `${i}.docx`)))).rejects.toThrow('256 KiB');
});
it.each(['doc', 'xls', 'ppt'])('rejects legacy %s with conversion guidance', async ext => {
  await expect(readWorkFiles([new File(['x'], `old.${ext}`)])).rejects.toThrow('转换');
  expect(api).not.toHaveBeenCalled();
});
it('keeps existing work attachments untouched when extraction fails', async () => {
  const existing = [{ kind:'file' as const, path:'upload:keep.txt', name:'keep.txt', text:'keep' }];
  vi.mocked(api).mockRejectedValue(new Error('文件加密或损坏'));
  await expect(readWorkFiles([new File(['synthetic'], 'bad.pdf')], existing)).rejects.toThrow('加密');
  expect(existing).toEqual([{kind:'file',path:'upload:keep.txt',name:'keep.txt',text:'keep'}]);
});
