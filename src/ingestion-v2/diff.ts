import type {
  CompactIngestionRow,
  DiffPlannerInput,
  IngestionRowClassification,
  SnapshotDiff,
  SnapshotDiffRow,
  SnapshotOmissionUpdate,
} from './types.js';

const actionableClassifications = new Set<IngestionRowClassification>([
  'new',
  'changed',
  'stale-policy',
  'reappeared',
  'retryable',
]);

function retryDue(row: CompactIngestionRow, now: string): boolean {
  if (!row.retryAt) return false;
  const due = Date.parse(row.retryAt);
  if (!Number.isFinite(due)) return false;
  return due <= Date.parse(now);
}

function classify(row: { externalId: string; materialHash: string }, prior: CompactIngestionRow | undefined, input: DiffPlannerInput): IngestionRowClassification {
  if (!prior) return 'new';
  // Policy migrations must reopen every retained state and stay silent even
  // when the same snapshot also changes material or restores an absent row.
  if (prior.admissionVersion !== input.admissionVersion) return 'stale-policy';
  if (prior.state === 'absent' || prior.consecutiveOmissions >= 2) return 'reappeared';
  if (prior.materialHash !== row.materialHash) return 'changed';
  if (retryDue(prior, input.now)) return 'retryable';
  return 'unchanged';
}

/**
 * Pure full-board diff.
 *
 * Every normalized row is compared against the compact ledger. The result is
 * independent of row or document ordering, and it performs no I/O. An
 * incomplete snapshot never becomes actionable and never advances omissions.
 */
export function planSnapshotDiff(input: DiffPlannerInput): SnapshotDiff {
  const base = {
    sourceId: input.sourceId,
    snapshotHash: input.snapshotHash,
    admissionVersion: input.admissionVersion,
  };
  if (!input.complete) {
    return {
      ...base,
      complete: false,
      counts: { total: input.rows.length, new: 0, changed: 0, stalePolicy: 0, retryable: 0, unchanged: 0, reappeared: 0, missing: 0 },
      actionableExternalIds: [],
      omissionUpdates: [],
      rows: [],
    };
  }

  const ledger = new Map(input.ledger.map((row) => [row.externalId, row]));
  const sortedRows = canonicalRows(input.rows);
  const rows: SnapshotDiffRow[] = [];
  const actionable: string[] = [];
  const counts = { total: sortedRows.length, new: 0, changed: 0, stalePolicy: 0, retryable: 0, unchanged: 0, reappeared: 0, missing: 0 };
  const seen = new Set<string>();

  for (const row of sortedRows) {
    seen.add(row.externalId);
    const classification = classify(row, ledger.get(row.externalId), input);
    const isActionable = actionableClassifications.has(classification);
    if (classification === 'new') counts.new += 1;
    else if (classification === 'changed') counts.changed += 1;
    else if (classification === 'stale-policy') counts.stalePolicy += 1;
    else if (classification === 'retryable') counts.retryable += 1;
    else if (classification === 'reappeared') counts.reappeared += 1;
    else counts.unchanged += 1;
    if (isActionable) actionable.push(row.externalId);
    rows.push({ externalId: row.externalId, classification, materialHash: row.materialHash, actionable: isActionable });
  }

  const omissionUpdates: SnapshotOmissionUpdate[] = [];
  for (const prior of input.ledger) {
    if (seen.has(prior.externalId) || prior.state === 'absent') continue;
    // Older ledgers retained admission lane states after two omissions. A
    // complete recovery pass repairs those states without grading missing rows.
    if (prior.consecutiveOmissions >= 2) {
      omissionUpdates.push({ externalId: prior.externalId, consecutiveOmissions: prior.consecutiveOmissions, becomesAbsent: true });
      continue;
    }
    const next = prior.consecutiveOmissions + 1;
    omissionUpdates.push({ externalId: prior.externalId, consecutiveOmissions: next, becomesAbsent: next >= 2 });
  }
  omissionUpdates.sort((left, right) => left.externalId.localeCompare(right.externalId));
  counts.missing = omissionUpdates.length;

  return {
    ...base,
    complete: true,
    counts,
    actionableExternalIds: actionable,
    omissionUpdates,
    rows,
  };
}

/** Normalization already orders production snapshots; copy only unordered callers. */
function canonicalRows<T extends { externalId: string }>(rows: readonly T[]): readonly T[] {
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1]!.externalId.localeCompare(rows[index]!.externalId) > 0) {
      return [...rows].sort((left, right) => left.externalId.localeCompare(right.externalId));
    }
  }
  return rows;
}
