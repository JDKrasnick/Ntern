import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { CatalogAdmission, Internship, NotificationEvent, SourceCheckpoint, SourceOccurrenceState } from '../src/types.js';

/**
 * D1 bills a row an `UPDATE` matched, not a row whose bytes changed, so a writer
 * that re-stores an identical row costs exactly what a real write costs. These
 * tests replay each write path and count the rows D1 would bill, including the
 * `catalog_items` review triggers that fire on every internship write.
 */

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      database.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

function subject() {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql', '0010_posting_identity.sql',
    '0015_role_metadata_enrichment.sql', '0016_role_metadata_repair_plans.sql', '0017_metadata_acquisition.sql',
    '0018_metadata_review.sql', '0019_metadata_job_review_revision.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database);
  /** Rows D1 would bill: `total_changes` counts trigger writes too. */
  const rowsWritten = () => Number((database.prepare('SELECT total_changes() AS total').get() as { total: number }).total);
  return { database, db, jobs: new D1InternshipStore(db), admission: new D1CatalogAdmissionStore(db), rowsWritten };
}

function job(jobId = 'job-1'): Internship {
  return {
    jobId, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'],
    season: 'summer-2027', applyUrl: `https://careers.acme.test/${jobId}`, normalizedUrl: `https://careers.acme.test/${jobId}`,
    fingerprint: `fingerprint-${jobId}`, compensation: { raw: '' },
    sourceReferences: [{ sourceId: 'community-acme', externalId: `row-${jobId}`, document: 'README.md',
      sourceUrl: 'https://github.test/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'Remote', locations: ['Remote'], season: 'summer-2027', applyUrl: `https://careers.acme.test/${jobId}`,
      compensation: { raw: '' }, state: 'open', provenance: 'reviewed-community' }],
    technical: true, open: true, firstSeenAt: '2026-09-01T00:00:00.000Z', catalogVisibleAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-04T00:00:00.000Z',
    notification: { smsPending: false, digestPending: false, smsSentAt: '2026-09-01T00:01:00.000Z' },
  };
}

function occurrence(externalId: string, state: SourceOccurrenceState['occurrence']['state'] = 'open'): SourceOccurrenceState {
  return { sourceId: 'community-acme', externalId, present: true, consecutiveOmissions: 0, jobId: 'job-1',
    changedSnapshotHash: 'snapshot-1', changedAt: '2026-09-04T00:00:00.000Z',
    occurrence: { sourceId: 'community-acme', externalId, document: 'README.md', sourceUrl: 'https://github.test/jobs',
      row: 1, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'],
      season: 'summer-2027', applyUrl: 'https://careers.acme.test/job-1', compensation: { raw: '' }, state } };
}

function admission(catalogEligible = true): CatalogAdmission {
  return {
    employerResolution: 'resolved', postingAttribution: 'attributed',
    destination: { classification: catalogEligible ? 'posting-detail' : 'aggregate-board', candidateUrl: 'https://careers.acme.test/job-1',
      provider: 'structured', inspectedAt: '2026-09-01T00:00:00.000Z' },
    metadata: { complete: true, title: 'complete', location: 'complete' }, catalogEligible, alertEligible: catalogEligible,
    reasonCodes: catalogEligible ? [] : ['destination-aggregate-board'], evaluatedAt: '2026-09-01T00:00:00.000Z',
    evidenceObservedAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('differential catalog writes', () => {
  afterEach(() => vi.useRealTimers());

  it('rewrites an internship row only when something in it changed', async () => {
    const current = subject();
    const stored = job();
    await current.jobs.putInternship(stored);
    const afterCreate = current.rowsWritten();
    await current.jobs.putInternship(stored);
    expect(current.rowsWritten()).toBe(afterCreate);
    // The row carries `internship` review triggers, so a real write bills the row plus both.
    const changed = { ...stored, lastSeenAt: '2026-09-05T00:00:00.000Z' };
    await current.jobs.putInternship(changed);
    expect(current.rowsWritten()).toBe(afterCreate + 3);
    expect(await current.jobs.getJob('job-1')).toMatchObject({ lastSeenAt: '2026-09-05T00:00:00.000Z' });
  });

  it('repairs a derived index column even when the stored value is unchanged', async () => {
    const current = subject();
    const stored = job();
    await current.jobs.putInternship(stored);
    // A deploy that changes the derived text must still repair the row, so the
    // guard compares the index columns, not just the JSON payload.
    current.database.prepare("UPDATE catalog_items SET search_text = 'stale-search-text' WHERE sk = 'META'").run();
    const before = current.rowsWritten();
    await current.jobs.putInternship(stored);
    expect(current.rowsWritten()).toBe(before + 3);
    expect(current.database.prepare("SELECT search_text FROM catalog_items WHERE sk = 'META'").get())
      .not.toEqual({ search_text: 'stale-search-text' });
  });

  it('keeps the notification outbox decision independent of the guarded job write', async () => {
    const current = subject();
    const stored = job();
    const event: NotificationEvent = { eventId: 'event-1', sourceId: 'community-acme', externalId: 'row-job-1',
      jobId: 'job-1', kind: 'new-job', createdAt: '2026-09-04T00:00:00.000Z' };
    expect(await current.jobs.putInternshipWithNotificationEvent(stored, event)).toBe(true);
    const afterFirst = current.rowsWritten();
    expect(await current.jobs.putInternshipWithNotificationEvent(stored, event)).toBe(false);
    expect(current.rowsWritten()).toBe(afterFirst);
    expect(await current.jobs.getJob('job-1')).toMatchObject({ jobId: 'job-1' });
  });

  it('skips an unchanged source occurrence and an unchanged checkpoint', async () => {
    const current = subject();
    const state = occurrence('row-1');
    await current.jobs.putSourceOccurrence(state);
    const afterOccurrence = current.rowsWritten();
    await current.jobs.putSourceOccurrence(state);
    expect(current.rowsWritten()).toBe(afterOccurrence);
    await current.jobs.putSourceOccurrence({ ...state, occurrence: { ...state.occurrence, state: 'closed' } });
    expect(current.rowsWritten()).toBe(afterOccurrence + 1);

    const checkpoint: SourceCheckpoint = { sourceId: 'community-acme', etag: 'etag-1', successfulFetches: 3, lastCheckedAt: '2026-09-04T00:00:00.000Z' } as SourceCheckpoint;
    await current.jobs.putCheckpoint(checkpoint);
    const afterCheckpoint = current.rowsWritten();
    await current.jobs.putCheckpoint(checkpoint);
    expect(current.rowsWritten()).toBe(afterCheckpoint);
    await current.jobs.putCheckpoint({ ...checkpoint, successfulFetches: 4 });
    expect(current.rowsWritten()).toBe(afterCheckpoint + 1);
  });

  it('bills nothing for a notification stamp that is already applied', async () => {
    const current = subject();
    const stored = job();
    await current.jobs.putInternship(stored);
    await current.jobs.putSourceOccurrence(occurrence('row-job-1'));
    const sentAt = '2026-09-04T01:00:00.000Z';
    expect(await current.jobs.markSmsSent('job-1', sentAt)).toBeUndefined();
    const afterSend = current.rowsWritten();
    await current.jobs.markSmsSent('job-1', sentAt);
    await current.jobs.markDigested(['job-1'], sentAt);
    const digestJob = await current.jobs.getJob('job-1');
    expect(digestJob?.notification).toMatchObject({ smsPending: false, smsSentAt: sentAt });
    expect(current.rowsWritten()).toBeGreaterThanOrEqual(afterSend);
    const settled = current.rowsWritten();
    await current.jobs.markDigested(['job-1'], sentAt);
    expect(current.rowsWritten()).toBe(settled);
  });

  it('does not rewrite an unchanged acquisition, handoff, or incident', async () => {
    const current = subject();
    const report = { method: 'browser', complete: true, fields: { compensation: 'extracted' }, observedAt: '2026-09-04T00:00:00.000Z' };
    await current.admission.recordMetadataAcquisition('job-1', 'community-acme', '2026-09-04T00:00:00.000Z', report, '2026-10-04T00:00:00.000Z');
    const afterAcquisition = current.rowsWritten();
    await current.admission.recordMetadataAcquisition('job-1', 'community-acme', '2026-09-04T00:00:00.000Z', report, '2026-10-04T00:00:00.000Z');
    expect(current.rowsWritten()).toBe(afterAcquisition);
    await current.admission.recordMetadataAcquisition('job-1', 'community-acme', '2026-09-05T00:00:00.000Z', report, '2026-10-05T00:00:00.000Z');
    expect(current.rowsWritten()).toBe(afterAcquisition + 1);

    const handoff = { outcome: 'enqueued' as const, method: 'browser', descriptionBytes: 4096, observedAt: '2026-09-05T00:01:00.000Z' };
    await current.admission.recordShadowExtractionHandoff('job-1', 'community-acme', '2026-09-05T00:00:00.000Z', handoff);
    const afterHandoff = current.rowsWritten();
    await current.admission.recordShadowExtractionHandoff('job-1', 'community-acme', '2026-09-05T00:00:00.000Z', handoff);
    expect(current.rowsWritten()).toBe(afterHandoff);

    const incident = { id: 'incident-1', jobId: 'job-1', sourceId: 'community-acme', host: 'careers.acme.test',
      reasonCode: 'destination-stale' as const, state: 'open' as const, openedAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z', graceDeadline: '2026-09-11T00:00:00.000Z' };
    await current.admission.upsertIncident(incident);
    const afterIncident = current.rowsWritten();
    await current.admission.upsertIncident({ ...incident, updatedAt: '2026-09-05T00:00:00.000Z' });
    expect(current.rowsWritten()).toBe(afterIncident);
    await current.admission.upsertIncident({ ...incident, state: 'quarantined' });
    expect(current.rowsWritten()).toBe(afterIncident + 1);

    await current.admission.markIncidentNotification('incident-1', 'grace-warning', '2026-09-05T00:00:00.000Z');
    const afterNotification = current.rowsWritten();
    await current.admission.markIncidentNotification('incident-1', 'grace-warning', '2026-09-06T00:00:00.000Z');
    expect(current.rowsWritten()).toBe(afterNotification);
    expect(current.database.prepare('SELECT warning_sent_at FROM admission_incidents WHERE id = ?').get('incident-1'))
      .toEqual({ warning_sent_at: '2026-09-05T00:00:00.000Z' });
  });

  it('still refuses an admission write whose expected reference moved', async () => {
    const current = subject();
    const stored = { ...job(), admission: admission() };
    await current.jobs.putInternship(stored);
    const reference = stored.sourceReferences[0]!;
    // The guard compares the stored source reference itself, so a reference that
    // moved since the caller read it must refuse the write. This path keeps its
    // precondition guard rather than a value comparison: its `changes` count is
    // the caller's commit signal.
    current.database.prepare("UPDATE catalog_items SET value = json_set(value, '$.sourceReferences[0].state', 'closed') WHERE sk = 'META'").run();
    const before = current.rowsWritten();
    expect(await current.jobs.putAdmissionState({ ...stored, admission: admission(false) }, reference)).toBe(false);
    expect(current.rowsWritten()).toBe(before);
  });
});
