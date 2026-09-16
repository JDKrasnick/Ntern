import { randomUUID } from 'node:crypto';
import { SourceFetchError } from './sources/source-error.js';
import type { SourceFailureCategory, SourceHealth, SourceOutcome, SourceRun } from './types.js';

const MAX_RECENT_RUNS = 25;
const QUALITY_FAILURES_BEFORE_QUARANTINE = 2;
const CAPACITY_FAILURES_BEFORE_QUARANTINE = 2;
const MAX_PROVIDER_BACKOFF_MS = 30 * 60_000;

export class ApplicationLinkValidationError extends Error {
  readonly samples: Array<{ category: SourceFailureCategory; diagnostic: string }>;

  constructor(provider: string, failures: number, total: number, samples: Array<{ category: SourceFailureCategory; diagnostic: string }>) {
    const sanitized = samples.slice(0, 5).map((sample) => ({
      category: sample.category,
      diagnostic: safeDiagnostic(sample.diagnostic),
    }));
    super(`${failures}/${total} eligible ${provider} application links failed shadow validation`);
    this.samples = sanitized;
  }
}

export function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email]')
    .replace(/\b(bearer|token|secret|password)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .slice(0, 500);
}

export function sourceFailureCategory(error: unknown): SourceFailureCategory {
  if (error instanceof SourceFetchError) {
    return error.category;
  }
  const message = safeDiagnostic(error).toLowerCase();
  // The link validator's own probe failures describe the request, not the link:
  // `Application link timed out`, `Application link could not be reached`,
  // `Application page could not be reached`, and `Application page body timed
  // out` all mean its HEAD/GET never completed. Classifying them as `link` let a
  // burst of row-level probe timeouts quarantine a healthy 3,029-row source for
  // two consecutive deliveries (2026-09-16, `simplify-summer-2026`), and the same
  // misclassification applied to the poll's joined failure list, where one
  // timed-out row next to a `D1 DB is overloaded` error still read as `link`.
  // Messages that describe a *completed* probe — a rejected host, a dead link, or
  // an aggregate `N/M eligible ... links failed shadow validation` — carry no
  // transport wording and stay `link`, so link integrity still quarantines at two
  // strikes.
  if (/application (?:link|page) (?:timed out|could not be reached)/.test(message)) return 'transport';
  if (/application link|application host|eligible .* link/.test(message)) return 'link';
  if (/shape|schema|malformed json/.test(message)) return 'json';
  if (/quality|suspicious zero-row/.test(message)) return 'quality';
  if (/exceeded(?: cpu| memory)?|resource limit|too much cpu|out of memory|memory limit|response body too large|too many jobs/i.test(message)) return 'capacity';
  if (/timeout|timed out|aborted|fetch|network|socket|econn/.test(message)) return 'transport';
  return 'persistence';
}

function shouldQuarantine(category: SourceFailureCategory, error: unknown, failures: number): boolean {
  if (error instanceof SourceFetchError && error.immediateQuarantine) return true;
  if (category === 'json' || category === 'identity') return true;
  if (category === 'http' && error instanceof SourceFetchError && [401, 403, 404].includes(error.status ?? 0)) return true;
  return (category === 'quality' || category === 'link' || category === 'empty') && failures >= QUALITY_FAILURES_BEFORE_QUARANTINE
    || category === 'capacity' && failures >= CAPACITY_FAILURES_BEFORE_QUARANTINE;
}

function withRun(previous: SourceHealth | undefined, run: SourceRun): SourceRun[] {
  return [run, ...(previous?.recentRuns ?? [])].slice(0, MAX_RECENT_RUNS);
}

function operationalFields(previous: SourceHealth | undefined) {
  if (!previous) return {};
  return {
    ...(previous.employerId ? { employerId: previous.employerId } : {}),
    ...(previous.provider ? { provider: previous.provider } : {}),
    ...(previous.region ? { region: previous.region } : {}),
    ...(previous.sourceStatus ? { sourceStatus: previous.sourceStatus } : {}),
    ...(previous.pollTier ? { pollTier: previous.pollTier } : {}),
    ...(previous.pollTierMode ? { pollTierMode: previous.pollTierMode } : {}),
    ...(previous.configVersion !== undefined ? { configVersion: previous.configVersion } : {}),
    ...(previous.changedAt ? { changedAt: previous.changedAt } : {}),
    ...(previous.changedBy ? { changedBy: previous.changedBy } : {}),
  };
}

export function sourceFailureOutcome(error: unknown): SourceOutcome {
  const category = sourceFailureCategory(error);
  if (error instanceof SourceFetchError) {
    if (error.status === 429) return 'rate_limited';
    if (error.status === 404) return 'not_found';
    if (error.status !== undefined && error.status >= 500) return 'temporary_provider_error';
  }
  if (category === 'transport' || category === 'http') return 'temporary_provider_error';
  if (category === 'json') {
    return /pagination/i.test(safeDiagnostic(error)) ? 'incomplete_pagination' : 'invalid_schema';
  }
  if (category === 'identity') return 'application_host_mismatch';
  if (category === 'empty' || category === 'quality') return 'unexpected_raw_zero';
  if (category === 'capacity') return 'resource_limit';
  if (category === 'persistence') return 'catalog_write_failed';
  return 'failed';
}

export function sourceBackoffUntil(error: unknown, failures: number, completedAt: string): string | undefined {
  if (!(error instanceof SourceFetchError) || !error.retryable) return undefined;
  const retryAfterMs = error.retryAfterMs;
  const exponentialMs = Math.min(30 * 60_000, 60_000 * (2 ** Math.max(0, failures - 1)));
  return new Date(Date.parse(completedAt) + Math.min(MAX_PROVIDER_BACKOFF_MS, Math.max(retryAfterMs ?? 0, exponentialMs))).toISOString();
}

export function successfulSourceHealth(input: {
  sourceId: string;
  employerId?: string;
  provider?: SourceHealth['provider'];
  region?: SourceHealth['region'];
  previous?: SourceHealth;
  startedAt: string;
  completedAt: string;
  runId?: string;
  outcome?: Extract<SourceOutcome, 'changed' | 'unchanged' | 'success_changed' | 'success_unchanged_304' | 'success_unchanged_hash'>;
  etag?: string;
  contentHash?: string;
  rawRows?: number;
  validRows?: number;
  eligibleRows?: number;
  filteredRows?: number;
  withheldRows?: number;
}): SourceHealth {
  const durationMs = Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt));
  const outcome = input.outcome ?? 'success_changed';
  const automaticPollTier = (input.eligibleRows ?? 0) > 0 ? 'active' : 'quiet';
  const pollTierMode = input.previous?.pollTierMode ?? 'automatic';
  const run: SourceRun = {
    runId: input.runId ?? randomUUID(),
    sourceId: input.sourceId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.region ? { region: input.region } : {}),
    outcome,
    state: 'succeeded',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs,
    ...(input.rawRows !== undefined ? { rawRows: input.rawRows } : {}),
    ...(input.eligibleRows !== undefined ? { eligibleRows: input.eligibleRows } : {}),
    ...(input.withheldRows !== undefined ? { withheldRows: input.withheldRows } : {}),
  };
  return {
    sourceId: input.sourceId,
    ...operationalFields(input.previous),
    ...(input.employerId ? { employerId: input.employerId } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.region ? { region: input.region } : {}),
    state: 'healthy',
    sourceStatus: input.previous?.sourceStatus ?? 'active',
    pollTier: pollTierMode === 'operator' ? input.previous?.pollTier ?? automaticPollTier : automaticPollTier,
    pollTierMode,
    configVersion: input.previous?.configVersion ?? 1,
    lastAttemptAt: input.completedAt,
    lastSuccessAt: input.completedAt,
    ...(
      outcome === 'success_changed' || outcome === 'changed'
        ? { lastChangedAt: input.completedAt }
        : input.previous?.lastChangedAt ? { lastChangedAt: input.previous.lastChangedAt } : {}
    ),
    freshnessMinutes: 0,
    outcome,
    lastOutcome: outcome,
    consecutiveFailures: 0,
    ...(input.etag ? { etag: input.etag } : {}),
    ...(input.contentHash ? { contentHash: input.contentHash, snapshotHash: input.contentHash } : {}),
    durationMs,
    ...(input.rawRows !== undefined ? { rawRows: input.rawRows, rawCount: input.rawRows } : {}),
    ...(input.validRows !== undefined ? { validRows: input.validRows, validCount: input.validRows } : {}),
    ...(input.eligibleRows !== undefined ? { eligibleRows: input.eligibleRows, eligibleCount: input.eligibleRows } : {}),
    ...(input.filteredRows !== undefined ? { filteredRows: input.filteredRows, filteredCount: input.filteredRows } : {}),
    ...(input.withheldRows !== undefined ? { withheldRows: input.withheldRows, withheldCount: input.withheldRows } : {}),
    incidentState: 'resolved',
    ...(input.previous?.incidentState && input.previous.incidentState !== 'resolved'
      ? {
          incidentSeverity: input.previous.incidentSeverity,
          incidentOpenedAt: input.previous.incidentOpenedAt,
          incidentUpdatedAt: input.completedAt,
          incidentResolvedAt: input.completedAt,
        }
      : {}),
    recentRuns: withRun(input.previous, run),
  };
}

export function failedSourceHealth(input: {
  sourceId: string;
  employerId?: string;
  provider?: SourceHealth['provider'];
  region?: SourceHealth['region'];
  previous?: SourceHealth;
  startedAt: string;
  completedAt: string;
  runId?: string;
  error: unknown;
}): SourceHealth {
  const category = sourceFailureCategory(input.error);
  const failures = (input.previous?.consecutiveFailures ?? 0) + 1;
  const previouslyQuarantined = input.previous?.state === 'quarantined';
  const quarantined = previouslyQuarantined || shouldQuarantine(category, input.error, failures);
  const diagnostic = safeDiagnostic(input.error);
  const outcome = sourceFailureOutcome(input.error);
  const durationMs = Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt));
  const run: SourceRun = {
    runId: input.runId ?? randomUUID(),
    sourceId: input.sourceId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.region ? { region: input.region } : {}),
    outcome,
    state: quarantined ? 'quarantined' : 'failed',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs,
    failureCategory: category,
    diagnostic,
  };
  const incident = quarantined || failures >= 2;
  const backoffUntil = sourceBackoffUntil(input.error, failures, input.completedAt);
  return {
    sourceId: input.sourceId,
    ...operationalFields(input.previous),
    ...(input.employerId ? { employerId: input.employerId } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.region ? { region: input.region } : {}),
    state: quarantined ? 'quarantined' : 'degraded',
    sourceStatus: quarantined ? 'paused' : input.previous?.sourceStatus ?? 'active',
    pollTier: input.previous?.pollTier ?? 'active',
    configVersion: input.previous?.configVersion ?? 1,
    lastAttemptAt: input.completedAt,
    ...(input.previous?.lastSuccessAt ? { lastSuccessAt: input.previous.lastSuccessAt } : {}),
    ...(input.previous?.lastChangedAt ? { lastChangedAt: input.previous.lastChangedAt } : {}),
    ...(input.previous?.lastSuccessAt
      ? { freshnessMinutes: Math.max(0, (Date.parse(input.completedAt) - Date.parse(input.previous.lastSuccessAt)) / 60_000) }
      : {}),
    outcome,
    lastOutcome: outcome,
    consecutiveFailures: failures,
    durationMs,
    failureCategory: category,
    lastFailureCategory: category,
    diagnosticCategory: category,
    diagnostic,
    lastSafeDiagnostic: diagnostic,
    ...(backoffUntil ? { backoffUntil } : {}),
    incidentState: incident
      ? input.previous?.incidentState === 'acknowledged' ? 'acknowledged' : 'open'
      : input.previous?.incidentState ?? 'resolved',
    ...(incident ? {
      incidentSeverity: quarantined || failures >= 3 ? 'high' as const : 'warning' as const,
      incidentOpenedAt: input.previous?.incidentOpenedAt ?? input.completedAt,
      incidentUpdatedAt: input.completedAt,
      ...(input.previous?.incidentAcknowledgedAt ? { incidentAcknowledgedAt: input.previous.incidentAcknowledgedAt } : {}),
    } : {}),
    ...(quarantined ? {
      quarantinedAt: previouslyQuarantined ? input.previous?.quarantinedAt ?? input.completedAt : input.completedAt,
      quarantineReason: previouslyQuarantined ? input.previous?.quarantineReason ?? diagnostic : diagnostic,
    } : {}),
    ...(input.previous?.rawRows !== undefined ? { rawRows: input.previous.rawRows, rawCount: input.previous.rawRows } : {}),
    ...(input.previous?.validRows !== undefined ? { validRows: input.previous.validRows, validCount: input.previous.validRows } : {}),
    ...(input.previous?.eligibleRows !== undefined ? { eligibleRows: input.previous.eligibleRows, eligibleCount: input.previous.eligibleRows } : {}),
    ...(input.previous?.filteredRows !== undefined ? { filteredRows: input.previous.filteredRows, filteredCount: input.previous.filteredRows } : {}),
    ...(input.previous?.withheldRows !== undefined ? { withheldRows: input.previous.withheldRows, withheldCount: input.previous.withheldRows } : {}),
    ...(input.previous?.applicationLinksChecked !== undefined
      ? { applicationLinksChecked: input.previous.applicationLinksChecked }
      : {}),
    ...(input.previous?.applicationLinkFailures !== undefined
      ? { applicationLinkFailures: input.previous.applicationLinkFailures }
      : {}),
    ...(input.error instanceof ApplicationLinkValidationError
      ? { applicationLinkFailureSamples: input.error.samples }
      : input.previous?.applicationLinkFailureSamples
        ? { applicationLinkFailureSamples: input.previous.applicationLinkFailureSamples }
      : {}),
    recentRuns: withRun(input.previous, run),
  };
}
