import type { IngestionSnapshotObjectStore } from '../types.js';
import type { NormalizedSnapshotRow } from '../types.js';
import type { AdmissionV2Ledger } from './ledger.js';
import { classifyAdmissionFailure, nextAdmissionAttempt } from './taxonomy.js';
import {
  ADMISSION_V2_LEASE_MS,
  type AdmissionFailure,
  type AdmissionV2Message,
  type AdmissionV2RowEvaluator,
} from './types.js';

export interface AdmissionV2ConsumerDependencies {
  ledger: AdmissionV2Ledger;
  snapshots: IngestionSnapshotObjectStore;
  evaluator: AdmissionV2RowEvaluator;
  now?: () => Date;
  owner?: (message: AdmissionV2Message) => string;
  leaseMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface AdmissionV2MessageResult {
  batchId: string;
  sourceId: string;
  /** True when every row independently committed; the delivery may acknowledge. */
  acknowledged: boolean;
  settled: number;
  retried: number;
  quarantined: number;
  skipped: number;
  /** Present when a systemic failure requires the whole delivery to retry. */
  infrastructureFailure?: AdmissionFailure;
  counts: {
    admitted: number;
    blocked: number;
    shelved: number;
  };
}

function defaultOwner(message: AdmissionV2Message): string {
  return `admission-v2:${message.batchId}`;
}

function infrastructureResult(result: AdmissionV2MessageResult, failure: AdmissionFailure): AdmissionV2MessageResult {
  result.acknowledged = false;
  result.infrastructureFailure = failure;
  return result;
}

async function selectedSnapshotRows(
  message: AdmissionV2Message,
  snapshots: IngestionSnapshotObjectStore,
): Promise<Map<string, NormalizedSnapshotRow>> {
  if (snapshots.getSnapshotRows) return snapshots.getSnapshotRows(message.sourceId, message.snapshotHash, message.externalIds);
  // The store validates the entire immutable board before any row can commit.
  // Let unselected postings become collectible before the first provider await.
  const envelope = await snapshots.getSnapshot(message.sourceId, message.snapshotHash);
  const selected = new Set(message.externalIds);
  return new Map(envelope.rows.filter((row) => selected.has(row.externalId)).map((row) => [row.externalId, row]));
}

/**
 * Process one admission message: read the referenced snapshot once, then let
 * every selected row settle, retry, or quarantine independently.
 *
 * A duplicate or stale delivery is a no-op because the lease predicate requires
 * the message's snapshot/material/policy intent to still match the row. A
 * systemic failure is returned as `infrastructureFailure` (and the delivery is
 * expected to retry) without consuming a row attempt or quarantining a row.
 */
export async function processAdmissionV2Message(
  message: AdmissionV2Message,
  dependencies: AdmissionV2ConsumerDependencies,
): Promise<AdmissionV2MessageResult> {
  const now = dependencies.now ?? (() => new Date());
  const leaseMs = dependencies.leaseMs ?? ADMISSION_V2_LEASE_MS;
  const owner = (dependencies.owner ?? defaultOwner)(message);
  const result: AdmissionV2MessageResult = {
    batchId: message.batchId,
    sourceId: message.sourceId,
    acknowledged: true,
    settled: 0,
    retried: 0,
    quarantined: 0,
    skipped: 0,
    counts: { admitted: 0, blocked: 0, shelved: 0 },
  };

  // A missing or incomplete snapshot is systemic: it must never settle, retry,
  // or quarantine a row, and the delivery should retry after an operator repair.
  const snapshotRecord = await dependencies.ledger.getSnapshot(message.sourceId, message.snapshotHash);
  if (!snapshotRecord) {
    return infrastructureResult(result, { kind: 'infrastructure', classification: 'snapshot-missing', detail: 'snapshot record not found' });
  }
  if (!snapshotRecord.isComplete) {
    return infrastructureResult(result, { kind: 'infrastructure', classification: 'snapshot-incomplete', detail: 'snapshot is incomplete' });
  }
  // Read the immutable snapshot once per batch, never once per row. A missing or
  // corrupt R2 object is systemic, never a row's fault.
  let rowsById;
  try {
    rowsById = await selectedSnapshotRows(message, dependencies.snapshots);
  } catch (error) {
    return infrastructureResult(result, classifyAdmissionFailure(error));
  }

  for (const externalId of message.externalIds) {
    const snapshotRow = rowsById.get(externalId);
    if (!snapshotRow) {
      // An ID absent from a retained complete snapshot is stale work, not an error.
      result.skipped += 1;
      continue;
    }
    const lease = await dependencies.ledger.acquireLease({
      sourceId: message.sourceId,
      externalId,
      owner,
      now: now().toISOString(),
      leaseMs,
      expectedSnapshotHash: message.snapshotHash,
      expectedMaterialHash: snapshotRow.materialHash,
      expectedAdmissionVersion: message.admissionVersion,
    });
    if (lease.outcome !== 'acquired') {
      result.skipped += 1;
      continue;
    }
    const expectedIdentity = {
      expectedSnapshotHash: message.snapshotHash,
      expectedMaterialHash: snapshotRow.materialHash,
      expectedAdmissionVersion: message.admissionVersion,
      expectedNotificationBaseline: lease.row.notificationBaseline ?? false,
      expectedLeaseExpiresAt: lease.row.leaseExpiresAt,
    };
    // Baseline is intentionally excluded: a silence change must release this
    // exact owned lease for immediate quiet reevaluation, without an attempt.
    const releaseGuard = {
      expectedSnapshotHash: message.snapshotHash,
      expectedMaterialHash: snapshotRow.materialHash,
      expectedAdmissionVersion: message.admissionVersion,
      expectedLeaseExpiresAt: lease.row.leaseExpiresAt,
    };

    try {
      const evaluation = await dependencies.evaluator.evaluate({
        sourceId: message.sourceId,
        externalId,
        snapshotHash: message.snapshotHash,
        admissionVersion: message.admissionVersion,
        // The durable row fence wins if an older queued message predates a
        // silent bootstrap or migration of the same admission identity.
        baseline: message.baseline || lease.row.notificationBaseline === true,
        row: lease.row,
        posting: snapshotRow.posting,
        firstObservationEligible: snapshotRow.firstObservationEligible,
        completeFetchSequence: lease.row.qualificationObservedSequence,
        qualificationCompleteSnapshots: lease.row.qualificationCompleteSnapshots,
      });
      const decision = evaluation.decision;
      let jobId = evaluation.jobId ?? (decision.kind === 'admitted' ? decision.jobId : undefined);
      if (evaluation.commitEffect) {
        const claimed = await dependencies.ledger.claimRowEffect({
          sourceId: message.sourceId,
          externalId,
          owner,
          now: now().toISOString(),
          ...expectedIdentity,
        });
        if (!claimed) {
          await dependencies.ledger.releaseLease(message.sourceId, externalId, owner, now().toISOString(), releaseGuard);
          result.skipped += 1;
          dependencies.log?.({ event: 'ingestion_v2_admission_lease_lost', batchId: message.batchId, sourceId: message.sourceId, externalId, phase: 'effect-claim' });
          continue;
        }
        const committed = await evaluation.commitEffect();
        if (committed) jobId = committed.jobId;
      }
      const settled = await dependencies.ledger.settleRow({
        sourceId: message.sourceId,
        externalId,
        owner,
        now: now().toISOString(),
        ...expectedIdentity,
        decision: decision.kind,
        effectClaimed: Boolean(evaluation.commitEffect),
        completeFetchSequence: evaluation.completeFetchSequence,
        qualificationPending: evaluation.qualificationPending ?? false,
        ...(jobId ? { jobId } : {}),
        ...(decision.kind === 'admitted' ? {} : { reason: decision.reason }),
      });
      if (!settled) {
        // Material, policy, silence, or lease replacement invalidated this
        // evaluation. Release only the original lease epoch; a surviving
        // silence update is then immediately eligible for quiet reevaluation.
        result.skipped += 1;
        await dependencies.ledger.releaseLease(message.sourceId, externalId, owner, now().toISOString(), releaseGuard);
        dependencies.log?.({ event: 'ingestion_v2_admission_lease_lost', batchId: message.batchId, sourceId: message.sourceId, externalId, phase: 'settle' });
        continue;
      }
      result.settled += 1;
      if (decision.kind === 'admitted') result.counts.admitted += 1;
      else if (decision.kind === 'blocked') result.counts.blocked += 1;
      else result.counts.shelved += 1;
    } catch (error) {
      const failure = classifyAdmissionFailure(error);
      if (failure.kind === 'infrastructure') {
        // Do not consume a row attempt or quarantine on a systemic failure.
        const released = await dependencies.ledger.releaseLease(message.sourceId, externalId, owner, now().toISOString(), releaseGuard);
        if (!released) dependencies.log?.({ event: 'ingestion_v2_admission_lease_lost', batchId: message.batchId, sourceId: message.sourceId, externalId, phase: 'release' });
        result.acknowledged = false;
        result.infrastructureFailure = failure;
        dependencies.log?.({ event: 'ingestion_v2_admission_infrastructure', batchId: message.batchId, externalId, classification: failure.classification });
        return result;
      }
      const failedAttempt = lease.row.attemptCount + (failure.retryWithoutAttempt ? 0 : 1);
      const next = nextAdmissionAttempt(failedAttempt, now().getTime(), failure);
      if ('exhausted' in next) {
        const quarantined = await dependencies.ledger.quarantineRow({
          sourceId: message.sourceId, externalId, owner, now: now().toISOString(),
          ...expectedIdentity,
          attemptCount: failedAttempt, failure,
        });
        if (!quarantined) {
          await dependencies.ledger.releaseLease(message.sourceId, externalId, owner, now().toISOString(), releaseGuard);
          result.skipped += 1;
          dependencies.log?.({ event: 'ingestion_v2_admission_lease_lost', batchId: message.batchId, sourceId: message.sourceId, externalId, phase: 'quarantine' });
          continue;
        }
        result.quarantined += 1;
        dependencies.log?.({ event: 'ingestion_v2_admission_quarantined', batchId: message.batchId, sourceId: message.sourceId, externalId, classification: failure.classification });
      } else {
        const retried = await dependencies.ledger.scheduleRowRetry({
          sourceId: message.sourceId, externalId, owner, now: now().toISOString(),
          ...expectedIdentity,
          attemptCount: next.attemptCount, retryAt: next.retryAt, failure,
        });
        if (!retried) {
          await dependencies.ledger.releaseLease(message.sourceId, externalId, owner, now().toISOString(), releaseGuard);
          result.skipped += 1;
          dependencies.log?.({ event: 'ingestion_v2_admission_lease_lost', batchId: message.batchId, sourceId: message.sourceId, externalId, phase: 'retry' });
          continue;
        }
        result.retried += 1;
      }
    }
  }

  return result;
}
