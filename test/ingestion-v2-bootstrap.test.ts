import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import {
  applyIngestionV2Bootstrap,
  planIngestionV2Bootstrap,
} from '../src/ingestion-v2/bootstrap.js';
import type { NormalizedSnapshotEnvelope } from '../src/ingestion-v2/types.js';
import type { SourceCheckpoint } from '../src/types.js';

const now = '2026-10-04T00:00:00.000Z';
const sourceId = 'community-canary';
const snapshotHash = 'a'.repeat(64);
const admissionVersion = 'policy-v2';

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

function envelope(): NormalizedSnapshotEnvelope {
  return {
    schemaVersion: 1,
    sourceId,
    snapshotHash,
    admissionVersion,
    observedAt: now,
    documentCount: 1,
    rowCount: 2,
    rows: [
      {
        externalId: 'active-a', document: 'README.md', row: 1,
        materialHash: 'b'.repeat(64), firstObservationEligible: false,
        posting: { sourceId, externalId: 'active-a' } as never,
      },
      {
        externalId: 'active-b', document: 'README.md', row: 2,
        materialHash: 'c'.repeat(64), firstObservationEligible: false,
        posting: { sourceId, externalId: 'active-b' } as never,
      },
    ],
  };
}

async function subject(options: { legacyCheckpoint?: boolean } = {}) {
  const database = new DatabaseSync(':memory:');
  for (const file of ['0001_initial.sql', '0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql', '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql', '0049_ingestion_v2_bootstrap.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const repository = new D1IngestionV2Repository(sqliteD1(database));
  await repository.putSnapshot({
    sourceId, snapshotHash, objectKey: `ingestion-v2/snapshots/${sourceId}/${snapshotHash}.json`, admissionVersion,
    documentCount: 1, rowCount: 2, state: 'active', isComplete: true, baseline: true,
    createdAt: now, activatedAt: now,
  });
  await repository.putRows(envelope().rows.map((row) => ({
    sourceId, externalId: row.externalId, snapshotHash, materialHash: row.materialHash, admissionVersion: 'policy-v1',
    notificationBaseline: false, state: 'settled' as const, decision: 'admitted' as const, attemptCount: 1,
    consecutiveOmissions: 0, firstObservedAt: now, lastObservedAt: now, updatedAt: now, settledAt: now,
  })));
  const store = new D1InternshipStore(sqliteD1(database));
  const checkpoint: SourceCheckpoint = {
    sourceId, successfulFetches: 3, admissionConfigurationVersion: 'policy-v1',
    ...(options.legacyCheckpoint === false ? {} : {
      pendingAdmissionConfigurationVersion: admissionVersion,
      pendingResolutionRows: ['active-a'],
    }),
  };
  await store.putCheckpoint(checkpoint);
  await store.putSourceHealth({
    sourceId, sourceStatus: 'paused', state: 'healthy', lastAttemptAt: now,
    consecutiveFailures: 0, durationMs: 1,
  });
  const selection = [
    { externalId: 'active-a', jobId: 'JOB#a', present: true, consecutiveOmissions: 0, state: 'open' as const, catalogPublicationSuppressed: true },
    { externalId: 'active-b', jobId: 'JOB#b', present: true, consecutiveOmissions: 0, state: 'open' as const },
    { externalId: 'history', jobId: 'JOB#history', present: false, consecutiveOmissions: 2, state: 'closed' as const },
  ];
  const bootstrapStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'listSourceOccurrenceSelectionMetadata') return async () => selection;
      const current = Reflect.get(target, property, receiver);
      return typeof current === 'function' ? current.bind(target) : current;
    },
  });
  const dependencies = {
    repository,
    snapshots: { async getSnapshot() { return envelope(); } } as never,
    store: bootstrapStore,
    secret: 'bootstrap-test-secret',
    now: () => new Date(now),
  };
  return { database, repository, dependencies, checkpoint: () => store.getCheckpoint(sourceId) };
}

describe('Ingestion V2 guarded bootstrap', () => {
  it('plans the complete active snapshot and atomically applies a silent baseline', async () => {
    const test = await subject();
    const plan = await planIngestionV2Bootstrap(sourceId, test.dependencies);
    expect(plan).toMatchObject({
      sourceStatus: 'paused', activeRows: 2, actionableRows: 2,
      historicalRowsExcluded: 1, legacySuppressedActiveRows: 1,
      expectedCatalogVisibilityChanges: 1, expectedNotifications: 0,
      estimatedWrites: { d1: 4, r2: 0 }, alreadyApplied: false,
    });
    const receipt = await applyIngestionV2Bootstrap({
      sourceId, repairToken: plan.repairToken, expectedActive: 2, expectedActionable: 2, actor: 'test-operator',
    }, test.dependencies);
    expect(receipt).toMatchObject({ activeRows: 2, actionableRows: 2, expectedNotifications: 0, idempotent: false });
    expect(await test.repository.overview(sourceId)).toMatchObject({ pending: 2, settled: 0 });
    expect(await test.repository.getRow(sourceId, 'active-a')).toMatchObject({
      state: 'pending', notificationBaseline: true, admissionVersion,
    });
    expect(await test.checkpoint()).toMatchObject({ admissionConfigurationVersion: admissionVersion });
    expect((await test.checkpoint())?.pendingAdmissionConfigurationVersion).toBeUndefined();
    expect((await test.checkpoint())?.pendingResolutionRows).toBeUndefined();
    test.database.close();
  });

  it('is idempotent for a completed source and rejects stale expected counts', async () => {
    const test = await subject();
    const first = await planIngestionV2Bootstrap(sourceId, test.dependencies);
    await expect(applyIngestionV2Bootstrap({
      sourceId, repairToken: first.repairToken, expectedActive: 2, expectedActionable: 1, actor: 'test-operator',
    }, test.dependencies)).rejects.toThrow('expected counts');
    await applyIngestionV2Bootstrap({
      sourceId, repairToken: first.repairToken, expectedActive: 2, expectedActionable: 2, actor: 'test-operator',
    }, test.dependencies);
    const repeated = await planIngestionV2Bootstrap(sourceId, test.dependencies);
    expect(repeated).toMatchObject({ alreadyApplied: true, actionableRows: 0, estimatedWrites: { d1: 0, r2: 0 } });
    const receipt = await applyIngestionV2Bootstrap({
      sourceId, repairToken: repeated.repairToken, expectedActive: 2, expectedActionable: 0, actor: 'test-operator',
    }, test.dependencies);
    expect(receipt.idempotent).toBe(true);
    expect(await test.repository.overview(sourceId)).toMatchObject({ pending: 2, settled: 0 });
    test.database.close();
  });

  it('applies against a fresh checkpoint shape and rejects an expired guard', async () => {
    const test = await subject({ legacyCheckpoint: false });
    const plan = await planIngestionV2Bootstrap(sourceId, test.dependencies);
    expect(plan.checkpoint).toMatchObject({ pendingResolutionRows: 0 });
    await expect(applyIngestionV2Bootstrap({
      sourceId, repairToken: plan.repairToken, expectedActive: 2, expectedActionable: 2, actor: 'test-operator',
    }, { ...test.dependencies, now: () => new Date(Date.parse(plan.expiresAt) + 1) })).rejects.toThrow('expired');
    expect(await test.repository.getBootstrapReceipt(sourceId, snapshotHash, admissionVersion)).toBeUndefined();
    test.database.close();
  });

  it('resumes safely after an interrupted apply before the atomic repository boundary', async () => {
    const test = await subject();
    const plan = await planIngestionV2Bootstrap(sourceId, test.dependencies);
    let interrupted = true;
    const repository = new Proxy(test.repository, {
      get(target, property, receiver) {
        if (property === 'applyBootstrap') return async (...args: Parameters<typeof target.applyBootstrap>) => {
          if (interrupted) { interrupted = false; throw new Error('simulated interrupted apply'); }
          return target.applyBootstrap(...args);
        };
        const current = Reflect.get(target, property, receiver);
        return typeof current === 'function' ? current.bind(target) : current;
      },
    });
    const input = {
      sourceId, repairToken: plan.repairToken, expectedActive: 2, expectedActionable: 2, actor: 'test-operator',
    };
    await expect(applyIngestionV2Bootstrap(input, { ...test.dependencies, repository })).rejects.toThrow('simulated interrupted');
    expect(await test.repository.getBootstrapReceipt(sourceId, snapshotHash, admissionVersion)).toBeUndefined();
    await expect(applyIngestionV2Bootstrap(input, { ...test.dependencies, repository })).resolves.toMatchObject({ idempotent: false });
    expect(await test.repository.overview(sourceId)).toMatchObject({ pending: 2, settled: 0 });
    test.database.close();
  });

  it('makes no checkpoint or receipt change when the active ledger drifts at the atomic boundary', async () => {
    const test = await subject();
    const plan = await planIngestionV2Bootstrap(sourceId, test.dependencies);
    const repository = new Proxy(test.repository, {
      get(target, property, receiver) {
        if (property === 'applyBootstrap') return async (...args: Parameters<typeof target.applyBootstrap>) => {
          test.database.prepare('DELETE FROM ingestion_rows WHERE source_id = ? AND external_id = ?')
            .run(sourceId, 'active-b');
          return target.applyBootstrap(...args);
        };
        const current = Reflect.get(target, property, receiver);
        return typeof current === 'function' ? current.bind(target) : current;
      },
    });
    await expect(applyIngestionV2Bootstrap({
      sourceId, repairToken: plan.repairToken, expectedActive: 2, expectedActionable: 2, actor: 'test-operator',
    }, { ...test.dependencies, repository })).rejects.toThrow('drifted during apply');
    expect(await test.repository.getBootstrapReceipt(sourceId, snapshotHash, admissionVersion)).toBeUndefined();
    expect(await test.checkpoint()).toMatchObject({
      pendingAdmissionConfigurationVersion: admissionVersion,
      pendingResolutionRows: ['active-a'],
    });
    test.database.close();
  });
});
