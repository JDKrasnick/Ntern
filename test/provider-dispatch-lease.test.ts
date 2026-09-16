import { describe, expect, it } from 'vitest';
import { isSourceDispatchInFlight, missedPublishedInterval, SOURCE_CADENCE_SLIP_MS, SOURCE_DISPATCH_LEASE_MS } from '../src/source-poll-cadence.js';
import type { SourceHealth } from '../src/types.js';

const now = new Date('2026-09-15T18:00:00.000Z');
const dispatchedAt = '2026-09-15T17:45:00.000Z';
const unacknowledged = { sourceId: 'greenhouse-airbnb', provider: 'greenhouse', dispatchedAt };
const acknowledged: SourceHealth = {
  sourceId: 'greenhouse-airbnb', lastAttemptAt: '2026-09-15T17:50:00.000Z', consecutiveFailures: 0, durationMs: 120,
};
const stale: SourceHealth = { ...acknowledged, lastAttemptAt: '2026-09-15T17:40:00.000Z' };
const aged = (milliseconds: number) => ({
  ...unacknowledged, dispatchedAt: new Date(now.getTime() - milliseconds).toISOString(),
});

describe('source dispatch leases', () => {
  it('suppresses a source whose dispatch marker is unexpired and unacknowledged', () => {
    expect(isSourceDispatchInFlight(unacknowledged, undefined, now)).toBe(true);
  });

  it('releases a source once its marker is a full cadence old', () => {
    expect(isSourceDispatchInFlight(aged(SOURCE_DISPATCH_LEASE_MS), undefined, now)).toBe(false);
    expect(isSourceDispatchInFlight(aged(SOURCE_DISPATCH_LEASE_MS - 1), undefined, now)).toBe(true);
    expect(isSourceDispatchInFlight(aged(SOURCE_DISPATCH_LEASE_MS + 1), undefined, now)).toBe(false);
  });

  it('releases a source whose attempt completed after the dispatch', () => {
    expect(isSourceDispatchInFlight(unacknowledged, acknowledged, now)).toBe(false);
  });

  it('keeps suppressing a source whose last attempt predates the dispatch', () => {
    expect(isSourceDispatchInFlight(unacknowledged, stale, now)).toBe(true);
  });

  it('ignores a missing or unparseable marker', () => {
    expect(isSourceDispatchInFlight(undefined, acknowledged, now)).toBe(false);
    expect(isSourceDispatchInFlight({ ...unacknowledged, dispatchedAt: 'not-a-timestamp' }, undefined, now)).toBe(false);
  });
});

describe('published cadence slips', () => {
  const slipped = { lastAttemptAt: new Date(now.getTime() - SOURCE_CADENCE_SLIP_MS - 1).toISOString() };
  const insideTwoCadences = { lastAttemptAt: new Date(now.getTime() - SOURCE_CADENCE_SLIP_MS).toISOString() };
  const backedOff = { ...slipped, backoffUntil: new Date(now.getTime() + 60_000).toISOString() };

  it('flags a published source whose attempt is older than two cadences', () => {
    expect(missedPublishedInterval('published', slipped, now)).toBe(true);
    expect(missedPublishedInterval('published', insideTwoCadences, now)).toBe(false);
  });

  it('does not flag a source that has never attempted, reported as never-succeeded instead', () => {
    expect(missedPublishedInterval('published', undefined, now)).toBe(false);
  });

  it('exempts paused, quarantined, and backed-off sources', () => {
    expect(missedPublishedInterval('published', { ...slipped, sourceStatus: 'paused' }, now)).toBe(false);
    expect(missedPublishedInterval('published', { ...slipped, state: 'quarantined' }, now)).toBe(false);
    expect(missedPublishedInterval('published', backedOff, now)).toBe(false);
  });

  it('exempts shadow sources', () => {
    expect(missedPublishedInterval('shadow', slipped, now)).toBe(false);
  });
});
