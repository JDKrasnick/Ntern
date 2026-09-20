import { describe, expect, it } from 'vitest';
import { ExpoPushPublisher, sendNewJobNotifications } from '../src/notifications.js';
import { Poller } from '../src/poll.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const role = (row: number, title: string, location: string): RawListing => ({
  sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://github.com/example/roles', row, company: 'Acme', title, location,
  season: 'summer-2027', applyUrl: `https://careers.example.test/${row}`, compensation: { raw: '$50/hr', maxHourlyUSD: 50 },
  state: 'open', postedAt: '2026-07-19', fetchedAt: '2026-07-19T12:00:00.000Z',
});
class Adapter implements SourceAdapter {
  readonly id = 'fixture';
  constructor(private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } };
  }
}

describe('rendered native job alerts', () => {
  it('preserves each role’s precise location through poll, matching, and Expo payload rendering', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putCheckpoint({ sourceId: 'fixture', successfulFetches: 1, lastRowCount: 0 });
    const polled = await new Poller([new Adapter([
      role(1, 'Software Engineering Intern', 'New York, NY'),
      role(2, 'Machine Learning Intern', 'Remote (US)'),
      role(3, 'Backend Engineering Intern', 'Austin, TX'),
      role(4, 'Platform Software Engineering Intern', 'Seattle, WA'),
    ])], jobs).poll();
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'student', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-07-19T00:00:00.000Z' });
    await users.putDevice({ userId: 'student', token: 'ExponentPushToken[student]', platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' });
    const payloads: Array<{ title: string; body: string; data: { jobId: string } }> = [];
    const publisher = new ExpoPushPublisher('https://push.example.test', async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)) as { title: string; body: string; data: { jobId: string } });
      return new Response(JSON.stringify({ data: { id: `ticket-${payloads.length}`, status: 'ok' } }), { status: 200 });
    });

    // One employer, one day: the three roles arrive as a single drop alert, and
    // the body still carries each role's own precise location.
    expect(await sendNewJobNotifications(polled.newJobs, users, publisher)).toEqual({ sent: 4, skipped: 0, failed: 0 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.title).toBe('Acme posted 4 matching roles');
    expect(payloads[0]?.body).toContain('New York, NY · summer-2027');
    expect(payloads[0]?.body).toContain('Remote — US · summer-2027');
    expect(payloads[0]?.body).toContain('Austin, TX · summer-2027');
    expect(payloads[0]?.body).toContain('Focus: SWE, AI/ML, Backend/API');
    expect(payloads[0]?.body).toContain('+1 more');
  });
});
