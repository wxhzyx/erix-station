import { expect, it } from 'vitest';
import { runningPreviewPorts, type PreviewPortItem } from './previewPorts';
it('requires fresh listener evidence, never allocation/active alone; preserves null URL listeners', () => {
  const now = Date.now();
  const row = (id: string, observed: unknown, url: string | null = null) => ({ id, state: 'active', observed, url }) as PreviewPortItem;
  const live = row('external', { observed_at: new Date(now).toISOString() });
  expect(runningPreviewPorts([
    row('allocated', null), row('legacy', undefined),
    row('stale', { observed_at: new Date(now - 45000).toISOString() }),
    row('invalid', { observed_at: 'invalid' }), live,
  ], now)).toEqual([live]);
  expect(runningPreviewPorts([live], now + 45000)).toEqual([]);
});
