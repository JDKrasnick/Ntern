-- Automatic company-icon resolution.
--
-- `canonical_employers` keeps owning the durable icon reference: `icon_key` is
-- still the only public reference, and a reviewer-uploaded asset is still the
-- strongest possible answer. These columns record what the resolver concluded
-- and why, so an automatic decision can be revalidated on TTL or invalidated by a
-- wrong-icon report without touching the asset itself.
--
-- `icon_source` distinguishes a human decision from a machine one; invalidation
-- must never clear an icon a reviewer uploaded.
ALTER TABLE canonical_employers ADD COLUMN website_domain TEXT;
ALTER TABLE canonical_employers ADD COLUMN icon_source TEXT;
ALTER TABLE canonical_employers ADD COLUMN icon_resolution_status TEXT;
ALTER TABLE canonical_employers ADD COLUMN icon_resolved_at TEXT;
-- One bounded tie-breaker per employer per retry window, recorded where the
-- budget is enforced so a sweep cannot call the model twice for one employer.
ALTER TABLE canonical_employers ADD COLUMN icon_tie_break_at TEXT;
ALTER TABLE canonical_employers ADD COLUMN icon_tie_break_fingerprint TEXT;
ALTER TABLE canonical_employers ADD COLUMN icon_tie_break_input_tokens INTEGER;
ALTER TABLE canonical_employers ADD COLUMN icon_tie_break_output_tokens INTEGER;

-- One row per (employer, evidence fingerprint). A redelivered posting collapses
-- onto the same row; a posting carrying stronger evidence has a different
-- fingerprint and therefore supersedes the earlier attempt instead of racing it.
-- `next_retry_at` doubles as the revalidation deadline for a resolved row.
CREATE TABLE employer_icon_resolutions (
  id TEXT PRIMARY KEY,
  canonical_employer_id TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('resolved', 'unresolved', 'retryable', 'invalidated')),
  selected_domain TEXT,
  selected_source TEXT,
  confidence REAL,
  -- Bounded, normalized provenance: domains, matched metadata, scores, and
  -- decision reason codes. Never full page HTML and never a provider secret.
  evidence_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  lease_token TEXT,
  lease_until TEXT,
  -- Wrong-icon reports sort to the front of the exception queue.
  review_priority INTEGER NOT NULL DEFAULT 0,
  invalidated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(canonical_employer_id, evidence_fingerprint)
);

CREATE INDEX employer_icon_resolutions_due
  ON employer_icon_resolutions(next_retry_at, lease_until);
CREATE INDEX employer_icon_resolutions_employer
  ON employer_icon_resolutions(canonical_employer_id, status, review_priority);
