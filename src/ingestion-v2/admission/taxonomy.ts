import {
  ADMISSION_V2_MAX_ATTEMPTS,
  ADMISSION_V2_RETRY_DELAYS_MS,
  type AdmissionFailure,
  type AdmissionInfrastructureFailureClass,
  type AdmissionRowFailureClass,
} from './types.js';

/**
 * A row-local transient failure: the source, destination, or evidence was
 * briefly unavailable. It consumes one row attempt and schedules the next retry;
 * after the final attempt the row is quarantined but peers are unaffected.
 */
export class AdmissionRowTransientError extends Error {
  constructor(
    readonly classification: AdmissionRowFailureClass,
    detail: string,
  ) {
    super(detail);
    this.name = 'AdmissionRowTransientError';
  }
}

/**
 * An infrastructure or systemic failure: D1, the queue, the runtime, or a
 * missing/malformed snapshot. It must not consume a row attempt or quarantine a
 * row; the delivery retries and the row lease expires safely.
 */
export class AdmissionInfrastructureError extends Error {
  constructor(
    readonly classification: AdmissionInfrastructureFailureClass,
    detail: string,
  ) {
    super(detail);
    this.name = 'AdmissionInfrastructureError';
  }
}

function bounded(detail: string): string {
  let sanitized = '';
  for (const character of detail) {
    const code = character.codePointAt(0) ?? 0;
    sanitized += code < 0x20 || code === 0x7f ? ' ' : character;
    if (sanitized.length >= 500) break;
  }
  return sanitized;
}

/** Classify a caught error into the admission failure taxonomy. */
export function classifyAdmissionFailure(error: unknown): AdmissionFailure {
  if (error instanceof AdmissionRowTransientError) {
    return { kind: 'row-transient', classification: error.classification, detail: bounded(error.message) };
  }
  if (error instanceof AdmissionInfrastructureError) {
    return { kind: 'infrastructure', classification: error.classification, detail: bounded(error.message) };
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  // A missing or corrupt snapshot is never a row's fault.
  if (lower.includes('snapshot object missing')) {
    return { kind: 'infrastructure', classification: 'snapshot-missing', detail: bounded(message) };
  }
  if (lower.includes('snapshot') && (lower.includes('hash mismatch') || lower.includes('invalid'))) {
    return { kind: 'infrastructure', classification: 'snapshot-corrupt', detail: bounded(message) };
  }
  // Destination-signalled transient failures.
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return { kind: 'row-transient', classification: 'destination-rate-limited', detail: bounded(message) };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return { kind: 'row-transient', classification: 'destination-timeout', detail: bounded(message) };
  }
  if (/\b5\d\d\b/u.test(message) || lower.includes('server error') || lower.includes('bad gateway') || lower.includes('unavailable')) {
    return { kind: 'row-transient', classification: 'upstream-server-error', detail: bounded(message) };
  }
  // D1 / runtime failures are systemic.
  if (lower.includes('d1') || lower.includes('storage') || lower.includes('database') || lower.includes('sql')) {
    return { kind: 'infrastructure', classification: 'd1-unavailable', detail: bounded(message) };
  }
  // Unknown errors fail safe as infrastructure: never quarantine on ambiguity.
  return { kind: 'infrastructure', classification: 'internal', detail: bounded(message) };
}

/** True when the failure may settle a row without touching its attempt count. */
export function isInfrastructureFailure(failure: AdmissionFailure): boolean {
  return failure.kind === 'infrastructure';
}

/** Compute the durable next attempt for a failed attempt, or exhaustion. */
export function nextAdmissionAttempt(
  failedAttempt: number,
  now: number,
): { retryAt: string; attemptCount: number } | { exhausted: true; attemptCount: number } {
  if (failedAttempt >= ADMISSION_V2_MAX_ATTEMPTS) return { exhausted: true, attemptCount: failedAttempt };
  const delay = ADMISSION_V2_RETRY_DELAYS_MS[Math.min(failedAttempt - 1, ADMISSION_V2_RETRY_DELAYS_MS.length - 1)];
  return { retryAt: new Date(now + delay).toISOString(), attemptCount: failedAttempt };
}
