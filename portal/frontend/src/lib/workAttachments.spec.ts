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
    for (const files of [[file('binary','\0')], [file('../file','a')], [file('large','a'.repeat(10 * 1024 * 1024 + 1))], Array(11).fill(file('a','b'))]) {
      await expect(readWorkFiles(files)).rejects.toThrow();
    }
  });
});

it('accepts 10 MiB and ten files, rejects an eleventh across selections', async () => {
  const text = 'x'.repeat(10 * 1024 * 1024 - 4) + 'TAIL';
  const selected = await readWorkFiles([file('large.txt',text), ...Array.from({length:9},(_,i)=>file(`${i}.txt`,'ok'))]);
  expect(selected).toHaveLength(10);expect(selected[0]?.text).toBe(text);
  await expect(readWorkFiles([file('extra.txt','no')],selected)).rejects.toThrow('10');
});
