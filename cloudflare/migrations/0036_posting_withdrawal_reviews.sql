-- Issue #262 reviewed withdrawals, 2026-09-24. The employer page for each of
-- these exact identities is gone: the tenant returns HTTP 410 with the
-- employer's own "the job ... is no longer open" message. A withdrawn identity
-- contributes no repair evidence and its catalog record stays closed while a
-- community list still publishes the dead URL, so the posting is retired rather
-- than merged. The ledger is append-only and validates its evidence hash and
-- exact provider identity at runtime.

CREATE TABLE posting_withdrawal_reviews (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  tenant TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
  reviewed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  UNIQUE (provider, tenant, posting_id)
);

CREATE TRIGGER posting_withdrawal_reviews_no_update
BEFORE UPDATE ON posting_withdrawal_reviews
BEGIN
  SELECT RAISE(ABORT, 'posting withdrawal reviews are immutable');
END;

CREATE TRIGGER posting_withdrawal_reviews_no_delete
BEFORE DELETE ON posting_withdrawal_reviews
BEGIN
  SELECT RAISE(ABORT, 'posting withdrawal reviews are immutable');
END;

INSERT INTO posting_withdrawal_reviews
  (id, provider, tenant, posting_id, evidence_url, evidence_hash, reviewed_at, reviewed_by)
VALUES
  (
    'pr262-withdraw-cesi-11204',
    'icims',
    'jobs-cesi',
    '11204',
    'https://jobs-cesi.icims.com/jobs/11204/job?mobile=true&needsRedirect=false&utm_source=Simplify&ref=Simplify',
    '31cf3c1dac6ebb9011d075eedd14b16a065050332d816786505e1cc1db8ce824',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  ),
  (
    'pr262-withdraw-cesi-11206',
    'icims',
    'jobs-cesi',
    '11206',
    'https://jobs-cesi.icims.com/jobs/11206/job?mobile=true&needsRedirect=false&utm_source=Simplify&ref=Simplify',
    '70730566a08ee4944259445c113c919eb9b25abc7cc9374adc111fe229e7551a',
    '2026-09-24T00:00:00Z',
    'owner-directed-official-page-review'
  );
