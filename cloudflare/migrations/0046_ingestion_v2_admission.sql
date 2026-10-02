-- Ingestion V2 fault-isolated admission (Stage 2), 2026-10-01.
--
-- Additive-only durable state for the dedicated admission queue:
--
--   * `ingestion_admission_handoffs` records a durable receipt for every
--     admission message a dispatcher handed to the queue. A message is only
--     considered dispatched while its handoff is unacknowledged and fresh, so a
--     repeated dispatcher run cannot create duplicate logical work and a failed
--     queue handoff remains recoverable once the handoff goes stale.
--
-- The per-row lease, attempt, retry, decision, and failure columns already exist
-- on `ingestion_rows` (0045); this migration only adds the handoff ledger and
-- its bounded lookup index. Every statement is `IF NOT EXISTS`.

CREATE TABLE IF NOT EXISTS ingestion_admission_handoffs (
  batch_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  admission_version TEXT NOT NULL,
  baseline INTEGER NOT NULL CHECK(baseline IN (0, 1)),
  external_ids TEXT NOT NULL CHECK(json_valid(external_ids)),
  dispatched_at TEXT NOT NULL,
  acknowledged_at TEXT
);

-- Fresh, unacknowledged handoffs for one source.
CREATE INDEX IF NOT EXISTS ingestion_admission_handoffs_active
  ON ingestion_admission_handoffs(source_id, acknowledged_at, dispatched_at);

PRAGMA optimize;
