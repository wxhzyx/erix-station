import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http.js';
import { cookieSettings, loadConfig } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';

async function fixture(t, restricted = false) {
  const userId = '11111111-1111-1111-1111-111111111111';
  const pool = new FakePool({ users: [{ id: userId, login: 'extract-test', display_name: 'Extract', role: 'admin', fde_name: null, status: 'active', must_change_password: restricted }] });
  const token = 'synthetic-extract-session';
  pool.sessions.push({ id: 'test-session', user_id: userId, token_hash: hashToken(token), created_at: new Date(), expires_at: new Date(Date.now() + 3600000), last_seen_at: new Date(), revoked_at: null });
  const config = { ...loadConfig({}), cookie: cookieSettings('dev-http', 604800), sessionTtlSeconds: 604800, sessionRenewIntervalSeconds: 3600, maxBodyBytes: 65536 };
  const server = createServer({ pool, config, log: { log() {}, warn() {}, error() {} } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/api/attachments/extract`, headers: { cookie: `${config.cookie.name}=${token}`, 'content-type': 'application/json' } };
}
const request = (f, body = {}, headers = f.headers) => fetch(f.url, { method: 'POST', headers, body: JSON.stringify(body) });
test('extraction requires authentication before interpreting document bytes', async t => {
  const f = await fixture(t);
  assert.equal((await request(f, {}, { 'content-type': 'application/json' })).status, 401);
});
test('extraction honors password-change and same-origin guards', async t => {
  const f = await fixture(t, true);
  assert.equal((await request(f)).status, 403);
  const g = await fixture(t);
  assert.equal((await request(g, {}, { ...g.headers, origin: 'https://evil.invalid' })).status, 403);
});
test('extraction rejects legacy, corrupt, unknown and oversized requests without filesystem access', async t => {
  const f = await fixture(t);
  for (const name of ['old.doc', 'bad.pdf', '../secret.docx', 'file.exe']) {
    const response = await request(f, { name, data_base64: Buffer.from('invalid').toString('base64') });
    assert.ok([400, 413, 415, 422].includes(response.status), `${name}: ${response.status}`);
    assert.match((await response.json()).error.code, /^document_/);
  }
  assert.equal((await request(f, { name: 'big.pdf', data_base64: 'A'.repeat(12 * 1024 * 1024) })).status, 413);
});

test('all document formats reach real chat and work prompt builders as text, not filenames', async t => {
  const { documentFixture } = await import('./helpers/document-fixtures.js');
  const { validateChatBody, chatPromptMessage } = await import('../src/chat-mode.js');
  const { validateMessageBody } = await import('../src/sessions.js');
  const { workMessageText } = await import('../src/work-attachments.js');
  const f = await fixture(t);
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx']) {
    const name = `example.${ext}`;
    const response = await request(f, { name, data_base64: documentFixture(ext).toString('base64') });
    assert.equal(response.status, 200, `${ext}: ${await response.clone().text()}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.name, name);
    assert.match(result.text, /Synthetic/);
    const chat = validateChatBody({ request_id: '44444444-4444-4444-4444-444444444444', content: '', attachments: [{ name, mime_type: 'text/plain', data_base64: Buffer.from(result.text).toString('base64') }] });
    assert.match(chatPromptMessage({ role: 'user', ...chat }).content[1].text, /Synthetic/);
    const work = validateMessageBody({ content: 'inspect', attachments: [{ kind: 'file', path: `upload:${name}`, name, text: result.text }] });
    assert.match(workMessageText(work.content, work.attachments), /Synthetic/);
    assert.deepEqual(validateMessageBody(work), work, 'queued delivery validates repeatedly without duplicating attachment content');
  }
});

test('unfinished upload reserves one user slot and disconnect releases it', async t => {
  const { request: httpRequest } = await import('node:http');
  const f = await fixture(t);
  const slow = httpRequest(f.url, { method: 'POST', headers: { ...f.headers, 'content-length': 1024 } });
  slow.on('error', () => {});
  t.after(() => slow.destroy());
  slow.write('{');
  const waitForStatus = async expected => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await request(f, { name: 'old.doc', data_base64: 'YWJj' });
      await response.arrayBuffer();
      if (response.status === expected) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`expected status ${expected}`);
  };
  await waitForStatus(429);
  slow.destroy();
  await waitForStatus(415);
});
