-- Posting-identity audit keyset scans filter by kind before walking (pk, sk).
CREATE INDEX IF NOT EXISTS catalog_items_kind_pk_sk
ON catalog_items(kind, pk, sk);

PRAGMA optimize;
