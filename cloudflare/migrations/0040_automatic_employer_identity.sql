-- Remove the short-lived hand-curated icon coverage seed from development.
-- Production never received migration 0039, so these deletes are no-ops there.
DELETE FROM employer_mappings WHERE id LIKE 'icon-coverage-2026-09-27-%';
DELETE FROM canonical_employers
WHERE id IN ('amd', 'garmin', 'keysight-technologies', 'principal-financial-group')
  AND reviewed_by = 'production-icon-coverage-review-2026-09-27'
  AND NOT EXISTS (
    SELECT 1 FROM employer_mappings WHERE canonical_employer_id = canonical_employers.id
  );

-- One row summarizes one exact ATS tenant + employer label observed in one
-- complete source snapshot. Promotion requires one sole normalized label plus
-- either an exact tenant/label match or two distinct immutable posting IDs.
CREATE TABLE IF NOT EXISTS automatic_employer_identity_observations (
  provider TEXT NOT NULL,
  scope TEXT NOT NULL,
  source_id TEXT NOT NULL,
  fetch_sequence INTEGER NOT NULL CHECK(fetch_sequence > 0),
  label_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  posting_ids_json TEXT NOT NULL CHECK(json_valid(posting_ids_json)),
  posting_count INTEGER NOT NULL CHECK(posting_count > 0),
  sample_application_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(provider, scope, source_id, fetch_sequence, label_key)
);

CREATE INDEX IF NOT EXISTS automatic_employer_identity_scope
  ON automatic_employer_identity_observations(provider, scope, fetch_sequence);

PRAGMA optimize;
