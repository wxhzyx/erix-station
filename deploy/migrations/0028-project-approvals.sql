-- Project review ledger: directory identity, not retired projects rows.
CREATE TABLE IF NOT EXISTS project_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id),
  cwd text NOT NULL,
  git_host_id text NOT NULL,
  repository text NOT NULL,
  source_ref text NOT NULL,
  target_ref text NOT NULL,
  source_sha text NOT NULL,
  target_sha text NOT NULL,
  diff text NOT NULL,
  web_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewing','reviewed','approved','merging','merged','failed','stale','rejected')),
  ai_review text,
  reviewed_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  merged_by uuid REFERENCES users(id),
  merged_at timestamptz,
  candidate_sha text,
  merge_sha text,
  error text,
  operation_token uuid,
  operation_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_approvals_owner_idx ON project_approvals(requester_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS project_approvals_open_versions_idx ON project_approvals
  (requester_id,cwd,git_host_id,repository,source_ref,target_ref,source_sha,target_sha)
  WHERE status NOT IN ('merged','stale','rejected');
