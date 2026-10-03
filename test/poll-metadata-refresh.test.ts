import { describe, expect, it } from 'vitest';
import { SOURCE_METADATA_PROCESSING_REVISION } from '../src/ingestion/processor.js';
import { Poller } from '../src/poll.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const sourceId = 'metadata-refresh-fixture';
const rows = (count: number): RawListing[] => Array.from({ length: count }, (_, index) => ({
  sourceId, document: 'README.md', sourceUrl: 'https://github.com/example/jobs', row: index + 1,
  externalId: `role-${index}`, company: 'Acme', title: `Software Engineering Intern ${index}`,
  location: 'Remote', season: 'summer-2027', applyUrl: `https://jobs.example.com/${index}`,
  compensation: { raw: '' },
  state: 'open', fetchedAt: '2026-09-06T12:00:00.000Z',
}));

class FixtureAdapter implements SourceAdapter {
  constructor(readonly listings: RawListing[]) {}
  readonly id = sourceId;
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId, listings: this.listings, notModified: false, checkpoint: {
      sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1,
      lastSuccessAt: '2026-09-06T12:00:00.000Z', lastRowCount: this.listings.length,
    } };
  }
}

describe('bounded source metadata refresh', () => {
  it('processes at most 20 current rows per continuation and advances freshness only after completion', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new FixtureAdapter(rows(45));
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const poll = () => new Poller([adapter], store, () => new Date('2026-09-06T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, resolver).poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });

    expect((await poll()).failures).toEqual([]);
    const complete = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1,
      metadataProcessingRevision: SOURCE_METADATA_PROCESSING_REVISION - 1 });

    for (const expectedStamped of [20, 40]) {
      const report = await poll();
      const checkpoint = (await store.getCheckpoint(sourceId))!;
      expect(report.continuationSources).toEqual([sourceId]);
      expect((await store.getSourceOccurrences(sourceId)).filter((item) =>
        item.occurrence.sourceMetadataProcessing?.extractionVersion === ROLE_METADATA_EXTRACTION_VERSION)).toHaveLength(expectedStamped);
      expect(checkpoint.successfulFetches).toBe(complete.successfulFetches);
      expect(checkpoint.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION - 1);
      expect(checkpoint.pendingMetadataProcessedRows).toHaveLength(expectedStamped);
    }

    const final = await poll();
    const checkpoint = (await store.getCheckpoint(sourceId))!;
    expect(final.continuationSources).toEqual([]);
    expect(checkpoint.successfulFetches).toBe(complete.successfulFetches + 1);
    expect(checkpoint.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
    expect(checkpoint.metadataProcessingRevision).toBe(SOURCE_METADATA_PROCESSING_REVISION);
    expect(checkpoint.pendingMetadataProcessedRows).toBeUndefined();
  });

  it('retries a row whose occurrence stamp committed before the rest of persistence failed', async () => {
    class CommitThenFailStore extends MemoryInternshipStore {
      failAfterCommit = false;
      commits = 0;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        const result = await super.commitPostingObservation(input);
        this.commits += 1;
        if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('failed after occurrence commit'); }
        return result;
      }
    }
    const store = new CommitThenFailStore();
    const adapter = new FixtureAdapter(rows(1));
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const poll = () => new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    await poll();
    const complete = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 });
    store.failAfterCommit = true;

    const failed = await poll();
    expect(failed.continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataProcessedRows).toEqual([]);
    expect((await poll()).continuationSources).toEqual([]);
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
  });

  it('does not certify a stale parser checkpoint from a conditional 304', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId, successfulFetches: 7, lastSuccessAt: '2026-09-05T12:00:00.000Z',
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1,
      metadataProcessingRevision: SOURCE_METADATA_PROCESSING_REVISION - 1 });
    const adapter: SourceAdapter = { id: sourceId, async fetch(previous) { return {
      sourceId, outcome: 'unchanged', complete: true, postings: [], rawCount: previous?.lastRawCount ?? 0,
      contentHash: previous?.contentHash ?? '', listings: [], notModified: true, unchangedReason: 'not_modified',
      checkpoint: { ...previous!, sourceId, successfulFetches: 7 },
    }; } };
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    let shadowRuns = 0;
    const shadow = { isEnabledForSource: () => true, async discover() { shadowRuns += 1; } };

    const report = await new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver,
      true, false, undefined, shadow)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    expect(report.continuationSources).toEqual([sourceId]);
    expect(shadowRuns).toBe(0);
    expect(await store.getCheckpoint(sourceId)).toMatchObject({
      successfulFetches: 7,
      metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1,
      metadataProcessingRevision: SOURCE_METADATA_PROCESSING_REVISION - 1,
    });
  });

  it('invalidates changed material and stale-version progress while a refresh is pending', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new FixtureAdapter(rows(25));
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const poll = () => new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    await poll();
    const complete = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1,
      pendingMetadataProcessedRows: [{ externalId: 'role-24', sourceMaterialHash: 'wrong',
        extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, processingRevision: SOURCE_METADATA_PROCESSING_REVISION }] });
    await poll();
    adapter.listings[0] = { ...adapter.listings[0]!, title: 'Changed Data Engineering Intern' };
    expect((await poll()).continuationSources).toEqual([]);
    expect((await store.getSourceOccurrences(sourceId)).find((item) => item.externalId === 'role-0')?.occurrence.title)
      .toBe('Changed Data Engineering Intern');
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
  });

  it('persists negative-row progress without an occurrence and retries an evidence write after the main commit', async () => {
    class EvidenceFailStore extends MemoryInternshipStore {
      failEvidence = false;
      evidenceAttempts = 0;
      override async recordRoleMetadataEvidence(...args: Parameters<MemoryInternshipStore['recordRoleMetadataEvidence']>) {
        this.evidenceAttempts += 1;
        if (this.failEvidence) { this.failEvidence = false; throw new Error('evidence write failed'); }
        return super.recordRoleMetadataEvidence(...args);
      }
    }
    const store = new EvidenceFailStore();
    const evidence = { schemaVersion: 1 as const, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      artifactHash: 'artifact', sourceClass: 'reviewed-community' as const, sourceId,
      sourceUrl: 'https://github.com/example/jobs', observedAt: '2026-09-06T12:00:00.000Z', exactPosting: true as const };
    const adapter = new FixtureAdapter([{ ...rows(1)[0]!, metadataEvidence: [evidence] }]);
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const poll = () => new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    await poll();
    const complete = (await store.getCheckpoint(sourceId))!;
    adapter.listings.push({ ...rows(1)[0]!, externalId: 'malformed', applyUrl: 'not a url', row: 2 });
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 });
    store.failEvidence = true;
    const failed = await poll();
    expect(failed.continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataProcessedRows?.some((item) => item.externalId === 'malformed')).toBe(true);
    expect((await store.getSourceOccurrences(sourceId)).map((item) => item.externalId)).not.toContain('malformed');
    const attempts = store.evidenceAttempts;
    expect((await poll()).continuationSources).toEqual([]);
    expect(store.evidenceAttempts).toBeGreaterThan(attempts);
  });

  it('pages missing occurrences once and removes a reappeared row from omission progress', async () => {
    const store = new MemoryInternshipStore();
    const allRows = rows(30);
    const adapter = new FixtureAdapter([...allRows]);
    const resolver = { async configurationVersion() { return 'fixture-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const poll = () => new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver)
      .poll({ maxAdmissionMigrationListingsPerSourceRun: 20 });
    await poll();
    const complete = (await store.getCheckpoint(sourceId))!;
    adapter.listings.splice(0, adapter.listings.length, allRows[0]!);
    await store.putCheckpoint({ ...complete, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 });
    expect((await poll()).continuationSources).toEqual([sourceId]);
    expect((await poll()).continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataOmissions).toHaveLength(20);

    adapter.listings.push(allRows[5]!);
    expect((await poll()).continuationSources).toEqual([sourceId]);
    expect((await store.getSourceOccurrences(sourceId)).find((item) => item.externalId === 'role-5')).toMatchObject({ present: true });
    expect((await poll()).continuationSources).toEqual([]);
    expect([...store.jobs.values()].every((job) => job.open)).toBe(true);
    expect((await store.getCheckpoint(sourceId))!.pendingMetadataOmissions).toBeUndefined();
  });
});
