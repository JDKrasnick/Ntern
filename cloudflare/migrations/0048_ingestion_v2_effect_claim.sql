-- Forward-only upgrade for databases that applied the original Stage 1 schema.
-- Never add these columns by rewriting 0045: Wrangler records migration names.
ALTER TABLE ingestion_rows
  ADD COLUMN notification_baseline INTEGER NOT NULL DEFAULT 0
  CHECK(notification_baseline IN (0, 1));

-- Linearization marker written after evaluation and immediately before any
-- catalog or notification sink effect. A replacement identity clears it.
ALTER TABLE ingestion_rows
  ADD COLUMN effect_claimed_at TEXT;
