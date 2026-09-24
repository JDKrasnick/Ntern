import { describe, expect, it, vi } from 'vitest';
import { IngestionRunner } from '../src/poll.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import { MemoryInternshipStore } from '../src/store.js';
import { buildInternshipIdentity } from '../src/identity/enrichment.js';
import { extractPostingMetadataEvidence, ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import type { CatalogAdmission, Internship, ProcessedListing, SourceAdapter, SourceCheckpoint, SourceFetchResult, SourceOccurrenceState } from '../src/types.js';

const listing = (sourceId: string, overrides: Partial<ProcessedListing> = {}): ProcessedListing => ({
  sourceId,
  externalId: 'role-1',
  document: 'role-1',
  sourceUrl: `https://source.example.test/${sourceId}`,
  row: 1,
  company: 'Acme',
  title: 'Software Engineering Intern',
  location: 'Remote',
  season: 'summer-2027',
  applyUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  compensation: { raw: '' },
  requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false },
  state: 'open',
  fetchedAt: '2026-07-29T12:00:00.000Z',
  technical: true,
  ...overrides,
});

class MutableAdapter implements SourceAdapter {
  rows: ProcessedListing[];
  unchanged = false;
  constructor(readonly id: string, rows: ProcessedListing[]) { this.rows = rows; }
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return {
      sourceId: this.id,
      rawRowCount: 1,
      listings: this.rows,
      notModified: this.unchanged,
      checkpoint: {
        sourceId: this.id,
        contentHash: this.rows.length ? 'present' : 'omitted',
        successfulFetches: (previous?.successfulFetches ?? 0) + (this.unchanged ? 0 : 1),
        lastRowCount: this.rows.length,
        activeExternalIds: this.rows.map((row) => row.externalId!),
      },
    };
  }
}

function officialAdmission(employerId: string): CatalogAdmission {
  const evaluatedAt = '2026-07-29T12:00:00.000Z';
  return {
    canonicalEmployer: { id: employerId, displayName: employerId }, employerResolution: 'resolved',
    postingAttribution: 'attributed', destination: {
      classification: 'application-form', candidateUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/application',
      provider: 'ashby', tenant: 'acme', expectedPostingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', inspectedAt: evaluatedAt,
    },
    metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt, evidenceObservedAt: evaluatedAt,
  };
}

describe('snapshot reconciliation', () => {
  it.each(['parser', 'preprocessing'] as const)('fetches unchanged Markdown once after a %s upgrade, then restores conditional requests', async upgrade => {
    const store = new MemoryInternshipStore(); const requests: RequestInit[] = [];
    const adapter = new GitHubMarkdownAdapter({ id: 'markdown-fixture', owner: 'owner', repo: 'repo',
      documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async (_url, init) => {
        requests.push(init ?? {});
        if (new Headers(init?.headers).has('If-None-Match')) return new Response(null, { status: 304 });
        return new Response('| Company | Position | Location | Posting | Salary |\n| --- | --- | --- | --- | --- |\n'
          + '| Acme | Software Engineering Intern | Remote | [Apply](https://careers.example.test/acme) | $60/hr |',
        { headers: { ETag: '"unchanged"' } });
      },
    });
    const runner = () => new IngestionRunner([adapter], store, () => new Date('2026-07-29T12:00:00.000Z'));
    await runner().run();
    const checkpoint = (await store.getCheckpoint(adapter.id))!;
    const original = [...store.jobs.values()][0]!;
    const events = store.notificationEvents.size;
    const oldEvidence = original.sourceReferences[0]!.metadataEvidence!.map(item => ({ ...item,
      extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 }));
    await store.putInternship({ ...original, sourceReferences: [{ ...original.sourceReferences[0]!, metadataEvidence: oldEvidence }] });
    const occurrence = (await store.getSourceOccurrences(adapter.id))[0]!;
    await store.putSourceOccurrence({ ...occurrence, occurrence: { ...occurrence.occurrence, metadataEvidence: oldEvidence } });
    await store.putCheckpoint({ ...checkpoint, ...(upgrade === 'parser'
      ? { metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 }
      : { metadataProcessingRevision: 0 }) });
    const report = await runner().run();
    expect(report.failures).toEqual([]);
    expect(new Headers(requests[1]?.headers).has('If-None-Match')).toBe(false);
    expect((await store.getCheckpoint(adapter.id))?.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
    expect([...store.jobs.values()][0]?.jobId).toBe(original.jobId);
    expect([...store.jobs.values()][0]?.sourceReferences[0]?.metadataEvidence?.every(item => item.extractionVersion === ROLE_METADATA_EXTRACTION_VERSION)).toBe(true);
    expect([...store.jobs.values()][0]?.notification).toEqual(original.notification);
    expect(store.notificationEvents.size).toBe(events);
    await runner().run();
    expect(new Headers(requests[2]?.headers).get('If-None-Match')).toBe('"unchanged"');
  });

  it('does not mark the new parser applied when a source refresh fails', async () => {
    const store = new MemoryInternshipStore();
    const prior = { sourceId: 'source-a', successfulFetches: 1, etag: 'old', metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 };
    await store.putCheckpoint(prior);
    const fetchSource = vi.fn().mockRejectedValue(new Error('source unavailable'));
    await new IngestionRunner([{ id: 'source-a', fetch: fetchSource }], store).run();
    expect(await store.getCheckpoint('source-a')).toEqual(prior);
    expect(fetchSource.mock.calls[0]?.[0]).toMatchObject({ metadataExtractionVersion: prior.metadataExtractionVersion, etag: undefined });
  });

  it('takes the unchanged-occurrence fast path when only metadata observation timestamps change', async () => {
    const store = new MemoryInternshipStore();
    const admissionResolver = {
      async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; },
      async resolveDestinationRule() { return undefined; },
      async configurationVersion() { return 'admission-v1'; },
    };
    const metadata = (observedAt: string) => extractPostingMetadataEvidence({
      artifact: { title: 'Software Engineering Intern', compensationText: 'USD $40/hour' },
      sourceClass: 'official-ats', sourceId: 'source-a', sourceUrl: 'https://source.example.test/source-a', observedAt, exactPosting: true,
    });
    const adapter = new MutableAdapter('source-a', [listing('source-a', {
      metadataEvidence: metadata('2026-07-29T12:00:00.000Z'),
    })]);
    await new IngestionRunner(
      [adapter], store, () => new Date('2026-07-29T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, admissionResolver,
    ).run();
    const commits = vi.spyOn(store, 'commitPostingObservation');

    adapter.rows = [listing('source-a', {
      fetchedAt: '2026-07-30T12:00:00.000Z',
      metadataEvidence: metadata('2026-07-30T12:00:00.000Z'),
    })];
    await new IngestionRunner(
      [adapter], store, () => new Date('2026-07-30T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, admissionResolver,
    ).run();

    expect(commits).not.toHaveBeenCalled();
    expect([...store.jobs.values()][0]?.compensation).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 40 });
  });

  it('reprojects changed source metadata without creating a second new-role event', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 1 });
    const metadata = (pay: string, observedAt: string) => extractPostingMetadataEvidence({
      artifact: { title: 'Software Engineering Intern', compensationText: pay },
      sourceClass: 'official-ats', sourceId: 'source-a', sourceUrl: 'https://source.example.test/source-a', observedAt, exactPosting: true,
    });
    const adapter = new MutableAdapter('source-a', [listing('source-a', { metadataEvidence: metadata('USD $40/hour', '2026-07-29T12:00:00.000Z') })]);
    await new IngestionRunner([adapter], store, () => new Date('2026-07-29T12:00:00.000Z')).run();
    const original = [...store.jobs.values()][0]!;
    expect(original.compensation).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 40 });
    expect(store.notificationEvents.size).toBe(1);

    adapter.rows = [listing('source-a', { metadataEvidence: metadata('USD $45/hour', '2026-07-30T12:00:00.000Z') })];
    await new IngestionRunner([adapter], store, () => new Date('2026-07-30T12:00:00.000Z')).run();
    const updated = [...store.jobs.values()][0]!;
    expect(updated.compensation).toMatchObject({ minHourlyUSD: 45, maxHourlyUSD: 45 });
    expect(updated.jobId).toBe(original.jobId);
    expect(updated.firstSeenAt).toBe(original.firstSeenAt);
    expect(updated.notification).toEqual(original.notification);
    expect(store.notificationEvents.size).toBe(1);

    adapter.rows = [listing('source-a', { metadataEvidence: metadata('', '2026-07-31T12:00:00.000Z') })];
    await new IngestionRunner([adapter], store, () => new Date('2026-07-31T12:00:00.000Z')).run();
    const removed = [...store.jobs.values()][0]!;
    expect(removed.compensation).toEqual({ raw: '' });
    expect(removed.roleMetadata).toBeUndefined();
    expect(store.notificationEvents.size).toBe(1);
  });

  it('closes an occurrence after two complete omissions, including an unchanged confirmation', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    await new IngestionRunner([adapter], store).run();

    adapter.rows = [];
    await new IngestionRunner([adapter], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: true });
    expect((await store.getSourceOccurrences('source-a'))[0]).toMatchObject({ present: false, consecutiveOmissions: 1 });

    adapter.unchanged = true;
    await new IngestionRunner([adapter], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: false });
    expect((await store.getSourceOccurrences('source-a'))[0]).toMatchObject({ present: false, consecutiveOmissions: 2 });
  });

  it('keeps a catalog role open while another source occurrence remains open', async () => {
    const store = new MemoryInternshipStore();
    const first = new MutableAdapter('source-a', [listing('source-a')]);
    const second = new MutableAdapter('source-b', [listing('source-b')]);
    await new IngestionRunner([first, second], store).run();
    first.rows = [];
    await new IngestionRunner([first], store).run();
    first.unchanged = true;
    await new IngestionRunner([first], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: true });
    expect([...store.jobs.values()][0].sourceReferences).toEqual([
      expect.objectContaining({ sourceId: 'source-a', state: 'closed' }),
      expect.objectContaining({ sourceId: 'source-b', state: 'open' }),
    ]);
  });

  it('keeps a reviewed withdrawn posting closed while its list still publishes it', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new MutableAdapter('github-list', [listing('github-list', { provenance: 'reviewed-community' })]);
    await new IngestionRunner([adapter], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: true });

    // The employer page for this exact posting is gone; the list has not caught
    // up yet. The reviewed ledger, not the row, decides that it stays retired.
    store.withdrawnPostingKeys.add('ashby:acme:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await new IngestionRunner([adapter], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({
      open: false,
      notification: { smsPending: false, digestPending: false },
    });

    await new IngestionRunner([adapter], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: false });
  });

  it('closes an elapsed role when its last official occurrence closes', async () => {
    const store = new MemoryInternshipStore();
    const community = new MutableAdapter('github-list', [listing('github-list', { season: 'summer-2025', provenance: 'reviewed-community' })]);
    const officialListing = listing('greenhouse-acme', {
      provenance: 'official-ats',
      season: 'summer-2025',
      internshipIdentity: buildInternshipIdentity({
        sourceId: 'greenhouse-acme', sourceUrl: 'https://source.example.test/greenhouse-acme', observedAt: '2026-07-29T12:00:00.000Z',
        company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2025', seasonEvidenceStatus: 'explicit',
      }),
    });
    const official = new MutableAdapter('greenhouse-acme', [officialListing]);
    await new IngestionRunner([community, official], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ open: true });

    official.rows = [];
    await new IngestionRunner([official], store).run();
    await new IngestionRunner([official], store).run();

    expect([...store.jobs.values()][0]).toMatchObject({ open: false });
    expect([...store.jobs.values()][0]?.sourceReferences).toEqual([
      expect.objectContaining({ sourceId: 'github-list', state: 'open' }),
      expect.objectContaining({ sourceId: 'greenhouse-acme', state: 'closed' }),
    ]);
  });

  it('keeps source observation facts immutable and timestamps an exact later attachment', async () => {
    const store = new MemoryInternshipStore();
    const aggregator = new MutableAdapter('source-a', [listing('source-a')]);
    await new IngestionRunner([aggregator], store).run();
    const first = (await store.getSourceOccurrences('source-a'))[0]!;
    const firstReference = [...store.jobs.values()][0]!.sourceReferences[0]!;

    await new IngestionRunner([aggregator], store).run();
    const repeated = (await store.getSourceOccurrences('source-a'))[0]!;
    expect(repeated.firstObservedAt).toBe(first.firstObservedAt);
    expect(repeated.firstObservedAtPrecision).toBe('exact');
    expect(repeated.occurrence).toMatchObject({
      firstAttachedAt: first.firstObservedAt,
      firstAttachedAtPrecision: 'exact',
    });
    expect([...store.jobs.values()][0]!.sourceReferences[0]).toMatchObject({
      firstAttachedAt: firstReference.firstAttachedAt,
      firstAttachedAtPrecision: 'exact',
    });

    const provider = new MutableAdapter('source-b', [listing('source-b', {
      providerTimestamp: { value: '2026-07-01T00:00:00.000Z', semantics: 'updated' },
    })]);
    await new IngestionRunner([provider], store).run();
    const attached = [...store.jobs.values()][0]!.sourceReferences.find((reference) => reference.sourceId === 'source-b')!;
    const providerOccurrence = (await store.getSourceOccurrences('source-b'))[0]!;
    expect(attached).toMatchObject({
      firstAttachedAt: providerOccurrence.firstObservedAt, firstAttachedAtPrecision: 'exact',
      providerTimestamp: { value: '2026-07-01T00:00:00.000Z', semantics: 'updated' },
    });
    expect([...store.jobs.values()][0]).toMatchObject({
      firstSeenAt: first.firstObservedAt, catalogVisibleAt: first.firstObservedAt,
    });
    expect(providerOccurrence.firstObservedAt).not.toBe(attached.providerTimestamp?.value);
  });

  it('keeps a role catalogued while any open source occurrence classifies it as technical', async () => {
    const store = new MemoryInternshipStore();
    const technical = new MutableAdapter('source-technical', [listing('source-technical', { technical: true })]);
    const shelved = new MutableAdapter('source-shelved', [listing('source-shelved', { technical: false })]);

    await new IngestionRunner([technical], store).run();
    await new IngestionRunner([shelved], store).run();

    expect([...store.jobs.values()][0]).toMatchObject({ technical: true, open: true });
    expect((await store.listOpen()).jobs).toHaveLength(1);
    expect([...store.jobs.values()][0]?.sourceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'source-technical', technical: true }),
      expect.objectContaining({ sourceId: 'source-shelved', technical: false }),
    ]));
  });

  it('closes a Markdown occurrence the connector stops listing', async () => {
    const rows = [
      '| Acme | Software Engineering Intern | Remote | [Apply](https://careers.example.test/acme) |',
      '| Beta | Data Science Intern | NYC | [Apply](https://careers.example.test/beta) |',
    ];
    let body = () => `| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n${rows.join('\n')}`;
    const adapter = new GitHubMarkdownAdapter({
      id: 'markdown-fixture', owner: 'owner', repo: 'repo',
      documents: [{ path: 'README.md', branch: 'main', season: 'summer-2027' }],
      fetchImpl: async () => new Response(body()),
    });
    const store = new MemoryInternshipStore();
    await new IngestionRunner([adapter], store).run();
    const dropped = [...store.jobs.values()].find((job) => job.company === 'Beta')!;

    body = () => `| Company | Position | Location | Posting |\n| --- | --- | --- | --- |\n${rows[0]}`;
    await new IngestionRunner([adapter], store).run();
    expect((await store.getJob(dropped.jobId))?.open).toBe(true);

    await new IngestionRunner([adapter], store).run();
    expect((await store.getJob(dropped.jobId))?.open).toBe(false);
    expect((await store.getJob([...store.jobs.values()].find((job) => job.company === 'Acme')!.jobId))?.open).toBe(true);
  });

  it('merges one role listed twice in a snapshot into a single alert and role', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 2 });
    const adapter = new MutableAdapter('source-a', [
      listing('source-a', { externalId: 'README.md:role-1', document: 'README.md' }),
      listing('source-a', { externalId: 'INTERN_INTL.md:role-1', document: 'INTERN_INTL.md' }),
    ]);
    const report = await new IngestionRunner([adapter], store).run();

    expect(report.newJobs).toHaveLength(1);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
    expect([...store.jobs.values()][0]?.sourceReferences.map((reference) => reference.document))
      .toEqual(['INTERN_INTL.md', 'README.md']);
  });

  it('keeps the canonical alert tombstone when one duplicate occurrence commit fails', async () => {
    class FailingStore extends MemoryInternshipStore {
      fail = true;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        if (this.fail && !('sourceId' in input)) {
          this.fail = false;
          throw new Error('first duplicate commit failed');
        }
        return super.commitPostingObservation(input);
      }
    }
    const store = new FailingStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 0 });
    const adapter = new MutableAdapter('source-a', [
      listing('source-a', { externalId: 'README.md:role-1', document: 'README.md' }),
      listing('source-a', { externalId: 'INTERN_INTL.md:role-1', document: 'INTERN_INTL.md' }),
    ]);

    const failed = await new IngestionRunner([adapter], store).run();
    expect(failed.failures).toEqual(['first duplicate commit failed']);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
    expect(store.occurrences.size).toBe(1);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(0);

    const retried = await new IngestionRunner([adapter], store).run();
    expect(retried.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
    expect(store.occurrences.size).toBe(2);
  });

  it('updates the stored season when a source correction arrives', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    await new IngestionRunner([adapter], store).run();

    adapter.rows = [listing('source-a', { season: 'summer-2026' })];
    await new IngestionRunner([adapter], store).run();

    expect([...store.jobs.values()][0]).toMatchObject({ season: 'summer-2026' });
  });

  it('touches no catalog record for an unchanged snapshot that confirms the active occurrences', async () => {
    let operations = 0;
    class CountingStore extends MemoryInternshipStore {
      override async putInternship(job: Internship) { operations += 1; return super.putInternship(job); }
      override async putSourceOccurrence(value: SourceOccurrenceState) { operations += 1; return super.putSourceOccurrence(value); }
      override async getJob(jobId: string) { operations += 1; return super.getJob(jobId); }
      override async findByUrl(url: string) { operations += 1; return super.findByUrl(url); }
    }
    const store = new CountingStore();
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    await new IngestionRunner([adapter], store).run();

    operations = 0;
    adapter.unchanged = true;
    const report = await new IngestionRunner([adapter], store).run();

    expect(report.unchangedSources).toEqual(['source-a']);
    expect(operations).toBe(0);
    expect((await store.getSourceOccurrences('source-a'))[0]).toMatchObject({ present: true, consecutiveOmissions: 0 });
  });

  it('prefers cleaned official evidence over community display fields', async () => {
    const store = new MemoryInternshipStore();
    const community = new MutableAdapter('community-list', [listing('community-list', {
      provenance: 'reviewed-community', company: 'Community Acme', title: 'SWE Intern', location: 'Unspecified',
    })]);
    await new IngestionRunner([community], store).run();
    const official = new MutableAdapter('greenhouse-acme', [listing('greenhouse-acme', {
      provenance: 'official-ats', company: '🇺🇸 Acme', title: '🎓 Advanced Degree Required · Software Engineering Intern', location: 'NYC',
    })]);
    await new IngestionRunner([official], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({
      company: 'Acme', title: 'Software Engineering Intern', location: 'New York, NY',
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: true },
    });
    community.rows = [listing('community-list', { provenance: 'reviewed-community', company: 'Bad community value', title: 'Bad title', location: 'Unspecified' })];
    await new IngestionRunner([community], store).run();
    expect([...store.jobs.values()][0]).toMatchObject({ company: 'Acme', title: 'Software Engineering Intern', location: 'New York, NY' });
  });

  it('does not advance a checkpoint or duplicate an outbox event after a partial write failure', async () => {
    class FailingStore extends MemoryInternshipStore {
      fail = true;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        if (this.fail) { this.fail = false; throw new Error('occurrence write failed'); }
        return super.commitPostingObservation(input);
      }
    }
    const store = new FailingStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 0 });
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);
    const failed = await new IngestionRunner([adapter], store).run();
    expect(failed.failures).toEqual(['occurrence write failed']);
    expect(failed.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(0);
    expect(store.occurrences.size).toBe(0);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(0);

    const retried = await new IngestionRunner([adapter], store).run();
    expect(retried.newJobs).toHaveLength(1);
    expect(store.notificationEvents.size).toBe(1);
    expect((await store.getCheckpoint('source-a'))?.lastRowCount).toBe(1);

    // A later retry re-derives the same create; the recorded outbox event keeps it quiet.
    store.occurrences.clear();
    const replayed = await new IngestionRunner([adapter], store).run();
    expect(replayed.newJobs).toEqual([]);
    expect(store.notificationEvents.size).toBe(1);
  });

  it('does not report a new job when a concurrent official write makes the committed projection hidden', async () => {
    class RacingStore extends MemoryInternshipStore {
      injectedConflict = false;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        if (!this.injectedConflict && !('sourceId' in input) && input.notificationEvent) {
          this.injectedConflict = true;
          const reference = input.occurrence.occurrence;
          const officialA = {
            ...reference, sourceId: 'official-a', externalId: 'official-a', provenance: 'official-ats' as const,
            admission: officialAdmission('employer-a'),
          };
          const officialB = {
            ...reference, sourceId: 'official-b', externalId: 'official-b', provenance: 'official-structured' as const,
            admission: officialAdmission('employer-b'),
          };
          this.jobs.set(input.job.jobId, {
            ...input.job,
            sourceReferences: [officialA, officialB],
            admission: {
              ...officialAdmission('employer-a'), canonicalEmployer: undefined, employerResolution: 'conflict',
              catalogEligible: false, alertEligible: false, reasonCodes: ['employer-conflict'],
            },
            notification: { smsPending: false, digestPending: false },
          });
        }
        return super.commitPostingObservation(input);
      }
    }
    const store = new RacingStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 0 });

    const report = await new IngestionRunner([
      new MutableAdapter('source-a', [listing('source-a')]),
    ], store).run();

    expect(report.newJobs).toEqual([]);
    expect(store.notificationEvents.size).toBe(0);
    expect([...store.jobs.values()][0]).toMatchObject({
      admission: { employerResolution: 'conflict', catalogEligible: false, alertEligible: false },
      notification: { smsPending: false, digestPending: false },
    });
  });

  it('retries an atomic job and outbox write without exposing pending delivery state first', async () => {
    class FailingStore extends MemoryInternshipStore {
      fail = true;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        if (this.fail) {
          this.fail = false;
          throw new Error('outbox transaction failed');
        }
        return super.commitPostingObservation(input);
      }
    }
    const store = new FailingStore();
    await store.putCheckpoint({ sourceId: 'source-a', successfulFetches: 1, lastRowCount: 0 });
    const adapter = new MutableAdapter('source-a', [listing('source-a')]);

    const failed = await new IngestionRunner([adapter], store).run();
    expect(failed.failures).toEqual(['outbox transaction failed']);
    expect(failed.newJobs).toEqual([]);
    expect(store.jobs.size).toBe(0);
    expect(store.notificationEvents.size).toBe(0);
    expect(await store.pendingDigest()).toEqual([]);

    const retried = await new IngestionRunner([adapter], store).run();
    expect(retried.newJobs).toHaveLength(1);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(1);
  });
});
