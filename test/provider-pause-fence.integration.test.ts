import { describe, expect, it, vi } from 'vitest';
import { processGreenhouseQueue, runGreenhouseBoard } from '../src/greenhouse-worker.js';
import { processLeverQueue, runLeverBoard } from '../src/lever-worker.js';
import { processAshbyQueue, runAshbyBoard } from '../src/ashby-worker.js';
import { MemoryInternshipStore } from '../src/store.js';
import { sourceDeliveryPaused } from '../src/source-health.js';
import type { SourceHealth } from '../src/types.js';
import type { GreenhouseWorkMessage } from '../src/greenhouse-dispatch.js';
import { acmeSource, technicalInternship } from './fixtures/greenhouse.js';
import { GREENHOUSE_RESPONSE_MAX_BYTES } from '../src/sources/greenhouse.js';

const pausedAt = '2026-10-08T12:00:00.000Z';
const earlier = '2026-10-08T11:59:59.000Z';
const later = '2026-10-08T12:00:01.000Z';
const health = (sourceId: string): SourceHealth => ({
  sourceId, sourceStatus: 'paused', state: 'healthy', changedAt: pausedAt,
  lastAttemptAt: earlier, consecutiveFailures: 0, durationMs: 0,
});

describe.each(['greenhouse', 'lever', 'ashby'] as const)('%s pause fences queued work', (provider) => {
  const sourceId = `${provider}-acme`;
  async function fixture() {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth(health(sourceId));
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('reached-provider'));
    const discover = vi.fn();
    const common = { store, fetchImpl, shadowDiscovery: { isEnabledForSource: () => true, discover },
      v2CatalogWriteOwner: () => true, linkValidator: async (url: string) => url };
    const run = (message: { force?: boolean; forceRequestedAt?: string }) => {
      const work = { version: 1 as const, sourceId, scheduledAt: later, ...message };
      if (provider === 'greenhouse') return runGreenhouseBoard(work, { ...common,
        sources: [{ ...acmeSource, id: sourceId, status: 'published' }] });
      if (provider === 'lever') return runLeverBoard(work, { ...common,
        sources: [{ id: sourceId, company: 'Acme', site: 'acme', careersUrl: 'https://acme.test/careers',
          admittedAt: earlier, status: 'published', region: 'global', evidenceStatus: 'legacy-review' }] });
      return runAshbyBoard(work, { ...common,
        sources: [{ id: sourceId, company: 'Acme', careersUrl: 'https://acme.test/careers', admittedAt: earlier,
          identity: { provider: 'ashby', boardKey: 'Acme', apiRegion: 'global' },
          evidenceState: 'ownership-verified', allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'published' }] });
    };
    return { store, fetchImpl, discover, run };
  }

  it.each([
    {}, { force: true }, { force: true, forceRequestedAt: earlier },
    { force: true, forceRequestedAt: pausedAt },
  ])('skips stale or unproven authorization without any source effects (%j)', async (message) => {
    const f = await fixture();
    await expect(f.run(message)).resolves.toMatchObject({ skipped: 'paused' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.store.jobs.size).toBe(0);
    expect(await f.store.getCheckpoint(sourceId)).toBeUndefined();
    expect(await f.store.getSourceHealth(sourceId)).toEqual(health(sourceId));
  });

  it('allows an explicit force request after the pause', async () => {
    const f = await fixture();
    await expect(f.run({ force: true, forceRequestedAt: later })).rejects.toThrow('reached-provider');
    expect(f.fetchImpl).toHaveBeenCalled();
  });

  it('allows the validation request recorded with an explicit recovery pause', async () => {
    const f = await fixture();
    await f.store.putSourceHealth({ ...health(sourceId), state: 'quarantined', incidentAcknowledgedAt: pausedAt });
    await expect(f.run({ force: true, forceRequestedAt: pausedAt })).rejects.toThrow('reached-provider');
    expect(f.fetchImpl).toHaveBeenCalled();
  });
});

it.each([[undefined, false], [earlier, false], [earlier, true]] as const)('retains force authorization across a Greenhouse continuation (%s, recovery=%s)', async (origin, recovery) => {
  const store = new MemoryInternshipStore();
  const source = { ...acmeSource, status: 'published' as const };
  const jobs = Array.from({ length: 25 }, (_, index) => ({ ...technicalInternship, id: 5000 + index,
    title: 'Software Engineering Intern, Summer 2027',
    absolute_url: `https://job-boards.greenhouse.io/${source.boardToken}/jobs/${5000 + index}` }));
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get('content') === 'true') {
      return new Response(new Uint8Array(GREENHOUSE_RESPONSE_MAX_BYTES + 1));
    }
    const id = Number(url.pathname.split('/').at(-1));
    return Response.json(Number.isFinite(id) ? jobs.find(job => job.id === id)
      : { jobs: jobs.map(job => ({ ...job, content: undefined })) });
  });
  const continuations: GreenhouseWorkMessage[] = [];
  const dependencies = { store, sources: [source], fetchImpl, linkValidator: async (url: string) => url,
    enqueueContinuation: async (message: GreenhouseWorkMessage) => { continuations.push(message); } };
  if (recovery) await store.putSourceHealth({ ...health(source.id), state: 'quarantined',
    changedAt: earlier, incidentAcknowledgedAt: earlier });
  await runGreenhouseBoard({ version: 1, sourceId: source.id, scheduledAt: earlier, force: true,
    forceRequestedAt: origin }, dependencies);
  expect(continuations).toHaveLength(1);
  expect(continuations[0]).toMatchObject({ force: true, forceRequestedAt: earlier });
  if (recovery) {
    await expect(runGreenhouseBoard(continuations[0]!, dependencies)).resolves.not.toHaveProperty('skipped');
    expect(await store.getSourceHealth(source.id)).toMatchObject({ sourceStatus: 'paused', state: 'healthy', incidentAcknowledgedAt: earlier });
    expect((await store.getCheckpoint(source.id))?.pendingGreenhousePostingIds ?? []).toHaveLength(0);
    return;
  }
  await store.putSourceHealth(health(source.id));
  const checkpoint = await store.getCheckpoint(source.id);
  const fetches = fetchImpl.mock.calls.length;
  await expect(runGreenhouseBoard(continuations[0]!, dependencies)).resolves.toMatchObject({ skipped: 'paused' });
  expect(fetchImpl).toHaveBeenCalledTimes(fetches);
  expect(await store.getCheckpoint(source.id)).toEqual(checkpoint);
});

describe.each([processGreenhouseQueue, processLeverQueue, processAshbyQueue])('queued authorization validation', (consume) => {
  it.each([
    { force: 'true' }, { force: true, forceRequestedAt: 'invalid' },
    { force: true, forceRequestedAt: later },
    { seedOnly: true }, { force: true, seedOnly: 'true' },
  ])('rejects a malformed or future request before fetching (%j)', async (fields) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await consume({ Records: [{ messageId: 'invalid', body: JSON.stringify({
      version: 1, sourceId: 'test', scheduledAt: pausedAt, ...fields,
    }) }] }, { store: new MemoryInternshipStore(), fetchImpl });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'invalid' }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it('does not suppress active sources or new force requests against legacy health', () => {
  expect(sourceDeliveryPaused({ ...health('test'), sourceStatus: 'active' }, { force: true })).toBe(false);
  expect(sourceDeliveryPaused({ ...health('test'), changedAt: undefined }, { force: true, forceRequestedAt: later })).toBe(false);
});


describe('silent Greenhouse backfill', () => {
  const source = { ...acmeSource, status: 'published' as const };
  const work = { version: 1 as const, sourceId: source.id, scheduledAt: later, force: true, forceRequestedAt: later, seedOnly: true };
  it('seeds an established catalog quietly, then alerts only for a genuinely new role', async () => {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth(health(source.id));
    await store.putCheckpoint({ sourceId: source.id, successfulFetches: 3 });
    let jobs = [technicalInternship];
    const dependencies = { store, sources: [source], linkValidator: async (url: string) => url,
      catalogAdmissionResolver: { async configurationVersion() { return 'reviewed-acme'; },
        async resolveCanonicalEmployer() { return { id: source.employerId, displayName: source.displayName }; },
        async resolveDestinationRule() { return undefined; } },
      fetchImpl: async () => Response.json({ jobs }) };
    await runGreenhouseBoard(work, dependencies);
    expect(store.jobs.size).toBe(1);
    expect(store.notificationEvents.size).toBe(0);
    await store.putSourceHealth({ ...health(source.id), sourceStatus: 'active' });
    jobs = [...jobs, { ...technicalInternship, id: 5002, internal_job_id: 5002, absolute_url: technicalInternship.absolute_url!.replace('5001', '5002') }];
    await runGreenhouseBoard({ ...work, force: false, seedOnly: undefined }, dependencies);
    expect(store.jobs.size).toBe(2);
    expect(store.notificationEvents.size).toBe(1);
  });
  it('retains quiet mode and the original force boundary through bounded detail continuations', async () => {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth(health(source.id));
    await store.putCheckpoint({ sourceId: source.id, successfulFetches: 3 });
    const jobs = Array.from({ length: 25 }, (_, index) => ({ ...technicalInternship, id: 6000 + index,
      internal_job_id: 6000 + index, absolute_url: `https://job-boards.greenhouse.io/${source.boardToken}/jobs/${6000 + index}` }));
    const continuations: GreenhouseWorkMessage[] = [];
    const dependencies = { store, sources: [source], linkValidator: async (url: string) => url,
      enqueueContinuation: async (message: GreenhouseWorkMessage) => { continuations.push(message); },
      fetchImpl: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.searchParams.get('content') === 'true') return new Response(new Uint8Array(GREENHOUSE_RESPONSE_MAX_BYTES + 1));
        const id = Number(url.pathname.split('/').at(-1));
        return Response.json(Number.isFinite(id) ? jobs.find(job => job.id === id) : { jobs: jobs.map(job => ({ ...job, content: undefined })) });
      } };
    await runGreenhouseBoard(work, dependencies);
    expect(continuations).toHaveLength(1);
    expect(continuations[0]).toMatchObject({ seedOnly: true, force: true, forceRequestedAt: later });
    await runGreenhouseBoard(continuations[0]!, dependencies);
    expect((await store.getCheckpoint(source.id))?.pendingGreenhousePostingIds ?? []).toHaveLength(0);
    expect(store.jobs.size).toBe(25);
    expect(store.notificationEvents.size).toBe(0);
    await store.putSourceHealth({ ...health(source.id), sourceStatus: 'active' });
    const fetches = (await store.getCheckpoint(source.id))?.successfulFetches;
    await expect(runGreenhouseBoard(continuations[0]!, dependencies)).resolves.toMatchObject({ skipped: 'silent-backfill-ineligible' });
    expect((await store.getCheckpoint(source.id))?.successfulFetches).toBe(fetches);
  });
  it.each(['active', 'quarantined', 'owned', 'shadow'] as const)('acknowledges obsolete quiet work for %s without source effects', async (kind) => {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth({ ...health(source.id), ...(kind === 'active' ? { sourceStatus: 'active' as const } : {}),
      ...(kind === 'quarantined' ? { state: 'quarantined' as const } : {}) });
    const fetchImpl = vi.fn<typeof fetch>();
    const before = await store.getSourceHealth(source.id);
    const result = await processGreenhouseQueue({ Records: [{ messageId: 'late-quiet', body: JSON.stringify(work) }] },
      { store, sources: [{ ...source, status: kind === 'shadow' ? 'shadow' : 'published' }],
        fetchImpl, v2CatalogWriteOwner: () => kind === 'owned' });
    expect(result.batchItemFailures).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await store.getSourceHealth(source.id)).toEqual(before);
    expect(await store.getCheckpoint(source.id)).toBeUndefined();
    expect(store.jobs.size).toBe(0);
    expect(store.notificationEvents.size).toBe(0);
  });
  it.each([{ seedOnly: 'true', force: true }, { seedOnly: true }])('rejects malformed authorization (%j)', async (flags) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await processGreenhouseQueue({ Records: [{ messageId: 'bad-seed', body: JSON.stringify({
      version: 1, sourceId: source.id, scheduledAt: later, ...flags,
    }) }] }, { store: new MemoryInternshipStore(), fetchImpl });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-seed' }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


describe.each(['lever', 'ashby'] as const)('silent %s backfill', provider => {
  const sourceId = `${provider}-acme`;
  const work = { version: 1 as const, sourceId, scheduledAt: later, force: true, forceRequestedAt: later, seedOnly: true };
  async function fixture() {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth(health(sourceId));
    await store.putCheckpoint({ sourceId, successfulFetches: 3 });
    const ids = ['11111111-1111-4111-8111-111111111111'];
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(provider === 'lever' ? ids.map(id => ({
      id, text: 'Software Engineering Intern, Summer 2027', descriptionPlain: 'Build software systems.',
      createdAt: 1783072000000, categories: { location: 'New York, NY', commitment: 'Internship' },
      hostedUrl: `https://jobs.lever.co/acme/${id}`, applyUrl: `https://jobs.lever.co/acme/${id}/apply`,
    })) : { apiVersion: '1', jobs: ids.map(id => ({ id, title: 'Software Engineering Intern, Summer 2027',
      location: 'New York, NY', isListed: true, employmentType: 'Intern', publishedAt: '2026-08-09T12:00:00Z',
      descriptionPlain: 'Build software systems.', jobUrl: `https://jobs.ashbyhq.com/Acme/${id}`,
      applyUrl: `https://jobs.ashbyhq.com/Acme/${id}/application`,
    })) }));
    const common = { store, fetchImpl, linkValidator: async (url: string) => url,
      catalogAdmissionResolver: { async configurationVersion() { return 'reviewed-acme'; },
        async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; },
        async resolveDestinationRule() { return undefined; } } };
    const run = (message = work, owner = false) => provider === 'lever'
      ? runLeverBoard(message, { ...common, v2CatalogWriteOwner: () => owner,
        sources: [{ id: sourceId, company: 'Acme', site: 'acme', careersUrl: 'https://acme.test/careers',
          admittedAt: earlier, status: 'published', region: 'global', evidenceStatus: 'legacy-review' }] })
      : runAshbyBoard(message, { ...common, v2CatalogWriteOwner: () => owner,
        sources: [{ id: sourceId, company: 'Acme', careersUrl: 'https://acme.test/careers', admittedAt: earlier,
          identity: { provider: 'ashby', boardKey: 'Acme', apiRegion: 'global' }, evidenceState: 'ownership-verified',
          allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'published' }] });
    return { store, fetchImpl, run, addRole: () => { ids.push('22222222-2222-4222-8222-222222222222'); } };
  }
  it('seeds an existing checkpoint without alerts, then alerts only for a new role', async () => {
    const f = await fixture();
    await f.run();
    expect(f.store.jobs.size).toBe(1);
    expect(f.store.notificationEvents.size).toBe(0);
    await f.store.putSourceHealth({ ...health(sourceId), sourceStatus: 'active' });
    f.addRole();
    await f.run({ ...work, force: false, seedOnly: false });
    expect(f.store.jobs.size).toBe(2);
    expect(f.store.notificationEvents.size).toBe(1);
    const calls = f.fetchImpl.mock.calls.length;
    await expect(f.run()).resolves.toMatchObject({ skipped: 'silent-backfill-ineligible' });
    expect(f.fetchImpl.mock.calls).toHaveLength(calls);
  });
  it('does not seed a source already owned by V2', async () => {
    const f = await fixture();
    await expect(f.run(work, true)).resolves.toMatchObject({ skipped: 'silent-backfill-ineligible' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.store.jobs.size).toBe(0);
  });
});
