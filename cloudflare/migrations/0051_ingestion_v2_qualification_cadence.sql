ALTER TABLE ingestion_snapshots ADD COLUMN complete_fetch_sequence INTEGER;
ALTER TABLE ingestion_rows ADD COLUMN complete_fetch_sequence INTEGER;
ALTER TABLE ingestion_rows ADD COLUMN qualification_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_rows ADD COLUMN qualification_observed_sequence INTEGER;
ALTER TABLE ingestion_rows ADD COLUMN qualification_complete_snapshots INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ingestion_rows_pending_qualification
  ON ingestion_rows(source_id, snapshot_hash, admission_version, complete_fetch_sequence, external_id)
  WHERE state = 'settled' AND qualification_pending = 1 AND notification_baseline = 0;
