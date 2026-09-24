-- Shared import metadata never contains user-entered manual descriptions.
-- Private resume records continue to live in user_items so account deletion's
-- existing ownership/tombstone barrier applies without a second data silo.
CREATE TABLE IF NOT EXISTS resume_job_imports (
  import_id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready', 'pending', 'manual-description-required', 'failed')),
  title TEXT,
  company TEXT,
  description_object_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resume_job_imports_hash ON resume_job_imports(content_hash);

CREATE TABLE IF NOT EXISTS resume_job_aliases (
  alias_url TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES resume_job_imports(import_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resume_job_import_tasks (
  task_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES resume_job_imports(import_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('queued', 'leased', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resume_job_import_tasks_ready ON resume_job_import_tasks(state, lease_until, created_at);
