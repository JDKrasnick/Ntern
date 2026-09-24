-- A receipt may precede a catalog projection. Keep it retryable until the
-- exact revision has been projected successfully.
ALTER TABLE shadow_publication_receipts ADD COLUMN projected_at TEXT;
CREATE INDEX shadow_publication_receipts_pending_projection
  ON shadow_publication_receipts(policy_version, projected_at, created_at);

CREATE TABLE shadow_publication_decisions (
  run_key TEXT NOT NULL REFERENCES shadow_extraction_runs(run_key),
  policy_version TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('skipped', 'receipted')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(run_key, policy_version)
);
