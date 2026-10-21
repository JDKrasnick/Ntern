-- Icon-only identities never grant canonical employer, admission, or ranking authority.
CREATE TABLE company_icon_identities (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  name_key TEXT NOT NULL,
  seed_json TEXT NOT NULL,
  donor_employer_id TEXT,
  icon_key TEXT,
  icon_source TEXT,
  icon_resolution_status TEXT,
  icon_resolved_at TEXT,
  icon_updated_at TEXT,
  website_domain TEXT,
  website_domain_source TEXT,
  website_domain_reviewed_at TEXT,
  website_domain_reviewed_by TEXT,
  icon_tie_break_at TEXT,
  icon_tie_break_fingerprint TEXT,
  icon_tie_break_input_tokens INTEGER,
  icon_tie_break_output_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX company_icon_identities_scope_name ON company_icon_identities(scope, name_key);
