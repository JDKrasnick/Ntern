import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { ashbyWorkMessages, ASHBY_POLL_INTERVAL_MS, dispatchAshbyBoards, isAshbySourceDue, type AshbyWorkMessage } from '../src/ashby-dispatch.js';
import { ashbySourceRunFailure, processAshbyQueue, runAshbyBoard } from '../src/ashby-worker.js';
import { reviewedAshbySources, type ReviewedAshbySource } from '../src/sources/ashby-config.js';
import { MemoryInternshipStore } from '../src/store.js';

const scheduledAt = '2026-08-09T12:00:00.000Z';
const shadowSource: ReviewedAshbySource = {
  ...reviewedAshbySources[0]!, status: 'shadow', promotionEvidence: undefined,
};
const message = (sourceId = shadowSource.id): AshbyWorkMessage => ({ version: 1, sourceId, scheduledAt });
const posting = {
  id: '123e4567-e89b-42d3-a456-426614174000', title: 'Software Engineering Intern', location: 'New York, NY',
  isListed: true, employmentType: 'Intern', jobUrl: `https://jobs.ashbyhq.com/${shadowSource.identity.boardKey}/123e4567-e89b-42d3-a456-426614174000`,
  applyUrl: `https://jobs.ashbyhq.com/${shadowSource.identity.boardKey}/123e4567-e89b-42d3-a456-426614174000/application`,
};
const response = (jobs = [posting]) => new Response(JSON.stringify({ apiVersion: '1', jobs }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
const catalogAdmissionResolver = {
  async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; },
  async resolveDestinationRule() { return undefined; },
};

describe('Ashby queue dispatch', () => {
  it('creates versioned FIFO work and batches boards', async () => {
    expect(ashbyWorkMessages([shadowSource], new Date(scheduledAt))).toEqual([message()]);
    const sources = Array.from({ length: 12 }, (_, index) => ({ ...shadowSource, id: `ashby-board-${index}` }));
    const commands: SendMessageBatchCommand[] = [];
    await expect(dispatchAshbyBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/ashby.fifo', sources,
      now: () => new Date(scheduledAt), client: { async send(command) { commands.push(command); return {}; } },
    })).resolves.toEqual({ queued: 12 });
    expect(commands.map((command) => command.input.Entries?.length)).toEqual([10, 2]);
    expect(commands[0]!.input.Entries?.[0]).toMatchObject({
      MessageGroupId: 'ashby-board-0', MessageDeduplicationId: expect.stringMatching(/^ashby-board-0:\d+$/),
    });
  });

  it('polls shadow boards every three hours on the deployed half-hour schedule', () => {
    const firstScheduledAt = Date.parse('2026-08-09T00:32:00.000Z');
    const lastSuccessAt = new Date(firstScheduledAt + 60_000).toISOString();
    const checkpoint = { sourceId: `shadow-${shadowSource.id}`, successfulFetches: 1, lastRowCount: 0, lastSuccessAt };
    const scheduledRuns = Array.from({ length: 7 }, (_, window) => new Date(firstScheduledAt + window * ASHBY_POLL_INTERVAL_MS));
    expect(scheduledRuns.slice(0, 6).every((now) => !isAshbySourceDue(shadowSource, checkpoint, now))).toBe(true);
    expect(isAshbySourceDue(shadowSource, checkpoint, scheduledRuns[6]!)).toBe(true);
    expect(isAshbySourceDue(shadowSource, checkpoint, new Date(firstScheduledAt + 10 * ASHBY_POLL_INTERVAL_MS))).toBe(true);
  });

  it('polls published boards every half hour even when they are quiet', () => {
    const published: ReviewedAshbySource = { ...shadowSource, status: 'published' };
    const checkpoint = { sourceId: published.id, successfulFetches: 1, lastRowCount: 0, lastSuccessAt: scheduledAt };
    expect(isAshbySourceDue(published, checkpoint, new Date(Date.parse(scheduledAt) + ASHBY_POLL_INTERVAL_MS))).toBe(true);
  });
});

describe('Ashby queue worker', () => {
  it('maps detailed failures to the low-cardinality operations contract', () => {
    expect(['transport', 'http', 'rate_limit'].map(ashbySourceRunFailure)).toEqual(['fetch', 'fetch', 'fetch']);
    expect(['json', 'identity', 'link', 'empty', 'quality', 'persistence'].map(ashbySourceRunFailure))
      .toEqual(['schema', 'identity', 'link', 'empty', 'quality', 'persistence']);
  });
  it('isolates shadow checkpoints and performs no catalog writes', async () => {
    const store = new MemoryInternshipStore();
    await expect(runAshbyBoard(message(), {
      store, sources: [shadowSource], fetchImpl: async () => response(), linkValidator: async (url) => url,
    })).resolves.toMatchObject({ sourceId: shadowSource.id, mode: 'shadow', listings: 1 });
    expect(store.jobs.size).toBe(0);
    expect(await store.getCheckpoint(`shadow-${shadowSource.id}`)).toMatchObject({ lastRawCount: 1, lastRowCount: 1 });
    expect(await store.getCheckpoint(shadowSource.id)).toBeUndefined();
    expect(await store.getSourceHealth(shadowSource.id)).toMatchObject({
      provider: 'ashby', region: 'global', consecutiveFailures: 0,
      applicationLinksChecked: 1, applicationLinkFailures: 0,
    });
  });

  it('retains tolerated shadow link failures for per-board verification', async () => {
    const store = new MemoryInternshipStore();
    const jobs = Array.from({ length: 5 }, (_, index) => {
      const id = `${index + 1}23e4567-e89b-42d3-a456-42661417400${index}`;
      return {
        ...posting, id,
        jobUrl: `https://jobs.ashbyhq.com/${shadowSource.identity.boardKey}/${id}`,
        applyUrl: `https://jobs.ashbyhq.com/${shadowSource.identity.boardKey}/${id}/application`,
      };
    });
    await runAshbyBoard(message(), {
      store, sources: [shadowSource], fetchImpl: async () => response(jobs),
      linkValidator: async (url) => {
        if (url.includes(jobs[0]!.id)) throw new Error('temporary link failure');
        return url;
      },
    });
    expect(await store.getSourceHealth(shadowSource.id)).toMatchObject({
      applicationLinksChecked: 5,
      applicationLinkFailures: 1,
    });
  });

  it('backfills link evidence for an unchanged pre-observability snapshot', async () => {
    const store = new MemoryInternshipStore();
    await runAshbyBoard(message(), {
      store, sources: [shadowSource], fetchImpl: async () => response(), linkValidator: async (url) => url,
    });
    const previous = (await store.getSourceHealth(shadowSource.id))!;
    const legacyHealth = { ...previous };
    delete legacyHealth.applicationLinksChecked;
    delete legacyHealth.applicationLinkFailures;
    await store.putSourceHealth(legacyHealth);
    let validations = 0;

    await expect(runAshbyBoard(message(), {
      store, sources: [shadowSource], fetchImpl: async () => response(),
      linkValidator: async (url) => { validations += 1; return url; },
    })).resolves.toMatchObject({ notModified: true });
    expect(validations).toBe(1);
    expect(await store.getSourceHealth(shadowSource.id)).toMatchObject({
      applicationLinksChecked: 1, applicationLinkFailures: 0,
    });
  });

  it('rejects a shadow snapshot when link failures exceed the threshold', async () => {
    const store = new MemoryInternshipStore();
    await expect(runAshbyBoard(message(), {
      store, sources: [shadowSource], fetchImpl: async () => response(),
      linkValidator: async () => { throw new Error('link unavailable'); },
    })).rejects.toThrow('1/1 eligible Ashby application links failed');
    expect(await store.getSourceHealth(shadowSource.id)).toMatchObject({
      failureCategory: 'link',
      consecutiveFailures: 1,
    });
  });

  it('rejects a suspicious raw-zero without advancing its checkpoint', async () => {
    const store = new MemoryInternshipStore();
    const dependencies = { store, sources: [shadowSource], linkValidator: async (url: string) => url };
    await runAshbyBoard(message(), { ...dependencies, fetchImpl: async () => response() });
    await expect(runAshbyBoard(message(), { ...dependencies, fetchImpl: async () => response([]) }))
      .rejects.toThrow('unexpected raw-zero');
    expect(await store.getCheckpoint(`shadow-${shadowSource.id}`)).toMatchObject({ lastRawCount: 1 });
  });

  it('accepts an owner-acknowledged empty board and advances its checkpoint', async () => {
    const acknowledged: ReviewedAshbySource = {
      ...shadowSource,
      emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-09-11T00:00:00.000Z', reason: 'seasonally empty' },
    };
    const store = new MemoryInternshipStore();
    const dependencies = { store, sources: [acknowledged], linkValidator: async (url: string) => url };
    await runAshbyBoard(message(), { ...dependencies, fetchImpl: async () => response() });
    await expect(runAshbyBoard(message(), { ...dependencies, fetchImpl: async () => response([]) }))
      .resolves.toMatchObject({ listings: 0 });
    expect(await store.getCheckpoint(`shadow-${shadowSource.id}`)).toMatchObject({ lastRawCount: 0 });
  });

  it('quietly baselines published boards and only emits later additions', async () => {
    const published: ReviewedAshbySource = { ...shadowSource, status: 'published' };
    const store = new MemoryInternshipStore();
    let jobs = [posting];
    const dependencies = { store, sources: [published], fetchImpl: async () => response(jobs), linkValidator: async (url: string) => url,
      catalogAdmissionResolver };
    await runAshbyBoard(message(published.id), dependencies);
    expect(await store.pendingSms()).toEqual([]);
    jobs = [...jobs, {
      ...posting, id: '223e4567-e89b-42d3-a456-426614174000', title: 'Machine Learning Intern',
      jobUrl: `https://jobs.ashbyhq.com/${shadowSource.identity.boardKey}/223e4567-e89b-42d3-a456-426614174000`,
      applyUrl: `https://jobs.ashbyhq.com/${shadowSource.identity.boardKey}/223e4567-e89b-42d3-a456-426614174000/application`,
    }];
    await runAshbyBoard(message(published.id), dependencies);
    expect(await store.pendingSms()).toHaveLength(1);
  });

  it('closes the last published role after two complete empty snapshots', async () => {
    const published: ReviewedAshbySource = { ...shadowSource, status: 'published' };
    const store = new MemoryInternshipStore();
    let jobs = [posting];
    const dependencies = { store, sources: [published], fetchImpl: async () => response(jobs), linkValidator: async (url: string) => url };
    await runAshbyBoard(message(published.id), dependencies);
    jobs = [];
    await runAshbyBoard(message(published.id), dependencies);
    expect([...store.jobs.values()][0]).toMatchObject({ open: true });
    await runAshbyBoard(message(published.id), dependencies);
    expect([...store.jobs.values()][0]).toMatchObject({ open: false });
    expect(await store.pendingSms()).toEqual([]);
  });

  it('returns failed records and blocks later work in the same FIFO group', async () => {
    const result = await processAshbyQueue({ Records: [
      { messageId: 'bad', body: JSON.stringify(message('ashby-unknown')), attributes: { MessageGroupId: 'same' } },
      { messageId: 'blocked', body: JSON.stringify(message()), attributes: { MessageGroupId: 'same' } },
    ] }, { store: new MemoryInternshipStore(), sources: [shadowSource] });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }, { itemIdentifier: 'blocked' }]);
  });
});
