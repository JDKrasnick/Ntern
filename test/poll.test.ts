import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryInternshipStore } from '../src/store.js';
import { Poller } from '../src/poll.js';
import { buildPostingIdentity } from '../src/identity/posting.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult, SourceSnapshot, SourcedPosting } from '../src/types.js';

const listing = (url: string, sourceId = 'one'): RawListing => ({ sourceId, document: 'README.md', sourceUrl: 'https://github.com/x', row: 5, company: 'Acme', title: 'Software Engineering Intern', location: 'NYC', season: 'summer-2027', applyUrl: url, compensation: { raw: '$40/hr', maxHourlyUSD: 40 }, state: 'open', fetchedAt: '2026-01-01T00:00:00Z' });
const greenhouseListing = (postingId: string, url: string): RawListing => ({
  ...listing(url, 'greenhouse-figma'), externalId: postingId, document: postingId,
  providerEvidence: { provider: 'greenhouse', tenant: 'figma', postingId, sourceId: 'greenhouse-figma', urls: [url] },
});
const reviewedListing = (input: { provider: 'greenhouse' | 'lever'; tenant: string; postingId: string; sourceId: string; url: string }): RawListing => ({
  ...listing(input.url, input.sourceId), externalId: input.postingId, document: input.postingId,
  providerEvidence: { provider: input.provider, tenant: input.tenant, postingId: input.postingId, sourceId: input.sourceId, urls: [input.url] },
});
class Adapter implements SourceAdapter {
  fetches = 0;
  constructor(readonly id: string, private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> { this.fetches += 1; return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } }; }
}
/** One row of a full-snapshot board, sized so a delivery slice is observable. */
const snapshotRow = (ordinal: number, sourceId = 'github-example'): SourcedPosting => ({
  sourceId, provenance: 'official-ats', externalId: `role-${ordinal}`, document: 'README.md', row: ordinal + 1,
  sourceUrl: 'https://github.com/example/jobs', fetchedAt: '2026-09-10T00:00:00Z',
  employer: { id: 'example', name: 'Example', authority: 'reviewed-registry' },
  title: `Software Engineering Intern ${ordinal}`,
  content: [{ kind: 'description', format: 'plain', value: 'Build production software with the platform team.' }],
  locations: ['Remote'], applyUrl: `https://jobs.example.com/role-${ordinal}`,
  sourceState: 'open', lifecycleAuthority: 'title',
});
const snapshotRows = (count: number, sourceId = 'github-example') => Array.from({ length: count }, (_, index) => snapshotRow(index, sourceId));
const snapshotHash = (rows: SourcedPosting[]) => createHash('sha256').update(rows.map((row) => row.externalId).join('|')).digest('hex');
class SnapshotAdapter implements SourceAdapter {
  fetches = 0;
  readonly received: Array<SourceCheckpoint | undefined> = [];
  constructor(readonly id: string, private rows: SourcedPosting[]) {}
  setRows(rows: SourcedPosting[]) { this.rows = rows; }
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult & SourceSnapshot> {
    this.fetches += 1;
    this.received.push(previous);
    const contentHash = snapshotHash(this.rows);
    const unchanged = previous?.contentHash === contentHash;
    return {
      sourceId: this.id, outcome: unchanged ? 'unchanged' : 'changed', complete: true,
      rawCount: this.rows.length, rawRowCount: this.rows.length, contentHash, postings: this.rows, listings: [], notModified: unchanged,
      ...(unchanged ? { unchangedReason: 'content_hash' as const } : {}),
      checkpoint: {
        sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + (unchanged ? 0 : 1),
        etag: 'board-etag', documentEtags: { 'README.md': 'document-etag' },
        lastRowCount: this.rows.length, contentHash, activeExternalIds: this.rows.map((row) => row.externalId),
      },
    };
  }
}
describe('polling', () => {
  it('persists successful not-modified checkpoints for source-health visibility', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'unchanged', successfulFetches: 1, lastRowCount: 3 });
    const adapter: SourceAdapter = {
      id: 'unchanged',
      async fetch(previous) {
        return {
          sourceId: 'unchanged',
          listings: [],
          notModified: true,
          checkpoint: { ...previous!, sourceId: 'unchanged', successfulFetches: 1, lastSuccessAt: '2026-07-29T12:00:00.000Z' },
        };
      },
    };
    const report = await new Poller([adapter], store).poll();
    expect(report.unchangedSources).toEqual(['unchanged']);
    expect(await store.getCheckpoint('unchanged')).toMatchObject({ lastSuccessAt: '2026-07-29T12:00:00.000Z' });
  });
  it('quietly seeds a source, then alerts a new canonical listing', async () => {
    const store = new MemoryInternshipStore();
    expect((await new Poller([new Adapter('one', [listing('https://jobs.example.com/a')])], store).poll()).newJobs).toHaveLength(0);
    const second = await new Poller([new Adapter('one', [listing('https://jobs.example.com/a'), { ...listing('https://jobs.example.com/b'), title: 'Backend Software Engineering Intern' }])], store).poll();
    expect(second.newJobs).toHaveLength(1); expect(await store.pendingSms()).toHaveLength(1);
    expect([...store.jobs.values()].find((job) => job.title === 'Software Engineering Intern')).toMatchObject({ catalogRecency: 'baseline' });
    expect([...store.jobs.values()].find((job) => job.title === 'Backend Software Engineering Intern')).toMatchObject({ catalogRecency: 'normal' });
  });
  it('durably queues one natural shadow verification for a new exact provider posting', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'greenhouse-acme';
    const posting = (postingId: string, title: string, description = 'Build production software with the platform team.') => ({
      sourceId, provenance: 'official-ats' as const, externalId: postingId,
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', fetchedAt: '2026-09-09T22:00:00Z',
      employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' as const }, title,
      content: [{ kind: 'description' as const, format: 'html' as const, value: `<p>${description}</p>` }],
      locations: ['New York, NY'], applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${postingId}`,
      sourceState: 'open' as const, lifecycleAuthority: 'title' as const,
      providerIdentity: { provider: 'greenhouse' as const, tenant: 'acme' },
      providerEvidence: { provider: 'greenhouse' as const, tenant: 'acme', postingId, sourceId,
        urls: [`https://job-boards.greenhouse.io/acme/jobs/${postingId}`] },
    });
    let rows = [posting('100', 'Software Engineering Intern')];
    let hash = 'baseline';
    const adapter: SourceAdapter = { id: sourceId, async fetch(previous): Promise<SourceFetchResult & SourceSnapshot> {
      return { sourceId, outcome: previous?.contentHash === hash ? 'unchanged' : 'changed', complete: true,
        rawCount: rows.length, contentHash: hash, checkpoint: { sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1,
          contentHash: hash, activeExternalIds: rows.map((row) => row.externalId) }, postings: rows,
        listings: [], notModified: previous?.contentHash === hash };
    } };
    const resolver = { async configurationVersion() { return 'configuration-v1'; },
      async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; }, async resolveDestinationRule() { return undefined; } };
    const queued: Array<{ externalId: string; reason: string; shadowOrigin?: string; shadowContentHash?: string; idempotencyKey?: string }> = [];
    const run = (naturalProviderPoll = true) => new Poller([adapter], store, () => new Date('2026-09-09T22:00:00Z'),
      undefined, undefined, undefined, async (request) => { queued.push(request); }, resolver).poll({ naturalProviderPoll });
    await run();
    expect(queued).toEqual([]);
    rows = [...rows, posting('101', 'Platform Engineering Intern')]; hash = 'new-role';
    await run();
    expect(queued).toEqual([expect.objectContaining({ externalId: '101', reason: 'first-sight',
      shadowOrigin: 'provider-poll', shadowContentHash: expect.stringMatching(/^[a-f0-9]{64}$/u), idempotencyKey: expect.any(String) })]);
    expect(await store.listPendingProviderShadowVerifications()).toEqual([]);
    await run();
    expect(queued).toHaveLength(1);
    rows = rows.map((row) => row.externalId === '101'
      ? posting('101', 'Platform Engineering Intern', 'Build production software and distributed systems with the platform team.') : row);
    hash = 'description-change';
    await run();
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({ externalId: '101', reason: 'content-change', shadowOrigin: 'provider-poll' });
    expect(queued[1]?.idempotencyKey).not.toBe(queued[0]?.idempotencyKey);
    rows = [...rows, posting('102', 'Security Engineering Intern')]; hash = 'forced-role';
    await run(false);
    expect(queued).toHaveLength(2);
  });

  it('queues evaluation-only shadow work when an official posting is blocked only by an unresolved employer', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'greenhouse-unmapped';
    const posting = (postingId: string) => ({
      sourceId, provenance: 'official-ats' as const, externalId: postingId,
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/unmapped/jobs', fetchedAt: '2026-09-09T22:00:00Z',
      employer: { id: 'unmapped', name: 'Unmapped', authority: 'reviewed-registry' as const },
      title: 'Software Engineering Intern', content: [{ kind: 'description' as const, format: 'plain' as const,
        value: 'Build production software.' }], locations: ['Remote'],
      applyUrl: `https://job-boards.greenhouse.io/unmapped/jobs/${postingId}`, sourceState: 'open' as const,
      lifecycleAuthority: 'title' as const, providerIdentity: { provider: 'greenhouse' as const, tenant: 'unmapped' },
      providerEvidence: { provider: 'greenhouse' as const, tenant: 'unmapped', postingId, sourceId,
        urls: [`https://job-boards.greenhouse.io/unmapped/jobs/${postingId}`] },
    });
    let ids = ['100'];
    const adapter: SourceAdapter = { id: sourceId, async fetch(previous): Promise<SourceFetchResult & SourceSnapshot> {
      const contentHash = ids.join(':');
      return { sourceId, outcome: previous?.contentHash === contentHash ? 'unchanged' : 'changed', complete: true,
        rawCount: ids.length, contentHash, checkpoint: { sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1,
          contentHash, activeExternalIds: ids }, postings: ids.map(posting), listings: [],
        notModified: previous?.contentHash === contentHash };
    } };
    const resolver = { async configurationVersion() { return 'configuration-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    const queued: Array<{ externalId: string; shadowOrigin?: string }> = [];
    const run = () => new Poller([adapter], store, undefined, undefined, undefined, undefined,
      async (request) => { queued.push(request); }, resolver).poll({ naturalProviderPoll: true });

    await run();
    ids = ['100', '101'];
    await run();

    expect(queued).toEqual([expect.objectContaining({ externalId: '101', shadowOrigin: 'provider-poll' })]);
    expect([...store.jobs.values()].find((job) => job.sourceReferences.some((reference) => reference.externalId === '101')))
      .toMatchObject({ admission: { catalogEligible: false, alertEligible: false, reasonCodes: ['employer-unresolved'] } });
    expect(await store.pendingSms()).toEqual([]);
  });

  it('defers a failed provider shadow queue handoff without failing the source poll', async () => {
    const store = new MemoryInternshipStore(); const sourceId = 'greenhouse-acme';
    const makeSnapshot = (ids: string[], hash: string): SourceFetchResult & SourceSnapshot => ({ sourceId, outcome: 'changed', complete: true,
      rawCount: ids.length, contentHash: hash, checkpoint: { sourceId, successfulFetches: 1, contentHash: hash, activeExternalIds: ids }, listings: [], notModified: false,
      postings: ids.map((postingId) => ({ sourceId, provenance: 'official-ats', externalId: postingId,
        sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', fetchedAt: '2026-09-09T22:00:00Z',
        employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' }, title: 'Software Engineering Intern',
        content: [{ kind: 'description', format: 'plain', value: 'Build production software.' }], locations: ['Remote'],
        applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${postingId}`, sourceState: 'open', lifecycleAuthority: 'title',
        providerIdentity: { provider: 'greenhouse', tenant: 'acme' }, providerEvidence: { provider: 'greenhouse', tenant: 'acme',
          postingId, sourceId, urls: [`https://job-boards.greenhouse.io/acme/jobs/${postingId}`] } })),
    });
    let snapshot = makeSnapshot(['100'], 'baseline');
    const adapter: SourceAdapter = { id: sourceId, async fetch() { return snapshot; } };
    const resolver = { async configurationVersion() { return 'configuration-v1'; },
      async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; }, async resolveDestinationRule() { return undefined; } };
    let fail = false; const delivered: string[] = [];
    const run = () => new Poller([adapter], store, undefined, undefined, undefined, undefined, async (request) => {
      if (fail) throw new Error('queue unavailable'); delivered.push(request.externalId);
    }, resolver).poll({ naturalProviderPoll: true });
    await run(); snapshot = makeSnapshot(['100', '101'], 'new-role'); fail = true;
    expect((await run()).failures).toEqual([]);
    expect(await store.listPendingProviderShadowVerifications()).toEqual([expect.objectContaining({ externalId: '101', shadowOrigin: 'provider-poll' })]);
    fail = false; await run();
    expect(delivered).toEqual(['101']);
    expect(await store.listPendingProviderShadowVerifications()).toEqual([]);
  });
  it.each([
    { provider: 'lever' as const, sourceId: 'lever-acme', firstId: '11111111-1111-4111-8111-111111111111',
      nextId: '22222222-2222-4222-8222-222222222222', sourceUrl: 'https://api.lever.co/v0/postings/acme?mode=json',
      applyUrl: (id: string) => `https://jobs.lever.co/acme/${id}` },
    { provider: 'ashby' as const, sourceId: 'ashby-acme', firstId: '33333333-3333-4333-8333-333333333333',
      nextId: '44444444-4444-4444-8444-444444444444', sourceUrl: 'https://api.ashbyhq.com/posting-api/job-board/acme',
      applyUrl: (id: string) => `https://jobs.ashbyhq.com/acme/${id}` },
  ])('uses the natural shadow path for $provider postings', async ({ provider, sourceId, firstId, nextId, sourceUrl, applyUrl }) => {
    const store = new MemoryInternshipStore(); let ids = [firstId]; let contentHash = 'baseline';
    const adapter: SourceAdapter = { id: sourceId, async fetch(previous): Promise<SourceFetchResult & SourceSnapshot> {
      const postings = ids.map((postingId) => ({ sourceId, provenance: 'official-ats' as const, externalId: postingId,
        sourceUrl, fetchedAt: '2026-09-09T22:00:00Z', employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' as const },
        title: 'Software Engineering Intern', content: [{ kind: 'description' as const, format: 'plain' as const,
          value: 'Build production software.' }], locations: ['Remote'], applyUrl: applyUrl(postingId),
        sourceState: 'open' as const, lifecycleAuthority: 'title' as const, providerIdentity: { provider, tenant: 'acme' },
        ...(provider === 'lever' ? { providerEvidence: { provider, tenant: 'acme', postingId, sourceId, urls: [applyUrl(postingId)] } } : {}) }));
      return { sourceId, outcome: previous?.contentHash === contentHash ? 'unchanged' : 'changed', complete: true,
        rawCount: postings.length, contentHash, checkpoint: { sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1,
          contentHash, activeExternalIds: ids }, postings, listings: [], notModified: previous?.contentHash === contentHash };
    } };
    const queued: Array<{ externalId: string; shadowOrigin?: string }> = [];
    const resolver = { async configurationVersion() { return 'configuration-v1'; },
      async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; }, async resolveDestinationRule() { return undefined; } };
    const run = () => new Poller([adapter], store, undefined, undefined, undefined, undefined,
      async (request) => { queued.push(request); }, resolver).poll({ naturalProviderPoll: true });
    await run(); ids = [firstId, nextId]; contentHash = 'new-role'; await run();
    expect(queued).toEqual([expect.objectContaining({ externalId: nextId, shadowOrigin: 'provider-poll' })]);
  });
  it('reuses unchanged source rows when another row changes the snapshot', async () => {
    const store = new MemoryInternshipStore();
    const firstSeen = '2026-08-09T12:00:00.000Z';
    const changedAt = '2026-08-10T12:00:00.000Z';
    const resolver = {
      async configurationVersion() { return 'configuration-v1'; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    await new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/a')])],
      store,
      () => new Date(firstSeen),
      undefined, undefined, undefined, undefined, resolver,
    ).poll();
    await new Poller(
      [new Adapter('one', [
        { ...listing('https://jobs.example.com/a'), row: 50 },
        { ...listing('https://jobs.example.com/b'), title: 'Systems Engineering Intern' },
      ])],
      store,
      () => new Date(changedAt),
      undefined, undefined, undefined, undefined, resolver,
    ).poll();
    const unchanged = [...store.jobs.values()].find((job) => job.title === 'Software Engineering Intern');
    expect(unchanged).toMatchObject({ lastSeenAt: firstSeen, sourceReferences: [{ row: 5 }] });
    expect(await store.getCheckpoint('one')).toMatchObject({ activeExternalIds: expect.arrayContaining([
      'README.md:https://jobs.example.com/a', 'README.md:https://jobs.example.com/b',
    ]) });

    const updatedAt = '2026-08-11T12:00:00.000Z';
    await new Poller(
      [new Adapter('one', [
        { ...listing('https://jobs.example.com/a'), title: 'Platform Engineering Intern' },
        { ...listing('https://jobs.example.com/b'), title: 'Systems Engineering Intern' },
      ])],
      store,
      () => new Date(updatedAt),
      undefined, undefined, undefined, undefined, resolver,
    ).poll();
    expect([...store.jobs.values()].find((job) => job.applyUrl === 'https://jobs.example.com/a'))
      .toMatchObject({ lastSeenAt: updatedAt });
    expect((await store.getSourceOccurrences('one')).find((occurrence) => occurrence.externalId.endsWith('/a')))
      .toMatchObject({ occurrence: { title: 'Platform Engineering Intern' } });
  });
  it('resumes an interrupted admission configuration migration from per-row progress', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const run = (observedAt: string, row = 5) => new Poller(
      [new Adapter('one', [{ ...listing('https://jobs.example.com/a'), row }])],
      store,
      () => new Date(observedAt),
      undefined, undefined, undefined, undefined, resolver,
    ).poll();

    await run('2026-08-09T12:00:00.000Z');
    configurationVersion = 'configuration-v2';
    const migratedAt = '2026-08-10T12:00:00.000Z';
    await run(migratedAt);
    expect((await store.getSourceOccurrences('one'))[0]).toMatchObject({
      occurrence: { admissionConfigurationVersion: 'configuration-v2' },
    });

    const migratedCheckpoint = await store.getCheckpoint('one');
    await store.putCheckpoint({ ...migratedCheckpoint!, admissionConfigurationVersion: 'configuration-v1' });
    await run('2026-08-11T12:00:00.000Z', 99);
    expect([...store.jobs.values()][0]).toMatchObject({ lastSeenAt: migratedAt });
    expect((await store.getSourceOccurrences('one'))[0]).toMatchObject({ occurrence: { row: 5 } });
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
  });
  it('finishes a large admission migration through bounded successful continuations', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const rows = Array.from({ length: 5 }, (_, index) => ({
      ...listing(`https://jobs.example.com/migration-${index}`),
      row: index + 1,
      title: `Software Engineering Intern ${index}`,
    }));
    const run = (observedAt: string) => new Poller(
      [new Adapter('one', rows)],
      store,
      () => new Date(observedAt),
      undefined, undefined, undefined, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 2 });

    await run('2026-08-09T12:00:00.000Z');
    configurationVersion = 'configuration-v2';

    const first = await run('2026-08-10T12:00:00.000Z');
    expect(first.continuationSources).toEqual(['one']);
    expect((await store.getSourceOccurrences('one')).filter((value) =>
      value.occurrence.admissionConfigurationVersion === 'configuration-v2')).toHaveLength(2);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v1' });

    const second = await run('2026-08-10T12:01:00.000Z');
    expect(second.continuationSources).toEqual(['one']);
    expect((await store.getSourceOccurrences('one')).filter((value) =>
      value.occurrence.admissionConfigurationVersion === 'configuration-v2')).toHaveLength(4);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v1' });

    const final = await run('2026-08-10T12:02:00.000Z');
    expect(final.continuationSources).toEqual([]);
    expect((await store.getSourceOccurrences('one')).filter((value) =>
      value.occurrence.admissionConfigurationVersion === 'configuration-v2')).toHaveLength(5);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect([...store.jobs.values()]).toHaveLength(5);
    expect([...store.jobs.values()].every((job) => job.open)).toBe(true);
  });
  it('fetches and persists every new role before a migration checkpoint can produce a 304', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    let fetches = 0;
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const rows = Array.from({ length: 6 }, (_, index) => ({
      ...listing(`https://jobs.example.com/migration-new-${index}`),
      row: index + 1,
      title: `Software Engineering Intern ${index}`,
    }));
    const adapter: SourceAdapter = {
      id: 'one',
      async fetch(previous) {
        fetches += 1;
        const notModified = previous?.admissionConfigurationVersion === 'configuration-v2'
          && previous.etag === 'roles-etag';
        return {
          sourceId: 'one',
          listings: notModified ? [] : fetches === 1 ? rows.slice(0, 1) : rows,
          notModified,
          checkpoint: {
            ...previous,
            sourceId: 'one',
            etag: 'roles-etag',
            successfulFetches: (previous?.successfulFetches ?? 0) + (notModified ? 0 : 1),
            lastRowCount: rows.length,
          },
        };
      },
    };
    const run = () => new Poller(
      [adapter], store, () => new Date('2026-08-10T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 2 });

    await run();
    configurationVersion = 'configuration-v2';

    const first = await run();
    expect(first.continuationSources).toEqual(['one']);
    expect([...store.jobs.values()]).toHaveLength(2);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v1' });

    const final = await run();
    expect(final.unchangedSources).toEqual([]);
    expect(final.continuationSources).toEqual([]);
    expect([...store.jobs.values()]).toHaveLength(6);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });

    const unchanged = await run();
    expect(unchanged.unchangedSources).toEqual(['one']);
    expect([...store.jobs.values()]).toHaveLength(6);
  });
  it('defers inactive occurrence loading until the next ordinary poll', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    let rows = [
      listing('https://jobs.example.com/active-1'),
      listing('https://jobs.example.com/active-2'),
      listing('https://jobs.example.com/inactive'),
    ];
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const run = () => new Poller(
      [new Adapter('one', rows)],
      store,
      () => new Date('2026-08-10T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 1 });

    await run();
    const inactive = (await store.getSourceOccurrences('one')).find((occurrence) =>
      occurrence.occurrence.applyUrl === 'https://jobs.example.com/inactive')!;
    rows = rows.slice(0, 2);
    configurationVersion = 'configuration-v2';
    const getJob = vi.spyOn(store, 'getJob');

    const first = await run();

    expect(first.continuationSources).toEqual(['one']);
    expect(getJob).not.toHaveBeenCalledWith(inactive.jobId);
    expect((await store.getSourceOccurrences('one')).find((occurrence) => occurrence.jobId === inactive.jobId))
      .toMatchObject({ present: true, consecutiveOmissions: 0 });

    const final = await run();
    expect(final.continuationSources).toEqual([]);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect((await store.getSourceOccurrences('one')).find((occurrence) => occurrence.jobId === inactive.jobId))
      .toMatchObject({ present: true, consecutiveOmissions: 0 });

    await run();
    expect((await store.getSourceOccurrences('one')).find((occurrence) => occurrence.jobId === inactive.jobId))
      .toMatchObject({ present: false, consecutiveOmissions: 1 });
  });
  it('preserves and stamps a failed legacy row so it cannot poison migration continuations', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const run = (row: RawListing) => new Poller(
      [new Adapter('one', [row])],
      store,
      () => new Date('2026-08-10T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 1 });

    await run(listing('https://jobs.example.com/original'));
    const originalJob = [...store.jobs.values()][0]!;
    configurationVersion = 'configuration-v2';
    const migrated = await run({ ...listing('not-a-url'), externalId: 'README.md:https://jobs.example.com/original' });

    expect(migrated.failures).toEqual([expect.stringContaining('Invalid URL')]);
    expect(migrated.continuationSources).toEqual([]);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect((await store.getSourceOccurrences('one'))[0]).toMatchObject({
      occurrence: { applyUrl: 'https://jobs.example.com/original', admissionConfigurationVersion: 'configuration-v2' },
    });
    expect(await store.getJob(originalJob.jobId)).toEqual(originalJob);
  });
  it('fails a new unpersistable row closed without poisoning migration continuations', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const run = (rows: RawListing[]) => new Poller(
      [new Adapter('one', rows)],
      store,
      () => new Date('2026-08-10T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 2 });
    const original = listing('https://jobs.example.com/original');

    await run([original]);
    configurationVersion = 'configuration-v2';
    const migrated = await run([
      original,
      { ...listing('not-a-url'), externalId: 'README.md:new-invalid-row' },
    ]);

    expect(migrated.failures).toEqual([expect.stringContaining('Invalid URL')]);
    expect(migrated.continuationSources).toEqual([]);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect(await store.getSourceOccurrences('one')).toHaveLength(1);
    expect([...store.jobs.values()]).toHaveLength(1);
  });
  it('does not reopen a stamped migration row when stored enrichment differs from its source', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const row = listing('https://jobs.example.com/original');
    const run = () => new Poller(
      [new Adapter('one', [row])],
      store,
      () => new Date('2026-08-10T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 1 });

    await run();
    configurationVersion = 'configuration-v2';
    await run();
    const occurrence = (await store.getSourceOccurrences('one'))[0]!;
    await store.putSourceOccurrence({
      ...occurrence,
      occurrence: { ...occurrence.occurrence, season: 'fall' },
    });
    const checkpoint = await store.getCheckpoint('one');
    await store.putCheckpoint({ ...checkpoint!, admissionConfigurationVersion: 'configuration-v1' });

    const resumed = await run();

    expect(resumed.continuationSources).toEqual([]);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect((await store.getSourceOccurrences('one'))[0]).toMatchObject({
      occurrence: { season: 'fall', admissionConfigurationVersion: 'configuration-v2' },
    });
  });
  it('finishes the full-role pass when untracked failures outnumber the migration slice', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const original = listing('https://jobs.example.com/original');
    const run = (rows: RawListing[]) => new Poller(
      [new Adapter('one', rows)],
      store,
      () => new Date('2026-08-10T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 1 });

    await run([original]);
    configurationVersion = 'configuration-v2';
    await run([original]);
    const checkpoint = await store.getCheckpoint('one');
    await store.putCheckpoint({ ...checkpoint!, admissionConfigurationVersion: 'configuration-v1' });
    const invalidRows = Array.from({ length: 3 }, (_, index) => ({
      ...listing(`not-a-url-${index}`),
      externalId: `README.md:new-invalid-row-${index}`,
    }));

    const resumed = await run([original, ...invalidRows]);

    expect(resumed.failures).toHaveLength(3);
    expect(resumed.failures.every((failure) => failure.includes('Invalid URL'))).toBe(true);
    expect(resumed.continuationSources).toEqual([]);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
  });
  it('preserves a legacy decision when classified persistence fails during migration', async () => {
    class FailingMigrationStore extends MemoryInternshipStore {
      failMigrationPersistence = false;
      override async commitPostingObservation(input: Parameters<MemoryInternshipStore['commitPostingObservation']>[0]) {
        if (this.failMigrationPersistence && !('sourceId' in input)) throw new Error('simulated classified write conflict');
        return super.commitPostingObservation(input);
      }
    }
    const store = new FailingMigrationStore();
    let configurationVersion = 'configuration-v1';
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const run = () => new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/original')])],
      store,
      () => new Date('2026-08-10T12:00:00.000Z'),
      undefined, undefined, undefined, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 1 });

    await run();
    const originalJob = [...store.jobs.values()][0]!;
    configurationVersion = 'configuration-v2';
    store.failMigrationPersistence = true;
    const migrated = await run();

    expect(migrated.failures).toEqual([expect.stringContaining('preserved prior decision')]);
    expect(migrated.continuationSources).toEqual([]);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect((await store.getSourceOccurrences('one'))[0]).toMatchObject({
      occurrence: { admissionConfigurationVersion: 'configuration-v2' },
    });
    expect(await store.getJob(originalJob.jobId)).toEqual(originalJob);
  });
  it('preserves a legacy decision when migration page inspection fails', async () => {
    const store = new MemoryInternshipStore();
    let configurationVersion = 'configuration-v1';
    let failInspection = false;
    const resolver = {
      async configurationVersion() { return configurationVersion; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    const run = () => new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/original')])],
      store,
      () => new Date('2026-08-10T12:00:00.000Z'),
      undefined,
      async () => {
        if (failInspection) throw new Error('Application page exceeds the inspection size limit');
        return 'Acme';
      },
      false, undefined, resolver,
    ).poll({ maxAdmissionMigrationListingsPerSourceRun: 1 });

    await run();
    const seededJob = [...store.jobs.values()][0]!;
    delete seededJob.applicationUrlValidatedAt;
    await store.putInternship(seededJob);
    const originalJob = structuredClone(seededJob);
    configurationVersion = 'configuration-v2';
    failInspection = true;
    const migrated = await run();

    expect(migrated.failures).toEqual([expect.stringContaining('inspection size limit')]);
    expect(migrated.continuationSources).toEqual([]);
    expect(await store.getCheckpoint('one')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect((await store.getSourceOccurrences('one'))[0]).toMatchObject({
      occurrence: { admissionConfigurationVersion: 'configuration-v2' },
    });
    expect(await store.getJob(originalJob.jobId)).toEqual(originalJob);
  });
  it('keeps a large quiet baseline behind a later normal role and out of new-since results', async () => {
    const store = new MemoryInternshipStore();
    const baseline = Array.from({ length: 60 }, (_, index) => ({
      ...listing(`https://jobs.example.com/baseline-${index}`), title: `Software Engineering Intern ${index}`,
    }));
    await new Poller([new Adapter('one', baseline)], store, () => new Date('2026-08-09T12:00:00.000Z')).poll();
    const fresh = { ...listing('https://jobs.example.com/fresh'), title: 'Platform Software Engineering Intern' };
    const report = await new Poller([new Adapter('one', [...baseline, fresh])], store, () => new Date('2026-08-10T12:00:00.000Z')).poll();
    expect(report.newJobs).toMatchObject([{ title: 'Platform Software Engineering Intern', catalogRecency: 'normal' }]);
    expect((await store.listOpen!(undefined, 25)).jobs[0]).toMatchObject({ title: 'Platform Software Engineering Intern' });
    expect(await store.listOpenSince('2026-08-08T00:00:00.000Z', '2026-08-11T00:00:00.000Z')).toMatchObject([{ title: 'Platform Software Engineering Intern' }]);
    expect(store.notificationEvents.size).toBe(1);
  });
  it('keeps identity-unconfirmed same-URL occurrences source-local', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'community', successfulFetches: 1, lastRowCount: 0 });
    await new Poller([new Adapter('community', [listing('https://jobs.example.com/shared', 'community')])], store, () => new Date('2026-08-08T12:00:00.000Z')).poll();
    await new Poller([new Adapter('ashby-provider', [listing('https://jobs.example.com/shared?utm_source=ashby', 'ashby-provider')])], store, () => new Date('2026-08-09T12:00:00.000Z')).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ firstSeenAt: '2026-08-08T12:00:00.000Z', catalogRecency: 'normal', postingIdentityStatus: 'unconfirmed' }),
      expect.objectContaining({ firstSeenAt: '2026-08-09T12:00:00.000Z', postingIdentityStatus: 'unconfirmed' }),
    ]));
  });
  it('does not merge cross-source occurrences from normalized URL syntax alone', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing('https://jobs.example.com/a')])], store).poll();
    await new Poller([new Adapter('two', [listing('https://jobs.example.com/a?utm_source=two', 'two')])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].every((job) => job.postingIdentityStatus === 'unconfirmed')).toBe(true);
  });
  it('does not let an unverified community occurrence revive a closed canonical posting', async () => {
    const store = new MemoryInternshipStore();
    const url = 'https://copart.wd12.myworkdayjobs.com/Copart/job/Dallas-TX/Software-Engineering-Intern_JR101510';
    const variant = 'https://copart.wd12.myworkdayjobs.com/en-US/Copart/job/Dallas-TX/Software-Engineering-Intern_JR101510';
    await new Poller([new Adapter('one', [{ ...listing(url), state: 'closed' as const }])], store).poll();
    await new Poller([new Adapter('community', [listing(variant, 'community')])], store).poll();
    expect([...store.jobs.values()][0]).toMatchObject({
      open: false,
      sourceReferences: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'one' }),
        expect.objectContaining({ sourceId: 'community', state: 'open' }),
      ]),
    });
  });
  it('adopts a legacy tracked URL when canonical tracking cleanup changes its lookup key', async () => {
    const store = new MemoryInternshipStore();
    const tracked = 'https://jobs.example.com/a?gh_src=legacy&utm_source=list';
    const reference = listing(tracked);
    await store.putInternship({
      jobId: 'legacy-tracked', company: reference.company, title: reference.title, location: reference.location,
      season: reference.season, applyUrl: tracked, normalizedUrl: 'https://jobs.example.com/a?gh_src=legacy',
      fingerprint: 'legacy-tracked', compensation: reference.compensation, sourceReferences: [reference], open: true,
      firstSeenAt: reference.fetchedAt, lastSeenAt: reference.fetchedAt, notification: { smsPending: false, digestPending: false },
    });
    await new Poller([new Adapter('one', [listing(tracked)])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]?.jobId).toBe('legacy-tracked');
  });
  it('keeps evidence-poor roles separate when their apply URLs differ', async () => {
    const store = new MemoryInternshipStore(); await new Poller([new Adapter('one', [listing('https://jobs.example.com/a')])], store).poll();
    await new Poller([new Adapter('two', [listing('https://careers.example.net/a', 'two')])], store).poll();
    expect(store.jobs.size).toBe(2);
  });
  it('keeps distinct provider requisitions even when every display field matches', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('greenhouse-figma', [greenhouseListing('100', 'https://job-boards.greenhouse.io/figma/jobs/100')])], store).poll();
    await new Poller([new Adapter('greenhouse-figma', [greenhouseListing('101', 'https://job-boards.greenhouse.io/figma/jobs/101')])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.providerPostingId).sort()).toEqual(['100', '101']);
  });
  it('never bridges distinct confirmed IDs through a reused ordinary application URL', async () => {
    const store = new MemoryInternshipStore();
    const shared = 'https://careers.example.test/apply';
    await new Poller([new Adapter('greenhouse-acme', [reviewedListing({
      provider: 'greenhouse', tenant: 'acme', postingId: '100', sourceId: 'greenhouse-acme', url: shared,
    })])], store).poll();
    await new Poller([new Adapter('greenhouse-acme', [reviewedListing({
      provider: 'greenhouse', tenant: 'acme', postingId: '101', sourceId: 'greenhouse-acme', url: shared,
    })])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.providerPostingId).sort()).toEqual(['100', '101']);
    expect([...store.jobs.values()].every((job) => job.sourceReferences.length === 1)).toBe(true);
  });
  it('converges reviewed URL variants on one provider posting identity', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('greenhouse-figma', [greenhouseListing('100', 'https://boards.greenhouse.io/figma?gh_jid=100')])], store).poll();
    await new Poller([new Adapter('community', [listing('https://job-boards.greenhouse.io/figma/jobs/100', 'community')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      postingIdentity: { provider: 'greenhouse', tenant: 'figma', providerPostingId: '100' },
      sourceReferences: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'greenhouse-figma' }),
        expect.objectContaining({ sourceId: 'community' }),
      ]),
    });
  });
  it.each([
    ['official first', true],
    ['community first', false],
  ])('converges a tenant-less Greenhouse embed when the %s occurrence arrives', async (_label, officialFirst) => {
    const store = new MemoryInternshipStore();
    const postingId = '6883068002';
    const official = reviewedListing({
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks',
      url: `https://job-boards.greenhouse.io/databricks/jobs/${postingId}`,
    });
    const community = listing(`https://boards.greenhouse.io/embed/job_app?token=${postingId}`, 'community');
    const polls = officialFirst
      ? [new Adapter('greenhouse-databricks', [official]), new Adapter('community', [community])]
      : [new Adapter('community', [community]), new Adapter('greenhouse-databricks', [official])];
    for (const adapter of polls) await new Poller([adapter], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      postingIdentity: { provider: 'greenhouse', tenant: 'databricks', providerPostingId: postingId },
    });
    expect(new Set([...store.jobs.values()][0]!.sourceReferences.map(({ sourceId }) => sourceId)))
      .toEqual(new Set(['greenhouse-databricks', 'community']));
  });
  it('converges a community-first tenant-less embed against the current provider snapshot', async () => {
    const store = new MemoryInternshipStore();
    const postingId = '6883068002';
    const official = new Adapter('greenhouse-databricks', [reviewedListing({
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks',
      url: `https://job-boards.greenhouse.io/databricks/jobs/${postingId}`,
    })]);
    await new Poller([
      new Adapter('community', [listing(`https://boards.greenhouse.io/embed/job_app?token=${postingId}`, 'community')]),
      official,
    ], store).poll();
    expect(official.fetches).toBe(1);
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      postingIdentity: { provider: 'greenhouse', tenant: 'databricks', providerPostingId: postingId },
      sourceReferences: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'community' }),
        expect.objectContaining({ sourceId: 'greenhouse-databricks' }),
      ]),
    });
  });
  it('does not scope a tenant-less Greenhouse embed when two active reviewed boards contain its ID', async () => {
    const store = new MemoryInternshipStore();
    const postingId = '6883068002';
    await store.putCheckpoint({ sourceId: 'greenhouse-databricks', successfulFetches: 1, activeExternalIds: [postingId] });
    await store.putCheckpoint({ sourceId: 'greenhouse-figma', successfulFetches: 1, activeExternalIds: [postingId] });
    await new Poller([new Adapter('community', [listing(`https://boards.greenhouse.io/embed/job_app?token=${postingId}`, 'community')])], store).poll();
    await new Poller([new Adapter('greenhouse-databricks', [reviewedListing({
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks',
      url: `https://job-boards.greenhouse.io/databricks/jobs/${postingId}`,
    })])], store).poll();
    expect(store.jobs.size).toBe(2);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.provider).sort()).toEqual(['greenhouse', undefined]);
    expect([...store.jobs.values()].find((job) => !job.postingIdentity)).toMatchObject({ postingIdentityStatus: 'unconfirmed' });
  });
  it('keeps a fresh tenant-less embed separate when two current reviewed snapshots share its ID', async () => {
    const store = new MemoryInternshipStore();
    const postingId = '6883068002';
    const embedUrl = `https://boards.greenhouse.io/embed/job_app?token=${postingId}`;
    const databricks = new Adapter('greenhouse-databricks', [reviewedListing({
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks',
      url: `https://job-boards.greenhouse.io/databricks/jobs/${postingId}`,
    })]);
    const figma = new Adapter('greenhouse-figma', [reviewedListing({
      provider: 'greenhouse', tenant: 'figma', postingId, sourceId: 'greenhouse-figma',
      url: `https://job-boards.greenhouse.io/figma/jobs/${postingId}`,
    })]);
    await new Poller([
      new Adapter('community', [listing(embedUrl, 'community')]),
      databricks,
      figma,
    ], store).poll();
    expect([databricks.fetches, figma.fetches]).toEqual([1, 1]);
    expect(store.jobs.size).toBe(3);
    expect([...store.jobs.values()].map((job) => job.postingIdentity?.tenant ?? 'unscoped').sort())
      .toEqual(['databricks', 'figma', 'unscoped']);
    expect([...store.jobs.values()].map((job) => job.sourceReferences.map(({ sourceId }) => sourceId)))
      .toEqual([['community'], ['greenhouse-databricks'], ['greenhouse-figma']]);
  });
  it('converges historical DRW custom and standard routes only after the active public ID confirms them', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('greenhouse-drweng', [reviewedListing({ provider: 'greenhouse', tenant: 'drweng', postingId: '3413670', sourceId: 'greenhouse-drweng', url: 'https://job-boards.greenhouse.io/drweng/jobs/3413670' })])], store).poll();
    await new Poller([new Adapter('community', [listing('https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670?utm_source=community', 'community')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      postingIdentity: { tenant: 'drweng', providerPostingId: '3413670' },
      sourceReferences: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'greenhouse-drweng' }),
        expect.objectContaining({ sourceId: 'community' }),
      ]),
    });
  });
  it('converges the historical PlusAI Lever hosted/apply pair', async () => {
    const store = new MemoryInternshipStore(); const id = 'b4f750e7-0148-41f0-b2b1-ff054450a320';
    await new Poller([new Adapter('lever-plusai', [reviewedListing({ provider: 'lever', tenant: 'plus-2', postingId: id, sourceId: 'lever-plusai', url: `https://jobs.lever.co/plus-2/${id}/apply` })])], store).poll();
    await new Poller([new Adapter('community', [listing(`https://jobs.lever.co/plus-2/${id}?ref=community`, 'community')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]?.postingIdentity).toMatchObject({ provider: 'lever', tenant: 'plus-2', providerPostingId: id });
  });
  it('does not infer a provider identity for an inactive custom-host public ID', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'greenhouse-drweng', successfulFetches: 1, activeExternalIds: ['3413670'] });
    await new Poller([new Adapter('community', [listing('https://www.drw.com/work-at-drw/listings/software-developer-intern-9999999', 'community')])], store).poll();
    expect([...store.jobs.values()][0]).toMatchObject({ postingIdentityStatus: 'unconfirmed' });
    expect([...store.jobs.values()][0]?.postingIdentity).toBeUndefined();
  });
  it('uses a reviewed custom-host ID for identity without treating a generic destination as alert eligible', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'greenhouse-drweng', successfulFetches: 1, activeExternalIds: ['3413670'], lastRowCount: 1 });
    const generic = reviewedListing({
      provider: 'greenhouse',
      tenant: 'drweng',
      postingId: '3413670',
      sourceId: 'greenhouse-drweng',
      url: 'https://www.drw.com/open-roles?gh_jid=3413670',
    });
    const inspected: string[] = [];
    const report = await new Poller(
      [new Adapter('greenhouse-drweng', [generic])],
      store,
      undefined,
      undefined,
      async (url) => {
        inspected.push(url);
        return {
          url,
          evidence: {
            url,
            title: 'Open roles',
            confidence: { score: 50, level: 'medium', recommendation: 'catalog-only', signals: ['destination reached'] },
          },
        };
      },
    ).poll();
    expect(inspected).not.toHaveLength(0);
    expect(new Set(inspected)).toEqual(new Set([generic.applyUrl]));
    expect(report.newJobs).toEqual([]);
    expect(report.filteredJobs).toHaveLength(1);
    expect([...store.jobs.values()][0]).toMatchObject({
      company: 'Acme',
      postingIdentity: { provider: 'greenhouse', tenant: 'drweng', providerPostingId: '3413670' },
      notification: { smsPending: false, digestPending: false },
    });
  });
  it('quarantines direct provider evidence whose reviewed route points at another board', async () => {
    const store = new MemoryInternshipStore();
    const mismatched = reviewedListing({ provider: 'greenhouse', tenant: 'figma', postingId: '123', sourceId: 'greenhouse-figma', url: 'https://job-boards.greenhouse.io/spacex/jobs/123' });
    const report = await new Poller([new Adapter('greenhouse-figma', [mismatched])], store).poll();
    expect(store.jobs.size).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.quarantinedListings).toEqual([expect.objectContaining({
      sourceId: 'greenhouse-figma',
      row: 5,
      reason: expect.stringContaining('provider-scope-mismatch'),
    })]);
    expect(await store.getCheckpoint('greenhouse-figma')).toMatchObject({ successfulFetches: 1 });
  });
  it('persists TikTok source aliases as their canonical job URL', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing('https://lifeattiktok.com/position/7623166667125508357')])], store).poll();
    const job = [...store.jobs.values()][0];
    expect(job.applyUrl).toBe('https://lifeattiktok.com/search/7623166667125508357');
    expect(job.sourceReferences[0].applyUrl).toBe(job.applyUrl);
  });
  it.each([
    [
      'Workday',
      'https://micron.wd1.myworkdayjobs.com/External/job/Boise/Intern_JR108448',
      'https://micron.wd5.myworkdayjobs.com/en-US/External/job/Intern_JR108448',
    ],
    [
      'ByteDance',
      'https://lifeattiktok.com/search/7672883129493948677',
      'https://jobs.bytedance.com/en/position/7672883129493948677/detail',
    ],
  ])('converges exact %s provider routes during ingestion', async (_provider, first, second) => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter('one', [listing(first)])], store).poll();
    await new Poller([new Adapter('two', [listing(second, 'two')])], store).poll();
    expect(store.jobs.size).toBe(1);
    expect([...store.jobs.values()][0]?.sourceReferences.map((reference) => reference.sourceId)).toEqual(['one', 'two']);
  });
  it('retains a checkpoint when an established adapter suddenly returns zero rows', async () => {
    const store = new MemoryInternshipStore(); const initial = new Adapter('one', [listing('https://jobs.example.com/a')]); await new Poller([initial], store).poll();
    const report = await new Poller([new Adapter('one', [])], store).poll();
    expect(report.failures[0]).toContain('suspicious zero-row'); expect((await store.getCheckpoint('one'))?.lastRowCount).toBe(1);
  });
  it('stores closed technical roles without queuing alerts', async () => {
    const store = new MemoryInternshipStore();
    const closed = { ...listing('https://jobs.example.com/closed'), state: 'closed' as const };
    await new Poller([new Adapter('one', [closed])], store).poll();
    expect((await store.listOpen?.(undefined, 25, 'closed'))?.jobs).toMatchObject([{ open: false }]);
    expect(await store.pendingSms()).toEqual([]);
  });
  it('does not store or alert a role whose application link fails validation', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 1 });
    const report = await new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/b')])],
      store,
      undefined,
      undefined,
      async () => { throw new Error('Application link returned HTTP 404'); },
    ).poll();
    // The failing row is still reported; a delivery whose links are mostly dead
    // also carries the source-level share failure alongside it.
    expect(report.failures).toContainEqual(expect.stringContaining('row 5: Application link returned HTTP 404'));
    expect(store.jobs.size).toBe(0);
    expect(report.newJobs).toEqual([]);
  });
  it('keeps a generic career shell in the catalog without alerting', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 1 });
    const report = await new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/generic')])],
      store,
      undefined,
      undefined,
      async () => ({
        url: 'https://jobs.example.com/generic',
        evidence: { url: 'https://jobs.example.com/generic', title: 'Candidate Experience page', confidence: { score: 75, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: ['destination reached'] } },
      }),
    ).poll();
    expect(report.newJobs).toEqual([]);
    expect(report.filteredJobs).toHaveLength(1);
    expect([...store.jobs.values()][0]).toMatchObject({ notification: { smsPending: false, digestPending: false } });
  });
  const legacyOpenRole = async (store: MemoryInternshipStore) => {
    const role = listing('https://jobs.example.com/b');
    await store.putInternship({
      jobId: 'legacy-role', company: role.company, title: role.title, location: role.location,
      season: role.season, applyUrl: role.applyUrl, normalizedUrl: role.applyUrl, fingerprint: 'legacy-role',
      compensation: role.compensation, sourceReferences: [role], open: true, firstSeenAt: role.fetchedAt,
      lastSeenAt: role.fetchedAt, notification: { smsPending: true, digestPending: true },
    });
    return role;
  };

  it('quarantines a legacy open role when its source has not changed but its link is gone', async () => {
    const store = new MemoryInternshipStore();
    const role = await legacyOpenRole(store);
    const report = await new Poller(
      [new Adapter('one', [])], store, undefined, undefined,
      async () => { throw new Error('Application link returned HTTP 410'); },
    ).poll();
    expect((await store.getJob('legacy-role'))).toMatchObject({ open: false, invalidApplicationUrl: role.applyUrl, notification: { smsPending: false, digestPending: false } });
    expect(report.failures).toContain('catalog: legacy-role: Application link returned HTTP 410');
  });

  it('leaves a legacy open role alone when the employer only refuses to be read', async () => {
    const store = new MemoryInternshipStore();
    await legacyOpenRole(store);
    // Tesla and Citadel answer automated clients with 403. That proves nothing
    // about the posting, so hiding the role would lose a real job.
    const report = await new Poller(
      [new Adapter('one', [])], store, undefined, undefined,
      async () => { throw new Error('Application link returned HTTP 403'); },
    ).poll();
    const preserved = await store.getJob('legacy-role');
    expect(preserved?.open).toBe(true);
    expect(preserved?.invalidApplicationUrl).toBeUndefined();
    expect(report.failures).toContain('catalog: legacy-role: Application link returned HTTP 403');
  });

  it('withdraws a row whose application page could not be reached instead of failing the delivery', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 0 });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    const report = await new Poller(
      [new Adapter('one', [
        listing('https://jobs.example.com/reachable'),
        listing('https://jobs.example.com/ok-2'), listing('https://jobs.example.com/ok-3'),
        listing('https://jobs.example.com/ok-4'), listing('https://jobs.example.com/ok-5'),
        listing('https://jobs.example.com/unreachable'),
      ])],
      store, undefined, undefined,
      async (url) => {
        if (url.includes('unreachable')) throw new Error('Application page could not be reached');
        return { url, evidence: { url, confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['source policy'] } } };
      },
      false,
    ).poll();
    spy.mockRestore();
    // A page that could not be reached withdraws its row; it is not evidence that
    // the source failed, which is what kept healthy lists quarantined.
    expect(report.failures.some((failure) => failure.includes('could not be reached'))).toBe(false);
    expect(logs.some((line) => line.includes('row_probe_withdrawn') && line.includes('could not be reached'))).toBe(true);
    const references = [...store.jobs.values()].flatMap((job) => job.sourceReferences.map((reference) => reference.applyUrl));
    expect(references).toContain('https://jobs.example.com/reachable');
    expect(references).not.toContain('https://jobs.example.com/unreachable');
  });

  it('replays the Simplify timeout rows without losing completed rows or retrying the whole slice', async () => {
    const store = new MemoryInternshipStore();
    const failedUrls = [
      'https://job-boards.greenhouse.io/compeerfinancial/jobs/5404850008',
      'https://job-boards.greenhouse.io/compeerfinancial/jobs/5405050008',
      'https://job-boards.greenhouse.io/compeerfinancial/jobs/5405015008',
      'https://job-boards.greenhouse.io/compeerfinancial/jobs/5404994008',
      'https://job-boards.greenhouse.io/sage49/jobs/6131191004',
      'https://careers.medpace.com/jobs/12962',
      'https://eofe.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/81251',
      'https://eofe.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/81252',
      'https://lifeattiktok.com/search/7670839727059339525',
      'https://lifeattiktok.com/search/7670700387322300677',
      'https://jobs.bytedance.com/en/position/7668489218234157365/detail',
      'https://lifeattiktok.com/search/7668921505254410549',
      'https://jobs.bytedance.com/en/position/7667378931599214853/detail',
    ];
    const rows = [...failedUrls, ...Array.from({ length: 12 }, (_, index) => `https://jobs.example.com/other-${index}`)]
      .map((url, index) => ({ ...listing(url, 'github-example'), row: index + 1, title: `Software Engineering Intern ${index}` }));
    let unavailable = true;
    const validated: string[] = [];
    const poll = () => new Poller([new Adapter('github-example', rows)], store, undefined, undefined,
      async (url) => {
        validated.push(url);
        if (unavailable && failedUrls.includes(url)) throw new Error('Application link timed out');
        return { url, evidence: { url, confidence: { score: 100, level: 'high' as const,
          recommendation: 'alert-eligible' as const, signals: ['source policy'] } } };
      }, false).poll({ maxListingsPerSourceRun: 25 });

    const first = await poll();
    expect(first.failures).toEqual([]);
    expect(first.continuationSources).toEqual([]);
    expect(first.pendingResolution['github-example']).toBe(failedUrls.length);
    expect((await store.getCheckpoint('github-example'))?.pendingResolutionRows).toHaveLength(failedUrls.length);
    expect(validated).toHaveLength(25);

    unavailable = false;
    validated.length = 0;
    const second = await poll();
    expect(second.failures).toEqual([]);
    expect(validated).toEqual(expect.arrayContaining(failedUrls));
    expect(validated).toHaveLength(failedUrls.length);
    expect((await store.getCheckpoint('github-example'))?.pendingResolutionRows).toBeUndefined();
    expect([...store.jobs.values()].flatMap((job) => job.sourceReferences.map((reference) => reference.applyUrl)))
      .toEqual(expect.arrayContaining(failedUrls));
  });

  it('keeps queue send timeouts out of the application link failure share', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'community-list';
    const url = 'https://job-boards.greenhouse.io/axon/jobs/7978840003';
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId, outcome: 'changed', complete: true, rawCount: 1, contentHash: 'queue-timeout',
      listings: [], notModified: false, checkpoint: { sourceId, successfulFetches: 1 },
      postings: [{ sourceId, provenance: 'reviewed-community', externalId: 'row-1',
        sourceUrl: 'https://github.com/example/jobs', fetchedAt: '2026-08-28T00:00:00Z',
        employer: { name: 'Axon', authority: 'source-row' }, title: '2027 Engineering Internship',
        content: [], locations: ['Arizona, USA'], applyUrl: url, sourceState: 'open', lifecycleAuthority: 'source' }],
    };
    const resolver = {
      async resolveCanonicalEmployer() { return { id: 'axon', displayName: 'Axon' }; },
      async resolveDestinationRule() { return undefined; },
    };
    const report = await new Poller([{ id: sourceId, async fetch() { return snapshot; } }],
      store, undefined, undefined, undefined, undefined,
      async () => { throw new Error('Queue send timed out'); }, resolver)
      .poll({ maxListingsPerSourceRun: 25 });
    expect(report.failures).toContain('community-list: row 1: Queue send timed out');
    expect(report.failures.some((failure) => failure.includes('rows could not be verified'))).toBe(false);
    expect((await store.getCheckpoint(sourceId))?.pendingResolutionRows).toBeUndefined();
  });

  it('still fails the delivery when a row fails for a non-probe reason and when the probe share is exceeded', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 0 });
    const report = await new Poller(
      [new Adapter('one', [listing('https://jobs.example.com/one')])], store, undefined, undefined,
      async () => { throw new Error('admission evaluation threw'); },
      false,
    ).poll();
    // A failure that is not a page probe still fails the delivery.
    expect(report.failures.some((failure) => failure.includes('admission evaluation threw'))).toBe(true);

    const broken = new MemoryInternshipStore();
    await broken.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 0 });
    const mostlyBroken = await new Poller(
      [new Adapter('one', [
        listing('https://jobs.example.com/1'), listing('https://jobs.example.com/2'),
        listing('https://jobs.example.com/3'), listing('https://jobs.example.com/4'),
      ])], broken, undefined, undefined,
      async (url) => { throw new Error(`Application link is dead: ${url}`); },
      false,
    ).poll();
    // When most rows cannot be verified, the list itself is the failure.
    expect(mostlyBroken.failures.some((failure) => failure.includes('rows could not be verified'))).toBe(true);
  });

  it('lets per-source workers validate incoming listings without applying their host policy to the catalog', async () => {
    const store = new MemoryInternshipStore();
    await legacyOpenRole(store);
    await store.putCheckpoint({ sourceId: 'one', successfulFetches: 1, lastRowCount: 0 });
    const validated: string[] = [];
    const incoming = listing('https://jobs.example.com/incoming');
    const report = await new Poller(
      [new Adapter('one', [incoming])], store, undefined, undefined,
      async (url) => {
        validated.push(url);
        return { url, evidence: { url, confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['source policy'] } } };
      },
      false,
    ).poll();
    expect(report.failures).toEqual([]);
    expect(validated).toEqual([incoming.applyUrl]);
    expect((await store.getJob('legacy-role'))?.open).toBe(true);
  });

  it('applies reviewed employer mappings and destination rules during neutral ingestion', async () => {
    const store = new MemoryInternshipStore();
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId: 'greenhouse-board-label', outcome: 'changed', complete: true, rawCount: 1, contentHash: 'hash',
      listings: [], notModified: false,
      checkpoint: { sourceId: 'greenhouse-board-label', successfulFetches: 1 },
      postings: [{
        sourceId: 'greenhouse-board-label', provenance: 'official-ats', externalId: '123', sourceUrl: 'https://boards-api.greenhouse.io/board-label',
        fetchedAt: '2026-08-27T12:00:00Z', employer: { id: 'board-label', name: 'Talent Community', authority: 'reviewed-registry' },
        providerIdentity: { provider: 'greenhouse', tenant: 'board-label' }, title: 'Software Engineering Intern',
        content: [], locations: ['Remote'], applyUrl: 'https://careers.example.test/roles/123', sourceState: 'open',
      }],
    };
    const adapter: SourceAdapter = { id: snapshot.sourceId, async fetch() { return snapshot; } };
    const resolver = {
      async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; },
      async resolveDestinationRule() { return { id: 'reviewed-custom-route', host: 'careers.example.test', provider: 'greenhouse' as const,
        tenant: 'board-label', decision: 'standard-provider-route' as const, reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer' }; },
    };
    await new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver).poll();
    expect([...store.jobs.values()][0]).toMatchObject({ company: 'Acme', admission: {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, catalogEligible: true,
    } });
  });

  it('preserves legacy community rows while withholding new unmapped employers', async () => {
    const store = new MemoryInternshipStore();
    const legacy = await legacyOpenRole(store);
    const legacyJob = (await store.getJob('legacy-role'))!;
    const priorUrl = 'https://ancestry.wd501.myworkdayjobs.com/Careers/job/Remote/Software-Engineer---Observability--Co-op_R003434';
    const refreshedUrl = 'https://ancestry.wd501.myworkdayjobs.com/en-US/careers/job/Draper-Utah/Software-Engineer---Observability--Co-op_R003434';
    await store.putInternship({ ...legacyJob, applyUrl: priorUrl, normalizedUrl: priorUrl,
      sourceReferences: [{ ...legacyJob.sourceReferences[0]!, sourceId: 'community-list', externalId: 'acme-role', applyUrl: priorUrl }] });
    await store.claimPostingIdentity(buildPostingIdentity({ applicationUrl: priorUrl }), 'legacy-role');
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId: 'community-list', outcome: 'changed', complete: true, rawCount: 2, contentHash: 'community-hash',
      listings: [], notModified: false,
      checkpoint: { sourceId: 'community-list', successfulFetches: 2 },
      postings: [
        { sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'acme-role', sourceUrl: 'https://github.com/example/jobs',
          fetchedAt: '2026-08-27T12:00:00Z', employer: { name: 'Acme', authority: 'source-row' }, title: legacy.title,
          content: [], locations: [legacy.location], applyUrl: refreshedUrl, sourceState: 'open', lifecycleAuthority: 'source' },
        { sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'beta-role', sourceUrl: 'https://github.com/example/jobs',
          fetchedAt: '2026-08-27T12:00:00Z', employer: { name: 'Beta', authority: 'source-row' }, title: 'Data Engineering Intern',
          content: [], locations: ['Remote'], applyUrl: 'https://jobs.example.com/beta', sourceState: 'open', lifecycleAuthority: 'source' },
      ],
    };
    const resolver = {
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule() { return undefined; },
    };
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store, undefined, undefined, undefined, undefined, undefined, resolver).poll();
    const preserved = await store.getJob('legacy-role');
    expect(preserved?.open).toBe(true);
    expect(preserved?.admission).toBeUndefined();
    expect(preserved?.sourceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'community-list', applyUrl: refreshedUrl }),
    ]));
    expect([...store.jobs.values()].find((job) => job.company === 'Beta')).toMatchObject({
      admission: { catalogEligible: false, alertEligible: false, reasonCodes: expect.arrayContaining(['employer-unresolved']) },
    });
  });

  it('queues an attributed-provider check when a reviewed community URL is specific but the posting is not yet corroborated', async () => {
    const store = new MemoryInternshipStore();
    const queued: Array<{ candidateUrl: string; providerIdentity: { provider: string; postingId?: string }; reason: string }> = [];
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId: 'community-list', outcome: 'changed', complete: true, rawCount: 1, contentHash: 'community-axon',
      listings: [], notModified: false, checkpoint: { sourceId: 'community-list', successfulFetches: 1 },
      postings: [{ sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1',
        sourceUrl: 'https://github.com/example/jobs', fetchedAt: '2026-08-28T00:00:00Z',
        employer: { name: 'Axon', authority: 'source-row' }, title: '2027 US Mechanical Engineering Internship',
        content: [], locations: ['Arizona, USA'], applyUrl: 'https://job-boards.greenhouse.io/axon/jobs/7978840003',
        sourceState: 'open', lifecycleAuthority: 'source' }],
    };
    const reviewed: { decision?: 'aggregate-board' } = {};
    const resolver = {
      async resolveCanonicalEmployer() { return { id: 'axon', displayName: 'Axon' }; },
      async resolveDestinationRule() {
        return reviewed.decision ? { id: 'axon-route', host: 'job-boards.greenhouse.io', provider: 'greenhouse' as const,
          tenant: 'axon', decision: reviewed.decision, reviewedAt: '2026-08-28T00:00:00Z', reviewedBy: 'reviewer' } : undefined;
      },
    };
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store,
      undefined, undefined, undefined, undefined, async (request) => { queued.push(request); }, resolver).poll();
    expect([...store.jobs.values()][0]).toMatchObject({ admission: { catalogEligible: false,
      reasonCodes: ['posting-unattributed'], destination: { classification: 'posting-detail' } } });
    expect(queued).toMatchObject([{ candidateUrl: 'https://job-boards.greenhouse.io/axon/jobs/7978840003',
      providerIdentity: { provider: 'greenhouse', postingId: '7978840003' }, reason: 'first-sight' }]);

    const first = [...store.jobs.values()][0]!;
    const verified = {
      ...first.sourceReferences[0]!.admission!, postingAttribution: 'attributed' as const,
      destination: { ...first.sourceReferences[0]!.admission!.destination, browserVisible: true,
        inspectedAt: '2026-08-28T00:05:00Z' }, catalogEligible: true, alertEligible: true, reasonCodes: [],
    };
    await store.putInternship({ ...first, admission: verified,
      sourceReferences: [{ ...first.sourceReferences[0]!, admission: verified }] });
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store,
      undefined, undefined, undefined, undefined, async (request) => { queued.push(request); }, resolver).poll();
    expect(queued).toHaveLength(1);
    expect([...store.jobs.values()][0]).toMatchObject({ admission: { destination: { browserVisible: true } },
      sourceReferences: [{ admission: { destination: { browserVisible: true } } }] });

    const attributed = [...store.jobs.values()][0]!;
    const unattributed = { ...attributed.admission!, postingAttribution: 'unattributed' as const };
    await store.putInternship({ ...attributed, admission: unattributed,
      sourceReferences: [{ ...attributed.sourceReferences[0]!, admission: unattributed }] });
    reviewed.decision = 'aggregate-board';
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store,
      undefined, undefined, undefined, undefined, async (request) => { queued.push(request); }, resolver).poll();
    expect(queued).toHaveLength(1);
    expect([...store.jobs.values()][0]).toMatchObject({ admission: {
      catalogEligible: false, destination: { classification: 'aggregate-board' },
      reasonCodes: ['destination-aggregate-board', 'posting-unattributed'],
    } });
  });

  it('keeps an existing exact-URL community role visible while its posting attribution is queued', async () => {
    const store = new MemoryInternshipStore();
    const applyUrl = 'https://job-boards.greenhouse.io/axon/jobs/7978840003';
    const reference = { ...listing(applyUrl, 'community-list'), externalId: 'row-1', provenance: 'reviewed-community' as const,
      company: 'Axon', title: '2027 US Mechanical Engineering Internship', location: 'Arizona, USA' };
    await store.putInternship({ jobId: 'legacy-axon', company: reference.company, title: reference.title,
      location: reference.location, season: reference.season, applyUrl, normalizedUrl: applyUrl, fingerprint: 'legacy-axon',
      compensation: reference.compensation, sourceReferences: [reference], open: true, firstSeenAt: reference.fetchedAt,
      lastSeenAt: reference.fetchedAt, notification: { smsPending: false, digestPending: false } });
    await store.claimPostingIdentity(buildPostingIdentity({ applicationUrl: applyUrl }), 'legacy-axon');
    const queued: string[] = [];
    const snapshot: SourceFetchResult & SourceSnapshot = {
      sourceId: 'community-list', outcome: 'changed', complete: true, rawCount: 1, contentHash: 'community-axon-refresh',
      listings: [], notModified: false, checkpoint: { sourceId: 'community-list', successfulFetches: 2 },
      postings: [{ sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1',
        sourceUrl: reference.sourceUrl, fetchedAt: '2026-08-28T00:00:00Z', employer: { name: 'Axon', authority: 'source-row' },
        title: reference.title, content: [], locations: [reference.location], applyUrl, sourceState: 'open', lifecycleAuthority: 'source' }],
    };
    const resolver = {
      async resolveCanonicalEmployer() { return { id: 'axon', displayName: 'Axon' }; },
      async resolveDestinationRule() { return undefined; },
    };
    await new Poller([{ id: snapshot.sourceId, async fetch() { return snapshot; } }], store,
      undefined, undefined, undefined, undefined, async ({ candidateUrl }) => { queued.push(candidateUrl); }, resolver).poll();
    const preserved = await store.getJob('legacy-axon');
    expect(preserved?.admission).toBeUndefined();
    expect(preserved).toMatchObject({ open: true, notification: { smsPending: false, digestPending: false } });
    expect(queued).toEqual([applyUrl]);
  });

  it('reprocesses an unchanged source after reviewed admission configuration changes', async () => {
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({ sourceId: 'greenhouse-acme', successfulFetches: 1, contentHash: 'same', etag: 'old-etag',
      admissionConfigurationVersion: 'configuration-v1' });
    let received: SourceCheckpoint | undefined;
    const adapter: SourceAdapter = {
      id: 'greenhouse-acme',
      async fetch(previous) {
        received = previous;
        return {
          sourceId: 'greenhouse-acme', outcome: previous?.contentHash === 'same' ? 'unchanged' : 'changed', complete: true,
          rawCount: 1, contentHash: 'same', listings: [], notModified: previous?.contentHash === 'same',
          checkpoint: { sourceId: 'greenhouse-acme', successfulFetches: 2, contentHash: 'same' },
          postings: [{ sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: 'acme-role', sourceUrl: 'https://boards-api.greenhouse.io/acme',
            fetchedAt: '2026-08-27T12:00:00Z', employer: { name: 'Acme', authority: 'reviewed-registry' }, title: 'Software Engineering Intern',
            providerIdentity: { provider: 'greenhouse', tenant: 'acme' },
            content: [], locations: ['Remote'], applyUrl: 'https://jobs.example.com/acme-role', sourceState: 'open', lifecycleAuthority: 'source' }],
        };
      },
    };
    const resolver = {
      async configurationVersion() { return 'configuration-v2'; },
      async resolveCanonicalEmployer(identity: { employerScope?: string }) {
        return identity.employerScope === 'employer:acme' ? { id: 'acme', displayName: 'Acme' } : undefined;
      },
      async resolveDestinationRule() { return { id: 'custom-posting-route', host: 'jobs.example.com', provider: 'greenhouse' as const,
        decision: 'standard-provider-route' as const, reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer' }; },
    };
    await new Poller([adapter], store, undefined, undefined, undefined, undefined, undefined, resolver).poll();
    expect(received).toMatchObject({ contentHash: undefined, etag: undefined });
    expect(await store.getCheckpoint('greenhouse-acme')).toMatchObject({ admissionConfigurationVersion: 'configuration-v2' });
    expect([...store.jobs.values()][0]).toMatchObject({ company: 'Acme', admission: { catalogEligible: true } });
  });

  it('slices a bounded resolution pass and resumes it across deliveries', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'github-example';
    const adapter = new SnapshotAdapter(sourceId, snapshotRows(900));
    const poll = () => new Poller([adapter], store).poll({ maxListingsPerSourceRun: 750 });

    const first = await poll();
    expect(await store.getSourceOccurrences(sourceId)).toHaveLength(750);
    expect(first.pendingResolution[sourceId]).toBe(150);
    expect(first.continuationSources).toEqual([sourceId]);
    expect(first.failures).toEqual([]);
    const firstCheckpoint = (await store.getCheckpoint(sourceId))!;
    expect(firstCheckpoint.etag).toBe('board-etag');
    expect(firstCheckpoint.pendingResolutionRows).toHaveLength(150);
    expect(firstCheckpoint.pendingResolutionRows).toContain('role-750');
    expect(firstCheckpoint.pendingResolutionRows).not.toContain('role-749');

    // An open pass re-reads the whole board: only the validators are cleared, so
    // the delivery is still labelled unchanged while the remaining 150 rows resolve.
    const second = await poll();
    expect(adapter.received[1]?.etag).toBeUndefined();
    expect(adapter.received[1]?.documentEtags).toBeUndefined();
    expect(adapter.received[1]?.contentHash).toBe(firstCheckpoint.contentHash);
    expect(second.unchangedSources).toEqual([sourceId]);
    expect(await store.getSourceOccurrences(sourceId)).toHaveLength(900);
    expect((await store.getCheckpoint(sourceId))?.pendingResolutionRows).toBeUndefined();
    expect(second.pendingResolution[sourceId]).toBeUndefined();
    expect(second.continuationSources).toEqual([]);
    expect(second.failures).toEqual([]);
  }, 15_000);

  it('resumes a seeded resolution pass from an unchanged delivery', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'github-example';
    const rows = snapshotRows(900);
    const adapter = new SnapshotAdapter(sourceId, rows);
    // Settle the board first so the seeded pass is the only outstanding work and
    // the checkpoint's metadata versions are current: an unchanged delivery
    // resolves nothing unless the pending set keeps the full body in scope.
    await new Poller([adapter], store).poll();
    const checkpoint = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...checkpoint, pendingResolutionRows: rows.map((row) => row.externalId) });

    const report = await new Poller([adapter], store).poll({ maxListingsPerSourceRun: 750 });

    expect(report.unchangedSources).toEqual([sourceId]);
    expect(adapter.received[1]?.contentHash).toBe(checkpoint.contentHash);
    expect(report.pendingResolution[sourceId]).toBe(150);
    expect(report.continuationSources).toEqual([sourceId]);
    expect((await store.getCheckpoint(sourceId))?.pendingResolutionRows).toHaveLength(150);
    expect(await store.getSourceOccurrences(sourceId)).toHaveLength(900);
    expect(report.failures).toEqual([]);
  }, 15_000);

  it('closes a resolution pass when pending rows leave the board', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'github-example';
    const adapter = new SnapshotAdapter(sourceId, snapshotRows(1000));
    const poll = () => new Poller([adapter], store).poll({ maxListingsPerSourceRun: 750 });

    const first = await poll();
    expect(first.pendingResolution[sourceId]).toBe(250);
    expect((await store.getCheckpoint(sourceId))?.pendingResolutionRows).toHaveLength(250);

    // 150 pending rows disappear between deliveries; only the 100 still listed
    // can resolve, and the pass must close instead of holding those 150 forever.
    adapter.setRows(snapshotRows(850));
    const second = await poll();

    expect(await store.getSourceOccurrences(sourceId)).toHaveLength(850);
    expect((await store.getCheckpoint(sourceId))?.pendingResolutionRows).toBeUndefined();
    expect(second.pendingResolution[sourceId]).toBeUndefined();
    expect(second.continuationSources).toEqual([]);
    expect(second.failures).toEqual([]);
  }, 15_000);

  it('reconciles an omission on the delivery that empties the resolution pass', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'github-example';
    const staleReference = {
      ...listing('https://jobs.example.com/role-stale', sourceId), externalId: 'role-stale',
    };
    await store.putInternship({
      jobId: 'stale-job', company: 'Acme', title: 'Software Engineering Intern', location: 'NYC', season: 'summer-2027',
      applyUrl: 'https://jobs.example.com/role-stale', normalizedUrl: 'https://jobs.example.com/role-stale',
      fingerprint: 'stale-job', compensation: { raw: '$40/hr', maxHourlyUSD: 40 }, sourceReferences: [staleReference],
      open: true, firstSeenAt: '2026-09-09T00:00:00.000Z', lastSeenAt: '2026-09-09T00:00:00.000Z',
      notification: { smsPending: false, digestPending: false },
    });
    await store.putSourceOccurrence({
      sourceId, externalId: 'role-stale', jobId: 'stale-job', occurrence: staleReference, present: true,
      consecutiveOmissions: 1, changedSnapshotHash: 'prior-snapshot', changedAt: '2026-09-09T00:00:00.000Z',
    });
    const adapter = new SnapshotAdapter(sourceId, snapshotRows(800));
    const poll = () => new Poller([adapter], store).poll({ maxListingsPerSourceRun: 750 });

    const first = await poll();
    expect(first.continuationSources).toEqual([sourceId]);
    expect(first.pendingResolution[sourceId]).toBe(50);
    // An open pass defers the closure to the delivery that empties it, so the
    // omitted job survives even though the row is already missing from the board.
    expect((await store.getJob('stale-job'))?.open).toBe(true);

    const final = await poll();
    expect(final.continuationSources).toEqual([]);
    expect(final.pendingResolution[sourceId]).toBeUndefined();
    expect((await store.getSourceOccurrences(sourceId)).find((value) => value.externalId === 'role-stale'))
      .toMatchObject({ present: false, occurrence: { state: 'closed' } });
    expect((await store.getJob('stale-job'))?.open).toBe(false);
    expect((await store.getSourceOccurrences(sourceId)).filter((value) => value.present)).toHaveLength(800);
    expect([...store.jobs.values()].filter((job) => job.jobId !== 'stale-job').every((job) => job.open)).toBe(true);
  }, 15_000);

  it('does not open a resolution pass for an unchanged board', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'github-example';
    const adapter = new SnapshotAdapter(sourceId, snapshotRows(900));
    await new Poller([adapter], store).poll();
    expect(await store.getSourceOccurrences(sourceId)).toHaveLength(900);

    const unchanged = await new Poller([adapter], store).poll({ maxListingsPerSourceRun: 750 });

    expect(unchanged.unchangedSources).toEqual([sourceId]);
    expect(unchanged.pendingResolution[sourceId]).toBeUndefined();
    expect(unchanged.continuationSources).toEqual([]);
    expect((await store.getCheckpoint(sourceId))?.pendingResolutionRows).toBeUndefined();
    expect(await store.getSourceOccurrences(sourceId)).toHaveLength(900);
    expect(unchanged.failures).toEqual([]);
  }, 15_000);
});
