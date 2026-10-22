-- Initial lookup plus retries at 5 minutes, 15 minutes, and one day, then stop.
-- Clear recurring retries left by the previous policy without disturbing holds
-- or live claims. The resolver also refuses to claim exhausted rows.
UPDATE employer_icon_resolutions
SET next_retry_at = NULL
WHERE status IN ('retryable', 'unresolved') AND attempts >= 4
  AND review_priority NOT BETWEEN 50 AND 99
  AND next_retry_at IS NOT NULL
  AND (lease_until IS NULL OR lease_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
