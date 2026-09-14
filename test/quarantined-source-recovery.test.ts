import type { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it } from 'vitest';
import { dispatchAshbyBoards } from '../src/ashby-dispatch.js';
import { dispatchGreenhouseBoards } from '../src/greenhouse-dispatch.js';
import { dispatchLeverBoards } from '../src/lever-dispatch.js';
import { isQuarantinedRecoveryProbeDue, SOURCE_POLL_CADENCE } from '../src/source-poll-cadence.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import { reviewedLeverSources } from '../src/sources/lever-config.js';
import type { SourceHealth } from '../src/types.js';

const firstProbeAt = (sourceId: string, health: SourceHealth): Date => {
  const start = Date.parse(health.lastAttemptAt!) + SOURCE_POLL_CADENCE.recoveryProbeIntervalMs;
  for (let at = start; at < start + SOURCE_POLL_CADENCE.recoveryProbeJitterMs; at += SOURCE_POLL_CADENCE.publishedIntervalMs) {
    const now = new Date(at);
    if (isQuarantinedRecoveryProbeDue(sourceId, health, now)) return now;
  }
  throw new Error('expected a recovery probe slot');
};

const quarantinedHealth = (sourceId: string): SourceHealth => ({
  sourceId,
  state: 'quarantined',
  sourceStatus: 'paused',
  lastAttemptAt: '2026-09-01T00:00:00.000Z',
  quarantinedAt: '2026-09-01T00:00:00.000Z',
  consecutiveFailures: 2,
  durationMs: 20,
});

const queuedMessage = (commands: SendMessageBatchCommand[]) =>
  JSON.parse(commands[0]!.input.Entries![0]!.MessageBody!) as { force?: boolean };

describe('quarantined source recovery probes', () => {
  const assertRecoveryProbe = async (sourceId: string, run: (now: Date, commands: SendMessageBatchCommand[]) => Promise<{ queued: number }>) => {
    const health = quarantinedHealth(sourceId);
    const commands: SendMessageBatchCommand[] = [];
    const probeAt = firstProbeAt(sourceId, health);

    await expect(run(new Date(probeAt.getTime() - SOURCE_POLL_CADENCE.publishedIntervalMs), commands)).resolves.toEqual({ queued: 0 });
    await expect(run(probeAt, commands)).resolves.toEqual({ queued: 1 });
    expect(queuedMessage(commands)).toMatchObject({ force: true });
  };

  it('queues one forced probe only in each provider’s jittered daily recovery slot', async () => {
    const lever = reviewedLeverSources.find((source) => source.status === 'shadow')!;
    const greenhouse = reviewedGreenhouseSources.find((source) => source.status === 'shadow')!;
    const ashby = reviewedAshbySources.find((source) => source.status === 'shadow')!;

    await assertRecoveryProbe(lever.id, async (now, commands) => dispatchLeverBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/lever.fifo', sources: [lever], now: () => now,
      checkpointReader: { getCheckpoint: async () => undefined, getSourceHealth: async () => quarantinedHealth(lever.id) },
      client: { async send(command) { commands.push(command); return {}; } },
    }));
    await assertRecoveryProbe(greenhouse.id, async (now, commands) => dispatchGreenhouseBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/greenhouse.fifo', sources: [greenhouse], now: () => now,
      checkpointReader: { getCheckpoint: async () => undefined, getSourceHealth: async () => quarantinedHealth(greenhouse.id) },
      client: { async send(command) { commands.push(command); return {}; } },
    }));
    await assertRecoveryProbe(ashby.id, async (now, commands) => dispatchAshbyBoards({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123/ashby.fifo', sources: [ashby], now: () => now,
      checkpointReader: { getCheckpoint: async () => undefined, getSourceHealth: async () => quarantinedHealth(ashby.id) },
      client: { async send(command) { commands.push(command); return {}; } },
    }));
  });
});
