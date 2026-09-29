import { isGenericEmployerLabel } from '../catalog-admission.js';
import { canonicalCompanyKey } from '../core/normalize.js';
import { providerPostingReference } from '../identity/posting.js';
import type { PostingProvider, ProcessedListing } from '../types.js';

const SHARED_SCOPE_PROVIDERS = new Set<PostingProvider>([
  'unknown',
  // Paylocity routes currently expose only recruiting.paylocity.com as their
  // tenant. That host serves many employers and is not an employer identity.
  'paylocity',
]);

export interface AutomaticEmployerIdentityCandidate {
  provider: PostingProvider;
  scope: string;
  sourceId: string;
  fetchSequence: number;
  labelKey: string;
  displayName: string;
  postingId: string;
  applicationUrl: string;
  observedAt: string;
}

export interface AutomaticEmployerIdentityObservation
  extends Omit<AutomaticEmployerIdentityCandidate, 'postingId'> {
  postingIds: string[];
}

export interface AutomaticEmployerIdentityObservationResult {
  observed: number;
  promoted: number;
  conflicted: number;
  disabled: number;
  /** Scopes whose active mapping changed and whose existing roles need restamping. */
  changedScopes?: Array<{ provider: PostingProvider; scope: string }>;
}

function cleanDisplayName(value: string): string {
  return value.normalize('NFKC')
    .replace(/^[^\p{L}\p{N}]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Build automatic employer evidence only from an immutable posting route.
 * Source labels remain untrusted until repeated snapshots establish consensus.
 */
export function automaticEmployerIdentityCandidate(
  listing: ProcessedListing,
  fetchSequence: number | undefined,
  observedAt: string,
): AutomaticEmployerIdentityCandidate | undefined {
  if (!fetchSequence || listing.provenance !== 'reviewed-community') return undefined;
  if (listing.employerLabelOrigin === 'inherited' && listing.employerInheritance !== 'same-tenant') return undefined;
  let reference;
  try { reference = providerPostingReference(listing.applyUrl); } catch { return undefined; }
  if (reference.provider === 'unknown' || SHARED_SCOPE_PROVIDERS.has(reference.provider)
    || !reference.tenant || !reference.postingId) return undefined;
  const displayName = cleanDisplayName(listing.company);
  const labelKey = canonicalCompanyKey(displayName);
  if (!labelKey || isGenericEmployerLabel(displayName)) return undefined;
  return {
    provider: reference.provider,
    scope: reference.tenant.toLowerCase(),
    sourceId: listing.sourceId,
    fetchSequence,
    labelKey,
    displayName,
    postingId: reference.postingId.toLowerCase(),
    applicationUrl: listing.applyUrl,
    observedAt,
  };
}

export function groupAutomaticEmployerIdentityCandidates(
  candidates: readonly AutomaticEmployerIdentityCandidate[],
): AutomaticEmployerIdentityObservation[] {
  const grouped = new Map<string, AutomaticEmployerIdentityObservation>();
  for (const candidate of candidates) {
    const key = [candidate.provider, candidate.scope, candidate.sourceId,
      candidate.fetchSequence, candidate.labelKey].join('\0');
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.postingIds.includes(candidate.postingId)) existing.postingIds.push(candidate.postingId);
      continue;
    }
    const { postingId, ...observation } = candidate;
    grouped.set(key, { ...observation, postingIds: [postingId] });
  }
  return [...grouped.values()].map((value) => ({ ...value, postingIds: [...value.postingIds].sort() }));
}

/**
 * Identity promotion is enrichment, not part of the ingestion critical path.
 * Large community boards can contain hundreds of distinct ATS tenants, and a
 * complete promotion check performs several D1 statements per tenant. Rotate a
 * small deterministic window on every successful fetch so coverage converges
 * without allowing enrichment to exhaust a queue delivery's D1 CPU budget.
 */
export const automaticEmployerIdentityObservationsPerDelivery = 5;
/**
 * One label is sufficient to represent an unambiguous scope and two distinct
 * labels are sufficient to prove a conflict. Keeping more cannot change the
 * safety decision, but it can turn one selected tenant into an unbounded D1
 * batch when a source publishes many label variants for the same ATS route.
 */
export const automaticEmployerIdentityLabelsPerScope = 2;

export function boundedAutomaticEmployerIdentityScopeEvidence(
  observations: readonly AutomaticEmployerIdentityObservation[],
): AutomaticEmployerIdentityObservation[] {
  const ordered = [...observations].sort((left, right) =>
    [left.labelKey, left.sourceId].join('\0').localeCompare([right.labelKey, right.sourceId].join('\0')));
  const selected: AutomaticEmployerIdentityObservation[] = [];
  const labels = new Set<string>();
  for (const observation of ordered) {
    if (labels.has(observation.labelKey)) continue;
    labels.add(observation.labelKey);
    selected.push(observation);
    if (selected.length === automaticEmployerIdentityLabelsPerScope) break;
  }
  return selected;
}

export function automaticEmployerIdentityObservationSlice(
  observations: readonly AutomaticEmployerIdentityObservation[],
  fetchSequence: number,
  limit = automaticEmployerIdentityObservationsPerDelivery,
): AutomaticEmployerIdentityObservation[] {
  if (limit <= 0 || observations.length === 0) return [];
  // The safety decision is made per exact ATS tenant, so its evidence must stay
  // atomic here. Preserve one label when the scope is unambiguous and two when
  // it conflicts: two distinct labels are sufficient to fail closed, while also
  // keeping the selected scopes inside a fixed statement budget.
  const byScope = new Map<string, AutomaticEmployerIdentityObservation[]>();
  for (const observation of observations) {
    const key = `${observation.provider}\0${observation.scope}`;
    const group = byScope.get(key) ?? [];
    group.push(observation);
    byScope.set(key, group);
  }
  const orderedScopes = [...byScope.entries()].sort(([left], [right]) => left.localeCompare(right));
  const start = ((Math.max(1, fetchSequence) - 1) * limit) % orderedScopes.length;
  const selectedScopes = orderedScopes.length <= limit
    ? orderedScopes
    : Array.from({ length: limit }, (_, offset) => orderedScopes[(start + offset) % orderedScopes.length]!);
  return selectedScopes.flatMap(([, group]) => boundedAutomaticEmployerIdentityScopeEvidence(group));
}
