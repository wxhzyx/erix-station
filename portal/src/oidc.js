// OIDC authorization-code + PKCE login. Protocol validation belongs to openid-client.
import crypto from 'node:crypto';
import * as oidc from 'openid-client';
import { hashToken, createSession, audit } from './auth.js';
import { enqueueOnboarding } from './onboarding.js';

export class OidcError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message); this.code = code; this.httpStatus = httpStatus;
  }
}

export function oidcSettings(env = process.env) {
  if (!env.OIDC_ISSUER) {
    if (env.OIDC_ONLY === '1') throw new Error('OIDC_ISSUER is required when OIDC_ONLY=1');
    return null;
  }
  const required = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OIDC_GIT_HOST_ID', 'OIDC_LLM_PROVIDER_ID', 'OIDC_LLM_MODEL_ID'];
  for (const key of required) if (!env[key]) throw new Error(`${key} is required when OIDC is enabled`);
  for (const key of ['OIDC_ISSUER', 'OIDC_REDIRECT_URI']) {
    const u = new URL(env[key]);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error(`${key} must be a clean HTTPS URL`);
  }
  return {
    issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: env.OIDC_REDIRECT_URI, gitHostId: env.OIDC_GIT_HOST_ID,
    providerId: env.OIDC_LLM_PROVIDER_ID, modelId: env.OIDC_LLM_MODEL_ID,
    adminSubjects: (env.OIDC_ADMIN_SUBJECTS || '').split(',').map(x => x.trim()).filter(Boolean),
  };
}

export function stationIdentity(settings, claims) {
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 || /[\x00-\x1f\x7f]/.test(claims.sub)) {
    throw new OidcError('sso_identity_invalid', 'SSO 未返回有效身份');
  }
  // Never link a local account merely because its username/email resembles an IdP claim.
  const subject = `${settings.issuer}|${claims.sub}`;
  // INTEVA publishes sAMAccountName as preferred_username (and as sub).
  const login = claims.preferred_username ?? claims.sub;
  if (typeof login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(login)) {
    throw new OidcError('sso_identity_invalid', 'SSO 未返回有效域账号');
  }
  const fdeName = login.toLowerCase().replace(/[_.]/g, '-').replace(/-+$/, '');
  return {
    subject, login, fdeName,
    displayName: typeof claims.name === 'string' ? claims.name.slice(0, 200) : claims.sub,
    email: claims.email_verified === true && typeof claims.email === 'string' ? claims.email.slice(0, 254) : null,
    role: settings.adminSubjects.includes(claims.sub) ? 'admin' : 'fde',
  };
}

export async function provisionSsoIdentity(pool, settings, claims) {
  const identity = stationIdentity(settings, claims);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identity.subject]);
    const found = await db.query('SELECT * FROM users WHERE oidc_sub = $1 FOR UPDATE', [identity.subject]);
    let user = found.rows[0];
    if (user && user.status !== 'active') throw new OidcError('sso_account_disabled', '工位账号已停用，请联系管理员', 403);
    if (!user) {
      const host = await db.query("SELECT id FROM git_hosts WHERE id = $1 AND enabled = true AND mode = 'minted'", [settings.gitHostId]);
      if (!host.rows[0]) throw new OidcError('sso_setup_incomplete', '自动开户的 Git 服务未配置完成', 503);
      const result = await db.query(`INSERT INTO users
        (login, email, display_name, role, auth_source, oidc_sub, fde_name, status, must_change_password)
        VALUES ($1, $2, $3, $4, 'oidc', $5, $6, 'active', false) RETURNING *`,
      [identity.login, identity.email, identity.displayName, identity.role, identity.subject, identity.fdeName]);
      user = result.rows[0];
      await enqueueOnboarding(db, { fdeId: user.id, gitHostId: settings.gitHostId,
        llm: { provider_id: settings.providerId, main_model_id: settings.modelId } });
      await audit(db, { actorId: user.id, action: 'auth.oidc_created', target: user.id });
    } else {
      // Keep UUID, workspace and external bindings stable. A username collision
      // fails the transaction; it never links or takes over another identity.
      user = (await db.query(`UPDATE users SET login=$2, display_name=$3, email=$4
        WHERE id=$1 RETURNING *`, [user.id, identity.login, identity.displayName, identity.email])).rows[0];
    }
    await db.query('COMMIT');
    return user;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') throw new OidcError('sso_identity_conflict', '身份与已有账号冲突，请联系管理员', 409);
    throw err;
  } finally { db.release(); }
}

export function createOidcLogin({ pool, config, client = oidc, gateway }) {
  const settings = config.oidc;
  let discovery;
  async function getClient() {
    discovery ??= client.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret,
      client.ClientSecretPost(settings.clientSecret), { timeout: 15 }).catch(error => { discovery = null; throw error; });
    return discovery;
  }
  return {
    async start() {
      const connection = await getClient();
      const state = client.randomState();
      const verifier = client.randomPKCECodeVerifier();
      const nonce = client.randomNonce();
      const browserToken = crypto.randomBytes(32).toString('base64url');
      await pool.query('DELETE FROM oidc_login_states WHERE expires_at < now()');
      await pool.query(`INSERT INTO oidc_login_states (state_hash, browser_hash, verifier, nonce, expires_at)
        VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`, [hashToken(state), hashToken(browserToken), verifier, nonce]);
      const url = client.buildAuthorizationUrl(connection, {
        redirect_uri: settings.redirectUri, scope: 'openid profile email', state, nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
      return { url: url.href, browserToken };
    },
    async callback(query, browserToken, { ip, userAgent } = {}) {
      const state = query.get('state');
      if (!state || state.length > 256 || !browserToken || browserToken.length > 256 || query.getAll('state').length !== 1) {
        throw new OidcError('sso_state_invalid', '登录请求已失效，请重新登录');
      }
      const result = await pool.query(`DELETE FROM oidc_login_states
        WHERE state_hash = $1 AND browser_hash = $2 AND expires_at > now() RETURNING verifier, nonce`,
      [hashToken(state), hashToken(browserToken)]);
      const pending = result.rows[0];
      if (!pending) throw new OidcError('sso_state_invalid', '登录请求已失效，请重新登录');
      const callbackUrl = new URL(settings.redirectUri);
      callbackUrl.search = query.toString();
      const connection = await getClient();
      const tokens = await client.authorizationCodeGrant(connection, callbackUrl, {
        pkceCodeVerifier: pending.verifier, expectedState: state, expectedNonce: pending.nonce, idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new OidcError('sso_identity_invalid', 'SSO 未返回有效身份');
      const profile = await client.fetchUserInfo(connection, tokens.access_token, claims.sub);
      const user = await provisionSsoIdentity(pool, settings, { ...claims, ...profile });
      // The gateway's stable user id and membership are reconciled on every SSO login.
      // Failure does not issue a platform session with an unsynchronized identity.
      if (gateway?.teamId) await gateway.ensureStationMember({id:user.id,login:user.login});
      const session = await createSession(pool, user.id, { ip, userAgent, ttlSeconds: config.sessionTtlSeconds });
      await audit(pool, { actorId: user.id, action: 'auth.oidc_login', target: user.id });
      return { user, session };
    },
  };
}
