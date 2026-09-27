-- Reviewed 2026-09-27 against the official employer-hosted iCIMS routes
-- currently present in the production catalog. These tenants are employer-
-- specific; shared/generic ATS hosts remain intentionally unmapped.

INSERT INTO canonical_employers
  (id, display_name, reviewed_at, reviewed_by, created_at, updated_at,
   website_domain, website_domain_source, website_domain_reviewed_at,
   website_domain_reviewed_by)
VALUES
  ('amd', 'AMD', '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27',
   '2026-09-27T00:00:00Z', '2026-09-27T00:00:00Z', 'amd.com', 'reviewed',
   '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27'),
  ('garmin', 'Garmin', '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27',
   '2026-09-27T00:00:00Z', '2026-09-27T00:00:00Z', 'garmin.com', 'reviewed',
   '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27'),
  ('keysight-technologies', 'Keysight Technologies', '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27',
   '2026-09-27T00:00:00Z', '2026-09-27T00:00:00Z', 'keysight.com', 'reviewed',
   '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27'),
  ('principal-financial-group', 'Principal Financial Group', '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27',
   '2026-09-27T00:00:00Z', '2026-09-27T00:00:00Z', 'principal.com', 'reviewed',
   '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27')
ON CONFLICT(id) DO NOTHING;

INSERT INTO employer_mappings
  (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
VALUES
  ('icon-coverage-2026-09-27-icims-amd', 'icims', 'amd', 'amd',
   '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27', '2026-09-27T00:00:00Z'),
  ('icon-coverage-2026-09-27-icims-garmin', 'icims', 'garmin', 'garmin',
   '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27', '2026-09-27T00:00:00Z'),
  ('icon-coverage-2026-09-27-icims-keysight', 'icims', 'keysight', 'keysight-technologies',
   '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27', '2026-09-27T00:00:00Z'),
  ('icon-coverage-2026-09-27-icims-principal', 'icims', 'principal', 'principal-financial-group',
   '2026-09-27T00:00:00Z', 'production-icon-coverage-review-2026-09-27', '2026-09-27T00:00:00Z');

PRAGMA optimize;
