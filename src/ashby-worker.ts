import { createSourceUrlValidator, type ApplicationUrlValidator } from './core/application-url.js';
import { ExpoPushPublisher, sendNewJobNotifications } from './notifications.js';
import { Poller } from './poll.js';
import { reviewedAshbySources, type ReviewedAshbySource } from './sources/ashby-config.js';
import { AshbyPostingsAdapter } from './sources/ashby.js';
import { SourceFetchError } from './sources/source-error.js';
import { ApplicationLinkValidationError, failedSourceHealth, safeDiagnostic, sourceFailureCategory, successfulSourceHealth } from './source-health.js';
import { DynamoInternshipStore, DynamoUserStore, type InternshipStore, type UserStore } from './store.js';
import type { SourceCheckpoint, SourceFetchResult } from './types.js';
import type { AshbyWorkMessage } from './ashby-dispatch.js';
import { processFifoBatch } from './sqs-fifo-batch.js';
import { legacyDeliveryExclusions, loadGroupedNotificationCohort, type GroupedNotificationCohort } from './grouped-notification-cohort.js';
import type { CatalogAdmissionResolver, DestinationVerificationRequest } from './destination-verification.js';

const SHADOW_CHECKPOINT_PREFIX = 'shadow-';
const SHADOW_LINK_CONCURRENCY = 4;
const SHADOW_LINK_FAILURE_THRESHOLD = 0.2;

type SourceRunFailure = 'fetch' | 'schema' | 'identity' | 'link' | 'empty' | 'quality' | 'persistence';

export function ashbySourceRunFailure(category: string | undefined): SourceRunFailure {
  if (category === 'json') return 'schema';
  if (category === 'identity') return 'identity';
  if (category === 'link') return 'link';
  if (category === 'empty') return 'empty';
  if (category === 'quality') return 'quality';
  if (category === 'persistence') return 'persistence';
  return 'fetch';
}

interface QueueRecord {
  messageId: string;
  body: string;
  attributes?: { MessageGroupId?: string };
}

interface QueueEvent {
  Records: QueueRecord[];
}

export interface AshbyBoardDependencies {
  store: InternshipStore;
  userStore?: UserStore;
  publisher?: ExpoPushPublisher;
  sources?: ReviewedAshbySource[];
  fetchImpl?: typeof fetch;
  linkValidator?: ApplicationUrlValidator;
  groupedNotificationCohort?: GroupedNotificationCohort;
  enqueueDestinationVerification?: (request: DestinationVerificationRequest) => Promise<void>;
  catalogAdmissionResolver?: CatalogAdmissionResolver;
  sleep?: (milliseconds: number) => Promise<void>;
  onRecordFailure?: (record: QueueRecord, error: unknown) => Promise<void> | void;
}

export interface AshbyBoardResult {
  sourceId: string;
  mode: 'shadow' | 'published';
  skipped?: 'paused' | 'backoff';
  notModified: boolean;
  listings: number;
  notifications: { sent: number; skipped: number; failed: number };
}

function parseWorkMessage(body: string): AshbyWorkMessage {
  const parsed = JSON.parse(body) as Partial<AshbyWorkMessage>;
  if (parsed.version !== 1 || typeof parsed.sourceId !== 'string' || typeof parsed.scheduledAt !== 'string') {
    throw new Error('Invalid Ashby work message');
  }
  if (!Number.isFinite(Date.parse(parsed.scheduledAt))) throw new Error('Invalid Ashby work message timestamp');
  return parsed as AshbyWorkMessage;
}

async function fetchShadowWithRetry(
  adapter: AshbyPostingsAdapter,
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
      console.log(JSON.stringify({
        event: 'source_fetch_retry_scheduled',
        provider: 'ashby',
        sourceId: adapter.id,
        attempt: attempt + 2,
        delayMs: delay,
      }));
      await sleep(delay);
    }
  }
  throw lastError;
}

function emitShadowSuccess(
  sourceId: string,
  outcome: string,
  durationMs: number,
  raw: number,
  eligible: number,
  withheld: number,
  applicationLinksChecked: number,
  applicationLinkFailures: number,
) {
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
          { Name: 'ApplicationLinksChecked', Unit: 'Count' },
          { Name: 'ApplicationLinkFailures', Unit: 'Count' },
        ],
      }],
    },
    event: 'source_fetch_completed',
    sourceId,
    provider: 'ashby',
    region: 'global',
    outcome,
    SourceFetchSuccess: 1,
    SourceFetchDurationMs: durationMs,
    RawListingCount: raw,
    EligibleListingCount: eligible,
    ListingWithheld: withheld,
    ApplicationLinksChecked: applicationLinksChecked,
    ApplicationLinkFailures: applicationLinkFailures,
  }));
}

function validatorFor(source: ReviewedAshbySource, fetchImpl?: typeof fetch): ApplicationUrlValidator {
  const allowedHosts = source.allowedApplicationHosts.map(({ host }) => host);
  const policy = { allowedInitialHosts: allowedHosts, allowedFinalHosts: allowedHosts };
  return fetchImpl ? createSourceUrlValidator(policy, fetchImpl) : createSourceUrlValidator(policy);
}

async function validateShadowLinks(
  listings: Awaited<ReturnType<AshbyPostingsAdapter['fetch']>>['listings'],
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
    throw new ApplicationLinkValidationError('Ashby', failures, listings.length, samples);
  }
  return { checked: listings.length, failures };
}

export async function runAshbyBoard(
  message: AshbyWorkMessage,
  dependencies: AshbyBoardDependencies,
): Promise<AshbyBoardResult> {
  const registry = dependencies.sources ?? reviewedAshbySources;
  const source = registry.find((candidate) => candidate.id === message.sourceId);
  if (!source) throw new Error(`Unknown reviewed Ashby source ${JSON.stringify(message.sourceId)}`);
  const mode = source.status;
  const sourceHealth = await dependencies.store.getSourceHealth(source.id);
  if (!message.force && (sourceHealth?.sourceStatus === 'paused' || sourceHealth?.state === 'quarantined')) {
    return { sourceId: source.id, mode, skipped: 'paused', notModified: true, listings: 0, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  if (!message.force && sourceHealth?.backoffUntil && Date.parse(sourceHealth.backoffUntil) > Date.now()) {
    return { sourceId: source.id, mode, skipped: 'backoff', notModified: true, listings: 0, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  const checkpointId = mode === 'shadow' ? `${SHADOW_CHECKPOINT_PREFIX}${source.id}` : source.id;
  const adapter = new AshbyPostingsAdapter({
    source,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const validate = dependencies.linkValidator ?? validatorFor(source, dependencies.fetchImpl);

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
      let linkValidation = {
        checked: previousHealth?.applicationLinksChecked ?? 0,
        failures: previousHealth?.applicationLinkFailures ?? 0,
      };
      const needsLinkEvidenceBackfill = previousHealth?.applicationLinksChecked === undefined
        || previousHealth.applicationLinkFailures === undefined;
      if (!result.notModified || (result.unchangedReason === 'content_hash' && needsLinkEvidenceBackfill)) {
        // An owner-acknowledged empty board is dormant, so its zero rows are expected.
        if (!source.emptyBoardAcknowledged && (previous?.lastRawCount ?? 0) > 0 && (result.rawRowCount ?? 0) === 0) {
          throw new SourceFetchError(`${source.id}: rejected an unexpected raw-zero snapshot`, 'empty');
        }
        linkValidation = await validateShadowLinks(result.listings, validate);
      }
      await dependencies.store.putCheckpoint({ ...result.checkpoint, sourceId: checkpointId });
      const completedAt = new Date().toISOString();
      const counts = result.processed?.counts;
      const unchanged304 = result.unchangedReason === 'not_modified';
      const health = {
        ...successfulSourceHealth({
          sourceId: source.id,
          employerId: source.id.replace(/^ashby-/, ''),
          provider: 'ashby',
          region: source.identity.apiRegion,
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
        }),
        applicationLinksChecked: linkValidation.checked,
        applicationLinkFailures: linkValidation.failures,
      };
      await dependencies.store.putSourceHealth(health);
      emitShadowSuccess(
        source.id,
        health.outcome ?? 'success_changed',
        Date.now() - started,
        health.rawRows ?? 0,
        health.eligibleRows ?? 0,
        health.withheldRows ?? 0,
        health.applicationLinksChecked,
        health.applicationLinkFailures,
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
        employerId: source.id.replace(/^ashby-/, ''),
        provider: 'ashby',
        region: source.identity.apiRegion,
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
      const sourceRunFailure = ashbySourceRunFailure(failureHealth.failureCategory);
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
        provider: 'ashby',
        region: source.identity.apiRegion,
        category: sourceRunFailure,
        internalCategory: failureHealth.failureCategory,
        SourceRunFailure: sourceRunFailure,
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
    dependencies.enqueueDestinationVerification, dependencies.catalogAdmissionResolver).poll({
    runId: message.runId,
    // Published Ashby boards already tolerate a complete empty snapshot, so an
    // `emptyBoardAcknowledged` declaration only changes the shadow guard above.
    allowCompleteEmptySnapshot: true,
    naturalProviderPoll: !message.force,
  });
  if (poll.failures.length) throw new Error(poll.failures.join('; '));
  const publishedHealth = await dependencies.store.getSourceHealth(source.id);
  if (publishedHealth) {
    await dependencies.store.putSourceHealth({
      ...publishedHealth,
      employerId: source.id.replace(/^ashby-/, ''),
      provider: 'ashby',
      region: source.identity.apiRegion,
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

export async function processAshbyQueue(
  event: QueueEvent,
  dependencies: AshbyBoardDependencies,
  context?: { awsRequestId?: string },
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  return processFifoBatch(event.Records, async (record) => {
    try {
      const parsed = parseWorkMessage(record.body);
      const result = await runAshbyBoard(
        parsed.runId ? parsed : { ...parsed, runId: context?.awsRequestId },
        dependencies,
      );
      console.log(JSON.stringify({
        event: 'source_poll_completed',
        command: 'ashby-poll',
        runId: parsed.runId ?? context?.awsRequestId,
        ...result,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        command: 'ashby-poll',
        messageId: record.messageId,
        error: safeDiagnostic(error),
      }));
      throw error;
    }
  }, undefined, dependencies.onRecordFailure);
}

export async function handler(
  event: QueueEvent,
  context?: { awsRequestId?: string },
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const tableName = process.env.INTERNSHIPS_TABLE;
  const usersTable = process.env.USERS_TABLE;
  if (!tableName || !usersTable) throw new Error('INTERNSHIPS_TABLE and USERS_TABLE are required');
  const cohortParameterName = process.env.GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME;
  if (!cohortParameterName) throw new Error('GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME is required');
  return processAshbyQueue(event, {
    store: new DynamoInternshipStore(tableName),
    userStore: new DynamoUserStore(usersTable),
    groupedNotificationCohort: await loadGroupedNotificationCohort(cohortParameterName),
  }, context);
}
