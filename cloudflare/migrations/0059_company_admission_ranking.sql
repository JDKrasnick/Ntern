-- Automatic/legacy identities are explicitly neutral pending editorial review.
-- Identity verification and catalog eligibility do not depend on this field.
ALTER TABLE canonical_employers ADD COLUMN ranking_json TEXT
  DEFAULT '{"tier":"unrated","status":"pending","reason":"Company ranking awaits admission review.","sources":[],"aliases":[]}'
  CHECK (ranking_json IS NULL OR json_valid(ranking_json));
