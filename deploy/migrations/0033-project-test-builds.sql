-- Administrator-owned delivery contract and immutable personal-branch test builds.
ALTER TABLE delivery_packages ADD COLUMN IF NOT EXISTS delivery_target jsonb NOT NULL DEFAULT '{"type":"web"}';
CREATE TABLE IF NOT EXISTS project_builds (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES collaboration_projects(id),
 requester_id uuid NOT NULL REFERENCES users(id), branch text NOT NULL, source_sha text NOT NULL,
 delivery_target jsonb NOT NULL, status text NOT NULL DEFAULT 'queued'
 CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 lease_hash text, lease_expires_at timestamptz, log text NOT NULL DEFAULT '', error text,
 artifact_name text, artifact_size bigint, artifact_sha256 text,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS project_builds_one_active ON project_builds(project_id,requester_id)
 WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS project_builds_history ON project_builds(project_id,created_at DESC);
GRANT SELECT,INSERT,UPDATE ON project_builds TO station_portal;
