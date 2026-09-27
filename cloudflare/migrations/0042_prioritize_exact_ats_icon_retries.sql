-- Strong exact-ATS repairs should not wait behind the ordinary icon coverage
-- backlog. This remains generic: it recognizes provider consensus for a domain
-- that names the immutable ATS tenant and does not seed any employer or icon.
UPDATE employer_icon_resolutions AS resolution
SET review_priority = MAX(review_priority, 100),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE resolution.status = 'retryable'
  AND resolution.selected_domain IS NULL
  AND resolution.attempts = 0
  AND EXISTS (
    SELECT 1
    FROM employer_mappings AS mapping
    JOIN canonical_employers AS employer
      ON employer.id = mapping.canonical_employer_id
    WHERE mapping.canonical_employer_id = resolution.canonical_employer_id
      AND mapping.reviewed_by = 'automatic-exact-ats-v1'
      AND mapping.superseded_at IS NULL
      AND employer.website_domain IS NULL
      AND EXISTS (
        SELECT 1
        FROM json_each(resolution.evidence_json, '$.candidates') AS candidate
        WHERE replace(lower(substr(json_extract(candidate.value, '$.domain'), 1,
                instr(json_extract(candidate.value, '$.domain'), '.') - 1)), '-', '')
            = replace(lower(mapping.scope), '-', '')
          AND EXISTS (SELECT 1 FROM json_each(candidate.value, '$.signals') WHERE value = 'logo-dev')
          AND EXISTS (SELECT 1 FROM json_each(candidate.value, '$.signals') WHERE value = 'brandfetch')
      )
  );

PRAGMA optimize;
