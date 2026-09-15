import { describe, expect, it } from 'vitest';
import { classifyD1Failure, d1FailureMessage, isRetryableD1Failure } from '../cloudflare/d1-errors.js';

describe('D1 failure classification', () => {
  it.each([
    ['D1_ERROR: Connection closed: this D1 DB instance is no longer active. Reconnect or retry the request.', 'retryable'],
    ['D1_ERROR: D1 DB reset because its code was updated.', 'retryable'],
    ['D1_ERROR: Network connection lost.', 'retryable'],
    ['D1_ERROR: storage caused object to be reset.', 'retryable'],
    ['D1_ERROR: D1 DB is overloaded. Requests queued for too long.', 'overloaded'],
    ['D1_ERROR: too many requests', 'overloaded'],
    ['D1_ERROR: Memory limit exceeded before EOF.', 'overloaded'],
    ['database is locked', 'overloaded'],
    ['D1_ERROR: internal error; reference = 6hi9i83lajvi9r65mtnuni1t', 'internal'],
    ['D1_ERROR: internal error', 'internal'],
    ['D1_ERROR: UNIQUE constraint failed: jobs.id', 'other'],
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyD1Failure(new Error(message))).toBe(expected);
  });

  it('reads a message off a non-Error value', () => {
    expect(d1FailureMessage({ message: 'D1_ERROR: too many requests' })).toBe('D1_ERROR: too many requests');
    expect(d1FailureMessage('plain failure')).toBe('plain failure');
  });

  it('only treats the reconnect/reset family as in-request retryable', () => {
    expect(isRetryableD1Failure(new Error('D1_ERROR: D1 DB reset because its code was updated.'))).toBe(true);
    expect(isRetryableD1Failure(new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'))).toBe(false);
    expect(isRetryableD1Failure(new Error('D1_ERROR: internal error; reference = 6hi9i83lajvi9r65mtnuni1t'))).toBe(false);
  });
});
