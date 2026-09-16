import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { dispatchLeverBoards, LEVER_POLL_INTERVAL_MS, isLeverSourceDue, leverWorkMessages, type LeverWorkMessage } from '../src/lever-dispatch.js';
import { processLeverQueue, runLeverBoard } from '../src/lever-worker.js';
import { reviewedLeverSources, type ReviewedLeverSource } from '../src/sources/lever-config.js';
import { MemoryInternshipStore } from '../src/store.js';

const scheduledAt = '2026-07-30T12:00:00.000Z';
const shadowSource = reviewedLeverSources.find((source) => source.status === 'shadow')!;
const message = (sourceId = shadowSource.id): LeverWorkMessage => ({ version: 1, sourceId, scheduledAt });
const firstPostingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondPostingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const posting = {
  id: firstPostingId,
  text: 'Software Engineering Intern, Summer 2027',
  applyUrl: `https://jobs.lever.co/${shadowSource.site}/${firstPostingId}/apply`,
  hostedUrl: `https://jobs.lever.co/${shadowSource.site}/${firstPostingId}`,
  descriptionPlain: 'Build reliable software.',
  categories: { location: 'Remote', commitment: 'Internship' },
};
const response = (postings = [posting]) => new Response(JSON.stringify(postings), {
  status: 200,
  headers: { 'Content-Type': 'application/json', ETag: '"fixture"' },
});
const catalogAdmissionResolver = {
  async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; },
  async resolveDestinationRule() { return undefined; },
};

describe('Lever queue dispatch', () => {
  it('creates one versioned work item per reviewed board', () => {
    expect(leverWorkMessages([shadowSource], new Date(scheduledAt))).toEqual([message()]);
    expect(leverWorkMessages()).toHaveLength(reviewedLeverSources.length);
    expect(leverWorkMessages().map((item) => item.sourceId)).toEqual(
      reviewedLeverSources.map((source) => source.id),
    );
  });

  it('queues FIFO work with per-board ordering and window deduplication', async () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({
      ...shadowSource,
      id: `lever-board-${index}`,
      site: `board-${index}`,
    }));
    const commands: SendMessageBatchCommand[] = [];
    const result = await dispatchLeverBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/lever.fifo',
      sources,
      now: () => new Date(scheduledAt),
      client: { async send(command) { commands.push(command); return {}; } },
    });

    expect(result).toEqual({ queued: 12 });
    expect(commands).toHaveLength(2);
    expect(commands[0].input.Entries).toHaveLength(10);
    expect(commands[1].input.Entries).toHaveLength(2);
    expect(commands[0].input.Entries?.[0]).toMatchObject({
      MessageGroupId: 'lever-board-0',
      MessageDeduplicationId: expect.stringMatching(/^lever-board-0:\d+$/),
    });
  });

  it('polls shadow boards every three hours on the deployed half-hour schedule', () => {
    const firstScheduledAt = Date.parse('2026-07-30T00:22:00.000Z');
    const lastSuccessAt = new Date(firstScheduledAt + 60_000).toISOString();
    const checkpoint = { sourceId: `shadow-${shadowSource.id}`, successfulFetches: 1, lastRowCount: 0, lastSuccessAt };
    const scheduledRuns = Array.from({ length: 7 }, (_, window) => new Date(firstScheduledAt + window * LEVER_POLL_INTERVAL_MS));
    expect(scheduledRuns.slice(0, 6).every((now) => !isLeverSourceDue(shadowSource, checkpoint, now))).toBe(true);
    expect(isLeverSourceDue(shadowSource, checkpoint, scheduledRuns[6]!)).toBe(true);
    expect(isLeverSourceDue(shadowSource, checkpoint, new Date(firstScheduledAt + 10 * LEVER_POLL_INTERVAL_MS))).toBe(true);
  });

  it('polls published boards every half hour even when they are quiet', () => {
    const published: ReviewedLeverSource = { ...shadowSource, status: 'published' };
    const checkpoint = { sourceId: published.id, successfulFetches: 1, lastRowCount: 0, lastSuccessAt: scheduledAt };
    expect(isLeverSourceDue(published, checkpoint, new Date(Date.parse(scheduledAt) + LEVER_POLL_INTERVAL_MS))).toBe(true);
  });

  it('honors durable pause controls and opens a freshness incident after a stale board resumes', async () => {
    const published: ReviewedLeverSource = { ...shadowSource, status: 'published' };
    const store = new MemoryInternshipStore();
    await store.putCheckpoint({
      sourceId: published.id,
      successfulFetches: 1,
      lastRowCount: 1,
      lastSuccessAt: '2026-07-30T11:00:00.000Z',
    });
    await store.putSourceHealth({
      sourceId: shadowSource.id,
      provider: 'lever',
      region: 'global',
      state: 'healthy',
      sourceStatus: 'paused',
      lastAttemptAt: '2026-07-30T11:00:00.000Z',
      lastSuccessAt: '2026-07-30T11:00:00.000Z',
      consecutiveFailures: 0,
      durationMs: 25,
    });
    const commands: SendMessageBatchCommand[] = [];
    expect(await dispatchLeverBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/lever.fifo',
      sources: [published],
      checkpointReader: store,
      now: () => new Date(scheduledAt),
      client: { async send(command) { commands.push(command); return {}; } },
    })).toEqual({ queued: 0 });
    expect(commands).toHaveLength(0);
    expect((await store.getSourceHealth(shadowSource.id))?.incidentState).toBeUndefined();

    await store.putSourceHealth({
      ...(await store.getSourceHealth(shadowSource.id))!,
      sourceStatus: 'active',
    });
    expect(await dispatchLeverBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/lever.fifo',
      sources: [published],
      checkpointReader: store,
      now: () => new Date('2026-07-30T13:00:00.000Z'),
      client: { async send(command) { commands.push(command); return {}; } },
    })).toEqual({ queued: 1 });
    expect(await store.getSourceHealth(shadowSource.id)).toMatchObject({
      incidentState: 'open',
      incidentSeverity: 'high',
      sourceStatus: 'active',
    });
  });
});

describe('Lever queue worker', () => {
  it('checks a shadow board without publishing jobs and stores an isolated checkpoint', async () => {
    const store = new MemoryInternshipStore();
    const result = await runLeverBoard(message(), {
      store,
      sources: [shadowSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toMatchObject({ sourceId: shadowSource.id, mode: 'shadow', listings: 1 });
    expect(store.jobs.size).toBe(0);
    expect(await store.getCheckpoint(`shadow-${shadowSource.id}`)).toMatchObject({
      sourceId: `shadow-${shadowSource.id}`,
      successfulFetches: 1,
      lastRowCount: 1,
    });
    expect(await store.getCheckpoint(shadowSource.id)).toBeUndefined();
    expect(await store.getSourceHealth(shadowSource.id)).toMatchObject({
      provider: 'lever',
      region: 'global',
      outcome: 'success_changed',
      rawRows: 1,
      eligibleRows: 1,
      consecutiveFailures: 0,
    });
  });

  it('does not fetch paused work unless it is an explicit operator replay', async () => {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth({
      sourceId: shadowSource.id,
      state: 'healthy',
      sourceStatus: 'paused',
      lastAttemptAt: scheduledAt,
      consecutiveFailures: 0,
      durationMs: 0,
    });
    let fetches = 0;
    const dependencies = {
      store,
      sources: [shadowSource],
      fetchImpl: async () => { fetches += 1; return response(); },
      linkValidator: async (url: string) => url,
    };

    await expect(runLeverBoard(message(), dependencies)).resolves.toMatchObject({ skipped: 'paused' });
    expect(fetches).toBe(0);
    await expect(runLeverBoard({ ...message(), force: true }, dependencies)).resolves.toMatchObject({ listings: 1 });
    expect(fetches).toBe(1);
  });

  it('does not immediately retry a published source when Lever supplies a long Retry-After', async () => {
    const published: ReviewedLeverSource = { ...shadowSource, status: 'published' };
    const store = new MemoryInternshipStore();
    let fetches = 0;

    await expect(runLeverBoard({ ...message(published.id) }, {
      store,
      sources: [published],
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
      },
      linkValidator: async (url: string) => url,
    })).rejects.toThrow('Lever fetch failed (429)');

    expect(fetches).toBe(1);
    expect(await store.getSourceHealth(published.id)).toMatchObject({ outcome: 'rate_limited', backoffUntil: expect.any(String) });
  });

  it('never parks a shadow consumer on a Lever Retry-After beyond the retry cap', async () => {
    const store = new MemoryInternshipStore();
    const slept: number[] = [];

    await expect(runLeverBoard(message(), {
      store,
      sources: [shadowSource],
      fetchImpl: async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
      linkValidator: async (url: string) => url,
      sleep: async (milliseconds: number) => { slept.push(milliseconds); },
    })).rejects.toThrow('Lever fetch failed (429)');

    expect(slept).toEqual([]);
  });

  it('treats a hash-identical response as healthy without erasing the last trusted counts', async () => {
    const store = new MemoryInternshipStore();
    const dependencies = {
      store,
      sources: [shadowSource],
      fetchImpl: async () => response(),
      linkValidator: async (url: string) => url,
    };
    await runLeverBoard(message(), dependencies);
    await runLeverBoard(message(), dependencies);

    expect(await store.getSourceHealth(shadowSource.id)).toMatchObject({
      outcome: 'success_unchanged_hash',
      rawRows: 1,
      eligibleRows: 1,
      pollTier: 'active',
      consecutiveFailures: 0,
    });
  });

  it('quietly baselines a published board and makes only later roles notification-eligible', async () => {
    const published: ReviewedLeverSource = { ...shadowSource, status: 'published' };
    const store = new MemoryInternshipStore();
    let current = [posting];
    const dependencies = {
      store,
      sources: [published],
      fetchImpl: async () => response(current),
      linkValidator: async (url: string) => url,
      catalogAdmissionResolver,
    };
    await runLeverBoard(message(), dependencies);
    expect(await store.pendingSms()).toEqual([]);

    current = [
      posting,
      {
        ...posting,
        id: secondPostingId,
        text: 'Machine Learning Engineering Intern, Summer 2027',
        hostedUrl: `https://jobs.lever.co/${shadowSource.site}/${secondPostingId}`,
        applyUrl: `https://jobs.lever.co/${shadowSource.site}/${secondPostingId}/apply`,
      },
    ];
    const result = await runLeverBoard(message(), dependencies);

    expect(result).toMatchObject({ mode: 'published', listings: 2 });
    expect(await store.pendingSms()).toHaveLength(1);
  });

  it('returns only failed SQS records and blocks later work in the same FIFO group', async () => {
    const result = await processLeverQueue({
      Records: [
        { messageId: 'bad', body: JSON.stringify(message('lever-unknown')), attributes: { MessageGroupId: 'same-board' } },
        { messageId: 'blocked', body: JSON.stringify(message()), attributes: { MessageGroupId: 'same-board' } },
      ],
    }, {
      store: new MemoryInternshipStore(),
      sources: [shadowSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }, { itemIdentifier: 'blocked' }] });
  });
});
