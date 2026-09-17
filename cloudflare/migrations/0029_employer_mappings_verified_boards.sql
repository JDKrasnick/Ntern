-- Ten official ATS boards held roles that were hidden only because their board
-- was missing from the reviewed employer registry: greenhouse-rocketlab,
-- greenhouse-spacex, lever-palantir, greenhouse-andurilindustries,
-- ashby-base-power, greenhouse-veeamsoftware, greenhouse-freeformfuturecorp,
-- greenhouse-neuralink, lever-hermeus, greenhouse-coinbase (306 open roles).
-- The directory gate is deliberate — a role is published only when its employer
-- is reviewed — and the owner verified these boards by hand, so they are
-- recorded here as reviewed mappings rather than bypassed.
--
-- SpaceX and Anduril stay quarantined for an unrelated reason (their boards
-- exceed the 16 MB response ceiling), so their roles publish only once that is
-- addressed; the mapping is correct either way.

INSERT INTO canonical_employers (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
VALUES
  ('rocket-lab', 'Rocket Lab', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('spacex', 'SpaceX', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('palantir', 'Palantir Technologies', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('anduril', 'Anduril Industries', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('base-power', 'Base Power', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('veeam', 'Veeam Software', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('freeform', 'Freeform', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('neuralink', 'Neuralink', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('hermeus', 'Hermeus', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z'),
  ('coinbase', 'Coinbase', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z');

INSERT INTO employer_mappings (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
VALUES
  ('owner-verified-2026-09-17-greenhouse-rocketlab', 'greenhouse', 'greenhouse-rocketlab', 'rocket-lab', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-greenhouse-spacex', 'greenhouse', 'greenhouse-spacex', 'spacex', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-lever-palantir', 'lever', 'lever-palantir', 'palantir', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-greenhouse-andurilindustries', 'greenhouse', 'greenhouse-andurilindustries', 'anduril', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-ashby-base-power', 'ashby', 'ashby-base-power', 'base-power', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-greenhouse-veeamsoftware', 'greenhouse', 'greenhouse-veeamsoftware', 'veeam', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-greenhouse-freeformfuturecorp', 'greenhouse', 'greenhouse-freeformfuturecorp', 'freeform', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-greenhouse-neuralink', 'greenhouse', 'greenhouse-neuralink', 'neuralink', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-lever-hermeus', 'lever', 'lever-hermeus', 'hermeus', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z'),
  ('owner-verified-2026-09-17-greenhouse-coinbase', 'greenhouse', 'greenhouse-coinbase', 'coinbase', '2026-09-17T00:00:00Z', 'owner-verified-boards-2026-09-17', '2026-09-17T00:00:00Z');

PRAGMA optimize;
