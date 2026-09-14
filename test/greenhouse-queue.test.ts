import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { dispatchGreenhouseBoards, GREENHOUSE_POLL_INTERVAL_MS, greenhouseWorkMessages, isGreenhouseSourceDue, type GreenhouseWorkMessage } from '../src/greenhouse-dispatch.js';
import { processGreenhouseQueue, runGreenhouseBoard } from '../src/greenhouse-worker.js';
import { MemoryInternshipStore } from '../src/store.js';
import { acmeJobsResponse, acmeSource, technicalInternship } from './fixtures/greenhouse.js';
import { reviewedGreenhouseSources, type ReviewedGreenhouseSource } from '../src/sources/greenhouse-config.js';

const scheduledAt = '2026-07-29T12:00:00.000Z';
const message = (sourceId = acmeSource.id): GreenhouseWorkMessage => ({ version: 1, sourceId, scheduledAt });
const response = (jobs = acmeJobsResponse) => new Response(JSON.stringify(jobs), {
  status: 200,
  headers: { 'Content-Type': 'application/json', ETag: '"fixture"' },
});
const catalogAdmissionResolver = {
  async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; },
  async resolveDestinationRule() { return undefined; },
};

describe('Greenhouse queue dispatch', () => {
  it('creates one versioned work item per reviewed board', () => {
    expect(greenhouseWorkMessages([acmeSource], new Date(scheduledAt))).toEqual([message()]);
    expect(greenhouseWorkMessages()).toHaveLength(reviewedGreenhouseSources.length);
    expect(greenhouseWorkMessages().map((item) => item.sourceId)).toEqual(
      reviewedGreenhouseSources.map((source) => source.id),
    );
  });

  it('queues FIFO work in API-sized batches with per-board ordering and window deduplication', async () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({
      ...acmeSource,
      id: `greenhouse-board-${index}`,
      boardToken: `board-${index}`,
    }));
    const commands: SendMessageBatchCommand[] = [];
    const result = await dispatchGreenhouseBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/greenhouse.fifo',
      sources,
      now: () => new Date(scheduledAt),
      client: { async send(command) { commands.push(command); return {}; } },
    });

    expect(result).toEqual({ queued: 12 });
    expect(commands).toHaveLength(2);
    expect(commands[0].input.Entries).toHaveLength(10);
    expect(commands[1].input.Entries).toHaveLength(2);
    expect(commands[0].input.Entries?.[0]).toMatchObject({
      MessageGroupId: 'greenhouse-board-0',
      MessageDeduplicationId: expect.stringMatching(/^greenhouse-board-0:\d+$/),
    });
  });

  it('fails the dispatch when SQS rejects any board', async () => {
    await expect(dispatchGreenhouseBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/greenhouse.fifo',
      sources: [acmeSource],
      client: { async send() { return { Failed: [{ Id: '0-0', Message: 'throttled' }] }; } },
    })).rejects.toThrow('throttled');
  });

  it('polls shadow boards every three hours on the deployed half-hour schedule', () => {
    const firstScheduledAt = Date.parse('2026-07-29T00:12:00.000Z');
    const lastSuccessAt = new Date(firstScheduledAt + 60_000).toISOString();
    const checkpoint = { sourceId: `shadow-${acmeSource.id}`, successfulFetches: 1, lastRowCount: 0, lastSuccessAt };
    const scheduledRuns = Array.from({ length: 7 }, (_, window) => new Date(firstScheduledAt + window * GREENHOUSE_POLL_INTERVAL_MS));
    expect(scheduledRuns.slice(0, 6).every((now) => !isGreenhouseSourceDue(acmeSource, checkpoint, now))).toBe(true);
    expect(isGreenhouseSourceDue(acmeSource, checkpoint, scheduledRuns[6]!)).toBe(true);
    expect(isGreenhouseSourceDue(acmeSource, checkpoint, new Date(firstScheduledAt + 10 * GREENHOUSE_POLL_INTERVAL_MS))).toBe(true);
  });

  it('polls published boards every half hour even when they are quiet', () => {
    const published: ReviewedGreenhouseSource = { ...acmeSource, status: 'published' };
    const checkpoint = { sourceId: published.id, successfulFetches: 1, lastRowCount: 0, lastSuccessAt: scheduledAt };
    expect(isGreenhouseSourceDue(published, checkpoint, new Date(Date.parse(scheduledAt) + GREENHOUSE_POLL_INTERVAL_MS))).toBe(true);
  });
});

describe('Greenhouse queue worker', () => {
  it('checks a shadow board without publishing jobs and stores an isolated checkpoint', async () => {
    const store = new MemoryInternshipStore();
    const result = await runGreenhouseBoard(message(), {
      store,
      sources: [acmeSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toMatchObject({ sourceId: acmeSource.id, mode: 'shadow', listings: 1 });
    expect(store.jobs.size).toBe(0);
    expect(await store.getCheckpoint(`shadow-${acmeSource.id}`)).toMatchObject({
      sourceId: `shadow-${acmeSource.id}`,
      successfulFetches: 1,
      lastRowCount: 1,
    });
    expect(await store.getCheckpoint(acmeSource.id)).toBeUndefined();
  });

  it('rejects an unacknowledged zero-row shadow snapshot without advancing its checkpoint', async () => {
    const store = new MemoryInternshipStore();
    const dependencies = { store, sources: [acmeSource], linkValidator: async (url: string) => url };
    await runGreenhouseBoard(message(), { ...dependencies, fetchImpl: async () => response() });
    await expect(runGreenhouseBoard(message(), { ...dependencies, fetchImpl: async () => response({ jobs: [], meta: { total: 0 } }) }))
      .rejects.toThrow('suspicious zero-row');
    expect(await store.getCheckpoint(`shadow-${acmeSource.id}`)).toMatchObject({ lastRowCount: 1 });
  });

  it('accepts an owner-acknowledged empty board and advances its checkpoint', async () => {
    const acknowledged: ReviewedGreenhouseSource = {
      ...acmeSource,
      emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-09-11T00:00:00.000Z', reason: 'seasonally empty' },
    };
    const store = new MemoryInternshipStore();
    const dependencies = { store, sources: [acknowledged], linkValidator: async (url: string) => url };
    await runGreenhouseBoard(message(), { ...dependencies, fetchImpl: async () => response() });
    await expect(runGreenhouseBoard(message(), { ...dependencies, fetchImpl: async () => response({ jobs: [], meta: { total: 0 } }) }))
      .resolves.toMatchObject({ listings: 0 });
    expect(await store.getCheckpoint(`shadow-${acmeSource.id}`)).toMatchObject({ lastRowCount: 0 });
  });

  it('does not fetch paused work unless it is an explicit operator replay', async () => {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth({
      sourceId: acmeSource.id,
      state: 'healthy',
      sourceStatus: 'paused',
      lastAttemptAt: scheduledAt,
      consecutiveFailures: 0,
      durationMs: 0,
    });
    let fetches = 0;
    const dependencies = {
      store,
      sources: [acmeSource],
      fetchImpl: async () => { fetches += 1; return response(); },
      linkValidator: async (url: string) => url,
    };

    await expect(runGreenhouseBoard(message(), dependencies)).resolves.toMatchObject({ skipped: 'paused' });
    expect(fetches).toBe(0);
    await expect(runGreenhouseBoard({ ...message(), force: true }, dependencies)).resolves.toMatchObject({ listings: 1 });
    expect(fetches).toBeGreaterThan(0);
  });

  it('quietly baselines a published board and makes only later roles notification-eligible', async () => {
    const published: ReviewedGreenhouseSource = { ...acmeSource, status: 'published' };
    const store = new MemoryInternshipStore();
    let current = acmeJobsResponse;
    const dependencies = {
      store,
      sources: [published],
      fetchImpl: async () => response(current),
      linkValidator: async (url: string) => url,
      catalogAdmissionResolver,
    };
    await runGreenhouseBoard(message(), dependencies);
    expect(await store.pendingSms()).toEqual([]);

    current = {
      jobs: [
        ...(acmeJobsResponse.jobs ?? []),
        {
          ...technicalInternship,
          id: 6001,
          internal_job_id: 9601,
          title: 'Machine Learning Engineering Intern, Summer 2027',
          absolute_url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/6001',
        },
      ],
    };
    const result = await runGreenhouseBoard(message(), dependencies);

    expect(result).toMatchObject({ mode: 'published', listings: 2 });
    expect(await store.pendingSms()).toHaveLength(1);
  });

  it('keeps the poller\'s rich health artifact for published boards', async () => {
    const published: ReviewedGreenhouseSource = { ...acmeSource, status: 'published' };
    const store = new MemoryInternshipStore();
    const dependencies = {
      store,
      sources: [published],
      fetchImpl: async () => response(),
      linkValidator: async (url: string) => url,
      catalogAdmissionResolver,
    };
    const records = [{ messageId: 'first', body: JSON.stringify(message()) }];
    expect(await processGreenhouseQueue({ Records: records }, dependencies)).toEqual({ batchItemFailures: [] });

    const health = await store.getSourceHealth(acmeSource.id);
    expect(health).toMatchObject({ state: 'healthy', provider: 'greenhouse', region: 'unknown', outcome: 'success_changed' });
    expect(health?.contentHash).toBeTruthy();
    expect(health?.counts).toBeDefined();
    expect(health?.recentRuns).toHaveLength(1);

    expect(await processGreenhouseQueue({ Records: records }, dependencies)).toEqual({ batchItemFailures: [] });
    const after = await store.getSourceHealth(acmeSource.id);
    expect(after?.outcome).toBe('success_unchanged_hash');
    expect(after?.recentRuns?.[0]).toMatchObject({ outcome: 'success_unchanged_hash', state: 'succeeded' });
    expect(after?.recentRuns).toHaveLength(2);
  });

  it('returns only failed SQS record IDs for bounded retry', async () => {
    const store = new MemoryInternshipStore();
    const result = await processGreenhouseQueue({
      Records: [
        { messageId: 'good', body: JSON.stringify(message()) },
        { messageId: 'bad', body: JSON.stringify(message('greenhouse-unknown')) },
      ],
    }, {
      store,
      sources: [acmeSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
    expect(await store.getSourceHealth(acmeSource.id)).toMatchObject({
      state: 'healthy', provider: 'greenhouse', region: 'unknown',
    });
    expect(await store.getSourceHealth('greenhouse-unknown')).toMatchObject({
      state: 'degraded', provider: 'greenhouse', region: 'unknown',
    });
  });

  it('reports each dead-letter-bound poll failure to onRecordFailure with its cause', async () => {
    const failures: Array<{ messageId: string; message: string }> = [];
    const result = await processGreenhouseQueue({
      Records: [
        { messageId: 'good', body: JSON.stringify(message()) },
        { messageId: 'bad', body: JSON.stringify(message('greenhouse-unknown')) },
      ],
    }, {
      store: new MemoryInternshipStore(),
      sources: [acmeSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
      onRecordFailure: (record, error) => {
        failures.push({ messageId: record.messageId, message: error instanceof Error ? error.message : String(error) });
      },
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.messageId).toBe('bad');
    expect(failures[0]?.message).toContain('greenhouse-unknown');
  });

  it('does not process later FIFO records from a board whose earlier record failed', async () => {
    const result = await processGreenhouseQueue({
      Records: [
        { messageId: 'bad', body: JSON.stringify(message('greenhouse-unknown')), attributes: { MessageGroupId: 'same-board' } },
        { messageId: 'blocked', body: JSON.stringify(message()), attributes: { MessageGroupId: 'same-board' } },
      ],
    }, {
      store: new MemoryInternshipStore(),
      sources: [acmeSource],
      fetchImpl: async () => response(),
      linkValidator: async (url) => url,
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }, { itemIdentifier: 'blocked' }] });
  });
});
