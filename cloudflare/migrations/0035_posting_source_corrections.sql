-- Issue #262 reviewed re-anchors, 2026-09-24, plus the presentation reviews
-- recorded in the same pass.
--
-- `posting_url_corrections`: a community list keeps publishing an application
-- URL the employer has republished under a new immutable posting id. The stale
-- URL still resolves, and the employer's own page declares the current id as
-- its canonical URL. The correction re-anchors only that exact provider
-- identity; it never rewrites the source row's provenance.
--
-- The ledger is append-only and validates its evidence hash and exact provider
-- identity at runtime, like `posting_identity_presentation_reviews`.

CREATE TABLE posting_url_corrections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  tenant TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  observed_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  UNIQUE (provider, tenant, posting_id)
);

CREATE TRIGGER posting_url_corrections_no_update
BEFORE UPDATE ON posting_url_corrections
BEGIN
  SELECT RAISE(ABORT, 'posting URL corrections are immutable');
END;

CREATE TRIGGER posting_url_corrections_no_delete
BEFORE DELETE ON posting_url_corrections
BEGIN
  SELECT RAISE(ABORT, 'posting URL corrections are immutable');
END;

INSERT INTO posting_url_corrections
  (id, provider, tenant, posting_id, observed_url, canonical_url, evidence_url, evidence_hash, reviewed_at, reviewed_by)
VALUES
  (
    'pr262-correct-gdmsi-744000146822449',
    'smartrecruiters',
    'gdmsi',
    '744000146822449',
    'https://jobs.smartrecruiters.com/GDMSI/744000146822449',
    'https://jobs.smartrecruiters.com/GDMSI/744000147561809-co-op-winter-2027-software-engineering-8-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000146822449',
    '40754fcd4efdae972b58a7ced0d7980b936916ec6c7a49cef84f21b58331e59b',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-correct-gdmsi-744000146985399',
    'smartrecruiters',
    'gdmsi',
    '744000146985399',
    'https://jobs.smartrecruiters.com/GDMSI/744000146985399',
    'https://jobs.smartrecruiters.com/GDMSI/744000147556214-co-op-winter-2027-software-engineering-developer-16-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000146985399',
    '461de6e3d50b11b5e3f6ea293fd4b36bf3e2e5c9abbbc44b07707f3fa3879729',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-correct-gdmsi-744000147019949',
    'smartrecruiters',
    'gdmsi',
    '744000147019949',
    'https://jobs.smartrecruiters.com/GDMSI/744000147019949',
    'https://jobs.smartrecruiters.com/GDMSI/744000147554134-co-op-winter-2027-software-developer-8-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000147019949',
    '2678fd906a7efa038b2dfe2acd936e9ee42c0a18be30420c399e7d36b177ca06',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-correct-gdmsi-744000147563929',
    'smartrecruiters',
    'gdmsi',
    '744000147563929',
    'https://jobs.smartrecruiters.com/GDMSI/744000147563929',
    'https://jobs.smartrecruiters.com/GDMSI/744000149415235-co-op-winter-2027-software-engineering-taccis-solutions-12-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000147563929',
    'c80f2a9454a574e8b46fd1bdd00b710cacbc7b3d99f5140e712faeb385a691b0',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-correct-gdmsi-744000147583700',
    'smartrecruiters',
    'gdmsi',
    '744000147583700',
    'https://jobs.smartrecruiters.com/GDMSI/744000147583700',
    'https://jobs.smartrecruiters.com/GDMSI/744000151059868-co-op-winter-2027-software-engineering-4-8-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000147583700',
    '0a6a97b6d50038c9ce132077eea296231586506962ea8f996592af0ce7d61ac1',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  );

INSERT INTO posting_identity_presentation_reviews
  (id, provider, tenant, posting_id, company, title, location, locations_json,
   apply_url, evidence_url, evidence_hash, reviewed_at, reviewed_by)
VALUES
  (
    'pr262-icims-11013',
    'icims',
    'gsk-us-earlytalent',
    '11013',
    'GSK',
    'Winter Co-op/Web App Developer',
    'US-Cambridge MA/Hybrid',
    '["US-Cambridge MA/Hybrid"]',
    'https://gsk-us-earlytalent.icims.com/jobs/11013/winter-co-op-web-app-developer/job?mobile=true&needsRedirect=false',
    'https://gsk-us-earlytalent.icims.com/jobs/11013/winter-co-op-web-app-developer/job?mobile=true&needsRedirect=false',
    '262388e17280c82aa810de183836e5eb02de99434f2099d5f1be1156de8468f9',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-gdmsi-744000147561809',
    'smartrecruiters',
    'gdmsi',
    '744000147561809',
    'General Dynamics Mission Systems',
    'Co-op Winter 2027 - Software Engineering - 8 Months',
    '1941 Robertson Road, Ottawa, Ontario, Canada',
    '["1941 Robertson Road, Ottawa, Ontario, Canada"]',
    'https://jobs.smartrecruiters.com/GDMSI/744000147561809-co-op-winter-2027-software-engineering-8-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000147561809-co-op-winter-2027-software-engineering-8-months',
    '185bd0c0ef82cc85d5d3dcf1a0c475a9bb59080225dc9efa9bb462e7c012ae60',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-gdmsi-744000147556214',
    'smartrecruiters',
    'gdmsi',
    '744000147556214',
    'General Dynamics Mission Systems',
    'Co-op Winter 2027 - Software Engineering Developer - 16-Months',
    '1120 68 St SE #110, Calgary, AB T2A 7B2, Canada',
    '["1120 68 St SE #110, Calgary, AB T2A 7B2, Canada"]',
    'https://jobs.smartrecruiters.com/GDMSI/744000147556214-co-op-winter-2027-software-engineering-developer-16-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000147556214-co-op-winter-2027-software-engineering-developer-16-months',
    'ceb3dd996f7490ff3ce6faab01bde689a9026b38febb67c9991d781d8f6934f0',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-gdmsi-744000147554134',
    'smartrecruiters',
    'gdmsi',
    '744000147554134',
    'General Dynamics Mission Systems',
    'Co-op Winter 2027 - Software Developer - 8 Months',
    '1941 Robertson Road, Ottawa, Ontario, Canada',
    '["1941 Robertson Road, Ottawa, Ontario, Canada"]',
    'https://jobs.smartrecruiters.com/GDMSI/744000147554134-co-op-winter-2027-software-developer-8-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000147554134-co-op-winter-2027-software-developer-8-months',
    '3276b7ae019ec5574bde89988974043e920a85d34d1479cc06e8db016c5c67be',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-gdmsi-744000149415235',
    'smartrecruiters',
    'gdmsi',
    '744000149415235',
    'General Dynamics Mission Systems',
    'Co-op Winter 2027 - Software Engineering (TacCIS Solutions) -12 Months',
    '1120 68 Ave NE #110, Calgary, AB T2E 8S5, Canada',
    '["1120 68 Ave NE #110, Calgary, AB T2E 8S5, Canada"]',
    'https://jobs.smartrecruiters.com/GDMSI/744000149415235-co-op-winter-2027-software-engineering-taccis-solutions-12-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000149415235-co-op-winter-2027-software-engineering-taccis-solutions-12-months',
    'eb42868f1d8b7e6cad32cb0cf5b54b74c8ff60218a70b67012e29effe225a5f6',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-gdmsi-744000151059868',
    'smartrecruiters',
    'gdmsi',
    '744000151059868',
    'General Dynamics Mission Systems',
    'Co-op Winter 2027 - Software Engineering - 4-8 months',
    '31 Millbrook Avenue, Cole Harbour, Nova Scotia, Canada',
    '["31 Millbrook Avenue, Cole Harbour, Nova Scotia, Canada"]',
    'https://jobs.smartrecruiters.com/GDMSI/744000151059868-co-op-winter-2027-software-engineering-4-8-months',
    'https://jobs.smartrecruiters.com/GDMSI/744000151059868-co-op-winter-2027-software-engineering-4-8-months',
    'f589a3a44ff3bf7a59649e07e56b11a035466a7a3b4616f06637aa26ee122069',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  );
