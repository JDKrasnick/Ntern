-- Brand assets belong to the canonical employer, never to a provider mapping.
-- Existing reviewed employers are backfilled deliberately; new ones are gated in
-- the operations API once their first-party R2 asset has been uploaded.
ALTER TABLE canonical_employers ADD COLUMN icon_key TEXT;
ALTER TABLE canonical_employers ADD COLUMN icon_updated_at TEXT;
