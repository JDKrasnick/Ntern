-- Persist negative catalog work independently of snapshot/diff progress.
ALTER TABLE ingestion_rows ADD COLUMN closure_pending INTEGER NOT NULL DEFAULT 0
  CHECK (closure_pending IN (0, 1));
UPDATE ingestion_rows SET closure_pending = 1
  WHERE consecutive_omissions >= 2;
CREATE INDEX ingestion_rows_pending_closure
  ON ingestion_rows(source_id, effect_claimed_at, external_id) WHERE closure_pending = 1;
