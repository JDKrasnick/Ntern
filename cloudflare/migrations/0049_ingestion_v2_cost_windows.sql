-- Bound ingestion V2 cost observability without adding a second write stream.
-- The existing per-source shadow comparison upsert maintains these tumbling
-- one-hour counters, which the scheduled ingestion-health check reads.

ALTER TABLE ingestion_v2_shadow_comparisons ADD COLUMN window_started_at TEXT;
ALTER TABLE ingestion_v2_shadow_comparisons ADD COLUMN window_run_count INTEGER NOT NULL DEFAULT 0 CHECK(window_run_count >= 0);
ALTER TABLE ingestion_v2_shadow_comparisons ADD COLUMN window_d1_rows_written INTEGER NOT NULL DEFAULT 0 CHECK(window_d1_rows_written >= 0);

