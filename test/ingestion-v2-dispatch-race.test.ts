import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import type { IngestionRowRecord } from '../src/ingestion-v2/types.js';

const sourceId = 'dispatch-race';
const now = '2026-10-04T00:00:00.000Z';
const hash = 'a'.repeat(64);
const future = '2026-10-04T00:01:00.000Z';

function row(externalId: string, overrides: Partial<IngestionRowRecord> = {}): IngestionRowRecord {
  return {
    sourceId, externalId, snapshotHash: hash, materialHash: 'material', admissionVersion: 'v1',
    state: 'pending', notificationBaseline: false, attemptCount: 0, consecutiveOmissions: 0,
    firstObservedAt: now, lastObservedAt: now, updatedAt: now, ...overrides,
  };
}

function intent(externalId: string) {
  return { sourceId, externalId, snapshotHash: hash, materialHash: 'material', admissionVersion: 'v1', now };
}

function lease(externalId: string, owner = 'consumer-A') {
  return {
    sourceId, externalId, owner, now, leaseMs: 60_000,
    expectedSnapshotHash: hash, expectedMaterialHash: 'material', expectedAdmissionVersion: 'v1',
  };
}

function harness() {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql', '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql', '0049_ingestion_v2_cost_windows.sql', '0050_ingestion_v2_omission_closure.sql', '0051_ingestion_v2_qualification_cadence.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(query).run(...values).changes) } }; },
  });
  const batchSizes: number[] = [];
  const d1: D1Database = {
    prepare: (query) => prepared(query),
    async batch(statements) {
      batchSizes.push(statements.length);
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
  return { database, batchSizes, repository: new D1IngestionV2Repository(d1) };
}

describe('guarded dispatcher marking', () => {
  it('rejects stale identities, future retries, active leases and nondispatchable states without changing them', async () => {
    const { database, repository } = harness();
    try {
      const rejected = [
        row('snapshot', { snapshotHash: 'b'.repeat(64) }),
        row('material', { materialHash: 'replacement' }),
        row('policy', { admissionVersion: 'v2' }),
        row('retry', { retryAt: future, attemptCount: 1 }),
        row('pending-lease', { leaseOwner: 'A', leaseExpiresAt: future }),
        row('queued-lease', { state: 'queued', leaseOwner: 'A', leaseExpiresAt: future }),
        row('processing-expired', { state: 'processing', leaseOwner: 'A', leaseExpiresAt: now }),
        row('settled', { state: 'settled' }), row('quarantined', { state: 'quarantined' }),
        row('absent', { state: 'absent' }), row('omitted', { consecutiveOmissions: 2 }),
      ];
      await repository.putRows(rejected);
      const before = await Promise.all(rejected.map((entry) => repository.getRow(sourceId, entry.externalId)));
      expect(await repository.markQueued(rejected.map((entry) => intent(entry.externalId)))).toEqual([]);
      expect(await Promise.all(rejected.map((entry) => repository.getRow(sourceId, entry.externalId)))).toEqual(before);
      expect(await repository.markQueued([])).toEqual([]);
    } finally { database.close(); }
  });

  it('returns only successful intents across bounded batches and accepts deadlines exactly at now', async () => {
    const { database, repository, batchSizes } = harness();
    try {
      const rows = Array.from({ length: 105 }, (_, index) => row(String(index), {
        state: index % 2 ? 'queued' : 'pending', retryAt: index === 52 ? future : now,
        leaseExpiresAt: now, leaseOwner: 'expired',
      }));
      await repository.putRows(rows);
      batchSizes.length = 0;
      const marked = await repository.markQueued(rows.map((entry) => intent(entry.externalId)));
      expect(marked.map((entry) => entry.externalId)).toEqual(rows.filter((entry) => entry.externalId !== '52').map((entry) => entry.externalId));
      expect(batchSizes.length).toBeGreaterThan(1);
      expect(Math.max(...batchSizes)).toBeLessThanOrEqual(50);
      expect(await repository.getRow(sourceId, '52')).toMatchObject({ retryAt: future, leaseOwner: 'expired' });
      const successful = await repository.getRow(sourceId, '0');
      expect(successful?.state).toBe('queued');
      expect(successful?.retryAt).toBeUndefined();
      expect(successful?.leaseOwner).toBeUndefined();
    } finally { database.close(); }
  });

  it.each(['claim', 'all-claimed', 'retry', 'snapshot', 'material', 'policy'] as const)('excludes a %s race after selection from messages and durable handoffs', async (race) => {
    const { database, repository } = harness();
    try {
      await repository.putSnapshot({
        sourceId, snapshotHash: hash, objectKey: `ingestion-v2/snapshots/${sourceId}/${hash}.json`,
        admissionVersion: 'v1', documentCount: 1, rowCount: 2, state: 'active',
        isComplete: true, baseline: false, createdAt: now, activatedAt: now,
      });
      await repository.putRows([row('raced'), row('safe')]);
      let selected!: () => void;
      const selectedPromise = new Promise<void>((resolve) => { selected = resolve; });
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => { resume = resolve; });
      const getSnapshot = repository.getSnapshot.bind(repository);
      vi.spyOn(repository, 'getSnapshot').mockImplementation(async (...args) => {
        selected();
        await gate;
        return getSnapshot(...args);
      });
      const dispatch = planAdmissionV2Dispatch(sourceId, { ledger: repository, now: () => new Date(now) });
      await selectedPromise;
      if (race === 'claim' || race === 'all-claimed' || race === 'retry') {
        expect((await repository.acquireLease(lease('raced'))).outcome).toBe('acquired');
        if (race === 'claim' || race === 'all-claimed') {
          expect(await repository.claimRowEffect(lease('raced'))).toBe(true);
          if (race === 'all-claimed') expect((await repository.acquireLease(lease('safe'))).outcome).toBe('acquired');
        } else {
          expect(await repository.scheduleRowRetry({
            ...lease('raced'), attemptCount: 1, retryAt: future,
            failure: { kind: 'row-transient', classification: 'destination-timeout', detail: 'timeout' },
          })).toBe(true);
        }
      } else {
        await repository.putRows([row('raced', {
          ...(race === 'snapshot' ? { snapshotHash: 'b'.repeat(64) } : {}),
          ...(race === 'material' ? { materialHash: 'replacement' } : {}),
          ...(race === 'policy' ? { admissionVersion: 'v2' } : {}),
        })]);
      }
      const before = await repository.getRow(sourceId, 'raced');
      const effectBefore = database.prepare('SELECT effect_claimed_at FROM ingestion_rows WHERE external_id = ?').get('raced');
      resume();
      const plan = await dispatch;
      const expectedIds = race === 'all-claimed' ? [] : ['safe'];
      expect(plan.messages.flatMap((message) => message.externalIds)).toEqual(expectedIds);
      expect((await repository.listActiveHandoffs(sourceId, '2026-10-03T00:00:00.000Z')).flatMap((handoff) => handoff.externalIds)).toEqual(expectedIds);
      expect(await repository.getRow(sourceId, 'raced')).toEqual(before);
      expect(database.prepare('SELECT effect_claimed_at FROM ingestion_rows WHERE external_id = ?').get('raced')).toEqual(effectBefore);
      if (race === 'claim' || race === 'all-claimed') expect(await repository.acquireLease(lease('raced', 'consumer-B'))).toMatchObject({ outcome: 'no-op', reason: 'leased' });
      if (race === 'retry') expect(await repository.acquireLease(lease('raced', 'consumer-B'))).toMatchObject({ outcome: 'no-op', reason: 'retry-not-due' });
    } finally { database.close(); }
  });
});
