import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { effectiveAdmissionConfigurationVersion, sourceAdmissionPolicy } from '../src/sources/trust-policy.js';
import { sourceQualityPolicies } from '../src/sources/quality.js';
import { runTrustedAdmissionBackfill } from '../src/trusted-admission-backfill.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type {
  CatalogAdmission,
  CatalogAdmissionReason,
  DestinationClassification,
  Internship,
  SourceCheckpoint,
  SourceOccurrence,
  SourceOccurrenceState,
  TrustedCommunityAlertQualification,
} from '../src/types.js';

const TRUSTED_SOURCE = 'speedyapply-2027-swe';
const STANDARD_SOURCE = sourceQualityPolicies.map((policy) => policy.id)
  .find((sourceId) => sourceAdmissionPolicy(sourceId).trust === 'standard')!;
const INSPECTED_AT = '2026-09-10T00:00:00Z';
const STORED_AT = '2026-09-12T00:00:00Z';
const APPLICATION_URL = 'https://jobs.example.test/acme/software-intern';

type Recorder = { log?: Array<{ query: string; values: unknown[] }>; batchSizes?: number[] };

function sqliteD1(database: DatabaseSync, recorder: Recorder = {}): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { recorder.log?.push({ query, values }); return database.prepare(query).get(...values) as T | null; },
    async all<T>() { recorder.log?.push({ query, values }); return { results: database.prepare(query).all(...values) as T[] }; },
    async run() {
      recorder.log?.push({ query, values });
      const result = database.prepare(query).run(...values);
      return { meta: { changes: Number(result.changes) } };
    },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      recorder.batchSizes?.push(statements.length);
      database.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

function subject(recorder: Recorder = {}) {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { database, db: sqliteD1(database, recorder) };
}

/** The version the poller stamps under the enabled gate, read from D1 the way the resolver does. */
async function currentVersion(db: D1Database, sourceId: string, enabled = true): Promise<string> {
  const resolverVersion = await new D1CatalogAdmissionStore(db).configurationVersion();
  return effectiveAdmissionConfigurationVersion({ sourceId, resolverVersion, trustedCommunityCatalogEnabled: enabled })!;
}

async function put(db: D1Database, pk: string, sk: string, kind: string, value: unknown, columns: Record<string, string | number | null> = {}) {
  const names = Object.keys(columns);
  const parameters = Array.from({ length: 4 + names.length }, () => '?').join(', ');
  await db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value${names.length ? `, ${names.join(', ')}` : ''}) VALUES (${parameters})`)
    .bind(pk, sk, kind, JSON.stringify(value), ...names.map((name) => columns[name]!)).run();
}

function read<T>(database: DatabaseSync, pk: string, sk: string): T {
  const row = database.prepare('SELECT value FROM catalog_items WHERE pk = ? AND sk = ?').get(pk, sk) as { value: string };
  return JSON.parse(row.value) as T;
}

function admissionOf(classification: DestinationClassification, reasonCodes: CatalogAdmissionReason[]): CatalogAdmission {
  return {
    employerResolution: 'source-reported',
    postingAttribution: 'attributed',
    destination: {
      classification,
      candidateUrl: APPLICATION_URL,
      ...(classification === 'application-form' ? { finalUrl: APPLICATION_URL } : {}),
      provider: 'github',
      inspectedAt: INSPECTED_AT,
    },
    metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: false,
    alertEligible: false,
    reasonCodes,
    evidenceCodes: ['trusted-community-source'],
    evaluatedAt: STORED_AT,
    evidenceObservedAt: INSPECTED_AT,
  };
}

function qualification(suppressed: boolean): TrustedCommunityAlertQualification {
  return {
    candidateKey: APPLICATION_URL,
    consecutiveCompleteSnapshots: 2,
    status: 'disabled',
    baselineSuppressed: false,
    catalogPublicationSuppressed: suppressed,
  };
}

function referenceOf(input: {
  sourceId: string;
  externalId: string;
  version: string;
  admission?: CatalogAdmission;
  suppressed: boolean;
}): SourceOccurrence {
  return {
    sourceId: input.sourceId,
    provenance: 'reviewed-community',
    externalId: input.externalId,
    admissionConfigurationVersion: input.version,
    document: 'README.md',
    sourceUrl: `https://github.com/example/jobs#row-${input.externalId}`,
    row: 1,
    company: 'Acme',
    title: 'Software Engineering Intern',
    location: 'Remote',
    locations: ['Remote'],
    season: 'summer-2027',
    applyUrl: APPLICATION_URL,
    compensation: { raw: '' },
    state: 'open',
    technical: true,
    trustedCommunityAlertQualification: qualification(input.suppressed),
    ...(input.admission ? { admission: input.admission } : {}),
  };
}

function jobOf(input: { jobId: string; reference: SourceOccurrence; admission?: CatalogAdmission }): Internship {
  return {
    jobId: input.jobId,
    company: 'Acme',
    title: 'Software Engineering Intern',
    location: 'Remote',
    locations: ['Remote'],
    season: 'summer-2027',
    applyUrl: APPLICATION_URL,
    normalizedUrl: APPLICATION_URL,
    fingerprint: `fingerprint-${input.jobId}`,
    compensation: { raw: '' },
    sourceReferences: [input.reference],
    technical: true,
    open: true,
    firstSeenAt: '2026-08-01T00:00:00Z',
    lastSeenAt: STORED_AT,
    notification: { smsPending: false, digestPending: false },
    ...(input.admission ? { admission: input.admission } : {}),
  };
}

function occurrenceStateOf(input: { sourceId: string; externalId: string; jobId: string; reference: SourceOccurrence }): SourceOccurrenceState {
  return {
    sourceId: input.sourceId,
    externalId: input.externalId,
    jobId: input.jobId,
    occurrence: input.reference,
    present: true,
    consecutiveOmissions: 0,
    changedSnapshotHash: 'snapshot-1',
    changedAt: STORED_AT,
  };
}

function checkpointOf(sourceId: string, extra: Partial<SourceCheckpoint> = {}): SourceCheckpoint {
  return { sourceId, successfulFetches: 3, admissionConfigurationVersion: 'stale', activeExternalIds: ['ext-1'], ...extra };
}

/** A suppressed occurrence whose stored decision is exactly the pending-migration shape. */
async function suppressedRow(input: {
  db: D1Database;
  sourceId: string;
  externalId: string;
  jobId: string;
  admission: CatalogAdmission;
}) {
  const state = occurrenceStateOf({
    sourceId: input.sourceId,
    externalId: input.externalId,
    jobId: input.jobId,
    reference: referenceOf({ sourceId: input.sourceId, externalId: input.externalId, version: 'stale', admission: input.admission, suppressed: true }),
  });
  const job = jobOf({ jobId: input.jobId, reference: state.occurrence, admission: input.admission });
  await put(input.db, `JOB#${input.jobId}`, 'META', 'internship', job, { url_key: job.normalizedUrl, fingerprint_key: job.fingerprint });
  await put(input.db, `SOURCE#${input.sourceId}`, `OCCURRENCE#${input.externalId}`, 'source-occurrence', state);
  return { state, job };
}

describe('trusted admission backfill', () => {
  it('publishes a suppressed qualifying row from its stored evidence and clears the migration flag', async () => {
    const { database, db } = subject();
    const admission = admissionOf('application-form', ['employer-unresolved']);
    await suppressedRow({ db, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1', admission });
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));

    const dryRun = await runTrustedAdmissionBackfill(db);
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.expectedChanged).toBe(1);
    expect(dryRun.totals).toEqual({ published: 1, regraded: 0, unchanged: 0, skipped: 0 });
    expect(dryRun.changes).toEqual({ occurrences: 1, jobs: 1, checkpoints: 1 });
    expect(dryRun.repairToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(dryRun.conflicts).toEqual([]);
    expect(dryRun.before[TRUSTED_SOURCE]).toEqual({ eligible: 0, blocked: 0, suppressed: 1 });
    expect(dryRun.after[TRUSTED_SOURCE]).toEqual({ eligible: 1, blocked: 0, suppressed: 0 });
    expect(dryRun.samples.published).toEqual([`${TRUSTED_SOURCE}:ext-1`]);

    const applied = await runTrustedAdmissionBackfill(db, {
      apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged,
    });
    expect(applied.dryRun).toBe(false);
    expect(applied.conflicts).toEqual([]);
    expect(applied.projectionRefreshRequired).toBe(true);

    const version = await currentVersion(db, TRUSTED_SOURCE);
    const job = read<Internship>(database, 'JOB#job-1', 'META');
    expect(job.admission).toMatchObject({
      catalogEligible: true,
      alertEligible: false,
      reasonCodes: ['employer-unresolved'],
      evidenceCodes: ['trusted-community-source'],
      employerResolution: 'source-reported',
    });
    expect(job.catalogVisibleAt).toBe(job.firstSeenAt);
    expect(job.sourceReferences[0]?.admission).toEqual(job.admission);
    expect(job.sourceReferences[0]?.admissionConfigurationVersion).toBe(version);
    expect(job.sourceReferences[0]?.trustedCommunityAlertQualification?.catalogPublicationSuppressed).toBe(false);

    const occurrence = read<SourceOccurrenceState>(database, `SOURCE#${TRUSTED_SOURCE}`, 'OCCURRENCE#ext-1');
    expect(occurrence.occurrence.admission).toEqual(job.admission);
    expect(occurrence.occurrence.admission?.catalogEligible).toBe(true);
    expect(occurrence.occurrence.admission?.alertEligible).toBe(false);
    expect(occurrence.occurrence.admissionConfigurationVersion).toBe(version);
    expect(occurrence.occurrence.trustedCommunityAlertQualification?.catalogPublicationSuppressed).toBe(false);

    const checkpoint = read<SourceCheckpoint>(database, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT');
    expect(checkpoint.pendingAdmissionConfigurationVersion).toBeUndefined();
    expect(checkpoint).toMatchObject({
      sourceId: TRUSTED_SOURCE, successfulFetches: 3, admissionConfigurationVersion: 'stale', activeExternalIds: ['ext-1'],
    });

    // The role has to be discoverable by the projection the route refreshes.
    const columns = database.prepare("SELECT catalog_state, catalog_sort_key, search_text, sms_pending, digest_pending FROM catalog_items WHERE pk = 'JOB#job-1'").get() as Record<string, unknown>;
    expect(columns.catalog_state).toBe('OPEN');
    expect(String(columns.catalog_sort_key)).toMatch(/^3#/u);
    expect(String(columns.search_text)).toContain('acme');
    expect(columns.sms_pending).toBe(0);
    expect(columns.digest_pending).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get() as { count: number }).count).toBe(0);
  });

  it('re-grades a blocked destination to the current version without publishing it', async () => {
    const { database, db } = subject();
    const admission = admissionOf('aggregate-board', ['destination-aggregate-board', 'employer-unresolved']);
    await suppressedRow({ db, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1', admission });
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));

    const dryRun = await runTrustedAdmissionBackfill(db);
    expect(dryRun.totals).toEqual({ published: 0, regraded: 1, unchanged: 0, skipped: 0 });
    expect(dryRun.changes).toEqual({ occurrences: 1, jobs: 1, checkpoints: 1 });
    expect(dryRun.before[TRUSTED_SOURCE]).toEqual({ eligible: 0, blocked: 0, suppressed: 1 });
    expect(dryRun.after[TRUSTED_SOURCE]).toEqual({ eligible: 0, blocked: 1, suppressed: 0 });

    const applied = await runTrustedAdmissionBackfill(db, {
      apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged,
    });
    expect(applied.totals.regraded).toBe(1);
    // The token covers no published row here, yet the re-grade is applied.
    expect(applied.appliedTotals).toEqual({ published: 0, regraded: 1 });
    expect(applied.regradedWithoutGuard).toBe(true);

    // The version stamp is the poller's migration cursor: it must stop selecting this row.
    const version = await currentVersion(db, TRUSTED_SOURCE);
    const occurrence = read<SourceOccurrenceState>(database, `SOURCE#${TRUSTED_SOURCE}`, 'OCCURRENCE#ext-1');
    expect(occurrence.occurrence.admissionConfigurationVersion).toBe(version);
    expect(occurrence.occurrence.admission?.catalogEligible).toBe(false);
    expect(occurrence.occurrence.admission?.reasonCodes).toEqual(['destination-aggregate-board', 'employer-unresolved']);
    expect(occurrence.occurrence.trustedCommunityAlertQualification?.catalogPublicationSuppressed).toBe(false);
    const job = read<Internship>(database, 'JOB#job-1', 'META');
    expect(job.admission?.catalogEligible).toBe(false);
    expect(job.sourceReferences[0]?.admissionConfigurationVersion).toBe(version);
    expect((database.prepare("SELECT catalog_state FROM catalog_items WHERE pk = 'JOB#job-1'").get() as { catalog_state: string | null }).catalog_state).toBeNull();
    expect(read<SourceCheckpoint>(database, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT').pendingAdmissionConfigurationVersion).toBeUndefined();
  });

  it('leaves a standard-policy source and its checkpoint untouched', async () => {
    const { database, db } = subject();
    const standardCheckpoint = checkpointOf(STANDARD_SOURCE, { pendingAdmissionConfigurationVersion: 'stale' });
    const standardReference = referenceOf({ sourceId: STANDARD_SOURCE, externalId: 'board-9', version: 'stale', suppressed: false });
    const standardState = occurrenceStateOf({ sourceId: STANDARD_SOURCE, externalId: 'board-9', jobId: 'job-9', reference: standardReference });
    const standardJob = jobOf({ jobId: 'job-9', reference: standardReference });
    await put(db, 'JOB#job-9', 'META', 'internship', standardJob, { url_key: standardJob.normalizedUrl, fingerprint_key: standardJob.fingerprint });
    await put(db, `SOURCE#${STANDARD_SOURCE}`, 'OCCURRENCE#board-9', 'source-occurrence', standardState);
    await put(db, `SOURCE#${STANDARD_SOURCE}`, 'CHECKPOINT', 'checkpoint', standardCheckpoint);
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1',
      admission: admissionOf('application-form', ['employer-unresolved']),
    });
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));
    const standardValues = database.prepare('SELECT pk, sk, value FROM catalog_items WHERE pk = ? ORDER BY sk')
      .all(`SOURCE#${STANDARD_SOURCE}`) as Array<{ pk: string; sk: string; value: string }>;
    const standardJobValue = (database.prepare('SELECT value FROM catalog_items WHERE pk = ?').get('JOB#job-9') as { value: string }).value;

    const dryRun = await runTrustedAdmissionBackfill(db);
    expect(dryRun.before[STANDARD_SOURCE]).toBeUndefined();
    expect(dryRun.totals.published).toBe(1);
    await runTrustedAdmissionBackfill(db, { apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged });

    expect(database.prepare('SELECT pk, sk, value FROM catalog_items WHERE pk = ? ORDER BY sk').all(`SOURCE#${STANDARD_SOURCE}`))
      .toEqual(standardValues);
    expect((database.prepare('SELECT value FROM catalog_items WHERE pk = ?').get('JOB#job-9') as { value: string }).value).toBe(standardJobValue);
    expect(read<Internship>(database, 'JOB#job-1', 'META').admission?.catalogEligible).toBe(true);
  });

  it('requires the dry-run token and count, writes nothing when they are stale, and is idempotent', async () => {
    const recorder: Recorder = { log: [], batchSizes: [] };
    const { database, db } = subject(recorder);
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1',
      admission: admissionOf('application-form', ['employer-unresolved']),
    });
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));
    const writes = () => recorder.log!.filter((entry) => /^\s*(?:INSERT|UPDATE|DELETE)/iu.test(entry.query));
    const fixtureWrites = writes().length;

    const dryRun = await runTrustedAdmissionBackfill(db);
    expect(dryRun.expectedChanged).toBe(1);
    expect(writes().length).toBe(fixtureWrites);

    await expect(runTrustedAdmissionBackfill(db, { apply: true, repairToken: 'stale', expectedChanged: 1 })).rejects.toThrow(/changed after dry run/u);
    // A count that does not match the published set the token covers.
    await expect(runTrustedAdmissionBackfill(db, { apply: true, repairToken: dryRun.repairToken, expectedChanged: 2 })).rejects.toThrow(/changed after dry run/u);
    expect(writes().length).toBe(fixtureWrites);
    expect(read<Internship>(database, 'JOB#job-1', 'META').admission?.catalogEligible).toBe(false);

    const applied = await runTrustedAdmissionBackfill(db, { apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged });
    expect(applied.totals.published).toBe(1);
    expect(applied.conflicts).toEqual([]);
    expect(applied.projectionRefreshRequired).toBe(true);

    const settled = await runTrustedAdmissionBackfill(db);
    expect(settled.expectedChanged).toBe(0);
    expect(settled.totals).toEqual({ published: 0, regraded: 0, unchanged: 1, skipped: 0 });
    const writesBefore = writes().length;
    const second = await runTrustedAdmissionBackfill(db, { apply: true, repairToken: settled.repairToken, expectedChanged: 0 });
    expect(second.dryRun).toBe(false);
    expect(second.conflicts).toEqual([]);
    expect(second.projectionRefreshRequired).toBe(false);
    expect(second.expectedChanged).toBe(0);
    expect(second.totals).toEqual({ published: 0, regraded: 0, unchanged: 1, skipped: 0 });
    expect(writes().length).toBe(writesBefore);
  });

  it('applies when only re-graded rows drifted since the dry run', async () => {
    const { database, db } = subject();
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1',
      admission: admissionOf('application-form', ['employer-unresolved']),
    });
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-2', jobId: 'job-2',
      admission: admissionOf('aggregate-board', ['destination-aggregate-board', 'employer-unresolved']),
    });
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));

    const dryRun = await runTrustedAdmissionBackfill(db);
    expect(dryRun.totals).toEqual({ published: 1, regraded: 1, unchanged: 0, skipped: 0 });
    // Only the published row is guarded: a row that merely re-grades cannot
    // change what anyone can see, so it must not invalidate the token.
    expect(dryRun.expectedChanged).toBe(1);

    // What a live catalog does between a dry run and the apply it authorizes:
    // other sources re-stamp the shared job row, and another blocked occurrence
    // arrives to be re-graded.
    const shared = read<Internship>(database, 'JOB#job-1', 'META');
    database.prepare('UPDATE catalog_items SET value = ? WHERE pk = ? AND sk = ?')
      .run(JSON.stringify({ ...shared, lastSeenAt: '2026-09-14T00:00:00Z' }), 'JOB#job-1', 'META');
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-3', jobId: 'job-3',
      admission: admissionOf('aggregate-board', ['destination-aggregate-board', 'employer-unresolved']),
    });

    const applied = await runTrustedAdmissionBackfill(db, {
      apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged,
    });
    expect(applied.conflicts).toEqual([]);
    expect(applied.totals).toEqual({ published: 1, regraded: 2, unchanged: 0, skipped: 0 });
    expect(applied.appliedTotals).toEqual({ published: 1, regraded: 2 });
    expect(applied.regradedWithoutGuard).toBe(true);
    expect(applied.projectionRefreshRequired).toBe(true);

    const version = await currentVersion(db, TRUSTED_SOURCE);
    expect(read<Internship>(database, 'JOB#job-1', 'META').admission?.catalogEligible).toBe(true);
    for (const jobId of ['job-2', 'job-3']) {
      const job = read<Internship>(database, `JOB#${jobId}`, 'META');
      expect(job.admission?.catalogEligible).toBe(false);
      expect(job.sourceReferences[0]?.admissionConfigurationVersion).toBe(version);
    }
    expect(read<SourceCheckpoint>(database, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT').pendingAdmissionConfigurationVersion).toBeUndefined();
  });

  it('refuses the apply and writes nothing when the published set drifted since the dry run', async () => {
    const recorder: Recorder = { log: [] };
    const { database, db } = subject(recorder);
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1',
      admission: admissionOf('application-form', ['employer-unresolved']),
    });
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));
    const writes = () => recorder.log!.filter((entry) => /^\s*(?:INSERT|UPDATE|DELETE)/iu.test(entry.query));

    const dryRun = await runTrustedAdmissionBackfill(db);
    expect(dryRun.expectedChanged).toBe(1);

    // A second occurrence becomes publishable. The guard covers it, so the token
    // and count the dry run issued authorize nothing any more.
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-2', jobId: 'job-2',
      admission: admissionOf('application-form', ['employer-unresolved']),
    });
    const fixtureWrites = writes().length;
    await expect(runTrustedAdmissionBackfill(db, {
      apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged,
    })).rejects.toThrow(/changed after dry run/u);
    expect(writes().length).toBe(fixtureWrites);
    expect(read<Internship>(database, 'JOB#job-1', 'META').admission?.catalogEligible).toBe(false);
    expect(read<Internship>(database, 'JOB#job-2', 'META').admission?.catalogEligible).toBe(false);
    expect(read<SourceCheckpoint>(database, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT').pendingAdmissionConfigurationVersion).toBe('stale');

    // The published set a fresh dry run sees is the one that authorizes writes.
    const fresh = await runTrustedAdmissionBackfill(db);
    expect(fresh.expectedChanged).toBe(2);
    expect(fresh.repairToken).not.toBe(dryRun.repairToken);
    const applied = await runTrustedAdmissionBackfill(db, {
      apply: true, repairToken: fresh.repairToken, expectedChanged: fresh.expectedChanged,
    });
    expect(applied.conflicts).toEqual([]);
    expect(applied.appliedTotals).toEqual({ published: 2, regraded: 0 });
    expect(read<Internship>(database, 'JOB#job-2', 'META').admission?.catalogEligible).toBe(true);
  });

  it('reads a large source in bounded pages and applies it in bounded guarded batches', async () => {
    const recorder: Recorder = { log: [], batchSizes: [] };
    const { database, db } = subject(recorder);
    const total = 300;
    const admission = admissionOf('application-form', ['employer-unresolved']);
    for (let index = 0; index < total; index += 1) {
      await suppressedRow({ db, sourceId: TRUSTED_SOURCE, externalId: `ext-${index}`, jobId: `job-${index}`, admission });
    }
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));
    const catalogReads = () => recorder.log!.filter((entry) => /^\s*SELECT[\s\S]*FROM catalog_items/iu.test(entry.query));
    const pages = () => catalogReads().filter((entry) => /LIKE 'OCCURRENCE#%'/u.test(entry.query));
    const guardedApplies = () => recorder.log!.filter((entry) => /UPDATE catalog_items AS target/u.test(entry.query));

    const dryRun = await runTrustedAdmissionBackfill(db);
    expect(dryRun.expectedChanged).toBe(total);
    expect(pages().length).toBeGreaterThan(1);
    expect(pages().every((entry) => entry.values[2] === 250)).toBe(true);
    expect(catalogReads().every((entry) => /LIMIT/iu.test(entry.query))).toBe(true);
    // D1 rejects a statement binding more than 100 parameters, a limit the local
    // sqlite harness does not enforce: every statement must stay under it.
    expect(recorder.log!.every((entry) => entry.values.length <= 100)).toBe(true);

    await runTrustedAdmissionBackfill(db, { apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged });
    expect(guardedApplies().length).toBeGreaterThan(1);
    expect(Math.max(...recorder.batchSizes!)).toBeLessThanOrEqual(25);

    const published = database.prepare('SELECT COUNT(*) AS count FROM catalog_items WHERE pk LIKE \'JOB#%\' AND catalog_state = \'OPEN\'').get() as { count: number };
    expect(published.count).toBe(total);
    expect((database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'trusted-admission-repair'").get() as { count: number }).count).toBe(0);
    expect(read<SourceCheckpoint>(database, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT').pendingAdmissionConfigurationVersion).toBeUndefined();
    const settled = await runTrustedAdmissionBackfill(db);
    expect(settled.expectedChanged).toBe(0);
    expect(settled.totals.unchanged).toBe(total);
  });

  it('applies a guarded group atomically and reports a concurrent writer instead of overwriting it', async () => {
    const { database, db: plain } = subject();
    await suppressedRow({
      db: plain, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1',
      admission: admissionOf('application-form', ['employer-unresolved']),
    });
    await put(plain, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));
    const occurrenceValue = (database.prepare("SELECT value FROM catalog_items WHERE pk = 'SOURCE#speedyapply-2027-swe' AND sk = 'OCCURRENCE#ext-1'").get() as { value: string }).value;
    const dryRun = await runTrustedAdmissionBackfill(plain);
    expect(dryRun.expectedChanged).toBe(1);

    // A concurrent writer touches the job after this run planned the group.
    let raced = false;
    const hook = (statement: D1PreparedStatement): D1PreparedStatement => ({
      bind(...values: unknown[]) { return hook(statement.bind(...values)); },
      first: () => statement.first(),
      all: () => statement.all(),
      async run() {
        if (!raced) {
          raced = true;
          database.prepare("UPDATE catalog_items SET value = value || ' ' WHERE pk = 'JOB#job-1'").run();
        }
        return statement.run();
      },
    });
    const racing: D1Database = { prepare: (query) => hook(plain.prepare(query)), batch: (statements) => plain.batch(statements) };

    const applied = await runTrustedAdmissionBackfill(racing, {
      apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged,
    });
    expect(raced).toBe(true);
    expect(applied.conflicts).toEqual(['job-1']);
    expect(applied.projectionRefreshRequired).toBe(false);
    expect((database.prepare("SELECT value FROM catalog_items WHERE pk = 'SOURCE#speedyapply-2027-swe' AND sk = 'OCCURRENCE#ext-1'").get() as { value: string }).value)
      .toBe(occurrenceValue);
    expect((database.prepare("SELECT value FROM catalog_items WHERE pk = 'JOB#job-1'").get() as { value: string }).value).toMatch(/\}\s$/u);
    expect((database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'trusted-admission-repair'").get() as { count: number }).count).toBe(0);
  });

  it('keeps the migration flag while any occurrence of the source is ungraded', async () => {
    const { database, db } = subject();
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1',
      admission: admissionOf('application-form', ['employer-unresolved']),
    });
    // A stored occurrence whose canonical job is gone cannot be graded offline.
    const orphan = occurrenceStateOf({
      sourceId: TRUSTED_SOURCE, externalId: 'ext-orphan', jobId: 'job-missing',
      reference: referenceOf({
        sourceId: TRUSTED_SOURCE, externalId: 'ext-orphan', version: 'stale', suppressed: true,
        admission: admissionOf('application-form', ['employer-unresolved']),
      }),
    });
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'OCCURRENCE#ext-orphan', 'source-occurrence', orphan);
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));

    const dryRun = await runTrustedAdmissionBackfill(db);
    expect(dryRun.totals).toEqual({ published: 1, regraded: 0, unchanged: 0, skipped: 1 });
    expect(dryRun.samples.skipped).toEqual([`${TRUSTED_SOURCE}:ext-orphan`]);
    expect(dryRun.changes.checkpoints).toBe(0);
    await runTrustedAdmissionBackfill(db, { apply: true, repairToken: dryRun.repairToken, expectedChanged: dryRun.expectedChanged });

    expect(read<Internship>(database, 'JOB#job-1', 'META').admission?.catalogEligible).toBe(true);
    expect(read<SourceCheckpoint>(database, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT').pendingAdmissionConfigurationVersion).toBe('stale');
  });

  it('scopes a run to the requested trusted sources and refuses standard ones', async () => {
    const { db } = subject();
    await suppressedRow({
      db, sourceId: TRUSTED_SOURCE, externalId: 'ext-1', jobId: 'job-1',
      admission: admissionOf('application-form', ['employer-unresolved']),
    });
    await put(db, `SOURCE#${TRUSTED_SOURCE}`, 'CHECKPOINT', 'checkpoint', checkpointOf(TRUSTED_SOURCE, {
      pendingAdmissionConfigurationVersion: 'stale',
    }));

    const scoped = await runTrustedAdmissionBackfill(db, { sourceIds: [TRUSTED_SOURCE] });
    expect(Object.keys(scoped.before)).toEqual([TRUSTED_SOURCE]);
    expect(scoped.expectedChanged).toBe(1);
    await expect(runTrustedAdmissionBackfill(db, { sourceIds: [STANDARD_SOURCE] })).rejects.toThrow(/Not trusted-community sources/u);
  });
});
