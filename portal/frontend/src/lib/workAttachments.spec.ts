import { describe, it, expect } from 'vitest';
import { readWorkFiles } from './workAttachments';
const file = (name: string, text: string) => ({ name, size: new TextEncoder().encode(text).length, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) as File;
describe('work file uploads', () => {
  it('reads multiple text files and preserves existing selections', async () => {
    const first = await readWorkFiles([file('a.txt', 'hello')]);
    const all = await readWorkFiles([file('b.ts', 'world')], first);
    expect(all.map(a => a.name)).toEqual(['a.txt', 'b.ts']);
    expect(all[0]?.text).toBe('hello');
  });
  it('rejects binary, unsafe names and count/byte limits atomically', async () => {
    for (const files of [[file('binary','\0')], [file('../file','a')], [file('large','a'.repeat(65537))], Array(9).fill(file('a','b')), Array(5).fill(file('a','b'.repeat(65536)))]) {
      await expect(readWorkFiles(files)).rejects.toThrow();
    }
  });
});
