-- Ingestion V2 foundation (Stage 1), 2026-10-01.
--
-- Additive-only durable state for fault-isolated ingestion:
--
--   * `ingestion_snapshots` records one complete, content-addressed normalized
--     snapshot per (source, snapshot hash). The R2 object is always written
--     before its D1 record so a staged object survives an activation failure.
--   * `ingestion_rows` is the compact per-row ledger the full-board diff plans
--     against. It never stores occurrence bodies or hydrated history: hot-path
--     selection reads only these indexed columns.
--   * `ingestion_v2_shadow_comparisons` holds the latest Stage 1 shadow
--     comparison per source for the protected operations surface.
--
-- Every statement is `IF NOT EXISTS`; the migration is safe to re-run and does
-- not touch any legacy table.

CREATE TABLE IF NOT EXISTS ingestion_snapshots (
  source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  admission_version TEXT NOT NULL,
  document_count INTEGER NOT NULL CHECK(document_count >= 0),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  state TEXT NOT NULL CHECK(state IN ('staged', 'active', 'terminal', 'expired')),
  is_complete INTEGER NOT NULL CHECK(is_complete IN (0, 1)),
  baseline INTEGER NOT NULL CHECK(baseline IN (0, 1)),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  terminal_at TEXT,
  expires_at TEXT,
  PRIMARY KEY(source_id, snapshot_hash)
);

-- Snapshot terminality and cleanup: every row of a snapshot is terminal only
-- when no `ingestion_rows` row still references it.
CREATE INDEX IF NOT EXISTS ingestion_snapshots_hash
  ON ingestion_snapshots(snapshot_hash);

-- Snapshot expiry sweep after every referenced row reaches a terminal state.
CREATE INDEX IF NOT EXISTS ingestion_snapshots_expiry
  ON ingestion_snapshots(state, expires_at);

CREATE INDEX IF NOT EXISTS ingestion_snapshots_source_created
  ON ingestion_snapshots(source_id, created_at);

CREATE TABLE IF NOT EXISTS ingestion_rows (
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  material_hash TEXT NOT NULL,
  admission_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'queued', 'processing', 'settled', 'quarantined', 'absent')),
  decision TEXT CHECK(decision IS NULL OR decision IN ('admitted', 'blocked', 'shelved')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  retry_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  consecutive_omissions INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_omissions >= 0),
  job_id TEXT,
  failure_class TEXT,
  failure_detail TEXT,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  PRIMARY KEY(source_id, external_id)
);

-- Bounded work selection: pending/due rows in retry order.
CREATE INDEX IF NOT EXISTS ingestion_rows_work
  ON ingestion_rows(source_id, state, retry_at);

-- Policy migration: active rows settled under a superseded admission version.
CREATE INDEX IF NOT EXISTS ingestion_rows_policy
  ON ingestion_rows(source_id, admission_version, state);

-- Expired lease recovery across every source.
CREATE INDEX IF NOT EXISTS ingestion_rows_lease
  ON ingestion_rows(state, lease_expires_at);

-- Snapshot terminality and cleanup: which rows still reference a snapshot.
CREATE INDEX IF NOT EXISTS ingestion_rows_snapshot
  ON ingestion_rows(snapshot_hash);

-- Operations pagination in observation order.
CREATE INDEX IF NOT EXISTS ingestion_rows_observed
  ON ingestion_rows(source_id, last_observed_at);

CREATE TABLE IF NOT EXISTS ingestion_v2_shadow_comparisons (
  source_id TEXT PRIMARY KEY,
  snapshot_hash TEXT NOT NULL,
  admission_version TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK(complete IN (0, 1)),
  metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)),
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_count INTEGER NOT NULL DEFAULT 1 CHECK(run_count >= 1)
);

PRAGMA optimize;
