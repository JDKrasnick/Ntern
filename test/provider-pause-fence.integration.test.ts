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

it.each([undefined, earlier])('retains force authorization across a Greenhouse continuation (%s)', async (origin) => {
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
  await runGreenhouseBoard({ version: 1, sourceId: source.id, scheduledAt: earlier, force: true,
    forceRequestedAt: origin }, dependencies);
  expect(continuations).toHaveLength(1);
  expect(continuations[0]).toMatchObject({ force: true, forceRequestedAt: earlier });
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
