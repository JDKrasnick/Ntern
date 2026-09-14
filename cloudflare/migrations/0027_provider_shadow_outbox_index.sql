-- The provider-shadow handoff recovery query runs frequently and must not scan
-- the entire catalog as the job catalog grows.
CREATE INDEX catalog_items_pending_provider_shadow_handoffs
ON catalog_items(kind, sk)
WHERE kind = 'provider-shadow-verification' AND sk = 'PENDING';

PRAGMA optimize;
