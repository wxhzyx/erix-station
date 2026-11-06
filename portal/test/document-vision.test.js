import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocumentImages } from '../src/document-vision.js';
const provider = { api_key: 'synthetic-personal-key', model: 'vision', base_url: 'http://gateway.invalid', supportsImages: true };
const parsed = { name: 'scan.pdf', text: 'text layer', warnings: [], images: [{ label: '第 1 页', mime_type: 'image/jpeg', data_base64: '/9j/2Q==' }] };
test('text-only documents use no model; visual content reaches personal model and images are not returned', async () => {
  assert.deepEqual(await readDocumentImages({ name: 'plain.xlsx', text: 'table', warnings: [] }), { name: 'plain.xlsx', text: 'table', warnings: [] });
  let calls = 0;
  const result = await readDocumentImages(parsed, { resolveProvider: async () => provider, complete: async options => {
    calls++; assert.equal(options.provider, provider); assert.equal(options.log, null);
    assert.equal(options.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,/9j/2Q==');
    assert.ok(options.maxTokens > 0); return { text: 'TOTAL 84', body: { choices: [{ finish_reason: 'stop' }] } };
  } });
  assert.equal(calls, 1); assert.match(result.text, /text layer.*\n.*\nTOTAL 84/s); assert.equal(result.images, undefined);
});
test('vision requires an explicitly capable model and never silently falls back to empty text', async () => {
  for (const p of [null, { ...provider, supportsImages: false }]) await assert.rejects(readDocumentImages(parsed, { resolveProvider: async () => p }), { code: 'document_vision_unavailable' });
  for (const text of ['', '[无可读内容]']) await assert.rejects(readDocumentImages(parsed, { resolveProvider: async () => provider, complete: async () => ({ text }) }), { code: 'document_empty' });
});
test('vision cancellation stops before billing, masks errors, and rejects truncated recognition', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(readDocumentImages(parsed, { signal: controller.signal, resolveProvider: () => { calls++; } })); assert.equal(calls, 0);
  await assert.rejects(readDocumentImages(parsed, { resolveProvider: async () => provider, complete: async () => { throw new Error(provider.api_key); } }), error => error.code === 'document_vision_failed' && !error.message.includes(provider.api_key));
  await assert.rejects(readDocumentImages(parsed, { resolveProvider: async () => provider, complete: async () => ({ text: 'partial', body: { choices: [{ finish_reason: 'length' }] } }) }), { code: 'document_visual_limit' });
  const result = await readDocumentImages(parsed, { resolveProvider: async () => provider, complete: async () => ({ text: provider.api_key + '\u0000 DATA' }) });
  assert.doesNotMatch(result.text, /synthetic-personal-key|\u0000/);
});
