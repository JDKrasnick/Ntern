import { createHash } from 'node:crypto';
import { classifyD1Failure } from '../cloudflare/d1-errors.js';
import { assessApplicationPageForListing, canonicalApplicationUrl, type ApplicationPageEvidence, type ApplicationUrlValidator } from './core/application-url.js';
import { boardReference, reachabilityFromFailure, reachabilityFromSignals, verifyApplication, type AttributionBasis, type Reachability } from './core/application-verification.js';
import { inferSeason, isPastSeason } from './core/early-career.js';
import { normalizeUrl } from './core/normalize.js';
import type { ProviderPostingReference } from './identity/posting.js';
import { resolvePostingIdentityDecision, stableSourceOccurrenceJobId } from './identity/registry.js';
import {
  providerEvidenceForOccurrence,
  reviewedProviderEvidenceError,
  reviewedProviderUrlReference,
  uniqueGreenhouseEvidenceForSources,
  unscopedGreenhouseEmbedPostingId,
  unscopedGreenhouseEmbedUrls,
} from './identity/reviewed-provider.js';
import { isTechnicalJob, type JobFilter } from './core/filters.js';
import { CatalogReconciler } from './ingestion/catalog-reconciler.js';
import { evaluateSourceFreshness } from './ingestion/monitoring.js';
import { sourceProvider, sourceRegion } from './integration-registry.js';
import { processSnapshot, SOURCE_METADATA_PROCESSING_REVISION } from './ingestion/processor.js';
import { deriveCanonicalAdmission, evaluateCatalogAdmission } from './catalog-admission.js';
import { classifyDestination, matchingBrowserDestination, requiresBrowserVerification, type CatalogAdmissionResolver, type DestinationVerificationRequest } from './destination-verification.js';
import { reviewedBoardIndex } from './sources/index.js';
import { sourceQualityFailures } from './sources/quality.js';
import {
  activeTrustedCommunityPolicy,
  advanceTrustedCommunityQualification,
  effectiveAdmissionConfigurationVersion,
  postingSpecificDestination,
  sourceAdmissionPolicy,
} from './sources/trust-policy.js';
import { trustedCommunityCircuitBreaches, trustedCommunityMetrics, trustedCommunityThresholdsFor } from './sources/trusted-community-health.js';
import { SourceFetchError } from './sources/source-error.js';
import { extractVerifiedPageMetadataEvidence, mergeRoleMetadataEvidence, projectRoleMetadata, roleMetadataEvidenceHasFields, ROLE_METADATA_EXTRACTION_VERSION, VERIFIED_PAGE_METADATA_SOURCES, withoutObservationTimestamps } from './role-metadata.js';
import { failedSourceHealth, sourceFailureCategory, sourceFailureOutcome, successfulSourceHealth } from './source-health.js';
import type {
  CatalogAdmission,
  Internship,
  ProcessedListing,
  ProcessedSnapshot,
  SourceAdapter,
  SourceCheckpoint,
  SourceFetchResult,
  SourceHealth,
  SourceOccurrence,
  SourceOccurrenceState,
  SourceSnapshot,
} from './types.js';
import type { InternshipStore } from './store.js';

const applicationPageMetadataVersion = ROLE_METADATA_EXTRACTION_VERSION + 1;

function stableSourceMaterial(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSourceMaterial).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSourceMaterial(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sourceOwnedMaterial(value: ProcessedListing | SourceOccurrence): string {
  // GitHub row numbers and fetch timestamps move whenever a maintainer edits
  // the Markdown around a role. Compare only facts the source owns so that
  // layout churn does not force a catalog read/write cycle for every row.
  const sourceEvidence = value.metadataEvidence?.filter((item) => item.sourceUrl === value.sourceUrl);
  return stableSourceMaterial({
    provenance: value.provenance,
    document: value.document,
    sourceUrl: value.sourceUrl,
    postedAt: value.postedAt,
    providerTimestamp: value.providerTimestamp,
    workMode: value.workMode,
    // Destination verification can append page/browser evidence to a durable
    // occurrence. Exclude it from the source comparison so an unchanged ATS
    // row can still take the fast path on its next poll.
    // Page evidence can be appended to a stored occurrence. An empty filtered
    // array is equivalent to no source evidence on the freshly fetched row.
    metadataEvidence: sourceEvidence?.length ? withoutObservationTimestamps(sourceEvidence) : undefined,
    company: value.company,
    title: value.title,
    location: value.location,
    locations: value.locations,
    season: value.season,
    applyUrl: value.applyUrl,
    compensation: value.compensation,
    requirements: value.requirements,
    technical: value.technical ?? true,
    state: value.state,
    providerEvidence: value.providerEvidence,
    shadowContentHash: value.shadowContentHash,
  });
}

function sourceMaterialHash(listing: ProcessedListing): string {
  let applyUrl = listing.applyUrl;
  try { applyUrl = canonicalApplicationUrl(applyUrl); } catch { /* Resolution rejects malformed URLs. */ }
  return createHash('sha256').update(sourceOwnedMaterial({ ...listing, applyUrl })).digest('hex');
}

function shadowEvaluationAdmissionEligible(listing: ProcessedListing, admission: CatalogAdmission): boolean {
  return admission.catalogEligible || (
    listing.provenance === 'official-ats'
    && admission.employerResolution === 'unresolved'
    && admission.reasonCodes.length === 1
    && admission.reasonCodes[0] === 'employer-unresolved'
    && ['posting-detail', 'application-form'].includes(admission.destination.classification)
  );
}

// Catalog rows written before posting identity v1 retained gh_src while
// removing the older, general tracking parameters. Keep this lookup shape
// only for adoption during the migration window; all new writes use the
// canonical posting URL.
function legacyNormalizedUrl(input: string): string {
  const tracking = new Set([
    'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  ]);
  const url = new URL(input.trim());
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  for (const key of [...url.searchParams.keys()]) {
    if (tracking.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}

function quarantinedOccurrence(
  listing: ProcessedListing,
  externalId: string,
  decision: Extract<NonNullable<ProcessedListing['postingIdentityDecision']>, { status: 'quarantined' }>,
): SourceOccurrence {
  return {
    sourceId: listing.sourceId,
    ...(listing.provenance ? { provenance: listing.provenance } : {}),
    document: listing.document,
    sourceUrl: listing.sourceUrl,
    row: listing.row,
    ...(listing.postedAt ? { postedAt: listing.postedAt } : {}),
    externalId,
    ...(listing.providerEvidence ? { providerEvidence: listing.providerEvidence } : {}),
    ...(listing.metadataEvidence?.length ? { metadataEvidence: listing.metadataEvidence } : {}),
    ...(listing.metadataExtraction ? { metadataExtraction: listing.metadataExtraction } : {}),
    ...(listing.admissionConfigurationVersion ? { admissionConfigurationVersion: listing.admissionConfigurationVersion } : {}),
    ...(listing.sourceMetadataProcessing ? { sourceMetadataProcessing: listing.sourceMetadataProcessing } : {}),
    ...(listing.shadowContentHash ? { shadowContentHash: listing.shadowContentHash } : {}),
    postingIdentityDecision: decision,
    company: listing.company,
    title: listing.title,
    location: listing.location,
    ...(listing.locations ? { locations: listing.locations } : {}),
    season: listing.season,
    applyUrl: listing.applyUrl,
    compensation: listing.compensation,
    ...(listing.requirements ? { requirements: listing.requirements } : {}),
    technical: listing.technical,
    state: listing.state,
  };
}

export interface PollReport {
  fetchedSources: number;
  unchangedSources: string[];
  baselineSources: string[];
  processedListings: number;
  newJobs: Internship[];
  filteredJobs: Internship[];
  quarantinedListings: Array<{ sourceId: string; row: number; reason: string }>;
  continuationSources: string[];
  /** Per source, listings still owed a bounded resolution pass; absent means none. */
  pendingResolution: Record<string, number>;
  failures: string[];
  // An outer fetch or persistence failure aborts the whole source. It is
  // tracked separately from per-row `failures` so a consumer can retry the
  // queue message instead of acknowledging a source that never ran. See #203.
  sourceFailures: Array<{ sourceId: string; message: string }>;
}

interface TrustedBatch {
  fetchResult: SourceFetchResult;
  processed: ProcessedSnapshot;
  snapshotHash: string;
  activeExternalIds: Set<string>;
  unchanged: boolean;
}

interface PrefetchedBoardFetch {
  attemptedAt: string;
  started: number;
  previous?: SourceCheckpoint;
  admissionConfigurationVersion?: string;
  result?: SourceFetchResult;
  error?: unknown;
}

const SOURCE_WORK_CONCURRENCY = 24;
const GITHUB_RESOLUTION_WORK_CONCURRENCY = 8;
const SOURCE_PERSISTENCE_CONCURRENCY = 8;
const SOURCE_MIGRATION_PERSISTENCE_CONCURRENCY = 4;
class DestinationHandoffError extends Error {
  constructor(cause: unknown) {
    super(`Destination verification handoff failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
/**
 * Share of a delivery's rows with broken application pages before the source
 * itself is treated as broken. Inconclusive transport probes stay pending for
 * a later poll and do not count as evidence that the source is broken.
 */
const MAX_PROBE_FAILURE_SHARE = 0.2;
const MAX_IN_PROCESS_RETRY_DELAY_MS = 60_000;
/**
 * Listings one GitHub queue delivery may resolve. Sliced because resolving a
 * whole board in one message is what killed these deliveries: the largest
 * reviewed source holds 3,063 raw rows, and in production each resolved row also
 * pays a destination check, a browser inspection for roughly half of them, and
 * its own catalog writes. 750 rows measured a 300 s (five-minute) message-deadline
 * abort on `simplify-summer-2026`, and the later 3,302-row production snapshot
 * still exhausted the delivery at 100 rows once page probes and persistence were
 * included. A 50-row slice later produced 11-13 transient probe failures on
 * live Simplify employer URLs. A 25-row slice with eight concurrent probes
 * leaves more room for the fixed fetch/parse cost and destination latency.
 * The pass is resumable from the checkpoint
 * (`pendingResolutionRows`), so lowering this only trades deliveries for
 * per-delivery cost; it never closes rows outside the completed slice.
 */
export const GITHUB_RESOLUTION_ROWS_PER_DELIVERY = 25;
/**
 * Listings one delivery may re-grade after an admission policy change. The
 * bounded-migration gate suppresses newly admitted rows of a trusted list until
 * its migration drains, so this bound also sets how fast those rows publish;
 * 20 rows per delivery left migrated rows hidden for hours, while 100 converges
 * in a manageable number of deliveries and keeps the migration inside the same
 * message budget as the resolution slice above.
 */
export const GITHUB_ADMISSION_MIGRATION_ROWS_PER_DELIVERY = 100;

/**
 * Bounded worker pool that always drains: the first error is rethrown only once
 * every worker has settled, so a failed slice never leaves writes in flight.
 */
async function forEachBounded<T>(items: readonly T[], task: (item: T, index: number) => Promise<void>,
  concurrency = SOURCE_WORK_CONCURRENCY): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try { await task(items[index]!, index); }
      catch (error) { failure ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure !== undefined) throw failure;
}

function providerFor(sourceId: string): SourceHealth['provider'] {
  return sourceProvider(sourceId);
}

function regionFor(provider: SourceHealth['provider']): NonNullable<SourceHealth['region']> {
  return sourceRegion(provider);
}

function emitSuccessMetric(
  sourceId: string,
  provider: SourceHealth['provider'],
  outcome: 'success_changed' | 'success_unchanged_304' | 'success_unchanged_hash',
  counts: ProcessedSnapshot['counts'],
  durationMs: number,
  conditionalRequest?: SourceFetchResult['conditionalRequest'],
  runId?: string,
) {
  const region = regionFor(provider);
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
          ...(conditionalRequest ? [
            { Name: 'ConditionalRequestAttempted', Unit: 'Count' },
            { Name: 'ConditionalRequestNotModified', Unit: 'Count' },
            ...(conditionalRequest.validatorChanged !== undefined
              ? [{ Name: 'ValidatorChanged', Unit: 'Count' }]
              : []),
          ] : []),
        ],
      }],
    },
    event: 'source_fetch_completed',
    runId,
    sourceId,
    provider,
    region,
    outcome,
    SourceFetchSuccess: 1,
    SourceFetchDurationMs: durationMs,
    RawListingCount: counts.raw,
    EligibleListingCount: counts.eligible,
    ListingWithheld: counts.withheld,
    ...(conditionalRequest ? {
      conditionalRequestAttempted: conditionalRequest.attempted,
      conditionalRequestNotModified: conditionalRequest.notModified,
      ...(conditionalRequest.validatorChanged !== undefined
        ? { validatorChanged: conditionalRequest.validatorChanged }
        : {}),
      ConditionalRequestAttempted: Number(conditionalRequest.attempted),
      ConditionalRequestNotModified: Number(conditionalRequest.notModified),
      ...(conditionalRequest.validatorChanged !== undefined
        ? { ValidatorChanged: Number(conditionalRequest.validatorChanged) }
        : {}),
    } : {}),
    counts,
  }));
}

function emitFreshnessMetric(records: SourceHealth[], now: Date) {
  const freshness = evaluateSourceFreshness(records, now);
  const polled = new Set(records.map((record) => record.provider));
  for (const [provider, staleCount] of Object.entries(freshness.byProvider).filter(([name]) => polled.has(name))) {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [{
          Namespace: 'InternNotifs/Ingestion',
          Dimensions: [['provider']],
          Metrics: [{ Name: 'StaleSourceCount', Unit: 'Count' }],
        }],
      },
      event: 'source_freshness_evaluated',
      provider,
      StaleSourceCount: staleCount,
      staleSourceIds: freshness.staleSourceIds.filter((sourceId) => providerFor(sourceId) === provider),
    }));
  }
}

function emitTrustedCommunityMetric(sourceId: string, metrics: NonNullable<SourceHealth['trustedCommunity']>, runId?: string) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'InternNotifs/Ingestion',
        Dimensions: [['sourceId']],
        Metrics: [
          { Name: 'TrustedRawRows', Unit: 'Count' },
          { Name: 'TrustedEligibleRows', Unit: 'Count' },
          { Name: 'TrustedRejectedAggregators', Unit: 'Count' },
          { Name: 'TrustedSurvivingAggregators', Unit: 'Count' },
          { Name: 'TrustedDuplicateOccurrences', Unit: 'Count' },
          { Name: 'TrustedDestinationFailures', Unit: 'Count' },
          { Name: 'TrustedBrowserInspectionShare', Unit: 'Percent' },
          { Name: 'TrustedCatalogYield', Unit: 'Percent' },
          { Name: 'TrustedAlertYield', Unit: 'Percent' },
        ],
      }],
    },
    event: 'trusted_community_source_evaluated',
    runId,
    sourceId,
    TrustedRawRows: metrics.rawRows,
    TrustedEligibleRows: metrics.eligibleRows,
    TrustedRejectedAggregators: metrics.rejectedAggregatorRows,
    TrustedSurvivingAggregators: metrics.survivingAggregatorRows,
    TrustedDuplicateOccurrences: metrics.duplicateOccurrenceIds,
    TrustedDestinationFailures: metrics.destinationFailures,
    TrustedBrowserInspectionShare: metrics.browserInspectionShare * 100,
    TrustedCatalogYield: metrics.catalogYield * 100,
    TrustedAlertYield: metrics.alertYield * 100,
    metrics,
  }));
}

function emitFailureMetric(
  sourceId: string,
  provider: SourceHealth['provider'],
  category: NonNullable<SourceHealth['diagnosticCategory']>,
  durationMs: number,
  outcome: string,
  runId?: string,
) {
  const region = regionFor(provider);
  const rejected = ['json', 'identity', 'link', 'empty', 'quality'].includes(category) ? 1 : 0;
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
    runId,
    sourceId,
    provider,
    region,
    category,
    outcome,
    SourceFetchFailure: 1,
    SourceFetchDurationMs: durationMs,
    SnapshotRejected: rejected,
  }));
}

function isSourceSnapshot(result: SourceFetchResult): result is SourceFetchResult & SourceSnapshot {
  return 'postings' in result && 'complete' in result && 'outcome' in result;
}

function externalId(listing: ProcessedListing): string {
  if (listing.externalId) return listing.externalId;
  try { return `${listing.document}:${normalizeUrl(listing.applyUrl)}`; }
  catch { return `${listing.document}:invalid:${listing.applyUrl}`; }
}

function sameApplicationUrl(left: string, right: string): boolean {
  try { return normalizeUrl(canonicalApplicationUrl(left)) === right; }
  catch { return false; }
}

function legacyBatch(result: SourceFetchResult): TrustedBatch {
  const listings = result.listings.map((listing) => ({
    ...listing,
    externalId: externalId(listing),
    technical: listing.technical ?? isTechnicalJob(listing),
  }));
  const snapshotHash = result.checkpoint.contentHash
    ?? createHash('sha256').update(JSON.stringify(listings, (key, value) => key === 'fetchedAt' ? undefined : value)).digest('hex');
  return {
    fetchResult: result,
    processed: {
      listings,
      decisions: listings.map((listing) => ({ externalId: externalId(listing), outcome: 'included' as const, reason: 'source-policy' as const })),
      counts: {
        raw: result.rawRowCount ?? listings.length,
        valid: listings.length,
        eligible: listings.filter((listing) => listing.technical !== false).length,
        shelved: listings.filter((listing) => listing.technical === false).length,
        filtered: 0,
        withheld: result.rejectedApplicationUrls?.length ?? 0,
      },
    },
    snapshotHash,
    activeExternalIds: new Set(result.checkpoint.activeExternalIds ?? listings.map(externalId)),
    unchanged: result.notModified,
  };
}

function neutralBatch(result: SourceFetchResult & SourceSnapshot): TrustedBatch {
  const processed = result.processed ?? processSnapshot(result);
  return {
    fetchResult: result,
    processed,
    snapshotHash: result.contentHash,
    activeExternalIds: new Set(result.checkpoint.activeExternalIds ?? result.postings.map((posting) => posting.externalId)),
    unchanged: result.outcome === 'unchanged',
  };
}

function retryable(error: unknown): boolean {
  return error instanceof SourceFetchError ? error.retryable : error instanceof TypeError || (error as { name?: string })?.name === 'AbortError';
}

async function fetchWithRetry(adapter: SourceAdapter, checkpoint: SourceCheckpoint | undefined): Promise<SourceFetchResult> {
  let finalError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await adapter.fetch(checkpoint);
    } catch (error) {
      finalError = error;
      if (!retryable(error) || attempt === 3) throw error;
      const exponentialDelay = 25 * (2 ** (attempt - 1));
      const retryAfterMs = error instanceof SourceFetchError ? error.retryAfterMs : undefined;
      // Let the durable source-health backoff handle longer provider windows;
      // never keep a queue worker asleep past its bounded retry budget.
      if (retryAfterMs !== undefined && retryAfterMs > MAX_IN_PROCESS_RETRY_DELAY_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.max(exponentialDelay, retryAfterMs ?? 0)));
    }
  }
  throw finalError;
}

export class IngestionRunner {
  private readonly reconciler = new CatalogReconciler();

  constructor(
    private readonly connectors: SourceAdapter[],
    private readonly store: InternshipStore,
    private readonly now: () => Date = () => new Date(),
    private readonly filter?: JobFilter,
    private readonly validateApplicationUrl?: ApplicationUrlValidator,
    private readonly validateCatalogApplicationUrl: ApplicationUrlValidator | false | undefined = validateApplicationUrl,
    private readonly enqueueDestinationVerification?: (request: DestinationVerificationRequest) => Promise<void>,
    private readonly catalogAdmissionResolver?: CatalogAdmissionResolver,
    private readonly publishUnconfirmedIdentities = true,
    private readonly trustedCommunityCatalogEnabled = false,
  ) {}

  private async quarantine(job: Internship) {
    await this.store.putInternship({
      ...job,
      open: false,
      invalidApplicationUrl: job.normalizedUrl,
      notification: { ...job.notification, smsPending: false, digestPending: false },
    });
  }

  private async validateUnverifiedOpenJobs(report: PollReport) {
    if (!this.validateCatalogApplicationUrl || !this.store.listOpen) return;
    const validateCatalogApplicationUrl = this.validateCatalogApplicationUrl;
    let cursor: string | undefined;
    do {
      const page = await this.store.listOpen(cursor, 100, 'open');
      cursor = page.cursor;
      const jobs = page.jobs.filter((job) => !job.applicationUrlValidatedAt);
      let nextJob = 0;
      const validateJob = async () => {
        const job = jobs[nextJob++];
        if (!job) return;
        try {
          await validateCatalogApplicationUrl(job.applyUrl);
          await this.store.putInternship({ ...job, applicationUrlValidatedAt: this.now().toISOString() });
        } catch (error) {
          // A refused read or a timeout says nothing about the posting; only a
          // destination proven gone hides a role a source still lists.
          if (reachabilityFromFailure(error) === 'gone') await this.quarantine(job);
          report.failures.push(`catalog: ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(24, jobs.length) }, async () => {
        while (nextJob < jobs.length) await validateJob();
      }));
    } while (cursor);
  }

  private async drainProviderShadowVerifications(): Promise<void> {
    if (!this.enqueueDestinationVerification || !this.store.listPendingProviderShadowVerifications
      || !this.store.markProviderShadowVerificationEnqueued) return;
    for (const request of await this.store.listPendingProviderShadowVerifications()) {
      try {
        await this.enqueueDestinationVerification(request);
        await this.store.markProviderShadowVerificationEnqueued(request.idempotencyKey!);
      } catch (error) {
        // Persistence already committed the outbox row. Leave it for the
        // bounded scheduled sweep rather than turning a successful source poll
        // into a retry storm when the downstream queue is unavailable.
        console.error(JSON.stringify({ event: 'provider_shadow_handoff_deferred', sourceId: request.sourceId,
          provider: request.providerIdentity.provider,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }));
      }
    }
  }

  /** A source-level breaker blocks the batch, but a newly proven unsafe
   * destination must still disappear from the existing catalog immediately.
   * Reuse the normal projection and atomic occurrence write; never close or
   * otherwise rewrite unaffected backlog rows. */
  private async hideUnsafeTrustedCommunityListings(input: {
    sourceId: string;
    snapshotHash: string;
    listings: ProcessedListing[];
    priorOccurrences: SourceOccurrenceState[];
    resolvedJobs: Map<string, Internship | undefined>;
    now: string;
    withdrawnPostingKeys: Set<string>;
  }): Promise<void> {
    const unsafeListings = input.listings.filter((listing) => {
      const existing = input.resolvedJobs.get(externalId(listing));
      return Boolean(existing && existing.admission?.catalogEligible !== false && listing.admission?.catalogEligible === false);
    });
    if (!unsafeListings.length) return;
    const unsafeIds = new Set(unsafeListings.map(externalId));
    const plan = this.reconciler.reconcile({
      sourceId: input.sourceId,
      snapshotHash: input.snapshotHash,
      activeExternalIds: unsafeIds,
      listings: unsafeListings,
      priorOccurrences: input.priorOccurrences.filter((occurrence) => unsafeIds.has(occurrence.externalId)),
      resolvedJobs: input.resolvedJobs,
      now: input.now,
      baseline: true,
      publishUnconfirmedIdentities: true,
      withdrawnPostingKeys: input.withdrawnPostingKeys,
    });
    const jobs = new Map(plan.jobs.map((job) => [job.jobId, job]));
    for (const occurrence of plan.occurrences) {
      const job = jobs.get(occurrence.jobId);
      const decision = occurrence.occurrence.postingIdentityDecision;
      if (!job || !decision || decision.status === 'quarantined') continue;
      const hidden = job.admission?.catalogEligible === false
        ? { ...job, notification: { ...job.notification, smsPending: false, digestPending: false } }
        : job;
      await this.store.commitPostingObservation({
        decision,
        ...(hidden.postingIdentity ? { identity: hidden.postingIdentity } : {}),
        job: hidden,
        occurrence,
      });
    }
  }

  /** Revocation depends on durable evidence, not on a successful upstream fetch.
   * Retain lifecycle/history and any independently eligible official reference. */
  private async revokeTrustedCommunityAdmission(
    prior: SourceOccurrenceState,
    admissionConfigurationVersion: string | undefined,
    now: string,
  ): Promise<SourceOccurrenceState> {
    const reference = prior.occurrence;
    const previousAdmission = reference.admission!;
    const job = await this.store.getJob(prior.jobId);
    const admission = evaluateCatalogAdmission({
      listing: { ...reference, fetchedAt: now,
        ...(previousAdmission.canonicalEmployer ? { employerEvidence: {
          authority: 'reviewed-registry', canonicalEmployer: previousAdmission.canonicalEmployer,
        } } : {}),
      },
      destination: previousAdmission.destination,
      postingAttributed: previousAdmission.postingAttribution === 'attributed',
      evaluatedAt: now,
    });
    const updatedReference = { ...reference, admission, admissionConfigurationVersion };
    const occurrence = { ...prior, occurrence: updatedReference, changedAt: now };
    if (!job) {
      await this.store.putSourceOccurrence(occurrence);
      return occurrence;
    }
    const decision = reference.postingIdentityDecision;
    if (!decision || decision.status === 'quarantined') {
      throw new Error(`Cannot revoke trusted admission without a classified occurrence: ${prior.externalId}`);
    }
    const sourceReferences = job.sourceReferences.map((item) => item.sourceId === prior.sourceId
      && item.externalId === prior.externalId ? updatedReference : item);
    const result = await this.store.commitPostingObservation({
      decision,
      ...(job.postingIdentity ? { identity: job.postingIdentity } : {}),
      job: { ...job, sourceReferences, admission: deriveCanonicalAdmission(sourceReferences, now) },
      occurrence,
    });
    if (result.outcome !== 'committed') throw new Error(`Trusted admission revocation conflicted: ${prior.externalId}`);
    return occurrence;
  }

  private readonly boardIndex = reviewedBoardIndex();
  private readonly boardActiveIds = new Map<string, Promise<Set<string>>>();
  private readonly currentRunGreenhouseActiveIds = new Map<string, Set<string>>();
  private boardCheckpoints?: Promise<Map<string, SourceCheckpoint>>;

  private activePostingIds(sourceId: string): Promise<Set<string>> {
    const current = this.currentRunGreenhouseActiveIds.get(sourceId);
    if (current) return Promise.resolve(current);
    if (!this.boardActiveIds.has(sourceId)) {
      this.boardActiveIds.set(sourceId, this.store.getCheckpoint(sourceId)
        .then((checkpoint) => new Set(checkpoint?.activeExternalIds ?? []))
        .catch(() => new Set<string>()));
    }
    return this.boardActiveIds.get(sourceId)!;
  }

  private async uniqueActiveGreenhouseEvidence(postingId: string, urls: string[]) {
    const sourceIds = [...new Set(this.boardIndex.values())];
    this.boardCheckpoints ??= this.store.getCheckpointsMany(sourceIds)
      .then((checkpoints) => new Map(checkpoints.map((checkpoint) => [checkpoint.sourceId, checkpoint])));
    const checkpoints = await this.boardCheckpoints;
    const activeSources = sourceIds.flatMap((sourceId) => {
      const evidence = providerEvidenceForOccurrence(sourceId, postingId, urls);
      if (evidence?.provider !== 'greenhouse') return [];
      const current = this.currentRunGreenhouseActiveIds.get(sourceId);
      return (current ? current.has(postingId) : checkpoints.get(sourceId)?.activeExternalIds?.includes(postingId)) ? [sourceId] : [];
    });
    return uniqueGreenhouseEvidenceForSources(postingId, activeSources, urls);
  }

  private async reviewedReferences(listing: ProcessedListing): Promise<ProviderPostingReference[]> {
    if (listing.providerEvidence) {
      const error = reviewedProviderEvidenceError(listing.providerEvidence);
      if (error) throw new Error(error);
    }
    const references: ProviderPostingReference[] = [];
    const urls = [listing.applyUrl, ...(listing.providerEvidence?.urls ?? [])];
    for (const url of urls) {
      const result = reviewedProviderUrlReference(url);
      if (result.outcome === 'conflict') throw new Error(result.reason);
      if (result.outcome !== 'match') {
        const postingId = unscopedGreenhouseEmbedPostingId(url);
        const evidence = postingId ? await this.uniqueActiveGreenhouseEvidence(postingId, [url]) : undefined;
        if (evidence) references.push({ provider: evidence.provider, tenant: evidence.tenant, postingId: evidence.postingId });
        continue;
      }
      const direct = listing.providerEvidence?.sourceId === result.reference.sourceId;
      if (direct || listing.providerEvidence || (await this.activePostingIds(result.reference.sourceId)).has(result.reference.postingId)) {
        references.push(result.reference);
      }
    }
    return references;
  }

  private async inferredEmbedAliases(listing: ProcessedListing): Promise<string[]> {
    const evidence = listing.providerEvidence;
    if (evidence?.provider !== 'greenhouse') return [];
    const unique = await this.uniqueActiveGreenhouseEvidence(evidence.postingId, evidence.urls ?? []);
    if (!unique || unique.sourceId !== evidence.sourceId || unique.tenant.toLowerCase() !== evidence.tenant.toLowerCase()) return [];
    return unscopedGreenhouseEmbedUrls(evidence.postingId);
  }

  /** Provider existence and destination validity are separate facts. Attribution
   * requires an exact hosted/apply route; a provider ID on a generic custom page
   * is still inspected like any other destination. */
  private async attribute(listing: ProcessedListing): Promise<AttributionBasis> {
    const reference = boardReference(listing.applyUrl);
    const sourceId = reference && this.boardIndex.get(`${reference.provider}:${reference.token}`);
    if (!reference || !sourceId) return 'unattributed';
    const evidence = listing.providerEvidence;
    if (evidence
      && evidence.provider === reference.provider
      && evidence.tenant.toLowerCase() === reference.token
      && evidence.postingId.toLowerCase() === reference.postingId.toLowerCase()
      && evidence.sourceId === sourceId) return 'provider-api';
    return (await this.activePostingIds(sourceId)).has(reference.postingId) ? 'reviewed-board' : 'unattributed';
  }

  private async resolveListings(
    listings: ProcessedListing[],
    report: PollReport,
    priorOccurrences: SourceOccurrenceState[] = [],
    admissionConfigurationVersion?: string,
    reuseUnchangedOccurrences = false,
    completeFetchSequence?: number,
    stampSourceMetadata = false,
    providerShadowEligible = false,
    workConcurrency = SOURCE_WORK_CONCURRENCY,
  ) {
    const resolved = new Map<string, Internship | undefined>();
    const validatedAt = new Map<string, string>();
    const metadataValidated = new Map<string, number>();
    const alertEligible = new Set<string>();
    const handledExternalIds = new Set<string>();
    const failedExternalIds = new Set<string>();
    const providerShadowVerifications: DestinationVerificationRequest[] = [];
    // Slots keep the snapshot order stable so duplicate merging, alert order, and
    // reported failures do not depend on which worker finished first.
    const accepted = new Array<ProcessedListing | undefined>(listings.length);
    const failures = new Array<string | undefined>(listings.length);
    // Failed probes stay out of this delivery. Transport failures remain owed by
    // the checkpoint; completed negative results still count toward the source
    // link-integrity gate. Queue or persistence errors fail the delivery.
    const withdrawnProbeFailures: string[] = [];
    const brokenProbeFailures: string[] = [];
    const retryableRowExternalIds = new Set<string>();
    const deferredHandoffFailures: string[] = [];
    const isProbeFailure = (error: unknown, fromValidator = false) => {
      const category = sourceFailureCategory(error);
      return (category === 'transport' || category === 'link')
        && (fromValidator || /^Application (?:link|page) /i.test(error instanceof Error ? error.message : String(error)));
    };
    const isRetryableProbeFailure = (error: unknown, fromValidator = false) =>
      (fromValidator && sourceFailureCategory(error) === 'transport')
      || /^Application (?:link (?:timed out|could not be reached)|page (?:could not be reached|body timed out))$/i
        .test(error instanceof Error ? error.message : String(error));
    const priorByExternalId = new Map(priorOccurrences.map((occurrence) => [occurrence.externalId, occurrence]));
    await forEachBounded(listings, async (sourceListing, slot) => {
      // Transitional RawListing adapters predate provider-neutral evidence.
      // Real connectors now emit SourceSnapshot postings and are always managed
      // by record-level admission; legacy rows retain their rollout behavior
      // until the reviewed backfill classifies them.
      const supportsAdmission = Boolean(sourceListing.employerEvidence || sourceListing.providerIdentity);
      const id = externalId(sourceListing);
      const priorOccurrence = priorByExternalId.get(id);
      const trustedCommunityPolicy = activeTrustedCommunityPolicy(
        sourceListing.sourceId,
        this.trustedCommunityCatalogEnabled,
      );
      const completeFailedAdmissionMigration = async () => {
        if (!admissionConfigurationVersion) return;
        if (priorOccurrence
          && priorOccurrence.occurrence.admissionConfigurationVersion !== admissionConfigurationVersion) {
          try {
            await this.store.putSourceOccurrence({
              ...priorOccurrence,
              occurrence: { ...priorOccurrence.occurrence, admissionConfigurationVersion },
            });
          } catch (error) {
            failures[slot] = `${failures[slot]}; failed to preserve migration decision: ${error instanceof Error ? error.message : String(error)}`;
            return;
          }
        }
        // A failed new row has no legacy occurrence to preserve. It still
        // completes this configuration slice by failing closed; otherwise the
        // same unpersistable row poisons every continuation forever.
        handledExternalIds.add(id);
      };
      let legacyUrl: string;
      let canonicalUrl: string;
      try {
        legacyUrl = legacyNormalizedUrl(sourceListing.applyUrl);
        canonicalUrl = canonicalApplicationUrl(sourceListing.applyUrl);
      } catch (error) {
        failures[slot] = `${sourceListing.sourceId}: row ${sourceListing.row}: ${error instanceof Error ? error.message : String(error)}`;
        await completeFailedAdmissionMigration();
        return;
      }
      let listing = {
        ...sourceListing,
        externalId: externalId(sourceListing),
        applyUrl: canonicalUrl,
        technical: sourceListing.technical ?? true,
        ...(priorOccurrence?.occurrence.trustedCommunityAlertQualification
          ? { trustedCommunityAlertQualification: priorOccurrence.occurrence.trustedCommunityAlertQualification }
          : {}),
        ...(admissionConfigurationVersion ? { admissionConfigurationVersion } : {}),
        ...(stampSourceMetadata ? { sourceMetadataProcessing: {
          extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
          processingRevision: SOURCE_METADATA_PROCESSING_REVISION,
          sourceMaterialHash: sourceMaterialHash(sourceListing),
        } } : {}),
      };
      const admissionAlreadyApplied = Boolean(admissionConfigurationVersion
        && priorOccurrence?.occurrence.admissionConfigurationVersion === admissionConfigurationVersion);
      // Reviewed community lists currently publish catalog roles without alerts.
      // Once a row has completed that policy, another row changing on the same
      // Markdown board must not re-probe and rewrite this unchanged occurrence.
      // Keep suppressed rows in the publication path until they are released.
      const settledCatalogOnlyCommunityRow = trustedCommunityPolicy?.alertMode === 'disabled'
        && admissionAlreadyApplied
        && priorOccurrence?.present === true
        && priorOccurrence?.occurrence.trustedCommunityAlertQualification
        && priorOccurrence.occurrence.trustedCommunityAlertQualification.basis !== undefined
        && priorOccurrence.occurrence.trustedCommunityAlertQualification.catalogPublicationSuppressed !== true
        && Date.parse(priorOccurrence.occurrence.admission?.destination.nextCheckAt ?? '') > this.now().getTime();
      if (!stampSourceMetadata && (!trustedCommunityPolicy || settledCatalogOnlyCommunityRow)
        && (reuseUnchangedOccurrences || admissionAlreadyApplied) && priorOccurrence
        && sourceOwnedMaterial(priorOccurrence.occurrence) === sourceOwnedMaterial(listing)) {
        handledExternalIds.add(id);
        return;
      }
      const priorTrustedQualification = priorOccurrence?.occurrence.trustedCommunityAlertQualification;
      const materialHash = sourceMaterialHash(sourceListing);
      const sameTrustedMaterial = priorTrustedQualification?.sourceMaterialHash
        ? priorTrustedQualification.sourceMaterialHash === materialHash
        : Boolean(priorOccurrence && sourceOwnedMaterial(priorOccurrence.occurrence) === sourceOwnedMaterial(listing));
      // Publication slices consume evidence collected under this exact policy;
      // they must not repeat every HTTP probe merely to clear suppression.
      if (trustedCommunityPolicy && admissionAlreadyApplied && priorOccurrence
        && priorTrustedQualification?.catalogPublicationSuppressed === true
        && priorOccurrence.present
        && priorOccurrence.occurrence.state === listing.state
        && priorOccurrence.occurrence.admission
        && sameTrustedMaterial) {
        const existing = await this.store.getJob(priorOccurrence.jobId);
        if (existing) {
          const priorListing = priorOccurrence.occurrence;
          const qualification = advanceTrustedCommunityQualification({
            previous: priorTrustedQualification,
            destination: priorListing.admission!.destination,
            postingIdentityDecision: priorListing.postingIdentityDecision,
            alertMode: trustedCommunityPolicy.alertMode,
            completeFetchSequence,
            catalogPublicationSuppressed: false,
          });
          const admission = evaluateCatalogAdmission({
            listing: { ...listing, ...priorListing,
              ...(priorListing.admission!.canonicalEmployer ? { employerEvidence: {
                authority: 'reviewed-registry', canonicalEmployer: priorListing.admission!.canonicalEmployer,
              } } : {}),
            },
            destination: priorListing.admission!.destination,
            postingAttributed: priorListing.admission!.postingAttribution === 'attributed',
            evaluatedAt: this.now().toISOString(),
            trustedCommunity: { policy: trustedCommunityPolicy, qualification },
          });
          accepted[slot] = { ...listing, ...priorListing, admission,
            ...(priorListing.postingIdentityDecision?.status === 'confirmed' && existing.postingIdentity
              ? { postingIdentity: existing.postingIdentity } : {}),
            trustedCommunityAlertQualification: qualification };
          resolved.set(id, existing);
          if (admission.alertEligible) alertEligible.add(id);
          handledExternalIds.add(id);
          return;
        }
      }
      if (trustedCommunityPolicy && admissionAlreadyApplied && priorOccurrence
        && priorTrustedQualification?.basis
        && priorOccurrence.present
        && priorOccurrence.occurrence.state === listing.state
        && priorTrustedQualification.catalogPublicationSuppressed !== true
        && priorOccurrence.occurrence.admission
        && postingSpecificDestination(priorOccurrence.occurrence.admission.destination)
        && sameTrustedMaterial) {
        handledExternalIds.add(id);
        return;
      }
      let existing: Internship | undefined;
      let identityMerged = false;
      try {
        const normalizedUrl = normalizeUrl(listing.applyUrl);
        const reviewedProviderReferences = await this.reviewedReferences(listing);
        const observedUrls = await this.inferredEmbedAliases(listing);
        const identityResult = resolvePostingIdentityDecision({
          sourceId: listing.sourceId,
          externalId: id,
          applicationUrl: listing.applyUrl,
          observedAt: this.now().toISOString(),
          ...(listing.providerEvidence ? { providerEvidence: listing.providerEvidence } : {}),
          reviewedProviderReferences,
          observedUrls,
          previousDecision: priorByExternalId.get(id)?.occurrence.postingIdentityDecision,
        });
        if (identityResult.decision.status === 'quarantined') {
          await this.store.commitPostingObservation({
            decision: identityResult.decision,
            sourceId: listing.sourceId,
            externalId: id,
            occurrence: quarantinedOccurrence(listing, id, identityResult.decision),
          });
          report.quarantinedListings.push({
            sourceId: listing.sourceId,
            row: listing.row,
            reason: `posting identity conflict (${identityResult.decision.reason})`,
          });
          handledExternalIds.add(id);
          return;
        }
        const identity = identityResult.identity;
        // A legacy row may be adopted only through its exact canonical URL.
        // Title/location fingerprints are search hints, not proof that two
        // employer requisitions are the same posting.
        const prior = priorByExternalId.get(id);
        existing = prior ? await this.store.getJob(prior.jobId) : undefined;
        const lookupUrls = [...new Set([
          normalizedUrl,
          legacyUrl,
          ...observedUrls,
          ...(identity?.aliases.filter((candidate) => candidate.value.startsWith('url:')).map((candidate) => candidate.value.slice(4)) ?? []),
        ])];
        if (!existing) {
          for (const lookupUrl of lookupUrls) {
            const candidate = await this.store.findByUrl(lookupUrl);
            if (!candidate) continue;
            const sameSourceOccurrence = candidate.sourceReferences.some((reference) => reference.sourceId === listing.sourceId
              && (reference.externalId === id || (!reference.externalId && reference.document === listing.document && reference.row === listing.row)));
            const adoptableLegacyCandidate = Boolean(identity) && candidate.postingIdentityStatus === undefined;
            const reviewedIdentityUrl = Boolean(identity)
              && candidate.postingIdentityStatus === 'unconfirmed'
              && observedUrls.some((observedUrl) => normalizeUrl(observedUrl) === lookupUrl);
            if (adoptableLegacyCandidate || reviewedIdentityUrl || sameSourceOccurrence) { existing = candidate; break; }
          }
        }
        if (identity) {
          const identityResolution = await this.store.resolvePostingIdentity(identity, existing?.jobId);
          if (identityResolution.outcome === 'quarantine') {
            const decision = {
              status: 'quarantined' as const,
              reason: identityResolution.reason,
              contradictoryEvidence: identityResolution.conflictingCanonicalJobIds,
              reviewFamilyKey: identityResult.decision.status === 'confirmed'
                ? identityResult.decision.exactKey
                : identityResult.decision.reviewFamilyKey,
              observedAt: identityResult.decision.observedAt,
            };
            await this.store.commitPostingObservation({
              decision,
              sourceId: listing.sourceId,
              externalId: id,
              occurrence: quarantinedOccurrence(listing, id, decision),
            });
            report.quarantinedListings.push({
              sourceId: listing.sourceId,
              row: listing.row,
              reason: `posting identity conflict (${identityResolution.reason})`,
            });
            handledExternalIds.add(id);
            return;
          }
          if (!existing || existing.jobId !== identityResolution.canonicalJobId) {
            existing = await this.store.getJob(identityResolution.canonicalJobId);
          }
          identityMerged = identityResolution.outcome === 'merge';
          identity.canonicalJobId = identityResolution.canonicalJobId;
        }
        listing = {
          ...listing,
          postingIdentityDecision: identityResult.decision,
          ...(identity ? { postingIdentity: identity } : {}),
        };
        if (supportsAdmission && listing.providerIdentity && this.catalogAdmissionResolver) {
          const canonicalEmployer = await this.catalogAdmissionResolver.resolveCanonicalEmployer(listing.providerIdentity);
          if (canonicalEmployer) listing = {
            ...listing,
            employerEvidence: { authority: 'reviewed-registry', canonicalEmployer },
          };
        }
        // Existing unclassified rows keep their rollout behavior until a
        // reviewed mapping exists. A refreshed URL is also safe when an
        // already-claimed immutable provider posting proves it is the same
        // requisition. New rows and otherwise unproven destination changes
        // fail closed, so activating admission cannot hide the legacy catalog.
        const knownLegacyDestination = existing?.normalizedUrl === normalizedUrl
          || existing?.sourceReferences.some((reference) => reference.sourceId === listing.sourceId
            && sameApplicationUrl(reference.applyUrl, normalizedUrl));
        const preserveLegacyAdmission = Boolean(existing && !existing.admission
          && (knownLegacyDestination || identityMerged)
          && !listing.employerEvidence?.canonicalEmployer);
        const admissionManaged = supportsAdmission && !preserveLegacyAdmission;
        const attribution = await this.attribute(listing);
        if (listing.seasonSource === 'source-default'
          && existing?.applicationPageMetadataVersion === applicationPageMetadataVersion
          && !isPastSeason(existing.season, this.now())) {
          listing = { ...listing, season: existing.season, seasonSource: 'posting' };
        }
        let reachability: Reachability = 'implied';
        let described: boolean | undefined;
        let pageEvidence: ApplicationPageEvidence | undefined;
        const needsMetadataValidation = listing.seasonSource === 'source-default'
          && existing?.applicationPageMetadataVersion !== applicationPageMetadataVersion;
        const destinationRule = admissionManaged && listing.providerIdentity && this.catalogAdmissionResolver
          ? await this.catalogAdmissionResolver.resolveDestinationRule(listing.providerIdentity, listing.applyUrl)
          : undefined;
        const initialDestination = classifyDestination({ listing, reachability, inspectedAt: this.now().toISOString(), ...(destinationRule ? { rule: destinationRule } : {}) });
        const needsPostingAttribution = listing.provenance === 'reviewed-community' && attribution === 'unattributed';
        // Standard provider routes are proven by immutable IDs. Custom routes
        // need page evidence even when the provider API attributed the posting.
        const needsValidation = Boolean(this.validateApplicationUrl && listing.technical !== false
          && (admissionManaged ? initialDestination.classification === 'unresolved' || needsPostingAttribution : attribution === 'unattributed')
          && existing?.invalidApplicationUrl !== normalizedUrl
          && (needsMetadataValidation || needsPostingAttribution || !existing?.applicationUrlValidatedAt || existing.normalizedUrl !== normalizedUrl));
        if (needsValidation) {
          try {
            const validation = await this.validateApplicationUrl!(listing.applyUrl);
            if (typeof validation === 'string') reachability = 'live';
            else {
              pageEvidence = validation.evidence;
              const confidence = assessApplicationPageForListing(listing.title, validation.evidence);
              reachability = reachabilityFromSignals(confidence.signals);
              described = confidence.recommendation === 'alert-eligible';
              const titleSeason = inferSeason(listing.title, '', this.now());
              const pageSeason = inferSeason(
                validation.evidence.title ?? '',
                [validation.evidence.description, validation.evidence.contentExcerpt].filter(Boolean).join(' '),
                this.now(),
              );
              const verifiedSeason = titleSeason !== 'ongoing' ? titleSeason : pageSeason;
              if (verifiedSeason !== 'ongoing') listing = { ...listing, season: verifiedSeason, seasonSource: 'posting' };
              metadataValidated.set(id, applicationPageMetadataVersion);
            }
          } catch (error) {
            reachability = reachabilityFromFailure(error);
            const failure = `${listing.sourceId}: row ${listing.row}: ${error instanceof Error ? error.message : String(error)}`;
            // A probe that never completed, or one that resolved to a dead link,
            // withdraws its row rather than failing the delivery; a genuinely
            // broken list is caught by the share gate in the caller.
            // A confirmed 404/410 is a complete negative destination decision:
            // admission below persists it without publishing the row. In a
            // bounded metadata refresh, inconclusive probes must remain pending
            // instead of entering the processed-row checkpoint ledger.
            if (!(stampSourceMetadata && reachability === 'gone' && admissionManaged)) {
              if (isProbeFailure(error, true) && !stampSourceMetadata) {
                withdrawnProbeFailures.push(failure);
                if (isRetryableProbeFailure(error, true)) {
                  retryableRowExternalIds.add(id);
                  failedExternalIds.add(id);
                  return;
                }
                brokenProbeFailures.push(failure);
              } else failures[slot] = failure;
            }
            if (stampSourceMetadata && reachability !== 'gone') failedExternalIds.add(id);
            if (!admissionManaged) {
              failedExternalIds.add(id);
              if (existing?.open && reachability === 'gone') await this.quarantine(existing);
              await completeFailedAdmissionMigration();
              // A durable 404/410 outcome is complete, not a transient retry.
              // Wait for quarantine and any prior admission record to persist
              // before allowing this row into the metadata progress ledger.
              if (stampSourceMetadata && reachability === 'gone' && handledExternalIds.has(id)) {
                failedExternalIds.delete(id);
                failures[slot] = undefined;
              }
              return;
            }
          }
        }
        const verification = verifyApplication({ attribution, reachability, ...(described === undefined ? {} : { described }) });
        if (!admissionManaged) {
          if (attribution !== 'unattributed' || (needsValidation && verification.alertEligible)) validatedAt.set(id, this.now().toISOString());
          if (verification.alertEligible) alertEligible.add(id);
          resolved.set(id, existing);
          accepted[slot] = listing;
          handledExternalIds.add(id);
          return;
        }
        const inspectedAt = this.now().toISOString();
        const observedDestination = classifyDestination({ listing, reachability, ...(pageEvidence ? { evidence: pageEvidence } : {}), inspectedAt,
          ...(destinationRule ? { rule: destinationRule } : {}) });
        // Explicit reviewed decisions remain authoritative when configuration
        // changes. Browser evidence may only supplement an unresolved route or
        // satisfy a rule that specifically requires browser inspection.
        const browserDestination = listing.providerIdentity
          && (!destinationRule || destinationRule.decision === 'browser-required')
          ? matchingBrowserDestination(existing, {
            sourceId: listing.sourceId, externalId: id, providerIdentity: listing.providerIdentity, candidateUrl: listing.applyUrl,
          })
          : undefined;
        const priorDestination = priorOccurrence?.occurrence.admission?.destination;
        const reusableTrustedDestination = trustedCommunityPolicy
          && !needsValidation && !destinationRule
          && priorDestination
          && postingSpecificDestination(priorDestination)
          && sameApplicationUrl(priorDestination.candidateUrl, normalizedUrl)
          ? priorDestination
          : undefined;
        const freshNegative = needsValidation && !postingSpecificDestination(observedDestination);
        const destination = freshNegative || (destinationRule && destinationRule.decision !== 'browser-required')
          ? observedDestination
          : browserDestination ?? reusableTrustedDestination ?? observedDestination;
        if (!browserDestination && pageEvidence && ['posting-detail', 'application-form'].includes(destination.classification)) {
          const pageMetadata = extractVerifiedPageMetadataEvidence({
            expectedTitle: listing.title,
            expectedPostingId: listing.providerIdentity?.postingId,
            page: {
              title: pageEvidence.title ?? listing.title,
              // Structured descriptions must pass the JSON-LD posting match;
              // do not also promote them as independently verified page text.
              text: pageEvidence.contentSource === 'json-ld' ? undefined : pageEvidence.contentExcerpt,
            },
            jsonLdArtifacts: pageEvidence.metadataArtifacts,
            sourceId: listing.sourceId,
            sourceUrl: pageEvidence.url,
            observedAt: inspectedAt,
            exactPosting: true,
          });
          listing = {
            ...listing,
            metadataEvidence: mergeRoleMetadataEvidence(listing.metadataEvidence, pageMetadata),
            metadataExtraction: {
              version: ROLE_METADATA_EXTRACTION_VERSION,
              artifactHash: pageEvidence.contentHash ?? pageEvidence.renderedEvidenceHash ?? createHash('sha256').update(JSON.stringify({ url: pageEvidence.url, title: pageEvidence.title, description: pageEvidence.description })).digest('hex'),
              observedAt: inspectedAt,
              outcome: pageMetadata.some(roleMetadataEvidenceHasFields) ? 'extracted' : 'no-explicit-metadata',
            },
          };
          metadataValidated.set(id, applicationPageMetadataVersion);
        }
        const trustedCommunityAlertQualification = trustedCommunityPolicy
          ? { ...advanceTrustedCommunityQualification({
            previous: priorOccurrence?.occurrence.trustedCommunityAlertQualification,
            destination,
            postingIdentityDecision: listing.postingIdentityDecision,
            alertMode: trustedCommunityPolicy.alertMode,
            completeFetchSequence,
            // Every occurrence observed while alerts are disabled belongs to
            // the quiet baseline, including roles added during a multi-run
            // catalog migration.
            baselineSuppressed: trustedCommunityPolicy.alertMode === 'disabled'
              || Boolean(priorOccurrence && !priorOccurrence.occurrence.trustedCommunityAlertQualification),
            catalogPublicationSuppressed: false,
          }), sourceMaterialHash: materialHash }
          : undefined;
        const admission = evaluateCatalogAdmission({
          listing,
          destination,
          postingAttributed: listing.provenance !== 'reviewed-community' || attribution !== 'unattributed' || described === true
            || existing?.sourceReferences.some((reference) => reference.sourceId === listing.sourceId && reference.externalId === id
              && reference.admission?.postingAttribution === 'attributed') === true,
          evaluatedAt: inspectedAt,
          previous: priorOccurrence?.occurrence.admission ?? existing?.admission,
          ...(trustedCommunityPolicy && trustedCommunityAlertQualification
            ? { trustedCommunity: { policy: trustedCommunityPolicy, qualification: trustedCommunityAlertQualification } }
            : {}),
        });
        // Activating reviewed employer mappings must not hide a previously
        // visible exact-URL role merely because its per-posting browser check
        // has not run yet. It receives no new alert and remains legacy-managed
        // until the queued verifier supplies attribution. New rows still fail
        // closed through the normal admission decision above.
        const preserveLegacyWhileAttributionPending = Boolean(existing && !existing.admission
          && knownLegacyDestination && listing.provenance === 'reviewed-community'
          && destination.classification === 'posting-detail'
          && admission.reasonCodes.length === 1 && admission.reasonCodes[0] === 'posting-unattributed');
        if (!preserveLegacyWhileAttributionPending) listing = {
          ...listing,
          admission,
          ...(trustedCommunityAlertQualification ? { trustedCommunityAlertQualification } : {}),
        };
        const needsPostingAttributionVerification = admission.reasonCodes.includes('posting-unattributed')
          && ['posting-detail', 'application-form'].includes(destination.classification);
        if (!browserDestination && this.enqueueDestinationVerification && listing.providerIdentity
          && (requiresBrowserVerification(destination) || needsPostingAttributionVerification)) {
          try {
            await this.enqueueDestinationVerification({
              jobId: listing.postingIdentity?.canonicalJobId ?? stableSourceOccurrenceJobId(listing.sourceId, id),
              sourceId: listing.sourceId,
              externalId: id,
              providerIdentity: listing.providerIdentity,
              candidateUrl: listing.applyUrl,
              reason: existing?.normalizedUrl && existing.normalizedUrl !== normalizedUrl ? 'url-change' : 'first-sight',
              metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
            });
          } catch (error) {
            throw new DestinationHandoffError(error);
          }
        } else if (providerShadowEligible && this.enqueueDestinationVerification && listing.providerIdentity
          && listing.postingIdentityDecision?.status === 'confirmed'
          && listing.technical !== false && listing.state === 'open' && shadowEvaluationAdmissionEligible(listing, admission)
          && Boolean(listing.shadowContentHash)
          && (!priorOccurrence || (Boolean(priorOccurrence.occurrence.shadowContentHash)
            && priorOccurrence.occurrence.shadowContentHash !== listing.shadowContentHash))
          && ['greenhouse', 'lever', 'ashby'].includes(listing.providerIdentity.provider)) {
          const reason = existing?.normalizedUrl && existing.normalizedUrl !== normalizedUrl
            ? 'url-change' as const : priorOccurrence ? 'content-change' as const : 'first-sight' as const;
          const jobId = listing.postingIdentity?.canonicalJobId ?? stableSourceOccurrenceJobId(listing.sourceId, id);
          providerShadowVerifications.push({
            jobId, sourceId: listing.sourceId, externalId: id, providerIdentity: listing.providerIdentity,
            candidateUrl: listing.applyUrl, reason, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
            shadowContentHash: listing.shadowContentHash,
            shadowOrigin: 'provider-poll',
            idempotencyKey: createHash('sha256').update(`provider-poll-shadow-v1\0${jobId}\0${listing.sourceId}\0${id}\0${listing.shadowContentHash}`).digest('hex'),
          });
        }
        if (admission.catalogEligible && ['posting-detail', 'application-form'].includes(destination.classification)) {
          validatedAt.set(id, this.now().toISOString());
        }
        if (admission.alertEligible) alertEligible.add(id);
        resolved.set(id, existing);
        accepted[slot] = listing;
        handledExternalIds.add(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = `${listing.sourceId}: row ${listing.row}: ${message}`;
        if (error instanceof DestinationHandoffError) {
          deferredHandoffFailures.push(failure);
          retryableRowExternalIds.add(id);
        } else if (isProbeFailure(error)) {
          withdrawnProbeFailures.push(failure);
          if (isRetryableProbeFailure(error)) retryableRowExternalIds.add(id);
          else brokenProbeFailures.push(failure);
        } else failures[slot] = failure;
        failedExternalIds.add(id);
        if (!(error instanceof DestinationHandoffError)) await completeFailedAdmissionMigration();
      }
    }, workConcurrency);
    // Only completed negative probes can establish a broken-list failure.
    const probeFailureShare = listings.length === 0 ? 0 : brokenProbeFailures.length / listings.length;
    if (probeFailureShare > MAX_PROBE_FAILURE_SHARE) {
      report.failures.push(
        `${listings[0]?.sourceId ?? 'source'}: ${brokenProbeFailures.length} of ${listings.length} rows could not be verified `
        + `(${(probeFailureShare * 100).toFixed(0)}% above ${MAX_PROBE_FAILURE_SHARE * 100}%)`,
        ...brokenProbeFailures.slice(0, 5),
      );
    }
    report.failures.push(...failures.filter((failure): failure is string => failure !== undefined));
    return {
      accepted: accepted.filter((listing): listing is ProcessedListing => listing !== undefined),
      resolved,
      validatedAt,
      metadataValidated,
      alertEligible,
      handledExternalIds,
      failedExternalIds,
      providerShadowVerifications,
      withdrawnProbeFailures,
      deferredHandoffFailures,
      retryableRowExternalIds,
      probeFailureShare,
    };
  }

  async run(options: {
    seedOnly?: boolean;
    runId?: string;
    allowCompleteEmptySnapshot?: boolean;
    maxAdmissionMigrationListingsPerSourceRun?: number;
    maxListingsPerSourceRun?: number;
    naturalProviderPoll?: boolean;
  } = {}): Promise<PollReport> {
    const report: PollReport = {
      fetchedSources: 0,
      unchangedSources: [],
      baselineSources: [],
      processedListings: 0,
      newJobs: [],
      filteredJobs: [],
      quarantinedListings: [],
      continuationSources: [],
      pendingResolution: {},
      failures: [],
      sourceFailures: [],
    };
    const health: SourceHealth[] = [];
    // Reviewed retired postings are read once per pass: the reconciler closes
    // them even while a community list still publishes the dead URL.
    const withdrawnPostingKeys = new Set(await this.store.listWithdrawnPostingKeys?.() ?? []);
    this.boardActiveIds.clear();
    this.boardCheckpoints = undefined;
    this.currentRunGreenhouseActiveIds.clear();
    const reviewedGreenhouseSourceIds = new Set([...new Set(this.boardIndex.values())]
      .filter((sourceId) => providerEvidenceForOccurrence(sourceId, '1')?.provider === 'greenhouse'));
    const prefetchedBoards = new Map<string, PrefetchedBoardFetch>();
    // Fetch every reviewed Greenhouse connector before resolving any listing.
    // Tenant-less embed aliases are safe only when uniqueness includes all
    // current snapshots, including boards processed later in this run.
    for (const connector of this.connectors) {
      if (!reviewedGreenhouseSourceIds.has(connector.id)) continue;
      const prefetched: PrefetchedBoardFetch = {
        attemptedAt: this.now().toISOString(),
        started: Date.now(),
      };
      prefetchedBoards.set(connector.id, prefetched);
      try {
        prefetched.previous = await this.store.getCheckpoint(connector.id);
        prefetched.admissionConfigurationVersion = effectiveAdmissionConfigurationVersion({
          sourceId: connector.id,
          resolverVersion: await this.catalogAdmissionResolver?.configurationVersion?.(),
          trustedCommunityCatalogEnabled: this.trustedCommunityCatalogEnabled,
        });
        const configurationChanged = Boolean(prefetched.previous?.pendingAdmissionConfigurationVersion || (prefetched.admissionConfigurationVersion
          && prefetched.previous?.admissionConfigurationVersion
          && prefetched.admissionConfigurationVersion !== prefetched.previous.admissionConfigurationVersion));
        const metadataVersionChanged = prefetched.previous?.metadataExtractionVersion !== ROLE_METADATA_EXTRACTION_VERSION
          || prefetched.previous?.metadataProcessingRevision !== SOURCE_METADATA_PROCESSING_REVISION;
        const fetchCheckpoint = (configurationChanged || metadataVersionChanged) && prefetched.previous ? {
          ...prefetched.previous,
          etag: undefined,
          documentEtags: undefined,
          contentHash: undefined,
        } : prefetched.previous;
        prefetched.result = await fetchWithRetry(connector, fetchCheckpoint);
        const qualityFailures = sourceQualityFailures(prefetched.result, prefetched.previous, {
          allowCompleteEmptySnapshot: options.allowCompleteEmptySnapshot && isSourceSnapshot(prefetched.result),
        });
        if (!qualityFailures.length) {
          const activeExternalIds = isSourceSnapshot(prefetched.result)
            ? prefetched.result.checkpoint.activeExternalIds ?? prefetched.result.postings.map((posting) => posting.externalId)
            : prefetched.result.checkpoint.activeExternalIds ?? prefetched.result.listings.map(externalId);
          this.currentRunGreenhouseActiveIds.set(connector.id, new Set(activeExternalIds));
        }
      } catch (error) {
        prefetched.error = error;
      }
    }
    for (const connector of this.connectors) {
      const prefetched = prefetchedBoards.get(connector.id);
      const attemptedAt = prefetched?.attemptedAt ?? this.now().toISOString();
      const started = prefetched?.started ?? Date.now();
      const previous = prefetched ? prefetched.previous : await this.store.getCheckpoint(connector.id);
      const previousHealth = await this.store.getSourceHealth(connector.id);
      let failureCategory: NonNullable<SourceHealth['diagnosticCategory']> = 'transport';
      let trustedMetrics: SourceHealth['trustedCommunity'];
      try {
        const admissionConfigurationVersion = prefetched
          ? prefetched.admissionConfigurationVersion
          : effectiveAdmissionConfigurationVersion({
            sourceId: connector.id,
            resolverVersion: await this.catalogAdmissionResolver?.configurationVersion?.(),
            trustedCommunityCatalogEnabled: this.trustedCommunityCatalogEnabled,
          });
        let remainingMigrationLimit = options.maxAdmissionMigrationListingsPerSourceRun;
        let revocationOccurrences: SourceOccurrenceState[] | undefined;
        if (!this.trustedCommunityCatalogEnabled && sourceAdmissionPolicy(connector.id).trust === 'trusted-community') {
          failureCategory = 'persistence';
          // The sweep and the reconciliation below read the same rows, so one
          // read serves both: each rewritten occurrence replaces its entry in
          // this array, keeping it identical to a second read of the source.
          const occurrences = await this.store.getSourceOccurrences(connector.id);
          revocationOccurrences = occurrences;
          const revocationIndexes: number[] = [];
          occurrences.forEach((item, index) => {
            if (item.occurrence.admission?.evidenceCodes?.includes('trusted-community-source')) revocationIndexes.push(index);
          });
          if (revocationIndexes.length) await this.store.putCheckpoint({
            sourceId: connector.id, successfulFetches: 0, ...previous,
            pendingAdmissionConfigurationVersion: admissionConfigurationVersion ?? 'standard-v1',
          });
          const selectedIndexes = remainingMigrationLimit === undefined
            ? revocationIndexes : revocationIndexes.slice(0, remainingMigrationLimit);
          for (const index of selectedIndexes) {
            occurrences[index] = await this.revokeTrustedCommunityAdmission(
              occurrences[index]!, admissionConfigurationVersion, this.now().toISOString());
          }
          if (remainingMigrationLimit !== undefined) remainingMigrationLimit -= selectedIndexes.length;
          if (selectedIndexes.length < revocationIndexes.length) {
            report.continuationSources.push(connector.id);
            continue;
          }
        }
        failureCategory = 'transport';
        if (prefetched?.error) throw prefetched.error;
        const admissionConfigurationChanged = Boolean(previous?.pendingAdmissionConfigurationVersion || (admissionConfigurationVersion
          && previous?.admissionConfigurationVersion
          && admissionConfigurationVersion !== previous.admissionConfigurationVersion));
        const metadataVersionChanged = previous?.metadataExtractionVersion !== ROLE_METADATA_EXTRACTION_VERSION
          || previous?.metadataProcessingRevision !== SOURCE_METADATA_PROCESSING_REVISION;
        // A validators-only response carries no rows, so an open bounded
        // resolution pass must re-read the whole board to make progress. Only
        // the validators are cleared: the content hash still labels the
        // re-read as unchanged instead of reporting a spurious source change.
        const resolutionPassOpen = Boolean(previous?.pendingResolutionRows?.length);
        const fetchCheckpoint = resolutionPassOpen && previous ? {
          ...previous,
          etag: undefined,
          documentEtags: undefined,
        } : (admissionConfigurationChanged || metadataVersionChanged) && previous ? {
          ...previous,
          etag: undefined,
          documentEtags: undefined,
          contentHash: undefined,
        } : previous;
        const result = prefetched?.result ?? await fetchWithRetry(connector, fetchCheckpoint);
        report.fetchedSources += 1;
        failureCategory = 'quality';
        const qualityFailures = sourceQualityFailures(result, previous, {
          allowCompleteEmptySnapshot: options.allowCompleteEmptySnapshot && isSourceSnapshot(result),
        });
        if (qualityFailures.length) throw new SourceFetchError(qualityFailures.join('; '), 'empty');
        const batch = isSourceSnapshot(result) ? neutralBatch(result) : legacyBatch(result);
        if (batch.unchanged) report.unchangedSources.push(connector.id);
        const baseline = Boolean(!previous || previous.successfulFetches === 0 || options.seedOnly);
        if (baseline) report.baselineSources.push(connector.id);
        report.processedListings += batch.processed.counts.eligible;
        const now = this.now().toISOString();
        const priorOccurrences = revocationOccurrences ?? await this.store.getSourceOccurrences(connector.id);
        // An unchanged snapshot repeats postings the checkpoint already trusts, so
        // only omission progress is reconciled; re-resolving every row would cost a
        // full catalog rewrite on every poll for byte-identical source content.
        const githubAdmissionConfigurationVersion = providerFor(connector.id) === 'github'
          ? admissionConfigurationVersion
          : undefined;
        const boundedMetadataRefresh = Boolean(previous && metadataVersionChanged && githubAdmissionConfigurationVersion
          && options.maxAdmissionMigrationListingsPerSourceRun !== undefined);
        const migrationLimit = (admissionConfigurationChanged || boundedMetadataRefresh) && githubAdmissionConfigurationVersion
          ? remainingMigrationLimit
          : undefined;
        const priorByExternalId = new Map(priorOccurrences.map((occurrence) => [occurrence.externalId, occurrence]));
        const requiredMigrationCandidates = migrationLimit === undefined ? [] : batch.processed.listings.filter((sourceListing) => {
          const prior = priorByExternalId.get(externalId(sourceListing));
          // The per-occurrence stamp is the durable migration cursor. Stored
          // occurrences can contain page-derived enrichment (for example a
          // verified season) that deliberately differs from the raw source;
          // reopening those rows by material comparison makes a completed
          // slice recur forever.
          return prior && (prior.occurrence.admissionConfigurationVersion !== githubAdmissionConfigurationVersion
            || (this.trustedCommunityCatalogEnabled && prior.occurrence.trustedCommunityAlertQualification?.sourceMaterialHash
              && prior.occurrence.trustedCommunityAlertQualification.sourceMaterialHash !== sourceMaterialHash(sourceListing)));
        });
        const metadataProgressKey = (row: NonNullable<SourceCheckpoint['pendingMetadataProcessedRows']>[number]) =>
          JSON.stringify([row.externalId, row.sourceMaterialHash, row.extractionVersion, row.processingRevision]);
        const priorMetadataProgress = new Set((previous?.pendingMetadataProcessedRows ?? []).map(metadataProgressKey));
        const metadataRowProcessed = (sourceListing: ProcessedListing) => {
          const materialHash = sourceMaterialHash(sourceListing);
          const prior = priorByExternalId.get(externalId(sourceListing));
          // Parser progress cannot stand in for lifecycle reconciliation. If a
          // row disappeared after it was parsed, its unchanged reappearance
          // must still restore the occurrence before the refresh certifies.
          if (prior && (!prior.present || prior.occurrence.state !== sourceListing.state)) return false;
          return priorMetadataProgress.has(metadataProgressKey({
            externalId: externalId(sourceListing), sourceMaterialHash: materialHash,
            extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
            processingRevision: SOURCE_METADATA_PROCESSING_REVISION,
          }));
        };
        const opportunisticMigrationCandidates = migrationLimit === undefined ? [] : batch.processed.listings.filter((sourceListing) =>
          !priorByExternalId.has(externalId(sourceListing))
          && !(boundedMetadataRefresh && metadataRowProcessed(sourceListing)));
        const metadataMigrationCandidates = !boundedMetadataRefresh ? [] : batch.processed.listings.filter((sourceListing) => {
          // The checkpoint ledger is the refresh transaction cursor. An
          // occurrence stamp can be committed before a later metadata-evidence
          // write fails, so it is observability only and cannot prove that this
          // refresh row completed atomically.
          return !metadataRowProcessed(sourceListing);
        });
        const selectedRequiredMigrations = migrationLimit === undefined
          ? []
          : requiredMigrationCandidates.slice(0, migrationLimit);
        // Standard migrations retain their final full-role pass. Trusted
        // migrations bound new evidence too, then use spare capacity to publish
        // already inspected occurrences. Overflow forces another full fetch.
        const trustedPolicy = activeTrustedCommunityPolicy(connector.id, this.trustedCommunityCatalogEnabled);
        const opportunisticCapacity = migrationLimit === undefined
          ? 0
          : boundedMetadataRefresh
            ? Math.max(0, migrationLimit - selectedRequiredMigrations.length)
          : !trustedPolicy && requiredMigrationCandidates.length === 0
            ? opportunisticMigrationCandidates.length
            : Math.max(0, migrationLimit - selectedRequiredMigrations.length);
        const selectedOpportunisticMigrations = migrationLimit === undefined
          ? []
          : opportunisticMigrationCandidates.slice(0, opportunisticCapacity);
        const publicationCandidates = trustedPolicy && migrationLimit !== undefined
          ? batch.processed.listings.filter((listing) => {
            const prior = priorByExternalId.get(externalId(listing));
            return prior && prior.occurrence.admissionConfigurationVersion === githubAdmissionConfigurationVersion
              && (!prior.occurrence.trustedCommunityAlertQualification?.sourceMaterialHash
                || prior.occurrence.trustedCommunityAlertQualification.sourceMaterialHash === sourceMaterialHash(listing))
              && prior.occurrence.trustedCommunityAlertQualification?.catalogPublicationSuppressed === true;
          }) : [];
        const publicationCapacity = migrationLimit === undefined ? 0
          : Math.max(0, migrationLimit - selectedRequiredMigrations.length - selectedOpportunisticMigrations.length);
        const selectedPublications = publicationCandidates.slice(0, publicationCapacity);
        const admissionCandidates = [...selectedRequiredMigrations, ...selectedOpportunisticMigrations, ...selectedPublications];
        const selectedMetadataMigrations = migrationLimit === undefined ? [] : metadataMigrationCandidates
          .filter((listing) => !admissionCandidates.some((candidate) => externalId(candidate) === externalId(listing)))
          .slice(0, Math.max(0, migrationLimit - admissionCandidates.length));
        const migrationCandidates = migrationLimit === undefined
          ? batch.processed.listings
          : [...admissionCandidates, ...selectedMetadataMigrations];
        // A trusted policy re-reads the whole body to advance an alert
        // qualification streak, and a policy with alerts disabled never
        // computes one: catalog exposure alone must not re-resolve every
        // listing on every poll (the largest trusted list holds 3,029 rows).
        const trustedFullBody = trustedPolicy?.alertMode !== undefined && trustedPolicy.alertMode !== 'disabled'
          && result.unchangedReason !== 'not_modified';
        const metadataFullBody = metadataVersionChanged && result.unchangedReason !== 'not_modified';
        // An unchanged snapshot repeats postings the checkpoint already trusts,
        // so it resolves nothing unless a full body is due for another reason.
        const resolutionDue = !batch.unchanged || trustedFullBody || metadataFullBody;
        // A cleared-validator refetch of unchanged content still reports
        // `unchangedReason: 'content_hash'`, so an open pass has to keep the
        // full body in scope or it could never resolve its next slice.
        const pendingResolutionRows = new Set(previous?.pendingResolutionRows ?? []);
        const resolutionFullBody = options.maxListingsPerSourceRun !== undefined
          && (pendingResolutionRows.size > 0
            || (resolutionDue && batch.processed.listings.length > options.maxListingsPerSourceRun));
        const listingsToResolve = migrationLimit === undefined
          ? (resolutionDue || resolutionFullBody ? batch.processed.listings : [])
          : migrationCandidates;
        // An admission migration's own rows stay obligated in every delivery,
        // including one that also advances a bounded resolution pass.
        const obligatedListings = migrationLimit === undefined ? [] : listingsToResolve;
        // A pass slice comes from the whole board rather than from a concurrent
        // migration's candidates, so neither pass can close the other early.
        const previouslyActiveIds = new Set(previous?.activeExternalIds ?? []);
        const resolutionScope = pendingResolutionRows.size
          ? batch.processed.listings.filter((listing) => {
            const id = externalId(listing);
            if (pendingResolutionRows.has(id) || !previouslyActiveIds.has(id)) return true;
            const priorMaterialHash = priorByExternalId.get(id)?.occurrence.trustedCommunityAlertQualification?.sourceMaterialHash;
            return priorMaterialHash !== undefined && priorMaterialHash !== sourceMaterialHash(listing);
          })
          : migrationLimit === undefined ? listingsToResolve : [];
        const obligatedIds = new Set(obligatedListings.map(externalId));
        const sliceCapacity = options.maxListingsPerSourceRun === undefined
          ? undefined
          : Math.max(0, options.maxListingsPerSourceRun - obligatedListings.length);
        const selectedSlice = sliceCapacity === undefined ? resolutionScope : resolutionScope.slice(0, sliceCapacity);
        const resolvedListings = obligatedListings.length
          ? [...obligatedListings, ...selectedSlice.filter((listing) => !obligatedIds.has(externalId(listing)))]
          : selectedSlice;
        // Rows that left the board between deliveries stop holding the pass
        // open; they have no listing to resolve and are reconciled as omissions.
        const remainingRows = resolutionFullBody
          ? resolutionScope.slice(sliceCapacity ?? resolutionScope.length).map(externalId)
          : [];
        const resolution = await this.resolveListings(
          resolvedListings,
          report,
          priorOccurrences,
          githubAdmissionConfigurationVersion,
          Boolean(githubAdmissionConfigurationVersion
            && !admissionConfigurationChanged
            && admissionConfigurationVersion === previous?.admissionConfigurationVersion),
          result.unchangedReason === 'not_modified' ? undefined : result.checkpoint.successfulFetches,
          boundedMetadataRefresh,
          !baseline && options.naturalProviderPoll === true,
          options.maxListingsPerSourceRun !== undefined
            && options.maxListingsPerSourceRun <= GITHUB_RESOLUTION_ROWS_PER_DELIVERY
            && migrationLimit === undefined
            ? GITHUB_RESOLUTION_WORK_CONCURRENCY : SOURCE_WORK_CONCURRENCY,
        );
        // Keep inconclusive rows in the checkpoint without making the whole
        // slice retry. Finish unvisited rows first; once only probes remain,
        // the next scheduled poll retries them without a hot queue loop.
        const nextPendingRows = [...new Set([
          ...remainingRows,
          ...resolvedListings.filter((listing) => resolution.retryableRowExternalIds.has(externalId(listing))).map(externalId),
        ])];
        // Existing catalog decisions are the durable migration obligation.
        // Rows with no prior occurrence are evaluated with spare slice capacity
        // but fail closed and cannot hold the source checkpoint open forever.
        if (resolution.withdrawnProbeFailures.length) {
          console.log(JSON.stringify({
            event: 'row_probe_withdrawn',
            sourceId: connector.id,
            count: resolution.withdrawnProbeFailures.length,
            brokenShare: Number(resolution.probeFailureShare.toFixed(4)),
            retryableCount: resolution.retryableRowExternalIds.size,
            samples: resolution.withdrawnProbeFailures.slice(0, 5),
          }));
        }
        if (resolution.deferredHandoffFailures.length) {
          console.error(JSON.stringify({
            event: 'row_handoff_deferred', sourceId: connector.id,
            count: resolution.deferredHandoffFailures.length,
            samples: resolution.deferredHandoffFailures.slice(0, 5),
          }));
        }
        const admissionEvidencePending = migrationLimit !== undefined && (
          requiredMigrationCandidates.length > selectedRequiredMigrations.length
          || selectedRequiredMigrations.some((listing) => !resolution.handledExternalIds.has(externalId(listing)))
          || opportunisticMigrationCandidates.length > selectedOpportunisticMigrations.length
        );
        const metadataMigrationPending = boundedMetadataRefresh && (
          result.unchangedReason === 'not_modified'
          || metadataMigrationCandidates.length > migrationCandidates.filter((listing) =>
            metadataMigrationCandidates.some((candidate) => externalId(candidate) === externalId(listing))).length
          || migrationCandidates.filter((listing) => metadataMigrationCandidates.some((candidate) => externalId(candidate) === externalId(listing)))
            .some((listing) => !resolution.handledExternalIds.has(externalId(listing)))
        );
        let admissionMigrationPending = admissionEvidencePending || metadataMigrationPending
          || publicationCandidates.length > selectedPublications.length
          || selectedPublications.some((listing) => !resolution.handledExternalIds.has(externalId(listing)));
        const missingOccurrences = priorOccurrences.filter((prior) => !batch.activeExternalIds.has(prior.externalId));
        const pendingOmissionIds = new Set((previous?.pendingMetadataOmissions ?? [])
          .filter((item) => item.extractionVersion === ROLE_METADATA_EXTRACTION_VERSION
            && item.processingRevision === SOURCE_METADATA_PROCESSING_REVISION
            && !batch.activeExternalIds.has(item.externalId))
          .map((item) => item.externalId));
        const unprocessedMissingOccurrences = missingOccurrences.filter((prior) => !pendingOmissionIds.has(prior.externalId));
        const selectedClosures = boundedMetadataRefresh && !admissionMigrationPending
          ? (metadataMigrationCandidates.length ? [] : unprocessedMissingOccurrences.slice(0, migrationLimit))
          : [];
        const lifecycleMigrationPending = boundedMetadataRefresh
          && (unprocessedMissingOccurrences.length > selectedClosures.length
            || metadataMigrationCandidates.length > 0 && unprocessedMissingOccurrences.length > 0);
        admissionMigrationPending ||= lifecycleMigrationPending;
        if (admissionMigrationPending) report.continuationSources.push(connector.id);
        // An open resolution pass also holds the source open: the delivery that
        // empties it reconciles omissions and closures in the same message.
        if (remainingRows.length && !report.continuationSources.includes(connector.id)) {
          report.continuationSources.push(connector.id);
        }
        if (nextPendingRows.length) report.pendingResolution[connector.id] = nextPendingRows.length;
        // Greenhouse boards that exceed the response ceiling acquire their
        // descriptions separately. The index is already complete, but its
        // bounded detail pass still needs another queue delivery.
        if (result.checkpoint.pendingGreenhousePostingIds?.length
          && !report.continuationSources.includes(connector.id)) {
          report.continuationSources.push(connector.id);
        }
        if (trustedPolicy && result.unchangedReason !== 'not_modified') {
          const diagnostics = result.trustedCommunityDiagnostics ?? {
            rejectedAggregatorRows: result.rejectedApplicationUrls?.filter((item) => item.reason.includes('aggregator')).length ?? 0,
            survivingAggregatorRows: 0,
            duplicateOccurrenceIds: 0,
          };
          trustedMetrics = trustedCommunityMetrics({
            rawRows: batch.processed.counts.raw,
            eligibleRows: batch.processed.counts.eligible,
            listings: resolution.accepted,
            priorOccurrences,
            eligibleExternalIds: new Set(batch.processed.listings
              .filter((listing) => listing.technical !== false)
              .map(externalId)),
            admissionConfigurationVersion: githubAdmissionConfigurationVersion,
            ...diagnostics,
          });
          emitTrustedCommunityMetric(connector.id, trustedMetrics, options.runId);
          const breaches = trustedCommunityCircuitBreaches({
            metrics: trustedMetrics,
            alertMode: trustedPolicy.alertMode,
            // Judge the list against its own observed shape: these boards differ
            // by an order of magnitude in size.
            thresholds: trustedCommunityThresholdsFor(connector.id),
            // Partial bounded slices are allowed to accumulate evidence. Any
            // pass that can clear suppression or advance the policy checkpoint
            // must prove that the current eligible snapshot was inspected.
            requireCompleteInspection: !admissionEvidencePending,
          });
          if (breaches.length) {
            // Hidden listings apply either way: the per-posting inspection keeps
            // unsafe rows out of the catalog whether or not the list is stopped.
            await this.hideUnsafeTrustedCommunityListings({
              sourceId: connector.id,
              snapshotHash: batch.snapshotHash,
              listings: resolution.accepted,
              priorOccurrences,
              resolvedJobs: resolution.resolved,
              now,
              withdrawnPostingKeys,
            });
            // An alert-only policy still hides the unsafe listings and records the
            // breach, but the source keeps polling instead of quarantining: the
            // reviewed list's anomalies are caught per posting downstream.
            if (trustedPolicy.circuitBreaker === 'alert') {
              // An aggregate breach alerts; it does not overturn a posting's own
              // admission. Owner decision, 2026-09-17: admission is durable and
              // nothing re-checks it afterwards, so the row's own evidence — the
              // per-posting hiding above — is what withholds a role, not the
              // list's aggregate shape. Suppressing every listing of a breaching
              // pass is a post-admission re-check in disguise: replaying six
              // lists on 2026-09-17 hid ~3,500 roles that were already live.
              // Only notifications pause for the anomalous pass.
              resolution.alertEligible.clear();
              console.log(JSON.stringify({
                event: 'trusted_community_circuit_alert',
                sourceId: connector.id,
                breaches,
                rawRows: trustedMetrics.rawRows,
                eligibleRows: trustedMetrics.eligibleRows,
                browserInspectionShare: trustedMetrics.browserInspectionShare,
              }));
              // The reviewed list keeps polling instead of quarantining: its
              // anomalies are caught per posting downstream. The pass falls
              // through rather than ending here: dropping the continuation and
              // the checkpoint left any list whose only breach is a
              // not-yet-complete inspection floor re-inspecting the same bounded
              // slice forever.
            } else {
              // A breaching pass is not evidence that the source advanced, so it
              // never self-enqueues and the throw fails the delivery for the
              // sources that quarantine.
              report.continuationSources = report.continuationSources.filter((sourceId) => sourceId !== connector.id);
              throw new SourceFetchError(`${connector.id}: trusted-community circuit breaker: ${breaches.join('; ')}`, 'quality', undefined, undefined, true);
            }
          }
        }
        // A bounded policy migration stores evidence but exposes none of its
        // newly admitted rows until one complete healthy evaluation can pass.
        if (trustedPolicy && admissionEvidencePending) {
          for (const listing of resolution.accepted) {
            if (listing.trustedCommunityAlertQualification) {
              listing.trustedCommunityAlertQualification = {
                ...listing.trustedCommunityAlertQualification,
                catalogPublicationSuppressed: true,
              };
            }
            if (listing.admission) listing.admission = { ...listing.admission, catalogEligible: false, alertEligible: false };
          }
          resolution.alertEligible.clear();
        }
        // Admission configuration migration is independent of source
        // lifecycle reconciliation. Replaying inactive historical occurrences
        // defeats the slice bound; the next ordinary poll handles omissions.
        // A bounded admission slice and an open resolution pass both defer
        // closure work to the delivery that completes them, so no non-sliced
        // row is closed while its own slice is still pending. Non-sliced active
        // rows are still confirmed against the whole-board id set above.
        const partialMigration = nextPendingRows.length > 0 || (migrationLimit !== undefined && admissionMigrationPending);
        const closureScope = boundedMetadataRefresh ? selectedClosures : partialMigration ? [] : missingOccurrences;
        const closureCandidates = closureScope.filter((prior) => !resolution.resolved.has(prior.externalId) && prior.consecutiveOmissions >= 1);
        await forEachBounded(closureCandidates, async (prior) => {
          resolution.resolved.set(prior.externalId, await this.store.getJob(prior.jobId));
        });
        const reconciliationPriorOccurrences = migrationLimit !== undefined
          ? [...listingsToResolve.flatMap((listing) => {
            const prior = priorByExternalId.get(externalId(listing));
            return prior ? [prior] : [];
          }), ...selectedClosures]
          : priorOccurrences;
        const plan = this.reconciler.reconcile({
          sourceId: connector.id,
          snapshotHash: batch.snapshotHash,
          activeExternalIds: batch.activeExternalIds,
          listings: resolution.accepted,
          priorOccurrences: reconciliationPriorOccurrences,
          resolvedJobs: resolution.resolved,
          now,
          baseline,
          filter: this.filter,
          validatedAt: resolution.validatedAt,
          metadataValidated: resolution.metadataValidated,
          alertEligible: resolution.alertEligible,
          publishUnconfirmedIdentities: this.publishUnconfirmedIdentities,
          trustedCommunityAlertsEnabled: trustedPolicy?.alertMode === 'exact-identity-or-two-complete-snapshots',
          withdrawnPostingKeys,
        });
        failureCategory = 'persistence';
        const notificationByJobId = new Map(plan.notifications.map((event) => [event.jobId, event]));
        const shadowVerificationByOccurrence = new Map(resolution.providerShadowVerifications
          .map((request) => [`${request.sourceId}\0${request.externalId}`, request]));
        const plannedJobs = new Map(plan.jobs.map((job) => [job.jobId, job]));
        const committedJobIds = new Set<string>();
        const blockedJobIds = new Set<string>();
        const persistenceFailedJobIds = new Set<string>();
        const persistenceFailedExternalIds = new Set<string>();
        const alertedJobIds = new Set<string>();
        const notificationErrors = new Array<unknown>(plan.notifications.length);
        const consumedEvents = new Set<string>();
        const classifiedEventIds = new Set<string>();
        const persistenceConcurrency = migrationLimit === undefined
          ? SOURCE_PERSISTENCE_CONCURRENCY : SOURCE_MIGRATION_PERSISTENCE_CONCURRENCY;
        await forEachBounded(plan.occurrences, async (occurrence) => {
          try {
            const job = plannedJobs.get(occurrence.jobId);
            const decision = occurrence.occurrence.postingIdentityDecision;
            if (!job || !decision || decision.status === 'quarantined') {
              await this.store.putSourceOccurrence(occurrence);
              return;
            }
            const event = notificationByJobId.get(job.jobId);
            // Every classified occurrence for the canonical job may carry the
            // same deterministic event. The transaction/outbox uniqueness
            // boundary chooses the inserter, so one failed sibling cannot leave
            // a successfully committed job without its alert tombstone.
            const includeEvent = event;
            if (includeEvent) classifiedEventIds.add(includeEvent.eventId);
            const result = await this.store.commitPostingObservation({
              decision,
              ...(job.postingIdentity ? { identity: job.postingIdentity } : {}),
              job,
              occurrence,
              ...(includeEvent ? { notificationEvent: includeEvent } : {}),
              ...(shadowVerificationByOccurrence.get(`${occurrence.sourceId}\0${occurrence.externalId}`)
                ? { providerShadowVerification: shadowVerificationByOccurrence.get(`${occurrence.sourceId}\0${occurrence.externalId}`)! }
                : {}),
            });
            if (result.outcome === 'quarantined') {
              blockedJobIds.add(job.jobId);
              report.quarantinedListings.push({
                sourceId: occurrence.sourceId,
                row: occurrence.occurrence.row,
                reason: `posting identity conflict (${result.incident.decision.reason})`,
              });
              return;
            }
            committedJobIds.add(job.jobId);
            if (this.store.recordRoleMetadataEvidence && occurrence.occurrence.metadataEvidence?.length) {
              const projected = projectRoleMetadata(job);
              await this.store.recordRoleMetadataEvidence(job.jobId, occurrence.occurrence.metadataEvidence, projected.conflicts, now,
                occurrence.occurrence.metadataExtraction ? {
                  sourceId: occurrence.sourceId,
                  sourceClasses: VERIFIED_PAGE_METADATA_SOURCES,
                } : undefined);
            }
            if (includeEvent) {
              consumedEvents.add(includeEvent.eventId);
              if (result.notificationInserted) alertedJobIds.add(job.jobId);
            }
          } catch (error) {
            // Pressure is a delivery-level failure. Continuing the slice and
            // stamping the old decision would both amplify D1 load and skip
            // the failed row when the queued delivery retries.
            if (classifyD1Failure(error) !== 'other') throw error;
            const job = plannedJobs.get(occurrence.jobId);
            const event = job ? notificationByJobId.get(job.jobId) : undefined;
            if (event) notificationErrors[plan.notifications.indexOf(event)] = error;
            if (migrationLimit === undefined || !githubAdmissionConfigurationVersion) throw error;
            persistenceFailedJobIds.add(occurrence.jobId);
            persistenceFailedExternalIds.add(occurrence.externalId);
            const prior = priorByExternalId.get(occurrence.externalId);
            try {
              if (prior && prior.occurrence.admissionConfigurationVersion !== githubAdmissionConfigurationVersion) {
                await this.store.putSourceOccurrence({
                  ...prior,
                  occurrence: { ...prior.occurrence, admissionConfigurationVersion: githubAdmissionConfigurationVersion },
                });
              }
              report.failures.push(`${occurrence.sourceId}: ${occurrence.externalId}: migration persistence failed; preserved prior decision: ${error instanceof Error ? error.message : String(error)}`);
            } catch (preserveError) {
              throw new Error(`${error instanceof Error ? error.message : String(error)}; failed to preserve migration decision: ${preserveError instanceof Error ? preserveError.message : String(preserveError)}`);
            }
          }
        }, persistenceConcurrency);
        await forEachBounded(
          plan.jobs.filter((job) => !committedJobIds.has(job.jobId) && !blockedJobIds.has(job.jobId)
            && !persistenceFailedJobIds.has(job.jobId) && !notificationByJobId.has(job.jobId)),
          async (job) => {
            try { await this.store.putInternship(job); }
            catch (error) {
              if (migrationLimit === undefined) throw error;
              if (boundedMetadataRefresh) {
                persistenceFailedJobIds.add(job.jobId);
                for (const occurrence of plan.occurrences.filter((item) => item.jobId === job.jobId)) {
                  persistenceFailedExternalIds.add(occurrence.externalId);
                }
              }
              report.failures.push(`${connector.id}: ${job.jobId}: migration job persistence failed; preserved prior decision: ${error instanceof Error ? error.message : String(error)}`);
            }
          }, persistenceConcurrency,
        );
        // Legacy-unclassified plans retain the compatible job+event operation.
        await forEachBounded(plan.notifications.filter((event) => !classifiedEventIds.has(event.eventId) && !consumedEvents.has(event.eventId) && !blockedJobIds.has(event.jobId)), async (event, index) => {
          const job = plannedJobs.get(event.jobId);
          if (!job) { notificationErrors[index] = new Error(`Notification event ${event.eventId} has no catalog job`); return; }
          try { if (await this.store.putInternshipWithNotificationEvent(job, event)) alertedJobIds.add(event.jobId); }
          catch (error) {
            notificationErrors[index] = error;
            if (boundedMetadataRefresh) {
              persistenceFailedJobIds.add(job.jobId);
              for (const occurrence of plan.occurrences.filter((item) => item.jobId === job.jobId)) {
                persistenceFailedExternalIds.add(occurrence.externalId);
              }
            }
          }
        }, persistenceConcurrency);
        for (const job of plan.newJobs) {
          if (alertedJobIds.has(job.jobId)) report.newJobs.push(job);
        }
        const notificationError = notificationErrors.find((error) => error !== undefined);
        if (notificationError) {
          if (migrationLimit === undefined) throw notificationError;
          report.failures.push(`${connector.id}: migration notification persistence failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`);
        }
        const provider = providerFor(connector.id);
        if ((trustedPolicy || boundedMetadataRefresh) && migrationLimit !== undefined && persistenceFailedJobIds.size) {
          admissionMigrationPending = true;
          if (!report.continuationSources.includes(connector.id)) report.continuationSources.push(connector.id);
        }
        if (boundedMetadataRefresh && report.failures.length) {
          admissionMigrationPending = true;
          if (!report.continuationSources.includes(connector.id)) report.continuationSources.push(connector.id);
        }
        const unchanged304 = result.unchangedReason === 'not_modified';
        const metricCounts: ProcessedSnapshot['counts'] = unchanged304 ? {
          raw: previous?.lastRawCount ?? previous?.lastRawRowCount ?? previousHealth?.rawRows ?? batch.processed.counts.raw,
          valid: previousHealth?.validRows ?? batch.processed.counts.valid,
          eligible: previous?.lastRowCount ?? previousHealth?.eligibleRows ?? batch.processed.counts.eligible,
          shelved: previousHealth?.counts?.shelved ?? batch.processed.counts.shelved,
          filtered: previousHealth?.filteredRows ?? batch.processed.counts.filtered,
          withheld: previous?.lastWithheldRowCount ?? previousHealth?.withheldRows ?? batch.processed.counts.withheld,
        } : batch.processed.counts;
        const successHealth: SourceHealth = {
          ...successfulSourceHealth({
            contentOmitted: result.checkpoint.contentOmitted === true,
            sourceId: connector.id,
            provider,
            region: regionFor(provider),
            previous: previousHealth,
            startedAt: attemptedAt,
            completedAt: now,
            runId: options.runId,
            outcome: batch.unchanged
              ? (result.unchangedReason === 'not_modified' ? 'success_unchanged_304' : 'success_unchanged_hash')
              : 'success_changed',
            etag: result.checkpoint.etag,
            contentHash: batch.snapshotHash,
            rawRows: metricCounts.raw,
            validRows: metricCounts.valid,
            eligibleRows: metricCounts.eligible,
            filteredRows: metricCounts.filtered,
            withheldRows: metricCounts.withheld,
          }),
          counts: metricCounts,
          ...(trustedMetrics ?? previousHealth?.trustedCommunity
            ? { trustedCommunity: trustedMetrics ?? previousHealth!.trustedCommunity }
            : {}),
        };
        if (admissionMigrationPending) successHealth.lastSuccessAt = previousHealth?.lastSuccessAt;
        await this.store.putSourceHealth(successHealth);
        health.push(successHealth);
        const checkpointAdmissionConfigurationVersion = admissionMigrationPending
          ? previous?.admissionConfigurationVersion
          : admissionConfigurationVersion;
        const priorProcessedRows = previous?.pendingMetadataProcessedRows ?? [];
        const metadataMigrationExternalIds = new Set(metadataMigrationCandidates.map(externalId));
        const appendedProcessedRows = migrationCandidates.filter((listing) => metadataMigrationExternalIds.has(externalId(listing))
            && resolution.handledExternalIds.has(externalId(listing))
            && !resolution.failedExternalIds.has(externalId(listing))
            && !persistenceFailedExternalIds.has(externalId(listing)))
            .map((listing) => ({ externalId: externalId(listing), sourceMaterialHash: sourceMaterialHash(listing),
              extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, processingRevision: SOURCE_METADATA_PROCESSING_REVISION }));
        const seenMetadataProgress = new Set<string>();
        const processedRows = [...priorProcessedRows, ...appendedProcessedRows].filter((row) => {
          const key = metadataProgressKey(row);
          if (seenMetadataProgress.has(key)) return false;
          seenMetadataProgress.add(key);
          return true;
        });
        const processedOmissionIds = [...new Set([
          ...pendingOmissionIds,
          ...selectedClosures.filter((prior) => !persistenceFailedExternalIds.has(prior.externalId)).map((prior) => prior.externalId),
        ])];
        const metadataReconciled = !unchanged304 && !admissionMigrationPending
          && (boundedMetadataRefresh || migrationLimit === undefined)
          && !persistenceFailedJobIds.size && !report.failures.length;
        const checkpointSuccess = admissionMigrationPending ? {
          successfulFetches: previous?.successfulFetches ?? 0,
          lastSuccessAt: previous?.lastSuccessAt,
        } : {};
        const nextCheckpoint: SourceCheckpoint = {
          ...result.checkpoint,
          ...checkpointSuccess,
          // A 304, migration slice or failed persistence cannot certify that
          // unchanged source content has passed the current metadata parser.
          metadataExtractionVersion: metadataReconciled ? ROLE_METADATA_EXTRACTION_VERSION : previous?.metadataExtractionVersion,
          metadataProcessingRevision: metadataReconciled ? SOURCE_METADATA_PROCESSING_REVISION : previous?.metadataProcessingRevision,
          pendingMetadataProcessedRows: metadataReconciled ? undefined : processedRows,
          pendingMetadataOmissions: metadataReconciled ? undefined : processedOmissionIds.map((externalId) => ({
            externalId, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
            processingRevision: SOURCE_METADATA_PROCESSING_REVISION,
          })),
          pendingResolutionRows: nextPendingRows.length ? nextPendingRows : undefined,
          contentHash: batch.snapshotHash,
          activeExternalIds: [...batch.activeExternalIds],
          pendingAdmissionConfigurationVersion: admissionMigrationPending ? admissionConfigurationVersion : undefined,
          ...(checkpointAdmissionConfigurationVersion ? { admissionConfigurationVersion: checkpointAdmissionConfigurationVersion } : {}),
        };
        await this.store.putCheckpoint(nextCheckpoint);
        await this.drainProviderShadowVerifications();
        for (const job of plan.newJobs) {
          if (!alertedJobIds.has(job.jobId)) {
            console.log(JSON.stringify({ event: 'new_job_alert_suppressed', sourceId: connector.id, jobId: job.jobId }));
          }
        }
        report.filteredJobs.push(...plan.filteredJobs);
        emitSuccessMetric(
          connector.id,
          providerFor(connector.id),
          batch.unchanged
            ? result.unchangedReason === 'not_modified' ? 'success_unchanged_304' : 'success_unchanged_hash'
            : 'success_changed',
          metricCounts,
          Date.now() - started,
          result.conditionalRequest,
          options.runId,
        );
      } catch (error) {
        const category = error instanceof SourceFetchError ? error.category : failureCategory;
        const provider = providerFor(connector.id);
        const failureHealth: SourceHealth = {
          ...failedSourceHealth({
            sourceId: connector.id,
            provider,
            region: regionFor(provider),
            previous: previousHealth,
            startedAt: attemptedAt,
            completedAt: this.now().toISOString(),
            runId: options.runId,
            error,
          }),
          diagnosticCategory: category,
          ...(trustedMetrics ?? previousHealth?.trustedCommunity
            ? { trustedCommunity: trustedMetrics ?? previousHealth!.trustedCommunity }
            : {}),
        };
        health.push(failureHealth);
        try { await this.store.putSourceHealth(failureHealth); }
        catch { /* The original source/persistence failure remains primary. */ }
        const message = error instanceof Error ? error.message : String(error);
        report.failures.push(message);
        report.sourceFailures.push({ sourceId: connector.id, message });
        emitFailureMetric(
          connector.id,
          providerFor(connector.id),
          category,
          Date.now() - started,
          sourceFailureOutcome(error),
          options.runId,
        );
      }
    }
    emitFreshnessMetric(health, this.now());
    await this.validateUnverifiedOpenJobs(report);
    return report;
  }
}

/** @deprecated Compatibility facade; new code should construct `IngestionRunner`. */
export class Poller extends IngestionRunner {
  poll(options: {
    seedOnly?: boolean;
    runId?: string;
    allowCompleteEmptySnapshot?: boolean;
    maxAdmissionMigrationListingsPerSourceRun?: number;
    maxListingsPerSourceRun?: number;
    naturalProviderPoll?: boolean;
  } = {}) {
    return this.run(options);
  }
}
