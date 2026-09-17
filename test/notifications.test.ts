import { describe, expect, it } from 'vitest';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import { compactRoleTitle, deliverDeferredExpoNotifications, drainPendingExpoNotifications, ExpoPushPublisher, MAX_LEGACY_PUSH_JOBS_PER_RUN, nextPushDeliveryAt, notificationDedupeKey, notificationSourceLabel, NtfyPublisher, renderPushTemplate, sendDigest, sendNewJobNotifications, sendPendingNotifications, summaryChunks, type PushMessage } from '../src/notifications.js';
import type { Internship } from '../src/types.js';

function job(index: number, company = 'Unknown'): Internship { return { jobId: `j${index}`, company, title: `Role ${index}`, location: 'NYC', season: 'summer-2027', applyUrl: `https://apply.example.com/${index}`, normalizedUrl: `https://apply.example.com/${index}`, fingerprint: String(index), compensation: { raw: '$50/hr', maxHourlyUSD: 50 }, sourceReferences: [{ sourceId: 'x', document: 'README', sourceUrl: 'x', row: index, company, title: `Role ${index}`, location: 'NYC', season: 'summer-2027', applyUrl: `https://apply.example.com/${index}`, compensation: { raw: '' }, state: 'open' }], open: true, firstSeenAt: `2026-01-0${index}T00:00:00Z`, lastSeenAt: '2026-01-01T00:00:00Z', notification: { smsPending: true, digestPending: true } }; }
function withSource(listing: Internship, sourceId: string, state: 'open' | 'closed' = 'open'): Internship {
  return { ...listing, sourceReferences: [...listing.sourceReferences, { ...listing.sourceReferences[0]!, sourceId, state }] };
}
describe('notifications', () => {
  it('sends five individual jobs and preserves links in summary chunks', async () => {
    const store = new MemoryInternshipStore();
    for (let index = 1; index <= 7; index += 1) {
      const listing = job(index, index === 1 ? 'OpenAI' : 'Unknown');
      await store.putInternship(index === 2 ? withSource(listing, 'lever-palantir') : listing);
    }
    const messages: PushMessage[] = []; await sendPendingNotifications(store, { publish: async (message) => { messages.push(message); } });
    expect(messages).toHaveLength(6); expect(messages[0]).toMatchObject({ title: 'Role 1 — OpenAI', body: 'NYC · summer-2027 · $50/hr\nFound by Ntern: Jan 1, 2026\nSource: Job board\nhttps://apply.example.com/1', click: 'https://apply.example.com/1' }); expect(messages[5]?.body).toContain('Source: Lever'); expect(messages.map((message) => message.body).join('\n')).toContain('https://apply.example.com/7'); expect(await store.pendingSms()).toHaveLength(0);
  });
  it('appends the identity-unconfirmed disclosure to legacy push copy', async () => {
    const store = new MemoryInternshipStore();
    await store.putInternship({ ...job(1), postingIdentityStatus: 'unconfirmed' });
    const messages: PushMessage[] = [];
    await sendPendingNotifications(store, { publish: async (message) => { messages.push(message); } });
    expect(messages[0]?.body).toMatch(/Identity unconfirmed$/u);
  });
  it('does not mark a failed SMS and does not send empty digests', async () => {
    const store = new MemoryInternshipStore(); await store.putInternship(job(1));
    await sendPendingNotifications(store, { publish: async () => { throw new Error('nope'); } }); expect(await store.pendingSms()).toHaveLength(1);
    const empty = new MemoryInternshipStore(); expect(await sendDigest(empty, { send: async () => { throw new Error('should not happen'); } })).toBe(0);
  });
  it('leaves excess legacy notifications pending for later bounded runs', async () => {
    const store = new MemoryInternshipStore();
    for (let index = 1; index <= MAX_LEGACY_PUSH_JOBS_PER_RUN + 2; index += 1) await store.putInternship(job(index));
    await sendPendingNotifications(store, { publish: async () => undefined });
    expect(await store.pendingSms()).toHaveLength(2);
  });
  it('drains legacy markers through the idempotent Expo receipt pipeline in bounded runs', async () => {
    const store = new MemoryInternshipStore(); const users = new MemoryUserStore(); let sends = 0;
    for (let index = 1; index <= MAX_LEGACY_PUSH_JOBS_PER_RUN + 2; index += 1) await store.putInternship(job(index));
    await users.putPreferences({ userId: 'user-1', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-08-25T00:00:00.000Z' });
    await users.putDevice({ userId: 'user-1', token: 'ExponentPushToken[test]', platform: 'ios', active: true, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' });
    const publisher = new ExpoPushPublisher('https://push.example.test', async (url) => {
      if (String(url).includes('getReceipts')) {
        return new Response(JSON.stringify({ data: Object.fromEntries(Array.from({ length: sends }, (_, index) => [`ticket-${index + 1}`, { status: 'ok' }])) }), { status: 200 });
      }
      sends += 1;
      return new Response(JSON.stringify({ data: { id: `ticket-${sends}`, status: 'ok' } }), { status: 200 });
    });
    const result = await drainPendingExpoNotifications(store, users, publisher, () => new Date('2026-08-25T12:00:00.000Z'));
    expect(result).toMatchObject({ processed: MAX_LEGACY_PUSH_JOBS_PER_RUN, delivery: { sent: MAX_LEGACY_PUSH_JOBS_PER_RUN, failed: 0 }, receipts: { ok: MAX_LEGACY_PUSH_JOBS_PER_RUN }, retries: { sent: 0, failed: 0 } });
    expect(await store.pendingSms()).toHaveLength(2);
    expect(sends).toBe(MAX_LEGACY_PUSH_JOBS_PER_RUN);
  });
  it('defers legacy markers while no opted-in device can receive them', async () => {
    const store = new MemoryInternshipStore(); const users = new MemoryUserStore();
    for (let index = 1; index <= 2; index += 1) await store.putInternship(job(index));

    const empty = await drainPendingExpoNotifications(store, users, new ExpoPushPublisher('https://push.example.test'));
    expect(empty).toMatchObject({ processed: 0, deferred: 2, delivery: { sent: 0 } });
    expect(await store.pendingSms()).toHaveLength(2);

    await users.putDevice({ userId: 'user-1', token: 'ExponentPushToken[test]', platform: 'ios', active: true, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' });
    const onboardingRace = await drainPendingExpoNotifications(store, users, new ExpoPushPublisher('https://push.example.test'));
    expect(onboardingRace).toMatchObject({ processed: 0, deferred: 2, delivery: { sent: 0 } });
    expect(await store.pendingSms()).toHaveLength(2);
  });
  it('persists daily and quiet-hours delivery until the selected local time', async () => {
    expect(nextPushDeliveryAt(new Date('2026-01-15T18:00:00.000Z'), {
      delivery: 'daily-digest', timezone: 'America/Los_Angeles', applicationReminders: true, followUpDays: 7,
    })).toBe('2026-01-16T17:00:00.000Z');
    expect(nextPushDeliveryAt(new Date('2026-03-08T15:00:00.000Z'), {
      delivery: 'daily-digest', timezone: 'America/Los_Angeles', applicationReminders: true, followUpDays: 7,
    })).toBe('2026-03-08T16:00:00.000Z');
    expect(nextPushDeliveryAt(new Date('2026-08-25T01:30:00.000Z'), {
      delivery: 'daily-digest', timezone: 'Asia/Tokyo', applicationReminders: true, followUpDays: 7,
    })).toBe('2026-08-26T00:00:00.000Z');
    expect(nextPushDeliveryAt(new Date('2026-08-25T03:00:00.000Z'), {
      delivery: 'immediate', applicationReminders: true, followUpDays: 7,
      quietHours: { start: '22:00', end: '08:00', timezone: 'UTC' },
    })).toBe('2026-08-25T08:00:00.000Z');

    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore(); const listing = job(1);
    await jobs.putInternship(listing);
    await users.putPreferences({ userId: 'user-1', filter: {}, alertsEnabled: true, onboardingComplete: true, updatedAt: '2026-08-25T00:00:00.000Z', alertSettings: { delivery: 'daily-digest', timezone: 'UTC', applicationReminders: true, followUpDays: 7, quietHours: { start: '22:00', end: '08:00', timezone: 'UTC' } } });
    await users.putDevice({ userId: 'user-1', token: 'ExponentPushToken[test]', platform: 'ios', active: true, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' });
    let sends = 0;
    const publisher = new ExpoPushPublisher('https://push.example.test', async () => { sends += 1; return new Response(JSON.stringify({ data: { id: 'ticket-1', status: 'ok' } }), { status: 200 }); });
    const createdAt = new Date('2026-08-25T10:00:00.000Z');
    expect(await sendNewJobNotifications([listing], users, publisher, () => createdAt)).toEqual({ sent: 0, skipped: 1, failed: 0 });
    const receipt = await users.getReceipt('user-1', notificationDedupeKey(listing), 'ExponentPushToken[test]');
    expect(receipt).toMatchObject({ status: 'deferred', deliveryState: 'deferred', deliverAfter: '2026-08-26T09:00:00.000Z' });
    expect(await deliverDeferredExpoNotifications(jobs, users, publisher, () => new Date(receipt!.deliverAfter!))).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sends).toBe(1);
  });
  it('only marks a digest after SES accepts it', async () => {
    const store = new MemoryInternshipStore(); await store.putInternship(job(1));
    await expect(sendDigest(store, { send: async () => { throw new Error('SES unavailable'); } })).rejects.toThrow('SES unavailable');
    expect(await store.pendingDigest()).toHaveLength(1);
  });
  it('splits compact summaries before their approximate limit', () => expect(summaryChunks(Array.from({ length: 20 }, (_, index) => job(index)), 200).every((chunk) => chunk.length >= 1)).toBe(true));
  it('supports safe user-selected title and description fields', async () => {
    const listing = { ...job(1, 'OpenAI'), title: 'Software\nIntern' };
    expect(renderPushTemplate('{company}: {title}', listing)).toBe('OpenAI: Software Intern');
    expect(renderPushTemplate('{season} | {compensation} | {url}', listing)).toBe('summer-2027 | $50/hr | https://apply.example.com/1');
    expect(compactRoleTitle('Software Engineering Intern')).toBe('SWE');
    expect(compactRoleTitle('Machine Learning Internship')).toBe('ML');
    expect(compactRoleTitle('Cloud Infrastructure Software Engineering Intern')).toBe('SWE');
    expect(compactRoleTitle('Software Engineering Intern', { 'software engineering': 'Dev' })).toBe('Dev');
    expect(renderPushTemplate('{focus}{postedDetail}', { ...listing, title: 'Machine Learning Intern', sourceReferences: [{ ...listing.sourceReferences[0], sourceId: 'ashby-acme', postedAt: '2026-07-19', providerTimestamp: { value: '2026-07-19', semantics: 'published' } }] })).toBe('Focus: AI/ML · Employer posted: Jul 19, 2026');
    expect(renderPushTemplate('{focus}{postedDetail}', { ...listing, title: 'Machine Learning Intern', sourceReferences: [{ ...listing.sourceReferences[0], postedAt: '2026-07-19', providerTimestamp: { value: '2026-07-19', semantics: 'published' } }] })).toBe('Focus: AI/ML · Source reported: Jul 19, 2026');
    expect(renderPushTemplate('{focus}{postedDetail}', { ...listing, title: 'Machine Learning Intern', sourceReferences: [{ ...listing.sourceReferences[0], postedAt: '21m', providerTimestamp: { value: '21m', semantics: 'published' } }] })).toBe('Focus: AI/ML · Found by Ntern: Jan 1, 2026');
    expect(notificationSourceLabel(withSource(listing, 'greenhouse-vardaspace'))).toBe('Greenhouse');
    expect(notificationSourceLabel(withSource(listing, 'lever-palantir'))).toBe('Lever');
    expect(notificationSourceLabel(withSource(listing, 'ashby-etched'))).toBe('Ashby');
    expect(notificationSourceLabel(withSource(listing, 'lever-acds'))).toBe('Job board');
    expect(notificationSourceLabel(withSource(listing, 'greenhouse-unreviewed'))).toBe('Job board');
    expect(notificationSourceLabel(withSource(listing, 'greenhouse-vardaspace', 'closed'))).toBe('Greenhouse');
    expect(notificationSourceLabel(withSource(withSource(listing, 'greenhouse-vardaspace'), 'greenhouse-figma'))).toBe('Greenhouse');
    expect(notificationSourceLabel(withSource(withSource(listing, 'greenhouse-vardaspace'), 'lever-palantir'))).toBe('Official careers site');
    expect(notificationSourceLabel(listing)).toBe('Job board');
    expect(renderPushTemplate('Source: {source}', withSource(listing, 'greenhouse-vardaspace'))).toBe('Source: Greenhouse');
    const store = new MemoryInternshipStore(); await store.putInternship({ ...listing, title: 'Software Engineering Intern', notification: { smsPending: true, digestPending: false } });
    const pushes: PushMessage[] = []; await sendPendingNotifications(store, { publish: async (message) => { pushes.push(message); } }); expect(pushes[0]?.tags).toEqual(['computer']);
  });
  it('publishes a high-priority push message and rejects non-success responses', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await new NtfyPublisher('private topic', 'https://push.example.test', async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 200 }); }).publish({ title: 'Role — Company', body: 'Remote\nhttps://apply.example.com', click: 'https://apply.example.com', tags: ['computer'] });
    expect(calls[0]).toMatchObject({ url: 'https://push.example.test', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'private topic', title: 'Role — Company', message: 'Remote\nhttps://apply.example.com', priority: 4, tags: ['computer'], click: 'https://apply.example.com' }), signal: expect.any(AbortSignal) } });
    await expect(new NtfyPublisher('topic', 'https://push.example.test', async () => new Response('', { status: 503 })).publish({ title: 'Test', body: 'hello' })).rejects.toThrow('HTTP 503');
  });
  it('uses a user-selected compact template over Expo while preserving the legacy defaults', async () => {
    const users = new MemoryUserStore(); const calls: RequestInit[] = []; const internship = withSource(job(1, 'OpenAI'), 'greenhouse-vardaspace');
    await users.putPreferences({ userId: 'user-1', filter: {}, alertsEnabled: true, onboardingComplete: true, push: { titleTemplate: '{company}: {title}', descriptionTemplate: '{season} | {source} | {url}' }, updatedAt: '2026-07-19T00:00:00Z' });
    await users.putDevice({ userId: 'user-1', token: 'ExponentPushToken[test]', platform: 'ios', active: true, createdAt: '2026-07-19T00:00:00Z', updatedAt: '2026-07-19T00:00:00Z' });
    const publisher = new ExpoPushPublisher('https://push.example.test', async (_url, init) => { calls.push(init ?? {}); return new Response(JSON.stringify({ data: { id: 'ticket-1', status: 'ok' } }), { status: 200 }); });
    await sendNewJobNotifications([internship], users, publisher);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      title: 'OpenAI: Role 1',
      body: 'summer-2027 | Greenhouse | https://apply.example.com/1',
      data: {
        destination: 'job',
        jobId: 'j1',
        url: 'internnotifs://jobs/j1',
        matchedFilters: { reasons: [{ kind: 'default-all-technical', label: 'All technical roles' }], exclusionsApplied: false },
      },
    });
  });
});
