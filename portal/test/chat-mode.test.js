import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChatBody, chatPromptMessage, sendChatMessage, getConversation, CHAT_LIMITS } from '../src/chat-mode.js';
const owner = '11111111-1111-1111-1111-111111111111';
const other = '22222222-2222-2222-2222-222222222222';
const id = '33333333-3333-3333-3333-333333333333';
const req = '44444444-4444-4444-4444-444444444444';
const body = (content = 'hello') => ({ content, request_id: req });
const textFile = { name: 'notes.txt', mime_type: 'text/plain', data_base64: Buffer.from('Useful context').toString('base64') };
const provider = { base_url: 'https://synthetic.invalid', api_key: 'synthetic-secret', model: 'fake' };
function fakePool({ busy = false, userBusy = false, initialRows = [] } = {}) {
  let rows = [...initialRows]; let pending = []; let released = 0;
  const calls = [];
  const db = { async query(sql, p = []) {
    calls.push([sql, p]);
    if (sql === 'BEGIN') { pending = [...rows]; return { rows: [] }; }
    if (sql === 'COMMIT') { rows = [...pending]; return { rows: [] }; }
    if (sql === 'ROLLBACK') { pending = []; return { rows: [] }; }
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: !userBusy }] };
    if (sql.includes('FROM chat_conversations')) {
      if (busy && sql.includes('NOWAIT')) throw Object.assign(new Error('lock'), { code: '55P03' });
      return { rows: p[0] === id && p[1] === owner ? [{ id, title: 'new' }] : [] };
    }
    if (sql.includes('SELECT * FROM chat_messages')) return { rows: pending.length ? pending : rows };
    if (sql.includes('INSERT INTO chat_messages')) {
      const row = { id: p[0], conversation_id: p[1], seq: p[2], role: p[3], content: p[4], attachments: JSON.parse(p[5]), request_id: p[6], request_hash: p[7] };
      pending.push(row); return { rows: [row] };
    }
    if (sql.startsWith('UPDATE')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  }, release() { released++; } };
  return { query: db.query, connect: async () => db, calls, rows: () => rows, released: () => released };
}
test('attachment-only text is accepted and becomes actual provider context', () => {
  const input = validateChatBody({ ...body(''), attachments: [textFile] });
  const prompt = chatPromptMessage({ role: 'user', ...input });
  assert.match(prompt.content[1].text, /Useful context/);
});
test('PNG becomes provider image content, no remote arbitrary URLs', () => {
  const png = { name: 'image.png', mime_type: 'image/png', data_base64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') };
  const input = validateChatBody({ ...body(), attachments: [png] });
  assert.equal(chatPromptMessage({ role: 'user', ...input }).content[1].image_url.url, `data:image/png;base64,${png.data_base64}`);
});
test('reject unsupported, invalid encoding, binary, traversal, excess count and bytes', () => {
  for (const attachments of [
    [{ ...textFile, mime_type: 'application/pdf' }], [{ ...textFile, data_base64: 'bad!' }],
    [{ ...textFile, data_base64: '/w==' }], [{ ...textFile, data_base64: 'AA==' }],
    [{ ...textFile, name: '../secret' }], Array(6).fill(textFile),
    [{ ...textFile, data_base64: Buffer.alloc(CHAT_LIMITS.fileBytes + 1, 65).toString('base64') }],
    Array(5).fill({ ...textFile, data_base64: Buffer.alloc(CHAT_LIMITS.fileBytes, 65).toString('base64') }),
    [{ ...textFile, mime_type: 'image/png' }],
  ]) assert.throws(() => validateChatBody({ ...body(), attachments }), { code: 'validation_failed' });
  assert.throws(() => validateChatBody(body('')), { code: 'validation_failed' });
  assert.throws(() => validateChatBody({ ...body(), request_id: '../x' }), { code: 'validation_failed' });
});
test('owner check before provider lookup; malformed and foreign IDs indistinguishable', async () => {
  const pool = fakePool(); let lookedUp = false;
  await assert.rejects(sendChatMessage(pool, other, id, body(), { resolveProvider: () => { lookedUp = true; } }), { code: 'not_found', httpStatus: 404 });
  assert.equal(lookedUp, false);
  await assert.rejects(getConversation(pool, owner, '../x'), { code: 'not_found' });
  assert.equal(pool.rows().length, 0);
});
test('persists actual attachment context, redacts key, returns metadata only and replays free', async () => {
  const pool = fakePool(); let calls = 0;
  const options = { resolveProvider: async () => provider, complete: async ({ messages, ...opts }) => {
    calls++; assert.match(messages[0].content[1].text, /Useful context/);
    assert.equal(opts.log, null); return { text: `Answer ${provider.api_key}` };
  } };
  const input = { ...body(), attachments: [textFile] };
  const sent = await sendChatMessage(pool, owner, id, input, options);
  assert.equal(sent.messages.length, 2);
  assert.equal(sent.messages[1].content, 'Answer [redacted]');
  assert.equal(sent.messages[0].attachments[0].data_base64, undefined);
  assert.equal(pool.rows()[0].attachments[0].data_base64, textFile.data_base64);
  assert.deepEqual(await sendChatMessage(pool, owner, id, input, options), sent);
  assert.equal(calls, 1);
  await assert.rejects(sendChatMessage(pool, owner, id, body('different'), options), { code: 'idempotency_key_reuse' });
  assert.equal(pool.rows().length, 2);
});
test('failed upstream rolls back, does not expose key and allows a retry', async () => {
  const pool = fakePool();
  await assert.rejects(sendChatMessage(pool, owner, id, body(), { resolveProvider: async () => provider, complete: async () => { throw new Error(provider.api_key); } }), (err) => err.code === 'llm_upstream_failed' && !err.message.includes(provider.api_key));
  assert.equal(pool.rows().length, 0); assert.equal(pool.released(), 1);
  await sendChatMessage(pool, owner, id, body(), { resolveProvider: async () => provider, complete: async () => ({ text: 'ok' }) });
  assert.equal(pool.rows().length, 2);
});
test('busy conversation and missing provider fail promptly without writes', async () => {
  await assert.rejects(sendChatMessage(fakePool({ busy: true }), owner, id, body()), { code: 'chat_busy', httpStatus: 409 });
  const pool = fakePool();
  await assert.rejects(sendChatMessage(pool, owner, id, body(), { resolveProvider: async () => null }), { code: 'llm_not_configured', httpStatus: 409 });
  assert.equal(pool.rows().length, 0);
});

test('one in-flight chat per user and settings writes share an advisory lock', async () => {
  const pool = fakePool({ userBusy: true });
  await assert.rejects(sendChatMessage(pool, owner, id, body()), { code: 'chat_busy' });
  assert.deepEqual(pool.calls.find(([sql]) => sql.includes('pg_try_advisory_xact_lock'))[1], [`mode-chat:${owner}`]);
  assert.equal(pool.calls.some(([sql]) => sql.includes('FROM chat_conversations')), false);
});
test('bounded history and image capability checked before calling upstream', async () => {
  const history = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'hello', seq: i + 1, attachments: [], request_id: 'old' }));
  await assert.rejects(sendChatMessage(fakePool({ initialRows: history }), owner, id, body()), { code: 'chat_limit' });
  const png = { name: 'image.png', mime_type: 'image/png', data_base64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') };
  await assert.rejects(sendChatMessage(fakePool(), owner, id, { ...body(), attachments: [png] }, { resolveProvider: async () => ({ ...provider, supportsImages: false }) }), { code: 'validation_failed' });
});
test('follow-up uses persisted prior text and attachments, resolver reuses transaction connection', async () => {
  const pool = fakePool();
  const options = { resolveProvider: async (_user, db) => { assert.equal(typeof db.query, 'function'); return provider; }, complete: async () => ({ text: 'first response' }) };
  await sendChatMessage(pool, owner, id, { ...body(), attachments: [textFile] }, options);
  await sendChatMessage(pool, owner, id, { content: 'follow up', request_id: '55555555-5555-5555-5555-555555555555' }, { ...options, complete: async ({ messages }) => {
    assert.equal(messages.length, 3); assert.match(messages[0].content[1].text, /Useful context/); assert.equal(messages[1].content, 'first response'); return { text: 'second response' };
  } });
  assert.deepEqual(pool.rows().map((m) => m.seq), [1, 2, 3, 4]);
});

test('request UUID casing is normalized for PostgreSQL idempotency replay', () => {
  assert.equal(validateChatBody({ ...body(), request_id: 'ABCDEFAB-1111-1111-1111-111111111111' }).request_id, 'abcdefab-1111-1111-1111-111111111111');
});

test('streams only safe text before commit and rolls back a cancelled turn', async()=>{
 const pool=fakePool();const seen=[];const controller=new AbortController();
 await assert.rejects(sendChatMessage(pool,owner,id,body(),{signal:controller.signal,onDelta:text=>seen.push(text),resolveProvider:async()=>provider,
  complete:async({stream,onDelta,signal})=>{assert.equal(stream,true);await onDelta('Live '+provider.api_key.slice(0,5));assert.deepEqual(seen,['Live ']);assert.equal(pool.rows().length,0);await onDelta(provider.api_key.slice(5));controller.abort();signal.throwIfAborted();}
 }),{code:'llm_upstream_failed'});
 assert.deepEqual(seen,['Live ','[redacted]']);assert.equal(pool.rows().length,0);assert.equal(pool.released(),1);
});
