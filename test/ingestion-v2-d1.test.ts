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
  database.exec(readFileSync(new URL('../cloudflare/migrations/0046_ingestion_v2_admission.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../cloudflare/migrations/0047_ingestion_v2_dispatch_cursor.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../cloudflare/migrations/0048_ingestion_v2_effect_claim.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../cloudflare/migrations/0050_ingestion_v2_omission_closure.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../cloudflare/migrations/0051_ingestion_v2_qualification_cadence.sql', import.meta.url), 'utf8'));
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
    notificationBaseline: false,
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

  it('activates a complete snapshot idempotently', async () => {
    const { repository } = subject();
    await repository.putSnapshot(snapshot());
    await repository.activateSnapshot('community-example', 'a'.repeat(64), '2026-10-01T01:00:00.000Z');
    expect(await repository.getSnapshot('community-example', 'a'.repeat(64))).toMatchObject({ state: 'active', activatedAt: '2026-10-01T01:00:00.000Z' });
    // A repeated observation keeps the same snapshot current and refreshes the
    // activation evidence without creating another record.
    await repository.activateSnapshot('community-example', 'a'.repeat(64), '2026-10-01T02:00:00.000Z');
    expect(await repository.getSnapshot('community-example', 'a'.repeat(64))).toMatchObject({ activatedAt: '2026-10-01T02:00:00.000Z' });
  });

  it('reactivates retained content when a board returns to an older hash', async () => {
    const { database, repository } = subject();
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);
    await repository.putSnapshot(snapshot({ snapshotHash: firstHash }));
    await repository.activateSnapshot('community-example', firstHash, '2026-10-01T00:00:00.000Z');
    await repository.putSnapshot(snapshot({
      snapshotHash: secondHash,
      objectKey: `ingestion-v2/snapshots/community-example/${secondHash}.json`,
      createdAt: '2026-10-02T00:00:00.000Z',
    }));
    await repository.activateSnapshot('community-example', secondHash, '2026-10-02T00:00:00.000Z');
    expect(await repository.getSnapshot('community-example', firstHash)).toMatchObject({ state: 'terminal' });

    await repository.putSnapshot(snapshot({ snapshotHash: firstHash, createdAt: '2026-10-03T00:00:00.000Z' }));
    await repository.activateSnapshot('community-example', firstHash, '2026-10-03T00:00:00.000Z');

    expect(await repository.getSnapshot('community-example', firstHash)).toMatchObject({
      state: 'active', activatedAt: '2026-10-03T00:00:00.000Z',
    });
    expect((await repository.getSnapshot('community-example', firstHash))?.terminalAt).toBeUndefined();
    expect((await repository.getSnapshot('community-example', firstHash))?.expiresAt).toBeUndefined();
    expect(await repository.getSnapshot('community-example', secondHash)).toMatchObject({ state: 'terminal' });
    const active = database.prepare(
      "SELECT COUNT(*) AS count FROM ingestion_snapshots WHERE source_id = ? AND state = 'active'",
    ).get('community-example') as { count: number };
    expect(active.count).toBe(1);
  });

  it('terminals an older settled snapshot with seven-day retention when a replacement activates', async () => {
    const { repository } = subject();
    const oldHash = 'a'.repeat(64);
    const nextHash = 'b'.repeat(64);
    await repository.putSnapshot(snapshot({ snapshotHash: oldHash, state: 'active', activatedAt: '2026-10-01T00:00:00.000Z' }));
    await repository.putRows([row({ externalId: 'role-old', snapshotHash: oldHash, state: 'settled' })]);
    await repository.putSnapshot(snapshot({ snapshotHash: nextHash, objectKey: `ingestion-v2/snapshots/community-example/${nextHash}.json` }));
    await repository.activateSnapshot('community-example', nextHash, '2026-10-02T00:00:00.000Z');
    expect(await repository.getSnapshot('community-example', oldHash)).toMatchObject({
      state: 'terminal',
      terminalAt: '2026-10-02T00:00:00.000Z',
      expiresAt: '2026-10-09T00:00:00.000Z',
    });
  });

  it('retains an older snapshot while admission work still references it', async () => {
    const { database, repository } = subject();
    const oldHash = 'a'.repeat(64);
    const nextHash = 'b'.repeat(64);
    await repository.putSnapshot(snapshot({ snapshotHash: oldHash, state: 'active', activatedAt: '2026-10-01T00:00:00.000Z' }));
    await repository.putRows([row({ externalId: 'role-old', snapshotHash: oldHash, state: 'queued', decision: undefined })]);
    await repository.putSnapshot(snapshot({ snapshotHash: nextHash, objectKey: `ingestion-v2/snapshots/community-example/${nextHash}.json` }));
    await repository.activateSnapshot('community-example', nextHash, '2026-10-02T00:00:00.000Z');
    expect(await repository.getSnapshot('community-example', oldHash)).toMatchObject({ state: 'active' });

    database.prepare("UPDATE ingestion_rows SET state = 'settled' WHERE source_id = ? AND external_id = ?")
      .run('community-example', 'role-old');
    await repository.recordHandoff({
      batchId: 'old-snapshot-complete',
      sourceId: 'community-example',
      snapshotHash: oldHash,
      admissionVersion: 'standard-v1',
      externalIds: ['role-old'],
      baseline: false,
      dispatchedAt: '2026-10-02T00:01:00.000Z',
    });
    await repository.acknowledgeHandoff('old-snapshot-complete', '2026-10-02T00:02:00.000Z');
    expect(await repository.getSnapshot('community-example', oldHash)).toMatchObject({
      state: 'terminal',
      terminalAt: '2026-10-02T00:02:00.000Z',
      expiresAt: '2026-10-09T00:02:00.000Z',
    });
  });

  it('does not terminalize the current snapshot when the requested target is unknown', async () => {
    const { repository } = subject();
    const oldHash = 'a'.repeat(64);
    await repository.putSnapshot(snapshot({ snapshotHash: oldHash, state: 'active', activatedAt: '2026-10-01T00:00:00.000Z' }));
    await repository.activateSnapshot('community-example', 'f'.repeat(64), '2026-10-02T00:00:00.000Z');
    expect(await repository.getSnapshot('community-example', oldHash)).toMatchObject({ state: 'active' });
  });

  it('does not let another source with the same content hash retain a settled snapshot', async () => {
    const { repository } = subject();
    const oldHash = 'a'.repeat(64);
    const nextHash = 'b'.repeat(64);
    await repository.putSnapshot(snapshot({ snapshotHash: oldHash, state: 'active', activatedAt: '2026-10-01T00:00:00.000Z' }));
    await repository.putSnapshot(snapshot({
      sourceId: 'other-source', snapshotHash: oldHash,
      objectKey: `ingestion-v2/snapshots/other-source/${oldHash}.json`,
      state: 'active', activatedAt: '2026-10-01T00:00:00.000Z',
    }));
    await repository.putRows([row({
      sourceId: 'other-source', externalId: 'other-role', snapshotHash: oldHash,
      state: 'queued', decision: undefined,
    })]);
    await repository.putSnapshot(snapshot({ snapshotHash: nextHash, objectKey: `ingestion-v2/snapshots/community-example/${nextHash}.json` }));
    await repository.activateSnapshot('community-example', nextHash, '2026-10-02T00:00:00.000Z');
    expect(await repository.getSnapshot('community-example', oldHash)).toMatchObject({ state: 'terminal' });
    expect(await repository.getSnapshot('other-source', oldHash)).toMatchObject({ state: 'active' });
  });

  it('lists every currently configured source within the dispatcher bound', async () => {
    const { repository } = subject();
    for (let index = 0; index < 54; index += 1) {
      const sourceId = `source-${String(index).padStart(2, '0')}`;
      const snapshotHash = index.toString(16).padStart(64, '0');
      await repository.putSnapshot(snapshot({ sourceId, snapshotHash, objectKey: `ingestion-v2/snapshots/${sourceId}/${snapshotHash}.json`, state: 'active' }));
    }
    const sourceIds = await repository.listActiveSourceIds(500);
    expect(sourceIds).toHaveLength(54);
    expect(sourceIds.at(-1)).toBe('source-53');
  });

  it('rotates the bounded source page so a tail source cannot starve', async () => {
    const { repository } = subject();
    for (let index = 0; index < 501; index += 1) {
      const sourceId = `source-${String(index).padStart(3, '0')}`;
      const snapshotHash = index.toString(16).padStart(64, '0');
      await repository.putSnapshot(snapshot({ sourceId, snapshotHash, objectKey: `ingestion-v2/snapshots/${sourceId}/${snapshotHash}.json`, state: 'active' }));
    }
    const first = await repository.listActiveSourceIds(500);
    await repository.setDispatchSourceCursor(first.at(-1), '2026-10-01T01:00:00.000Z');
    const second = await repository.listActiveSourceIds(500, await repository.getDispatchSourceCursor());
    expect(second).toEqual(['source-500']);
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

  it('resets and reopens queued work when it receives a new material identity', async () => {
    const { repository } = subject();
    await repository.putRows([row({
      externalId: 'changed', state: 'queued', decision: undefined, attemptCount: 2,
      retryAt: '2026-10-01T01:00:00.000Z', failureClass: 'destination-timeout', failureDetail: 'old material',
    })]);
    await repository.putRows([row({
      externalId: 'changed', snapshotHash: 'b'.repeat(64), materialHash: 'new', admissionVersion: 'standard-v2',
      state: 'settled', decision: undefined, attemptCount: 0, retryAt: undefined,
      failureClass: undefined, failureDetail: undefined, settledAt: undefined,
      updatedAt: '2026-10-01T00:05:00.000Z', lastObservedAt: '2026-10-01T00:05:00.000Z',
    })]);
    expect(await repository.getRow('community-example', 'changed')).toMatchObject({
      state: 'settled', snapshotHash: 'b'.repeat(64), materialHash: 'new', admissionVersion: 'standard-v2', attemptCount: 0,
    });
    expect((await repository.getRow('community-example', 'changed'))?.retryAt).toBeUndefined();
    expect((await repository.getRow('community-example', 'changed'))?.failureClass).toBeUndefined();
    expect((await repository.getRow('community-example', 'changed'))?.decision).toBeUndefined();
    await repository.reopenRows('community-example', ['changed'], '2026-10-01T00:05:01.000Z');
    expect(await repository.getRow('community-example', 'changed')).toMatchObject({ state: 'queued', attemptCount: 0 });
  });

  it('preserves row-owned work when only a peer changes the board snapshot', async () => {
    const { repository } = subject();
    const nextSnapshotHash = 'b'.repeat(64);
    await repository.putRows([
      row({ externalId: 'retry', state: 'queued', decision: undefined, attemptCount: 1, retryAt: '2026-10-01T00:10:00.000Z', failureClass: 'destination-timeout' }),
      row({ externalId: 'poison', state: 'quarantined', decision: 'blocked', attemptCount: 3, failureClass: 'upstream-server-error' }),
      row({ externalId: 'leased', state: 'processing', decision: undefined, attemptCount: 1, leaseOwner: 'old-owner', leaseExpiresAt: '2026-10-01T00:05:00.000Z' }),
    ]);
    await repository.putRows(['retry', 'poison', 'leased'].map((externalId) => row({
      externalId,
      snapshotHash: nextSnapshotHash,
      state: 'settled',
      decision: 'admitted',
      attemptCount: 0,
      updatedAt: '2026-10-01T00:01:00.000Z',
      lastObservedAt: '2026-10-01T00:01:00.000Z',
    })));

    expect(await repository.getRow('community-example', 'retry')).toMatchObject({
      snapshotHash: nextSnapshotHash, state: 'queued', attemptCount: 1,
      retryAt: '2026-10-01T00:10:00.000Z', failureClass: 'destination-timeout',
    });
    expect(await repository.getRow('community-example', 'poison')).toMatchObject({
      snapshotHash: nextSnapshotHash, state: 'quarantined', attemptCount: 3, failureClass: 'upstream-server-error',
    });
    expect(await repository.getRow('community-example', 'leased')).toMatchObject({
      snapshotHash: nextSnapshotHash, state: 'processing', attemptCount: 1, leaseOwner: 'old-owner',
    });
    expect(await repository.settleRow({
      sourceId: 'community-example', externalId: 'leased', owner: 'old-owner', now: '2026-10-01T00:02:00.000Z',
      expectedSnapshotHash: 'a'.repeat(64), expectedMaterialHash: 'm', expectedAdmissionVersion: 'standard-v1',
      decision: 'admitted',
    })).toBe(false);
  });

  it('preserves an in-flight lease while counting complete omissions', async () => {
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
      state: 'processing', consecutiveOmissions: 1, leaseOwner: 'worker',
    });
    expect(await repository.getRow('community-example', 'idle')).toMatchObject({
      state: 'settled', consecutiveOmissions: 1,
    });
  });

  it('preserves queued or quarantined lane history while recording closure intent', async () => {
    const { repository } = subject();
    await repository.putRows([
      row({ externalId: 'queued', state: 'queued', decision: undefined, attemptCount: 1, retryAt: '2026-10-01T00:10:00.000Z' }),
      row({ externalId: 'quarantined', state: 'quarantined', decision: 'blocked', attemptCount: 3, failureClass: 'destination-timeout' }),
      row({ externalId: 'settled', state: 'settled', decision: 'admitted' }),
    ]);
    await repository.applyOmissions('community-example', [
      { externalId: 'queued', consecutiveOmissions: 2, becomesAbsent: true },
      { externalId: 'quarantined', consecutiveOmissions: 2, becomesAbsent: true },
      { externalId: 'settled', consecutiveOmissions: 2, becomesAbsent: true },
    ], '2026-10-02T00:00:00.000Z');
    expect(await repository.getRow('community-example', 'queued')).toMatchObject({
      state: 'queued', attemptCount: 1, retryAt: '2026-10-01T00:10:00.000Z', consecutiveOmissions: 2,
    });
    expect(await repository.getRow('community-example', 'quarantined')).toMatchObject({
      state: 'quarantined', attemptCount: 3, failureClass: 'destination-timeout', consecutiveOmissions: 2,
    });
    // A discovery-owned settled row still closes to absent.
    expect(await repository.getRow('community-example', 'settled')).toMatchObject({
      state: 'absent', consecutiveOmissions: 2,
    });
  });

  it('reports whether a guarded lane write applied', async () => {
    const { repository } = subject();
    await repository.putRows([row({ externalId: 'a' })]);
    // Not leased, so every guarded write is refused.
    const expectedIdentity = { expectedSnapshotHash: 'a'.repeat(64), expectedMaterialHash: 'm', expectedAdmissionVersion: 'standard-v1' };
    expect(await repository.settleRow({ sourceId: 'community-example', externalId: 'a', owner: 'x', now: '2026-10-01T00:00:00.000Z', ...expectedIdentity, decision: 'admitted' })).toBe(false);
    expect(await repository.scheduleRowRetry({ sourceId: 'community-example', externalId: 'a', owner: 'x', now: '2026-10-01T00:00:00.000Z', ...expectedIdentity, attemptCount: 1, retryAt: '2026-10-01T00:01:00.000Z', failure: { kind: 'row-transient', classification: 'destination-timeout', detail: 't' } })).toBe(false);
    expect(await repository.quarantineRow({ sourceId: 'community-example', externalId: 'a', owner: 'x', now: '2026-10-01T00:00:00.000Z', ...expectedIdentity, attemptCount: 3, failure: { kind: 'row-transient', classification: 'upstream-server-error', detail: '5' } })).toBe(false);
    expect(await repository.releaseLease('community-example', 'a', 'x', '2026-10-01T00:00:00.000Z')).toBe(false);
    await repository.putRows([row({ externalId: 'b', state: 'processing', decision: undefined, leaseOwner: 'x', leaseExpiresAt: '2026-10-01T01:00:00.000Z' })]);
    expect(await repository.releaseLease('community-example', 'b', 'x', '2026-10-01T00:00:00.000Z')).toBe(true);
  });

  it('requires an exact durable effect claim before settling an effectful row', async () => {
    const { repository } = subject();
    await repository.putRows([row({ externalId: 'effect', state: 'queued', decision: undefined })]);
    const identity = {
      expectedSnapshotHash: 'a'.repeat(64), expectedMaterialHash: 'm', expectedAdmissionVersion: 'standard-v1',
    };
    expect(await repository.acquireLease({
      sourceId: 'community-example', externalId: 'effect', owner: 'owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000, ...identity,
    })).toMatchObject({ outcome: 'acquired' });
    expect(await repository.settleRow({
      sourceId: 'community-example', externalId: 'effect', owner: 'owner', now: '2026-10-01T00:00:01.000Z',
      ...identity, decision: 'admitted', effectClaimed: true,
    })).toBe(false);
    expect(await repository.claimRowEffect({
      sourceId: 'community-example', externalId: 'effect', owner: 'owner', now: '2026-10-01T00:00:02.000Z',
      ...identity,
    })).toBe(true);
    expect(await repository.settleRow({
      sourceId: 'community-example', externalId: 'effect', owner: 'owner', now: '2026-10-01T00:00:03.000Z',
      ...identity, decision: 'admitted', effectClaimed: true,
    })).toBe(true);
  });

  it('does not acquire a retrying row before its durable backoff expires', async () => {
    const { repository } = subject();
    await repository.putRows([row({
      externalId: 'retry', state: 'queued', decision: undefined, attemptCount: 1,
      retryAt: '2026-10-01T00:01:00.000Z',
    })]);
    const identity = {
      expectedSnapshotHash: 'a'.repeat(64), expectedMaterialHash: 'm', expectedAdmissionVersion: 'standard-v1',
    };
    expect(await repository.acquireLease({
      sourceId: 'community-example', externalId: 'retry', owner: 'early', now: '2026-10-01T00:00:30.000Z', leaseMs: 60_000, ...identity,
    })).toMatchObject({ outcome: 'no-op', reason: 'retry-not-due' });
    expect(await repository.acquireLease({
      sourceId: 'community-example', externalId: 'retry', owner: 'due', now: '2026-10-01T00:01:00.000Z', leaseMs: 60_000, ...identity,
    })).toMatchObject({ outcome: 'acquired', row: { attemptCount: 1, leaseOwner: 'due' } });
  });

  it('reopens more rows than one D1 bind-limited statement can hold', async () => {
    const { repository } = subject();
    const records = Array.from({ length: 250 }, (_, index) => row({ externalId: `row-${String(index).padStart(3, '0')}` }));
    await repository.putRows(records);
    expect(await repository.reopenRows(
      'community-example', records.map((record) => record.externalId), '2026-10-01T00:01:00.000Z',
      { admissionVersion: 'standard-v2', notificationBaseline: true },
    )).toBe(250);
    expect(await repository.listRowsByState('community-example', 'queued', 500)).toHaveLength(250);
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
    expect((await repository.listRowsForSnapshot('community-example', 'a'.repeat(64), 10)).map((entry) => entry.externalId)).toContain('settled');
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
