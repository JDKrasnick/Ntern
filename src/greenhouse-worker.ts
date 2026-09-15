import { createSourceUrlValidator, type ApplicationUrlValidator } from './core/application-url.js';
import { ExpoPushPublisher, sendNewJobNotifications } from './notifications.js';
import { Poller } from './poll.js';
import { reviewedGreenhouseSources, type ReviewedGreenhouseSource } from './sources/greenhouse-config.js';
import { GreenhouseBoardAdapter } from './sources/greenhouse.js';
import { greenhouseQualityPolicy, verifySourceQuality } from './sources/quality.js';
import { DynamoInternshipStore, DynamoUserStore, type InternshipStore, type UserStore } from './store.js';
import type { GreenhouseWorkMessage } from './greenhouse-dispatch.js';
import { ApplicationLinkValidationError, failedSourceHealth, safeDiagnostic, sourceFailureCategory, successfulSourceHealth } from './source-health.js';
import { processFifoBatch } from './sqs-fifo-batch.js';
import { legacyDeliveryExclusions, loadGroupedNotificationCohort, type GroupedNotificationCohort } from './grouped-notification-cohort.js';
import type { CatalogAdmissionResolver, DestinationVerificationRequest } from './destination-verification.js';
import { integrationRegistry } from './integration-registry.js';

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

export interface GreenhouseBoardDependencies {
  store: InternshipStore;
  userStore?: UserStore;
  publisher?: ExpoPushPublisher;
  sources?: ReviewedGreenhouseSource[];
  fetchImpl?: typeof fetch;
  linkValidator?: ApplicationUrlValidator;
  groupedNotificationCohort?: GroupedNotificationCohort;
  enqueueDestinationVerification?: (request: DestinationVerificationRequest) => Promise<void>;
  catalogAdmissionResolver?: CatalogAdmissionResolver;
  onRecordFailure?: (record: QueueRecord, error: unknown) => Promise<void> | void;
}

export interface GreenhouseBoardResult {
  sourceId: string;
  mode: 'shadow' | 'published';
  skipped?: 'paused' | 'backoff';
  notModified: boolean;
  listings: number;
  rawRows?: number;
  withheldRows?: number;
  notifications: { sent: number; skipped: number; failed: number };
}

function parseWorkMessage(body: string): GreenhouseWorkMessage {
  const parsed = JSON.parse(body) as Partial<GreenhouseWorkMessage>;
  if (parsed.version !== 1 || typeof parsed.sourceId !== 'string' || typeof parsed.scheduledAt !== 'string') {
    throw new Error('Invalid Greenhouse work message');
  }
  if (!Number.isFinite(Date.parse(parsed.scheduledAt))) throw new Error('Invalid Greenhouse work message timestamp');
  return parsed as GreenhouseWorkMessage;
}

function validatorFor(source: ReviewedGreenhouseSource, fetchImpl?: typeof fetch): ApplicationUrlValidator {
  const policy = { allowedInitialHosts: source.allowedInitialHosts, allowedFinalHosts: source.allowedFinalHosts };
  return fetchImpl ? createSourceUrlValidator(policy, fetchImpl) : createSourceUrlValidator(policy);
}

async function validateShadowLinks(listings: Awaited<ReturnType<GreenhouseBoardAdapter['fetch']>>['listings'], validate: ApplicationUrlValidator) {
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
    throw new ApplicationLinkValidationError('Greenhouse', failures, listings.length, samples);
  }
}

export async function runGreenhouseBoard(
  message: GreenhouseWorkMessage,
  dependencies: GreenhouseBoardDependencies,
): Promise<GreenhouseBoardResult> {
  const registry = dependencies.sources ?? reviewedGreenhouseSources;
  const source = registry.find((candidate) => candidate.id === message.sourceId);
  if (!source) throw new Error(`Unknown reviewed Greenhouse source ${JSON.stringify(message.sourceId)}`);
  const mode = source.status;
  const sourceHealth = await dependencies.store.getSourceHealth(source.id);
  if (!message.force && (sourceHealth?.sourceStatus === 'paused' || sourceHealth?.state === 'quarantined')) {
    return { sourceId: source.id, mode, skipped: 'paused', notModified: true, listings: 0, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  if (!message.force && sourceHealth?.backoffUntil && Date.parse(sourceHealth.backoffUntil) > Date.now()) {
    return { sourceId: source.id, mode, skipped: 'backoff', notModified: true, listings: 0, notifications: { sent: 0, skipped: 0, failed: 0 } };
  }
  const checkpointId = mode === 'shadow' ? `${SHADOW_CHECKPOINT_PREFIX}${source.id}` : source.id;
  const adapter = new GreenhouseBoardAdapter({
    source,
    checkpointId,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const validate = dependencies.linkValidator ?? validatorFor(source, dependencies.fetchImpl);

  if (mode === 'shadow') {
    const previous = await dependencies.store.getCheckpoint(checkpointId);
    const result = await adapter.fetch(previous);
    if (!result.notModified) {
      const quality = verifySourceQuality([{ policy: greenhouseQualityPolicy(source), result, previous }]);
      if (quality.failures.length) throw new Error(quality.failures.join('; '));
      await validateShadowLinks(result.listings, validate);
    }
    await dependencies.store.putCheckpoint(result.checkpoint);
    return {
      sourceId: source.id,
      mode,
      notModified: result.notModified,
      listings: result.notModified ? previous?.lastRowCount ?? 0 : result.listings.length,
      rawRows: result.checkpoint.lastRawRowCount,
      withheldRows: result.checkpoint.lastWithheldRowCount,
      notifications: { sent: 0, skipped: 0, failed: 0 },
    };
  }

  const poll = await new Poller([adapter], dependencies.store, undefined, undefined, validate, false,
    dependencies.enqueueDestinationVerification, dependencies.catalogAdmissionResolver).poll({ naturalProviderPoll: !message.force });
  // An outer fetch or persistence failure aborts the whole source and must
  // never be acknowledged as a successful poll: retry the queue message so
  // resilientD1 and the bounded queue retries can apply. Only a sparse set of
  // per-row link-validation failures is tolerated.
  if (poll.sourceFailures.length) {
    throw new Error(poll.sourceFailures.map(({ message }) => message).join('; '));
  }
  const rowFailures = poll.failures.filter((failure) => failure.startsWith(`${source.id}:`));
  const widespreadLinkFailure = poll.processedListings > 0 && rowFailures.length / poll.processedListings > SHADOW_LINK_FAILURE_THRESHOLD;
  if (rowFailures.length && widespreadLinkFailure) {
    throw new Error(`${rowFailures.length}/${poll.processedListings} eligible Greenhouse application links failed validation`);
  }
  const checkpoint = await dependencies.store.getCheckpoint(source.id);
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
    rawRows: checkpoint?.lastRawRowCount,
    withheldRows: (checkpoint?.lastWithheldRowCount ?? 0) + rowFailures.length,
    notifications,
  };
}

export async function processGreenhouseQueue(
  event: QueueEvent,
  dependencies: GreenhouseBoardDependencies,
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  return processFifoBatch(event.Records, async (record) => {
    const startedAt = new Date().toISOString();
    try {
      const message = parseWorkMessage(record.body);
      const result = await runGreenhouseBoard(message, dependencies);
      if (result.skipped) {
        console.log(JSON.stringify({ event: 'source_poll_skipped', command: 'greenhouse-poll', sourceId: result.sourceId, reason: result.skipped }));
        return;
      }
      if (result.mode === 'shadow') {
        // Shadow boards fetch through the adapter, so the queue owns their only
        // health write. Published boards poll through the shared poller, which
        // already persisted counts, hashes, and outcome for this attempt; a
        // second coarse write here would overwrite that richer artifact and
        // report every attempt as `success_changed`.
        await dependencies.store.putSourceHealth(successfulSourceHealth({
          sourceId: result.sourceId,
          provider: integrationRegistry.greenhouse.id,
          region: integrationRegistry.greenhouse.defaultRegion,
          previous: await dependencies.store.getSourceHealth(result.sourceId),
          startedAt,
          completedAt: new Date().toISOString(),
          rawRows: result.rawRows,
          eligibleRows: result.listings,
          withheldRows: result.withheldRows,
        }));
      }
      console.log(JSON.stringify({ command: 'greenhouse-poll', ...result }));
    } catch (error) {
      try {
        const message = parseWorkMessage(record.body);
        const previous = await dependencies.store.getSourceHealth(message.sourceId);
        const completedAt = new Date().toISOString();
        await dependencies.store.putSourceHealth(failedSourceHealth({
          sourceId: message.sourceId,
          provider: integrationRegistry.greenhouse.id,
          region: integrationRegistry.greenhouse.defaultRegion,
          previous,
          startedAt,
          completedAt,
          error,
        }));
      } catch (healthError) {
        console.error(JSON.stringify({ command: 'greenhouse-health', messageId: record.messageId, error: healthError instanceof Error ? healthError.message : String(healthError) }));
      }
      console.error(JSON.stringify({
        command: 'greenhouse-poll',
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  }, undefined, dependencies.onRecordFailure);
}

export async function handler(event: QueueEvent): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const tableName = process.env.INTERNSHIPS_TABLE;
  const usersTable = process.env.USERS_TABLE;
  if (!tableName || !usersTable) throw new Error('INTERNSHIPS_TABLE and USERS_TABLE are required');
  const cohortParameterName = process.env.GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME;
  if (!cohortParameterName) throw new Error('GROUPED_NOTIFICATION_COHORT_PARAMETER_NAME is required');
  return processGreenhouseQueue(event, {
    store: new DynamoInternshipStore(tableName),
    userStore: new DynamoUserStore(usersTable),
    groupedNotificationCohort: await loadGroupedNotificationCohort(cohortParameterName),
  });
}
