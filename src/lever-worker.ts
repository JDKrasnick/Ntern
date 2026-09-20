import { createSourceUrlValidator, type ApplicationUrlValidator } from './core/application-url.js';
import { ExpoPushPublisher, sendNewJobNotifications } from './notifications.js';
import { Poller } from './poll.js';
import { reviewedLeverSources, type ReviewedLeverSource } from './sources/lever-config.js';
import { LeverPostingsAdapter } from './sources/lever.js';
import { qualityPolicyFor, verifySourceQuality } from './sources/quality.js';
import { SourceFetchError } from './sources/source-error.js';
import { ApplicationLinkValidationError, failedSourceHealth, safeDiagnostic, sourceFailureCategory, successfulSourceHealth } from './source-health.js';
import { SOURCE_RETRY_DELAY_CAP_MS } from './source-poll-cadence.js';
import { type InternshipStore, type UserStore } from './store.js';
import type { SourceCheckpoint, SourceFetchResult } from './types.js';
import type { LeverWorkMessage } from './lever-dispatch.js';
import { processFifoBatch } from './sqs-fifo-batch.js';
import { legacyDeliveryExclusions, type GroupedNotificationCohort } from './grouped-notification-cohort.js';
import type { CatalogAdmissionResolver, DestinationVerificationRequest } from './destination-verification.js';

const SHADOW_CHECKPOINT_PREFIX = 'shadow-';
const SHADOW_LINK_CONCURRENCY = 4;
const SHADOW_LINK_FAILURE_THRESHOLD = 0.2;

interface QueueRecord {
  messageId: string;
  body: string;
  attributes?: { MessageGroupId?: string };
}

interface QueueEvent {
  Records: QueueRecord[];
}

export interface LeverBoardDependencies {
  store: InternshipStore;
  userStore?: UserStore;
  publisher?: ExpoPushPublisher;
  sources?: ReviewedLeverSource[];
  fetchImpl?: typeof fetch;
  linkValidator?: ApplicationUrlValidator;
  groupedNotificationCohort?: GroupedNotificationCohort;
  enqueueDestinationVerification?: (request: DestinationVerificationRequest) => Promise<void>;
  catalogAdmissionResolver?: CatalogAdmissionResolver;
  sleep?: (milliseconds: number) => Promise<void>;
  onRecordFailure?: (record: QueueRecord, error: unknown) => Promise<void> | void;
  messageDeadlineMs?: number;
}

export interface LeverBoardResult {
  sourceId: string;
  mode: 'shadow' | 'published';
  skipped?: 'paused' | 'backoff';
  notModified: boolean;
  listings: number;
  notifications: { sent: number; skipped: number; failed: number };
}

function parseWorkMessage(body: string): LeverWorkMessage {
  const parsed = JSON.parse(body) as Partial<LeverWorkMessage>;
  if (parsed.version !== 1 || typeof parsed.sourceId !== 'string' || typeof parsed.scheduledAt !== 'string') {
    throw new Error('Invalid Lever work message');
  }
  if (!Number.isFinite(Date.parse(parsed.scheduledAt))) throw new Error('Invalid Lever work message timestamp');
  return parsed as LeverWorkMessage;
}

async function fetchShadowWithRetry(
  adapter: LeverPostingsAdapter,
  checkpoint: SourceCheckpoint | undefined,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<SourceFetchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await adapter.fetch(checkpoint);
    } catch (error) {
      lastError = error;
      if (!(error instanceof SourceFetchError) || !error.retryable || attempt === 2) throw error;
      const delay = Math.max(error.retryAfterMs ?? 0, 250 * (2 ** attempt));
      // A provider Retry-After beyond the cap belongs to the durable backoff and
      // the queue retry path, not to a consumer slot parked for minutes.
      if (delay > SOURCE_RETRY_DELAY_CAP_MS) throw error;
      console.log(JSON.stringify({
        event: 'source_fetch_retry_scheduled',
        provider: 'lever',
        sourceId: adapter.id,
        attempt: attempt + 2,
        delayMs: delay,
      }));
      await sleep(delay);
    }
  }
  throw lastError;
}

function emitShadowSuccess(sourceId: string, outcome: string, durationMs: number, raw: number, eligible: number, withheld: number) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'InternNotifs/Ingestion',
        Dimensions: [['provider', 'region', 'outcome']],
        Metrics: [
          { Name: 'SourceFetchSuccess', Unit: 'Count' },
          { Name: 'SourceFetchDurationMs', Unit: 'Milliseconds' },
          { Name: 'RawListingCount', Unit: 'Count' },
          { Name: 'EligibleListingCount', Unit: 'Count' },
          { Name: 'ListingWithheld', Unit: 'Count' },
        ],
      }],
    },
    event: 'source_fetch_completed',
    sourceId,
    provider: 'lever',
    region: 'global',
    outcome,
    SourceFetchSuccess: 1,
    SourceFetchDurationMs: durationMs,
    RawListingCount: raw,
    EligibleListingCount: eligible,
    ListingWithheld: withheld,
  }));
}

function validatorFor(fetchImpl?: typeof fetch): ApplicationUrlValidator {
  const policy = { allowedInitialHosts: ['jobs.lever.co'], allowedFinalHosts: ['jobs.lever.co'] };
  return fetchImpl ? createSourceUrlValidator(policy, fetchImpl) : createSourceUrlValidator(policy);
}

async function validateShadowLinks(
  listings: Awaited<ReturnType<LeverPostingsAdapter['fetch']>>['listings'],
  validate: ApplicationUrlValidator,
) {
  let next = 0;
  let failures = 0;
  const samples: Array<{ category: ReturnType<typeof sourceFailureCategory>; diagnostic: string }> = [];
  const worker = async () => {
    while (next < listings.length) {
      const listing = listings[next++];
      try {
        await validate(listing.applyUrl);
      } catch (error) {
        failures += 1;
        if (samples.length < 5) samples.push({ category: sourceFailureCategory(error), diagnostic: safeDiagnostic(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHADOW_LINK_CONCURRENCY, listings.length) }, worker));
  if (listings.length && failures / listings.length > SHADOW_LINK_FAILURE_THRESHOLD) {
    throw new ApplicationLinkValidationError('Lever', failures, listings.length, samples);
  }
}

export async function runLeverBoard(
  message: LeverWorkMessage,
  dependencies: LeverBoardDependencies,
): Promise<LeverBoardResult> {
  const dynamic = dependencies.sources || !dependencies.store.listLeverAdmissions
    ? []
    : (await dependencies.store.listLeverAdmissions()).map(({ source }) => source);
  const registry = dependencies.sources ?? [...reviewedLeverSources, ...dynamic];
  const source = registry.find((candidate) => candidate.id === message.sourceId);
  if (!source) throw new Error(`Unknown reviewed Lever source ${JSON.stringify(message.sourceId)}`);
  const mode = source.status;
  const sourceHealth = await dependencies.store.getSourceHealth(source.id);
  if (!message.force && (sourceHealth?.sourceStatus === 'paused' || sourceHealth?.state === 'quarantined')) {
    return { sourceId: source.id, mode, skipped: 'paused', notModified: true, listings: 0, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  if (!message.force && sourceHealth?.backoffUntil && Date.parse(sourceHealth.backoffUntil) > Date.now()) {
    return { sourceId: source.id, mode, skipped: 'backoff', notModified: true, listings: 0, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  const checkpointId = mode === 'shadow' ? `${SHADOW_CHECKPOINT_PREFIX}${source.id}` : source.id;
  const adapter = new LeverPostingsAdapter({
    id: source.id,
    company: source.company,
    site: source.site,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const validate = dependencies.linkValidator ?? validatorFor(dependencies.fetchImpl);

  if (mode === 'shadow') {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const previous = await dependencies.store.getCheckpoint(checkpointId);
    const previousHealth = sourceHealth;
    try {
      const result = await fetchShadowWithRetry(
        adapter,
        previous,
        dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      );
      if (!result.notModified) {
        const policy = reviewedLeverSources.some(({ id }) => id === source.id)
          ? qualityPolicyFor(source.id)
          : { id: source.id, sourceClass: 'lever' as const, leverSite: source.site };
        const quality = verifySourceQuality([{ policy, result, previous }]);
        if (quality.failures.length) throw new SourceFetchError(quality.failures.join('; '), 'quality');
        await validateShadowLinks(result.listings, validate);
      }
      await dependencies.store.putCheckpoint({ ...result.checkpoint, sourceId: checkpointId });
      const completedAt = new Date().toISOString();
      const counts = result.processed?.counts;
      const unchanged304 = result.unchangedReason === 'not_modified';
      const health = successfulSourceHealth({
        sourceId: source.id,
        employerId: source.id.replace(/^lever-/, ''),
        provider: 'lever',
        region: source.region,
        previous: previousHealth,
        startedAt,
        completedAt,
        runId: message.runId,
        outcome: !result.notModified
          ? 'success_changed'
          : result.unchangedReason === 'not_modified' ? 'success_unchanged_304' : 'success_unchanged_hash',
        etag: result.checkpoint.etag,
        contentHash: result.checkpoint.contentHash,
        rawRows: unchanged304 ? previous?.lastRawCount ?? previousHealth?.rawRows : counts?.raw ?? result.rawRowCount,
        validRows: unchanged304 ? previousHealth?.validRows : counts?.valid,
        eligibleRows: unchanged304 ? previous?.lastRowCount ?? previousHealth?.eligibleRows : counts?.eligible ?? result.listings.length,
        filteredRows: unchanged304 ? previousHealth?.filteredRows : counts?.filtered,
        withheldRows: unchanged304 ? previous?.lastWithheldRowCount ?? previousHealth?.withheldRows : counts?.withheld ?? result.rejectedApplicationUrls?.length,
      });
      await dependencies.store.putSourceHealth(health);
      emitShadowSuccess(
        source.id,
        health.outcome ?? 'success_changed',
        Date.now() - started,
        health.rawRows ?? 0,
        health.eligibleRows ?? 0,
        health.withheldRows ?? 0,
      );
      return {
        sourceId: source.id,
        mode,
        notModified: result.notModified,
        listings: result.notModified ? previous?.lastRowCount ?? 0 : result.listings.length,
        notifications: { sent: 0, skipped: 0, failed: 0 },
      };
    } catch (error) {
      const completedAt = new Date().toISOString();
      const failureHealth = failedSourceHealth({
        sourceId: source.id,
        employerId: source.id.replace(/^lever-/, ''),
        provider: 'lever',
        region: source.region,
        previous: previousHealth,
        startedAt,
        completedAt,
        runId: message.runId,
        error,
      });
      try {
        await dependencies.store.putSourceHealth(failureHealth);
      } catch {
        // Preserve the original provider or validation failure as the SQS result.
      }
      const snapshotRejected = ['json', 'identity', 'link', 'empty', 'quality'].includes(failureHealth.failureCategory ?? '') ? 1 : 0;
      console.error(JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [{
            Namespace: 'InternNotifs/Ingestion',
            Dimensions: [['provider', 'region', 'category']],
            Metrics: [
              { Name: 'SourceFetchFailure', Unit: 'Count' },
              { Name: 'SourceFetchDurationMs', Unit: 'Milliseconds' },
              { Name: 'SnapshotRejected', Unit: 'Count' },
            ],
          }],
        },
        event: 'source_fetch_failed',
        runId: message.runId,
        sourceId: source.id,
        provider: 'lever',
        region: source.region,
        category: failureHealth.failureCategory,
        outcome: failureHealth.outcome,
        diagnostic: failureHealth.diagnostic,
        backoffUntil: failureHealth.backoffUntil,
        catalogPreserved: true,
        SourceFetchFailure: 1,
        SourceFetchDurationMs: failureHealth.durationMs,
        SnapshotRejected: snapshotRejected,
      }));
      throw error;
    }
  }

  const poll = await new Poller([adapter], dependencies.store, undefined, undefined, validate, false,
    dependencies.enqueueDestinationVerification, dependencies.catalogAdmissionResolver).poll({ runId: message.runId,
      naturalProviderPoll: !message.force });
  if (poll.failures.length) throw new Error(poll.failures.join('; '));
  const publishedHealth = await dependencies.store.getSourceHealth(source.id);
  if (publishedHealth) {
    await dependencies.store.putSourceHealth({
      ...publishedHealth,
      employerId: source.id.replace(/^lever-/, ''),
      provider: 'lever',
      region: source.region,
    });
  }
  const notifications = dependencies.userStore
    ? await sendNewJobNotifications(
      poll.newJobs.filter((job) => job.technical !== false),
      dependencies.userStore,
      dependencies.publisher ?? new ExpoPushPublisher(),
      undefined,
      undefined,
      legacyDeliveryExclusions(dependencies.groupedNotificationCohort ?? new Set()),
    )
    : { sent: 0, skipped: 0, failed: 0 };
  return {
    sourceId: source.id,
    mode,
    notModified: poll.unchangedSources.includes(adapter.id),
    listings: poll.processedListings,
    notifications,
  };
}

export async function processLeverQueue(
  event: QueueEvent,
  dependencies: LeverBoardDependencies,
  context?: { awsRequestId?: string },
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  return processFifoBatch(event.Records, async (record) => {
    try {
      const parsed = parseWorkMessage(record.body);
      const result = await runLeverBoard(
        parsed.runId ? parsed : { ...parsed, runId: context?.awsRequestId },
        dependencies,
      );
      console.log(JSON.stringify({
        event: 'source_poll_completed',
        command: 'lever-poll',
        runId: parsed.runId ?? context?.awsRequestId,
        ...result,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        command: 'lever-poll',
        messageId: record.messageId,
        error: safeDiagnostic(error),
      }));
      throw error;
    }
  }, undefined, dependencies.onRecordFailure, dependencies.messageDeadlineMs);
}
