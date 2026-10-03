import { CatalogReconciler } from '../../ingestion/catalog-reconciler.js';
import type { InternshipStore } from '../../store.js';
import { AdmissionInfrastructureError } from './taxonomy.js';
import type { AdmissionCatalogCommit, AdmissionV2CatalogSink } from './evaluator.js';

/**
 * Reconciler-backed effect boundary used by integration verification and the
 * eventual live cutover. The deployed Stage 2 lane still injects the recording
 * sink, but both modes now exercise the same idempotent catalog contract.
 */
export class ReconcilerAdmissionV2CatalogSink implements AdmissionV2CatalogSink {
  private readonly reconciler = new CatalogReconciler();

  constructor(
    private readonly store: InternshipStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async commit(input: AdmissionCatalogCommit): Promise<void> {
    const observedAt = this.now().toISOString();
    const prior = await this.store.getSourceOccurrence(input.sourceId, input.externalId);
    const existing = prior ? await this.store.getJob(prior.jobId) : await this.store.getJob(input.jobId);
    const listing = {
      ...input.listing,
      externalId: input.externalId,
      admission: input.admission,
      admissionConfigurationVersion: input.admissionVersion,
    };
    const plan = this.reconciler.reconcile({
      sourceId: input.sourceId,
      snapshotHash: `admission-v2:${input.admissionVersion}`,
      activeExternalIds: new Set([input.externalId]),
      listings: [listing],
      priorOccurrences: prior ? [prior] : [],
      resolvedJobs: new Map([[input.externalId, existing]]),
      now: observedAt,
      baseline: input.baseline,
      alertEligible: input.notify ? new Set([input.externalId]) : new Set(),
      publishUnconfirmedIdentities: true,
      forcePersistExternalIds: new Set([input.externalId]),
    });
    const jobs = new Map(plan.jobs.map((job) => [job.jobId, job]));
    const notifications = new Map(plan.notifications.map((event) => [event.jobId, event]));
    const occurrence = plan.occurrences.find((candidate) => candidate.externalId === input.externalId);
    if (!occurrence) return;
    const job = jobs.get(occurrence.jobId);
    const decision = occurrence.occurrence.postingIdentityDecision;
    if (!job || !decision || decision.status === 'quarantined') {
      throw new AdmissionInfrastructureError('internal', 'catalog reconciliation did not produce a committable posting observation');
    }
    const result = await this.store.commitPostingObservation({
      decision,
      ...(job.postingIdentity ? { identity: job.postingIdentity } : {}),
      job,
      occurrence,
      ...(input.notify && notifications.get(job.jobId)
        ? { notificationEvent: notifications.get(job.jobId)! }
        : {}),
    });
    if (result.outcome !== 'committed') {
      throw new AdmissionInfrastructureError('internal', 'catalog observation was quarantined at the identity boundary');
    }
  }
}
