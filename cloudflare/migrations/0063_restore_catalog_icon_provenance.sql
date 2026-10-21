-- Old canonical tasks read raw role records that can lack source provenance.
-- The resolver now hydrates them from its current-manifest snapshot. Give only
-- those active, unreviewed misses one fresh attempt with the repaired evidence.
WITH reviewed_active AS MATERIALIZED (
  SELECT DISTINCT json_extract(item.value, '$.group.featuredRole.canonicalEmployerId') AS id
  FROM catalog_items AS current
  JOIN catalog_items AS manifest ON manifest.pk = 'CATALOG_PROJECTION#MANIFESTS'
    AND manifest.sk = json_extract(current.value, '$.version')
  CROSS JOIN json_each(manifest.value, '$.keys') AS manifest_key
  CROSS JOIN catalog_items AS item
  WHERE current.pk = 'CATALOG_PROJECTION' AND current.sk = 'CURRENT'
    AND item.pk = 'CATALOG_PROJECTION#GROUPS' AND item.sk = manifest_key.value
    AND json_extract(item.value, '$.group.featuredRole.sourceReferences[0].provenance')
      IN ('official-ats', 'official-structured', 'employer-submitted', 'reviewed-community')
), eligible AS (
  SELECT DISTINCT task.canonical_employer_id AS id
  FROM employer_icon_resolutions AS task
  JOIN canonical_employers AS employer ON employer.id = task.canonical_employer_id
  JOIN reviewed_active ON reviewed_active.id = employer.id
  WHERE task.status IN ('retryable', 'unresolved') AND task.next_retry_at IS NOT NULL
    AND task.review_priority < 50
    AND COALESCE(employer.icon_resolution_status, '') NOT IN ('resolved', 'invalidated')
    AND COALESCE(employer.icon_key, '') = '' AND COALESCE(employer.website_domain_source, '') <> 'reviewed'
    AND CASE WHEN json_valid(task.evidence_json) THEN json_extract(task.evidence_json, '$.provenance') END IS NULL
    AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions AS blocked
      WHERE blocked.canonical_employer_id = employer.id
        AND (blocked.status = 'invalidated' OR blocked.review_priority >= 50
          OR blocked.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
)
UPDATE canonical_employers SET icon_tie_break_at = NULL, icon_tie_break_fingerprint = NULL,
  icon_tie_break_input_tokens = NULL, icon_tie_break_output_tokens = NULL
WHERE id IN (SELECT id FROM eligible);

WITH reviewed_active AS MATERIALIZED (
  SELECT DISTINCT json_extract(item.value, '$.group.featuredRole.canonicalEmployerId') AS id
  FROM catalog_items AS current
  JOIN catalog_items AS manifest ON manifest.pk = 'CATALOG_PROJECTION#MANIFESTS'
    AND manifest.sk = json_extract(current.value, '$.version')
  CROSS JOIN json_each(manifest.value, '$.keys') AS manifest_key
  CROSS JOIN catalog_items AS item
  WHERE current.pk = 'CATALOG_PROJECTION' AND current.sk = 'CURRENT'
    AND item.pk = 'CATALOG_PROJECTION#GROUPS' AND item.sk = manifest_key.value
    AND json_extract(item.value, '$.group.featuredRole.sourceReferences[0].provenance')
      IN ('official-ats', 'official-structured', 'employer-submitted', 'reviewed-community')
)
UPDATE employer_icon_resolutions AS task
SET next_retry_at = '1970-01-01T00:00:00.000Z'
WHERE task.status IN ('retryable', 'unresolved') AND task.next_retry_at IS NOT NULL
  AND task.review_priority < 50
  AND task.canonical_employer_id IN (SELECT id FROM reviewed_active)
  AND CASE WHEN json_valid(task.evidence_json) THEN json_extract(task.evidence_json, '$.provenance') END IS NULL
  AND EXISTS (SELECT 1 FROM canonical_employers AS employer WHERE employer.id = task.canonical_employer_id
    AND COALESCE(employer.icon_resolution_status, '') NOT IN ('resolved', 'invalidated')
    AND COALESCE(employer.icon_key, '') = '' AND COALESCE(employer.website_domain_source, '') <> 'reviewed')
  AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions AS blocked
    WHERE blocked.canonical_employer_id = task.canonical_employer_id
      AND (blocked.status = 'invalidated' OR blocked.review_priority >= 50
        OR blocked.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
