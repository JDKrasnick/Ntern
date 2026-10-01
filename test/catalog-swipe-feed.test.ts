import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { Internship } from '../src/types.js';

/**
 * The swipe deck reads the public role feed one role at a time, newest first.
 * These pin the contract the deck depends on: no account required, individual
 * open roles in recency order, and a cursor the deck can keep loading from.
 */
const role = (jobId: string, firstSeenAt: string): Internship => ({
  jobId,
  company: 'Acme',
  title: `Software Intern ${jobId}`,
  location: 'Remote',
  season: 'summer-2027',
  applyUrl: `https://apply.example.test/${jobId}`,
  normalizedUrl: `https://apply.example.test/${jobId}`,
  fingerprint: `acme-${jobId}`,
  compensation: { raw: '' },
  sourceReferences: [],
  open: true,
  firstSeenAt,
  lastSeenAt: firstSeenAt,
  notification: { smsPending: false, digestPending: false },
});

const event = (method: string, rawPath: string, queryStringParameters?: Record<string, string>) => ({
  rawPath,
  queryStringParameters,
  requestContext: { http: { method } },
});

describe('swipe deck role feed', () => {
  it('serves individual open roles newest first without an account', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(role('oldest', '2026-01-01T00:00:00.000Z'));
    await jobs.putInternship(role('middle', '2026-05-01T00:00:00.000Z'));
    await jobs.putInternship(role('newest', '2026-09-01T00:00:00.000Z'));
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const response = await handler(event('GET', '/jobs', { status: 'open' }));
    expect(response.statusCode).toBe(200);
    const page = JSON.parse(response.body) as { jobs: Internship[] };
    expect(page.jobs.map((job) => job.jobId)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('pages with a cursor so the deck can keep loading', async () => {
    const jobs = new MemoryInternshipStore();
    for (const [jobId, seen] of [
      ['a', '2026-09-03T00:00:00.000Z'],
      ['b', '2026-09-02T00:00:00.000Z'],
      ['c', '2026-09-01T00:00:00.000Z'],
    ] as const) {
      await jobs.putInternship(role(jobId, seen));
    }
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const first = JSON.parse((await handler(event('GET', '/jobs', { status: 'open', limit: '2' }))).body) as { jobs: Internship[]; cursor?: string };
    expect(first.jobs.map((job) => job.jobId)).toEqual(['a', 'b']);
    expect(first.cursor).toBeDefined();
    const second = JSON.parse((await handler(event('GET', '/jobs', { status: 'open', limit: '2', cursor: first.cursor! }))).body) as { jobs: Internship[]; cursor?: string };
    expect(second.jobs.map((job) => job.jobId)).toEqual(['c']);
    expect(second.cursor).toBeUndefined();
  });
});
