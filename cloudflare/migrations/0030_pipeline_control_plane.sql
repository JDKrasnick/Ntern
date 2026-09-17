CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id TEXT PRIMARY KEY, operation TEXT NOT NULL, priority TEXT NOT NULL CHECK (priority IN ('P1', 'P2')),
  scope_json TEXT NOT NULL, input_version TEXT NOT NULL, cursor TEXT, chunk_size INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'paused', 'completed', 'failed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, failure_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_runs_one_active_priority ON pipeline_runs(priority) WHERE state IN ('planned', 'running', 'paused');
CREATE TABLE IF NOT EXISTS pipeline_run_chunks (
  run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id), ordinal INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
  cursor_start TEXT, cursor_end TEXT, state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'completed', 'failed')), completed_at TEXT,
  PRIMARY KEY (run_id, ordinal), UNIQUE (idempotency_key)
);
CREATE TABLE IF NOT EXISTS pipeline_incidents (
  fingerprint TEXT PRIMARY KEY, severity TEXT NOT NULL, lane TEXT NOT NULL, first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, recovered_at TEXT, event_count INTEGER NOT NULL DEFAULT 1, details_json TEXT NOT NULL
);
