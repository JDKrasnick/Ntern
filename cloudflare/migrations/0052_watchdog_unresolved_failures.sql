-- Bound oldest-unresolved incident sampling without scanning resolved history.
CREATE INDEX IF NOT EXISTS queue_failure_unresolved_age
  ON queue_failure_events(first_failed_at, id, queue_name)
  WHERE resolved_at IS NULL;

-- Daily retention expires resolved receipts without scanning active incidents.
CREATE INDEX IF NOT EXISTS queue_failure_resolved_age
  ON queue_failure_events(resolved_at)
  WHERE resolved_at IS NOT NULL;
