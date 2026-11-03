-- Durable collaboration state; remote Git and model usage are never cascade-deleted.
CREATE TABLE IF NOT EXISTS collaboration_projects (
 id uuid PRIMARY KEY, name text NOT NULL, owner_user_id uuid NOT NULL REFERENCES users(id),
 package_id uuid NOT NULL REFERENCES delivery_packages(id), instructions text NOT NULL DEFAULT '',
 repo_name text NOT NULL UNIQUE, repo_id bigint, repo_url text,
 state text NOT NULL DEFAULT 'provisioning' CHECK(state IN ('provisioning','active','deleting','deleted','failed')),
 last_error text, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz
);
ALTER TABLE project_assignments ADD COLUMN IF NOT EXISTS collaboration_project_id uuid REFERENCES collaboration_projects(id);
CREATE TABLE IF NOT EXISTS project_memberships (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES collaboration_projects(id),
 user_id uuid NOT NULL REFERENCES users(id), assignment_id uuid UNIQUE REFERENCES project_assignments(id),
 branch text NOT NULL, remote_login text NOT NULL,
 state text NOT NULL CHECK(state IN ('invited','provisioning','active','revoking','revoked','declined','failed')),
 invited_by uuid NOT NULL REFERENCES users(id), accepted_at timestamptz, last_error text, cleanup_ack boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,user_id), UNIQUE(project_id,branch)
);
CREATE TABLE IF NOT EXISTS collaboration_reviews (
 project_id uuid NOT NULL REFERENCES collaboration_projects(id), pr_number integer NOT NULL,
 reviewer_id uuid NOT NULL REFERENCES users(id), source_sha text NOT NULL, target_sha text NOT NULL,
 approved boolean NOT NULL, reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,pr_number,reviewer_id)
);
CREATE INDEX IF NOT EXISTS collaboration_pending ON project_memberships(state) WHERE state IN ('provisioning','revoking','failed');
GRANT SELECT,INSERT,UPDATE,DELETE ON collaboration_projects,project_memberships,collaboration_reviews TO station_portal;
