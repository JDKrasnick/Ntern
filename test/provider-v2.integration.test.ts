import { describe, expect, it } from 'vitest';
import { runGreenhouseBoard } from '../src/greenhouse-worker.js';
import { runLeverBoard } from '../src/lever-worker.js';
import { runAshbyBoard } from '../src/ashby-worker.js';
import { MemoryInternshipStore } from '../src/store.js';
import { normalizeSourceSnapshot } from '../src/ingestion-v2/normalize.js';
import type { ShadowDiscoveryHook, ShadowDiscoveryInput } from '../src/ingestion-v2/types.js';
import { acmeSource, technicalInternship } from './fixtures/greenhouse.js';

const postingId = '11111111-1111-4111-8111-111111111111';
const title = 'Software Engineering Intern, Summer 2027';
const scheduledAt = '2026-10-05T12:00:00.000Z';

it.each([false, true])('re-fetches an unchanged reviewed Greenhouse board for V2 (catalog owner=%s)', async (owner) => {
  const source = { ...acmeSource, id: 'greenhouse-figma', boardToken: 'figma', status: 'published' as const };
  const store = new MemoryInternshipStore();
  const observed: ShadowDiscoveryInput[] = [];
  const conditionalRequests: boolean[] = [];
  const dependencies = {
    store, sources: [source], v2CatalogWriteOwner: () => owner,
    linkValidator: async (url: string) => url,
    shadowDiscovery: {
      isEnabledForSource: () => true,
      async discover(input: ShadowDiscoveryInput) {
        observed.push(input);
        return { completed: true, snapshotHash: normalizeSourceSnapshot(input).snapshotHash };
      },
    },
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const conditional = new Headers(init?.headers).has('If-None-Match');
      conditionalRequests.push(conditional);
      return conditional ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ jobs: [{
        ...technicalInternship, absolute_url: 'https://job-boards.greenhouse.io/figma/jobs/5001',
      }] }), { headers: { ETag: 'stable-board' } });
    },
  };
  await runGreenhouseBoard({ version: 1, sourceId: source.id, scheduledAt }, dependencies);
  const before = await store.getCheckpoint(source.id);
  expect(before?.etag).toBe('stable-board');
  await runGreenhouseBoard({ version: 1, sourceId: source.id, scheduledAt }, dependencies);
  expect(conditionalRequests).toEqual([false, false]);
  expect(observed).toHaveLength(2);
  expect(observed[1]!.snapshotHash).toBe(observed[0]!.snapshotHash);
  expect(observed[1]!.postings).toHaveLength(1);
  expect(await store.getSourceHealth(source.id)).toMatchObject({ state: 'healthy', consecutiveFailures: 0 });
  expect((await store.getCheckpoint(source.id))?.contentHash).toBe(before?.contentHash);
});

async function run(provider: 'greenhouse' | 'lever' | 'ashby', owner: boolean, completed = true) {
  const store = new MemoryInternshipStore();
  const observed: ShadowDiscoveryInput[] = [];
  const hook: ShadowDiscoveryHook = {
    isEnabledForSource: () => true,
    async discover(input) {
      observed.push(input);
      const snapshot = normalizeSourceSnapshot(input);
      return { completed, snapshotHash: snapshot.snapshotHash };
    },
  };
  const dependencies = {
    store, shadowDiscovery: hook, v2CatalogWriteOwner: () => owner,
    v2TrustedCommunityAlertsEnabled: () => false,
    linkValidator: async (url: string) => url,
  };
  if (provider === 'greenhouse') {
    const source = { ...acmeSource, status: 'published' as const };
    await runGreenhouseBoard({ version: 1, sourceId: source.id, scheduledAt }, {
      ...dependencies, sources: [source],
      fetchImpl: async () => new Response(JSON.stringify({ jobs: [technicalInternship] })),
    });
  } else if (provider === 'lever') {
    const source = { id: 'lever-acme', company: 'Acme', site: 'acme', careersUrl: 'https://acme.test/careers',
      admittedAt: scheduledAt, status: 'published' as const, region: 'global' as const,
      evidenceStatus: 'legacy-review' as const };
    await runLeverBoard({ version: 1, sourceId: source.id, scheduledAt, runId: 'lever-v2-test' }, {
      ...dependencies, sources: [source],
      fetchImpl: async () => new Response(JSON.stringify([{ id: postingId, text: title,
        applyUrl: `https://jobs.lever.co/acme/${postingId}/apply`,
        hostedUrl: `https://jobs.lever.co/acme/${postingId}`, descriptionPlain: 'Build software. Summer 2027 internship.',
        categories: { location: 'New York', commitment: 'Intern' }, createdAt: Date.parse(scheduledAt) }])),
    });
  } else {
    const source = { id: 'ashby-acme', company: 'Acme',
      identity: { provider: 'ashby' as const, boardKey: 'Acme', apiRegion: 'global' as const },
      careersUrl: 'https://acme.test/careers', admittedAt: scheduledAt,
      evidenceState: 'ownership-verified' as const, allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }],
      status: 'published' as const };
    await runAshbyBoard({ version: 1, sourceId: source.id, scheduledAt, runId: 'ashby-v2-test' }, {
      ...dependencies, sources: [source],
      fetchImpl: async () => new Response(JSON.stringify({ apiVersion: '1', jobs: [{ id: postingId, title,
        location: 'New York', isListed: true, employmentType: 'Intern', descriptionPlain: 'Build software.',
        jobUrl: `https://jobs.ashbyhq.com/Acme/${postingId}`,
        applyUrl: `https://jobs.ashbyhq.com/Acme/${postingId}/application` }] })),
    });
  }
  return { store, observed };
}

describe.each(['greenhouse', 'lever', 'ashby'] as const)('%s queue worker V2 boundary', (provider) => {
  it('observes a complete parsed board while legacy retains catalog ownership', async () => {
    const { store, observed } = await run(provider, false);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.postings).toHaveLength(1);
    expect(observed[0]!.sourceId).toMatch(new RegExp(`^${provider}-`));
    expect(store.jobs.size).toBe(1);
  });

  it('persists discovery and skips legacy catalog effects for a V2-owned source', async () => {
    const { store, observed } = await run(provider, true);
    expect(observed).toHaveLength(1);
    expect(store.jobs.size).toBe(0);
    expect(await store.getCheckpoint(observed[0]!.sourceId)).toBeDefined();
  });

  it('fails closed when an owned source cannot persist its snapshot', async () => {
    await expect(run(provider, true, false)).rejects.toThrow('failed to persist its complete source snapshot');
  });
});
