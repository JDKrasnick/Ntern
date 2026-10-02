import type { CompactIngestionRow, IngestionDecision, IngestionRowRecord, IngestionRowState, IngestionSnapshotRecord } from '../types.js';
import type {
  AdmissionFailure,
  AdmissionLeaseResult,
  AdmissionV2Handoff,
  AdmissionV2SourceOverview,
} from './types.js';

export interface AcquireLeaseInput {
  sourceId: string;
  externalId: string;
  owner: string;
  now: string;
  leaseMs: number;
  /** The message's snapshot/material/policy intent; a mismatch leaves the row untouched. */
  expectedSnapshotHash: string;
  expectedMaterialHash: string;
  expectedAdmissionVersion: string;
}

export interface MarkQueuedInput {
  sourceId: string;
  externalId: string;
  snapshotHash: string;
  materialHash: string;
  admissionVersion: string;
  now: string;
}

/**
 * Admission-lane ledger operations. Implemented by the same D1 repository as
 * the Stage 1 ledger; kept as a separate boundary so the queue consumer only
 * depends on the transition primitives it needs.
 */
export interface AdmissionV2Ledger {
  /** Commit rows as `queued` before the producer sends their message. */
  markQueued(rows: readonly MarkQueuedInput[]): Promise<void>;
  /**
   * Atomically acquire a bounded lease. Returns `no-op` when the row is already
   * settled/quarantined, is owned by another delivery, or the message intent is
   * stale relative to the current row.
   */
  acquireLease(input: AcquireLeaseInput): Promise<AdmissionLeaseResult>;
  /** Return a leased row to `queued` without consuming an attempt. Reports whether the guarded update applied. */
  releaseLease(sourceId: string, externalId: string, owner: string, now: string): Promise<boolean>;
  settleRow(input: {
    sourceId: string;
    externalId: string;
    owner: string;
    now: string;
    decision: IngestionDecision;
    jobId?: string;
    reason?: string;
  }): Promise<boolean>;
  scheduleRowRetry(input: {
    sourceId: string;
    externalId: string;
    owner: string;
    now: string;
    attemptCount: number;
    retryAt: string;
    failure: AdmissionFailure;
  }): Promise<boolean>;
  quarantineRow(input: {
    sourceId: string;
    externalId: string;
    owner: string;
    now: string;
    attemptCount: number;
    failure: AdmissionFailure;
  }): Promise<boolean>;
  /**
   * Reopen settled/quarantined/absent rows (material, policy, or operator
   * replay). Optionally stamps a new admission version, which is how policy
   * migration re-grades a row under the current policy.
   */
  reopenRows(sourceId: string, externalIds: readonly string[], now: string, options?: { admissionVersion?: string }): Promise<number>;
  /** Expired leases are reclaimable; returns the rows moved back to `queued`. */
  reclaimExpiredLeases(now: string, limit: number): Promise<IngestionRowRecord[]>;
  recordHandoff(handoff: AdmissionV2Handoff): Promise<void>;
  acknowledgeHandoff(batchId: string, now: string): Promise<void>;
  /** Handoffs still within their dispatch lease, used to avoid duplicate sends. */
  listActiveHandoffs(sourceId: string, staleBefore: string): Promise<AdmissionV2Handoff[]>;
  /** Rows in a given state for one source, for policy migration and reopening. */
  listRowsByState(sourceId: string, state: IngestionRowState, limit: number): Promise<IngestionRowRecord[]>;
  /** Ledger row by key (used to guard replay and reopening). */
  getLedgerRow(sourceId: string, externalId: string): Promise<IngestionRowRecord | undefined>;
  getRow(sourceId: string, externalId: string): Promise<IngestionRowRecord | undefined>;
  /** Bounded rows due for dispatch; includes expired processing leases. */
  listDispatchableRows(sourceId: string, now: string, limit: number): Promise<IngestionRowRecord[]>;
  /** Settled rows graded under an older admission policy. */
  listStalePolicyRows(sourceId: string, admissionVersion: string, limit: number): Promise<CompactIngestionRow[]>;
  getSnapshot(sourceId: string, snapshotHash: string): Promise<IngestionSnapshotRecord | undefined>;
  listRowsPage(sourceId: string, options?: { state?: IngestionRowState; cursor?: string; limit?: number }): Promise<{ rows: IngestionRowRecord[]; cursor?: string }>;
  /** Sources with an active V2 snapshot, for the scheduled dispatcher. */
  listActiveSourceIds(limit: number): Promise<string[]>;
  overview(sourceId: string): Promise<AdmissionV2SourceOverview>;
}
