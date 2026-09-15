import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { compactIdentityValue, runPostingIdentityAudit } from '../src/posting-identity-audit.js';
import { postingIdentityRepairPlan } from '../src/posting-identity-repair.js';
import type { Internship, ProviderPostingEvidence, SourceOccurrence } from '../src/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query); const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return {
    prepare(query) { return prepared(query); },
    async batch(statements) {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      return result;
    },
  };
}

function database() {
  const value = new DatabaseSync(':memory:');
  for (const name of ['0001_initial.sql', '0002_cost_guards.sql', '0003_billing_shutdown.sql', '0004_auth_rate_limits.sql',
    '0005_auth_consent.sql', '0006_employer_channel.sql', '0007_catalog_admission.sql', '0010_posting_identity.sql',
    '0013_posting_presentation_reviews.sql']) {
    value.exec(readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8'));
  }
  return value;
}

const KINDS = "'internship', 'job-id-alias', 'source-occurrence', 'posting-identity-incident', 'checkpoint', 'posting-alias', 'notification-tombstone', 'notification-event'";

function job(jobId: string, applyUrl: string, firstSeenAt: string, sourceReferences: SourceOccurrence[], extra: Record<string, unknown> = {}): Internship {
  return {
    jobId, company: 'Historical Employer', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl, normalizedUrl: applyUrl, fingerprint: `fingerprint-${jobId}`, compensation: { raw: '' }, sourceReferences,
    open: true, technical: true, firstSeenAt, catalogVisibleAt: firstSeenAt, lastSeenAt: '2026-08-02T00:00:00.000Z',
    notification: { smsPending: false, digestPending: false }, ...extra,
  };
}

function occurrence(sourceId: string, externalId: string, applyUrl: string, providerEvidence?: ProviderPostingEvidence): SourceOccurrence {
  return {
    sourceId, externalId, document: externalId, sourceUrl: 'https://example.test/source', row: 1,
    company: 'Historical Employer', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl, compensation: { raw: '' }, state: 'open', ...(providerEvidence ? { providerEvidence } : {}),
  };
}

const plusId = 'b4f750e7-0148-41f0-b2b1-ff054450a320';
const plusEvidence: ProviderPostingEvidence = {
  provider: 'lever', tenant: 'plus-2', postingId: plusId, sourceId: 'lever-plusai',
  urls: [`https://jobs.lever.co/plus-2/${plusId}`, `https://jobs.lever.co/plus-2/${plusId}/apply`],
};
const drwEvidence: ProviderPostingEvidence = {
  provider: 'greenhouse', tenant: 'drweng', postingId: '3413670', sourceId: 'greenhouse-drweng',
  urls: ['https://job-boards.greenhouse.io/drweng/jobs/3413670'],
};

/**
 * Catalog shaped like production: two duplicate groups whose members fall in
 * different audit pages, reviewed cohorts, a legacy occurrence, a dangling
 * occurrence, an existing alias claim, an outbox record, and an incident.
 */
function fixture() {
  const sqlite = database();
  const insert = sqlite.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, ?, ?)');
  const putJob = (value: Internship) => insert.run(`JOB#${value.jobId}`, 'META', 'internship', JSON.stringify(value));
  const putOccurrence = (row: { sourceId: string; externalId: string; jobId: string; occurrence: SourceOccurrence; firstObservedAt?: string }) =>
    insert.run(`SOURCE#${row.sourceId}|OCCURRENCE#${row.externalId}`, '', 'source-occurrence', JSON.stringify({
      ...row, present: true, consecutiveOmissions: 0, changedSnapshotHash: row.externalId, changedAt: row.firstObservedAt ?? '2026-08-01T00:00:00.000Z',
    }));
  insert.run('CHECKPOINT#lever-plusai', 'STATE', 'checkpoint', JSON.stringify({ sourceId: 'lever-plusai', successfulFetches: 10, activeExternalIds: [plusId] }));
  insert.run('CHECKPOINT#greenhouse-drweng', 'STATE', 'checkpoint', JSON.stringify({ sourceId: 'greenhouse-drweng', successfulFetches: 10, activeExternalIds: ['3413670'] }));

  putJob(job('plus-old', `https://jobs.lever.co/plus-2/${plusId}`, '2026-07-28T03:12:13.556Z', [
    occurrence('community-list', 'community-plus', `https://jobs.lever.co/plus-2/${plusId}?utm_source=simplify`),
  ]));
  putJob(job('plus-duplicate', `https://jobs.lever.co/plus-2/${plusId}/apply`, '2026-08-01T13:44:06.281Z', [
    occurrence('lever-plusai', plusId, `https://jobs.lever.co/plus-2/${plusId}/apply`, plusEvidence),
  ]));
  putJob(job('drw-old', 'https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670', '2026-07-20T00:00:00.000Z', [
    occurrence('community-list', 'drw-community', 'https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670?ref=feed'),
  ]));
  putJob(job('drw-duplicate', 'https://job-boards.greenhouse.io/drweng/jobs/3413670', '2026-07-21T00:00:00.000Z', [
    occurrence('greenhouse-drweng', '3413670', 'https://job-boards.greenhouse.io/drweng/jobs/3413670', drwEvidence),
  ]));
  for (const id of ['regular-a', 'regular-b', 'regular-c']) {
    putJob(job(id, `https://careers.example.test/jobs/${id}`, '2026-08-04T00:00:00.000Z', [
      occurrence('community-list', id, `https://careers.example.test/jobs/${id}`),
    ]));
  }
  putOccurrence({ sourceId: 'lever-plusai', externalId: plusId, jobId: 'plus-duplicate',
    occurrence: occurrence('lever-plusai', plusId, `https://jobs.lever.co/plus-2/${plusId}/apply`, plusEvidence),
    firstObservedAt: '2026-08-01T13:44:06.281Z' });
  putOccurrence({ sourceId: 'community-list', externalId: 'detached', jobId: 'missing-job',
    occurrence: occurrence('community-list', 'detached', 'https://careers.example.test/jobs/detached') });
  insert.run(`POSTING_ALIAS#provider:lever:plus-2:${plusId}`, 'CLAIM', 'posting-alias',
    JSON.stringify({ alias: `provider:lever:plus-2:${plusId}`, canonicalJobId: 'plus-duplicate', claimedAt: '2026-08-02T00:00:00.000Z' }));
  insert.run('JOB_ID_ALIAS#retired-job', 'TARGET', 'job-id-alias',
    JSON.stringify({ oldJobId: 'retired-job', canonicalJobId: 'regular-a', createdBy: 'posting-identity-repair' }));
  insert.run('OUTBOX#one', 'EVENT', 'notification-event', JSON.stringify({ eventId: 'one', jobId: 'regular-a', kind: 'new-job', createdAt: '2026-08-02T00:00:00.000Z' }));
  insert.run('OUTBOX#two', 'EVENT', 'notification-event', JSON.stringify({ eventId: 'two', jobId: 'regular-a', kind: 'new-job', createdAt: '2026-08-03T00:00:00.000Z' }));
  insert.run('INCIDENT#one', 'STATE', 'posting-identity-incident', JSON.stringify({ id: 'one', jobId: 'regular-b', reason: 'unconfirmed' }));
  insert.run('INCIDENT#two', 'STATE', 'posting-identity-incident', JSON.stringify({ id: 'two', jobId: 'regular-c', reason: 'unconfirmed' }));
  return sqlite;
}

/** The single-pass plan the paged audit has to reproduce exactly. */
function referenceReport(sqlite: DatabaseSync) {
  const catalog = sqlite.prepare(`SELECT * FROM catalog_items WHERE kind IN (${KINDS}) ORDER BY pk, sk`).all() as never[];
  return postingIdentityRepairPlan(catalog, [], [], 'all', {});
}

describe('paged posting identity audit', () => {
  it('reproduces the single-pass plan across pages', async () => {
    const sqlite = fixture();
    const expected = referenceReport(sqlite);
    const audit = await runPostingIdentityAudit(sqliteD1(sqlite), { jobBatch: 2 });

    expect(audit.pages).toBeGreaterThan(1);
    expect(audit.jobsScanned).toBe(7);
    expect(audit.occurrenceCounts).toEqual(expected.occurrenceCounts);
    expect(audit.gate).toEqual(expected.gate);
    expect(audit.providerGroups).toBe(expected.providerGroups);
    expect(audit.duplicateGroups).toBe(expected.duplicateGroups);
    expect(audit.duplicateJobs).toBe(expected.duplicateJobs);
    expect(audit.eligibleDuplicateGroups).toBe(expected.eligibleDuplicateGroups);
    expect(audit.unresolvedDuplicateGroups).toBe(expected.unresolvedDuplicateGroups);
    expect(audit.presentationDisagreements).toEqual(expected.presentationDisagreements);
    expect(audit.unknownUrlFamilyCandidates).toEqual(expected.unknownUrlFamilyCandidates);
    expect(audit.duplicateAlertGroups).toBe(expected.duplicateAlertGroups);
    expect(audit.outboxRows).toBe(expected.outboxRows);
    expect(audit.conflicts).toEqual(expected.conflicts);
    expect(audit.occurrenceCounts.quarantined).toBe(2);
    expect(audit.gate.duplicateOccurrenceReferences).toBe(expected.gate.duplicateOccurrenceReferences);
  });

  it('reports the same facts for every page size', async () => {
    const sqlite = fixture();
    const expected = referenceReport(sqlite);
    const reports = await Promise.all([1, 3, 100].map((jobBatch) =>
      runPostingIdentityAudit(sqliteD1(sqlite), { jobBatch })));
    for (const report of reports) {
      expect(report.gate).toEqual(expected.gate);
      expect(report.occurrenceCounts).toEqual(expected.occurrenceCounts);
      expect(report.conflicts).toEqual(expected.conflicts);
      expect(report.presentationDisagreements).toEqual(expected.presentationDisagreements);
    }
    expect(reports.map((report) => report.pages)).toEqual([8, 4, 2]);
  });

  it('leaves the catalog byte-identical', async () => {
    const sqlite = fixture();
    const before = sqlite.prepare('SELECT pk, sk, kind, value FROM catalog_items ORDER BY pk, sk').all();
    await runPostingIdentityAudit(sqliteD1(sqlite), { jobBatch: 2 });
    const after = sqlite.prepare('SELECT pk, sk, kind, value FROM catalog_items ORDER BY pk, sk').all();
    expect(after).toEqual(before);
  });

  it('keeps every field the plan reads when rows are compacted', () => {
    const sqlite = fixture();
    const rows = sqlite.prepare(`SELECT * FROM catalog_items WHERE kind IN (${KINDS}) ORDER BY pk, sk`).all() as Array<Record<string, unknown>>;
    const compacted = rows.map((row) => ({ ...row, value: compactIdentityValue(String(row.kind), String(row.value)) }));
    const reference = postingIdentityRepairPlan(rows as never, [], [], 'all', {} as never, 'audit');
    const projected = postingIdentityRepairPlan(compacted as never, [], [], 'all', {} as never, 'audit');
    expect(projected.gate).toEqual(reference.gate);
    expect(projected.occurrenceCounts).toEqual(reference.occurrenceCounts);
    expect(projected.conflicts).toEqual(reference.conflicts);
    expect(projected.scan).toEqual(reference.scan);
  });

  it('keeps repair mode free of audit substitutions', async () => {
    const sqlite = fixture();
    const rows = sqlite.prepare(`SELECT * FROM catalog_items WHERE kind IN (${KINDS}) ORDER BY pk, sk`).all() as never[];
    const repair = postingIdentityRepairPlan(rows, [], [], 'all', {});
    const audit = postingIdentityRepairPlan(rows, [], [], 'all', {}, 'audit');
    expect(repair.gate).toEqual(audit.gate);
    expect(repair.duplicateJobs).toEqual(audit.duplicateJobs);
    expect(repair.repairToken).not.toEqual(audit.repairToken);
    expect(repair.jobUpdates).toBeGreaterThan(0);
    expect(audit.jobUpdates).toBe(0);
  });
});
