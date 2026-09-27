-- Resolver v3 gives ATS-tenant corroboration only to a provider candidate whose
-- domain names the employer. Repair any automatic identity whose older decision
-- selected a different domain while both providers nominated the tenant-named
-- domain. The task is made retryable so the normal scheduled resolver performs
-- the correction; no employer-specific mapping or icon is seeded here.
UPDATE canonical_employers AS employer
SET icon_key = CASE WHEN icon_source IN ('logo-dev', 'platform', 'domain-asset') THEN NULL ELSE icon_key END,
    icon_source = CASE WHEN icon_source IN ('logo-dev', 'platform', 'domain-asset') THEN NULL ELSE icon_source END,
    website_domain = NULL,
    website_domain_source = NULL,
    website_domain_reviewed_at = NULL,
    website_domain_reviewed_by = NULL,
    icon_resolution_status = NULL,
    icon_resolved_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE employer.id IN (
  SELECT mapping.canonical_employer_id
  FROM employer_mappings AS mapping
  JOIN employer_icon_resolutions AS resolution
    ON resolution.canonical_employer_id = mapping.canonical_employer_id
  WHERE mapping.reviewed_by = 'automatic-exact-ats-v1'
    AND mapping.superseded_at IS NULL
    AND resolution.status = 'resolved'
    -- The employer's own ATS declaration is stronger than a tenant-shaped
    -- provider result (for example, two unrelated companies can share a name).
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(resolution.evidence_json, '$.candidates') AS selected_candidate
      WHERE json_extract(selected_candidate.value, '$.domain') = resolution.selected_domain
        AND EXISTS (
          SELECT 1 FROM json_each(selected_candidate.value, '$.signals')
          WHERE value IN ('reviewed-domain', 'platform-website', 'jsonld-url')
        )
    )
    AND EXISTS (
      SELECT 1
      FROM json_each(resolution.evidence_json, '$.candidates') AS candidate
      WHERE replace(lower(substr(json_extract(candidate.value, '$.domain'), 1,
              instr(json_extract(candidate.value, '$.domain'), '.') - 1)), '-', '')
          = replace(lower(mapping.scope), '-', '')
        AND json_extract(candidate.value, '$.domain') <> resolution.selected_domain
        AND EXISTS (SELECT 1 FROM json_each(candidate.value, '$.signals') WHERE value = 'logo-dev')
        AND EXISTS (SELECT 1 FROM json_each(candidate.value, '$.signals') WHERE value = 'brandfetch')
    )
);

UPDATE employer_icon_resolutions AS resolution
SET status = 'retryable',
    selected_domain = NULL,
    selected_source = NULL,
    confidence = NULL,
    attempts = 0,
    next_retry_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    lease_token = NULL,
    lease_until = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE resolution.status = 'resolved'
  AND resolution.canonical_employer_id IN (
    SELECT mapping.canonical_employer_id
    FROM employer_mappings AS mapping
    WHERE mapping.reviewed_by = 'automatic-exact-ats-v1'
      AND mapping.superseded_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(resolution.evidence_json, '$.candidates') AS selected_candidate
        WHERE json_extract(selected_candidate.value, '$.domain') = resolution.selected_domain
          AND EXISTS (
            SELECT 1 FROM json_each(selected_candidate.value, '$.signals')
            WHERE value IN ('reviewed-domain', 'platform-website', 'jsonld-url')
          )
      )
      AND EXISTS (
        SELECT 1
        FROM json_each(resolution.evidence_json, '$.candidates') AS candidate
        WHERE replace(lower(substr(json_extract(candidate.value, '$.domain'), 1,
                instr(json_extract(candidate.value, '$.domain'), '.') - 1)), '-', '')
            = replace(lower(mapping.scope), '-', '')
          AND json_extract(candidate.value, '$.domain') <> resolution.selected_domain
          AND EXISTS (SELECT 1 FROM json_each(candidate.value, '$.signals') WHERE value = 'logo-dev')
          AND EXISTS (SELECT 1 FROM json_each(candidate.value, '$.signals') WHERE value = 'brandfetch')
      )
  );

PRAGMA optimize;
