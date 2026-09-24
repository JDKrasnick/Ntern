import { describe, expect, it } from 'vitest';
import {
  boardReference,
  reachabilityFromFailure,
  reachabilityFromSignals,
  verifyApplication,
} from '../src/core/application-verification.js';
import { IngestionRunner } from '../src/poll.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { ProcessedListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const listing = (overrides: Partial<ProcessedListing>): ProcessedListing => ({
  sourceId: 'markdown-list', externalId: 'role-1', document: 'README.md', sourceUrl: 'https://github.test',
  row: 1, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
  applyUrl: 'https://careers.example.test/role-1', compensation: { raw: '' },
  requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false }, state: 'open',
  fetchedAt: '2026-07-29T12:00:00.000Z', technical: true, ...overrides,
});

const adapter = (rows: ProcessedListing[], id = 'markdown-list'): SourceAdapter => ({
  id,
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return {
      sourceId: id, rawRowCount: rows.length, listings: rows, notModified: false,
      checkpoint: {
        sourceId: id, contentHash: `h${Math.random()}`, successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastRowCount: rows.length, activeExternalIds: rows.map((row) => row.externalId!),
      },
    };
  },
});

describe('application URL attribution', () => {
  it('reads the board and posting an ATS application URL points at', () => {
    expect(boardReference('https://job-boards.greenhouse.io/stripe/jobs/8657500002'))
      .toEqual({ provider: 'greenhouse', token: 'stripe', postingId: '8657500002' });
    expect(boardReference('https://jobs.lever.co/palantir/9e40d77f-0148-41f0-b2b1-ff054450a320/apply'))
      .toEqual({ provider: 'lever', token: 'palantir', postingId: '9e40d77f-0148-41f0-b2b1-ff054450a320' });
    expect(boardReference('https://www.tesla.com/careers/search/job/12345')).toBeUndefined();
    expect(boardReference('not a url')).toBeUndefined();
  });
});

describe('reachability', () => {
  it('separates a destination that is gone from one that refused to be read', () => {
    expect(reachabilityFromFailure(new Error('Application link returned HTTP 410'))).toBe('gone');
    expect(reachabilityFromFailure(new Error('Application page returned HTTP 404'))).toBe('gone');
    expect(reachabilityFromFailure(new Error('Application link returned HTTP 403'))).toBe('blocked');
    expect(reachabilityFromFailure(new Error('Application page returned HTTP 406'))).toBe('blocked');
    expect(reachabilityFromFailure(new Error('Application link returned HTTP 503'))).toBe('unreachable');
    expect(reachabilityFromFailure(new Error('fetch timed out'))).toBe('unreachable');
    expect(reachabilityFromSignals(['destination reached', 'access restricted to scraper'])).toBe('blocked');
    expect(reachabilityFromSignals(['destination reached', 'job-description language'])).toBe('live');
  });
});

describe('verification decision', () => {
  it('lets attribution carry a role whose page cannot be read', () => {
    expect(verifyApplication({ attribution: 'provider-api', reachability: 'implied' }))
      .toMatchObject({ alertEligible: true, quarantine: false });
    // Ashby and Workday render by JavaScript, so the page describes nothing.
    expect(verifyApplication({ attribution: 'reviewed-board', reachability: 'live', described: false }))
      .toMatchObject({ alertEligible: true });
  });

  it('requires the page to vouch for a role nothing else attributes', () => {
    expect(verifyApplication({ attribution: 'unattributed', reachability: 'live', described: true }).alertEligible).toBe(true);
    expect(verifyApplication({ attribution: 'unattributed', reachability: 'blocked', described: false }).alertEligible).toBe(false);
    // Never inspected is not the same as inspected and unconvincing.
    expect(verifyApplication({ attribution: 'unattributed', reachability: 'implied' }).alertEligible).toBe(true);
  });

  it('hides a role only when its destination is proven gone', () => {
    for (const attribution of ['provider-api', 'reviewed-board', 'unattributed'] as const) {
      expect(verifyApplication({ attribution, reachability: 'gone' }))
        .toMatchObject({ alertEligible: false, quarantine: true });
    }
    expect(verifyApplication({ attribution: 'unattributed', reachability: 'unreachable' }).quarantine).toBe(false);
  });
});

describe('verification in the poll', () => {
  const seeded = async (store: MemoryInternshipStore) => {
    await store.putCheckpoint({ sourceId: 'markdown-list', successfulFetches: 1, lastRowCount: 1 });
  };

  it('never fetches a role attributed by a board this catalog polls', async () => {
    const store = new MemoryInternshipStore();
    await seeded(store);
    // The Greenhouse worker already recorded this board's active postings.
    await store.putCheckpoint({
      sourceId: 'greenhouse-stripe', successfulFetches: 4, lastRowCount: 2,
      activeExternalIds: ['8657500002'],
    });
    const fetched: string[] = [];
    const report = await new IngestionRunner(
      [adapter([listing({ applyUrl: 'https://job-boards.greenhouse.io/stripe/jobs/8657500002' })])],
      store, () => new Date('2026-07-29T12:00:00.000Z'), undefined,
      async (url: string) => { fetched.push(url); return url; },
    ).run();

    expect(fetched).toEqual([]);
    expect(report.newJobs).toHaveLength(1);
    expect([...store.jobs.values()][0]?.applicationUrlValidatedAt).toBe('2026-07-29T12:00:00.000Z');
  });

  it('falls back to reading the page when no board can attribute the role', async () => {
    const store = new MemoryInternshipStore();
    await seeded(store);
    const fetched: string[] = [];
    await new IngestionRunner(
      [adapter([listing({ applyUrl: 'https://job-boards.greenhouse.io/unknown-board/jobs/1' })])],
      store, () => new Date('2026-07-29T12:00:00.000Z'), undefined,
      async (url: string) => { fetched.push(url); return url; },
    ).run();

    expect(fetched).toEqual(['https://job-boards.greenhouse.io/unknown-board/jobs/1']);
  });

  it('replaces current list-wide season with employer evidence, then rolls a past cycle forward', async () => {
    const store = new MemoryInternshipStore();
    await seeded(store);
    const rows = [listing({ season: 'summer-2027', seasonSource: 'source-default' })];
    await new IngestionRunner([adapter(rows)], store, () => new Date('2026-07-29T12:00:00.000Z')).run();

    await new IngestionRunner(
      [adapter(rows)], store, () => new Date('2026-07-29T13:00:00.000Z'), undefined,
      async (url: string) => ({
        url,
        evidence: {
          url,
          title: 'Machine Learning Engineer Intern - 2026 Start',
          contentExcerpt: 'Able to work for 12 weeks during Summer 2026.',
          confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['destination reached'] },
        },
      }),
    ).run();

    expect([...store.jobs.values()][0]).toMatchObject({
      season: 'summer-2026',
      applicationPageMetadataVersion: ROLE_METADATA_EXTRACTION_VERSION + 1,
    });

    const refetched: string[] = [];
    await new IngestionRunner(
      [adapter(rows)], store, () => new Date('2026-07-29T14:00:00.000Z'), undefined,
      async (url: string) => { refetched.push(url); return url; },
    ).run();
    expect(refetched).toEqual([]);
    expect([...store.jobs.values()][0]?.season).toBe('summer-2027');
  });

  it('does not let employer-page enrichment override a season in the listing title', async () => {
    const store = new MemoryInternshipStore();
    await seeded(store);
    const rows = [listing({
      title: 'Software Engineering Intern, Summer 2026',
      season: 'summer-2026',
      seasonSource: 'source-default',
    })];

    await new IngestionRunner(
      [adapter(rows)], store, () => new Date('2026-07-29T13:00:00.000Z'), undefined,
      async (url: string) => ({
        url,
        evidence: {
          url,
          title: 'Software Engineering Intern, Summer 2027',
          confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['destination reached'] },
        },
      }),
    ).run();

    expect([...store.jobs.values()][0]?.season).toBe('summer-2026');
  });

  it('keeps an open role visible when its destination merely times out', async () => {
    const store = new MemoryInternshipStore();
    await seeded(store);
    const rows = [listing({})];
    await new IngestionRunner([adapter(rows)], store, () => new Date('2026-07-29T12:00:00.000Z')).run();
    const before = [...store.jobs.values()][0]!;
    expect(before.open).toBe(true);

    const report = await new IngestionRunner([adapter(rows)], store, () => new Date('2026-07-29T13:00:00.000Z'),
      undefined, async () => { throw new Error('fetch timed out'); }).run();

    // A one-row timeout exceeds the share gate, which reports the aggregate
    // source failure before retaining the sampled per-row timeout for diagnosis.
    expect(report.failures).toContainEqual(expect.stringContaining('1 of 1 rows could not be verified'));
    expect(report.failures).toContainEqual(expect.stringContaining('fetch timed out'));
    expect((await store.getJob(before.jobId))?.invalidApplicationUrl).toBeUndefined();
    expect((await store.getJob(before.jobId))?.open).toBe(true);
  });

  it('hides an open role whose destination is gone', async () => {
    const store = new MemoryInternshipStore();
    await seeded(store);
    const rows = [listing({})];
    await new IngestionRunner([adapter(rows)], store, () => new Date('2026-07-29T12:00:00.000Z')).run();
    const before = [...store.jobs.values()][0]!;

    await new IngestionRunner([adapter(rows)], store, () => new Date('2026-07-29T13:00:00.000Z'),
      undefined, async () => { throw new Error('Application link returned HTTP 410'); }).run();

    expect((await store.getJob(before.jobId))?.invalidApplicationUrl).toBe(before.normalizedUrl);
    expect((await store.getJob(before.jobId))?.open).toBe(false);
  });
});
