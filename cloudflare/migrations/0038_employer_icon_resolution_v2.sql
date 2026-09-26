-- Durable provenance for reviewed employer domains. Automatic resolution may
-- refresh machine evidence, but it must never overwrite a person's decision.
ALTER TABLE canonical_employers ADD COLUMN website_domain_source TEXT
  CHECK (website_domain_source IS NULL OR website_domain_source IN ('automatic', 'reviewed'));
ALTER TABLE canonical_employers ADD COLUMN website_domain_reviewed_at TEXT;
ALTER TABLE canonical_employers ADD COLUMN website_domain_reviewed_by TEXT;

UPDATE canonical_employers
SET website_domain_source = 'reviewed',
    website_domain_reviewed_at = COALESCE(icon_resolved_at, updated_at),
    website_domain_reviewed_by = 'employer-icon-operations'
WHERE website_domain IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM employer_icon_resolutions AS resolution
    WHERE resolution.canonical_employer_id = canonical_employers.id
      AND resolution.selected_source = 'reviewed'
      AND resolution.selected_domain = canonical_employers.website_domain
  );

UPDATE canonical_employers
SET website_domain_source = 'automatic'
WHERE website_domain IS NOT NULL AND website_domain_source IS NULL;

-- Resolver v2 changes candidate authority and redirect handling. Re-run old
-- non-terminal decisions immediately instead of waiting out their old backoff.
UPDATE employer_icon_resolutions
SET next_retry_at = '1970-01-01T00:00:00.000Z',
    evidence_json = CASE WHEN json_valid(evidence_json)
      THEN json_set(evidence_json, '$.resolverVersion', 2) ELSE evidence_json END
WHERE status IN ('unresolved', 'retryable');
