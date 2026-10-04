import { snapshotObjectKey } from '../normalize.js';
import type { IngestionRowRecord } from '../types.js';
import type { AdmissionV2Ledger } from './ledger.js';
import { buildAdmissionV2Messages } from './message.js';
import { ADMISSION_V2_MAX_EXTERNAL_IDS, type AdmissionV2DispatchPlan } from './types.js';

/** How long an unacknowledged handoff suppresses a duplicate send. */
export const ADMISSION_V2_DISPATCH_LEASE_MS = 10 * 60 * 1000;

export interface AdmissionV2DispatchDependencies {
  ledger: AdmissionV2Ledger;
  now?: () => Date;
  maxIds?: number;
  dispatchLeaseMs?: number;
  maxRowsPerSource?: number;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Find the work one source should dispatch and turn it into bounded, versioned
 * admission messages.
 *
 * Ordering: reclaim expired leases first, then select pending rows, queued rows
 * whose handoff is missing or stale, and processing rows whose lease lapsed.
 * Rows already covered by a fresh, unacknowledged handoff are left alone so a
 * repeated dispatcher run cannot create duplicate logical work. Every selected
 * row is committed `queued` and paired with a durable handoff before the caller
 * sends, so a failed handoff stays recoverable by the next dispatcher run.
 *
 * This selects only rows already in a dispatchable lane state. Shadow discovery
 * reopens actionable rows while the scheduled bootstrap reopens a retained
 * baseline when admission is enabled after a shadow-first rollout.
 */
export async function planAdmissionV2Dispatch(
  sourceId: string,
  dependencies: AdmissionV2DispatchDependencies,
): Promise<AdmissionV2DispatchPlan> {
  const now = dependencies.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const dispatchLeaseMs = dependencies.dispatchLeaseMs ?? ADMISSION_V2_DISPATCH_LEASE_MS;
  const maxRows = dependencies.maxRowsPerSource ?? 500;

  await dependencies.ledger.reclaimExpiredLeases(nowIso, maxRows);
  const candidates = await dependencies.ledger.listDispatchableRows(sourceId, nowIso, maxRows);
  if (candidates.length === 0) {
    return { sourceId, snapshotHash: '', snapshotKey: '', admissionVersion: '', baseline: false, messages: [], skipped: 'no-work' };
  }

  const staleBefore = new Date(now().getTime() - dispatchLeaseMs).toISOString();
  const activeHandoffs = await dependencies.ledger.listActiveHandoffs(sourceId, staleBefore);
  const covered = new Set(activeHandoffs.flatMap((handoff) => handoff.externalIds));

  const groups = new Map<string, { snapshotHash: string; admissionVersion: string; baseline: boolean; rows: IngestionRowRecord[] }>();
  for (const row of candidates) {
    if (covered.has(row.externalId)) continue;
    // An absent row has no snapshot to grade against until it reappears.
    if (row.state === 'absent') continue;
    const baseline = row.notificationBaseline ?? false;
    const key = `${row.snapshotHash}\u0000${row.admissionVersion}\u0000${baseline ? 'baseline' : 'incremental'}`;
    let group = groups.get(key);
    if (!group) {
      group = { snapshotHash: row.snapshotHash, admissionVersion: row.admissionVersion, baseline, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  if (groups.size === 0) {
    return { sourceId, snapshotHash: '', snapshotKey: '', admissionVersion: '', baseline: false, messages: [], skipped: 'no-work' };
  }

  const messages = [];
  let firstGroup: { snapshotHash: string; admissionVersion: string; baseline: boolean } | undefined;
  for (const group of groups.values()) {
    const snapshot = await dependencies.ledger.getSnapshot(sourceId, group.snapshotHash);
    if (!snapshot || !snapshot.isComplete) continue;
    const marked = await dependencies.ledger.markQueued(group.rows.map((row) => ({
      sourceId,
      externalId: row.externalId,
      snapshotHash: row.snapshotHash,
      materialHash: row.materialHash,
      admissionVersion: row.admissionVersion,
      now: nowIso,
    })));
    if (marked.length === 0) continue;
    firstGroup ??= group;
    const orderedIds = marked.map((row) => row.externalId);
    const built = buildAdmissionV2Messages({
      sourceId,
      snapshotHash: group.snapshotHash,
      snapshotKey: snapshotObjectKey(sourceId, group.snapshotHash),
      admissionVersion: group.admissionVersion,
      baseline: group.baseline,
      externalIds: orderedIds,
      maxIds: dependencies.maxIds ?? ADMISSION_V2_MAX_EXTERNAL_IDS,
    });
    for (const message of built) {
      await dependencies.ledger.recordHandoff({
        batchId: message.batchId,
        sourceId,
        snapshotHash: message.snapshotHash,
        admissionVersion: message.admissionVersion,
        externalIds: [...message.externalIds],
        baseline: message.baseline,
        dispatchedAt: nowIso,
      });
      messages.push(message);
    }
  }
  if (messages.length === 0) {
    return { sourceId, snapshotHash: '', snapshotKey: '', admissionVersion: '', baseline: false, messages: [], skipped: 'no-active-snapshot' };
  }
  dependencies.log?.({ event: 'ingestion_v2_dispatch', sourceId, batches: messages.length, rows: messages.reduce((sum, message) => sum + message.externalIds.length, 0) });
  return {
    sourceId,
    snapshotHash: firstGroup?.snapshotHash ?? '',
    snapshotKey: firstGroup ? snapshotObjectKey(sourceId, firstGroup.snapshotHash) : '',
    admissionVersion: firstGroup?.admissionVersion ?? '',
    baseline: firstGroup?.baseline ?? false,
    messages,
  };
}
