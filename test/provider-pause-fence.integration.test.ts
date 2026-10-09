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
    await expect(runGreenhouseBoard(continuations[0]!, dependencies)).rejects.toThrow('Silent Greenhouse backfill');
  });
  it.each(['active', 'quarantined', 'owned', 'shadow'] as const)('rejects %s before fetching', async (kind) => {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth({ ...health(source.id), ...(kind === 'active' ? { sourceStatus: 'active' as const } : {}),
      ...(kind === 'quarantined' ? { state: 'quarantined' as const } : {}) });
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(runGreenhouseBoard(work, { store, sources: [{ ...source, status: kind === 'shadow' ? 'shadow' : 'published' }],
      fetchImpl, v2CatalogWriteOwner: () => kind === 'owned' })).rejects.toThrow('Silent Greenhouse backfill');
    expect(fetchImpl).not.toHaveBeenCalled();
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
