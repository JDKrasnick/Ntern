import { describe, expect, it } from 'vitest';
import { ApplicationLinkValidationError, failedSourceHealth, sourceFailureCategory, sourceFailureOutcome, successfulSourceHealth } from '../src/source-health.js';
import { SourceFetchError } from '../src/sources/source-error.js';

describe('source health', () => {
  it('keeps temporary transport failures degraded and retains the last success', () => {
    const previous = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      eligibleRows: 2,
    });
    const health = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      previous,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:02.000Z',
      error: new SourceFetchError('request timed out', 'transport'),
    });
    expect(health).toMatchObject({
      state: 'degraded',
      lastSuccessAt: '2026-07-29T12:00:01.000Z',
      consecutiveFailures: 1,
      failureCategory: 'transport',
      outcome: 'temporary_provider_error',
      backoffUntil: '2026-07-29T12:11:02.000Z',
    });
  });

  it('quarantines deterministic schema failures immediately', () => {
    const health = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      error: new SourceFetchError('response shape was invalid', 'json'),
    });
    expect(health.state).toBe('quarantined');
    expect(health.sourceStatus).toBe('paused');
    expect(health.quarantineReason).toContain('shape');
  });

  it('quarantines an explicit trusted-source circuit breach immediately', () => {
    const health = failedSourceHealth({
      sourceId: 'simplify-summer-2026',
      startedAt: '2026-09-04T12:00:00.000Z',
      completedAt: '2026-09-04T12:00:01.000Z',
      error: new SourceFetchError('trusted-community circuit breaker', 'quality', undefined, undefined, true),
    });
    expect(health).toMatchObject({ state: 'quarantined', consecutiveFailures: 1, incidentSeverity: 'high' });
  });

  it('requires repeated link-health failures before source quarantine', () => {
    const first = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      error: new Error('2/3 eligible Greenhouse application links failed validation'),
    });
    const second = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      previous: first,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:01.000Z',
      error: new Error('2/3 eligible Greenhouse application links failed validation'),
    });
    expect(sourceFailureCategory(new Error('application link timed out'))).toBe('link');
    expect(first.state).toBe('degraded');
    expect(second.state).toBe('quarantined');
    expect(second.recentRuns).toHaveLength(2);
  });

  it('treats a body-capacity failure as a resource limit and quarantines only the repeat', () => {
    const error = new SourceFetchError(
      'greenhouse-acmerobotics: Greenhouse response body exceeds 16777216 bytes',
      'capacity',
    );
    expect(sourceFailureOutcome(error)).toBe('resource_limit');
    const first = failedSourceHealth({
      sourceId: 'greenhouse-acmerobotics',
      startedAt: '2026-09-16T12:00:00.000Z',
      completedAt: '2026-09-16T12:00:01.000Z',
      error,
    });
    const second = failedSourceHealth({
      sourceId: 'greenhouse-acmerobotics',
      previous: first,
      startedAt: '2026-09-16T12:10:00.000Z',
      completedAt: '2026-09-16T12:10:01.000Z',
      error,
    });
    expect(first).toMatchObject({
      state: 'degraded',
      sourceStatus: 'active',
      failureCategory: 'capacity',
      outcome: 'resource_limit',
      consecutiveFailures: 1,
      backoffUntil: '2026-09-16T12:01:01.000Z',
    });
    expect(second).toMatchObject({ state: 'quarantined', sourceStatus: 'paused', consecutiveFailures: 2 });
    expect(second.quarantineReason).toContain('response body exceeds');
    expect(second.recentRuns).toHaveLength(2);
  });

  it('persists only bounded, redacted application-link failure samples', () => {
    const error = new ApplicationLinkValidationError('Lever', 6, 8, Array.from({ length: 7 }, (_, index) => ({
      category: 'link' as const,
      diagnostic: `https://secret.example/${index}?token=private applicant${index}@example.com`,
    })));
    const health = failedSourceHealth({
      sourceId: 'lever-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      error,
    });
    expect(health.applicationLinkFailureSamples).toHaveLength(5);
    expect(JSON.stringify(health.applicationLinkFailureSamples)).not.toContain('secret.example');
    expect(JSON.stringify(health.applicationLinkFailureSamples)).not.toContain('applicant');
  });

  it('returns a quarantined source to healthy after a clean run', () => {
    const quarantined = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      error: new SourceFetchError('malformed JSON', 'json'),
    });
    const recovered = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      previous: quarantined,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:01.000Z',
      rawRows: 4,
      eligibleRows: 1,
    });
    expect(recovered).toMatchObject({ state: 'healthy', sourceStatus: 'paused', consecutiveFailures: 0, rawRows: 4, eligibleRows: 1 });
  });

  it('keeps a quarantined source quarantined when a forced recovery fails transiently', () => {
    const quarantined = failedSourceHealth({
      sourceId: 'github-pitt-csc',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      error: new SourceFetchError('malformed JSON', 'json'),
    });
    const failedRecovery = failedSourceHealth({
      sourceId: 'github-pitt-csc',
      previous: quarantined,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:01.000Z',
      error: new SourceFetchError('request timed out', 'transport'),
    });
    expect(failedRecovery).toMatchObject({
      state: 'quarantined',
      sourceStatus: 'paused',
      consecutiveFailures: 2,
      quarantinedAt: quarantined.quarantinedAt,
      quarantineReason: quarantined.quarantineReason,
      lastSafeDiagnostic: 'request timed out',
      recentRuns: expect.arrayContaining([expect.objectContaining({ diagnostic: 'request timed out' })]),
    });
  });

  it('promotes an automatically quiet source when eligible roles appear', () => {
    const quiet = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      eligibleRows: 0,
    });
    const promoted = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      previous: quiet,
      startedAt: '2026-07-29T18:00:00.000Z',
      completedAt: '2026-07-29T18:00:01.000Z',
      eligibleRows: 2,
    });

    expect(quiet).toMatchObject({ pollTier: 'quiet', pollTierMode: 'automatic' });
    expect(promoted).toMatchObject({ pollTier: 'active', pollTierMode: 'automatic' });
  });

  it('preserves an operator cadence override when source volume changes', () => {
    const previous = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
      eligibleRows: 0,
    });
    const updated = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      previous: { ...previous, pollTier: 'quiet', pollTierMode: 'operator' },
      startedAt: '2026-07-29T18:00:00.000Z',
      completedAt: '2026-07-29T18:00:01.000Z',
      eligibleRows: 2,
    });

    expect(updated).toMatchObject({ pollTier: 'quiet', pollTierMode: 'operator' });
  });

  it('lets current registry identity replace stale persisted identity', () => {
    const previous = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      provider: 'retired-provider',
      region: 'retired-region',
      startedAt: '2026-07-29T12:00:00.000Z',
      completedAt: '2026-07-29T12:00:01.000Z',
    });

    const successful = successfulSourceHealth({
      sourceId: 'greenhouse-acme',
      provider: 'greenhouse',
      region: 'unknown',
      previous,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:01.000Z',
    });
    const failed = failedSourceHealth({
      sourceId: 'greenhouse-acme',
      provider: 'greenhouse',
      region: 'unknown',
      previous,
      startedAt: '2026-07-29T12:10:00.000Z',
      completedAt: '2026-07-29T12:10:01.000Z',
      error: new SourceFetchError('request timed out', 'transport'),
    });

    expect(successful).toMatchObject({ provider: 'greenhouse', region: 'unknown' });
    expect(failed).toMatchObject({ provider: 'greenhouse', region: 'unknown' });
  });
});
