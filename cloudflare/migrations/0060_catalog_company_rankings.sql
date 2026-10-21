-- Ranking evidence for catalog labels is independent of employer admission.
-- A review here never grants employer identity, listing or alert eligibility.
CREATE TABLE catalog_company_rankings (
  company_key TEXT PRIMARY KEY NOT NULL CHECK(length(company_key) BETWEEN 1 AND 160),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
  ranking_json TEXT NOT NULL CHECK(json_valid(ranking_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
