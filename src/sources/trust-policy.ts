import { createHash } from 'node:crypto';
import { canonicalApplicationUrl } from '../core/application-url.js';
import type {
  DestinationEvidence,
  PostingIdentityDecision,
  TrustedCommunityAlertMode,
  TrustedCommunityAlertQualification,
} from '../types.js';

export interface TrustedCommunityAdmissionPolicy {
  trust: 'trusted-community';
  version: string;
  catalogMode: 'validated-posting-specific-destination';
  alertMode: TrustedCommunityAlertMode;
  /**
   * `block` (the default) fails the delivery so the source quarantines; `alert`
   * hides the unsafe listings and logs the breach but keeps polling. The
   * reviewed lists are manually verified and their anomalies are caught per
   * posting, so a floor breach is an alarm rather than a stop.
   */
  circuitBreaker?: 'block' | 'alert';
}

export interface StandardAdmissionPolicy {
  trust: 'standard';
  version: 'standard-v1';
}

export type SourceAdmissionPolicy = StandardAdmissionPolicy | TrustedCommunityAdmissionPolicy;

const STANDARD_POLICY: StandardAdmissionPolicy = { trust: 'standard', version: 'standard-v1' };

/** The reviewed admission policy every trusted community list starts from. */
function trustedCommunityListPolicy(sourceId: string): TrustedCommunityAdmissionPolicy {
  return {
    trust: 'trusted-community',
    version: `${sourceId}-trusted-community-v1`,
    catalogMode: 'validated-posting-specific-destination',
    alertMode: 'disabled',
    circuitBreaker: 'alert',
  };
}

/**
 * Policy changes are reviewed configuration deployments. Keep the alert mode
 * disabled for the catalog-baseline rollout; activating it must bump version.
 *
 * Reviewed community lists whose rows may publish from source-reported employer
 * evidence once the catalog gate is open. Every entry is an explicit reviewed
 * decision: trust is never inferred from the polled source registry, so adding
 * a list to `defaultSources` cannot admit it by itself. A newly trusted list is
 * re-graded under its own policy version when the gate turns on.
 *
 * `simplify-summer-2026` was reviewed before the per-source version convention
 * and keeps its exact version string, so its existing occurrences stay graded.
 */
const TRUSTED_COMMUNITY_POLICIES: Readonly<Record<string, TrustedCommunityAdmissionPolicy>> = {
  'vanshb03-summer-2027': trustedCommunityListPolicy('vanshb03-summer-2027'),
  'simplify-summer-2026': {
    trust: 'trusted-community',
    version: 'simplify-trusted-community-v1',
    catalogMode: 'validated-posting-specific-destination',
    alertMode: 'disabled',
    circuitBreaker: 'alert',
  },
  'speedyapply-2027-swe': trustedCommunityListPolicy('speedyapply-2027-swe'),
  'speedyapply-2027-ai': trustedCommunityListPolicy('speedyapply-2027-ai'),
  'northwestern-fintech-2027-quant': trustedCommunityListPolicy('northwestern-fintech-2027-quant'),
  'canadian-tech-2027': trustedCommunityListPolicy('canadian-tech-2027'),
};

export function sourceAdmissionPolicy(sourceId: string): SourceAdmissionPolicy {
  return TRUSTED_COMMUNITY_POLICIES[sourceId] ?? STANDARD_POLICY;
}

export function activeTrustedCommunityPolicy(
  sourceId: string,
  catalogEnabled: boolean,
): TrustedCommunityAdmissionPolicy | undefined {
  const policy = sourceAdmissionPolicy(sourceId);
  return catalogEnabled && policy.trust === 'trusted-community' ? policy : undefined;
}

export function effectiveAdmissionConfigurationVersion(input: {
  sourceId: string;
  resolverVersion?: string;
  trustedCommunityCatalogEnabled: boolean;
}): string | undefined {
  const policy = sourceAdmissionPolicy(input.sourceId);
  // A dormant deploy must be byte-for-byte compatible with the existing
  // resolver version. The gate-on transition introduces the policy version.
  if (policy.trust === 'standard' || !input.trustedCommunityCatalogEnabled) return input.resolverVersion;
  return createHash('sha256').update(JSON.stringify({
    resolverVersion: input.resolverVersion ?? null,
    sourcePolicyVersion: policy.version,
    trustedCommunityCatalogEnabled: policy.trust === 'trusted-community'
      ? input.trustedCommunityCatalogEnabled
      : null,
  })).digest('hex');
}

function safeDestinationKey(value: string): string {
  try { return canonicalApplicationUrl(value); }
  catch { return value.trim(); }
}

export function postingSpecificDestination(destination: DestinationEvidence): boolean {
  return destination.classification === 'posting-detail' || destination.classification === 'application-form';
}

/**
 * Counts complete source snapshots independently from browser timing. A first
 * successful browser validation adopts the already-counted candidate history;
 * only a change from one validated destination to another resets the streak.
 */
export function advanceTrustedCommunityQualification(input: {
  previous?: TrustedCommunityAlertQualification;
  destination: DestinationEvidence;
  postingIdentityDecision?: PostingIdentityDecision;
  alertMode: TrustedCommunityAlertMode;
  completeFetchSequence?: number;
  baselineSuppressed?: boolean;
  catalogPublicationSuppressed?: boolean;
}): TrustedCommunityAlertQualification {
  const candidateKey = safeDestinationKey(input.destination.candidateUrl);
  const validatedDestinationKey = postingSpecificDestination(input.destination)
    ? safeDestinationKey(input.destination.finalUrl ?? input.destination.candidateUrl)
    : undefined;
  const candidateChanged = Boolean(input.previous && input.previous.candidateKey !== candidateKey);
  const validatedDestinationChanged = Boolean(
    input.previous?.validatedDestinationKey
    && validatedDestinationKey
    && input.previous.validatedDestinationKey !== validatedDestinationKey,
  );
  const reset = candidateChanged || validatedDestinationChanged;
  const previousCount = reset ? 0 : input.previous?.consecutiveCompleteSnapshots ?? 0;
  const previousSequence = reset ? undefined : input.previous?.lastCountedSuccessfulFetchSequence;
  const settled = !reset && input.previous?.basis !== undefined;
  const countable = !settled && input.completeFetchSequence !== undefined
    && input.completeFetchSequence !== previousSequence;
  // A different sequence is not necessarily the next sequence: the occurrence
  // may have been absent from one or more intervening complete snapshots.
  const continuesStreak = previousSequence !== undefined
    && input.completeFetchSequence === previousSequence + 1;
  const consecutiveCompleteSnapshots = countable
    ? continuesStreak ? previousCount + 1 : 1
    : previousCount;
  const lastCountedSuccessfulFetchSequence = countable ? input.completeFetchSequence : previousSequence;
  const exactIdentity = input.postingIdentityDecision?.status === 'confirmed';
  const basis = exactIdentity
    ? 'exact-identity' as const
    : consecutiveCompleteSnapshots >= 2 ? 'two-complete-snapshots' as const : undefined;
  const status = input.alertMode === 'disabled'
    ? 'disabled' as const
    : !validatedDestinationKey
      ? 'ineligible' as const
      : basis ? 'eligible' as const : 'pending' as const;
  return {
    candidateKey,
    ...(input.previous?.sourceMaterialHash ? { sourceMaterialHash: input.previous.sourceMaterialHash } : {}),
    ...(validatedDestinationKey ? { validatedDestinationKey } : {}),
    consecutiveCompleteSnapshots,
    ...(lastCountedSuccessfulFetchSequence !== undefined ? { lastCountedSuccessfulFetchSequence } : {}),
    status,
    ...(basis ? { basis } : {}),
    baselineSuppressed: Boolean(input.previous?.baselineSuppressed || input.baselineSuppressed),
    catalogPublicationSuppressed: input.catalogPublicationSuppressed
      ?? input.previous?.catalogPublicationSuppressed
      ?? false,
  };
}
