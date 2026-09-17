import { createHash } from 'node:crypto';
import { sourceRoleAgreement } from './core/application-url.js';
import type { TrustedCommunityAdmissionPolicy } from './sources/trust-policy.js';
import type {
  CatalogAdmission,
  CatalogAdmissionReason,
  DestinationEvidence,
  MetadataCompleteness,
  ProcessedListing,
  SourceOccurrence,
  TrustedCommunityAlertQualification,
} from './types.js';

const GENERIC_EMPLOYER = /\b(?:talent community|job board|open roles?|careers?|external|private|job wrapping|university jobs?|early career)\b/iu;
const ELLIPSIS = /(?:\.{2,}|…)/u;
const TRAILING_FRAGMENT = /[,/(&[{-]\s*$/u;

export function isGenericEmployerLabel(value: string): boolean {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return !normalized || GENERIC_EMPLOYER.test(normalized);
}

function delimiterState(value: string): 'complete' | 'malformed' {
  const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];
  return pairs.some(([open, close]) => value.split(open).length !== value.split(close).length)
    ? 'malformed'
    : 'complete';
}

export function metadataCompleteness(input: {
  title: string;
  locations: readonly string[];
  titleRepaired?: boolean;
}): MetadataCompleteness {
  const title = input.title.replace(/\s+/gu, ' ').trim();
  const sourceLocation = input.locations.join(' · ').replace(/\s+/gu, ' ').trim();
  const titleState: MetadataCompleteness['title'] = !title
    ? 'missing'
    : ELLIPSIS.test(title)
      ? 'truncated'
      : delimiterState(title) === 'malformed' || TRAILING_FRAGMENT.test(title)
        ? 'malformed'
        : input.titleRepaired ? 'approximate-repair' : 'complete';
  const locationState: MetadataCompleteness['location'] = !sourceLocation
    ? 'not-specified'
    : ELLIPSIS.test(sourceLocation)
      ? 'truncated'
      : delimiterState(sourceLocation) === 'malformed' || /\b[A-Za-z]{1,2}\.{2,}\s*$/u.test(sourceLocation)
        ? 'malformed'
        : 'complete';
  return {
    complete: titleState === 'complete' && (locationState === 'complete' || locationState === 'not-specified'),
    title: titleState,
    location: locationState,
  };
}

function metadataReasons(metadata: MetadataCompleteness): CatalogAdmissionReason[] {
  const reasons: CatalogAdmissionReason[] = [];
  if (metadata.title === 'missing') reasons.push('metadata-title-missing');
  if (metadata.title === 'truncated') reasons.push('metadata-title-truncated');
  if (metadata.title === 'malformed') reasons.push('metadata-title-malformed');
  if (metadata.title === 'approximate-repair') reasons.push('metadata-title-approximate-repair');
  if (metadata.location === 'truncated') reasons.push('metadata-location-truncated');
  if (metadata.location === 'malformed') reasons.push('metadata-location-malformed');
  return reasons;
}

function destinationReason(destination: DestinationEvidence): CatalogAdmissionReason | undefined {
  if (destination.classification === 'aggregate-board') return 'destination-aggregate-board';
  if (destination.classification === 'blocked-uninspectable') return 'destination-blocked-uninspectable';
  if (destination.classification === 'gone') return 'destination-gone';
  if (destination.classification === 'unresolved') return 'destination-unresolved';
  return undefined;
}

function exactRoleDestination(destination: DestinationEvidence): boolean {
  return destination.classification === 'posting-detail' || destination.classification === 'application-form';
}

/**
 * Legacy admissions did not record a verification timestamp. Their last
 * successful exact destination inspection is safe to use once, but never use
 * an inspection from an unresolved/grace admission: that would let retries
 * extend the grace period.
 */
function lastSuccessfulVerification(previous: CatalogAdmission | undefined): string | undefined {
  if (!previous) return undefined;
  if (previous.lastVerifiedAt && Number.isFinite(Date.parse(previous.lastVerifiedAt))) return previous.lastVerifiedAt;
  if (previous.catalogEligible && exactRoleDestination(previous.destination)
    && Number.isFinite(Date.parse(previous.destination.inspectedAt))) return previous.destination.inspectedAt;
  return undefined;
}

export function evaluateCatalogAdmission(input: {
  listing: ProcessedListing;
  destination: DestinationEvidence;
  postingAttributed: boolean;
  evaluatedAt: string;
  previous?: CatalogAdmission;
  trustedCommunity?: {
    policy: TrustedCommunityAdmissionPolicy;
    qualification: TrustedCommunityAlertQualification;
  };
}): CatalogAdmission {
  const { listing, destination, postingAttributed, evaluatedAt, previous, trustedCommunity } = input;
  const employer = listing.employerEvidence?.canonicalEmployer;
  const genericEmployer = isGenericEmployerLabel(employer?.displayName ?? listing.company);
  const metadata = listing.metadataCompleteness ?? metadataCompleteness({
    title: listing.title,
    locations: listing.locations ?? [listing.location],
    titleRepaired: listing.titleRepaired,
  });
  const reasons = metadataReasons(metadata);
  if (!employer) reasons.push('employer-unresolved');
  if (genericEmployer) reasons.push('employer-generic-label');
  if (!postingAttributed) reasons.push('posting-unattributed');
  const destinationFailure = destinationReason(destination);
  if (destinationFailure) reasons.push(destinationFailure);

  const verifiedAt = exactRoleDestination(destination) && postingAttributed
    ? destination.inspectedAt
    : lastSuccessfulVerification(previous);
  const previouslyGood = !trustedCommunity && Boolean(verifiedAt);
  const newlyInconclusive = destination.classification === 'unresolved' || destination.classification === 'blocked-uninspectable';
  const graceDeadline = previouslyGood && newlyInconclusive && verifiedAt
    ? new Date(Date.parse(verifiedAt) + 7 * 86_400_000).toISOString()
    : undefined;
  const inGrace = Boolean(graceDeadline && Date.parse(evaluatedAt) < Date.parse(graceDeadline));
  if (inGrace) {
    const index = reasons.findIndex((reason) => reason === 'destination-unresolved' || reason === 'destination-blocked-uninspectable');
    if (index >= 0) reasons.splice(index, 1, 'destination-grace');
  }
  const diagnosticOnly = trustedCommunity
    ? new Set<CatalogAdmissionReason>(['employer-unresolved', 'posting-unattributed'])
    : new Set<CatalogAdmissionReason>();
  const blocking = reasons.filter((reason) => reason !== 'destination-grace' && !diagnosticOnly.has(reason));
  const catalogEligible = trustedCommunity?.qualification.catalogPublicationSuppressed !== true
    && blocking.length === 0 && (destination.classification === 'posting-detail'
    || destination.classification === 'application-form'
    || inGrace);
  const trustedAlertEligible = trustedCommunity?.policy.alertMode === 'exact-identity-or-two-complete-snapshots'
    && trustedCommunity.qualification.status === 'eligible'
    && !trustedCommunity.qualification.baselineSuppressed;
  return {
    ...(employer && !genericEmployer ? { canonicalEmployer: employer } : {}),
    employerResolution: employer && !genericEmployer
      ? 'resolved'
      : trustedCommunity ? 'source-reported' : 'unresolved',
    postingAttribution: postingAttributed ? 'attributed' : 'unattributed',
    destination: inGrace && previous ? {
      ...destination,
      finalUrl: previous.destination.finalUrl ?? previous.destination.candidateUrl,
      ...(verifiedAt ? { lastKnownGoodAt: verifiedAt } : {}),
      ...(previous.destination.validThrough ? { validThrough: previous.destination.validThrough } : {}),
      ...(previous.destination.freshUntil ? { freshUntil: previous.destination.freshUntil } : {}),
    } : destination,
    metadata,
    catalogEligible,
    alertEligible: catalogEligible && !inGrace && (trustedCommunity ? trustedAlertEligible : true),
    reasonCodes: [...new Set(reasons)].sort(),
    ...(trustedCommunity ? { evidenceCodes: ['trusted-community-source' as const] } : {}),
    evaluatedAt,
    evidenceObservedAt: destination.inspectedAt,
    ...(verifiedAt ? { lastVerifiedAt: verifiedAt } : {}),
    ...(graceDeadline ? { graceDeadline } : {}),
  };
}

export function deriveCanonicalAdmission(references: readonly SourceOccurrence[], evaluatedAt: string): CatalogAdmission | undefined {
  const openReferences = references.filter((reference) => reference.state === 'open');
  const relevantReferences = openReferences.length ? openReferences : references;
  const decisions = relevantReferences.map((reference) => reference.admission).filter((value): value is CatalogAdmission => Boolean(value));
  if (!decisions.length) return undefined;
  const officialEmployerIds = new Set(relevantReferences
    .filter((reference) => reference.provenance !== 'reviewed-community')
    .map((reference) => reference.admission?.canonicalEmployer?.id)
    .filter((value): value is string => Boolean(value)));
  if (officialEmployerIds.size > 1) {
    const latest = [...decisions].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0]!;
    return {
      ...latest,
      canonicalEmployer: undefined,
      employerResolution: 'conflict',
      catalogEligible: false,
      alertEligible: false,
      reasonCodes: [...new Set([...latest.reasonCodes, 'employer-conflict' as const])].sort(),
      evaluatedAt,
    };
  }
  const identities = new Map<string, SourceOccurrence[]>();
  for (const reference of relevantReferences) {
    const destination = reference.admission?.destination;
    if (!destination?.expectedPostingId) continue;
    const key = `${destination.provider}\0${destination.tenant ?? ''}\0${destination.expectedPostingId}`;
    identities.set(key, [...(identities.get(key) ?? []), reference]);
  }
  const metadataConflict = [...identities.values()].some((group) => {
    const official = group.filter((reference) => reference.provenance !== 'reviewed-community' && reference.admission?.catalogEligible);
    const authoritative = official.length ? official : group;
    return authoritative.some((left, index) => authoritative.slice(index + 1).some((right) => {
    if (left.title.trim().toLowerCase() === right.title.trim().toLowerCase()) return false;
    const generic = (value: string) => /^(?:intern(?:ship)?|co-?op)$/iu.test(value.trim());
    if (generic(left.title) !== generic(right.title)) return true;
    return sourceRoleAgreement(left.title, { url: right.applyUrl, title: right.title,
      confidence: { score: 0, level: 'low', recommendation: 'review', signals: [] } }) === 'weak'
      && sourceRoleAgreement(right.title, { url: left.applyUrl, title: left.title,
        confidence: { score: 0, level: 'low', recommendation: 'review', signals: [] } }) === 'weak';
    }));
  });
  if (metadataConflict) {
    const latest = [...decisions].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0]!;
    return { ...latest, catalogEligible: false, alertEligible: false,
      reasonCodes: [...new Set([...latest.reasonCodes, 'metadata-conflict' as const])].sort(), evaluatedAt };
  }
  const admissible = decisions.filter((decision) => decision.catalogEligible)
    .sort((a, b) => Number(b.employerResolution === 'resolved') - Number(a.employerResolution === 'resolved')
      || Number(b.alertEligible) - Number(a.alertEligible)
      || b.evaluatedAt.localeCompare(a.evaluatedAt))[0];
  if (admissible) return { ...admissible, evaluatedAt };
  const latest = [...decisions].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))[0]!;
  return { ...latest, catalogEligible: false, alertEligible: false, evaluatedAt };
}

/**
 * A stored decision is durable: once a role is admitted, the catalog keeps
 * publishing it until the role itself ends (closed by its source, or out of
 * season). Owner decision, 2026-09-17: re-inspection after admission is off, so
 * an expired evidence timestamp must not retire a role nobody re-checked.
 * `alertEligible` follows the same rule for the same reason.
 */
export function catalogEligible(job: { admission?: CatalogAdmission }): boolean {
  const admission = job.admission;
  if (!admission) return true;
  return admission.catalogEligible;
}

/** Inconclusive checks pause alerts immediately; no result extends the last verified deadline. */
export function alertEligible(job: { admission?: CatalogAdmission }): boolean {
  const admission = job.admission;
  if (!admission) return true;
  return admission.alertEligible;
}

export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
