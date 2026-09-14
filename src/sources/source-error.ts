import type { SourceFailureCategory } from '../types.js';

/**
 * Typed fetch failure so the snapshot publisher can decide between a bounded
 * retry (429/5xx/transport) and an immediate quarantine (404/401/malformed).
 */
export class SourceFetchError extends Error {
  constructor(
    message: string,
    readonly category: SourceFailureCategory,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly immediateQuarantine = false,
  ) {
    super(message);
    this.name = 'SourceFetchError';
  }

  get retryable(): boolean {
    if (this.category === 'transport') return true;
    if (this.category === 'capacity') return true;
    if (this.category === 'http') return this.status === 429 || (this.status !== undefined && this.status >= 500);
    return false;
  }
}

export function categorizeFetchError(error: unknown, sourceId: string): SourceFetchError {
  if (error instanceof SourceFetchError) return error;
  // A raw fetch rejection (DNS failure, timeout abort, connection reset) is a
  // transport problem and should be retried rather than quarantining the board.
  const message = error instanceof Error ? error.message : String(error);
  return new SourceFetchError(`${sourceId}: ${message}`, 'transport');
}
