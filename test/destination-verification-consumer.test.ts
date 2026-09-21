import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { enqueueDueDestinationVerifications, processDestinationVerificationBatch, sendAdmissionOperationalAlert,
  type DestinationVerificationEnvironment,
  type DestinationVerificationMessage } from '../cloudflare/destination-verification.js';
import type { D1Database, D1PreparedStatement, MessageBatch, QueueMessage, R2Bucket } from '../cloudflare/types.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import type { Internship, SourceOccurrence } from '../src/types.js';
import { normalizeExactPostingDescription } from '../src/shadow-extraction.js';
import { metadataDescriptionText } from '../src/core/metadata-text.js';

const launch = vi.hoisted(() => vi.fn());
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch } }));

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return database.prepare(query).get(...values) as T | null; },
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
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql', '0008_catalog_admission_occurrence_repair.sql',
    '0010_posting_identity.sql',
    '0012_destination_verification_schedule.sql', '0015_role_metadata_enrichment.sql', '0016_role_metadata_repair_plans.sql',
    '0017_metadata_acquisition.sql', '0018_metadata_review.sql', '0019_metadata_job_review_revision.sql',
    '0020_shadow_extraction.sql', '0021_shadow_extraction_fencing.sql',
    '0022_shadow_extraction_cache_expiry.sql', '0026_shadow_extraction_origin.sql', '0032_shadow_extraction_input_completeness.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database);
  return { database, db, operations: new D1CatalogAdmissionStore(db), jobs: new D1InternshipStore(db) };
}

function role(): { job: Internship; reference: SourceOccurrence } {
  const reference: SourceOccurrence = {
    sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: '7654321', document: '7654321',
    sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme',
    title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321', compensation: { raw: '' }, state: 'open',
  };
  return { reference, job: {
    jobId: 'job-1', company: reference.company, title: reference.title, location: reference.location, season: reference.season,
    applyUrl: reference.applyUrl, normalizedUrl: reference.applyUrl, fingerprint: 'fingerprint', compensation: { raw: '' },
    sourceReferences: [reference], technical: true, open: true, firstSeenAt: '2026-08-01T00:00:00Z',
    catalogVisibleAt: '2026-08-01T00:00:00Z', catalogRecency: 'normal', lastSeenAt: '2026-08-30T00:00:00Z',
    notification: { smsPending: false, digestPending: false },
  } };
}

function queueMessage(body: DestinationVerificationMessage) {
  return { id: 'message-1', body, ack: vi.fn(), retry: vi.fn() } satisfies QueueMessage<DestinationVerificationMessage>;
}

function environment(db: D1Database): DestinationVerificationEnvironment {
  return {
    DB: db, DESTINATION_BROWSER: {} as DestinationVerificationEnvironment['DESTINATION_BROWSER'],
    DESTINATION_VERIFICATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
  };
}

describe('destination verification queue consumer', () => {
  beforeEach(() => {
    launch.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('acknowledges a duplicate completion without opening a page or mutating state', async () => {
    const { db, operations } = subject();
    await operations.recordVerificationCompletion('already-complete', '2026-08-30T00:00:00Z');
    const newPage = vi.fn();
    launch.mockResolvedValue({ newPage, close: vi.fn() });
    const { reference } = role();
    const queued = queueMessage({ version: 1, jobId: 'job-1', sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', idempotencyKey: 'already-complete' });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(newPage).not.toHaveBeenCalled();
  });

  it('discards a live message when the occurrence URL and posting identity have changed', async () => {
    const { db, jobs } = subject();
    const { job, reference } = role();
    const currentReference = { ...reference, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/8765432' };
    await jobs.putInternship({ ...job, applyUrl: currentReference.applyUrl, normalizedUrl: currentReference.applyUrl,
      sourceReferences: [currentReference] });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', idempotencyKey: 'stale-generation' });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db),
      () => new Date('2026-08-30T00:01:00Z'));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(await jobs.getJob(job.jobId)).toMatchObject({ applyUrl: currentReference.applyUrl,
      sourceReferences: [{ applyUrl: currentReference.applyUrl }] });
  });

  it('settles a scheduled check when the same destination was attempted recently', async () => {
    const { db, operations, jobs } = subject();
    const { job, reference } = role();
    const priorAdmission = {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved' as const,
      postingAttribution: 'attributed' as const,
      destination: { classification: 'posting-detail' as const, candidateUrl: reference.applyUrl,
        provider: 'greenhouse' as const, tenant: 'acme', expectedPostingId: reference.externalId,
        inspectedAt: '2026-08-24T00:00:00Z', freshUntil: '2026-08-31T00:00:00Z', nextCheckAt: '2026-08-30T00:00:00Z' },
      metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
      catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt: '2026-08-24T00:00:00Z',
      evidenceObservedAt: '2026-08-24T00:00:00Z',
    };
    reference.admission = priorAdmission;
    job.admission = priorAdmission;
    await jobs.putInternship({ ...job, sourceReferences: [reference] });
    await operations.syncVerificationSchedule('2026-08-30T00:00:00Z');
    const [scheduled] = await operations.leaseDueVerifications('2026-08-30T00:00:00Z');
    await operations.recordVerificationAttempt({ id: 'recent-attempt', jobId: job.jobId, sourceId: reference.sourceId,
      candidateUrl: reference.applyUrl, state: 'failed', error: 'Navigation timeout',
      attemptedAt: '2026-08-30T00:00:20Z', completedAt: '2026-08-30T00:00:30Z' });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: scheduled!.providerIdentity,
      reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', occurrenceKey: scheduled!.occurrenceKey,
      leaseToken: scheduled!.leaseToken, idempotencyKey: 'recent-scheduled-generation' });

    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db),
      () => new Date('2026-08-30T00:01:00Z'));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    await expect(operations.verificationCompleted('recent-scheduled-generation')).resolves.toBe(true);
    await expect(operations.leaseDueVerifications('2026-08-30T00:16:00Z')).resolves.toEqual([]);
    await expect(operations.leaseDueVerifications('2026-08-31T00:01:00Z')).resolves.toHaveLength(1);
  });

  it('does not persist evidence when the occurrence changes while the browser is running', async () => {
    const { database, db, jobs } = subject();
    const { job, reference } = role();
    await jobs.putInternship(job);
    const changedReference = { ...reference, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/8765432' };
    const frame = { waitForFunction: vi.fn().mockResolvedValue({ dispose: vi.fn() }), evaluate: vi.fn().mockResolvedValue({ url: reference.applyUrl, title: reference.title,
      visibleText: `${reference.title} ${reference.externalId} Apply`,
      structuredJobText: JSON.stringify({ '@type': 'JobPosting', identifier: reference.externalId, title: reference.title }),
      jobPostingCount: 1, distinctJobLinkCount: 0, applicationFormPresent: true }), parentFrame: () => null };
    launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockImplementation(async () => {
        await jobs.putInternship({ ...job, applyUrl: changedReference.applyUrl, normalizedUrl: changedReference.applyUrl,
          sourceReferences: [changedReference] });
        return { status: () => 200 };
      }),
      frames: () => [frame], close: vi.fn(),
    }), close: vi.fn() });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', idempotencyKey: 'raced-generation' });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db),
      () => new Date('2026-08-30T00:01:00Z'));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    const stored = await jobs.getJob(job.jobId);
    expect(stored).toMatchObject({ applyUrl: changedReference.applyUrl,
      sourceReferences: [{ applyUrl: changedReference.applyUrl }] });
    expect(stored?.sourceReferences[0]).not.toHaveProperty('admission');
    expect(database.prepare('SELECT count(*) AS count FROM destination_verification_evidence').get()).toEqual({ count: 0 });
  });

  it('keeps historical evidence out of live evidence and catalog state', async () => {
    const { database, db, operations, jobs } = subject();
    const { job, reference } = role();
    await jobs.putInternship(job);
    const before = await jobs.getJob(job.jobId);
    const generation = await operations.previewBackfill('2026-08-30T00:00:00Z');
    const [candidate] = await operations.backfillPage(generation.id);
    await operations.markBackfillQueued(generation.id, [candidate!.occurrenceKey], '2026-08-30T00:01:00Z');
    await operations.recordVerificationAttempt({ id: 'recent-live-attempt', jobId: job.jobId, sourceId: reference.sourceId,
      candidateUrl: reference.applyUrl, state: 'failed', error: 'Navigation timeout',
      attemptedAt: '2026-08-30T00:00:20Z', completedAt: '2026-08-30T00:00:30Z' });
    const frame = { evaluate: vi.fn().mockResolvedValue({ url: reference.applyUrl, title: reference.title,
      visibleText: `${reference.externalId} Responsibilities and qualifications. ${'Build reliable systems. '.repeat(30)}`,
      structuredJobText: JSON.stringify({ '@type': 'JobPosting', identifier: reference.externalId, description: reference.title }),
      jobPostingCount: 1, distinctJobLinkCount: 0, applicationFormPresent: true }), parentFrame: () => null };
    launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockResolvedValue({ status: () => 200 }), url: () => reference.applyUrl,
      evaluate: vi.fn().mockResolvedValue([]), frames: () => [frame], close: vi.fn(),
    }), close: vi.fn() });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: candidate!.providerIdentity,
      reason: 'historical-backfill', queuedAt: '2026-08-30T00:01:00Z', generationId: generation.id,
      occurrenceKey: candidate!.occurrenceKey });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] } as MessageBatch<unknown>,
      environment(db), () => new Date('2026-08-30T00:02:00Z'));
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(await jobs.getJob(job.jobId)).toEqual(before);
    expect(database.prepare('SELECT count(*) AS count FROM admission_backfill_evidence').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT count(*) AS count FROM destination_verification_evidence').get()).toEqual({ count: 0 });
    await expect(operations.hasVerificationAttemptSince(job.jobId, reference.sourceId, reference.applyUrl,
      '2026-08-29T00:00:00Z')).resolves.toBe(true);
    database.prepare("DELETE FROM destination_verification_attempts WHERE id = 'recent-live-attempt'").run();
    await expect(operations.hasVerificationAttemptSince(job.jobId, reference.sourceId, reference.applyUrl,
      '2026-08-29T00:00:00Z')).resolves.toBe(false);
  });

  it('hands a verified exact posting off through R2 and the shadow queue after catalog persistence', async () => {
    const { database, db, jobs } = subject();
    const { job, reference } = role();
    await jobs.putInternship(job);
    const frame = {
      waitForFunction: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      evaluate: vi.fn().mockResolvedValue({ url: reference.applyUrl, title: reference.title,
        visibleText: `${reference.title}\nAustin\n$50 - $60 per hour\n${'Build reliable systems. '.repeat(30)}`,
        structuredJobText: JSON.stringify({ '@type': 'JobPosting', identifier: reference.externalId, title: reference.title }),
        jobPostingCount: 1, distinctJobLinkCount: 0, applicationFormPresent: true }),
      parentFrame: () => null,
    };
    launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockResolvedValue({ status: () => 200 }), url: () => reference.applyUrl,
      evaluate: vi.fn().mockResolvedValue([]), frames: () => [frame], close: vi.fn(),
    }), close: vi.fn() });
    const shadowQueue = { send: vi.fn(), sendBatch: vi.fn() };
    const artifactPut = vi.fn().mockResolvedValue(undefined);
    const shadowArtifacts = { put: artifactPut } as unknown as R2Bucket;
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'content-change', queuedAt: '2026-08-30T00:00:00Z', idempotencyKey: 'shadow-handoff', shadowOrigin: 'provider-poll' });

    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, {
      ...environment(db), SHADOW_EXTRACTION_QUEUE: shadowQueue, SHADOW_EXTRACTION_ARTIFACTS: shadowArtifacts,
    }, () => new Date('2026-08-30T00:01:00Z'));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(artifactPut).toHaveBeenCalledOnce();
    expect(shadowQueue.send).toHaveBeenCalledOnce();
    expect(shadowQueue.send.mock.calls[0]![0]).toMatchObject({ version: 1, jobId: job.jobId,
      sourceId: reference.sourceId, externalId: reference.externalId, origin: 'provider-poll' });
    expect(database.prepare('SELECT job_id, source_id, external_id FROM shadow_extraction_posting_revisions').get())
      .toEqual({ job_id: job.jobId, source_id: reference.sourceId, external_id: reference.externalId });
  });

  it('does not freshness-short-circuit a revision-bound natural provider shadow handoff', async () => {
    const { database, db, jobs } = subject();
    const { job, reference } = role();
    const description = `${reference.title}\nAustin\n$50 - $60 per hour\n${'Build reliable systems. '.repeat(30)}`;
    reference.admission = {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved', postingAttribution: 'attributed',
      destination: { classification: 'application-form', candidateUrl: reference.applyUrl, finalUrl: reference.applyUrl,
        provider: 'greenhouse', tenant: 'acme', expectedPostingId: reference.externalId, inspectedAt: '2026-08-30T00:00:00Z',
        freshUntil: '2026-09-06T00:00:00Z', nextCheckAt: '2026-09-05T00:00:00Z', browserVisible: true },
      metadata: { complete: true, title: 'complete', location: 'complete' }, catalogEligible: true, alertEligible: true,
      reasonCodes: [], evaluatedAt: '2026-08-30T00:00:00Z', evidenceObservedAt: '2026-08-30T00:00:00Z',
    };
    reference.metadataExtraction = { version: 15, artifactHash: 'current-artifact',
      observedAt: '2026-08-30T00:00:00Z', outcome: 'extracted' };
    await jobs.putInternship({ ...job, sourceReferences: [reference] });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({
      id: Number(reference.externalId), title: reference.title, content: description,
    })));
    const shadowQueue = { send: vi.fn(), sendBatch: vi.fn() };
    const artifactPut = vi.fn().mockResolvedValue(undefined);
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'content-change', queuedAt: '2026-08-30T00:00:00Z', idempotencyKey: 'natural-shadow-handoff',
      // A message only counts as current when it carries the running version.
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      shadowContentHash: normalizeExactPostingDescription(reference.title, metadataDescriptionText(description)).contentHash,
      shadowOrigin: 'provider-poll' });

    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, {
      ...environment(db), SHADOW_EXTRACTION_QUEUE: shadowQueue,
      SHADOW_EXTRACTION_ARTIFACTS: { put: artifactPut } as unknown as R2Bucket,
    }, () => new Date('2026-08-30T00:01:00Z'));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(artifactPut).toHaveBeenCalledOnce();
    expect(shadowQueue.send).toHaveBeenCalledOnce();
    expect(shadowQueue.send.mock.calls[0]![0]).toMatchObject({ origin: 'provider-poll' });
    expect(database.prepare('SELECT count(*) AS count FROM destination_verification_completions WHERE idempotency_key = ?')
      .get('natural-shadow-handoff')).toEqual({ count: 1 });

    const stale = queueMessage({ ...queued.body, idempotencyKey: 'stale-natural-shadow-handoff', shadowContentHash: '0'.repeat(64) });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [stale] }, {
      ...environment(db), SHADOW_EXTRACTION_QUEUE: shadowQueue,
      SHADOW_EXTRACTION_ARTIFACTS: { put: artifactPut } as unknown as R2Bucket,
    }, () => new Date('2026-08-30T00:02:00Z'));
    expect(stale.ack).toHaveBeenCalledOnce();
    expect(stale.retry).not.toHaveBeenCalled();
    expect(artifactPut).toHaveBeenCalledOnce();
    expect(shadowQueue.send).toHaveBeenCalledOnce();
  });

  it('hands a staging-only official API backfill off to shadow extraction', async () => {
    const { database, db, jobs } = subject();
    const { job, reference } = role();
    await jobs.putInternship(job);
    const before = await jobs.getJob(job.jobId);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      id: Number(reference.externalId), title: reference.title,
      content: `<p>${reference.title}</p><p>Austin</p><p>$50 - $60 per hour</p>`,
    })));
    const shadowQueue = { send: vi.fn(), sendBatch: vi.fn() };
    const artifactPut = vi.fn().mockResolvedValue(undefined);
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'historical-backfill', queuedAt: '2026-08-30T00:00:00Z',
      metadataBackfillToken: 'staging-only-shadow-handoff' });

    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, {
      ...environment(db), SHADOW_EXTRACTION_QUEUE: shadowQueue,
      SHADOW_EXTRACTION_ARTIFACTS: { put: artifactPut } as unknown as R2Bucket,
    }, () => new Date('2026-08-30T00:01:00Z'));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(await jobs.getJob(job.jobId)).toEqual(before);
    expect(artifactPut).toHaveBeenCalledOnce();
    expect(shadowQueue.send).toHaveBeenCalledOnce();
    expect(database.prepare('SELECT job_id, source_id, external_id FROM shadow_extraction_posting_revisions').get())
      .toEqual({ job_id: job.jobId, source_id: reference.sourceId, external_id: reference.externalId });
    expect(JSON.parse(database.prepare('SELECT report FROM role_metadata_acquisition WHERE job_id = ? AND source_id = ?')
      .get(job.jobId, reference.sourceId)!.report as string)).toMatchObject({
      shadowHandoff: { outcome: 'enqueued', method: 'greenhouse-api' },
    });
  });

  it('records text removed by normalization as skipped-no-text', async () => {
    const { database, db, jobs } = subject();
    const { job, reference } = role();
    await jobs.putInternship(job);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      id: Number(reference.externalId), title: reference.title, content: '\u0001',
    })));
    const shadowQueue = { send: vi.fn(), sendBatch: vi.fn() };
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'historical-backfill', queuedAt: '2026-08-30T00:00:00Z',
      metadataBackfillToken: 'normalized-empty-shadow-handoff' });

    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, {
      ...environment(db), SHADOW_EXTRACTION_QUEUE: shadowQueue,
      SHADOW_EXTRACTION_ARTIFACTS: { put: vi.fn() } as unknown as R2Bucket,
    }, () => new Date('2026-08-30T00:01:00Z'));

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(shadowQueue.send).not.toHaveBeenCalled();
    expect(JSON.parse(database.prepare('SELECT report FROM role_metadata_acquisition WHERE job_id = ? AND source_id = ?')
      .get(job.jobId, reference.sourceId)!.report as string)).toMatchObject({
      shadowHandoff: { outcome: 'skipped-no-text', method: 'greenhouse-api' },
    });
  });

  it('retries a durable metadata acquisition when its shadow queue handoff fails', async () => {
    const { database, db, jobs } = subject();
    const { job, reference } = role();
    await jobs.putInternship(job);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      id: Number(reference.externalId), title: reference.title,
      content: `<p>${reference.title}</p><p>Austin</p><p>$50 - $60 per hour</p>`,
    })));
    const shadowQueue = { send: vi.fn().mockRejectedValue(new Error('temporary queue failure')), sendBatch: vi.fn() };
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: {
        provider: 'greenhouse', sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
        tenant: 'acme', postingId: reference.externalId,
      }, reason: 'historical-backfill', queuedAt: '2026-08-30T00:00:00Z',
      metadataBackfillToken: 'retry-shadow-handoff' });

    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, {
      ...environment(db), SHADOW_EXTRACTION_QUEUE: shadowQueue,
      SHADOW_EXTRACTION_ARTIFACTS: { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket,
    }, () => new Date('2026-08-30T00:01:00Z'));

    expect(queued.ack).not.toHaveBeenCalled();
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 300 }, expect.any(Error));
    expect(JSON.parse(database.prepare('SELECT report FROM role_metadata_acquisition WHERE job_id = ? AND source_id = ?')
      .get(job.jobId, reference.sourceId)!.report as string)).toMatchObject({
      shadowHandoff: { outcome: 'failed', method: 'greenhouse-api' },
    });
  });

  it('retries a transient browser failure for platform retry and eventual DLQ handling', async () => {
    const { db, operations, jobs } = subject();
    const { job, reference } = role();
    const priorAdmission = {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved' as const,
      postingAttribution: 'attributed' as const,
      destination: { classification: 'posting-detail' as const, candidateUrl: reference.applyUrl,
        provider: 'greenhouse' as const, tenant: 'acme', expectedPostingId: reference.externalId,
        inspectedAt: '2026-08-24T00:00:00Z', freshUntil: '2026-08-31T00:00:00Z', nextCheckAt: '2026-08-30T00:00:00Z' },
      metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
      catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt: '2026-08-24T00:00:00Z',
      evidenceObservedAt: '2026-08-24T00:00:00Z',
    };
    reference.admission = priorAdmission;
    job.admission = priorAdmission;
    await jobs.putInternship({ ...job, sourceReferences: [reference] });
    await operations.syncVerificationSchedule('2026-08-30T00:00:00Z');
    const [scheduled] = await operations.leaseDueVerifications('2026-08-30T00:00:00Z');
    expect(scheduled).toBeDefined();
    launch.mockResolvedValue({ newPage: vi.fn().mockResolvedValue({
      goto: vi.fn().mockRejectedValue(new Error('timeout')), frames: () => [], close: vi.fn(),
    }), close: vi.fn() });
    const queued = queueMessage({ version: 1, jobId: job.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId!, candidateUrl: reference.applyUrl, providerIdentity: scheduled!.providerIdentity,
      reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z', occurrenceKey: scheduled!.occurrenceKey,
      leaseToken: scheduled!.leaseToken, idempotencyKey: 'scheduled-generation' });
    await processDestinationVerificationBatch({ queue: 'destination-verification', messages: [queued] }, environment(db),
      () => new Date('2026-08-30T00:01:00Z'));
    expect(queued.retry).toHaveBeenCalledWith({ delaySeconds: 86_400 });
    expect(queued.ack).not.toHaveBeenCalled();

    const queue = { send: vi.fn(), sendBatch: vi.fn() };
    // Owner decision, 2026-09-17: nothing re-inspects a destination after it is
    // admitted, so the sweep never enqueues a check however overdue one is.
    await expect(enqueueDueDestinationVerifications({ ...environment(db), DESTINATION_VERIFICATION_QUEUE: queue },
      new Date('2026-08-31T01:02:00Z'))).resolves.toBe(0);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('uses the configured verified sender for operational alerts', async () => {
    const { operations } = subject();
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', send);
    const sent = await sendAdmissionOperationalAlert(operations, {
      RESEND_API_KEY: 'resend-key', ADMISSION_SUPPORT_RECIPIENT: 'support@example.test',
      AUTH_FROM_EMAIL: 'Ntern <notifications@send.ntern.app>',
    }, { signals: ['destination-verification-dlq'], details: 'One message is waiting.', observedAt: '2026-08-30T12:00:00Z' });
    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const init = send.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: 'Ntern <notifications@send.ntern.app>',
      to: ['support@example.test'],
    });
    expect(JSON.parse(init.body as string).text).toContain('Action required: inspect the destination-verification DLQ');
    expect(JSON.parse(init.body as string).text).toContain('Do not purge messages.');
    vi.unstubAllGlobals();
  });
});
