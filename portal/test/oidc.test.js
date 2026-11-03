import test from 'node:test';
import assert from 'node:assert/strict';
import { oidcSettings, stationIdentity, provisionSsoIdentity, createOidcLogin } from '../src/oidc.js';
import { hashToken } from '../src/auth.js';

const settings = { issuer: 'https://sso.example/', clientId: 'station', clientSecret: 'test-secret',
  redirectUri: 'https://station.example/api/auth/sso/callback', gitHostId: 'host', providerId: 'provider', modelId: 'model', adminSubjects: [] };

test('OIDC is opt-in and refuses incomplete or insecure configuration', () => {
  assert.equal(oidcSettings({}), null);
  assert.throws(() => oidcSettings({ OIDC_ONLY: '1' }), /OIDC_ISSUER/);
  assert.throws(() => oidcSettings({ OIDC_ISSUER: settings.issuer }), /OIDC_CLIENT_ID/);
  const env = { OIDC_ISSUER: settings.issuer, OIDC_CLIENT_ID: 'station', OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: settings.redirectUri, OIDC_GIT_HOST_ID: 'id', OIDC_LLM_PROVIDER_ID: 'p', OIDC_LLM_MODEL_ID: 'm' };
  assert.equal(oidcSettings(env).issuer, settings.issuer);
  assert.throws(() => oidcSettings({ ...env, OIDC_REDIRECT_URI: 'http://station.example/callback' }), /HTTPS/);
});

test('SSO identities do not inherit roles or link to local usernames; issuer namespaces subjects', () => {
  const claims = { sub: 'JXu14', name: 'Test Employee', email: 'employee@example.com', role: 'admin' };
  const a = stationIdentity(settings, claims);
  assert.equal(a.role, 'fde'); assert.equal(a.email, null);
  assert.match(a.fdeName, /^sso-jxu14-[0-9a-f]{8}$/);
  assert.deepEqual(a, stationIdentity(settings, claims));
  assert.notEqual(a.fdeName, stationIdentity({ ...settings, issuer: 'https://other.example/' }, claims).fdeName);
  assert.equal(stationIdentity({ ...settings, adminSubjects: ['JXu14'] }, claims).role, 'admin');
  assert.equal(stationIdentity(settings, { ...claims, email_verified: true }).email, claims.email);
  assert.throws(() => stationIdentity(settings, { sub: 'bad\nidentity' }), /有效身份/);
});

function fakePool(existing = null) {
  const calls = []; const rows = existing ? [existing] : [];
  const db = { release() {}, async query(sql, args) {
    calls.push({ sql, args });
    if (sql.startsWith('SELECT * FROM users')) return { rows };
    if (sql.startsWith('SELECT id FROM git_hosts')) return { rows: [{ id: 'host' }] };
    if (sql.startsWith('INSERT INTO users')) {
      const user = { id: 'user-id', login: args[0], status: 'active', role: args[3], oidc_sub: args[4] };
      rows.push(user); return { rows: [user] };
    }
    return { rows: [] };
  } };
  return { calls, connect: async () => db };
}

test('first SSO login queues durable Git/LLM onboarding once; repeat login preserves binding', async () => {
  const pool = fakePool();
  const a = await provisionSsoIdentity(pool, settings, { sub: 'employee' });
  const b = await provisionSsoIdentity(pool, settings, { sub: 'employee' });
  assert.equal(a.id, b.id);
  assert.equal(pool.calls.filter(c => c.sql.startsWith('INSERT INTO users')).length, 1);
  assert.equal(pool.calls.filter(c => c.sql.includes('INSERT INTO fde_onboarding')).length, 1);
  assert.ok(pool.calls.some(c => c.sql.includes('pg_advisory_xact_lock')));
});

test('disabled SSO identities cannot log in or trigger reactivation', async () => {
  const pool = fakePool({ id: 'user-id', status: 'disabled' });
  await assert.rejects(provisionSsoIdentity(pool, settings, { sub: 'employee' }), { code: 'sso_account_disabled' });
  assert.equal(pool.calls.some(c => c.sql.startsWith('INSERT')), false);
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});

test('callback rejects missing, replayed, and wrong-browser state before token exchange', async () => {
  let exchanges = 0;
  const client = { authorizationCodeGrant() { exchanges++; } };
  const pool = { async query(sql, args) {
    assert.match(sql, /browser_hash = \$2 AND expires_at > now\(\)/);
    assert.deepEqual(args, [hashToken('test-state'), hashToken('wrong-browser')]);
    return { rows: [] };
  } };
  const service = createOidcLogin({ pool, config: { oidc: settings }, client });
  await assert.rejects(service.callback(new URLSearchParams(), null), { code: 'sso_state_invalid' });
  await assert.rejects(service.callback(new URLSearchParams('state=test-state'), 'wrong-browser'), { code: 'sso_state_invalid' });
  await assert.rejects(service.callback(new URLSearchParams('state=x&state=y'), 'browser'), { code: 'sso_state_invalid' });
  assert.equal(exchanges, 0);
});

test('successful callback checks PKCE, nonce and subject, then consumes state once', async () => {
  const db = fakePool();
  let pending = true;
  const exchanges = [];
  const pool = { ...db, async query(sql, args) {
    if (sql.startsWith('DELETE FROM oidc_login_states')) {
      assert.deepEqual(args, [hashToken('state'), hashToken('browser')]);
      const rows = pending ? [{ verifier: 'verifier', nonce: 'nonce' }] : [];
      pending = false;
      return { rows };
    }
    db.calls.push({ sql, args });
    return { rows: [] };
  } };
  const client = {
    ClientSecretPost: () => 'client-auth', discovery: async () => 'connection',
    authorizationCodeGrant: async (connection, url, checks) => {
      assert.equal(connection, 'connection');
      assert.equal(url.origin, 'https://station.example');
      exchanges.push(checks);
      return { access_token: 'access-token', claims: () => ({ sub: 'employee' }) };
    },
    fetchUserInfo: async (connection, token, expectedSubject) => {
      assert.equal(expectedSubject, 'employee'); assert.equal(token, 'access-token');
      return { sub: 'employee', name: 'Employee' };
    },
  };
  const service = createOidcLogin({ pool, config: { oidc: settings, sessionTtlSeconds: 3600 }, client });
  const result = await service.callback(new URLSearchParams('state=state&code=code'), 'browser');
  assert.equal(result.user.role, 'fde'); assert.ok(result.session.token);
  assert.deepEqual(exchanges, [{ pkceCodeVerifier: 'verifier', expectedState: 'state', expectedNonce: 'nonce', idTokenExpected: true }]);
  await assert.rejects(service.callback(new URLSearchParams('state=state&code=code'), 'browser'), { code: 'sso_state_invalid' });
  assert.equal(exchanges.length, 1);
});
