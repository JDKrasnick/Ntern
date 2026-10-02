import { evaluateCatalogAdmission } from '../../catalog-admission.js';
import type { ApplicationPageEvidence } from '../../core/application-url.js';
import type { Reachability } from '../../core/application-verification.js';
import { classifyDestination } from '../../destination-verification.js';
import { stableSourceOccurrenceJobId } from '../../identity/registry.js';
import { processPosting } from '../../ingestion/processor.js';
import type { CatalogAdmission, ProcessedListing, SourcedPosting } from '../../types.js';
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

/** Terminal catalog effects for one admitted row. */
export interface AdmissionCatalogCommit {
  sourceId: string;
  externalId: string;
  baseline: boolean;
  admissionVersion: string;
  listing: ProcessedListing;
  admission: CatalogAdmission;
  jobId: string;
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
  probe: AdmissionDestinationProbe;
  evaluatedAt: string;
}): GradedAdmissionRow | { decision: AdmissionRowEvaluation['decision'] } {
  const { listing, decision } = processPosting(input.posting);
  if (decision.outcome !== 'included') {
    if (decision.outcome === 'shelved') return { decision: { kind: 'shelved', reason: decision.reason } };
    return { decision: { kind: 'blocked', reason: decision.reason } };
  }
  // `included` always carries a listing.
  const normalized = listing!;
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
      });
      return { decision: graded.decision, jobId: graded.jobId };
    }
    return { decision: graded.decision };
  }
}
