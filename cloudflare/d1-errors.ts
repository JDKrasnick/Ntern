// One classification for every D1 failure mode the ingestion pipeline can see,
// so the in-request retry (resilient-d1.ts) and the queue-boundary backoff
// (worker.ts) never disagree about a message. See issues #203 and #205.
export type D1FailureClass = 'retryable' | 'overloaded' | 'internal' | 'other';

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

export function classifyD1Failure(error: unknown): D1FailureClass {
  const message = d1FailureMessage(error);
  if (RETRYABLE.test(message)) return 'retryable';
  if (OVERLOADED.test(message)) return 'overloaded';
  if (INTERNAL.test(message)) return 'internal';
  return 'other';
}

export function isRetryableD1Failure(error: unknown): boolean {
  return classifyD1Failure(error) === 'retryable';
}
