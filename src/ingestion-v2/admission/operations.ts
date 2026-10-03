import { createHash } from 'node:crypto';
import type { IngestionRowRecord, IngestionRowState, IngestionSnapshotObjectStore } from '../types.js';
import type { AdmissionV2Ledger } from './ledger.js';
import type { AdmissionReplayPreview, AdmissionReplayRequest } from './types.js';

/** Sanitized row projection for the operations surface. */
export interface AdmissionRowInspection {
  sourceId: string;
  externalId: string;
  state: IngestionRowState;
  decision?: string;
  attemptCount: number;
  retryAt?: string;
  leaseExpiresAt?: string;
  failureClass?: string;
  failureDetail?: string;
  snapshotHash: string;
  materialHash: string;
  admissionVersion: string;
  jobId?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  updatedAt: string;
  settledAt?: string;
  replayEligible: boolean;
}

export interface AdmissionRowsPage {
  sourceId: string;
  rows: AdmissionRowInspection[];
  cursor?: string;
}

function replayEligible(row: IngestionRowRecord): boolean {
  return row.state === 'quarantined' || row.state === 'settled' || row.state === 'absent';
}

function inspect(row: IngestionRowRecord): AdmissionRowInspection {
  return {
    sourceId: row.sourceId,
    externalId: row.externalId,
    state: row.state,
    ...(row.decision ? { decision: row.decision } : {}),
    attemptCount: row.attemptCount,
    ...(row.retryAt ? { retryAt: row.retryAt } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.failureClass ? { failureClass: row.failureClass } : {}),
    ...(row.failureDetail ? { failureDetail: row.failureDetail } : {}),
    snapshotHash: row.snapshotHash,
    materialHash: row.materialHash,
    admissionVersion: row.admissionVersion,
    ...(row.jobId ? { jobId: row.jobId } : {}),
    firstObservedAt: row.firstObservedAt,
    lastObservedAt: row.lastObservedAt,
    updatedAt: row.updatedAt,
    ...(row.settledAt ? { settledAt: row.settledAt } : {}),
    replayEligible: replayEligible(row),
  };
}

/**
 * Bounded, keyset-paginated, sanitized row inspection. Failure detail is stored
 * already-sanitized by the consumer and is never a raw response body.
 */
export async function inspectAdmissionRows(
  ledger: AdmissionV2Ledger,
  input: { sourceId: string; state?: IngestionRowState; cursor?: string; limit?: number },
): Promise<AdmissionRowsPage> {
  const page = await ledger.listRowsPage(input.sourceId, {
    ...(input.state ? { state: input.state } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: input.limit ?? 100,
  });
  return {
    sourceId: input.sourceId,
    rows: page.rows.map(inspect),
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}

export async function inspectAdmissionOverview(ledger: AdmissionV2Ledger, sourceId: string) {
  return ledger.overview(sourceId);
}

/** Stable replay token bound to the row's durable identity and state. */
function replayToken(row: IngestionRowRecord): string {
  return createHash('sha256').update([
    'admission-v2-replay',
    row.sourceId,
    row.externalId,
    row.materialHash,
    row.admissionVersion,
    row.state,
  ].join('|')).digest('hex');
}

/**
 * Plan a guarded replay: preview the row, prove it is absent from no retained
 * snapshot, and hand back a token the apply step must echo. Replay of an
 * in-flight row is refused so an operator cannot bypass an active lease.
 */
export async function planAdmissionReplay(
  ledger: AdmissionV2Ledger,
  request: AdmissionReplayRequest,
  dependencies: { snapshots: IngestionSnapshotObjectStore },
): Promise<AdmissionReplayPreview & { replayToken?: string }> {
  const row = await ledger.getLedgerRow(request.sourceId, request.externalId);
  if (!row) return { sourceId: request.sourceId, externalId: request.externalId, eligible: false, reason: 'unknown-row' };
  const base = {
    sourceId: row.sourceId,
    externalId: row.externalId,
    state: row.state,
    attemptCount: row.attemptCount,
    snapshotHash: row.snapshotHash,
    materialHash: row.materialHash,
    admissionVersion: row.admissionVersion,
  };
  if (!replayEligible(row)) {
    return { ...base, eligible: false, reason: `in-flight:${row.state}` };
  }
  const snapshot = await ledger.getSnapshot(row.sourceId, row.snapshotHash);
  if (!snapshot || !snapshot.isComplete) {
    return { ...base, eligible: false, reason: 'snapshot-not-retained' };
  }
  try {
    const retained = await dependencies.snapshots.getSnapshot(row.sourceId, row.snapshotHash);
    if (!retained.rows.some((candidate) => candidate.externalId === row.externalId)) {
      return { ...base, eligible: false, reason: 'row-not-in-retained-snapshot' };
    }
  } catch {
    return { ...base, eligible: false, reason: 'snapshot-object-unavailable' };
  }
  return { ...base, eligible: true, expectedTransition: `${row.state}->queued`, replayToken: replayToken(row) };
}

export interface AdmissionReplayResult {
  applied: boolean;
  reason?: string;
  state?: IngestionRowState;
}

/**
 * Apply a guarded replay. The token binds the apply to the exact row state that
 * was previewed, so a concurrent settle or migration cannot be replayed by a
 * stale plan. Reopening an already-queued row is a no-op, so a repeated apply is
 * idempotent.
 */
export async function applyAdmissionReplay(
  ledger: AdmissionV2Ledger,
  request: AdmissionReplayRequest & { replayToken: string },
  options: { snapshots: IngestionSnapshotObjectStore; now?: () => Date; actor?: string },
): Promise<AdmissionReplayResult> {
  const preview = await planAdmissionReplay(ledger, request, { snapshots: options.snapshots });
  if (!preview.eligible) return { applied: false, reason: preview.reason };
  if (!preview.replayToken || preview.replayToken !== request.replayToken) {
    return { applied: false, reason: 'stale-replay-token' };
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const reopened = await ledger.reopenRows(request.sourceId, [request.externalId], now);
  const applied = reopened > 0;
  // Record the operator identity and outcome: replay is the one mutating
  // operations action, so it must leave an auditable trace.
  console.log(JSON.stringify({
    event: 'ingestion_v2_admission_replay',
    actor: options.actor ?? 'operator',
    sourceId: request.sourceId,
    externalId: request.externalId,
    applied,
    at: now,
  }));
  return { applied, state: 'queued' };
}
