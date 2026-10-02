import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import { applyAdmissionReplay, planAdmissionReplay } from '../src/ingestion-v2/admission/operations.js';
import type { IngestionRowRecord, IngestionSnapshotRecord } from '../src/ingestion-v2/types.js';

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
  for (const file of ['0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
  }
  return { database, repository: new D1IngestionV2Repository(sqliteD1(database)) };
}

const SOURCE = 'community-example';
const HASH = 'a'.repeat(64);
const ADMISSION = 'standard-v1';

function snapshotRecord(): IngestionSnapshotRecord {
  return {
    sourceId: SOURCE, snapshotHash: HASH, objectKey: `ingestion-v2/snapshots/${SOURCE}/${HASH}.json`,
    admissionVersion: ADMISSION, documentCount: 1, rowCount: 3, state: 'active', isComplete: true, baseline: false,
    createdAt: '2026-10-01T00:00:00.000Z', activatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function row(externalId: string, overrides: Partial<IngestionRowRecord> = {}): IngestionRowRecord {
  return {
    sourceId: SOURCE, externalId, snapshotHash: HASH, materialHash: `m-${externalId}`, admissionVersion: ADMISSION,
    state: 'pending', attemptCount: 0, consecutiveOmissions: 0,
    firstObservedAt: '2026-10-01T00:00:00.000Z', lastObservedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

async function seeded(): Promise<{ database: DatabaseSync; repository: D1IngestionV2Repository }> {
  const context = subject();
  await context.repository.putSnapshot(snapshotRecord());
  await context.repository.putRows([row('a'), row('b'), row('c')]);
  return context;
}

describe('ingestion v2 admission ledger (D1)', () => {
  it('dispatches pending rows, records handoffs, and excludes fresh work', async () => {
    const { repository } = await seeded();
    const first = await planAdmissionV2Dispatch(SOURCE, { ledger: repository, now: () => new Date('2026-10-01T00:10:00.000Z') });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].externalIds).toEqual(['a', 'b', 'c']);
    expect((await repository.getRow(SOURCE, 'a'))?.state).toBe('queued');
    const handoffs = await repository.listActiveHandoffs(SOURCE, '2026-10-01T00:00:00.000Z');
    expect(handoffs).toHaveLength(1);
    const second = await planAdmissionV2Dispatch(SOURCE, { ledger: repository, now: () => new Date('2026-10-01T00:10:00.000Z') });
    expect(second.messages).toHaveLength(0);
  });

  it('acquires a lease atomically, refuses contention, and reclaims expiry', async () => {
    const { repository } = await seeded();
    const acquire = (owner: string, now: string) => repository.acquireLease({
      sourceId: SOURCE, externalId: 'a', owner, now, leaseMs: 60_000,
      expectedSnapshotHash: HASH, expectedMaterialHash: 'm-a', expectedAdmissionVersion: ADMISSION,
    });
    expect((await acquire('one', '2026-10-01T00:00:00.000Z')).outcome).toBe('acquired');
    expect((await acquire('two', '2026-10-01T00:00:30.000Z')).outcome).toBe('no-op');
    // After expiry another owner may claim it.
    expect((await acquire('two', '2026-10-01T00:02:00.000Z')).outcome).toBe('acquired');
    const reclaimed = await repository.reclaimExpiredLeases('2026-10-01T00:05:00.000Z', 10);
    expect(reclaimed.map((entry) => entry.externalId)).toEqual(['a']);
    expect((await repository.getRow(SOURCE, 'a'))?.state).toBe('queued');
  });

  it('rejects a stale message while another row still settles', async () => {
    const { repository } = await seeded();
    const stale = await repository.acquireLease({
      sourceId: SOURCE, externalId: 'a', owner: 'one', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
      expectedSnapshotHash: 'b'.repeat(64), expectedMaterialHash: 'm-a', expectedAdmissionVersion: ADMISSION,
    });
    expect(stale).toMatchObject({ outcome: 'no-op', reason: 'stale' });
  });

  it('settles, retries, quarantines, and reopens rows independently', async () => {
    const { repository } = await seeded();
    const lease = async (externalId: string) => repository.acquireLease({
      sourceId: SOURCE, externalId, owner: 'owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
      expectedSnapshotHash: HASH, expectedMaterialHash: `m-${externalId}`, expectedAdmissionVersion: ADMISSION,
    });
    await lease('a');
    await repository.settleRow({ sourceId: SOURCE, externalId: 'a', owner: 'owner', now: '2026-10-01T00:00:10.000Z', decision: 'admitted', jobId: 'JOB#1' });
    expect(await repository.getRow(SOURCE, 'a')).toMatchObject({ state: 'settled', decision: 'admitted', jobId: 'JOB#1', attemptCount: 1 });

    await lease('b');
    await repository.scheduleRowRetry({ sourceId: SOURCE, externalId: 'b', owner: 'owner', now: '2026-10-01T00:00:10.000Z', attemptCount: 1, retryAt: '2026-10-01T00:01:10.000Z', failure: { kind: 'row-transient', classification: 'destination-timeout', detail: 'timeout' } });
    expect(await repository.getRow(SOURCE, 'b')).toMatchObject({ state: 'queued', attemptCount: 1, retryAt: '2026-10-01T00:01:10.000Z', failureClass: 'destination-timeout' });

    await lease('c');
    await repository.quarantineRow({ sourceId: SOURCE, externalId: 'c', owner: 'owner', now: '2026-10-01T00:00:10.000Z', attemptCount: 3, failure: { kind: 'row-transient', classification: 'upstream-server-error', detail: '503' } });
    expect(await repository.getRow(SOURCE, 'c')).toMatchObject({ state: 'quarantined', attemptCount: 3, failureClass: 'upstream-server-error' });

    expect(await repository.reopenRows(SOURCE, ['c'], '2026-10-01T00:10:00.000Z', { admissionVersion: 'standard-v2' })).toBe(1);
    expect(await repository.getRow(SOURCE, 'c')).toMatchObject({ state: 'queued', attemptCount: 0, admissionVersion: 'standard-v2' });
  });

  it('releases a lease on a systemic failure without consuming a row attempt', async () => {
    const { repository } = await seeded();
    await repository.acquireLease({
      sourceId: SOURCE, externalId: 'b', owner: 'owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
      expectedSnapshotHash: HASH, expectedMaterialHash: 'm-b', expectedAdmissionVersion: ADMISSION,
    });
    await repository.releaseLease(SOURCE, 'b', 'owner', '2026-10-01T00:00:05.000Z');
    expect(await repository.getRow(SOURCE, 'b')).toMatchObject({ state: 'queued', attemptCount: 0 });
    // The released row is dispatchable again.
    expect((await repository.listDispatchableRows(SOURCE, '2026-10-01T00:00:06.000Z', 10)).map((row) => row.externalId)).toContain('b');
  });

  it('reports a source overview with oldest work and current snapshot', async () => {
    const { repository } = await seeded();
    const overview = await repository.overview(SOURCE);
    expect(overview).toMatchObject({ sourceId: SOURCE, pending: 3, currentSnapshotHash: HASH });
    expect(overview.oldestWorkAt).toBeDefined();
  });

  it('guards replay with a token bound to the previewed state', async () => {
    const { repository } = await seeded();
    await repository.acquireLease({
      sourceId: SOURCE, externalId: 'a', owner: 'owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
      expectedSnapshotHash: HASH, expectedMaterialHash: 'm-a', expectedAdmissionVersion: ADMISSION,
    });
    await repository.quarantineRow({
      sourceId: SOURCE, externalId: 'a', owner: 'owner', now: '2026-10-01T00:00:00.000Z', attemptCount: 3,
      failure: { kind: 'row-transient', classification: 'upstream-server-error', detail: '503' },
    });
    const preview = await planAdmissionReplay(repository, { sourceId: SOURCE, externalId: 'a' });
    expect(preview.eligible).toBe(true);
    const applied = await applyAdmissionReplay(repository, { sourceId: SOURCE, externalId: 'a', replayToken: preview.replayToken! });
    expect(applied.applied).toBe(true);
    expect((await repository.getRow(SOURCE, 'a'))?.state).toBe('queued');
    expect((await repository.overview(SOURCE)).queued).toBe(1);
  });
});
