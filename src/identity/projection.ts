import { canonicalCatalogRecency } from '../catalog-recency.js';
import { alertEligible, deriveCanonicalAdmission } from '../catalog-admission.js';
import { isPastSeason } from '../core/early-career.js';
import { isOfficialOccurrence } from '../sources/provenance.js';
import type { Internship, NotificationEvent, SourceOccurrence, SourceOccurrenceState } from '../types.js';
import { mergeSourceOccurrenceReferences, sourceOccurrenceKey } from './source-occurrence.js';
import { projectRoleMetadata } from '../role-metadata.js';

function earliest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort()[0];
}

function latest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function mergeReferences(current: Internship | undefined, proposed: Internship, occurrence: SourceOccurrenceState): SourceOccurrence[] {
  return mergeSourceOccurrenceReferences([
    ...(current?.sourceReferences ?? []), ...proposed.sourceReferences, occurrence.occurrence,
  ]).sort((left, right) =>
    (left.firstAttachedAt ?? '').localeCompare(right.firstAttachedAt ?? '')
    || sourceOccurrenceKey(left).localeCompare(sourceOccurrenceKey(right)));
}

export function postingIdentityStatusForOccurrences(references: SourceOccurrence[]): Internship['postingIdentityStatus'] {
  if (references.some((reference) => reference.postingIdentityDecision?.status === 'confirmed')) return 'confirmed';
  if (references.some((reference) => reference.postingIdentityDecision?.status === 'unconfirmed')) return 'unconfirmed';
  return undefined;
}

function presentationOwner(current: Internship | undefined, proposed: Internship): Internship {
  if (!current) return proposed;
  const officialKey = (job: Internship) => job.sourceReferences
    .filter(isOfficialOccurrence)
    .map(sourceOccurrenceKey)
    .sort()[0];
  const currentOfficial = officialKey(current);
  const proposedOfficial = officialKey(proposed);
  if (currentOfficial || proposedOfficial) {
    if (!currentOfficial) return proposed;
    if (!proposedOfficial) return current;
    return proposedOfficial.localeCompare(currentOfficial) <= 0 ? proposed : current;
  }
  const currentReferences = new Set(current.sourceReferences.map(sourceOccurrenceKey));
  if (proposed.sourceReferences.some((reference) => currentReferences.has(sourceOccurrenceKey(reference)))) return proposed;
  const currentFirst = current.catalogVisibleAt ?? current.firstSeenAt;
  const proposedFirst = proposed.catalogVisibleAt ?? proposed.firstSeenAt;
  return proposedFirst.localeCompare(currentFirst) < 0 ? proposed : current;
}

/**
 * Builds the canonical job projection from durable occurrence facts. The
 * compare-and-swap store implementations call this again after contention, so
 * a concurrent writer cannot erase source history or reset alert tombstones.
 */
export function postingObservationProjection(
  current: Internship | undefined,
  proposed: Internship,
  occurrence: SourceOccurrenceState,
): Internship {
  const sourceReferences = mergeReferences(current, proposed, occurrence);
  const presentation = presentationOwner(current, proposed);
  const admission = deriveCanonicalAdmission(sourceReferences, latest([current?.lastSeenAt, proposed.lastSeenAt]) ?? proposed.lastSeenAt);
  const smsSentAt = latest([current?.notification.smsSentAt, proposed.notification.smsSentAt]);
  const digestedAt = latest([current?.notification.digestedAt, proposed.notification.digestedAt]);
  const postingIdentityStatus = postingIdentityStatusForOccurrences(sourceReferences);
  const anyOpen = sourceReferences.some((reference) => reference.state === 'open');
  const becomingCatalogVisible = !current?.catalogVisibleAt && current?.admission?.catalogEligible === false
    && admission?.catalogEligible === true;
  const season = presentation.season;
  const seasonEvidence = (proposed.internshipIdentity ?? current?.internshipIdentity) as { season?: { evidenceStatus?: string } } | undefined;
  const seasonAllowsOpen = !isPastSeason(season, new Date(proposed.lastSeenAt))
    || (seasonEvidence?.season?.evidenceStatus === 'explicit'
      && sourceReferences.some((reference) => reference.state === 'open' && isOfficialOccurrence(reference)));
  const base = { ...proposed };
  if (admission?.catalogEligible === false && !current?.catalogVisibleAt) {
    delete base.catalogVisibleAt;
    delete base.catalogRecency;
  }
  const projected = {
    ...base,
    company: presentation.company,
    title: presentation.title,
    location: presentation.location,
    ...(presentation.locations ? { locations: presentation.locations } : {}),
    applyUrl: presentation.applyUrl,
    normalizedUrl: presentation.normalizedUrl,
    fingerprint: presentation.fingerprint,
    season,
    sourceReferences,
    ...(admission ? { admission } : {}),
    ...(postingIdentityStatus ? { postingIdentityStatus } : {}),
    technical: sourceReferences.some((reference) => (!anyOpen || reference.state === 'open') && reference.technical !== false),
    open: !proposed.invalidApplicationUrl && anyOpen && seasonAllowsOpen && Boolean(current?.open || proposed.open),
    firstSeenAt: earliest([current?.firstSeenAt, proposed.firstSeenAt]) ?? proposed.firstSeenAt,
    ...(admission?.catalogEligible === false && !current?.catalogVisibleAt
      ? {}
      : becomingCatalogVisible
        ? { catalogVisibleAt: proposed.catalogVisibleAt ?? proposed.lastSeenAt, catalogRecency: proposed.catalogRecency ?? 'normal' as const }
        : current?.catalogVisibleAt || proposed.catalogVisibleAt
          ? { catalogVisibleAt: earliest([current?.catalogVisibleAt, proposed.catalogVisibleAt]) }
          : { catalogVisibleAt: earliest([current?.firstSeenAt, proposed.firstSeenAt]) }),
    lastSeenAt: latest([current?.lastSeenAt, proposed.lastSeenAt]) ?? proposed.lastSeenAt,
    notification: {
      smsPending: !smsSentAt && Boolean(current?.notification.smsPending || proposed.notification.smsPending),
      digestPending: !digestedAt && Boolean(current?.notification.digestPending || proposed.notification.digestPending),
      ...(smsSentAt ? { smsSentAt } : {}),
      ...(digestedAt ? { digestedAt } : {}),
    },
  };
  return canonicalCatalogRecency(projectRoleMetadata(projected).job);
}

/** Persist the same final policy verdict in the job and its occurrence row. */
export function postingObservationOccurrenceProjection(job: Internship, occurrence: SourceOccurrenceState): SourceOccurrenceState {
  const key = sourceOccurrenceKey(occurrence.occurrence);
  const reference = job.sourceReferences.find(item => sourceOccurrenceKey(item) === key);
  // Keep the source's material fields: canonical presentation normalization
  // must not make an unchanged input look changed on the next refresh.
  return reference?.admission
    ? { ...occurrence, occurrence: { ...occurrence.occurrence, admission: reference.admission } }
    : occurrence;
}

/**
 * Finalizes delayed notification state from the same canonical projection that
 * the store compare-and-swap commits. A stale caller may propose a promotion
 * after another source has made the canonical job ineligible; in that case,
 * retain only notification state that was already durable.
 */
export function postingObservationNotificationProjection(
  current: Internship | undefined,
  projected: Internship,
  notificationEvent: NotificationEvent | undefined,
): { job: Internship; notificationEvent?: NotificationEvent } {
  if (!notificationEvent || (alertEligible(projected) && projected.open && projected.technical !== false)) {
    return { job: projected, ...(notificationEvent ? { notificationEvent } : {}) };
  }
  const smsSentAt = projected.notification.smsSentAt;
  const digestedAt = projected.notification.digestedAt;
  return {
    job: {
      ...projected,
      notification: {
        smsPending: !smsSentAt && Boolean(current?.notification.smsPending),
        digestPending: !digestedAt && Boolean(current?.notification.digestPending),
        ...(smsSentAt ? { smsSentAt } : {}),
        ...(digestedAt ? { digestedAt } : {}),
      },
    },
  };
}
