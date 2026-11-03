-- Administrative delivery packages are immutable; assignments own their lifecycle.
CREATE TABLE IF NOT EXISTS delivery_packages (
  id uuid PRIMARY KEY, name text NOT NULL, filename text NOT NULL,
  sha256 text NOT NULL, archive bytea NOT NULL, manifest jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_assignments (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  package_id uuid NOT NULL REFERENCES delivery_packages(id), name text NOT NULL,
  instructions text NOT NULL DEFAULT '', created_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  repo_url text, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,name)
);
CREATE TABLE IF NOT EXISTS token_quota_requests (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  requested_limit bigint NOT NULL CHECK (requested_limit > 0 AND requested_limit <= 1000000000),
  reason text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by uuid REFERENCES users(id), review_note text, created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS token_quota_one_pending ON token_quota_requests(user_id) WHERE status='pending';
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_packages, project_assignments, token_quota_requests TO station_portal;
