-- Quarantine repair, 2026-09-25.
--
-- Seven sources were sitting in `quarantined` state. Four are boards that no
-- longer exist upstream and are already absent from the checked-in reviewed
-- registries, but their retained D1 rows kept a stale quarantine (and its
-- alerting) alive: greenhouse-matx, greenhouse-iherb, greenhouse-postman and
-- lever-calstart. `zapply-2027` was retired on 2026-09-14 but only its catalog
-- occurrences were closed; its health/dispatch/checkpoint rows remained.
--
-- Two sources are live but were quarantined for reasons that no longer hold:
-- `ashby-odin-dynamics` moved its Ashby board from `odin-dynamics` to `odin`,
-- and `lever-evrealty-us` is genuinely empty (its careers page still links the
-- Lever site). Those rows keep their shadow state; only the board key and the
-- empty-board acknowledgement change, and the stale health row is cleared so
-- the next provider sweep re-validates them.
--
-- Retiring a source means setting its registry state to `disabled` and removing
-- the derived health/dispatch/checkpoint rows; the reviewed config stays for
-- audit. This is idempotent: sources that were never seeded, or that were
-- already repaired, are simply not matched.

UPDATE reviewed_source_registry
   SET state = 'disabled',
       updated_at = '2026-09-25T17:37:40.000Z'
 WHERE source_id IN ('greenhouse-matx', 'greenhouse-iherb', 'greenhouse-postman', 'lever-calstart');

UPDATE reviewed_source_registry
   SET config_json = json_set(config_json, '$.identity.boardKey', 'odin'),
       updated_at = '2026-09-25T17:37:40.000Z'
 WHERE source_id = 'ashby-odin-dynamics';

UPDATE reviewed_source_registry
   SET config_json = json_set(
         config_json,
         '$.emptyBoardAcknowledged',
         json_object(
           'acknowledgedBy', 'JDKrasnick',
           'acknowledgedAt', '2026-09-25T17:37:40.000Z',
           'reason', 'No open roles as of 2026-09-25; evrealtyus.com still links jobs.lever.co/evrealty-us')),
       updated_at = '2026-09-25T17:37:40.000Z'
 WHERE source_id = 'lever-evrealty-us';

DELETE FROM catalog_items
 WHERE pk IN (
         'SOURCE#zapply-2027',
         'SOURCE#greenhouse-matx',
         'SOURCE#greenhouse-iherb',
         'SOURCE#greenhouse-postman',
         'SOURCE#lever-calstart',
         'SOURCE#ashby-odin-dynamics',
         'SOURCE#lever-evrealty-us')
   AND sk IN ('HEALTH', 'DISPATCH', 'CHECKPOINT');

PRAGMA optimize;
