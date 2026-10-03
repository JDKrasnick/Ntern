import { evaluateCatalogAdmission } from '../../catalog-admission.js';
import type { ApplicationPageEvidence } from '../../core/application-url.js';
import type { Reachability } from '../../core/application-verification.js';
import { classifyDestination } from '../../destination-verification.js';
import { resolvePostingIdentityDecision, stableSourceOccurrenceJobId } from '../../identity/registry.js';
import { processPosting } from '../../ingestion/processor.js';
import type { CanonicalEmployer, CatalogAdmission, ProcessedListing, SourcedPosting } from '../../types.js';
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

/** Terminal catalog effects for one admitted row. */
export interface AdmissionCatalogCommit {
  sourceId: string;
  externalId: string;
  baseline: boolean;
  admissionVersion: string;
  listing: ProcessedListing;
  admission: CatalogAdmission;
  jobId: string;
  /**
   * Whether this commit may mint a new-role notification. It is always false for
   * baseline work and for a row that already has a catalog job (policy-migration
   * or re-admission), so a verification/canary sink can prove zero notifications
   * without a live catalog writer.
   */
  notify: boolean;
}

/**
 * Notification fencing for one admitted row. Baseline work and work for a row
 * that already owns a catalog job are silent; only a genuinely new post-baseline
 * role may notify. Retries and duplicate deliveries reuse the same durable row
 * identity, so this decision is stable across attempts.
 */
export function admissionRowShouldNotify(
  context: Pick<AdmissionRowContext, 'baseline' | 'row' | 'firstObservationEligible'>,
  options: { policyMigration?: boolean } = {},
): boolean {
  return admissionShouldNotify({
    baseline: context.baseline,
    policyMigration: options.policyMigration ?? false,
    firstObservation: context.firstObservationEligible ?? true,
    existingJob: Boolean(context.row.jobId),
  });
}

export interface AdmissionV2CatalogSink {
  /** Commit the row's decision and catalog effects idempotently. */
  commit(input: AdmissionCatalogCommit): Promise<void>;
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
  const admission = evaluateCatalogAdmission({
    listing: normalized,
    destination,
    postingAttributed: true,
    evaluatedAt: input.evaluatedAt,
  });
  const jobId = normalized.postingIdentity?.canonicalJobId
    ?? stableSourceOccurrenceJobId(input.sourceId, input.externalId);
  if (!admission.catalogEligible) {
    return { decision: { kind: 'blocked', reason: admission.reasonCodes[0] ?? 'not-catalog-eligible' } };
  }
  return { jobId, listing: normalized, admission, decision: { kind: 'admitted', jobId } };
}

function isGraded(row: GradedAdmissionRow | { decision: AdmissionRowEvaluation['decision'] }): row is GradedAdmissionRow {
  return 'jobId' in row;
}

export interface RuleBasedAdmissionEvaluatorDependencies {
  prober: AdmissionDestinationProber;
  sink: AdmissionV2CatalogSink;
  resolveCanonicalEmployer?: AdmissionCanonicalEmployerResolver;
  now?: () => Date;
}

/**
 * The default Stage 2 evaluator. It grades the row with existing rules and
 * commits the catalog effect through the injected sink, so the same grading is
 * exercised whether the sink records decisions (verification canary) or writes
 * the live catalog.
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
      return deterministic.decision.outcome === 'shelved'
        ? { decision: { kind: 'shelved', reason: deterministic.decision.reason } }
        : { decision: { kind: 'blocked', reason: deterministic.decision.reason } };
    }
    const canonicalEmployer = deterministic.listing?.employerEvidence?.canonicalEmployer
      ?? (deterministic.listing && this.dependencies.resolveCanonicalEmployer
        ? await this.dependencies.resolveCanonicalEmployer(deterministic.listing)
        : undefined);
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
      probe,
      evaluatedAt: observedAt,
    });
    if (isGraded(graded)) {
      await this.dependencies.sink.commit({
        sourceId: context.sourceId,
        externalId: context.externalId,
        baseline: context.baseline,
        admissionVersion: context.admissionVersion,
        listing: graded.listing,
        admission: graded.admission,
        jobId: graded.jobId,
        notify: admissionRowShouldNotify(context),
      });
      return { decision: graded.decision, jobId: graded.jobId };
    }
    return { decision: graded.decision };
  }
}
