-- Some Workday logo endpoints label real image bytes as text/plain.
-- Retry under byte-based asset recognition, with the same review boundaries.
-- Retry one active missing-icon task per identity under the new extractor.
-- Preserve all operator decisions, corporate-review holds and in-flight work.
WITH active AS MATERIALIZED (
  SELECT DISTINCT COALESCE(
      json_extract(item.value, '$.group.featuredRole.canonicalEmployerId'),
      json_extract(item.value, '$.group.featuredRole.companyIconId')) AS id
  FROM catalog_items AS current
  JOIN catalog_items AS manifest ON manifest.pk = 'CATALOG_PROJECTION#MANIFESTS'
    AND manifest.sk = json_extract(current.value, '$.version')
  CROSS JOIN json_each(manifest.value, '$.keys') AS manifest_key
  CROSS JOIN catalog_items AS item
  WHERE current.pk = 'CATALOG_PROJECTION' AND current.sk = 'CURRENT'
    AND item.pk = 'CATALOG_PROJECTION#GROUPS' AND item.sk = manifest_key.value
    AND json_extract(item.value, '$.group.featuredRole.officialApplyUrl')
      LIKE 'https://%.wd%.myworkdayjobs.com/%/job/%'
    AND json_extract(item.value, '$.group.featuredRole.sourceReferences[0].provenance')
      IN ('official-ats', 'official-structured', 'employer-submitted', 'reviewed-community')
), identities AS (
  SELECT id, icon_key, icon_resolution_status, website_domain_source FROM canonical_employers
  UNION ALL
  SELECT id, icon_key, icon_resolution_status, website_domain_source FROM company_icon_identities
), eligible AS (
  SELECT task.id, ROW_NUMBER() OVER (
      PARTITION BY task.canonical_employer_id ORDER BY task.attempts, task.id) AS position
  FROM employer_icon_resolutions AS task
  JOIN identities AS employer ON employer.id = task.canonical_employer_id
  JOIN active ON active.id = employer.id
  WHERE task.status IN ('retryable', 'unresolved') AND task.next_retry_at IS NOT NULL
    AND task.review_priority < 50
    AND COALESCE(employer.icon_key, '') = ''
    AND COALESCE(employer.icon_resolution_status, '') NOT IN ('resolved', 'invalidated')
    AND COALESCE(employer.website_domain_source, '') <> 'reviewed'
    AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions AS blocked
      WHERE blocked.canonical_employer_id = employer.id
        AND (blocked.status = 'invalidated' OR blocked.review_priority >= 50
          OR blocked.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
)
UPDATE employer_icon_resolutions SET next_retry_at = '1970-01-01T00:00:00.000Z'
WHERE id IN (SELECT id FROM eligible WHERE position = 1);
