import { describe, expect, it } from 'vitest';
import { identityCoverageFloor, nextIdentityCoverageBaseline } from '../cloudflare/identity-coverage-ratchet.js';
import { runScheduledPostingIdentityAudit } from '../cloudflare/worker.js';
import type { Environment } from '../cloudflare/worker.js';
import type { PostingIdentityRepairPlan } from '../src/posting-identity-repair.js';

/** A D1 stub holding only the baseline row: the ratchet's own read and write. */
function baselineDb(initial?: number) {
  const writes: number[] = [];
  let stored = initial === undefined ? undefined : JSON.stringify({ baseline: initial, updatedAt: '2026-09-17T00:00:00.000Z' });
  const db = {
    prepare() {
      return {
        bind: (_pk: string, _sk: string, value?: string) => ({
          async first() { return stored === undefined ? null : { value: stored }; },
          async run() { if (typeof value === 'string') { stored = value; writes.push(JSON.parse(value).baseline); } },
        }),
      };
    },
  };
  return { db, writes, current: () => (stored === undefined ? undefined : JSON.parse(stored).baseline as number) };
}

const passingGate = {
  passed: true, exactDuplicateGroups: 0, aliasConflicts: 0, untrackedQuarantines: 0,
  presentationBlockers: 0, legacyOccurrences: 0, projectionMismatches: 0,
  duplicateOccurrenceReferences: 0, danglingOccurrenceReferences: 0,
};

const planWithCoverage = (confirmedCoverage: number) => ({
  ...passingGate,
  occurrenceCounts: { confirmed: 8, unconfirmed: 2, legacy: 0, quarantined: 0, confirmedCoverage },
  duplicateAlertGroups: 0, duplicateJobs: 0, gate: passingGate,
}) as unknown as PostingIdentityRepairPlan;

describe('identity coverage ratchet', () => {
  it('keeps the configured backstop until a baseline exists', () => {
    expect(identityCoverageFloor(0.5, undefined)).toBe(0.5);
    expect(identityCoverageFloor(undefined, undefined)).toBe(0);
  });

  it('pads the floor by one percentage point of churn', () => {
    // 12,904 occurrence rows today, so one point absorbs roughly 130 rows of
    // ordinary movement. A backstop above the baseline still wins.
    expect(identityCoverageFloor(0, 0.8)).toBeCloseTo(0.79, 6);
    expect(identityCoverageFloor(0.95, 0.8)).toBe(0.95);
  });

  it('only ever raises the stored baseline', () => {
    expect(nextIdentityCoverageBaseline(undefined, 0.75)).toBe(0.75);
    expect(nextIdentityCoverageBaseline(0.8, 0.79)).toBe(0.8);
    expect(nextIdentityCoverageBaseline(0.8, 0.82)).toBe(0.82);
    expect(nextIdentityCoverageBaseline(0.8, null)).toBe(0.8);
  });

  it('fails a pass that falls below the baseline and passes one that improves it', async () => {
    const regression = baselineDb(0.8);
    await expect(runScheduledPostingIdentityAudit({
      DB: regression.db as unknown as Environment['DB'],
      IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'true',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => planWithCoverage(0.6), log: () => undefined }))
      .rejects.toThrow('integrity gate failed');
    expect(regression.writes).toEqual([]);

    const improvement = baselineDb(0.8);
    await expect(runScheduledPostingIdentityAudit({
      DB: improvement.db as unknown as Environment['DB'],
      IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'true',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => planWithCoverage(0.9), log: () => undefined })).resolves.toMatchObject({
      status: 'passed', confirmedCoverage: 0.9, coverageRegression: false,
    });
    expect(improvement.current()).toBe(0.9);
  });

  it('fails a pass that falls further than the padding below its baseline', async () => {
    const slipping = baselineDb(0.8);
    await expect(runScheduledPostingIdentityAudit({
      DB: slipping.db as unknown as Environment['DB'],
      IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'true',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => planWithCoverage(0.789), log: () => undefined }))
      .rejects.toThrow('integrity gate failed');
  });

  it('passes a pass that stays inside the tolerance of its baseline', async () => {
    const steady = baselineDb(0.8);
    await expect(runScheduledPostingIdentityAudit({
      DB: steady.db as unknown as Environment['DB'],
      IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'true',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => planWithCoverage(0.799), log: () => undefined })).resolves.toMatchObject({
      status: 'passed', coverageRegression: false,
    });
  });
});
