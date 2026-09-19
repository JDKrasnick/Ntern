import { describe, expect, it } from 'vitest';
import { Poller } from '../src/poll.js';
import { SOURCE_METADATA_PROCESSING_REVISION } from '../src/ingestion/processor.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { MemoryInternshipStore } from '../src/store.js';
import { SourceFetchError } from '../src/sources/source-error.js';
import type { Internship, RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const sourceId = 'metadata-refresh-failure-fixture';
const row = (id: string): RawListing => ({
  sourceId, externalId: id, document: 'README.md', sourceUrl: 'https://github.com/example/jobs', row: 1,
  company: 'Acme', title: `Software Engineering Intern ${id}`, location: 'Remote', season: 'summer-2027',
  applyUrl: `https://jobs.example.com/${id}`, compensation: { raw: '' }, state: 'open',
  fetchedAt: '2026-09-06T12:00:00.000Z',
});

class Adapter implements SourceAdapter {
  readonly id = sourceId;
  constructor(readonly listings: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId, listings: this.listings, notModified: false,
      checkpoint: { sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastSuccessAt: '2026-09-06T12:00:00.000Z', lastRowCount: this.listings.length } };
  }
}

const resolver = {
  async configurationVersion() { return 'fixture-v1'; },
  async resolveCanonicalEmployer() { return undefined; },
  async resolveDestinationRule() { return undefined; },
};

describe('bounded metadata refresh persistence failures', () => {
  it.each([404, 410])('completes a new legacy row that is gone (%s) without publishing or retrying it', async (status) => {
    const store = new MemoryInternshipStore();
    const gone = row(`gone-${status}`);
    const adapter = new Adapter([gone]);
    await store.putCheckpoint({ sourceId, successfulFetches: 7, lastSuccessAt: '2026-09-05T12:00:00.000Z',
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, metadataProcessingRevision: 1 });
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const poll = () => new Poller([adapter], store, undefined, undefined,
      async () => { throw new SourceFetchError(`HTTP ${status}`, 'http', status); }, undefined, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });

    const report = await poll();
    expect(report.continuationSources).toEqual([]);
    expect(report.newJobs).toEqual([]);
    expect(store.notificationEvents.size).toBe(0);
    expect([...store.jobs.values()]).toEqual([]);
    expect(await store.getCheckpoint(sourceId)).toMatchObject({
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      metadataProcessingRevision: SOURCE_METADATA_PROCESSING_REVISION,
    });
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataProcessedRows).toBeUndefined();
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataOmissions).toBeUndefined();
  });

  it.each([403, 429, 'timeout'] as const)('keeps transient validation failure (%s) pending', async (kind) => {
    const store = new MemoryInternshipStore();
    const pending = row(`pending-${kind}`);
    const adapter = new Adapter([pending]);
    await store.putCheckpoint({ sourceId, successfulFetches: 7, lastSuccessAt: '2026-09-05T12:00:00.000Z',
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, metadataProcessingRevision: 1 });
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const poll = () => new Poller([adapter], store, undefined, undefined,
      async () => { throw kind === 'timeout' ? new SourceFetchError('timed out', 'transport') : new SourceFetchError(`HTTP ${kind}`, 'http', kind); },
      undefined, undefined, resolver).poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });

    const report = await poll();
    expect(report.continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION - 1);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataProcessedRows).toEqual([]);
    expect([...store.jobs.values()]).toEqual([]);
  });

  it.each([404, 410])('quarantines an existing legacy open job before certifying a gone destination (%s)', async (status) => {
    const store = new MemoryInternshipStore();
    const legacy = row(`existing-${status}`);
    const adapter = new Adapter([legacy]);
    let gone = false;
    let validationCalls = 0;
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const validate = async () => {
      validationCalls += 1;
      if (gone) throw new SourceFetchError(`HTTP ${status}`, 'http', status);
      return 'live';
    };
    const poll = () => new Poller([adapter], store, undefined, undefined, validate, false, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    await poll();
    const jobId = [...store.jobs.keys()][0]!;
    const existing = await store.getJob(jobId);
    expect(existing).toBeDefined();
    await store.putInternship({ ...existing!, applicationUrlValidatedAt: undefined });
    const complete = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, metadataProcessingRevision: 1 });
    gone = true;

    const callsBeforeGone = validationCalls;
    const report = await poll();
    expect(validationCalls).toBeGreaterThan(callsBeforeGone);
    expect(report.continuationSources).toEqual([]);
    expect(await store.getJob(jobId)).toMatchObject({ open: false, notification: { smsPending: false, digestPending: false } });
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
  });

  it('keeps a failed legacy quarantine pending and retries it durably', async () => {
    class QuarantineFailureStore extends MemoryInternshipStore {
      failQuarantine = true;
      override async putInternship(job: Internship) {
        if (this.failQuarantine && !job.open) throw new Error('quarantine write failed');
        return super.putInternship(job);
      }
    }
    const store = new QuarantineFailureStore();
    const adapter = new Adapter([row('existing-quarantine-failure')]);
    let gone = false;
    let validationCalls = 0;
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const validate = async () => {
      validationCalls += 1;
      if (gone) throw new SourceFetchError('HTTP 410', 'http', 410);
      return 'live';
    };
    const poll = () => new Poller([adapter], store, undefined, undefined, validate, false, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    await poll();
    const jobId = [...store.jobs.keys()][0]!;
    const existing = await store.getJob(jobId);
    expect(existing).toBeDefined();
    await store.putInternship({ ...existing!, applicationUrlValidatedAt: undefined });
    const complete = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, metadataProcessingRevision: 1 });
    gone = true;
    const callsBeforeGone = validationCalls;
    expect((await poll()).continuationSources).toEqual([sourceId]);
    expect(validationCalls).toBeGreaterThan(callsBeforeGone);
    expect((await store.getJob(jobId))!.open).toBe(true);
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION - 1);
    store.failQuarantine = false;
    expect((await poll()).continuationSources).toEqual([]);
    expect((await store.getJob(jobId))!.open).toBe(false);
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
  });

  it('does not checkpoint an omission when the legacy closed-job fallback fails', async () => {
    class ClosedJobFailureStore extends MemoryInternshipStore {
      failClosedJob = false;
      override async putInternship(job: Internship) {
        if (this.failClosedJob && !job.open) { this.failClosedJob = false; throw new Error('closed job write failed'); }
        return super.putInternship(job);
      }
    }
    const store = new ClosedJobFailureStore();
    const adapter = new Adapter([row('active'), row('missing')]);
    const poll = () => new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    await poll();
    const missing = (await store.getSourceOccurrences(sourceId)).find((item) => item.externalId === 'missing')!;
    store.occurrences.set(`${sourceId}#missing`, { ...missing, present: true, consecutiveOmissions: 1,
      occurrence: { ...missing.occurrence, postingIdentityDecision: undefined } });
    const complete = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 });
    adapter.listings.splice(0, adapter.listings.length, row('active'));
    await poll(); // current-row metadata slice; lifecycle work follows separately
    store.failClosedJob = true;

    const failed = await poll();
    expect(failed.continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataOmissions?.map((item) => item.externalId))
      .not.toContain('missing');
    expect((await store.getJob(missing.jobId))?.open).toBe(true);

    expect((await poll()).continuationSources).toEqual([]);
    expect((await store.getJob(missing.jobId))?.open).toBe(false);
  });

  it('does not checkpoint a legacy row when its combined job/event write fails', async () => {
    class EventFailureStore extends MemoryInternshipStore {
      failEvent = true;
      override async putInternshipWithNotificationEvent(job: Internship, event: Parameters<MemoryInternshipStore['putInternshipWithNotificationEvent']>[1]) {
        if (this.failEvent) { this.failEvent = false; throw new Error('legacy event write failed'); }
        return super.putInternshipWithNotificationEvent(job, event);
      }
    }
    const store = new EventFailureStore();
    await store.putCheckpoint({ sourceId, successfulFetches: 1, lastSuccessAt: '2026-09-05T12:00:00.000Z',
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 });
    const adapter = new Adapter([row('new-role')]);
    const poll = () => {
      const runner = new Poller([adapter], store, undefined, undefined,
        async (url) => url, undefined, undefined, resolver);
      const internals = runner as unknown as { reconciler: { reconcile(input: unknown): {
        occurrences: Array<{ occurrence: RawListing }>; [key: string]: unknown;
      } } };
      const original = internals.reconciler;
      internals.reconciler = { reconcile(input) {
        const plan = original.reconcile(input);
        return { ...plan, occurrences: plan.occurrences.map((item) => ({ ...item,
          occurrence: { ...item.occurrence, postingIdentityDecision: undefined } })) };
      } };
      return runner.poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    };

    const failed = await poll();
    expect(failed.continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataProcessedRows?.map((item) => item.externalId))
      .not.toContain('new-role');
    expect(store.notificationEvents.size).toBe(0);

    expect((await poll()).continuationSources).toEqual([]);
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
    expect(store.notificationEvents.size).toBe(1);
  });
});
