import { describe, expect, it } from 'vitest';
import { blockEnd, classifyBlock, formatBlockLabel, normalizeUsage, previewUsagePath, usageErrorText } from './previewPoolUsage';
const POOL = { start: 31000, end: 31999, block_size: 10, total_blocks: 100 };

const USAGE = {
  pool: POOL,
  // §4.7a 自洽：free 97 + partial 2 + occupied 1 = 100；len(occupied_blocks)=3 = partial + occupied
  summary: { total_blocks: 100, free: 97, partial: 2, occupied: 1 },
  occupied_blocks: [
    { start: 31000, end: 31009, occupied_count: 10, fde_names: ['eric'] },
    { start: 31020, end: 31029, occupied_count: 3, fde_names: ['bob', 'dana'] },
    { start: 31050, end: 31059, occupied_count: 1, fde_names: ['dana'] },
  ],
  free_blocks: { items: [31010, 31030, 31040], limit: 3, has_more: true },
};

describe('issue #350 lib 纯函数（归一化 / 段标签 / 块归属 / 错误面）', () => {
  it('previewUsagePath：缺省不带 query；正整数才拼 limit；脏值按不指定处理', () => {
    expect(previewUsagePath()).toBe('/api/admin/preview-ports/usage');
    expect(previewUsagePath(null)).toBe('/api/admin/preview-ports/usage');
    expect(previewUsagePath(3)).toBe('/api/admin/preview-ports/usage?limit=3');
    expect(previewUsagePath(0)).toBe('/api/admin/preview-ports/usage');
    expect(previewUsagePath(-1)).toBe('/api/admin/preview-ports/usage');
    expect(previewUsagePath(1.5)).toBe('/api/admin/preview-ports/usage');
  });

  it('normalizeUsage：字符串数字/NaN/缺字段一律 null（不 Number() 硬转、不当 0）', () => {
    const usage = normalizeUsage({
      pool: { start: '31000', end: 31999, block_size: 10, total_blocks: 100 },
      summary: { total_blocks: 100, free: '97', partial: null },
      occupied_blocks: [{ start: 31000, fde_names: ['eric', '', 42] }, { end: 1 }, 'junk'],
      free_blocks: { items: [31010, '31030', null], limit: '3', has_more: 'yes' },
    });
    expect(usage.pool).toBeNull(); // start 是字符串 ⇒ 整段不可信
    expect(usage.summary).toEqual({ totalBlocks: 100, free: null, partial: null, occupied: null });
    expect(usage.occupiedBlocks).toEqual([{ start: 31000, end: null, occupiedCount: null, fdeNames: ['eric'] }]);
    expect(usage.freeBlocks).toEqual({ items: [31010], limit: null, hasMore: null });
    expect(usage.occupiedPresent).toBe(true);
    expect(usage.freePresent).toBe(true);
  });

  it('normalizeUsage：整份响应不是对象也不炸，且 Present 旗标说「没给」', () => {
    for (const raw of [null, undefined, 'oops', 42, []]) {
      const usage = normalizeUsage(raw);
      expect(usage.pool).toBeNull();
      expect(usage.occupiedPresent).toBe(false);
      expect(usage.freePresent).toBe(false);
      expect(usage.freeBlocks).toEqual({ items: [], limit: null, hasMore: null });
    }
  });

  it('blockEnd/formatBlockLabel：末端由 block_size 推导；块大小未知就不编末端', () => {
    expect(blockEnd(31010, 10)).toBe(31019);
    expect(blockEnd(31010, null)).toBeNull();
    expect(blockEnd(31010, 0)).toBeNull();
    expect(formatBlockLabel(31010, 31019)).toBe('31010–31019');
    expect(formatBlockLabel(31010, null)).toBe('31010');
  });

  it('classifyBlock：占用的段点名 FDE；只有真在空闲列表里才算 free；其余一律 unknown', () => {
    const usage = normalizeUsage(USAGE);
    expect(classifyBlock(usage, 31000)).toEqual({ kind: 'occupied', fdeNames: ['eric'], occupiedCount: 10 });
    expect(classifyBlock(usage, 31030)).toEqual({ kind: 'free', fdeNames: [], occupiedCount: null });
    // 31100 既不在 occupied_blocks 也不在（截断的）空闲列表里 ⇒ 不知道，不许说「空闲」
    expect(classifyBlock(usage, 31100).kind).toBe('unknown');
    expect(classifyBlock(null, 31000).kind).toBe('unknown');
    expect(classifyBlock(usage, null).kind).toBe('unknown');
  });

  it('usageErrorText：ApiError 取 code+message 原文；非 Error 也不炸', () => {
    const error = Object.assign(new Error('forbidden: admin role required'), { status: 403, code: 'forbidden' });
    expect(usageErrorText(error)).toEqual({ code: 'forbidden', message: 'forbidden: admin role required' });
    expect(usageErrorText(new Error('boom'))).toEqual({ code: 'unknown', message: 'boom' });
    expect(usageErrorText('plain')).toEqual({ code: 'unknown', message: 'plain' });
  });
});
