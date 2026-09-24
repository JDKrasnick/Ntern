import { createHash } from 'node:crypto';
import { employerCategory } from '../core/employers.js';
import { isTechnicalJob, matchesJobFilter, technicalScopeFor, type JobFilter } from '../core/filters.js';
import { fingerprint, jobId, normalizeUrl } from '../core/normalize.js';
import { normalizeInternship, normalizeListing } from '../catalog-quality.js';
import { isOfficialOccurrence } from '../sources/provenance.js';
import { isPastSeason } from '../core/early-career.js';
import { deriveCanonicalAdmission } from '../catalog-admission.js';
import { providerPostingKey, providerPostingReference } from '../identity/posting.js';
import { stableSourceOccurrenceJobId } from '../identity/registry.js';
import { projectRoleMetadata } from '../role-metadata.js';
import { mergeSourceOccurrence } from '../identity/source-occurrence.js';
import type {
  Internship,
  NotificationEvent,
  ProcessedListing,
  SourceOccurrence,
  SourceOccurrenceState,
} from '../types.js';

export interface ReconciliationInput {
  sourceId: string;
  snapshotHash: string;
  activeExternalIds: Set<string>;
  listings: ProcessedListing[];
  priorOccurrences: SourceOccurrenceState[];
  resolvedJobs: Map<string, Internship | undefined>;
  now: string;
  baseline: boolean;
  filter?: JobFilter;
  validatedAt?: Map<string, string>;
  metadataValidated?: Map<string, number>;
  alertEligible?: Set<string>;
  /** Rollout gate: classified rows remain durable while publication is shadowed. */
  publishUnconfirmedIdentities?: boolean;
  /** Enabled only by the active trusted source's reviewed alert policy. */
  trustedCommunityAlertsEnabled?: boolean;
  /** Reviewed withdrawn postings as exact provider keys. A retired posting must
   * not reopen because a community list still publishes its dead URL. */
  withdrawnPostingKeys?: Set<string>;
}

/** True when the listing's own application URL names a reviewed withdrawn
 * posting. The reviewed ledger is the authority, never the row's own claim. */
function listsWithdrawnPosting(applyUrl: string, withdrawn: Set<string> | undefined): boolean {
  if (!withdrawn?.size) return false;
  try {
    const reference = providerPostingReference(applyUrl);
    if (reference.provider === 'unknown' || !reference.postingId) return false;
    return withdrawn.has(providerPostingKey({
      provider: reference.provider, tenant: reference.tenant, postingId: reference.postingId,
    }));
  } catch { return false; }
}

export interface ReconciliationPlan {
  jobs: Internship[];
  occurrences: SourceOccurrenceState[];
  notifications: NotificationEvent[];
  newJobs: Internship[];
  filteredJobs: Internship[];
}

function occurrence(listing: ProcessedListing, externalId: string): SourceOccurrence {
  return {
    sourceId: listing.sourceId,
    ...(listing.provenance ? { provenance: listing.provenance } : {}),
    externalId,
    ...(listing.admissionConfigurationVersion
      ? { admissionConfigurationVersion: listing.admissionConfigurationVersion }
      : {}),
    ...(listing.sourceMetadataProcessing ? { sourceMetadataProcessing: listing.sourceMetadataProcessing } : {}),
    ...(listing.shadowContentHash ? { shadowContentHash: listing.shadowContentHash } : {}),
    ...(listing.providerEvidence ? { providerEvidence: listing.providerEvidence } : {}),
    ...(listing.metadataEvidence?.length ? { metadataEvidence: listing.metadataEvidence } : {}),
    ...(listing.metadataExtraction ? { metadataExtraction: listing.metadataExtraction } : {}),
    ...(listing.postingIdentityDecision ? { postingIdentityDecision: listing.postingIdentityDecision } : {}),
    ...(listing.trustedCommunityAlertQualification
      ? { trustedCommunityAlertQualification: listing.trustedCommunityAlertQualification }
      : {}),
    document: listing.document,
    sourceUrl: listing.sourceUrl,
    row: listing.row,
    postedAt: listing.postedAt,
    ...(listing.providerTimestamp ? { providerTimestamp: listing.providerTimestamp } : {}),
    workMode: listing.workMode,
    company: listing.company,
    title: listing.title,
    location: listing.location,
    ...(listing.locations ? { locations: listing.locations } : {}),
    season: listing.season,
    applyUrl: listing.applyUrl,
    compensation: listing.compensation,
    ...(listing.requirements ? { requirements: listing.requirements } : {}),
    technical: listing.technical ?? true,
    state: listing.state,
    ...(listing.admission ? { admission: listing.admission } : {}),
    ...(listing.employerLabelOrigin ? { employerLabelOrigin: listing.employerLabelOrigin } : {}),
    ...(listing.employerInheritance ? { employerInheritance: listing.employerInheritance } : {}),
  };
}

/** Key order is normalized so a stored occurrence compares equal to a freshly built one. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A confirmed, unchanged occurrence needs no write; presence lives in the checkpoint. */
function occurrenceChanged(prior: SourceOccurrenceState | undefined, next: SourceOccurrenceState): boolean {
  return !prior
    || prior.present !== next.present
    || prior.consecutiveOmissions !== next.consecutiveOmissions
    || prior.jobId !== next.jobId
    || stableJson(prior.occurrence) !== stableJson(next.occurrence);
}

function genericLocation(value: string | undefined) {
  return !value || /^(unknown|unspecified|n\/?a|not (?:listed|specified)|tbd|see (?:description|job))$/i.test(value.trim());
}

function mergedPostingIdentity(existing: Internship['postingIdentity'], incoming: Internship['postingIdentity']) {
  if (!incoming) return existing;
  if (!existing) return incoming;
  // Alias claims are persisted independently. Replaying another occurrence of
  // the same canonical posting must not discard stronger provider evidence or
  // rewrite an already-audited identity merely because its URL presentation
  // was normalized by a newer writer.
  if (existing.canonicalJobId === incoming.canonicalJobId
    && (existing.provider !== 'unknown' || incoming.provider === 'unknown')) return existing;
  return incoming;
}

function anyOpenTechnicalOccurrence(references: SourceOccurrence[]): boolean {
  return references.some((reference) => reference.state === 'open' && reference.technical !== false);
}

function postingIdentityStatus(references: SourceOccurrence[]): Internship['postingIdentityStatus'] {
  const decisions = references.map((reference) => reference.postingIdentityDecision).filter(Boolean);
  if (decisions.some((decision) => decision?.status === 'confirmed')) return 'confirmed';
  if (decisions.some((decision) => decision?.status === 'unconfirmed')) return 'unconfirmed';
  return undefined;
}

function seasonAllowsOpen(season: string, identity: Internship['internshipIdentity'], references: SourceOccurrence[], now: string): boolean {
  if (!isPastSeason(season, new Date(now))) return true;
  const evidence = (identity as { season?: { evidenceStatus?: string } } | undefined)?.season?.evidenceStatus;
  return evidence === 'explicit' && references.some((reference) => reference.state === 'open' && isOfficialOccurrence(reference));
}

function merge(existing: Internship, listing: ProcessedListing, externalId: string, now: string,
  applicationUrlValidatedAt: string | undefined, metadataVersion: number | undefined, withdrawn: boolean): Internship {
  const becomingCatalogVisible = !existing.catalogVisibleAt && existing.admission?.catalogEligible === false && listing.admission?.catalogEligible === true;
  existing = normalizeInternship(existing);
  listing = normalizeListing(listing);
  const reference = occurrence(listing, externalId);
  const match = existing.sourceReferences.findIndex((item) =>
    item.sourceId === reference.sourceId
    && (item.externalId ? item.externalId === externalId : item.document === reference.document && item.row === reference.row));
  const incomingOfficial = isOfficialOccurrence(listing);
  const preferIncoming = incomingOfficial && (listing.admission?.catalogEligible ?? true);
  const useIncomingLocation = genericLocation(existing.location) || (!genericLocation(listing.location) && preferIncoming);
  const location = useIncomingLocation ? listing.location || existing.location : existing.location;
  const locations = useIncomingLocation ? listing.locations ?? existing.locations : existing.locations ?? listing.locations;
  const company = preferIncoming ? listing.company || existing.company : existing.company || listing.company;
  const title = preferIncoming ? listing.title || existing.title : existing.title || listing.title;
  const sourceReferences = match >= 0
    ? existing.sourceReferences.map((item, index) => index === match ? {
      ...mergeSourceOccurrence(item, reference),
      ...(item.firstAttachedAt ? { firstAttachedAt: item.firstAttachedAt } : {}),
      ...(item.firstAttachedAtPrecision ? { firstAttachedAtPrecision: item.firstAttachedAtPrecision } : item.firstAttachedAt ? { firstAttachedAtPrecision: 'exact' as const } : { firstAttachedAtPrecision: 'unknown' as const }),
    } : item)
    : [...existing.sourceReferences, { ...reference, firstAttachedAt: now, firstAttachedAtPrecision: 'exact' as const }];
  const admission = deriveCanonicalAdmission(sourceReferences, now);
  const listingNormalizedUrl = normalizeUrl(listing.applyUrl);
  const verifiedReopen = Boolean(admission?.catalogEligible
    && ['posting-detail', 'application-form'].includes(admission.destination.classification));
  const authoritativeClosure = admission?.destination.classification === 'gone';
  const keepQuarantined = existing.invalidApplicationUrl === listingNormalizedUrl && !verifiedReopen;
  const replaceStoredUrl = Boolean(applicationUrlValidatedAt && (!existing.applicationUrlValidatedAt || existing.normalizedUrl !== listingNormalizedUrl));
  const base = { ...existing };
  if (!keepQuarantined) delete base.invalidApplicationUrl;
  if (authoritativeClosure) delete base.applicationUrlValidatedAt;
  const internshipIdentity = listing.internshipIdentity ?? existing.internshipIdentity;
  const canonicalCompany = admission?.canonicalEmployer?.displayName;
  const season = preferIncoming || Boolean(applicationUrlValidatedAt) || (match >= 0 && existing.sourceReferences.length === 1)
    ? listing.season
    : existing.season;
  const trustedReappearance = Boolean(match >= 0 && listing.state === 'open'
    && listing.admission?.catalogEligible === true
    && listing.admission.evidenceCodes?.includes('trusted-community-source')
    && !existing.sourceReferences.some(isOfficialOccurrence));
  const canRevive = existing.open || preferIncoming || trustedReappearance;
  const merged = normalizeInternship({
    ...base,
    company: canonicalCompany ?? company,
    title,
    location,
    ...(locations ? { locations } : {}),
    season,
    applyUrl: replaceStoredUrl ? listing.applyUrl : existing.applyUrl || listing.applyUrl,
    normalizedUrl: replaceStoredUrl ? listingNormalizedUrl : existing.normalizedUrl,
    postingIdentity: mergedPostingIdentity(existing.postingIdentity, listing.postingIdentity),
    ...(postingIdentityStatus(sourceReferences) ? { postingIdentityStatus: postingIdentityStatus(sourceReferences) } : {}),
    internshipIdentity,
    fingerprint: fingerprint(company, title, location, season),
    compensation: listing.compensation.maxHourlyUSD ? listing.compensation : existing.compensation,
    requirements: {
      requiresUsCitizenship: Boolean(listing.requirements?.requiresUsCitizenship || existing.requirements?.requiresUsCitizenship),
      advancedDegreeRequired: Boolean(listing.requirements?.advancedDegreeRequired || existing.requirements?.advancedDegreeRequired),
    },
    employerCategory: employerCategory(company),
    sourceReferences,
    ...(admission ? { admission } : {}),
    ...(authoritativeClosure || withdrawn ? { invalidApplicationUrl: listingNormalizedUrl,
      notification: { ...existing.notification, smsPending: false, digestPending: false } } : {}),
    technical: canRevive ? anyOpenTechnicalOccurrence(sourceReferences) : existing.technical,
    open: authoritativeClosure || keepQuarantined || withdrawn ? false
      : canRevive && sourceReferences.some((item) => item.state === 'open') && seasonAllowsOpen(season, internshipIdentity, sourceReferences, now),
    ...(becomingCatalogVisible ? {
      catalogVisibleAt: now,
      catalogRecency: listing.trustedCommunityAlertQualification?.baselineSuppressed ? 'baseline' as const : 'normal' as const,
    } : {}),
    lastSeenAt: now,
    ...(applicationUrlValidatedAt ? { applicationUrlValidatedAt } : {}),
    ...(metadataVersion ? { applicationPageMetadataVersion: metadataVersion } : {}),
  });
  return projectRoleMetadata(merged).job;
}

function create(listing: ProcessedListing, externalId: string, now: string, baseline: boolean,
  applicationUrlValidatedAt: string | undefined, metadataVersion: number | undefined, withdrawn: boolean): Internship {
  listing = normalizeListing(listing);
  const normalizedUrl = normalizeUrl(listing.applyUrl);
  const key = fingerprint(listing.company, listing.title, listing.location, listing.season);
  const reference = { ...occurrence(listing, externalId), firstAttachedAt: now, firstAttachedAtPrecision: 'exact' as const };
  const admission = deriveCanonicalAdmission([reference], now);
  const authoritativeClosure = admission?.destination.classification === 'gone';
  const created: Internship = {
    jobId: listing.postingIdentity?.canonicalJobId
      ?? (listing.postingIdentityDecision?.status === 'unconfirmed'
        ? stableSourceOccurrenceJobId(listing.sourceId, externalId)
        : jobId(normalizedUrl, key)),
    company: admission?.canonicalEmployer?.displayName ?? listing.company,
    title: listing.title,
    location: listing.location,
    ...(listing.locations ? { locations: listing.locations } : {}),
    season: listing.season,
    applyUrl: listing.applyUrl,
    normalizedUrl,
    ...(listing.postingIdentity ? { postingIdentity: listing.postingIdentity } : {}),
    ...(listing.postingIdentityDecision?.status === 'confirmed' ? { postingIdentityStatus: 'confirmed' as const }
      : listing.postingIdentityDecision?.status === 'unconfirmed' ? { postingIdentityStatus: 'unconfirmed' as const } : {}),
    ...(listing.internshipIdentity ? { internshipIdentity: listing.internshipIdentity } : {}),
    ...(applicationUrlValidatedAt ? { applicationUrlValidatedAt } : {}),
    ...(metadataVersion ? { applicationPageMetadataVersion: metadataVersion } : {}),
    fingerprint: key,
    compensation: listing.compensation,
    ...(listing.requirements ? { requirements: listing.requirements } : {}),
    employerCategory: employerCategory(listing.company),
    sourceReferences: [reference],
    ...(admission ? { admission } : {}),
    ...(authoritativeClosure ? { invalidApplicationUrl: normalizedUrl } : {}),
    ...(withdrawn ? { invalidApplicationUrl: normalizedUrl } : {}),
    technical: listing.technical ?? isTechnicalJob(listing),
    ...(listing.technicalScope ?? technicalScopeFor(listing) ? { technicalScope: listing.technicalScope ?? technicalScopeFor(listing) } : {}),
    open: !authoritativeClosure && !withdrawn && listing.state === 'open'
      && seasonAllowsOpen(listing.season, listing.internshipIdentity, [reference], now),
    firstSeenAt: now,
    ...(admission?.catalogEligible === false ? {} : {
      catalogVisibleAt: now,
      catalogRecency: baseline ? 'baseline' as const : 'normal' as const,
    }),
    lastSeenAt: now,
    notification: { smsPending: true, digestPending: true },
  };
  return projectRoleMetadata(created).job;
}

export function newJobNotificationEvent(sourceId: string, externalId: string, job: Internship, now: string): NotificationEvent {
  return {
    // The canonical job identity, not arrival source, owns the one-time alert.
    // This makes official/community races converge on one outbox tombstone.
    eventId: createHash('sha256').update(`posting-observation-v2|${job.jobId}|new-job`).digest('hex'),
    sourceId,
    externalId,
    jobId: job.jobId,
    kind: 'new-job',
    createdAt: now,
  };
}

export function shouldPromoteDelayedNotification(input: {
  previousOccurrenceAlertEligible?: boolean;
  occurrenceAlertEligible?: boolean;
  canonicalAlertEligible?: boolean;
  baselineSuppressed?: boolean;
}): boolean {
  return input.previousOccurrenceAlertEligible !== true
    && input.occurrenceAlertEligible === true
    && input.canonicalAlertEligible === true
    && input.baselineSuppressed !== true;
}

function closeOccurrence(job: Internship, state: SourceOccurrenceState, now: string): Internship {
  const sourceReferences = job.sourceReferences.map((reference) =>
    reference.sourceId === state.sourceId
      && (reference.externalId ? reference.externalId === state.externalId : reference.document === state.occurrence.document && reference.row === state.occurrence.row)
      ? { ...reference, state: 'closed' as const }
      : reference);
  return {
    ...job,
    sourceReferences,
    ...(deriveCanonicalAdmission(sourceReferences, now) ? { admission: deriveCanonicalAdmission(sourceReferences, now) } : {}),
    technical: job.open ? anyOpenTechnicalOccurrence(sourceReferences) : job.technical,
    open: job.open && sourceReferences.some((reference) => reference.state === 'open')
      && seasonAllowsOpen(job.season, job.internshipIdentity, sourceReferences, now),
    lastSeenAt: now,
  };
}

function safeNormalizeUrl(value: string): string {
  try { return normalizeUrl(value); }
  catch { return value; }
}

/** Pure calculation: this class performs no reads, writes, network calls, or logging. */
export class CatalogReconciler {
  reconcile(input: ReconciliationInput): ReconciliationPlan {
    const jobs = new Map<string, Internship>();
    const occurrences: SourceOccurrenceState[] = [];
    const notifications: NotificationEvent[] = [];
    const newJobs: Internship[] = [];
    const filteredJobs: Internship[] = [];
    const includedIds = new Set<string>();
    const priorById = new Map(input.priorOccurrences.map((prior) => [prior.externalId, prior]));
    // One snapshot can list one exact posting twice, across documents or through
    // reviewed provider URL variants. Only exact identity or URL evidence may
    // converge them; title/location fingerprints can collide across requisitions.
    // URL-only convergence remains solely for legacy-unclassified adapters.
    // Classified occurrences require an exact reviewed identity.
    const legacyByUrl = new Map<string, Internship>();
    const byPostingIdentity = new Map<string, Internship>();

    for (const listing of input.listings) {
      const externalId = listing.externalId ?? `${listing.document}:${safeNormalizeUrl(listing.applyUrl)}`;
      includedIds.add(externalId);
      const listingUrl = safeNormalizeUrl(listing.applyUrl);
      const stored = input.resolvedJobs.get(externalId);
      const inSnapshot = (stored && jobs.get(stored.jobId))
        ?? (listing.postingIdentity ? byPostingIdentity.get(listing.postingIdentity.canonicalJobId) : undefined)
        ?? (!listing.postingIdentityDecision ? legacyByUrl.get(listingUrl) : undefined);
      const existing = inSnapshot ?? stored;
      const validatedAt = input.validatedAt?.get(externalId);
      const metadataVersion = input.metadataValidated?.get(externalId);
      const withdrawn = listsWithdrawnPosting(listing.applyUrl, input.withdrawnPostingKeys);
      const job = existing
        ? merge(existing, listing, externalId, input.now, validatedAt, metadataVersion, withdrawn)
        : create(listing, externalId, input.now, input.baseline, validatedAt, metadataVersion, withdrawn);
      const retryingUncommittedCreate = Boolean(stored && !inSnapshot
        && !priorById.has(externalId)
        && stored.sourceReferences.length === 1
        && stored.sourceReferences[0]?.sourceId === input.sourceId
        && stored.sourceReferences[0]?.externalId === externalId);
      const deliveryAllowed = !input.baseline && job.open && job.technical
        && matchesJobFilter(job, input.filter)
        && job.admission?.alertEligible !== false
        && !(job.postingIdentityStatus === 'unconfirmed' && input.publishUnconfirmedIdentities === false)
        && (!input.alertEligible || input.alertEligible.has(externalId));
      const delayedPromotion = Boolean(input.trustedCommunityAlertsEnabled
        && listing.trustedCommunityAlertQualification?.status === 'eligible'
        && existing && deliveryAllowed && shouldPromoteDelayedNotification({
        previousOccurrenceAlertEligible: priorById.get(externalId)?.occurrence.admission?.alertEligible,
        occurrenceAlertEligible: listing.admission?.alertEligible,
        canonicalAlertEligible: job.admission?.alertEligible,
        baselineSuppressed: listing.trustedCommunityAlertQualification?.baselineSuppressed,
      }));
      if (!existing || retryingUncommittedCreate) {
        if (!deliveryAllowed) {
          job.notification = { smsPending: false, digestPending: false };
          filteredJobs.push(job);
        } else {
          newJobs.push(job);
          notifications.push(newJobNotificationEvent(input.sourceId, externalId, job, input.now));
        }
      } else if (delayedPromotion) {
        job.notification = { ...job.notification, smsPending: true, digestPending: true };
        newJobs.push(job);
        notifications.push(newJobNotificationEvent(input.sourceId, externalId, job, input.now));
      }
      jobs.set(job.jobId, job);
      if (!listing.postingIdentityDecision) {
        legacyByUrl.set(job.normalizedUrl, job);
        legacyByUrl.set(listingUrl, job);
      }
      if (listing.postingIdentity) byPostingIdentity.set(listing.postingIdentity.canonicalJobId, job);
      const prior = priorById.get(externalId);
      const firstAttachedAt = prior?.occurrence.firstAttachedAt ?? prior?.firstObservedAt ?? prior?.changedAt ?? input.now;
      const firstAttachedAtPrecision = prior?.occurrence.firstAttachedAtPrecision
        ?? (prior?.firstObservedAt ? prior.firstObservedAtPrecision ?? 'exact' as const : prior ? 'unknown' as const : 'exact' as const);
      const next: SourceOccurrenceState = {
        sourceId: input.sourceId,
        externalId,
        jobId: job.jobId,
        occurrence: mergeSourceOccurrence(prior?.occurrence, {
          ...occurrence(listing, externalId),
          firstAttachedAt,
          firstAttachedAtPrecision,
        }),
        present: true,
        consecutiveOmissions: 0,
        changedSnapshotHash: input.snapshotHash,
        changedAt: input.now,
        ...(prior?.firstObservedAt
          ? { firstObservedAt: prior.firstObservedAt }
          : prior
            ? { firstObservedAtPrecision: 'unknown' as const }
            : { firstObservedAt: input.now, firstObservedAtPrecision: 'exact' as const }),
        ...(prior?.firstObservedAtPrecision
          ? { firstObservedAtPrecision: prior.firstObservedAtPrecision }
          : {}),
      };
      if (occurrenceChanged(priorById.get(externalId), next)) occurrences.push(next);
    }

    for (const prior of input.priorOccurrences) {
      if (includedIds.has(prior.externalId)) continue;
      if (input.activeExternalIds.has(prior.externalId)) {
        const confirmed = { ...prior, present: true, consecutiveOmissions: 0, changedSnapshotHash: input.snapshotHash, changedAt: input.now };
        if (occurrenceChanged(prior, confirmed)) occurrences.push(confirmed);
        continue;
      }
      const consecutiveOmissions = prior.consecutiveOmissions + 1;
      const next = {
        ...prior,
        present: false,
        consecutiveOmissions,
        changedSnapshotHash: input.snapshotHash,
        changedAt: input.now,
        occurrence: consecutiveOmissions >= 2 ? { ...prior.occurrence, state: 'closed' as const } : prior.occurrence,
      };
      occurrences.push(next);
      if (consecutiveOmissions < 2) continue;
      const existing = jobs.get(prior.jobId) ?? input.resolvedJobs.get(prior.externalId);
      if (existing) jobs.set(existing.jobId, closeOccurrence(existing, next, input.now));
    }

    return { jobs: [...jobs.values()], occurrences, notifications, newJobs, filteredJobs };
  }
}
