import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { processAdmissionV2Message } from '../src/ingestion-v2/admission/consumer.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import { migrateAdmissionPolicy } from '../src/ingestion-v2/admission/migration.js';
import { applyAdmissionReplay, planAdmissionReplay } from '../src/ingestion-v2/admission/operations.js';
import type { IngestionRowRecord, IngestionSnapshotObjectStore, IngestionSnapshotRecord } from '../src/ingestion-v2/types.js';

interface D1OperationMetrics {
  reads: number;
  writes: number;
  batches: number;
}

function sqliteD1(database: DatabaseSync, metrics?: D1OperationMetrics): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { if (metrics) metrics.reads += 1; return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { if (metrics) metrics.reads += 1; return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { if (metrics) metrics.writes += 1; return { meta: { changes: Number(database.prepare(query).run(...values).changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      if (metrics) metrics.batches += 1;
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

function subject(metrics?: D1OperationMetrics): { database: DatabaseSync; repository: D1IngestionV2Repository } {
  const database = new DatabaseSync(':memory:');
  for (const file of ['0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql', '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql', '0049_ingestion_v2_cost_windows.sql', '0050_ingestion_v2_omission_closure.sql', '0051_ingestion_v2_qualification_cadence.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
  }
  return { database, repository: new D1IngestionV2Repository(sqliteD1(database, metrics)) };
}

const SOURCE = 'community-example';
const HASH = 'a'.repeat(64);
const ADMISSION = 'standard-v1';
const expectedIdentity = (externalId: string) => ({
  expectedSnapshotHash: HASH,
  expectedMaterialHash: `m-${externalId}`,
  expectedAdmissionVersion: ADMISSION,
});

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
    notificationBaseline: false, state: 'pending', attemptCount: 0, consecutiveOmissions: 0,
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
  it('records bounded D1 reads and writes for a largest-allowed 25-row delivery', async () => {
    const metrics: D1OperationMetrics = { reads: 0, writes: 0, batches: 0 };
    const { repository } = subject(metrics);
    const ids = Array.from({ length: 25 }, (_, index) => `resource-${String(index).padStart(2, '0')}`);
    await repository.putSnapshot({ ...snapshotRecord(), rowCount: ids.length });
    await repository.putRows(ids.map((externalId) => row(externalId, { state: 'queued' })));
    metrics.reads = 0;
    metrics.writes = 0;
    metrics.batches = 0;
    const snapshot = {
      schemaVersion: 1 as const,
      sourceId: SOURCE,
      snapshotHash: HASH,
      admissionVersion: ADMISSION,
      documentCount: 1,
      rowCount: ids.length,
      observedAt: '2026-10-01T00:00:00.000Z',
      rows: ids.map((externalId) => ({
        externalId,
        document: 'board',
        row: 1,
        materialHash: `m-${externalId}`,
        firstObservationEligible: true,
        posting: {
          sourceId: SOURCE,
          externalId,
          document: 'board',
          row: 1,
          provenance: 'reviewed-community' as const,
          sourceUrl: 'https://example.com/board',
          applyUrl: `https://jobs.example.com/${externalId}`,
          employer: { id: 'acme', name: 'Acme', authority: 'source-row' as const },
          title: 'Software Engineering Intern',
          locations: ['Remote'],
          content: [],
          lifecycleAuthority: 'posting' as const,
          sourceState: 'open' as const,
          fetchedAt: '2026-10-01T00:00:00.000Z',
        },
      })),
    };
    const [message] = (await import('../src/ingestion-v2/admission/message.js')).buildAdmissionV2Messages({
      sourceId: SOURCE,
      snapshotHash: HASH,
      snapshotKey: snapshotRecord().objectKey,
      admissionVersion: ADMISSION,
      baseline: false,
      externalIds: ids,
    });
    const result = await processAdmissionV2Message(message, {
      ledger: repository,
      snapshots: { async getSnapshot() { return snapshot; } } as unknown as IngestionSnapshotObjectStore,
      evaluator: { async evaluate() { return { decision: { kind: 'admitted' as const } }; } },
    });
    expect(result).toMatchObject({ acknowledged: true, settled: 25 });
    expect(metrics.reads).toBe(26);
    expect(metrics.writes).toBe(50);
    expect(metrics.batches).toBe(0);
  });

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

  it('cannot settle changed material through a lease for the prior identity', async () => {
    const { repository } = await seeded();
    await repository.acquireLease({
      sourceId: SOURCE, externalId: 'a', owner: 'old-owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
      ...expectedIdentity('a'),
    });
    await repository.putRows([row('a', {
      snapshotHash: 'b'.repeat(64), materialHash: 'm-a-v2', admissionVersion: 'standard-v2',
      state: 'settled', notificationBaseline: false, lastObservedAt: '2026-10-01T00:00:10.000Z', updatedAt: '2026-10-01T00:00:10.000Z',
    })]);

    expect(await repository.settleRow({
      sourceId: SOURCE, externalId: 'a', owner: 'old-owner', now: '2026-10-01T00:00:20.000Z',
      ...expectedIdentity('a'), decision: 'blocked', reason: 'decision-for-old-material',
    })).toBe(false);
    expect(await repository.getRow(SOURCE, 'a')).toMatchObject({
      snapshotHash: 'b'.repeat(64), materialHash: 'm-a-v2', admissionVersion: 'standard-v2', state: 'settled',
    });

    await repository.reopenRows(SOURCE, ['a'], '2026-10-01T00:02:00.000Z');
    const reclaimed = await repository.getRow(SOURCE, 'a');
    expect(reclaimed).toMatchObject({ state: 'queued' });
    expect(reclaimed?.decision).toBeUndefined();
    const lease = await repository.acquireLease({
      sourceId: SOURCE, externalId: 'a', owner: 'new-owner', now: '2026-10-01T00:02:01.000Z', leaseMs: 60_000,
      expectedSnapshotHash: 'b'.repeat(64), expectedMaterialHash: 'm-a-v2', expectedAdmissionVersion: 'standard-v2',
    });
    expect(lease.outcome).toBe('acquired');
    expect(await repository.settleRow({
      sourceId: SOURCE, externalId: 'a', owner: 'new-owner', now: '2026-10-01T00:02:02.000Z',
      expectedSnapshotHash: 'b'.repeat(64), expectedMaterialHash: 'm-a-v2', expectedAdmissionVersion: 'standard-v2',
      decision: 'admitted', jobId: 'JOB#V2',
    })).toBe(true);
    expect(await repository.getRow(SOURCE, 'a')).toMatchObject({ state: 'settled', decision: 'admitted', jobId: 'JOB#V2' });
  });

  it('settles, retries, quarantines, and reopens rows independently', async () => {
    const { repository } = await seeded();
    const lease = async (externalId: string) => repository.acquireLease({
      sourceId: SOURCE, externalId, owner: 'owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
      expectedSnapshotHash: HASH, expectedMaterialHash: `m-${externalId}`, expectedAdmissionVersion: ADMISSION,
    });
    await lease('a');
    await repository.settleRow({ sourceId: SOURCE, externalId: 'a', owner: 'owner', now: '2026-10-01T00:00:10.000Z', ...expectedIdentity('a'), decision: 'admitted', jobId: 'JOB#1' });
    expect(await repository.getRow(SOURCE, 'a')).toMatchObject({ state: 'settled', decision: 'admitted', jobId: 'JOB#1', attemptCount: 1 });

    await lease('b');
    await repository.scheduleRowRetry({ sourceId: SOURCE, externalId: 'b', owner: 'owner', now: '2026-10-01T00:00:10.000Z', ...expectedIdentity('b'), attemptCount: 1, retryAt: '2026-10-01T00:01:10.000Z', failure: { kind: 'row-transient', classification: 'destination-timeout', detail: 'timeout' } });
    expect(await repository.getRow(SOURCE, 'b')).toMatchObject({ state: 'queued', attemptCount: 1, retryAt: '2026-10-01T00:01:10.000Z', failureClass: 'destination-timeout' });

    await lease('c');
    await repository.quarantineRow({ sourceId: SOURCE, externalId: 'c', owner: 'owner', now: '2026-10-01T00:00:10.000Z', ...expectedIdentity('c'), attemptCount: 3, failure: { kind: 'row-transient', classification: 'upstream-server-error', detail: '503' } });
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

  it('regrades stale settled rows to the current policy version and leaves peers visible', async () => {
    const { repository } = await seeded();
    for (const externalId of ['a', 'b']) {
      await repository.acquireLease({
        sourceId: SOURCE, externalId, owner: 'owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
        expectedSnapshotHash: HASH, expectedMaterialHash: `m-${externalId}`, expectedAdmissionVersion: ADMISSION,
      });
      await repository.settleRow({ sourceId: SOURCE, externalId, owner: 'owner', now: '2026-10-01T00:00:10.000Z', ...expectedIdentity(externalId), decision: 'admitted', ...(externalId === 'a' ? { jobId: 'JOB#A' } : {}) });
    }
    const result = await migrateAdmissionPolicy(SOURCE, 'standard-v2', { ledger: repository, now: () => new Date('2026-10-01T01:00:00.000Z') });
    expect(result).toMatchObject({ reopened: 2, remaining: false });
    // The migrated row keeps its existing job identity, so it stays visible and
    // cannot mint a duplicate new-role notification.
    expect(await repository.getRow(SOURCE, 'a')).toMatchObject({ state: 'queued', admissionVersion: 'standard-v2', attemptCount: 0, jobId: 'JOB#A' });
    const dispatched = await planAdmissionV2Dispatch(SOURCE, { ledger: repository, now: () => new Date('2026-10-01T01:00:00.000Z') });
    expect(dispatched.messages.map((message) => message.externalIds).flat().sort()).toEqual(['a', 'b', 'c']);
  });

  it('guards replay with a token bound to the previewed state', async () => {
    const { repository } = await seeded();
    await repository.acquireLease({
      sourceId: SOURCE, externalId: 'a', owner: 'owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
      expectedSnapshotHash: HASH, expectedMaterialHash: 'm-a', expectedAdmissionVersion: ADMISSION,
    });
    await repository.quarantineRow({
      sourceId: SOURCE, externalId: 'a', owner: 'owner', now: '2026-10-01T00:00:00.000Z', attemptCount: 3,
      ...expectedIdentity('a'),
      failure: { kind: 'row-transient', classification: 'upstream-server-error', detail: '503' },
    });
    const snapshots = {
      async getSnapshot() { return { rows: [{ externalId: 'a' }] }; },
    } as unknown as IngestionSnapshotObjectStore;
    const preview = await planAdmissionReplay(repository, { sourceId: SOURCE, externalId: 'a' }, { snapshots });
    expect(preview.eligible).toBe(true);
    const applied = await applyAdmissionReplay(
      repository,
      { sourceId: SOURCE, externalId: 'a', replayToken: preview.replayToken! },
      { snapshots },
    );
    expect(applied.applied).toBe(true);
    expect((await repository.getRow(SOURCE, 'a'))?.state).toBe('queued');
    expect((await repository.overview(SOURCE)).queued).toBe(1);
  });
});
