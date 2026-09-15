import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';
import { NtfyPublisher, sendDigest, sendPendingNotifications, SesEmailSender, type EmailSender, type PushMessage, type PushPublisher } from '../src/notifications.js';
import { Poller } from '../src/poll.js';
import { MemoryInternshipStore } from '../src/store.js';
import { GREENHOUSE_RESPONSE_MAX_BYTES, GreenhouseBoardAdapter } from '../src/sources/greenhouse.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';
import { acmeSource } from './fixtures/greenhouse.js';

const row = (number: number, sourceId = 'fixture'): RawListing => ({
  sourceId, document: 'README.md', sourceUrl: 'https://github.com/fixture/list', row: number,
  company: number === 1 ? 'OpenAI' : `Company ${number}`, title: `Software Intern ${number}`,
  location: 'New York, NY', season: 'summer-2027', applyUrl: `https://jobs.ashbyhq.com/fixture/00000000-0000-0000-0000-${String(number).padStart(12, '0')}?utm_source=fixture`,
  compensation: { raw: `$${40 + number}/hr`, maxHourlyUSD: 40 + number }, state: 'open',
  postedAt: `2026-07-${String(number).padStart(2, '0')}`, fetchedAt: '2026-07-18T12:00:00.000Z'
});

class FixtureAdapter implements SourceAdapter {
  constructor(readonly id: string, private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> {
    return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length, lastSuccessAt: '2026-07-18T12:00:00.000Z' } };
  }
}

class RecorderSms implements PushPublisher {
  messages: PushMessage[] = []; calls = 0;
  async publish(message: PushMessage): Promise<void> { this.calls += 1; if (this.calls === 2) throw new Error('simulated push timeout'); this.messages.push(message); }
}
class RecorderEmail implements EmailSender {
  calls = 0; subject = ''; text = ''; html = '';
  async send(subject: string, text: string, html: string): Promise<void> { this.calls += 1; this.subject = subject; this.text = text; this.html = html; }
}

describe('mocked production workflow integration', () => {
  it('quietly baselines, deduplicates, retries push failures, and digests only after SES acceptance', async () => {
    const store = new MemoryInternshipStore();
    const baseline = row(1);
    const first = await new Poller([new FixtureAdapter('feed-a', [baseline])], store, () => new Date('2026-07-18T12:00:00.000Z')).poll();
    expect(first).toMatchObject({ baselineSources: ['feed-a'], newJobs: [] });
    expect(await store.pendingSms()).toEqual([]);

    // The duplicated URL comes from a newly added source; it must not create another canonical job or alert.
    const duplicate = { ...baseline, sourceId: 'feed-b', applyUrl: 'https://JOBS.ashbyhq.com/fixture/00000000-0000-0000-0000-000000000001/application?utm_source=second#apply' };
    const fresh = Array.from({ length: 7 }, (_, index) => row(index + 2));
    const second = await new Poller([new FixtureAdapter('feed-a', [baseline, ...fresh]), new FixtureAdapter('feed-b', [duplicate])], store, () => new Date('2026-07-18T12:05:00.000Z')).poll();
    expect(second.newJobs).toHaveLength(7);
    expect(store.jobs.size).toBe(8);
    expect([...store.jobs.values()].find((job) => job.company === 'OpenAI')?.sourceReferences).toHaveLength(2);

    const sms = new RecorderSms();
    const firstSms = await sendPendingNotifications(store, sms, undefined, () => new Date('2026-07-18T12:05:01.000Z'));
    expect(firstSms).toEqual({ sent: 6, failed: 1 });
    expect(await store.pendingSms()).toHaveLength(1);
    expect(sms.messages.map((message) => message.body).join('\n')).toContain('https://jobs.ashbyhq.com/fixture/00000000-0000-0000-0000-000000000008');
    expect(sms.messages.map((message) => message.body).join('\n')).not.toContain('utm_source');

    const retry = new RecorderSms();
    expect(await sendPendingNotifications(store, retry)).toEqual({ sent: 1, failed: 0 });
    expect(await store.pendingSms()).toEqual([]);

    const email = new RecorderEmail();
    expect(await sendDigest(store, email, () => new Date('2026-07-18T17:00:00.000Z'))).toBe(7);
    expect(email).toMatchObject({ calls: 1, subject: 'Internship digest: 7 new roles' });
    expect(email.html).toContain('https://jobs.ashbyhq.com/fixture/00000000-0000-0000-0000-000000000002');
    expect(email.text).not.toContain('utm_source');
    expect(email.html).not.toContain('utm_source');
    expect(await store.pendingDigest()).toEqual([]);
    expect(await sendDigest(store, email)).toBe(0);
    expect(email.calls).toBe(1);
  });

  it('builds ntfy and SES delivery requests without making network calls', async () => {
    const sesSend = vi.spyOn(SESv2Client.prototype, 'send').mockResolvedValue({ $metadata: {} } as never);
    const ntfyCalls: Array<{ url: string; init?: RequestInit }> = [];
    await new NtfyPublisher('private-topic', 'https://ntfy.example.test', async (url, init) => { ntfyCalls.push({ url: String(url), init }); return new Response('', { status: 200 }); }).publish({ title: 'Role — Company', body: 'Synthetic push smoke test', click: 'https://jobs.example.com/1', tags: ['computer'] });
    await new SesEmailSender('sender@example.com', 'recipient@example.com').send('Synthetic email smoke test', 'plain', '<p>html</p>');
    const sesCommand = sesSend.mock.calls[0][0];
    expect(ntfyCalls[0]).toMatchObject({ url: 'https://ntfy.example.test', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'private-topic', title: 'Role — Company', message: 'Synthetic push smoke test', priority: 4, tags: ['computer'], click: 'https://jobs.example.com/1' }) } });
    expect(sesCommand).toBeInstanceOf(SendEmailCommand);
    expect((sesCommand as SendEmailCommand).input).toMatchObject({ FromEmailAddress: 'sender@example.com', Destination: { ToAddresses: ['recipient@example.com'] }, Content: { Simple: { Subject: { Data: 'Synthetic email smoke test' }, Body: { Text: { Data: 'plain' }, Html: { Data: '<p>html</p>' } } } } });
    sesSend.mockRestore();
  });

  it('records an oversized Greenhouse board as a retryable resource-limit failure', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => new Response('{"jobs":[]}', {
        headers: { 'content-length': String(GREENHOUSE_RESPONSE_MAX_BYTES + 1) },
      }),
    });

    const result = await new Poller([adapter], store, () => new Date('2026-09-14T19:00:00.000Z')).poll();
    const health = await store.getSourceHealth(acmeSource.id);

    expect(result.failures).toEqual([expect.stringContaining('response body exceeds')]);
    expect(health).toMatchObject({
      sourceId: acmeSource.id,
      outcome: 'resource_limit',
      failureCategory: 'capacity',
      diagnosticCategory: 'capacity',
    });
    expect(health?.backoffUntil).toBeDefined();
  });

  it('keeps a Greenhouse source degraded when the board body is cut off mid-transfer', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jobs":['));
          controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        },
      })),
    });

    const result = await new Poller([adapter], store, () => new Date('2026-09-15T13:30:00.000Z')).poll();
    const health = await store.getSourceHealth(acmeSource.id);

    expect(result.failures).toEqual([expect.stringContaining('The operation was aborted due to timeout')]);
    expect(health).toMatchObject({
      sourceId: acmeSource.id,
      state: 'degraded',
      outcome: 'temporary_provider_error',
      failureCategory: 'transport',
      consecutiveFailures: 1,
    });
    expect(health?.backoffUntil).toBeDefined();
  });

  it('quarantines a Greenhouse source after two consecutive capacity failures', async () => {
    const store = new MemoryInternshipStore();
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => new Response('{"jobs":[]}', {
        headers: { 'content-length': String(GREENHOUSE_RESPONSE_MAX_BYTES + 1) },
      }),
    });

    await new Poller([adapter], store, () => new Date('2026-09-14T19:00:00.000Z')).poll();
    await new Poller([adapter], store, () => new Date('2026-09-14T19:01:00.000Z')).poll();

    await expect(store.getSourceHealth(acmeSource.id)).resolves.toMatchObject({
      consecutiveFailures: 2,
      lastOutcome: 'resource_limit',
      state: 'quarantined',
      sourceStatus: 'paused',
    });
  });
});
