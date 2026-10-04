import { evaluateCatalogAdmission } from '../../catalog-admission.js';
import type { PostingObservationAdmissionFence } from '../../store.js';
import type { ApplicationPageEvidence } from '../../core/application-url.js';
import type { Reachability } from '../../core/application-verification.js';
import { classifyDestination } from '../../destination-verification.js';
import { resolvePostingIdentityDecision, stableSourceOccurrenceJobId } from '../../identity/registry.js';
import { processPosting } from '../../ingestion/processor.js';
import { activeTrustedCommunityPolicy, advanceTrustedCommunityQualification } from '../../sources/trust-policy.js';
import type {
  CanonicalEmployer,
  CatalogAdmission,
  PostingIdentityDecision,
  ProcessedListing,
  SourcedPosting,
  TrustedCommunityAlertQualification,
} from '../../types.js';
import { admissionShouldNotify } from './migration.js';
import type { AdmissionRowContext, AdmissionRowEvaluation, AdmissionV2RowEvaluator } from './types.js';

/** Reachability and page evidence produced by a bounded destination probe. */
export interface AdmissionDestinationProbe {
  reachability: Reachability;
  evidence?: ApplicationPageEvidence;
}

export interface AdmissionDestinationProber {
  /**
   * Probe one destination. Must reject with an `AdmissionRowTransientError` for
   * timeouts, 429s, and 5xx responses so the consumer retries that row only.
   */
  probe(input: { sourceId: string; externalId: string; applyUrl: string; observedAt: string }): Promise<AdmissionDestinationProbe>;
}

export type AdmissionCanonicalEmployerResolver = (
  listing: ProcessedListing,
) => Promise<Pick<CanonicalEmployer, 'id' | 'displayName'> | undefined>;

/** Existing live-catalog evidence used to grade a Stage 2 canary row fairly. */
export interface AdmissionV2PriorContext {
  admission?: CatalogAdmission;
  postingIdentityDecision?: PostingIdentityDecision;
  trustedCommunityAlertQualification?: TrustedCommunityAlertQualification;
}

export type AdmissionV2PriorContextResolver = (
  sourceId: string,
  externalId: string,
) => Promise<AdmissionV2PriorContext | undefined>;

/** Terminal catalog effects for one admitted row. */
export interface AdmissionCatalogCommit {
  effectFence?: PostingObservationAdmissionFence;
  sourceId: string;
  externalId: string;
  baseline: boolean;
  admissionVersion: string;
  listing: ProcessedListing;
  admission: CatalogAdmission;
  jobId: string;
  /**
   * Whether this commit may mint a new-role notification. Baselines and policy
   * migrations stay silent. Qualified unsuppressed trusted-community rows may
   * promote their existing catalog job using its deterministic notification receipt.
   */
  notify: boolean;
  trustedCommunityAlertsEnabled?: boolean;
}

/**
 * Notification fencing for one admitted row, including delayed promotion of a
 * genuinely new post-baseline trusted-community role. Retries and duplicates
 * reuse the durable notification receipt.
 */
export function admissionRowShouldNotify(
  context: Pick<AdmissionRowContext, 'baseline' | 'row' | 'firstObservationEligible'>,
  options: { policyMigration?: boolean; delayedPromotion?: boolean } = {},
): boolean {
  return admissionShouldNotify({
    baseline: context.baseline,
    policyMigration: options.policyMigration ?? false,
    firstObservation: context.firstObservationEligible ?? true,
    existingJob: Boolean(context.row.jobId) && !options.delayedPromotion,
  });
}

export interface AdmissionV2CatalogSink {
  /** Commit the row's decision and catalog effects idempotently. */
  commit(input: AdmissionCatalogCommit): Promise<void>;
  revoke?(input: {
    sourceId: string; externalId: string; reason: string; admissionVersion: string;
    effectFence?: PostingObservationAdmissionFence;
  }): Promise<void>;
}

export interface GradedAdmissionRow {
  jobId: string;
  listing: ProcessedListing;
  admission: CatalogAdmission;
  decision: AdmissionRowEvaluation['decision'];
}

/**
 * Grade one normalized source row using the existing admission rules:
 * technical scope and normalization (`processPosting`), destination
 * classification (`classifyDestination`), and catalog admission
 * (`evaluateCatalogAdmission`). Pure aside from the injected probe.
 */
export function gradeAdmissionRow(input: {
  sourceId: string;
  externalId: string;
  posting: SourcedPosting;
  canonicalEmployer?: Pick<CanonicalEmployer, 'id' | 'displayName'>;
  prior?: AdmissionV2PriorContext;
  trustedCommunityCatalogEnabled?: boolean;
  trustedCommunityAlertsEnabled?: boolean;
  baseline?: boolean;
  completeFetchSequence?: number;
  sourceMaterialHash?: string;
  qualificationCompleteSnapshots?: number;
  probe: AdmissionDestinationProbe;
  evaluatedAt: string;
}): GradedAdmissionRow | { decision: AdmissionRowEvaluation['decision'] } {
  const { listing, decision } = processPosting(input.posting);
  if (decision.outcome !== 'included') {
    if (decision.outcome === 'shelved') return { decision: { kind: 'shelved', reason: decision.reason } };
    return { decision: { kind: 'blocked', reason: decision.reason } };
  }
  // `included` always carries a listing.
  const processed = listing!;
  const identity = resolvePostingIdentityDecision({
    sourceId: input.sourceId,
    externalId: input.externalId,
    applicationUrl: processed.applyUrl,
    observedAt: input.evaluatedAt,
    ...(input.posting.providerEvidence ? { providerEvidence: input.posting.providerEvidence } : {}),
    ...(input.prior?.postingIdentityDecision ? { previousDecision: input.prior.postingIdentityDecision } : {}),
  });
  if (identity.decision.status === 'quarantined') {
    return { decision: { kind: 'blocked', reason: `posting-identity-${identity.decision.reason}` } };
  }
  const normalized: ProcessedListing = {
    ...processed,
    postingIdentityDecision: identity.decision,
    ...(identity.identity ? { postingIdentity: identity.identity } : {}),
    ...(input.canonicalEmployer
      ? { employerEvidence: { authority: input.posting.employer.authority, canonicalEmployer: input.canonicalEmployer } }
      : input.posting.employer.authority === 'reviewed-registry' && input.posting.employer.id
      ? {
        employerEvidence: {
          authority: input.posting.employer.authority,
          canonicalEmployer: { id: input.posting.employer.id, displayName: input.posting.employer.name },
        },
      } : {}),
  };
  const destination = classifyDestination({
    listing: normalized,
    reachability: input.probe.reachability,
    ...(input.probe.evidence ? { evidence: input.probe.evidence } : {}),
    inspectedAt: input.evaluatedAt,
  });
  if (destination.closureState === 'gone') {
    return { decision: { kind: 'blocked', reason: 'destination-gone' } };
  }
  const trustedCommunityPolicy = activeTrustedCommunityPolicy(
    input.sourceId,
    input.trustedCommunityCatalogEnabled ?? false,
  );
  const effectiveTrustedCommunityPolicy = trustedCommunityPolicy && input.trustedCommunityAlertsEnabled
    ? { ...trustedCommunityPolicy, alertMode: 'exact-identity-or-two-complete-snapshots' as const }
    : trustedCommunityPolicy;
  const previousQualification = input.prior?.trustedCommunityAlertQualification;
  const materialChanged = Boolean(input.sourceMaterialHash && previousQualification?.sourceMaterialHash
    && input.sourceMaterialHash !== previousQualification.sourceMaterialHash);
  const previousCadence = input.completeFetchSequence !== undefined && input.qualificationCompleteSnapshots !== undefined
    ? {
      consecutiveCompleteSnapshots: Math.max(0, input.qualificationCompleteSnapshots - 1),
      lastCountedSuccessfulFetchSequence: input.completeFetchSequence - 1,
      basis: undefined,
    } : {};
  const qualificationSeed = previousQualification ?? (effectiveTrustedCommunityPolicy
    ? advanceTrustedCommunityQualification({ destination, postingIdentityDecision: identity.decision,
      alertMode: effectiveTrustedCommunityPolicy.alertMode }) : undefined);
  const trustedCommunityQualification = effectiveTrustedCommunityPolicy
    ? { ...advanceTrustedCommunityQualification({
      ...(qualificationSeed
        ? { previous: {
          ...qualificationSeed,
          ...(materialChanged ? { consecutiveCompleteSnapshots: 0,
            lastCountedSuccessfulFetchSequence: undefined, basis: undefined } : {}),
          ...previousCadence,
        } }
        : {}),
      destination,
      postingIdentityDecision: identity.decision,
      alertMode: effectiveTrustedCommunityPolicy.alertMode,
      completeFetchSequence: input.completeFetchSequence,
      baselineSuppressed: effectiveTrustedCommunityPolicy.alertMode === 'disabled' || input.baseline === true,
      catalogPublicationSuppressed: false,
    }), ...(input.sourceMaterialHash ? { sourceMaterialHash: input.sourceMaterialHash } : {}) }
    : undefined;
  const qualifiedListing: ProcessedListing = trustedCommunityQualification
    ? { ...normalized, trustedCommunityAlertQualification: trustedCommunityQualification }
    : normalized;
  const admission = evaluateCatalogAdmission({
    listing: qualifiedListing,
    destination,
    postingAttributed: true,
    evaluatedAt: input.evaluatedAt,
    ...(input.prior?.admission ? { previous: input.prior.admission } : {}),
    ...(effectiveTrustedCommunityPolicy && trustedCommunityQualification
      ? { trustedCommunity: { policy: effectiveTrustedCommunityPolicy, qualification: trustedCommunityQualification } }
      : {}),
  });
  const jobId = normalized.postingIdentity?.canonicalJobId
    ?? stableSourceOccurrenceJobId(input.sourceId, input.externalId);
  if (!admission.catalogEligible) {
    return { decision: { kind: 'blocked', reason: admission.reasonCodes[0] ?? 'not-catalog-eligible' } };
  }
  return { jobId, listing: qualifiedListing, admission, decision: { kind: 'admitted', jobId } };
}

function isGraded(row: GradedAdmissionRow | { decision: AdmissionRowEvaluation['decision'] }): row is GradedAdmissionRow {
  return 'jobId' in row;
}

export interface RuleBasedAdmissionEvaluatorDependencies {
  prober: AdmissionDestinationProber;
  sink: AdmissionV2CatalogSink;
  resolveCanonicalEmployer?: AdmissionCanonicalEmployerResolver;
  resolvePriorContext?: AdmissionV2PriorContextResolver;
  trustedCommunityCatalogEnabled?: boolean;
  trustedCommunityAlertsEnabledForSource?: (sourceId: string) => boolean;
  now?: () => Date;
}

/**
 * The default Stage 2 evaluator. It grades the row with existing rules and
 * returns the catalog effect as a deferred callback. The consumer claims the
 * exact row identity durably before invoking the sink, so material replaced
 * during network evaluation can never publish a stale effect.
 */
export class RuleBasedAdmissionV2Evaluator implements AdmissionV2RowEvaluator {
  private readonly now: () => Date;

  constructor(private readonly dependencies: RuleBasedAdmissionEvaluatorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async evaluate(context: AdmissionRowContext): Promise<AdmissionRowEvaluation> {
    const observedAt = this.now().toISOString();
    // Deterministic posting decisions do not need network evidence. Running
    // these first keeps invalid URLs, nontechnical roles, and policy shelves
    // terminal instead of spending the row's transient retry budget.
    const deterministic = processPosting(context.posting);
    if (deterministic.decision.outcome !== 'included') {
      return this.terminal(context, {
        kind: deterministic.decision.outcome === 'shelved' ? 'shelved' : 'blocked',
        reason: deterministic.decision.reason,
      });
    }
    const canonicalEmployer = deterministic.listing?.employerEvidence?.canonicalEmployer
      ?? (deterministic.listing && this.dependencies.resolveCanonicalEmployer
        ? await this.dependencies.resolveCanonicalEmployer(deterministic.listing)
        : undefined);
    const prior = this.dependencies.resolvePriorContext
      ? await this.dependencies.resolvePriorContext(context.sourceId, context.externalId)
      : undefined;
    const probe = await this.dependencies.prober.probe({
      sourceId: context.sourceId,
      externalId: context.externalId,
      applyUrl: context.posting.applyUrl,
      observedAt,
    });
    const graded = gradeAdmissionRow({
      sourceId: context.sourceId,
      externalId: context.externalId,
      posting: context.posting,
      ...(canonicalEmployer ? { canonicalEmployer } : {}),
      ...(prior ? { prior } : {}),
      trustedCommunityCatalogEnabled: this.dependencies.trustedCommunityCatalogEnabled ?? false,
      trustedCommunityAlertsEnabled: this.dependencies.trustedCommunityAlertsEnabledForSource?.(context.sourceId) ?? false,
      baseline: context.baseline,
      completeFetchSequence: context.completeFetchSequence,
      sourceMaterialHash: context.row.materialHash,
      qualificationCompleteSnapshots: context.qualificationCompleteSnapshots,
      probe,
      evaluatedAt: observedAt,
    });
    if (isGraded(graded)) {
      const qualification = graded.listing.trustedCommunityAlertQualification;
      const alertsEnabled = this.dependencies.trustedCommunityAlertsEnabledForSource?.(context.sourceId) === true;
      const delayedPromotion = alertsEnabled && qualification?.status === 'eligible'
        && qualification.baselineSuppressed !== true && qualification.catalogPublicationSuppressed !== true
        && graded.admission.alertEligible;
      const effect = {
        sourceId: context.sourceId,
        externalId: context.externalId,
        baseline: context.baseline,
        admissionVersion: context.admissionVersion,
        ...(context.row.leaseOwner && context.row.leaseExpiresAt ? { effectFence: {
          snapshotHash: context.row.snapshotHash, materialHash: context.row.materialHash,
          admissionVersion: context.row.admissionVersion, leaseOwner: context.row.leaseOwner,
          leaseExpiresAt: context.row.leaseExpiresAt,
        } } : {}),
        listing: graded.listing,
        admission: graded.admission,
        jobId: graded.jobId,
        notify: admissionRowShouldNotify(context, { delayedPromotion }),
        trustedCommunityAlertsEnabled: delayedPromotion,
      };
      return {
        decision: graded.decision,
        jobId: graded.jobId,
        completeFetchSequence: context.completeFetchSequence,
        qualificationPending: alertsEnabled && qualification?.status === 'pending'
          && qualification.baselineSuppressed !== true && qualification.catalogPublicationSuppressed !== true,
        commitEffect: () => this.dependencies.sink.commit(effect),
      };
    }
    return this.terminal(context, graded.decision);
  }

  private terminal(context: AdmissionRowContext, decision: AdmissionRowEvaluation['decision']): AdmissionRowEvaluation {
    const revoke = this.dependencies.sink.revoke;
    return {
      decision,
      completeFetchSequence: context.completeFetchSequence,
      qualificationPending: false,
      ...(revoke && decision.kind !== 'admitted' ? {
        commitEffect: () => revoke.call(this.dependencies.sink, {
          sourceId: context.sourceId, externalId: context.externalId,
          reason: decision.reason, admissionVersion: context.admissionVersion,
          ...(context.row.leaseOwner && context.row.leaseExpiresAt ? { effectFence: {
            snapshotHash: context.row.snapshotHash, materialHash: context.row.materialHash,
            admissionVersion: context.row.admissionVersion, leaseOwner: context.row.leaseOwner,
            leaseExpiresAt: context.row.leaseExpiresAt,
          } } : {}),
        }),
      } : {}),
    };
  }
}
