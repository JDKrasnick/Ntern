import { randomUUID } from 'node:crypto';
import { SendMessageBatchCommand, SQSClient, type SendMessageBatchRequestEntry } from '@aws-sdk/client-sqs';
import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import { DynamoInternshipStore, type LeverAdmission } from './store.js';
import { isProviderSourceDue, SOURCE_POLL_CADENCE } from './source-poll-cadence.js';
import type { SourceCheckpoint, SourceHealth } from './types.js';

export const LEVER_DISPATCH_BATCH_SIZE = 10;
export const LEVER_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.publishedIntervalMs;
export const LEVER_SHADOW_POLL_INTERVAL_MS = SOURCE_POLL_CADENCE.shadowIntervalMs;

export interface LeverWorkMessage {
  version: 1;
  sourceId: string;
  scheduledAt: string;
  runId?: string;
  /** An operator replay may deliberately bypass a pause or provider backoff. */
  force?: boolean;
}

interface LeverQueueClient {
  send(command: SendMessageBatchCommand): Promise<{ Failed?: Array<{ Id?: string; Message?: string }> }>;
}

interface CheckpointReader {
  getCheckpoint(sourceId: string): Promise<SourceCheckpoint | undefined>;
  getSourceHealth?(sourceId: string): Promise<SourceHealth | undefined>;
  putSourceHealth?(health: SourceHealth): Promise<void>;
  listLeverAdmissions?(): Promise<LeverAdmission[]>;
}

export interface LeverDispatchDependencies {
  queueUrl: string;
  client?: LeverQueueClient;
  checkpointReader?: CheckpointReader;
  sources?: ReviewedLeverSource[];
  now?: () => Date;
  runId?: string;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function leverWorkMessages(
  sources: ReviewedLeverSource[] = reviewedLeverSources,
  scheduledAt = new Date(),
  runId?: string,
  recoveryProbeSourceIds = new Set<string>(),
): LeverWorkMessage[] {
  const timestamp = scheduledAt.toISOString();
  return sources.map((source) => ({
    version: 1,
    sourceId: source.id,
    scheduledAt: timestamp,
    ...(runId ? { runId } : {}),
    ...(recoveryProbeSourceIds.has(source.id) ? { force: true } : {}),
  }));
}

export function isLeverSourceDue(
  source: ReviewedLeverSource,
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
  health?: SourceHealth,
): boolean {
  return isProviderSourceDue(source.id, source.status, checkpoint, now, health);
}

function emitFreshness(source: ReviewedLeverSource, health: SourceHealth | undefined, checkpoint: SourceCheckpoint | undefined, now: Date) {
  const lastSuccessAt = health?.lastSuccessAt ?? checkpoint?.lastSuccessAt;
  const freshnessMinutes = lastSuccessAt
    ? Math.max(0, (now.getTime() - Date.parse(lastSuccessAt)) / 60_000)
    : Math.max(0, (now.getTime() - Date.parse(source.admittedAt)) / 60_000);
  console.log(JSON.stringify({
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [{
        Namespace: 'InternNotifs/Ingestion',
        Dimensions: [['provider', 'region']],
        Metrics: [{ Name: 'SourceFreshnessMinutes', Unit: 'None' }],
      }],
    },
    event: 'source_freshness_evaluated',
    sourceId: source.id,
    provider: 'lever',
    region: source.region,
    SourceFreshnessMinutes: freshnessMinutes,
    backoffUntil: health?.backoffUntil,
  }));
  return freshnessMinutes;
}

async function recordFreshnessIncident(
  source: ReviewedLeverSource,
  checkpoint: SourceCheckpoint | undefined,
  health: SourceHealth | undefined,
  reader: CheckpointReader,
  now: Date,
) {
  // Shadow boards intentionally run every three hours and are not held to the
  // published-source freshness objective.
  if (source.status === 'shadow' || health?.sourceStatus === 'paused') return;
  const freshnessMinutes = emitFreshness(source, health, checkpoint, now);
  if (!health || freshnessMinutes < 90 || !reader.putSourceHealth) return;
  const severity = 'high' as const;
  const state = health.incidentState === 'acknowledged' ? 'acknowledged' as const : 'open' as const;
  if (health.incidentState === state && health.incidentSeverity === severity
    && Math.floor(health.freshnessMinutes ?? -1) === Math.floor(freshnessMinutes)) return;
  const timestamp = now.toISOString();
  await reader.putSourceHealth({
    ...health,
    freshnessMinutes,
    incidentState: state,
    incidentSeverity: severity,
    incidentOpenedAt: health.incidentOpenedAt ?? timestamp,
    incidentUpdatedAt: timestamp,
  });
  if (health.incidentState !== state || health.incidentSeverity !== severity) {
    console.warn(JSON.stringify({
      event: 'source_incident_state_changed',
      sourceId: source.id,
      provider: 'lever',
      region: source.region,
      incidentState: state,
      severity,
      freshnessMinutes,
      catalogPreserved: true,
      nextAction: health.backoffUntil ? 'review_provider_backoff' : 'replay_or_investigate_source',
    }));
  }
}

async function dueSources(
  sources: ReviewedLeverSource[],
  checkpointReader: CheckpointReader | undefined,
  now: Date,
): Promise<Array<{ source: ReviewedLeverSource; recoveryProbe: boolean }>> {
  if (!checkpointReader) return sources.map((source) => ({ source, recoveryProbe: false }));
  const checkpoints = new Map<string, SourceCheckpoint | undefined>();
  const health = new Map<string, SourceHealth | undefined>();
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const source = sources[next++];
      const checkpointId = source.status === 'shadow' ? `shadow-${source.id}` : source.id;
      const [checkpoint, sourceHealth] = await Promise.all([
        checkpointReader.getCheckpoint(checkpointId),
        checkpointReader.getSourceHealth?.(source.id),
      ]);
      checkpoints.set(source.id, checkpoint);
      health.set(source.id, sourceHealth);
      await recordFreshnessIncident(source, checkpoint, sourceHealth, checkpointReader, now);
    }
  };
  await Promise.all(Array.from({ length: Math.min(24, sources.length) }, worker));
  return sources.flatMap((source) => {
    const sourceHealth = health.get(source.id);
    if (!isLeverSourceDue(source, checkpoints.get(source.id), now, sourceHealth)) return [];
    return [{ source, recoveryProbe: sourceHealth?.state === 'quarantined' }];
  });
}

export async function dispatchLeverBoards(dependencies: LeverDispatchDependencies): Promise<{ queued: number }> {
  const client = dependencies.client ?? new SQSClient({});
  const now = (dependencies.now ?? (() => new Date()))();
  const dynamic = dependencies.sources || !dependencies.checkpointReader?.listLeverAdmissions
    ? []
    : (await dependencies.checkpointReader.listLeverAdmissions()).map(({ source }) => source);
  const sources = dependencies.sources ?? [...reviewedLeverSources, ...dynamic];
  const due = await dueSources(sources, dependencies.checkpointReader, now);
  const messages = leverWorkMessages(
    due.map(({ source }) => source),
    now,
    dependencies.runId ?? randomUUID(),
    new Set(due.filter(({ recoveryProbe }) => recoveryProbe).map(({ source }) => source.id)),
  );
  const window = Math.floor(now.getTime() / LEVER_POLL_INTERVAL_MS);
  let queued = 0;

  for (const [batchIndex, batch] of chunks(messages, LEVER_DISPATCH_BATCH_SIZE).entries()) {
    const entries: SendMessageBatchRequestEntry[] = batch.map((message, entryIndex) => ({
      Id: `${batchIndex}-${entryIndex}`,
      MessageBody: JSON.stringify(message),
      MessageGroupId: message.sourceId,
      MessageDeduplicationId: `${message.sourceId}:${window}`,
    }));
    const response = await client.send(new SendMessageBatchCommand({ QueueUrl: dependencies.queueUrl, Entries: entries }));
    if (response.Failed?.length) {
      const detail = response.Failed.map((failure) => `${failure.Id ?? 'unknown'}: ${failure.Message ?? 'unknown error'}`).join('; ');
      throw new Error(`Failed to queue Lever boards: ${detail}`);
    }
    queued += entries.length;
  }
  return { queued };
}

export async function handler(_event?: unknown, context?: { awsRequestId?: string }): Promise<{ queued: number }> {
  const queueUrl = process.env.LEVER_QUEUE_URL;
  const tableName = process.env.INTERNSHIPS_TABLE;
  if (!queueUrl || !tableName) throw new Error('LEVER_QUEUE_URL and INTERNSHIPS_TABLE are required');
  const runId = context?.awsRequestId ?? randomUUID();
  const result = await dispatchLeverBoards({ queueUrl, checkpointReader: new DynamoInternshipStore(tableName), runId });
  console.log(JSON.stringify({ event: 'poll_completed', command: 'lever-dispatch', provider: 'lever', runId, ...result }));
  return result;
}
