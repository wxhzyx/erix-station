-- One-time OIDC state bound to a browser cookie. No access/refresh tokens are stored.
CREATE TABLE IF NOT EXISTS oidc_login_states (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  verifier text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oidc_login_states_expiry_idx ON oidc_login_states (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON oidc_login_states TO station_portal;
