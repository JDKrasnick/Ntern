-- Bound work-first dispatch independently of the fleet migration cursor.
CREATE INDEX IF NOT EXISTS ingestion_rows_ready_admission
  ON ingestion_rows(state, COALESCE(retry_at, updated_at), source_id)
  WHERE consecutive_omissions < 2;
