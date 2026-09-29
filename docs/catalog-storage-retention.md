# Catalog storage retention

## Why

D1 has a hard 10 GB size limit per paid database. Production reached 6.87 GB
with 1,291,564 `catalog_items` rows, the bulk of it historical: source
occurrences, the notification outbox, closed internships, and role-metadata
evidence history. None of those rows had a delete path, so the database grew
without bound and a few unrelated queries could be exposed to D1 pressure as the
keyspace and its indexes grew.

This is not about read latency in the normal case — unpaged scans were the
measured cause of overloads and are already bounded ([#197](197-ingestion-resource-bounds.md)).
It is about staying ahead of the cap, where writes start failing and the catalog
projection freezes.

## Policy

The daily `34 8 * * *` maintenance cron runs `runCatalogRetention`
([`cloudflare/catalog-retention.ts`](../cloudflare/catalog-retention.ts)) with
`apply: true`. The minute deliberately avoids every provider dispatch cron
(`2,32` Ashby, `12,42` Greenhouse, `22,52` Lever, and the `*/5`/`7-57/10`/`9-59/10`/`1-51/10`
cadences): the retention pass is write-heavy, and running it on the same minute as
a greenhouse dispatch overloaded D1 and dead-lettered that dispatch's polls.

Every sweep keeps what a live reader needs and deletes only history:

| Sweep | Retention | What it removes | What it keeps |
| --- | --- | --- | --- |
| Notification events (`kind = 'notification-event'`) | 30 days | Outbox rows already consumed by the notification drain and past the operator recovery look-back | Anything inside the recovery window; the recovery endpoint rejects an older `since` value instead of returning a silently truncated result |
| Closed internships (`kind = 'internship'`, `catalog_state = 'CLOSED'`) | 365 days since `lastSeenAt` | The job row, its per-source occurrences (named by its own `sourceReferences`), and its complete job-scoped role-metadata acquisition/review/repair lifecycle | Open roles and closed roles still inside the window; each saved application receives a compact presentation snapshot before its catalog parent disappears, so company/title/location remain visible without retaining the application URL |
| Closed source occurrences (`kind = 'source-occurrence'`, `occurrence.state = 'closed'`) | 180 days since `changedAt` | A source's own record that it dropped a posting | Occurrences the source still lists, and any occurrence inside the window |
| Superseded evidence (`role_metadata_evidence.is_current = 0`) | 180 days | Historical evidence rows | The current evidence set |
| Extraction attempts | 180 days | Older attempts, keeping the newest per `(job_id, source_id)` | The freshness row that coverage and candidate selection read |
| Resolved conflicts (`role_metadata_conflicts.state = 'resolved'`) | 180 days | Settled conflicts | Open conflicts |

Each pass is bounded (200 rows, 25 jobs). The daily cron repeats full passes for
at most 20 seconds or 100 passes, then reports which classes still have eligible
backlog. This lets a large initial backlog drain at the database's available
throughput without turning one scheduled invocation into an unbounded job. The
metadata sweeps are isolated behind a `try`/`catch`, so a table that a migration
has not yet added cannot block catalog reclamation. The maintenance step runs
inside `runScheduledStep`, so a failure is logged and the rest of the cron
continues.

Mutable rows are never deleted from a stale selection. Timestamp and metadata
sweeps select and delete inside one SQLite statement. A closed job and its
dependent rows are deleted in one D1 batch transaction; every child statement
rechecks the exact selected parent, and the primary key remains authoritative if
embedded JSON disagrees. The same transaction snapshots saved-application
presentation first and refuses the parent delete while any referencing
application lacks that snapshot. The per-job metadata revision is deleted after
the parent because the catalog-delete trigger recreates it.

Whole-row deletion is what reclaims bytes; field-level compaction was
deliberately not used. A stored source occurrence feeds
`mergeSourceOccurrence`, which reads `admission`, `metadataEvidence`,
`providerEvidence`, `provenance`, and `firstAttachedAt` from the previous row, so
stripping fields would risk identity-repair correctness for a modest saving
against deleting the row outright at the end of its window.

## Indexes

Migration `0038_catalog_retention_indexes.sql` adds the indexes each sweep needs
so it never scans the whole `catalog_items` keyspace on a multi-gigabyte
database:

- `catalog_items_notification_event_created` — partial expression index on
  `coalesce(json_extract(value, '$.createdAt'), '')` where the row is a
  notification event.
- `catalog_items_source_occurrence_closed_changed` — partial expression index on
  `coalesce(json_extract(value, '$.changedAt'), '')` where the row is a closed
  source occurrence. The query expressions match these indexes exactly, and the
  regression suite requires SQLite to choose range searches rather than scans.
- `user_items_application_job` — partial expression index on application
  `jobId`, used to snapshot every saved reference without scanning private user
  data once per expired job.
- `role_metadata_evidence_retention`, `role_metadata_extraction_observed`,
  `role_metadata_conflicts_resolved` — retention-leading indexes on the history
  tables.

Closed internships reuse the existing `catalog_items_state_sort`
(`catalog_state, catalog_sort_key`), whose closed value is
`<lastSeenAt>#<jobId>`, so the cutoff is a lexical comparison.

## Operating it

- Dry run: call `runCatalogRetention(db, { now })` without `apply`; it returns
  the same report without writing.
- Notification recovery accepts a `since` value only inside the same 30-day
  window. An older request returns `400` with `earliestSupportedSince`; use that
  boundary or a newer timestamp before previewing the candidate set.
- The cron logs the report on `employer_maintenance_complete` as
  `catalogRetention`, with counts, pass count, time-budget state, and exact
  remaining-backlog booleans. Any `remaining` value that stays true across runs
  is a capacity signal, not a successful drain.
- Narrow the batch sizes (`rowBatchSize`, `jobBatchSize`) to drain a large
  backlog more gradually; widen the retention windows only with an owner
  decision, since they bound how long a delisted role stays resolvable.
- This is the first line of defense. If ingestion volume ever outgrows a
  bounded window, the durable next step is a hot/cold split — keep the open
  catalog in D1 and move closed history to R2 (already the primary catalog read
  model) or a second D1 database.

## Verification

`test/catalog-retention.test.ts` covers each sweep: a dry run reports without
deleting, expired rows are removed while live and recent rows are kept, a closed
job is removed with its occurrences and full-schema metadata lifecycle, a legacy
saved application is snapshotted and still renders company/title/location through
the real D1/API path, concurrent reopen and embedded identity mismatch cases
preserve live data, the newest attempt survives, multi-pass work stays bounded,
and the retention predicates retain indexed query plans.
