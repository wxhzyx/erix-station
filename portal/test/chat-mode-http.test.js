import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http.js';
import { cookieSettings, loadConfig } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
const id = '33333333-3333-3333-3333-333333333333';
async function fixture(t, { restricted = false } = {}) {
  const userId = '11111111-1111-1111-1111-111111111111';
  const pool = new FakePool({ users: [{ id: userId, login: 'chat-test', display_name: 'Chat', role: 'admin', fde_name: null, status: 'active', must_change_password: restricted }] });
  const token = 'synthetic-chat-session';
  pool.sessions.push({ id: 'test-session', user_id: userId, token_hash: hashToken(token), created_at: new Date(), expires_at: new Date(Date.now() + 3600000), last_seen_at: new Date(), revoked_at: null });
  const original = pool.query.bind(pool);
  const queries = [];
  pool.query = async (sql, args) => {
    if (sql.includes('chat_conversations')) { queries.push(sql); return { rows: [] }; }
    return original(sql, args);
  };
  const config = { ...loadConfig({}), cookie: cookieSettings('dev-http', 604800), sessionTtlSeconds: 604800, sessionRenewIntervalSeconds: 3600, maxBodyBytes: 64 * 1024 };
  const server = createServer({ pool, config, log: { log() {}, warn() {}, error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, headers: { cookie: `${config.cookie.name}=${token}`, 'content-type': 'application/json' }, queries };
}
test('chat HTTP requires login and permits authenticated user without workstation', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/chat/conversations`)).status, 401);
  const res = await fetch(`${f.base}/api/chat/conversations`, { headers: f.headers });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { conversations: [] });
});
test('chat HTTP enforces mandatory password change before data access', async (t) => {
  const f = await fixture(t, { restricted: true });
  const res = await fetch(`${f.base}/api/chat/conversations`, { headers: f.headers });
  assert.equal(res.status, 403);
  assert.equal(f.queries.length, 0);
});
test('chat HTTP foreign or unknown conversation does not expose existence', async (t) => {
  const f = await fixture(t);
  const res = await fetch(`${f.base}/api/chat/conversations/${id}`, { headers: f.headers });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
});
test('chat HTTP CSRF rejection precedes all conversation writes', async (t) => {
  const f = await fixture(t);
  const res = await fetch(`${f.base}/api/chat/conversations`, { method: 'POST', headers: { ...f.headers, origin: 'https://evil.invalid' }, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'cross_origin_forbidden');
  assert.equal(f.queries.length, 0);
});
test('chat HTTP oversized JSON rejected before DB or model call', async (t) => {
  const f = await fixture(t);
  const res = await fetch(`${f.base}/api/chat/conversations/${id}/messages`, { method: 'POST', headers: f.headers, body: JSON.stringify({ content: 'x'.repeat(6 * 1024 * 1024 + 1) }) });
  assert.equal(res.status, 413);
  assert.equal(f.queries.length, 0);
});
