import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient, type QueueAttributeName } from '@aws-sdk/client-sqs';
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoInternshipStore, type InternshipStore } from './store.js';
import { acceptLeverAdmission, listLeverCandidates, verifyLeverAdmission, type LeverAdmissionInput } from './lever-admission.js';
import { monitoringChecklistItems, monitoringPeriod, publicMonitoringChecklist } from './monitoring-checklist.js';
import { occurrenceStatus } from './ingestion/monitoring.js';
import { missedPublishedInterval } from './source-poll-cadence.js';
import {
  catalogProviderDefinitions,
  integrationRegistry,
  operationsSources,
  type CatalogProviderId,
  type RegisteredOperationsSource,
  type SourceAction,
} from './integration-registry.js';
import type { MonitoringChecklist, MonitoringChecklistItemId, SourceCheckpoint, SourceHealth, SourceHealthState } from './types.js';

type ApiEvent = {
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
  rawPath?: string;
  routeKey?: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
};

const responseHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Headers': 'Content-Type,X-Operations-Key',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
const reply = (statusCode: number, body: unknown) => ({ statusCode, headers: responseHeaders, body: JSON.stringify(body) });
const inactiveHealthWindowMs = 7 * 60 * 60_000;
// Cloudflare's queue-metrics client reports the age of the oldest message under
// this name, which the SQS attribute union does not carry.
type QueueAttributes = Partial<Record<QueueAttributeName | 'oldest_message_timestamp_ms', string>>;

type Provider = CatalogProviderId;
type OperationsSource = RegisteredOperationsSource;
export type FleetConfiguration = Partial<Record<Provider, { queueUrl?: string; deadLetterQueueUrl?: string }>>;

function header(event: ApiEvent, name: string): string | undefined {
  const match = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function authorized(event: ApiEvent, expectedSecret: string): boolean {
  const supplied = header(event, 'x-operations-key');
  if (!supplied || !expectedSecret) return false;
  const actual = createHash('sha256').update(supplied).digest();
  const expected = createHash('sha256').update(expectedSecret).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function stateFor(source: OperationsSource, health: SourceHealth | undefined, checkpoint: SourceCheckpoint | undefined, timestamp: number): SourceHealthState {
  if (health?.state === 'quarantined') return 'quarantined';
  const lastSuccessAt = health?.lastSuccessAt ?? checkpoint?.lastSuccessAt;
  if (!lastSuccessAt) return health?.state ?? 'never-succeeded';
  const allowedAge = source.mode === 'shadow' || health?.pollTier === 'quiet'
    ? inactiveHealthWindowMs
    : (checkpoint?.lastRowCount ?? health?.eligibleRows ?? 0) > 0
      ? integrationRegistry[source.provider].freshnessWindowMs
      : inactiveHealthWindowMs;
  if (timestamp - Date.parse(lastSuccessAt) > allowedAge || health?.state === 'degraded') return 'degraded';
  return 'healthy';
}

function publicSource(
  source: OperationsSource,
  health: SourceHealth | undefined,
  checkpoint: SourceCheckpoint | undefined,
  timestamp: number,
) {
  const lastSuccessAt = health?.lastSuccessAt ?? checkpoint?.lastSuccessAt;
  const recentRuns = health?.recentRuns ?? [];
  const successfulRuns = recentRuns.filter((run) => run.state === 'succeeded').length;
  const state = stateFor(source, health, checkpoint, timestamp);
  return {
    source: {
      sourceId: source.sourceId,
      provider: source.provider,
      region: source.region,
      displayName: source.displayName,
      careersUrl: source.careersUrl,
      mode: source.mode,
      boardToken: source.boardToken,
      evidenceStatus: source.evidenceStatus,
    },
    state,
    ...(lastSuccessAt ? { lastSuccessfulSnapshotAt: lastSuccessAt, ageSeconds: Math.max(0, Math.floor((timestamp - Date.parse(lastSuccessAt)) / 1000)) } : {}),
    lastAttemptAt: health?.lastAttemptAt ?? lastSuccessAt,
    quarantined: state === 'quarantined',
    quarantineReason: health?.quarantineReason,
    diagnostic: health?.diagnostic,
    failureCategory: health?.failureCategory,
    outcome: health?.outcome,
    consecutiveFailures: health?.consecutiveFailures ?? 0,
    sourceStatus: health?.sourceStatus ?? 'active',
    pollTier: health?.pollTier ?? ((checkpoint?.lastRowCount ?? 0) > 0 ? 'active' : 'quiet'),
    backoffUntil: health?.backoffUntil,
    incidentState: health?.incidentState,
    incidentSeverity: health?.incidentSeverity,
    rawRows: health?.rawRows ?? checkpoint?.lastRawRowCount,
    eligibleRows: health?.eligibleRows ?? checkpoint?.lastRowCount,
    withheldRows: health?.withheldRows ?? checkpoint?.lastWithheldRowCount ?? 0,
    applicationLinksChecked: health?.applicationLinksChecked,
    applicationLinkFailures: health?.applicationLinkFailures,
    recentRuns: recentRuns.length,
    successRate: recentRuns.length ? successfulRuns / recentRuns.length : lastSuccessAt ? 1 : 0,
  };
}

async function fleetStatus(
  provider: (typeof catalogProviderDefinitions)[number],
  configuration: { queueUrl: string; deadLetterQueueUrl: string },
  sqs: SQSClient,
  cloudwatch: CloudWatchClient,
) {
  const [queue, deadLetter, alarms] = await Promise.all([
    sqs.send(new GetQueueAttributesCommand({
      QueueUrl: configuration.queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    })),
    sqs.send(new GetQueueAttributesCommand({
      QueueUrl: configuration.deadLetterQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    })),
    cloudwatch.send(new DescribeAlarmsCommand({
      AlarmNamePrefix: provider.alarmPrefix,
    })),
  ]);
  const number = (value: string | undefined) => Number(value ?? 0);
  const attributes: QueueAttributes | undefined = queue.Attributes;
  return {
    provider: provider.id,
    queue: {
      waiting: number(queue.Attributes?.ApproximateNumberOfMessages),
      // The same quantity as `waiting`, under Cloudflare's own field name, so an
      // operator can compare this row with /queues/{queue_id}/metrics directly.
      backlogCount: number(queue.Attributes?.ApproximateNumberOfMessages),
      oldestMessageTimestampMs: attributes?.oldest_message_timestamp_ms
        ? number(attributes.oldest_message_timestamp_ms) : null,
      processing: number(queue.Attributes?.ApproximateNumberOfMessagesNotVisible),
      deadLettered: number(deadLetter.Attributes?.ApproximateNumberOfMessages) + number(deadLetter.Attributes?.ApproximateNumberOfMessagesNotVisible),
    },
    alarms: (alarms.MetricAlarms ?? []).map((alarm) => ({
      name: alarm.AlarmName,
      state: alarm.StateValue,
      updatedAt: alarm.StateUpdatedTimestamp?.toISOString(),
      description: alarm.AlarmDescription,
    })),
  };
}

async function applicationAlarms(cloudwatch: CloudWatchClient) {
  const response = await cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: 'InternNotifs-' }));
  return (response.MetricAlarms ?? []).map((alarm) => ({
    name: alarm.AlarmName,
    state: alarm.StateValue,
    updatedAt: alarm.StateUpdatedTimestamp?.toISOString(),
    description: alarm.AlarmDescription,
  }));
}

async function providerFleets(
  configured: FleetConfiguration,
  ssm: SSMClient,
  parameterPrefix?: string,
): Promise<FleetConfiguration> {
  const complete = (fleet: FleetConfiguration[Provider]) => Boolean(fleet?.queueUrl && fleet.deadLetterQueueUrl);
  if (!parameterPrefix || catalogProviderDefinitions.every((provider) => complete(configured[provider.id]))) return configured;
  const response = await ssm.send(new GetParametersByPathCommand({
    Path: parameterPrefix,
    Recursive: true,
    WithDecryption: false,
  }));
  const values = new Map((response.Parameters ?? []).flatMap((parameter) => (
    parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value] as const] : []
  )));
  return Object.fromEntries(catalogProviderDefinitions.map((provider) => {
    const current = configured[provider.id];
    const base = `${parameterPrefix}/${provider.runtime.awsParameterSegment}`;
    return [provider.id, {
      queueUrl: current?.queueUrl ?? values.get(`${base}/queue-url`),
      deadLetterQueueUrl: current?.deadLetterQueueUrl ?? values.get(`${base}/dead-letter-queue-url`),
    }];
  })) as FleetConfiguration;
}

export interface SourceOperationsDependencies {
  store: InternshipStore;
  sharedSecret: string;
  fleets?: FleetConfiguration;
  queueUrl?: string;
  deadLetterQueueUrl?: string;
  parameterPrefix?: string;
  sqs?: SQSClient;
  cloudwatch?: CloudWatchClient;
  ssm?: SSMClient;
  now?: () => Date;
  alarmTelemetry?: { status: 'available' | 'unavailable'; reason?: string };
  queueTelemetry?: { status: 'available' | 'partial'; reason?: string };
}

function configuredFleetInput(dependencies: SourceOperationsDependencies): FleetConfiguration {
  if (dependencies.fleets) return dependencies.fleets;
  return {
    greenhouse: {
      queueUrl: dependencies.queueUrl,
      deadLetterQueueUrl: dependencies.deadLetterQueueUrl,
    },
  };
}

function parseBody(event: ApiEvent): Record<string, unknown> {
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
  return JSON.parse(body) as Record<string, unknown>;
}

export function createSourceOperationsHandler(dependencies: SourceOperationsDependencies) {
  return async (event: ApiEvent) => {
    const method = event.requestContext?.http?.method ?? event.routeKey?.split(' ')[0] ?? 'GET';
    if (method === 'OPTIONS') return reply(204, {});
    if (!authorized(event, dependencies.sharedSecret)) return reply(401, { code: 'AUTHENTICATION_REQUIRED', message: 'Operations credentials were rejected.' });

    const timestamp = (dependencies.now ?? (() => new Date()))().getTime();
    const path = (event.rawPath ?? event.routeKey?.split(' ')[1] ?? '/').replace(/^\/internal(?=\/)/, '');
    const dynamicAdmissions = await (dependencies.store.listLeverAdmissions?.() ?? Promise.resolve([]));
    if (path === '/operations/lever/candidates' && method === 'GET') {
      const candidates = await listLeverCandidates(dependencies.store, new Date(timestamp));
      return reply(200, { generatedAt: new Date(timestamp).toISOString(), candidates, admissions: dynamicAdmissions });
    }
    const leverAction = path.match(/^\/operations\/lever\/candidates\/([^/]+)\/(verify|accept)$/);
    if (leverAction && method === 'POST') {
      let input: LeverAdmissionInput;
      try {
        const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
        input = JSON.parse(body) as LeverAdmissionInput;
      } catch {
        return reply(400, { code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' });
      }
      const site = decodeURIComponent(leverAction[1]);
      try {
        if (leverAction[2] === 'verify') {
          return reply(200, await verifyLeverAdmission(dependencies.store, site, input, { now: dependencies.now }));
        }
        const actor = header(event, 'x-operations-actor')?.trim() || 'operations-owner';
        return reply(201, await acceptLeverAdmission(dependencies.store, site, input, actor, { now: dependencies.now }));
      } catch (error) {
        return reply(422, {
          code: leverAction[2] === 'verify' ? 'VERIFICATION_FAILED' : 'ADMISSION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const sources: OperationsSource[] = operationsSources({ leverAdmissions: dynamicAdmissions });
    const ids = sources.map((source) => source.sourceId);
    const checklistPeriod = monitoringPeriod(new Date(timestamp));
    const [healthRecords, checkpoints, storedChecklist] = await Promise.all([
      dependencies.store.getSourceHealthMany(ids),
      Promise.all(sources.map((source) => dependencies.store.getCheckpoint(source.checkpointId))),
      dependencies.store.getMonitoringChecklist(checklistPeriod),
    ]);
    const health = new Map(healthRecords.map((record) => [record.sourceId, record]));
    const rows = sources.map((source, index) => publicSource(source, health.get(source.sourceId), checkpoints[index], timestamp));

    const checklistMatch = path.match(/^\/operations\/checklist\/([^/]+)$/);
    if (checklistMatch && method === 'POST') {
      const itemId = decodeURIComponent(checklistMatch[1]) as MonitoringChecklistItemId;
      if (!monitoringChecklistItems.some((item) => item.id === itemId)) {
        return reply(404, { code: 'CHECKLIST_ITEM_NOT_FOUND', message: 'Checklist item not found.' });
      }
      let input: Record<string, unknown>;
      try { input = parseBody(event); }
      catch { return reply(400, { code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' }); }
      if (typeof input.completed !== 'boolean') {
        return reply(400, { code: 'INVALID_REQUEST', message: 'completed must be a boolean.' });
      }
      const actor = header(event, 'x-operations-actor')?.trim() || 'operations-owner';
      const changedAt = new Date(timestamp).toISOString();
      const checklist: MonitoringChecklist = storedChecklist ?? {
        period: checklistPeriod,
        completions: {},
        version: 0,
      };
      const completions = { ...checklist.completions };
      if (input.completed) completions[itemId] = { completedAt: changedAt, completedBy: actor };
      else delete completions[itemId];
      const updated: MonitoringChecklist = {
        ...checklist,
        completions,
        updatedAt: changedAt,
        updatedBy: actor,
        version: checklist.version + 1,
      };
      await dependencies.store.putMonitoringChecklist(updated);
      console.log(JSON.stringify({
        event: 'monitoring_checklist_changed',
        period: checklistPeriod,
        itemId,
        completed: input.completed,
        actor,
        version: updated.version,
      }));
      return reply(200, publicMonitoringChecklist(updated, checklistPeriod));
    }

    const attributionMatch = path.match(/^\/operations\/attribution\/([^/]+)$/);
    if (attributionMatch) {
      if (method !== 'GET') return reply(405, { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });
      const jobId = decodeURIComponent(attributionMatch[1]);
      const job = await dependencies.store.getJob(jobId);
      if (!job) return reply(404, { code: 'JOB_NOT_FOUND', message: 'Catalog job not found.' });
      const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
      const referenceSourceIds = [...new Set(job.sourceReferences.map((reference) => reference.sourceId))];
      const [occurrenceEntries, attributionCheckpoints, attributionHealthRecords] = await Promise.all([
        Promise.all(referenceSourceIds.map(async (sourceId) => [sourceId, await dependencies.store.getSourceOccurrences(sourceId)] as const)),
        Promise.all(referenceSourceIds.map((sourceId) => dependencies.store.getCheckpoint(sourceId))),
        dependencies.store.getSourceHealthMany(referenceSourceIds),
      ]);
      const occurrencesBySourceId = new Map(occurrenceEntries);
      const checkpointBySourceId = new Map(referenceSourceIds.map((sourceId, index) => [sourceId, attributionCheckpoints[index]]));
      const healthBySourceId = new Map(attributionHealthRecords.map((record) => [record.sourceId, record]));
      const occurrences = job.sourceReferences.map((reference) => {
        const candidates = occurrencesBySourceId.get(reference.sourceId) ?? [];
        const state = candidates.find((candidate) => candidate.externalId === reference.externalId)
          ?? candidates.find((candidate) => candidate.occurrence.document === reference.document && candidate.occurrence.row === reference.row);
        const source = sourceById.get(reference.sourceId);
        const status = state ? occurrenceStatus(state, checkpointBySourceId.get(reference.sourceId), healthBySourceId.get(reference.sourceId)) : undefined;
        return {
          sourceId: reference.sourceId,
          sourceKind: source ? 'direct-provider' as const : 'aggregator' as const,
          externalId: reference.externalId,
          firstObservedAt: status?.firstObservedAt,
          firstObservedAtPrecision: status?.firstObservedAtPrecision ?? 'unknown',
          lastConfirmedAt: status?.lastConfirmedAt,
          firstAttachedAt: reference.firstAttachedAt,
          firstAttachedAtPrecision: reference.firstAttachedAtPrecision ?? 'unknown',
          providerTimestamp: reference.providerTimestamp,
        };
      });
      const firstExact = (kind: 'direct-provider' | 'aggregator') => occurrences
        .filter((item) => item.sourceKind === kind && item.firstObservedAtPrecision === 'exact' && item.firstObservedAt)
        .sort((a, b) => a.firstObservedAt!.localeCompare(b.firstObservedAt!))[0];
      const providerFirst = firstExact('direct-provider');
      const aggregatorFirst = firstExact('aggregator');
      const providerMinusAggregatorLagMs = providerFirst && aggregatorFirst
        ? Date.parse(providerFirst.firstObservedAt!) - Date.parse(aggregatorFirst.firstObservedAt!)
        : undefined;
      return reply(200, {
        generatedAt: new Date(timestamp).toISOString(),
        jobId: job.jobId,
        occurrences,
        providerFirstObservedAt: providerFirst?.firstObservedAt,
        aggregatorFirstObservedAt: aggregatorFirst?.firstObservedAt,
        // Positive means the aggregator was seen first; negative means a direct provider was seen first.
        ...(providerMinusAggregatorLagMs === undefined ? {} : { providerMinusAggregatorLagMs }),
      });
    }

    const actionMatch = path.match(/^\/operations\/sources\/([^/]+)\/actions$/);
    if (actionMatch && method === 'POST') {
      const sourceId = decodeURIComponent(actionMatch[1]);
      const source = sources.find((candidate) => candidate.sourceId === sourceId);
      if (!source) {
        const historical = await dependencies.store.getSourceHealth(sourceId);
        return historical
          ? reply(409, { code: 'SOURCE_NOT_ACTIVE', message: 'Historical source health is read-only because this source is not active in the registry.' })
          : reply(404, { code: 'SOURCE_NOT_FOUND', message: 'Source not found.' });
      }
      let input: Record<string, unknown>;
      try { input = parseBody(event); }
      catch { return reply(400, { code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' }); }
      const action = input.action;
      const knownActions: SourceAction[] = ['pause', 'resume', 'replay', 'quarantine', 'recover', 'acknowledge', 'resolve', 'set-tier'];
      if (typeof action !== 'string' || !knownActions.includes(action as SourceAction)) {
        return reply(400, { code: 'INVALID_ACTION', message: 'Action must be pause, resume, replay, quarantine, recover, acknowledge, resolve, or set-tier.' });
      }
      const provider = integrationRegistry[source.provider];
      const advertisedActions: readonly SourceAction[] = provider.sourceActions;
      if (!advertisedActions.includes(action as SourceAction)) {
        return reply(409, { code: 'ACTION_NOT_SUPPORTED', message: `${provider.displayName} does not advertise the ${action} source action.` });
      }
      const actor = header(event, 'x-operations-actor')?.trim() || 'operations-owner';
      const changedAt = new Date(timestamp).toISOString();
      const previous = health.get(sourceId);
      const base: SourceHealth = {
        ...(previous ?? {
          sourceId,
          state: 'never-succeeded',
          lastAttemptAt: changedAt,
          consecutiveFailures: 0,
          durationMs: 0,
        }),
        provider: source.provider,
        region: source.region,
      };
      let updated = {
        ...base,
        configVersion: (base.configVersion ?? 0) + 1,
        changedAt,
        changedBy: actor,
      };
      if (action === 'pause') updated = { ...updated, sourceStatus: 'paused' };
      if (action === 'quarantine') {
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (!reason || reason.length > 500) {
          return reply(400, { code: 'INVALID_QUARANTINE_REASON', message: 'A quarantine reason between 1 and 500 characters is required.' });
        }
        updated = {
          ...updated,
          state: 'quarantined',
          sourceStatus: 'paused',
          diagnostic: reason,
          lastSafeDiagnostic: reason,
          quarantineReason: reason,
          quarantinedAt: changedAt,
          incidentState: 'open',
          incidentSeverity: 'high',
          incidentOpenedAt: base.incidentOpenedAt ?? changedAt,
          incidentUpdatedAt: changedAt,
        };
      }
      if (action === 'resume') {
        if (base.state === 'quarantined') {
          return reply(409, { code: 'SOURCE_STILL_QUARANTINED', message: 'Run recovery successfully before resuming this source.' });
        }
        const withoutBackoff = { ...updated };
        delete withoutBackoff.backoffUntil;
        updated = { ...withoutBackoff, sourceStatus: 'active' };
      }
      if (action === 'set-tier') {
        if (input.pollTier !== 'active' && input.pollTier !== 'quiet') {
          return reply(400, { code: 'INVALID_POLL_TIER', message: 'pollTier must be active or quiet.' });
        }
        updated = { ...updated, pollTier: input.pollTier, pollTierMode: 'operator' };
      }
      if (action === 'acknowledge') {
        if (!base.incidentState || base.incidentState === 'resolved') {
          return reply(409, { code: 'NO_OPEN_INCIDENT', message: 'This source has no open incident to acknowledge.' });
        }
        updated = { ...updated, incidentState: 'acknowledged', incidentAcknowledgedAt: changedAt, incidentUpdatedAt: changedAt };
      }
      if (action === 'resolve') {
        updated = { ...updated, incidentState: 'resolved', incidentResolvedAt: changedAt, incidentUpdatedAt: changedAt };
      }
      if (action === 'replay' || action === 'recover') {
        if (action === 'recover' && base.state !== 'quarantined') {
          return reply(409, { code: 'SOURCE_NOT_QUARANTINED', message: 'Recovery requires a quarantined source.' });
        }
        let configuredFleets: FleetConfiguration;
        try {
          configuredFleets = await providerFleets(
            configuredFleetInput(dependencies),
            dependencies.ssm ?? new SSMClient({}),
            dependencies.parameterPrefix,
          );
        } catch {
          return reply(503, { code: 'PROVIDER_CONFIGURATION_UNAVAILABLE', message: 'Provider queue configuration could not be resolved.' });
        }
        const fleet = configuredFleets[source.provider];
        if (!fleet?.queueUrl) return reply(503, { code: 'PROVIDER_QUEUE_UNAVAILABLE', message: `${source.provider} replay is not configured.` });
        if (action === 'recover') {
          updated = { ...updated, sourceStatus: 'paused', incidentState: 'acknowledged', incidentAcknowledgedAt: changedAt, incidentUpdatedAt: changedAt };
          await dependencies.store.putSourceHealth(updated);
        }
        const runId = `${action === 'recover' ? 'recovery' : 'operator'}-${randomUUID()}`;
        try {
          await (dependencies.sqs ?? new SQSClient({})).send(new SendMessageCommand({
            QueueUrl: fleet.queueUrl,
            MessageBody: JSON.stringify(provider.replayMessage(sourceId, changedAt, runId)),
            MessageGroupId: sourceId,
            MessageDeduplicationId: runId,
          }));
        } catch (error) {
          if (action !== 'recover') throw error;
          const enqueueFailed = {
            ...updated,
            incidentState: base.incidentState ?? 'open' as const,
            incidentUpdatedAt: changedAt,
          };
          if (base.incidentAcknowledgedAt) enqueueFailed.incidentAcknowledgedAt = base.incidentAcknowledgedAt;
          else delete enqueueFailed.incidentAcknowledgedAt;
          await dependencies.store.putSourceHealth(enqueueFailed);
          console.error(JSON.stringify({ event: 'source_recovery_enqueue_failed', sourceId, provider: source.provider, runId, actor }));
          return reply(503, { code: 'RECOVERY_ENQUEUE_FAILED', message: 'Recovery validation could not be queued.' });
        }
        console.log(JSON.stringify({ event: action === 'recover' ? 'source_recovery_requested' : 'source_replay_requested', sourceId, provider: source.provider, runId, actor }));
        return reply(202, { sourceId, action, runId, queuedAt: changedAt, ...(action === 'recover' ? { sourceStatus: 'paused' } : {}) });
      }
      await dependencies.store.putSourceHealth(updated);
      console.log(JSON.stringify({
        event: action === 'pause' || action === 'resume' || action === 'set-tier' || action === 'quarantine'
          ? 'source_setting_changed'
          : 'source_incident_state_changed',
        sourceId,
        provider: source.provider,
        action,
        actor,
        configVersion: updated.configVersion,
      }));
      return reply(200, { sourceId, action, health: updated });
    }
    if (method !== 'GET') return reply(405, { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' });

    if (path === '/operations/sources') {
      let configuredFleets: FleetConfiguration;
      let configurationDiscoveryUnavailable = false;
      try {
        configuredFleets = await providerFleets(
          configuredFleetInput(dependencies),
          dependencies.ssm ?? new SSMClient({}),
          dependencies.parameterPrefix,
        );
      } catch {
        configuredFleets = configuredFleetInput(dependencies);
        configurationDiscoveryUnavailable = true;
      }
      const cloudwatch = dependencies.cloudwatch ?? new CloudWatchClient({});
      const [providerTelemetry, allApplicationAlarms, legacyPendingNotifications] = await Promise.all([
        Promise.all(catalogProviderDefinitions.map(async (provider) => {
          const configuration = configuredFleets[provider.id];
          const unavailableReasons = [
            ...(!configuration?.queueUrl ? ['Work queue is not configured.'] : []),
            ...(!configuration?.deadLetterQueueUrl ? ['Dead-letter queue is not configured.'] : []),
            ...(configurationDiscoveryUnavailable ? ['Runtime provider configuration could not be discovered.'] : []),
          ];
          if (unavailableReasons.length) return { provider, unavailableReasons };
          const queueUrl = configuration?.queueUrl;
          const deadLetterQueueUrl = configuration?.deadLetterQueueUrl;
          if (!queueUrl || !deadLetterQueueUrl) return { provider, unavailableReasons: ['Fleet queues are not configured.'] };
          try {
            const fleet = await fleetStatus(
              provider,
              { queueUrl, deadLetterQueueUrl },
              dependencies.sqs ?? new SQSClient({}),
              cloudwatch,
            );
            return { provider, unavailableReasons: [], fleet };
          } catch {
            return { provider, unavailableReasons: ['Fleet telemetry is unavailable.'] };
          }
        })),
        applicationAlarms(cloudwatch),
        dependencies.store.pendingSms().then((jobs) => jobs.length),
      ]);
      const fleetRows = providerTelemetry.flatMap((entry) => entry.fleet ? [entry.fleet] : []);
      const alarmsByName = new Map(allApplicationAlarms.flatMap((alarm) => alarm.name ? [[alarm.name, alarm] as const] : []));
      for (const alarm of fleetRows.flatMap((row) => row.alarms)) {
        if (alarm.name) alarmsByName.set(alarm.name, alarm);
      }
      const queueTelemetry = dependencies.queueTelemetry ?? { status: 'available' as const };
      const queue = fleetRows.reduce((total, row) => ({
          waiting: total.waiting + row.queue.waiting,
          backlogCount: total.backlogCount + row.queue.backlogCount,
          processing: total.processing + row.queue.processing,
          deadLettered: total.deadLettered + row.queue.deadLettered,
        }), { waiting: 0, backlogCount: 0, processing: 0, deadLettered: 0 });
      const oldestMessageTimestamps = fleetRows.flatMap((row) => row.queue.oldestMessageTimestampMs === null
        ? [] : [row.queue.oldestMessageTimestampMs]);
      const fleet = {
        queue: {
          ...queue,
          oldestMessageTimestampMs: oldestMessageTimestamps.length ? Math.min(...oldestMessageTimestamps) : null,
          processing: queueTelemetry.status === 'available' ? queue.processing : null,
        },
        queueTelemetry,
        alarms: [...alarmsByName.values()],
        alarmTelemetry: dependencies.alarmTelemetry ?? { status: 'available' as const },
      };
      const cutoff = timestamp - 24 * 60 * 60_000;
      const failedExtractions24h = healthRecords.reduce((total, record) => total + (record.recentRuns ?? [])
        .filter((run) => run.state !== 'succeeded' && Date.parse(run.completedAt) >= cutoff).length, 0);
      const productionMetrics = {
        deadLetterMessages: fleet.queue.deadLettered,
        failedExtractions24h,
        staleSources: rows.filter((row) => row.state === 'degraded' || row.state === 'never-succeeded').length,
        quarantinedSources: rows.filter((row) => row.state === 'quarantined').length,
        pausedSources: rows.filter((row) => row.sourceStatus === 'paused').length,
        activeAlarms: fleet.alarmTelemetry.status === 'available'
          ? fleet.alarms.filter((alarm) => alarm.state === 'ALARM').length
          : null,
        queuedMessages: fleet.queue.waiting,
        processingMessages: fleet.queue.processing,
        // The same predicate the provider crons alarm on, so an operator can see
        // which published sources missed an interval before the daily email.
        overduePublishedSources: sources.filter((source) => source.mode === 'published'
          && missedPublishedInterval('published', health.get(source.sourceId), new Date(timestamp))).length,
        legacyPendingNotifications,
      };
      const order: Record<SourceHealthState, number> = { quarantined: 0, degraded: 1, 'never-succeeded': 2, healthy: 3 };
      return reply(200, {
        generatedAt: new Date(timestamp).toISOString(),
        providers: providerTelemetry.map(({ provider, unavailableReasons, fleet: providerFleet }) => ({
          id: provider.id,
          displayName: provider.displayName,
          category: provider.category,
          regions: provider.regions,
          defaultRegion: provider.defaultRegion,
          availability: unavailableReasons.length ? 'unavailable' : 'available',
          unavailableReasons,
          sourceActions: provider.sourceActions,
          workflows: provider.workflows,
          ...(providerFleet ? { fleet: providerFleet } : {}),
        })),
        sources: rows,
        reliabilityRanking: [...rows].sort((a, b) => order[a.state] - order[b.state] || b.consecutiveFailures - a.consecutiveFailures || a.source.displayName.localeCompare(b.source.displayName)),
        fleet,
        fleets: fleetRows,
        productionMetrics,
        checklist: publicMonitoringChecklist(storedChecklist, checklistPeriod),
      });
    }
    const match = path.match(/^\/operations\/sources\/([^/]+)$/);
    if (!match) return reply(404, { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' });
    const sourceId = decodeURIComponent(match[1]);
    const row = rows.find((candidate) => candidate.source.sourceId === sourceId);
    const record = health.get(sourceId) ?? await dependencies.store.getSourceHealth(sourceId);
    if (!row && !record) return reply(404, { code: 'SOURCE_NOT_FOUND', message: 'Source not found.' });
    if (!row) {
      return reply(200, {
        generatedAt: new Date(timestamp).toISOString(),
        historical: true,
        source: {
          sourceId,
          provider: record!.provider,
          region: record!.region,
          displayName: sourceId,
          mode: 'historical',
        },
        state: record!.state ?? 'never-succeeded',
        health: record,
        recentRuns: record!.recentRuns ?? [],
      });
    }
    return reply(200, {
      generatedAt: new Date(timestamp).toISOString(),
      ...row,
      health: { state: row.state, ageSeconds: row.ageSeconds },
      recentRuns: record?.recentRuns ?? [],
    });
  };
}

/** Backward-compatible name retained for existing imports and the stable stack. */
export const createGreenhouseOperationsHandler = createSourceOperationsHandler;

const tableName = process.env.INTERNSHIPS_TABLE;
const queueUrl = process.env.GREENHOUSE_QUEUE_URL;
const deadLetterQueueUrl = process.env.GREENHOUSE_DEAD_LETTER_QUEUE_URL;
const sharedSecret = process.env.OPERATIONS_SHARED_SECRET;
const parameterPrefix = process.env.OPERATIONS_PROVIDER_PARAMETER_PREFIX;

export const handler = async (event: ApiEvent) => {
  if (!tableName || !sharedSecret || ((!queueUrl || !deadLetterQueueUrl) && !parameterPrefix)) {
    return reply(500, { code: 'OPERATIONS_NOT_CONFIGURED', message: 'Source operations data is not configured.' });
  }
  return createSourceOperationsHandler({
    store: new DynamoInternshipStore(tableName),
    queueUrl,
    deadLetterQueueUrl,
    parameterPrefix,
    sharedSecret,
  })(event);
};
