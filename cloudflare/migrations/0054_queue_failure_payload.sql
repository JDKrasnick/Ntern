CREATE INDEX IF NOT EXISTS queue_failure_payload
  ON queue_failure_events(queue_name, payload_hash, last_failed_at DESC);
