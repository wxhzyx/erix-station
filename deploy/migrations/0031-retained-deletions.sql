-- Tombstones preserve identity attribution, repositories and historical usage.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE project_assignments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE project_assignments ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz;
-- Keep the unique (user_id,name): a retained Git repository must never be
-- accidentally taken over by a subsequent, unrelated assignment of the same name.
