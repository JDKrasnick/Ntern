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

export function automaticEmployerIdentityObservationSlice(
  observations: readonly AutomaticEmployerIdentityObservation[],
  fetchSequence: number,
  limit = automaticEmployerIdentityObservationsPerDelivery,
): AutomaticEmployerIdentityObservation[] {
  if (limit <= 0 || observations.length === 0) return [];
  const ordered = [...observations].sort((left, right) =>
    [left.provider, left.scope, left.sourceId, left.labelKey].join('\0')
      .localeCompare([right.provider, right.scope, right.sourceId, right.labelKey].join('\0')));
  if (ordered.length <= limit) return ordered;
  const start = ((Math.max(1, fetchSequence) - 1) * limit) % ordered.length;
  return Array.from({ length: limit }, (_, offset) => ordered[(start + offset) % ordered.length]!);
}
