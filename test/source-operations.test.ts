import { DescribeAlarmsCommand, type CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { createSourceOperationsHandler } from '../src/greenhouse-operations-api.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import { reviewedLeverSources } from '../src/sources/lever-config.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { Internship } from '../src/types.js';
import { defaultSources } from '../src/sources/index.js';

const secret = 'fixture-secret';
const event = (path: string, method = 'GET', body?: unknown) => ({
  rawPath: path,
  requestContext: { http: { method } },
  headers: { 'x-operations-key': secret, 'x-operations-actor': 'test-operator' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function dependencies(store: MemoryInternshipStore) {
  const commands: unknown[] = [];
  return {
    commands,
    value: {
      store,
      sharedSecret: secret,
      fleets: {
        greenhouse: { queueUrl: 'https://sqs.test/greenhouse.fifo', deadLetterQueueUrl: 'https://sqs.test/greenhouse-dlq.fifo' },
        lever: { queueUrl: 'https://sqs.test/lever.fifo', deadLetterQueueUrl: 'https://sqs.test/lever-dlq.fifo' },
        ashby: { queueUrl: 'https://sqs.test/ashby.fifo', deadLetterQueueUrl: 'https://sqs.test/ashby-dlq.fifo' },
      },
      sqs: {
        async send(command: unknown) {
          commands.push(command);
          if (command instanceof SendMessageCommand) return {};
          if (!(command instanceof GetQueueAttributesCommand)) return {};
          return (command.input.QueueUrl ?? '').includes('-dlq')
            ? { Attributes: { ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0' } }
            : { Attributes: { ApproximateNumberOfMessages: '82', ApproximateNumberOfMessagesNotVisible: '0', oldest_message_timestamp_ms: '1789488135922' } };
        },
      } as unknown as SQSClient,
      cloudwatch: { async send(command: unknown) {
        if (command instanceof DescribeAlarmsCommand && command.input.AlarmNamePrefix === 'InternNotifs-') {
          return { MetricAlarms: [{ AlarmName: 'InternNotifs-PollDuration', StateValue: 'ALARM', AlarmDescription: 'Poll duration is near timeout.' }] };
        }
        return { MetricAlarms: [] };
      } } as unknown as CloudWatchClient,
      now: () => new Date('2026-07-30T20:00:00.000Z'),
    },
  };
}

describe('shared source operations', () => {
  it('reports exact provider-versus-aggregator discovery lag without inventing legacy precision', async () => {
    const store = new MemoryInternshipStore();
    const direct = reviewedGreenhouseSources.find((candidate) => candidate.status === 'published')!;
    const job: Internship = {
      jobId: 'attribution-job', company: 'Acme', title: 'Software Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: 'https://careers.example.test/role', normalizedUrl: 'https://careers.example.test/role', fingerprint: 'acme-role', compensation: { raw: '' },
      open: true, technical: true, firstSeenAt: '2026-07-30T10:00:00.000Z', lastSeenAt: '2026-07-30T10:00:00.000Z', notification: { smsPending: false, digestPending: false },
      sourceReferences: [
        { sourceId: 'community-list', externalId: 'list-1', document: 'README.md', sourceUrl: 'https://github.test/list', row: 1, company: 'Acme', title: 'Software Intern', location: 'Remote', season: 'summer-2027', applyUrl: 'https://careers.example.test/role', compensation: { raw: '' }, state: 'open', firstAttachedAt: '2026-07-30T10:00:00.000Z', firstAttachedAtPrecision: 'exact' },
        { sourceId: direct.id, externalId: 'provider-1', document: 'provider-1', sourceUrl: 'https://boards.example.test', row: 1, company: 'Acme', title: 'Software Intern', location: 'Remote', season: 'summer-2027', applyUrl: 'https://careers.example.test/role', compensation: { raw: '' }, state: 'open', firstAttachedAtPrecision: 'unknown', providerTimestamp: { value: '2026-07-29T10:00:00.000Z', semantics: 'updated' } },
      ],
    };
    await store.putInternship(job);
    await store.putSourceOccurrence({ sourceId: 'community-list', externalId: 'list-1', jobId: job.jobId, occurrence: job.sourceReferences[0]!, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'a', changedAt: '2026-07-30T10:00:00.000Z', firstObservedAt: '2026-07-30T10:00:00.000Z', firstObservedAtPrecision: 'exact' });
    await store.putSourceOccurrence({ sourceId: direct.id, externalId: 'provider-1', jobId: job.jobId, occurrence: job.sourceReferences[1]!, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'b', changedAt: '2026-07-30T10:05:00.000Z', firstObservedAt: '2026-07-30T10:05:00.000Z', firstObservedAtPrecision: 'exact' });
    await store.putCheckpoint({ sourceId: 'community-list', successfulFetches: 1, lastRowCount: 1, activeExternalIds: ['list-1'], contentHash: 'aggregator-confirmed', lastSuccessAt: '2026-07-30T11:00:00.000Z' });

    const response = await createSourceOperationsHandler(dependencies(store).value)(event(`/operations/attribution/${job.jobId}`));
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      providerFirstObservedAt: '2026-07-30T10:05:00.000Z',
      aggregatorFirstObservedAt: '2026-07-30T10:00:00.000Z',
      providerMinusAggregatorLagMs: 300000,
    });
    expect(body.occurrences.find((occurrence: { sourceId: string }) => occurrence.sourceId === direct.id)).toMatchObject({
      firstAttachedAtPrecision: 'unknown', providerTimestamp: { semantics: 'updated' },
    });
    expect(body.occurrences.find((occurrence: { sourceId: string }) => occurrence.sourceId === 'community-list')).toMatchObject({
      lastConfirmedAt: '2026-07-30T11:00:00.000Z',
    });
  });

  it('returns every registered provider while keeping an incompletely configured fleet isolated', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const response = await createSourceOperationsHandler(setup.value)(event('/operations/sources'));
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(new Set(body.sources.map((row: { source: { provider: string } }) => row.source.provider)))
      .toEqual(new Set(['greenhouse', 'lever', 'ashby', 'github']));
    expect(body.fleets.map((fleet: { provider: string }) => fleet.provider).sort()).toEqual(['ashby', 'greenhouse', 'lever']);
    expect(body.providers.map((provider: { id: string }) => provider.id)).toEqual(['greenhouse', 'lever', 'ashby', 'github']);
    expect(body.providers.find((provider: { id: string }) => provider.id === 'github')).toMatchObject({
      availability: 'unavailable',
      unavailableReasons: ['Work queue is not configured.', 'Dead-letter queue is not configured.'],
      sourceActions: ['pause', 'resume', 'replay', 'quarantine', 'recover', 'acknowledge', 'resolve', 'set-tier'],
    });
    expect(body.providers.filter((provider: { id: string }) => provider.id !== 'github'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ availability: 'available' })]));
    expect(body.productionMetrics).toMatchObject({
      deadLetterMessages: 0,
      failedExtractions24h: 0,
      activeAlarms: 1,
      legacyPendingNotifications: 0,
    });
    expect(body.fleet.alarms).toContainEqual(expect.objectContaining({ name: 'InternNotifs-PollDuration', state: 'ALARM' }));
    expect(body.checklist).toMatchObject({ period: '2026-07', completed: 0, total: 8, complete: false });
  });

  it('marks alarm telemetry unavailable instead of reporting a fabricated healthy zero', async () => {
    const store = new MemoryInternshipStore();
    // One published source that attempted long ago and one that attempted a
    // minute before the snapshot: only the first is a cadence slip.
    const staleSource = reviewedGreenhouseSources.find((candidate) => candidate.status === 'published')!;
    const freshSource = reviewedLeverSources.find((candidate) => candidate.status === 'published')!;
    await store.putSourceHealth({ sourceId: staleSource.id, lastAttemptAt: '2026-07-30T18:00:00.000Z', consecutiveFailures: 0, durationMs: 10 });
    await store.putSourceHealth({ sourceId: freshSource.id, lastAttemptAt: '2026-07-30T19:59:00.000Z', consecutiveFailures: 0, durationMs: 10 });
    const setup = dependencies(store);
    const response = await createSourceOperationsHandler({
      ...setup.value,
      alarmTelemetry: { status: 'unavailable', reason: 'Cloudflare alert state is not exposed.' },
      queueTelemetry: { status: 'partial', reason: 'Only total backlog is exposed.' },
    })(event('/operations/sources'));
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.productionMetrics.activeAlarms).toBeNull();
    expect(body.productionMetrics.processingMessages).toBeNull();
    expect(body.fleet.queue).toMatchObject({
      backlogCount: 246, waiting: 246, oldestMessageTimestampMs: 1789488135922,
    });
    expect(body.fleets[0].queue.backlogCount).toBe(82);
    const stale = body.sources.filter((entry: { lastAttemptAt?: string; sourceStatus?: string; state: string; source: { mode: string } }) =>
      entry.source.mode === 'published' && entry.sourceStatus !== 'paused' && entry.state !== 'quarantined'
      && entry.lastAttemptAt !== undefined
      && Date.parse(entry.lastAttemptAt) < Date.parse(body.generatedAt) - 60 * 60_000);
    expect(stale.map((entry: { source: { sourceId: string } }) => entry.source.sourceId)).toEqual([staleSource.id]);
    expect(body.productionMetrics.overduePublishedSources).toBe(1);
    expect(body.fleet.queueTelemetry).toEqual({ status: 'partial', reason: 'Only total backlog is exposed.' });
    expect(body.fleet.alarmTelemetry).toEqual({
      status: 'unavailable',
      reason: 'Cloudflare alert state is not exposed.',
    });
  });

  it('retains the quiet classification for published source health', async () => {
    const store = new MemoryInternshipStore();
    const source = reviewedGreenhouseSources.find((candidate) => candidate.status === 'published')!;
    await store.putCheckpoint({
      sourceId: source.id,
      successfulFetches: 1,
      lastRowCount: 1,
      lastSuccessAt: '2026-07-30T16:00:00.000Z',
    });
    await store.putSourceHealth({
      sourceId: source.id,
      provider: 'greenhouse',
      region: 'unknown',
      state: 'healthy',
      sourceStatus: 'active',
      pollTier: 'quiet',
      pollTierMode: 'automatic',
      lastAttemptAt: '2026-07-30T16:00:00.000Z',
      lastSuccessAt: '2026-07-30T16:00:00.000Z',
      eligibleRows: 0,
      consecutiveFailures: 0,
      durationMs: 1,
    });

    const response = await createSourceOperationsHandler(dependencies(store).value)(event('/operations/sources'));
    const row = JSON.parse(response.body).sources.find(({ source: candidate }: { source: { sourceId: string } }) => candidate.sourceId === source.id);

    expect(row).toMatchObject({ state: 'healthy', pollTier: 'quiet', eligibleRows: 0 });
  });

  it('uses the shadow freshness window even when a shadow source found eligible rows', async () => {
    const store = new MemoryInternshipStore();
    const source = reviewedGreenhouseSources.find((candidate) => candidate.status === 'shadow')!;
    await store.putCheckpoint({
      sourceId: `shadow-${source.id}`,
      successfulFetches: 1,
      lastRowCount: 1,
      lastSuccessAt: '2026-07-30T17:00:00.000Z',
    });
    await store.putSourceHealth({
      sourceId: source.id,
      provider: 'greenhouse',
      region: 'unknown',
      state: 'healthy',
      sourceStatus: 'active',
      pollTier: 'active',
      pollTierMode: 'automatic',
      lastAttemptAt: '2026-07-30T17:00:00.000Z',
      lastSuccessAt: '2026-07-30T17:00:00.000Z',
      eligibleRows: 1,
      consecutiveFailures: 0,
      durationMs: 1,
    });

    const response = await createSourceOperationsHandler(dependencies(store).value)(event('/operations/sources'));
    const row = JSON.parse(response.body).sources.find(({ source: candidate }: { source: { sourceId: string } }) => candidate.sourceId === source.id);

    expect(row).toMatchObject({ state: 'healthy', eligibleRows: 1 });
  });

  it('shows that a board was read without its descriptions', async () => {
    // SpaceX and Anduril answer with more than an isolate can parse once their
    // descriptions are included, so their listings are read instead: the rows are
    // complete and the extracted detail is what is missing.
    const store = new MemoryInternshipStore();
    const source = reviewedGreenhouseSources[0]!;
    await store.putSourceHealth({
      sourceId: source.id, provider: 'greenhouse', state: 'healthy', sourceStatus: 'active',
      outcome: 'success_changed', lastAttemptAt: '2026-07-30T17:00:00.000Z', lastSuccessAt: '2026-07-30T17:00:00.000Z',
      consecutiveFailures: 0, rawRows: 2497, eligibleRows: 4, contentOmitted: true, recentRuns: [],
    } as never);

    const response = await createSourceOperationsHandler(dependencies(store).value)(event('/operations/sources'));
    const row = JSON.parse(response.body).sources.find(({ source: candidate }: { source: { sourceId: string } }) => candidate.sourceId === source.id);

    expect(row).toMatchObject({ contentOmitted: true, rawRows: 2497 });
  });

  it('tracks monthly monitoring checks for all provider fleets', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const handler = createSourceOperationsHandler(setup.value);

    const completed = await handler(event('/operations/checklist/exercise-greenhouse-recovery', 'POST', { completed: true }));
    expect(completed.statusCode).toBe(200);
    expect(JSON.parse(completed.body)).toMatchObject({ completed: 1, total: 8, complete: false });

    const overview = await handler(event('/operations/sources'));
    expect(JSON.parse(overview.body).checklist.items).toContainEqual(expect.objectContaining({
      id: 'exercise-greenhouse-recovery',
      completion: expect.objectContaining({ completedBy: 'test-operator' }),
    }));
  });

  it('pauses and replays a Lever source without changing reviewed configuration', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const source = reviewedLeverSources[0]!;
    const handler = createSourceOperationsHandler(setup.value);

    const paused = await handler(event(`/operations/sources/${source.id}/actions`, 'POST', { action: 'pause' }));
    expect(paused.statusCode).toBe(200);
    expect(await store.getSourceHealth(source.id)).toMatchObject({
      sourceStatus: 'paused',
      changedBy: 'test-operator',
      configVersion: 1,
    });

    const replayed = await handler(event(`/operations/sources/${source.id}/actions`, 'POST', { action: 'replay' }));
    expect(replayed.statusCode).toBe(202);
    const replay = setup.commands.find((command) => command instanceof SendMessageCommand) as SendMessageCommand;
    expect(replay.input).toMatchObject({
      QueueUrl: 'https://sqs.test/lever.fifo',
      MessageGroupId: source.id,
      MessageBody: expect.stringContaining('"force":true'),
    });
  });

  it('normalizes legacy active health to the current registry identity on mutation', async () => {
    const store = new MemoryInternshipStore();
    const source = reviewedGreenhouseSources.find((candidate) => candidate.status === 'published')!;
    await store.putSourceHealth({
      sourceId: source.id,
      state: 'healthy',
      lastAttemptAt: '2026-07-30T19:00:00.000Z',
      consecutiveFailures: 0,
      durationMs: 4,
    });

    const response = await createSourceOperationsHandler(dependencies(store).value)(event(
      `/operations/sources/${source.id}/actions`, 'POST', { action: 'pause' },
    ));

    expect(response.statusCode).toBe(200);
    expect(await store.getSourceHealth(source.id)).toMatchObject({
      provider: 'greenhouse', region: 'unknown', sourceStatus: 'paused',
    });
  });

  it('records set-tier actions as operator overrides', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const source = reviewedLeverSources[0]!;

    const response = await createSourceOperationsHandler(setup.value)(event(
      `/operations/sources/${source.id}/actions`,
      'POST',
      { action: 'set-tier', pollTier: 'quiet' },
    ));

    expect(response.statusCode).toBe(200);
    expect(await store.getSourceHealth(source.id)).toMatchObject({ pollTier: 'quiet', pollTierMode: 'operator' });
  });

  it('exposes GitHub controls and builds its provider-specific forced replay message', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const source = defaultSources[0]!;
    const handler = createSourceOperationsHandler({
      ...setup.value,
      fleets: {
        ...setup.value.fleets,
        github: { queueUrl: 'https://sqs.test/github', deadLetterQueueUrl: 'https://sqs.test/github-dlq' },
      },
    });

    const paused = await handler(event(`/operations/sources/${source.id}/actions`, 'POST', { action: 'pause' }));
    expect(paused.statusCode).toBe(200);
    expect(await store.getSourceHealth(source.id)).toMatchObject({ sourceStatus: 'paused', provider: 'github' });

    const replayed = await handler(event(`/operations/sources/${source.id}/actions`, 'POST', { action: 'replay' }));
    expect(replayed.statusCode).toBe(202);
    const replay = setup.commands.find((command) => command instanceof SendMessageCommand) as SendMessageCommand;
    expect(replay.input.QueueUrl).toBe('https://sqs.test/github');
    expect(JSON.parse(replay.input.MessageBody!)).toEqual({ sourceId: source.id, force: true });
  });

  it('keeps historical provider and region strings visible but read-only', async () => {
    const store = new MemoryInternshipStore();
    await store.putSourceHealth({
      sourceId: 'retired-provider-source', provider: 'retired-ats', region: 'moon-1', state: 'degraded',
      lastAttemptAt: '2026-07-30T19:00:00.000Z', consecutiveFailures: 1, durationMs: 4,
    });
    const handler = createSourceOperationsHandler(dependencies(store).value);

    const detail = await handler(event('/operations/sources/retired-provider-source'));
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body)).toMatchObject({
      historical: true,
      source: { provider: 'retired-ats', region: 'moon-1' },
      health: { provider: 'retired-ats', region: 'moon-1' },
    });

    const action = await handler(event('/operations/sources/retired-provider-source/actions', 'POST', { action: 'replay' }));
    expect(action.statusCode).toBe(409);
    expect(JSON.parse(action.body)).toMatchObject({ code: 'SOURCE_NOT_ACTIVE' });
  });

  it('routes an Ashby replay to the independently discovered fleet', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const source = reviewedAshbySources[0]!;
    const response = await createSourceOperationsHandler(setup.value)(event(
      `/operations/sources/${source.id}/actions`, 'POST', { action: 'replay' },
    ));
    expect(response.statusCode).toBe(202);
    const replay = setup.commands.find((command) => command instanceof SendMessageCommand) as SendMessageCommand;
    expect(replay.input).toMatchObject({ QueueUrl: 'https://sqs.test/ashby.fifo', MessageGroupId: source.id });
    expect(JSON.parse(replay.input.MessageBody!)).toMatchObject({ version: 1, sourceId: source.id, force: true, runId: expect.any(String) });
  });

  it('quarantines an Ashby source and queues a paused validation recovery', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const source = reviewedAshbySources[0]!;
    const handler = createSourceOperationsHandler(setup.value);

    const quarantined = await handler(event(
      `/operations/sources/${source.id}/actions`, 'POST', { action: 'quarantine', reason: 'Unexpected application host under review' },
    ));
    expect(quarantined.statusCode).toBe(200);
    expect(await store.getSourceHealth(source.id)).toMatchObject({
      state: 'quarantined', sourceStatus: 'paused', incidentState: 'open', incidentSeverity: 'high',
      quarantineReason: 'Unexpected application host under review',
    });

    const recovery = await handler(event(`/operations/sources/${source.id}/actions`, 'POST', { action: 'recover' }));
    expect(recovery.statusCode).toBe(202);
    expect(JSON.parse(recovery.body)).toMatchObject({ action: 'recover', sourceStatus: 'paused' });
    expect(await store.getSourceHealth(source.id)).toMatchObject({
      state: 'quarantined', sourceStatus: 'paused', incidentState: 'acknowledged',
    });
    const command = setup.commands.find((candidate) => candidate instanceof SendMessageCommand) as SendMessageCommand;
    expect(command.input).toMatchObject({ QueueUrl: 'https://sqs.test/ashby.fifo', MessageGroupId: source.id });
    expect(JSON.parse(command.input.MessageBody!)).toMatchObject({ force: true, runId: expect.stringMatching(/^recovery-/) });
  });

  it('rejects recovery for a source that is not quarantined', async () => {
    const store = new MemoryInternshipStore();
    const source = reviewedAshbySources[0]!;
    const response = await createSourceOperationsHandler(dependencies(store).value)(event(
      `/operations/sources/${source.id}/actions`, 'POST', { action: 'recover' },
    ));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'SOURCE_NOT_QUARANTINED' });
  });

  it('requires successful recovery before a quarantined source can resume', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const source = reviewedAshbySources[0]!;
    const handler = createSourceOperationsHandler(setup.value);
    await handler(event(`/operations/sources/${source.id}/actions`, 'POST', { action: 'quarantine', reason: 'Schema drift' }));
    const response = await handler(event(`/operations/sources/${source.id}/actions`, 'POST', { action: 'resume' }));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'SOURCE_STILL_QUARANTINED' });
    expect(await store.getSourceHealth(source.id)).toMatchObject({ state: 'quarantined', sourceStatus: 'paused' });
  });

  it('keeps a quarantined incident open when its recovery fleet is unavailable', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const source = reviewedAshbySources[0]!;
    await createSourceOperationsHandler(setup.value)(event(
      `/operations/sources/${source.id}/actions`, 'POST', { action: 'quarantine', reason: 'Investigating schema drift' },
    ));

    const response = await createSourceOperationsHandler({
      ...setup.value,
      fleets: { greenhouse: setup.value.fleets.greenhouse, lever: setup.value.fleets.lever },
    })(event(`/operations/sources/${source.id}/actions`, 'POST', { action: 'recover' }));

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'PROVIDER_QUEUE_UNAVAILABLE' });
    expect(await store.getSourceHealth(source.id)).toMatchObject({
      state: 'quarantined', sourceStatus: 'paused', incidentState: 'open',
    });
  });

  it('reopens a quarantined incident when its recovery message cannot be queued', async () => {
    const store = new MemoryInternshipStore();
    const setup = dependencies(store);
    const source = reviewedAshbySources[0]!;
    await createSourceOperationsHandler(setup.value)(event(
      `/operations/sources/${source.id}/actions`, 'POST', { action: 'quarantine', reason: 'Investigating schema drift' },
    ));
    const failingSqs = {
      async send(command: unknown) {
        if (command instanceof SendMessageCommand) throw new Error('SQS unavailable');
        return {};
      },
    } as unknown as SQSClient;

    const response = await createSourceOperationsHandler({ ...setup.value, sqs: failingSqs })(event(
      `/operations/sources/${source.id}/actions`, 'POST', { action: 'recover' },
    ));

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'RECOVERY_ENQUEUE_FAILED' });
    expect(await store.getSourceHealth(source.id)).toMatchObject({
      state: 'quarantined', sourceStatus: 'paused', incidentState: 'open',
    });
    expect((await store.getSourceHealth(source.id))?.incidentAcknowledgedAt).toBeUndefined();
  });
});
