// One classification for every D1 failure mode the ingestion pipeline can see,
// so the in-request retry (resilient-d1.ts) and the queue-boundary backoff
// (worker.ts) never disagree about a message. See issues #203 and #205.
export type D1FailureClass = 'retryable' | 'stalled' | 'overloaded' | 'internal' | 'other';

// D1 rotates or resets an instance out from under in-flight statements. A
// fresh prepare/bind runs against the reconnected instance, so an immediate
// rebuild-and-retry is safe. Cloudflare's guidance for this set is to retry.
const RETRYABLE = /no longer active|Connection closed|reset because the connection|D1 DB reset|Network connection lost|storage caused object to be reset/i;
// Transient pressure, not a dead instance. Retrying immediately worsens it;
// this class is paced at the queue boundary instead.
const OVERLOADED = /(?:\bd1\b|d1[_\s-]?error).*?(?:overload|too many|busy|limit)|database is locked/i;
// "D1_ERROR: internal error; reference = ..." matches neither Cloudflare's
// documented retryable list nor the overload wording, so it is treated as its
// own class and paced conservatively at the queue boundary.
const INTERNAL = /D1_ERROR:\s*internal error|internal error;\s*reference/i;

export function d1FailureMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : String(error);
}

/**
 * A D1 statement that never settles. Unlike every other class here it carries no
 * D1 error text at all — the request simply does not return — so it is
 * classified by type, not by message. Without this, a stalled read parks the
 * invoking consumer until the platform's fifteen-minute limit (observed on
 * `greenhouse-rocketlab`, which hung three consecutive deliveries while the same
 * board normally polls in under a second).
 */
export class D1StatementStallError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`D1 statement did not settle within ${timeoutMs} ms`);
    this.name = 'D1StatementStallError';
  }
}

export function classifyD1Failure(error: unknown): D1FailureClass {
  if (error instanceof D1StatementStallError) return 'stalled';
  const message = d1FailureMessage(error);
  if (RETRYABLE.test(message)) return 'retryable';
  if (OVERLOADED.test(message)) return 'overloaded';
  if (INTERNAL.test(message)) return 'internal';
  return 'other';
}

/** A stall is safe to retry in-request: the abandoned statement no longer holds
 * anything, and a fresh prepare/bind is a new request. */
export function isRetryableD1Failure(error: unknown): boolean {
  const classification = classifyD1Failure(error);
  return classification === 'retryable' || classification === 'stalled';
}
