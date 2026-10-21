-- These reviewed Greenhouse registry IDs already occur in the active catalog,
-- but V2 emitted them without registering their canonical employer. Insert only:
-- never overwrite an operator's identity, relationships, ranking, or icon.
WITH reviewed_sources(id, display_name) AS (VALUES
  ('waymo', 'Waymo'),
  ('flyzipline', 'Zipline'),
  ('epicgames', 'Epic Games'),
  ('lyft', 'Lyft'),
  ('formlabs', 'Formlabs'),
  ('towerresearchcapital', 'Tower Research Capital'),
  ('interstates', 'Interstates'),
  ('akunacapital', 'Akuna Capital'),
  ('oldmissioncapital', 'Old Mission Capital'),
  ('wehrtyou', 'Hudson River Trading'),
  ('awardco', 'Awardco'),
  ('duolingo', 'Duolingo'),
  ('samsara', 'Samsara'),
  ('trillium', 'Trillium'),
  ('symphony', 'Symphony Communication Services'),
  ('helsing', 'Helsing'),
  ('kinexon', 'KINEXON'),
  ('upstart', 'Upstart'),
  ('workato', 'Workato')
)
INSERT INTO canonical_employers
  (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
SELECT id, display_name, '2026-10-21T00:00:00.000Z', 'reviewed-source-registry',
  '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'
FROM reviewed_sources WHERE true ON CONFLICT(id) DO NOTHING;

-- Give unresolved identity cases one new model window under resolver v5.
-- Keep resolved/withdrawn/reviewer-owned icons and corporate review holds intact.
UPDATE canonical_employers
SET icon_tie_break_at = NULL, icon_tie_break_fingerprint = NULL
WHERE icon_key IS NULL AND icon_resolution_status IS NOT 'resolved'
  AND icon_resolution_status IS NOT 'invalidated'
  AND COALESCE(website_domain_source, '') <> 'reviewed'
  AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions AS held
    WHERE held.canonical_employer_id = canonical_employers.id
      AND (held.status = 'invalidated' OR json_extract(held.evidence_json, '$.reasonCode') = 'corporate-redirect-review'));

UPDATE employer_icon_resolutions
SET next_retry_at = '1970-01-01T00:00:00.000Z', attempts = 0
WHERE status IN ('unresolved', 'retryable')
  AND COALESCE(json_extract(evidence_json, '$.reasonCode'), '') <> 'corporate-redirect-review'
  AND EXISTS (SELECT 1 FROM canonical_employers AS employer
    WHERE employer.id = employer_icon_resolutions.canonical_employer_id
      AND employer.icon_key IS NULL AND employer.icon_resolution_status IS NOT 'resolved'
      AND employer.icon_resolution_status IS NOT 'invalidated'
      AND COALESCE(employer.website_domain_source, '') <> 'reviewed')
  AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions AS held
    WHERE held.canonical_employer_id = employer_icon_resolutions.canonical_employer_id
      AND (held.status = 'invalidated' OR json_extract(held.evidence_json, '$.reasonCode') = 'corporate-redirect-review'));
