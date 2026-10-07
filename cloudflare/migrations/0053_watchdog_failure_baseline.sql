-- The watchdog first became active on 2026-10-07. Its initial reconciliation
-- found only pre-activation failures: later source successes covered 362 rows,
-- and the remaining rows belonged to retired sources. Preserve those records
-- as resolved receipts while keeping every incident from activation onward live.
UPDATE queue_failure_events
SET resolved_at = '2026-10-07T23:10:00.000Z'
WHERE resolved_at IS NULL
  AND last_failed_at < '2026-10-07T00:00:00.000Z';
