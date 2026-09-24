import type { SourceCheckpoint, SourceDispatch, SourceHealth } from './types.js';
import { catalogProviderDefinitions, type CatalogProviderId } from './integration-registry.js';

const providerSchedules = Object.fromEntries(
  catalogProviderDefinitions.map((provider) => [provider.id, provider.runtime.awsSchedule]),
) as Record<CatalogProviderId, string>;

/** The single cadence contract used by provider dispatchers and their stacks. */
export const SOURCE_POLL_CADENCE = {
  publishedIntervalMs: 30 * 60 * 1000,
  shadowIntervalMs: 3 * 60 * 60 * 1000,
  // Quarantined sources receive one validation-only retry per day. Their
  // stable six-hour slot prevents a provider outage from triggering a second
  // synchronized fleet-wide burst.
  recoveryProbeIntervalMs: 24 * 60 * 60 * 1000,
  recoveryProbeJitterMs: 6 * 60 * 60 * 1000,
  // With the current account concurrency quota of 10, three provider fleets
  // can use at most six worker executions and leave capacity for the public API.
  workerMaxConcurrency: 2,
  schedules: providerSchedules,
} as const;

/** Suppression of a source that already has a work message pending lasts at
 * most one cadence, so consecutive attempts stay within two cadences. */
export const SOURCE_DISPATCH_LEASE_MS = SOURCE_POLL_CADENCE.publishedIntervalMs;

/** A published source that has not attempted a poll within two cadences has
 * missed a scheduled interval. */
export const SOURCE_CADENCE_SLIP_MS = SOURCE_POLL_CADENCE.publishedIntervalMs * 2;

/** No queue consumer may sleep longer than this on a provider retry window:
 * a longer wait fails the message into the durable backoff and queue retry. */
export const SOURCE_RETRY_DELAY_CAP_MS = 60_000;

/** A single work message may not hold a consumer slot for longer than this. A
 * hung provider, browser, or storage call must fail the message into the queue
 * retry path instead of parking a slot until the platform's 15-minute consumer
 * limit — six parked invocations are what delayed a whole sweep. Five minutes is
 * more than twice the longest legitimate attempt on record (a 27 MB board whose
 * D1 write took 147 s) and one sixth of the published cadence. */
export const SOURCE_MESSAGE_DEADLINE_MS = 5 * 60_000;

/**
 * Deliveries Cloudflare allows for one catalog message. The catalog consumers
 * run with `max_retries: 2`, so a message is delivered three times before the
 * platform moves it to the dead-letter queue. Keep this in sync with
 * `max_retries` in the Wrangler ingestion configs.
 */
export const CATALOG_DELIVERY_MAX_ATTEMPTS = 3;

/**
 * A source-scoped catalog failure that survives every delivery is deferred to
 * the scheduled dispatcher rather than dead-lettered: the source's health row
 * and checkpoint are the durable retry state, and the dispatcher re-issues the
 * poll on its next sweep (or its next recovery probe when quarantined). Only a
 * message the dispatcher can never own — an unknown source or a malformed body —
 * is poison and dead-letters. `error` is the failure from the final delivery.
 */
export function catalogFailureIsPoison(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Unknown reviewed /.test(message) || /^Invalid .* work message/.test(message);
}

function stableSourceBucket(sourceId: string, buckets: number): number {
  let hash = 2166136261;
  for (const character of sourceId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % buckets;
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Shadow sources use the last completed attempt when available, falling back
 * to their last trusted snapshot. This makes a delayed or missed scheduler run
 * catch up instead of requiring an exact modulo window.
 */
function isShadowSourceDue(
  sourceId: string,
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
  health?: SourceHealth,
): boolean {
  const lastPollAt = timestamp(health?.lastAttemptAt)
    ?? timestamp(health?.lastSuccessAt)
    ?? timestamp(checkpoint?.lastSuccessAt);
  if (lastPollAt !== undefined) {
    // Workers record completion slightly after the dispatcher invocation.
    // Compare scheduler windows so normal processing latency does not defer a
    // three-hour poll to the following half-hour run.
    const elapsedWindows = Math.floor(now.getTime() / SOURCE_POLL_CADENCE.publishedIntervalMs)
      - Math.floor(lastPollAt / SOURCE_POLL_CADENCE.publishedIntervalMs);
    return elapsedWindows >= SOURCE_POLL_CADENCE.shadowIntervalMs / SOURCE_POLL_CADENCE.publishedIntervalMs;
  }

  // A source with state but no usable timestamp must recover immediately. Only
  // brand-new shadow sources are spread across the first six dispatcher runs.
  if (checkpoint || health) return true;
  const buckets = SOURCE_POLL_CADENCE.shadowIntervalMs / SOURCE_POLL_CADENCE.publishedIntervalMs;
  const currentWindow = Math.floor(now.getTime() / SOURCE_POLL_CADENCE.publishedIntervalMs);
  return currentWindow % buckets === stableSourceBucket(sourceId, buckets);
}

export function isQuarantinedRecoveryProbeDue(sourceId: string, health: SourceHealth, now: Date): boolean {
  if (health.state !== 'quarantined') return false;
  const lastAttemptAt = timestamp(health.lastAttemptAt) ?? timestamp(health.quarantinedAt);
  if (lastAttemptAt === undefined) return false;
  const elapsedWindows = Math.floor(now.getTime() / SOURCE_POLL_CADENCE.publishedIntervalMs)
    - Math.floor(lastAttemptAt / SOURCE_POLL_CADENCE.publishedIntervalMs);
  const recoveryWindows = SOURCE_POLL_CADENCE.recoveryProbeIntervalMs / SOURCE_POLL_CADENCE.publishedIntervalMs;
  if (elapsedWindows < recoveryWindows) return false;
  const jitterWindows = SOURCE_POLL_CADENCE.recoveryProbeJitterMs / SOURCE_POLL_CADENCE.publishedIntervalMs;
  const currentWindow = Math.floor(now.getTime() / SOURCE_POLL_CADENCE.publishedIntervalMs);
  return currentWindow % jitterWindows === stableSourceBucket(sourceId, jitterWindows);
}

/** A source is suppressed only while its own work message is pending: the
 * marker is unexpired and no attempt has completed since it was written. */
export function isSourceDispatchInFlight(
  dispatch: SourceDispatch | undefined,
  health: SourceHealth | undefined,
  now: Date,
): boolean {
  const dispatchedAt = timestamp(dispatch?.dispatchedAt);
  if (dispatchedAt === undefined) return false;
  if (now.getTime() - dispatchedAt >= SOURCE_DISPATCH_LEASE_MS) return false;
  const attemptedAt = timestamp(health?.lastAttemptAt);
  return attemptedAt === undefined || attemptedAt < dispatchedAt;
}

/** Deliberately mirrors the exclusions `isProviderSourceDue` applies, so a
 * paused, quarantined, or backed-off source never raises a cadence alarm. A
 * source with no health row is *not* a cadence slip: it has never been polled at
 * all, and the provider cron dispatches it in the same run that would report it,
 * so counting it would alarm on every newly published source before its first
 * attempt could possibly complete. Never-polled sources are reported instead as
 * `state: 'never-succeeded'` and counted in `productionMetrics.staleSources`. */
export function missedPublishedInterval(
  sourceStatus: 'published' | 'shadow',
  health: Pick<SourceHealth, 'lastAttemptAt' | 'sourceStatus' | 'state' | 'backoffUntil'> | undefined,
  now: Date,
): boolean {
  if (sourceStatus !== 'published') return false;
  if (!health) return false;
  if (health.state === 'quarantined' || health.sourceStatus === 'paused') return false;
  const backoffUntil = timestamp(health.backoffUntil);
  if (backoffUntil !== undefined && backoffUntil > now.getTime()) return false;
  const lastAttemptAt = timestamp(health.lastAttemptAt);
  return lastAttemptAt === undefined || now.getTime() - lastAttemptAt > SOURCE_CADENCE_SLIP_MS;
}

export function isProviderSourceDue(
  sourceId: string,
  sourceStatus: 'published' | 'shadow',
  checkpoint: SourceCheckpoint | undefined,
  now: Date,
  health?: SourceHealth,
): boolean {
  if (health?.state === 'quarantined') return isQuarantinedRecoveryProbeDue(sourceId, health, now);
  if (health?.sourceStatus === 'paused') return false;
  const backoffUntil = timestamp(health?.backoffUntil);
  if (backoffUntil !== undefined && backoffUntil > now.getTime()) return false;
  if (sourceStatus === 'published') return true;
  return isShadowSourceDue(sourceId, checkpoint, now, health);
}
