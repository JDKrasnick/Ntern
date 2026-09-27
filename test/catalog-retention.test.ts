import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLOSED_JOB_RETENTION_DAYS, CLOSED_OCCURRENCE_RETENTION_DAYS,
  METADATA_HISTORY_RETENTION_DAYS, NOTIFICATION_EVENT_RETENTION_DAYS,
  runCatalogRetention,
} from '../cloudflare/catalog-retention.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

function sqliteD1(database: DatabaseSync, beforeFirstBatch?: () => void): D1Database {
  let pendingBeforeBatch = beforeFirstBatch;
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(query).run(...values).changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      pendingBeforeBatch?.();
      pendingBeforeBatch = undefined;
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

function subject(beforeFirstBatch?: (database: DatabaseSync) => void): { database: DatabaseSync; db: D1Database } {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0015_role_metadata_enrichment.sql', '0038_catalog_retention_indexes.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { database, db: sqliteD1(database, beforeFirstBatch ? () => beforeFirstBatch(database) : undefined) };
}

const NOW = new Date('2026-09-27T12:00:00.000Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function insertCatalog(database: DatabaseSync, row: {
  pk: string; sk: string; kind: string; value: unknown; catalogState?: string; catalogSortKey?: string;
}) {
  database.prepare(`INSERT INTO catalog_items (pk, sk, kind, value, catalog_state, catalog_sort_key)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(row.pk, row.sk, row.kind, JSON.stringify(row.value), row.catalogState ?? null, row.catalogSortKey ?? null);
}

function closedJob(database: DatabaseSync, jobId: string, lastSeenAt: string, sourceId: string, externalId: string) {
  insertCatalog(database, {
    pk: `JOB#${jobId}`, sk: 'META', kind: 'internship', catalogState: 'CLOSED',
    catalogSortKey: `${lastSeenAt}#${jobId}`,
    value: { jobId, sourceReferences: [{ sourceId, externalId, document: '', sourceUrl: 'https://x.test', row: 0 }] },
  });
  insertCatalog(database, {
    pk: `SOURCE#${sourceId}`, sk: `OCCURRENCE#${externalId}`, kind: 'source-occurrence',
    value: { sourceId, externalId, jobId, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'h', changedAt: lastSeenAt,
      occurrence: { sourceId, externalId, company: 'Acme', title: 'Intern', location: 'Remote', season: 'summer-2024',
        applyUrl: 'https://x.test', compensation: { raw: '' }, state: 'closed', row: 0, document: '', sourceUrl: 'https://x.test' } },
  });
  database.prepare(`INSERT INTO role_metadata_evidence
    (job_id, source_class, source_id, source_url, artifact_hash, extraction_version, evidence, observed_at, is_current)
    VALUES (?, 'official-page', ?, 'https://x.test', 'h1', 1, '{}', ?, 0)`).run(jobId, sourceId, lastSeenAt);
  database.prepare(`INSERT INTO role_metadata_extraction_attempts
    (id, job_id, source_id, source_url, artifact_hash, extraction_version, outcome, observed_at)
    VALUES (?, ?, ?, 'https://x.test', 'h1', 1, 'extracted', ?)`).run(`a-${jobId}`, jobId, sourceId, lastSeenAt);
  database.prepare(`INSERT INTO role_metadata_conflicts
    (id, job_id, field, evidence_hashes, values_json, state, opened_at, updated_at)
    VALUES (?, ?, 'compensation', '[]', '[]', 'resolved', ?, ?)`).run(`c-${jobId}`, jobId, lastSeenAt, lastSeenAt);
}

describe('catalog retention', () => {
  it('reports eligible history without deleting on a dry run', async () => {
    const { database, db } = subject();
    insertCatalog(database, { pk: 'OUTBOX#old', sk: 'EVENT', kind: 'notification-event',
      value: { eventId: 'old', createdAt: daysBefore(NOTIFICATION_EVENT_RETENTION_DAYS + 5) } });
    closedJob(database, 'old-job', daysBefore(CLOSED_JOB_RETENTION_DAYS + 10), 'gh-acme', 'ext-1');

    const report = await runCatalogRetention(db, { now: NOW });
    expect(report).toMatchObject({ applied: false, notificationEvents: 1, closedJobs: 1, closedJobOccurrences: 0, closedJobMetadataRows: 0 });
    expect(database.prepare('SELECT count(*) AS count FROM catalog_items').get()).toEqual({ count: 3 });
    database.close();
  });

  it('expires only notification events past the window', async () => {
    const { database, db } = subject();
    insertCatalog(database, { pk: 'OUTBOX#old', sk: 'EVENT', kind: 'notification-event',
      value: { eventId: 'old', createdAt: daysBefore(NOTIFICATION_EVENT_RETENTION_DAYS + 1) } });
    insertCatalog(database, { pk: 'OUTBOX#new', sk: 'EVENT', kind: 'notification-event',
      value: { eventId: 'new', createdAt: daysBefore(NOTIFICATION_EVENT_RETENTION_DAYS - 1) } });
    insertCatalog(database, { pk: 'OUTBOX#malformed', sk: 'EVENT', kind: 'notification-event', value: {} });

    const report = await runCatalogRetention(db, { now: NOW, apply: true });
    expect(report.notificationEvents).toBe(2);
    expect(database.prepare("SELECT pk FROM catalog_items WHERE kind = 'notification-event'").all())
      .toEqual([{ pk: 'OUTBOX#new' }]);
    database.close();
  });

  it('removes a closed internship with its occurrences and metadata, keeping live and recent roles', async () => {
    const { database, db } = subject();
    closedJob(database, 'old-job', daysBefore(CLOSED_JOB_RETENTION_DAYS + 10), 'gh-acme', 'ext-1');
    closedJob(database, 'recent-job', daysBefore(CLOSED_OCCURRENCE_RETENTION_DAYS - 10), 'gh-beta', 'ext-2');
    insertCatalog(database, { pk: 'JOB#open-job', sk: 'META', kind: 'internship', catalogState: 'OPEN',
      catalogSortKey: `${daysBefore(1)}#open-job`, value: { jobId: 'open-job', sourceReferences: [] } });

    const report = await runCatalogRetention(db, { now: NOW, apply: true });
    expect(report).toMatchObject({ closedJobs: 1, closedJobOccurrences: 1, closedJobMetadataRows: 3 });
    expect(database.prepare("SELECT pk FROM catalog_items WHERE kind = 'internship' ORDER BY pk").all())
      .toEqual([{ pk: 'JOB#open-job' }, { pk: 'JOB#recent-job' }]);
    expect(database.prepare("SELECT pk FROM catalog_items WHERE kind = 'source-occurrence'").all())
      .toEqual([{ pk: 'SOURCE#gh-beta' }]);
    expect(database.prepare('SELECT job_id FROM role_metadata_evidence ORDER BY job_id').all())
      .toEqual([{ job_id: 'recent-job' }]);
    expect(database.prepare('SELECT job_id FROM role_metadata_extraction_attempts ORDER BY job_id').all())
      .toEqual([{ job_id: 'recent-job' }]);
    expect(database.prepare('SELECT job_id FROM role_metadata_conflicts ORDER BY job_id').all())
      .toEqual([{ job_id: 'recent-job' }]);
    database.close();
  });

  it('does not delete a job or occurrence that reopens after the retention page is selected', async () => {
    const { database, db } = subject((current) => {
      const row = current.prepare("SELECT value FROM catalog_items WHERE pk = 'JOB#old-job'").get() as { value: string };
      const job = JSON.parse(row.value) as Record<string, unknown>;
      current.prepare(`UPDATE catalog_items SET value = ?, catalog_state = 'OPEN', catalog_sort_key = ? WHERE pk = ? AND sk = 'META'`)
        .run(JSON.stringify({ ...job, open: true, lastSeenAt: NOW.toISOString() }), `${NOW.toISOString()}#old-job`, 'JOB#old-job');
      const occurrenceRow = current.prepare("SELECT value FROM catalog_items WHERE pk = 'SOURCE#gh-acme'").get() as { value: string };
      const occurrence = JSON.parse(occurrenceRow.value) as { occurrence: Record<string, unknown> };
      current.prepare("UPDATE catalog_items SET value = ? WHERE pk = 'SOURCE#gh-acme' AND sk = 'OCCURRENCE#ext-1'")
        .run(JSON.stringify({ ...occurrence, changedAt: NOW.toISOString(), occurrence: { ...occurrence.occurrence, state: 'open' } }));
    });
    closedJob(database, 'old-job', daysBefore(CLOSED_JOB_RETENTION_DAYS + 10), 'gh-acme', 'ext-1');

    const report = await runCatalogRetention(db, { now: NOW, apply: true });

    expect(report.closedJobs).toBe(0);
    expect(database.prepare("SELECT catalog_state FROM catalog_items WHERE pk = 'JOB#old-job'").get()).toEqual({ catalog_state: 'OPEN' });
    expect(database.prepare("SELECT json_extract(value, '$.occurrence.state') AS state FROM catalog_items WHERE pk = 'SOURCE#gh-acme'").get())
      .toEqual({ state: 'open' });
    database.close();
  });

  it('uses the selected primary key when embedded job identity disagrees', async () => {
    const { database, db } = subject();
    closedJob(database, 'old-job', daysBefore(CLOSED_JOB_RETENTION_DAYS + 10), 'gh-old', 'old-ext');
    closedJob(database, 'live-job', daysBefore(1), 'gh-live', 'live-ext');
    const old = database.prepare("SELECT value FROM catalog_items WHERE pk = 'JOB#old-job'").get() as { value: string };
    const inconsistent = { ...(JSON.parse(old.value) as Record<string, unknown>), jobId: 'live-job',
      sourceReferences: [{ sourceId: 'gh-live', externalId: 'live-ext' }] };
    database.prepare("UPDATE catalog_items SET value = ? WHERE pk = 'JOB#old-job'").run(JSON.stringify(inconsistent));

    const report = await runCatalogRetention(db, { now: NOW, apply: true });

    expect(report.closedJobs).toBe(1);
    expect(database.prepare("SELECT pk FROM catalog_items WHERE kind = 'internship' ORDER BY pk").all())
      .toEqual([{ pk: 'JOB#live-job' }]);
    expect(database.prepare("SELECT pk FROM catalog_items WHERE pk = 'SOURCE#gh-live'").all())
      .toEqual([{ pk: 'SOURCE#gh-live' }]);
    expect(database.prepare("SELECT job_id FROM role_metadata_evidence WHERE job_id = 'live-job'").all())
      .toEqual([{ job_id: 'live-job' }]);
    database.close();
  });

  it('expires source-dropped occurrences without touching open or recent ones', async () => {
    const { database, db } = subject();
    const occurrence = (state: string, changedAt: string) => ({
      sourceId: 'gh-acme', externalId: `ext-${state}-${changedAt}`, jobId: 'job', present: state === 'open', consecutiveOmissions: 0,
      changedSnapshotHash: 'h', changedAt, occurrence: { state, row: 0, document: '', sourceUrl: 'https://x.test' },
    });
    insertCatalog(database, { pk: 'SOURCE#gh-acme', sk: 'OCCURRENCE#old-closed', kind: 'source-occurrence',
      value: occurrence('closed', daysBefore(CLOSED_OCCURRENCE_RETENTION_DAYS + 1)) });
    insertCatalog(database, { pk: 'SOURCE#gh-acme', sk: 'OCCURRENCE#new-closed', kind: 'source-occurrence',
      value: occurrence('closed', daysBefore(CLOSED_OCCURRENCE_RETENTION_DAYS - 1)) });
    insertCatalog(database, { pk: 'SOURCE#gh-acme', sk: 'OCCURRENCE#old-open', kind: 'source-occurrence',
      value: occurrence('open', daysBefore(CLOSED_OCCURRENCE_RETENTION_DAYS + 1)) });

    const report = await runCatalogRetention(db, { now: NOW, apply: true });
    expect(report.closedOccurrences).toBe(1);
    expect(database.prepare("SELECT sk FROM catalog_items WHERE kind = 'source-occurrence' ORDER BY sk").all())
      .toEqual([{ sk: 'OCCURRENCE#new-closed' }, { sk: 'OCCURRENCE#old-open' }]);
    database.close();
  });

  it('keeps current evidence and the newest attempt while pruning superseded history', async () => {
    const { database, db } = subject();
    const oldAt = daysBefore(METADATA_HISTORY_RETENTION_DAYS + 5);
    const recentAt = daysBefore(METADATA_HISTORY_RETENTION_DAYS - 5);
    const evidence = database.prepare(`INSERT INTO role_metadata_evidence
      (job_id, source_class, source_id, source_url, artifact_hash, extraction_version, evidence, observed_at, is_current)
      VALUES ('job-1', 'official-page', 'gh-acme', 'https://x.test', ?, 1, '{}', ?, ?)`);
    evidence.run('superseded-old', oldAt, 0);
    evidence.run('superseded-recent', recentAt, 0);
    evidence.run('current-old', oldAt, 1);

    const attempt = database.prepare(`INSERT INTO role_metadata_extraction_attempts
      (id, job_id, source_id, source_url, artifact_hash, extraction_version, outcome, observed_at)
      VALUES (?, 'job-1', ?, 'https://x.test', 'h', 1, 'extracted', ?)`);
    attempt.run('attempt-newest', 'gh-acme', recentAt);
    attempt.run('attempt-older', 'gh-acme', oldAt);
    attempt.run('attempt-lonely', 'gh-other', oldAt);

    const conflict = database.prepare(`INSERT INTO role_metadata_conflicts
      (id, job_id, field, evidence_hashes, values_json, state, opened_at, updated_at)
      VALUES (?, 'job-1', 'compensation', '[]', '[]', ?, ?, ?)`);
    conflict.run('resolved-old', 'resolved', oldAt, oldAt);
    conflict.run('resolved-recent', 'resolved', recentAt, recentAt);
    conflict.run('open-old', 'open', oldAt, oldAt);

    const report = await runCatalogRetention(db, { now: NOW, apply: true });
    expect(report).toMatchObject({ metadataEvidenceHistory: 1, metadataExtractionAttempts: 1, metadataResolvedConflicts: 1 });
    expect(database.prepare('SELECT artifact_hash FROM role_metadata_evidence ORDER BY artifact_hash').all())
      .toEqual([{ artifact_hash: 'current-old' }, { artifact_hash: 'superseded-recent' }]);
    expect(database.prepare('SELECT id FROM role_metadata_extraction_attempts ORDER BY id').all())
      .toEqual([{ id: 'attempt-lonely' }, { id: 'attempt-newest' }]);
    expect(database.prepare('SELECT id FROM role_metadata_conflicts ORDER BY id').all())
      .toEqual([{ id: 'open-old' }, { id: 'resolved-recent' }]);
    database.close();
  });

  it('drains full pages up to the configured pass bound and reports remaining work', async () => {
    const { database, db } = subject();
    for (let index = 0; index < 5; index += 1) {
      closedJob(database, `job-${index}`, daysBefore(CLOSED_JOB_RETENTION_DAYS + 10), `gh-${index}`, `ext-${index}`);
    }
    const first = await runCatalogRetention(db, { now: NOW, apply: true, jobBatchSize: 2, maxPasses: 2 });
    expect(first).toMatchObject({ closedJobs: 4, passes: 2, remaining: { closedJobs: true } });
    expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'internship'").get()).toEqual({ count: 1 });
    const second = await runCatalogRetention(db, { now: NOW, apply: true, jobBatchSize: 2, maxPasses: 2 });
    expect(second).toMatchObject({ closedJobs: 1, passes: 1, remaining: { closedJobs: false } });
    database.close();
  });

  it('uses indexed range searches for timestamp retention predicates', () => {
    const { database } = subject();
    const notificationPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM catalog_items
      WHERE kind = 'notification-event' AND coalesce(json_extract(value, '$.createdAt'), '') < ?
      ORDER BY coalesce(json_extract(value, '$.createdAt'), '') LIMIT ?`).all('2026-01-01', 200) as Array<{ detail: string }>;
    const occurrencePlan = database.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM catalog_items
      WHERE kind = 'source-occurrence' AND json_extract(value, '$.occurrence.state') = 'closed'
        AND coalesce(json_extract(value, '$.changedAt'), '') < ?
      ORDER BY coalesce(json_extract(value, '$.changedAt'), '') LIMIT ?`).all('2026-01-01', 200) as Array<{ detail: string }>;

    expect(notificationPlan.map(({ detail }) => detail).join('\n'))
      .toContain('SEARCH catalog_items USING INDEX catalog_items_notification_event_created (<expr><?)');
    expect(occurrencePlan.map(({ detail }) => detail).join('\n'))
      .toContain('SEARCH catalog_items USING INDEX catalog_items_source_occurrence_closed_changed (<expr><?)');
    database.close();
  });
});
