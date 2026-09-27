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

The daily `42 8 * * *` maintenance cron runs `runCatalogRetention`
([`cloudflare/catalog-retention.ts`](../cloudflare/catalog-retention.ts)) with
`apply: true`. Every sweep keeps what a live reader needs and deletes only
history:

| Sweep | Retention | What it removes | What it keeps |
| --- | --- | --- | --- |
| Notification events (`kind = 'notification-event'`) | 30 days | Outbox rows already consumed by the notification drain and past the operator recovery look-back | Anything inside the recovery window |
| Closed internships (`kind = 'internship'`, `catalog_state = 'CLOSED'`) | 365 days since `lastSeenAt` | The job row, its per-source occurrences (named by its own `sourceReferences`), and `role_metadata_*` rows keyed by job id | Open roles, and closed roles still inside the window; the saved-application record is untouched and renders the existing "role unavailable" state |
| Closed source occurrences (`kind = 'source-occurrence'`, `occurrence.state = 'closed'`) | 180 days since `changedAt` | A source's own record that it dropped a posting | Occurrences the source still lists, and any occurrence inside the window |
| Superseded evidence (`role_metadata_evidence.is_current = 0`) | 180 days | Historical evidence rows | The current evidence set |
| Extraction attempts | 180 days | Older attempts, keeping the newest per `(job_id, source_id)` | The freshness row that coverage and candidate selection read |
| Resolved conflicts (`role_metadata_conflicts.state = 'resolved'`) | 180 days | Settled conflicts | Open conflicts |

The three catalog sweeps are bounded per run (200 rows, 25 jobs). The metadata
sweeps are isolated behind a `try`/`catch`, so a table that a migration has not
yet added cannot block catalog reclamation. The maintenance step runs inside
`runScheduledStep`, so a failure is logged and the rest of the cron continues.

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
  `json_extract(value, '$.createdAt')` where the row is a notification event.
- `catalog_items_source_occurrence_closed_changed` — partial expression index on
  `json_extract(value, '$.changedAt')` where the row is a closed source
  occurrence.
- `role_metadata_evidence_retention`, `role_metadata_extraction_observed`,
  `role_metadata_conflicts_resolved` — retention-leading indexes on the history
  tables.

Closed internships reuse the existing `catalog_items_state_sort`
(`catalog_state, catalog_sort_key`), whose closed value is
`<lastSeenAt>#<jobId>`, so the cutoff is a lexical comparison.

## Operating it

- Dry run: call `runCatalogRetention(db, { now })` without `apply`; it returns
  the same report without writing.
- The cron logs the report on `employer_maintenance_complete` as
  `catalogRetention`, with one count per sweep.
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
job is removed with its occurrences and metadata, the newest attempt survives,
and a bounded batch drains across successive calls.
