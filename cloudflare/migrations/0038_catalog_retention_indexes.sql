-- Catalog retention sweeps, 2026-09-27.
--
-- The daily maintenance run prunes append-only catalog history so the D1
-- database does not grow toward its 10 GB ceiling forever. Each sweep needs an
-- index that reaches only its own rows; without one it would scan the whole
-- `catalog_items` keyspace on a multi-gigabyte database.
--
-- `catalog_items_state_sort` already covers closed internships by
-- `catalog_state`. These partial expression indexes cover notification events
-- by `createdAt` and closed source occurrences by their last change, so those
-- sweeps stay bounded. The role-metadata history tables are small but their
-- existing indexes do not lead with the retention column.

CREATE INDEX IF NOT EXISTS catalog_items_notification_event_created
ON catalog_items(coalesce(json_extract(value, '$.createdAt'), ''))
WHERE kind = 'notification-event';

CREATE INDEX IF NOT EXISTS catalog_items_source_occurrence_closed_changed
ON catalog_items(coalesce(json_extract(value, '$.changedAt'), ''))
WHERE kind = 'source-occurrence' AND json_extract(value, '$.occurrence.state') = 'closed';

-- Snapshot lookup for applications whose catalog parent is about to expire.
CREATE INDEX IF NOT EXISTS user_items_application_job
ON user_items(json_extract(value, '$.jobId'))
WHERE kind = 'application';

CREATE INDEX IF NOT EXISTS role_metadata_evidence_retention
ON role_metadata_evidence(is_current, observed_at);

CREATE INDEX IF NOT EXISTS role_metadata_extraction_observed
ON role_metadata_extraction_attempts(observed_at);

CREATE INDEX IF NOT EXISTS role_metadata_conflicts_resolved
ON role_metadata_conflicts(state, updated_at);

PRAGMA optimize;
