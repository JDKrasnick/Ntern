-- zapply-2027 was retired on 2026-09-14 after review: its rows reached employers
-- through the intermediary `zapply.jobs` redirect host, so they were withheld
-- from the catalog. Its occurrences and the roles only it listed stayed in the
-- catalog, and 848 of those roles dominated the unresolved-employer backlog as
-- dead rows that nothing would ever refresh.
--
-- Close the source's own open occurrences, then close each role whose only
-- references belong to it. Two groups are deliberately left alone: the 669 roles
-- another live source also lists (closing their references would change nothing
-- while the other reference keeps them open) and the 17 the catalog still shows
-- on fresh evidence (closing those would take live roles off the shelf). Only
-- roles that are already hidden are touched, so nothing a reader can see moves.

UPDATE catalog_items
SET value = json_set(value, '$.occurrence.state', 'closed')
WHERE kind = 'source-occurrence'
  AND source_id = 'zapply-2027'
  AND json_extract(value, '$.occurrence.state') = 'open';

UPDATE catalog_items AS job
SET value = json_set(
      job.value,
      '$.sourceReferences',
      (SELECT json_group_array(json_set(reference.value, '$.state', 'closed'))
       FROM json_each(json_extract(job.value, '$.sourceReferences')) AS reference),
      '$.open', json('false'),
      '$.lastSeenAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ),
    sms_pending = 0,
    digest_pending = 0
WHERE job.kind = 'internship'
  AND json_extract(job.value, '$.open') = 1
  AND job.catalog_state IS NULL
  AND EXISTS (
    SELECT 1 FROM json_each(json_extract(job.value, '$.sourceReferences')) AS reference
    WHERE json_extract(reference.value, '$.sourceId') = 'zapply-2027')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(json_extract(job.value, '$.sourceReferences')) AS reference
    WHERE json_extract(reference.value, '$.sourceId') <> 'zapply-2027'
      AND COALESCE(json_extract(reference.value, '$.state'), 'open') <> 'closed');

PRAGMA optimize;
