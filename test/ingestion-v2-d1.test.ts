import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { IngestionRowRecord, IngestionSnapshotRecord, ShadowComparisonMetrics } from '../src/ingestion-v2/types.js';

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(query).run(...values).changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function subject(): { database: DatabaseSync; repository: D1IngestionV2Repository } {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL('../cloudflare/migrations/0045_ingestion_v2.sql', import.meta.url), 'utf8'));
  return { database, repository: new D1IngestionV2Repository(sqliteD1(database)) };
}

function snapshot(overrides: Partial<IngestionSnapshotRecord> = {}): IngestionSnapshotRecord {
  return {
    sourceId: 'community-example',
    snapshotHash: 'a'.repeat(64),
    objectKey: `ingestion-v2/snapshots/community-example/${'a'.repeat(64)}.json`,
    admissionVersion: 'standard-v1',
    documentCount: 1,
    rowCount: 2,
    state: 'staged',
    isComplete: true,
    baseline: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function row(overrides: Partial<IngestionRowRecord> & { externalId: string }): IngestionRowRecord {
  return {
    sourceId: 'community-example',
    snapshotHash: 'a'.repeat(64),
    materialHash: 'm',
    admissionVersion: 'standard-v1',
    state: 'settled',
    decision: 'admitted',
    attemptCount: 0,
    consecutiveOmissions: 0,
    firstObservedAt: '2026-10-01T00:00:00.000Z',
    lastObservedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    settledAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ingestion v2 D1 repository', () => {
  it('upserts snapshots idempotently and never regresses a terminal state', async () => {
    const { repository } = subject();
    await repository.putSnapshot(snapshot());
    await repository.putSnapshot(snapshot({ state: 'active', activatedAt: '2026-10-01T01:00:00.000Z' }));
    expect(await repository.getSnapshot('community-example', 'a'.repeat(64))).toMatchObject({ state: 'active', baseline: false, isComplete: true });

    await repository.putSnapshot(snapshot({ state: 'terminal', terminalAt: '2026-10-02T00:00:00.000Z' }));
    await repository.putSnapshot(snapshot({ state: 'staged' }));
    expect(await repository.getSnapshot('community-example', 'a'.repeat(64))).toMatchObject({ state: 'terminal' });
  });

  it('activates only a staged snapshot', async () => {
    const { repository } = subject();
    await repository.putSnapshot(snapshot());
    await repository.activateSnapshot('community-example', 'a'.repeat(64), '2026-10-01T01:00:00.000Z');
    expect(await repository.getSnapshot('community-example', 'a'.repeat(64))).toMatchObject({ state: 'active', activatedAt: '2026-10-01T01:00:00.000Z' });
    // A second activation is a no-op.
    await repository.activateSnapshot('community-example', 'a'.repeat(64), '2026-10-01T02:00:00.000Z');
    expect(await repository.getSnapshot('community-example', 'a'.repeat(64))).toMatchObject({ activatedAt: '2026-10-01T01:00:00.000Z' });
  });

  it('upserts rows idempotently, preserving first observation', async () => {
    const { repository } = subject();
    await repository.putRows([row({ externalId: 'a', lastObservedAt: '2026-10-01T00:00:00.000Z' })]);
    await repository.putRows([row({ externalId: 'a', lastObservedAt: '2026-10-02T00:00:00.000Z', firstObservedAt: '2030-01-01T00:00:00.000Z' })]);
    const stored = await repository.getRow('community-example', 'a');
    expect(stored).toMatchObject({ firstObservedAt: '2026-10-01T00:00:00.000Z', lastObservedAt: '2026-10-02T00:00:00.000Z' });
  });

  it('applies omission increments and closes at two', async () => {
    const { repository } = subject();
    await repository.putRows([row({ externalId: 'a' }), row({ externalId: 'b' })]);
    await repository.applyOmissions('community-example', [
      { externalId: 'a', consecutiveOmissions: 1, becomesAbsent: false },
      { externalId: 'b', consecutiveOmissions: 2, becomesAbsent: true },
    ], '2026-10-02T00:00:00.000Z');
    expect(await repository.getRow('community-example', 'a')).toMatchObject({ consecutiveOmissions: 1, state: 'settled' });
    expect(await repository.getRow('community-example', 'b')).toMatchObject({ consecutiveOmissions: 2, state: 'absent' });
  });

  it('never lets a shadow upsert clobber admission-lane row state', async () => {
    const { repository } = subject();
    await repository.putRows([
      row({ externalId: 'leased', state: 'processing', decision: undefined, attemptCount: 2, leaseOwner: 'worker', leaseExpiresAt: '2026-10-01T01:00:00.000Z' }),
      row({ externalId: 'queued', state: 'queued', decision: undefined, attemptCount: 1, retryAt: '2026-10-01T00:10:00.000Z' }),
      row({ externalId: 'quarantined', state: 'quarantined', decision: 'blocked', attemptCount: 3, failureClass: 'upstream-server-error' }),
      row({ externalId: 'settled', state: 'settled', decision: 'admitted' }),
    ]);
    // A shadow discovery upsert for the same board, all projected `settled`.
    await repository.putRows([
      row({ externalId: 'leased', state: 'settled', decision: 'admitted', attemptCount: 0, lastObservedAt: '2026-10-02T00:00:00.000Z' }),
      row({ externalId: 'queued', state: 'settled', decision: 'admitted', attemptCount: 0, lastObservedAt: '2026-10-02T00:00:00.000Z' }),
      row({ externalId: 'quarantined', state: 'settled', decision: 'admitted', attemptCount: 0, lastObservedAt: '2026-10-02T00:00:00.000Z' }),
      row({ externalId: 'settled', state: 'settled', decision: 'blocked', lastObservedAt: '2026-10-02T00:00:00.000Z' }),
    ]);
    expect(await repository.getRow('community-example', 'leased')).toMatchObject({
      state: 'processing', attemptCount: 2, leaseOwner: 'worker', leaseExpiresAt: '2026-10-01T01:00:00.000Z',
    });
    expect(await repository.getRow('community-example', 'queued')).toMatchObject({
      state: 'queued', attemptCount: 1, retryAt: '2026-10-01T00:10:00.000Z',
    });
    expect(await repository.getRow('community-example', 'quarantined')).toMatchObject({
      state: 'quarantined', decision: 'blocked', attemptCount: 3, failureClass: 'upstream-server-error',
    });
    // A settled row is discovery-owned: its state and decision may be refreshed.
    expect(await repository.getRow('community-example', 'settled')).toMatchObject({
      state: 'settled', decision: 'blocked', lastObservedAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('leaves an in-flight row untouched when it drops off the board', async () => {
    const { repository } = subject();
    await repository.putRows([
      row({ externalId: 'leased', state: 'processing', decision: undefined, leaseOwner: 'worker', leaseExpiresAt: '2026-10-01T01:00:00.000Z' }),
      row({ externalId: 'idle' }),
    ]);
    await repository.applyOmissions('community-example', [
      { externalId: 'leased', consecutiveOmissions: 1, becomesAbsent: false },
      { externalId: 'idle', consecutiveOmissions: 1, becomesAbsent: false },
    ], '2026-10-02T00:00:00.000Z');
    expect(await repository.getRow('community-example', 'leased')).toMatchObject({
      state: 'processing', consecutiveOmissions: 0, leaseOwner: 'worker',
    });
    expect(await repository.getRow('community-example', 'idle')).toMatchObject({
      state: 'settled', consecutiveOmissions: 1,
    });
  });

  it('reports whether a guarded lane write applied', async () => {
    const { repository } = subject();
    await repository.putRows([row({ externalId: 'a' })]);
    // Not leased, so every guarded write is refused.
    expect(await repository.settleRow({ sourceId: 'community-example', externalId: 'a', owner: 'x', now: '2026-10-01T00:00:00.000Z', decision: 'admitted' })).toBe(false);
    expect(await repository.scheduleRowRetry({ sourceId: 'community-example', externalId: 'a', owner: 'x', now: '2026-10-01T00:00:00.000Z', attemptCount: 1, retryAt: '2026-10-01T00:01:00.000Z', failure: { kind: 'row-transient', classification: 'destination-timeout', detail: 't' } })).toBe(false);
    expect(await repository.quarantineRow({ sourceId: 'community-example', externalId: 'a', owner: 'x', now: '2026-10-01T00:00:00.000Z', attemptCount: 3, failure: { kind: 'row-transient', classification: 'upstream-server-error', detail: '5' } })).toBe(false);
    expect(await repository.releaseLease('community-example', 'a', 'x', '2026-10-01T00:00:00.000Z')).toBe(false);
    await repository.putRows([row({ externalId: 'b', state: 'processing', decision: undefined, leaseOwner: 'x', leaseExpiresAt: '2026-10-01T01:00:00.000Z' })]);
    expect(await repository.releaseLease('community-example', 'b', 'x', '2026-10-01T00:00:00.000Z')).toBe(true);
  });

  it('pages rows by observation order', async () => {
    const { repository } = subject();
    await repository.putRows([
      row({ externalId: 'a', lastObservedAt: '2026-10-01T00:00:00.000Z' }),
      row({ externalId: 'b', lastObservedAt: '2026-10-02T00:00:00.000Z' }),
      row({ externalId: 'c', lastObservedAt: '2026-10-03T00:00:00.000Z' }),
    ]);
    const first = await repository.listRowsPage('community-example', { limit: 2 });
    expect(first.rows.map((entry) => entry.externalId)).toEqual(['a', 'b']);
    expect(first.cursor).toBeDefined();
    const second = await repository.listRowsPage('community-example', { limit: 2, cursor: first.cursor });
    expect(second.rows.map((entry) => entry.externalId)).toEqual(['c']);
    expect(second.cursor).toBeUndefined();
  });

  it('selects bounded due work, stale policy, expired leases, and snapshot rows', async () => {
    const { repository } = subject();
    await repository.putRows([
      row({ externalId: 'due', state: 'pending', decision: undefined, retryAt: '2026-10-01T00:00:00.000Z' }),
      row({ externalId: 'future', state: 'pending', decision: undefined, retryAt: '2026-11-01T00:00:00.000Z' }),
      row({ externalId: 'settled', state: 'settled' }),
      row({ externalId: 'stale', admissionVersion: 'old-v1' }),
      row({ externalId: 'leased', state: 'processing', decision: undefined, leaseOwner: 'worker', leaseExpiresAt: '2026-09-30T00:00:00.000Z' }),
    ]);
    const due = (await repository.listDueWork('community-example', '2026-10-01T00:00:00.000Z', 10)).map((entry) => entry.externalId);
    expect(due).toContain('due');
    expect(due).not.toContain('future');
    expect(due).not.toContain('settled');
    expect((await repository.listStalePolicyRows('community-example', 'standard-v1', 10)).map((entry) => entry.externalId)).toEqual(['stale']);
    expect((await repository.listExpiredLeases('2026-10-01T00:00:00.000Z', 10)).map((entry) => entry.externalId)).toEqual(['leased']);
    expect((await repository.listRowsForSnapshot('a'.repeat(64), 10)).map((entry) => entry.externalId)).toContain('settled');
  });

  it('stores and increments shadow comparison counters', async () => {
    const { database, repository } = subject();
    const metrics: ShadowComparisonMetrics = {
      sourceId: 'community-example',
      snapshotHash: 'a'.repeat(64),
      admissionVersion: 'standard-v1',
      complete: true,
      observedAt: '2026-10-01T00:00:00.000Z',
      durationMs: 5,
      counts: { total: 2, new: 1, changed: 0, stalePolicy: 0, retryable: 0, unchanged: 1, reappeared: 0, missing: 0 },
      v2Actionable: { count: 1, samples: ['a'] },
      legacyActionable: { count: 1, samples: ['a'] },
      v2Only: { count: 0, samples: [] },
      legacyOnly: { count: 0, samples: [] },
      d1RowsRead: 0,
      d1RowsWritten: 4,
      r2Bytes: 128,
      status: 'complete',
    };
    await repository.putShadowComparison(metrics);
    await repository.putShadowComparison(metrics);
    const stored = await repository.getShadowComparison('community-example');
    expect(stored).toMatchObject({ snapshotHash: 'a'.repeat(64), counts: { total: 2 } });
    expect((await repository.listShadowComparisons()).length).toBe(1);
    const { run_count: runCount } = database.prepare(
      'SELECT run_count FROM ingestion_v2_shadow_comparisons WHERE source_id = ?',
    ).get('community-example') as { run_count: number };
    expect(runCount).toBe(2);
  });
});
