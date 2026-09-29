import { describe, expect, it, vi } from 'vitest';
import {
  identityCoverageFloor, newRecurringIdentitySourceIds, nextIdentityCoverageBaseline,
  recurringIdentitySourceIds,
} from '../cloudflare/identity-coverage-ratchet.js';
import { runScheduledPostingIdentityAudit } from '../cloudflare/worker.js';
import type { Environment } from '../cloudflare/worker.js';
import type { PostingIdentityRepairPlan } from '../src/posting-identity-repair.js';

/** A D1 stub holding only the two identity-monitoring baseline rows. */
function baselineDb(initial?: number, recurring?: string[]) {
  const writes: number[] = [];
  const recurrenceWrites: string[][] = [];
  const rows = new Map<string, string>();
  if (initial !== undefined) rows.set('IDENTITY#COVERAGE_BASELINE', JSON.stringify({ baseline: initial, updatedAt: '2026-09-17T00:00:00.000Z' }));
  if (recurring !== undefined) rows.set('IDENTITY#RECURRENCE_BASELINE', JSON.stringify({ sourceIds: recurring, updatedAt: '2026-09-17T00:00:00.000Z' }));
  const db = {
    prepare(query: string) {
      return {
        bind: (pk: string, _skOrKind: string, value?: string) => ({
          async first() { const stored = rows.get(pk); return stored === undefined ? null : { value: stored }; },
          async run() {
            if (!query.startsWith('INSERT') || typeof value !== 'string') return;
            rows.set(pk, value);
            const parsed = JSON.parse(value) as { baseline?: number; sourceIds?: string[] };
            if (typeof parsed.baseline === 'number') writes.push(parsed.baseline);
            if (parsed.sourceIds) recurrenceWrites.push(parsed.sourceIds);
          },
        }),
      };
    },
  };
  return {
    db, writes, recurrenceWrites,
    current: () => JSON.parse(rows.get('IDENTITY#COVERAGE_BASELINE') ?? '{}').baseline as number | undefined,
    currentRecurring: () => JSON.parse(rows.get('IDENTITY#RECURRENCE_BASELINE') ?? '{}').sourceIds as string[] | undefined,
  };
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
      IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'true',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => planWithCoverage(0.6), log: () => undefined }))
      .rejects.toThrow('integrity gate failed');
    expect(regression.writes).toEqual([]);

    const improvement = baselineDb(0.8);
    await expect(runScheduledPostingIdentityAudit({
      DB: improvement.db as unknown as Environment['DB'],
      IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'true',
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
      IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'true',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => planWithCoverage(0.789), log: () => undefined }))
      .rejects.toThrow('integrity gate failed');
  });

  it('passes a pass that stays inside the tolerance of its baseline', async () => {
    const steady = baselineDb(0.8);
    await expect(runScheduledPostingIdentityAudit({
      DB: steady.db as unknown as Environment['DB'],
      IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'true',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => planWithCoverage(0.799), log: () => undefined })).resolves.toMatchObject({
      status: 'passed', coverageRegression: false,
    });
  });

  it('seeds the durable recurrence inventory without paging on the existing backlog', async () => {
    const recurring = baselineDb(0.8);
    const alerts: Array<{ signals: string[] }> = [];
    await expect(runScheduledPostingIdentityAudit({
      DB: recurring.db as unknown as Environment['DB'],
      IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'false',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => ({
      ...planWithCoverage(0.8),
      unconfirmedSources: [{ sourceId: 'reviewed-community', occurrences: 3 }],
    }), log: () => undefined, alert: async (input) => { alerts.push(input); } })).resolves.toMatchObject({
      status: 'passed', recurringUnconfirmedSources: 1, newRecurringUnconfirmedSources: 0,
    });
    expect(alerts).toEqual([]);
    expect(recurring.currentRecurring()).toEqual(['reviewed-community']);
  });

  it('alerts only when a source newly crosses the recurrence threshold', async () => {
    const recurring = baselineDb(0.8, ['known-community']);
    const alerts: Array<{ signals: string[] }> = [];
    await expect(runScheduledPostingIdentityAudit({
      DB: recurring.db as unknown as Environment['DB'],
      IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'false',
      IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
    }, { audit: async () => ({
      ...planWithCoverage(0.8),
      unconfirmedSources: [
        { sourceId: 'known-community', occurrences: 40 },
        { sourceId: 'new-community', occurrences: 3 },
      ],
    }), log: () => undefined, alert: async (input) => { alerts.push(input); } })).resolves.toMatchObject({
      status: 'passed', recurringUnconfirmedSources: 2, newRecurringUnconfirmedSources: 1,
    });
    expect(alerts).toMatchObject([{
      signals: ['repeated-unconfirmed-identity-source'],
    }]);
    expect(recurring.currentRecurring()).toEqual(['known-community', 'new-community']);
  });

  it('does not advance the recurrence baseline when the alert cannot be delivered', async () => {
    const recurring = baselineDb(0.8, ['known-community']);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runScheduledPostingIdentityAudit({
        DB: recurring.db as unknown as Environment['DB'],
        IDENTITY_INTEGRITY_ENFORCEMENT_ENABLED: 'false',
        IDENTITY_CONFIRMED_COVERAGE_FLOOR: '0',
      }, { audit: async () => ({
        ...planWithCoverage(0.8),
        unconfirmedSources: [
          { sourceId: 'known-community', occurrences: 40 },
          { sourceId: 'new-community', occurrences: 3 },
        ],
      }), log: () => undefined, alert: async () => { throw new Error('Resend unavailable'); } })).resolves.toMatchObject({
        status: 'passed', newRecurringUnconfirmedSources: 1,
      });
      expect(recurring.currentRecurring()).toEqual(['known-community']);
      expect(error).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
    }
  });

  it('treats a resolved source that later recurs as a new regression', () => {
    expect(recurringIdentitySourceIds([
      { sourceId: 'one-off', occurrences: 2 },
      { sourceId: 'recurring', occurrences: 3 },
    ])).toEqual(['recurring']);
    expect(newRecurringIdentitySourceIds(['recurring'], [])).toEqual(['recurring']);
  });
});
