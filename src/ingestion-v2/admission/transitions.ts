import type { IngestionRowState } from '../types.js';

/**
 * The admission row state machine, encoded as data so illegal transitions are
 * rejected rather than silently applied.
 *
 *   pending    -> queued processing absent
 *   queued     -> processing settled absent
 *   processing -> settled queued (retry/reclaim) quarantined absent
 *   settled    -> queued (material/policy change) absent
 *   quarantined-> queued (reopen) absent
 *   absent     -> queued (reappeared) pending
 */
export const ADMISSION_TRANSITIONS: Readonly<Record<IngestionRowState, readonly IngestionRowState[]>> = {
  pending: ['queued', 'processing', 'absent'],
  queued: ['processing', 'settled', 'absent'],
  processing: ['settled', 'queued', 'quarantined', 'absent'],
  settled: ['queued', 'absent'],
  quarantined: ['queued', 'absent'],
  absent: ['queued', 'pending'],
};

export function canTransition(from: IngestionRowState, to: IngestionRowState): boolean {
  return from === to || ADMISSION_TRANSITIONS[from].includes(to);
}

export type AdmissionRowEvent =
  | { type: 'dispatch' }
  | { type: 'lease' }
  | { type: 'settle' }
  | { type: 'retry' }
  | { type: 'quarantine' }
  | { type: 'reclaim-lease' }
  | { type: 'reopen' }
  | { type: 'mark-absent' }
  | { type: 'reappear' };

/** Map an event to its target state for a given current state. */
export function transitionTarget(from: IngestionRowState, event: AdmissionRowEvent['type']): IngestionRowState | undefined {
  switch (event) {
    case 'dispatch':
      return from === 'pending' || from === 'absent' ? 'queued' : undefined;
    case 'lease':
      return from === 'pending' || from === 'queued' ? 'processing' : undefined;
    case 'settle':
      return from === 'processing' ? 'settled' : undefined;
    case 'retry':
      return from === 'processing' ? 'queued' : undefined;
    case 'quarantine':
      return from === 'processing' ? 'quarantined' : undefined;
    case 'reclaim-lease':
      return from === 'processing' ? 'queued' : undefined;
    case 'reopen':
      return from === 'quarantined' || from === 'settled' ? 'queued' : undefined;
    case 'mark-absent':
      return from === 'absent' ? 'absent' : 'absent';
    case 'reappear':
      return from === 'absent' ? 'queued' : undefined;
  }
}

export interface TransitionPlan {
  from: IngestionRowState;
  event: AdmissionRowEvent['type'];
  to: IngestionRowState;
}

export type TransitionResult =
  | { ok: true; plan: TransitionPlan }
  | { ok: false; reason: string };

/** Pure transition planner used by the D1 writer and unit tests. */
export function planRowTransition(from: IngestionRowState, event: AdmissionRowEvent['type']): TransitionResult {
  const to = transitionTarget(from, event);
  if (!to) return { ok: false, reason: `illegal-transition:${from}->${event}` };
  if (!canTransition(from, to)) return { ok: false, reason: `illegal-transition:${from}->${to}` };
  return { ok: true, plan: { from, event, to } };
}
