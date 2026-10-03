-- Durable round-robin cursor for the bounded Stage 2 source dispatcher.
CREATE TABLE IF NOT EXISTS ingestion_v2_dispatch_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  source_cursor TEXT,
  updated_at TEXT NOT NULL
);

-- Non-publishing catalog-effect receipts for the controlled Stage 2 canary.
-- They contain only classifications and stable identifiers, never source body
-- text or fetched response content.
CREATE TABLE IF NOT EXISTS ingestion_v2_admission_decisions (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  admission_version TEXT NOT NULL,
  job_id TEXT NOT NULL,
  notify INTEGER NOT NULL CHECK(notify IN (0, 1)),
  catalog_eligible INTEGER NOT NULL CHECK(catalog_eligible IN (0, 1)),
  alert_eligible INTEGER NOT NULL CHECK(alert_eligible IN (0, 1)),
  reason_codes TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(source_id, external_id, admission_version)
);

CREATE INDEX IF NOT EXISTS ingestion_v2_admission_decisions_recorded
  ON ingestion_v2_admission_decisions(recorded_at, source_id, external_id);
