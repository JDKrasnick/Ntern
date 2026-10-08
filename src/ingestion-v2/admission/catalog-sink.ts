import { CatalogReconciler } from '../../ingestion/catalog-reconciler.js';
import { createHash } from 'node:crypto';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../../role-metadata.js';
import { SupersededPostingObservationError, type InternshipStore, type PostingObservationOmissionFence,
  type PostingObservationAdmissionFence } from '../../store.js';
import { AdmissionInfrastructureError } from './taxonomy.js';
import type { AdmissionCatalogCommit, AdmissionV2CatalogSink } from './evaluator.js';

/**
 * Reconciler-backed effect boundary used by integration verification and the
 * source-scoped Stage 3 live writer. Default-off controls select this sink only
 * for an explicit cutover source; all other rows use the recording sink.
 */
export class ReconcilerAdmissionV2CatalogSink implements AdmissionV2CatalogSink {
  private readonly reconciler = new CatalogReconciler();

  constructor(
    private readonly store: InternshipStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async revoke(input: {
    sourceId: string; externalId: string; reason: string; admissionVersion: string;
    effectFence?: PostingObservationAdmissionFence;
  }): Promise<void> {
    try {
      await this.close(input);
    } catch (error) {
      if (error instanceof SupersededPostingObservationError) return;
      throw error;
    }
  }

  /** Complete-snapshot absence is source-local, never proof a peer is gone. */
  async closeOmission(input: {
    sourceId: string; externalId: string; admissionVersion: string;
    observedAt: string; fence: PostingObservationOmissionFence;
  }): Promise<void> {
    await this.close({ ...input, reason: 'complete-snapshot-omission' }, input);
  }

  private async close(
    input: { sourceId: string; externalId: string; reason: string; admissionVersion: string;
      effectFence?: PostingObservationAdmissionFence },
    omission?: { observedAt: string; fence: PostingObservationOmissionFence },
  ): Promise<void> {
    const prior = await this.store.getSourceOccurrence(input.sourceId, input.externalId);
    if (!prior) return;
    const existing = await this.store.getJob(prior.jobId);
    if (!existing) throw new AdmissionInfrastructureError('internal', 'closure occurrence has no canonical job');
    if (!omission && prior.occurrence.state === 'closed'
      && prior.occurrence.admission?.catalogEligible === false
      && prior.occurrence.admissionConfigurationVersion === input.admissionVersion
      && existing.sourceReferences.some((reference) => reference.sourceId === input.sourceId
        && reference.externalId === input.externalId && reference.state === 'closed'
        && reference.admission?.catalogEligible === false)) return;
    const decision = prior.occurrence.postingIdentityDecision;
    if (!decision || decision.status === 'quarantined') {
      throw new AdmissionInfrastructureError('internal', 'closure requires an existing committable identity decision');
    }
    const admission = prior.occurrence.admission;
    const previousAdmissionClock = admission ? Math.max(...[
      admission.evaluatedAt, admission.evidenceObservedAt, admission.destination.inspectedAt,
    ].map((value) => Date.parse(value ?? '')).filter(Number.isFinite)) : 0;
    const observedAt = omission?.observedAt ?? new Date(Math.max(
      this.now().getTime(), previousAdmissionClock + 1,
    )).toISOString();
    const occurrence = {
      ...prior,
      present: omission ? false : prior.present,
      consecutiveOmissions: omission ? Math.max(2, prior.consecutiveOmissions) : prior.consecutiveOmissions,
      changedAt: observedAt,
      changedSnapshotHash: omission?.fence.activeSnapshotHash ?? prior.changedSnapshotHash,
      occurrence: {
        ...prior.occurrence,
        state: 'closed' as const,
        admissionConfigurationVersion: input.admissionVersion,
        ...(admission && !omission ? { admission: {
          ...admission, catalogEligible: false, alertEligible: false,
          evaluatedAt: observedAt, evidenceObservedAt: observedAt,
        } } : {}),
      },
    };
    // Keep peer references out of the proposed snapshot. The atomic projection
    // reads current peers again after contention rather than replaying stale ones.
    const job = { ...existing, sourceReferences: [occurrence.occurrence] };
    const result = await this.store.commitPostingObservation({
      decision, job, occurrence,
      ...(omission ? { omissionFence: omission.fence } : {}),
      ...(input.effectFence ? { admissionEffectFence: input.effectFence } : {}),
    });
    if (result.outcome !== 'committed') {
      throw new AdmissionInfrastructureError('internal', 'closure was quarantined at the identity boundary');
    }
  }

  async commit(input: AdmissionCatalogCommit): Promise<{ jobId: string } | void> {
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
      trustedCommunityAlertsEnabled: input.notify && input.trustedCommunityAlertsEnabled === true,
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
    let result;
    const provider = listing.providerIdentity;
    const previousShadowHash = prior?.occurrence.shadowContentHash;
    const shadowEligible = provider && ['greenhouse', 'lever', 'ashby'].includes(provider.provider)
      && decision.status === 'confirmed' && listing.technical !== false && job.open
      && input.admission.catalogEligible && Boolean(listing.shadowContentHash)
      && (!prior || Boolean(previousShadowHash && previousShadowHash !== listing.shadowContentHash));
    try {
      result = await this.store.commitPostingObservation({
        decision,
        ...(job.postingIdentity ? { identity: job.postingIdentity } : {}),
        job,
        occurrence,
        ...(shadowEligible ? { providerShadowVerification: {
          jobId: job.jobId, sourceId: input.sourceId, externalId: input.externalId,
          providerIdentity: provider, candidateUrl: listing.applyUrl,
          reason: prior ? 'content-change' as const : 'first-sight' as const,
          metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
          shadowContentHash: listing.shadowContentHash,
          shadowOrigin: 'provider-poll' as const,
          idempotencyKey: createHash('sha256').update(`provider-poll-shadow-v1\0${job.jobId}\0${input.sourceId}\0${input.externalId}\0${listing.shadowContentHash}`).digest('hex'),
        } } : {}),
        ...(input.effectFence ? { admissionEffectFence: input.effectFence } : {}),
        ...(input.notify && notifications.get(job.jobId)
          ? { notificationEvent: notifications.get(job.jobId)! }
          : {}),
      });
    } catch (error) {
      if (error instanceof SupersededPostingObservationError) return;
      throw error;
    }
    if (result.outcome !== 'committed') {
      throw new AdmissionInfrastructureError('internal', 'catalog observation was quarantined at the identity boundary');
    }
    return { jobId: result.canonicalJobId };
  }
}
