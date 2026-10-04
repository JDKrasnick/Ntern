-- Ingestion V2 guarded Stage 3 bootstrap receipts, 2026-10-04.
--
-- One immutable receipt makes the source/snapshot bootstrap resumable and
-- idempotent. Repeating an apply for the same complete snapshot returns the
-- existing receipt and never reopens already-settled rows.

CREATE TABLE IF NOT EXISTS ingestion_v2_bootstrap_receipts (
  source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  admission_version TEXT NOT NULL,
  active_rows INTEGER NOT NULL CHECK(active_rows >= 0),
  actionable_rows INTEGER NOT NULL CHECK(actionable_rows >= 0),
  checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)),
  actor TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  PRIMARY KEY(source_id, snapshot_hash, admission_version)
);

CREATE INDEX IF NOT EXISTS ingestion_v2_bootstrap_receipts_applied
  ON ingestion_v2_bootstrap_receipts(applied_at, source_id);

PRAGMA optimize;
