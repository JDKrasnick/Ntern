-- Saved-application snapshot lookup for catalog retention, 2026-09-28.
--
-- Migration 0038 was already applied in production before saved-role snapshots
-- joined the retention contract. Keep that migration immutable and add the
-- lookup index forward so existing databases receive it too.

CREATE INDEX IF NOT EXISTS user_items_application_job
ON user_items(json_extract(value, '$.jobId'))
WHERE kind = 'application';
