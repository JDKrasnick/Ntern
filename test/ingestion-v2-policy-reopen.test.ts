import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { planSnapshotDiff } from '../src/ingestion-v2/diff.js';
import { normalizeSourceSnapshot, parseEnvelope, serializeEnvelope, snapshotObjectKey } from '../src/ingestion-v2/normalize.js';
import { IngestionV2ShadowDiscovery } from '../src/ingestion-v2/shadow-discovery.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import type { CompactIngestionRow, IngestionRowState, IngestionSnapshotObjectStore } from '../src/ingestion-v2/types.js';
import type { SourcedPosting } from '../src/types.js';

const sourceId = 'community-example';
const now = '2026-10-04T00:00:00.000Z';
const states: IngestionRowState[] = ['settled', 'quarantined', 'pending', 'queued', 'processing', 'absent'];

function prior(state: IngestionRowState): CompactIngestionRow {
  return {
    externalId: 'role', snapshotHash: 'a'.repeat(64), materialHash: 'old-material',
    admissionVersion: 'v1', state, attemptCount: 2, consecutiveOmissions: 0,
    retryAt: '2026-10-05T00:00:00.000Z',
  };
}

function diff(state: IngestionRowState, materialChanged: boolean, admissionVersion = 'v2', complete = true) {
  return planSnapshotDiff({
    sourceId, snapshotHash: 'b'.repeat(64), admissionVersion, complete, now,
    rows: [{ externalId: 'role', materialHash: materialChanged ? 'new-material' : 'old-material' }],
    ledger: [prior(state)],
  });
}

describe('policy-change diff precedence', () => {
  it.each(states)('reopens %s rows on policy mismatch despite a future retry', (state) => {
    const result = diff(state, false);
    expect(result.rows).toEqual([{ externalId: 'role', materialHash: 'old-material', classification: 'stale-policy', actionable: true }]);
    expect(result.actionableExternalIds).toEqual(['role']);
    expect(result.counts).toMatchObject({ stalePolicy: 1, changed: 0, retryable: 0, unchanged: 0, reappeared: 0 });
  });

  it.each(states)('prioritizes policy over simultaneous material change for %s rows', (state) => {
    expect(diff(state, true).rows[0]).toMatchObject({ classification: 'stale-policy', materialHash: 'new-material', actionable: true });
  });

  it.each(states)('preserves same-policy classification for %s rows', (state) => {
    expect(diff(state, false, 'v1').rows[0]?.classification).toBe(state === 'absent' ? 'reappeared' : 'unchanged');
    expect(diff(state, true, 'v1').rows[0]?.classification).toBe(state === 'absent' ? 'reappeared' : 'changed');
  });

  it('does not act on policy mismatches in an incomplete snapshot', () => {
    expect(diff('quarantined', true, 'v2', false)).toMatchObject({ rows: [], actionableExternalIds: [], counts: { stalePolicy: 0 } });
  });
});

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

function snapshots(): IngestionSnapshotObjectStore {
  const objects = new Map<string, string>();
  return {
    async put(key, body) { objects.set(key, body); },
    async get(key) { return objects.get(key) ?? null; },
    async delete(key) { objects.delete(key); },
    async putSnapshot(envelope) {
      const key = snapshotObjectKey(envelope.sourceId, envelope.snapshotHash);
      const body = serializeEnvelope(envelope);
      const existed = objects.has(key);
      objects.set(key, body);
      return { key, bytes: body.length, existed };
    },
    async getSnapshot(source, hash) {
      return parseEnvelope(objects.get(snapshotObjectKey(source, hash))!, { sourceId: source, snapshotHash: hash });
    },
  };
}

function posting(externalId: string): SourcedPosting {
  return {
    sourceId, externalId, provenance: 'reviewed-community', sourceUrl: 'https://github.com/example/jobs',
    document: 'README.md', row: 1, fetchedAt: now,
    employer: { id: 'example', name: 'Example', authority: 'reviewed-registry' },
    title: 'Software Engineering Intern', locations: ['Remote'],
    content: [{ kind: 'description', format: 'plain', value: 'Build software.' }],
    applyUrl: `https://jobs.example.com/${externalId}`, sourceState: 'open', lifecycleAuthority: 'title',
  };
}

describe('policy-change discovery and dispatch composition', () => {
  it.each([false, true])('reopens every prior state silently with materialChanged=%s while new roles remain incremental', async (materialChanged) => {
    const database = new DatabaseSync(':memory:');
    try {
      for (const migration of ['0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql', '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql', '0049_ingestion_v2_cost_windows.sql', '0050_ingestion_v2_omission_closure.sql', '0051_ingestion_v2_qualification_cadence.sql']) {
        database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
      }
      const repository = new D1IngestionV2Repository(sqliteD1(database));
      const original = states.map((state) => posting(state));
      const oldEnvelope = normalizeSourceSnapshot({ sourceId, postings: original, admissionVersion: 'v1', observedAt: now });
      await repository.putRows(oldEnvelope.rows.map((row, index) => ({
        ...prior(states[index]!), sourceId, externalId: row.externalId, materialHash: row.materialHash,
        snapshotHash: oldEnvelope.snapshotHash, notificationBaseline: false,
        leaseOwner: states[index] === 'processing' ? 'old-owner' : undefined,
        leaseExpiresAt: states[index] === 'processing' ? '2026-10-05T00:00:00.000Z' : undefined,
        firstObservedAt: now, lastObservedAt: now, updatedAt: now,
      })));
      const reopened: string[][] = [];
      const discovery = new IngestionV2ShadowDiscovery({
        repository, snapshots: snapshots(), features: { shadowDiscoveryEnabled: true },
        admissionEnabledForSource: () => true, now: () => new Date(now), log: () => undefined,
        reopenActionableRows: async (input) => {
          reopened.push([...input.externalIds]);
          return repository.reopenRows(sourceId, input.externalIds, now, { admissionVersion: input.admissionVersion });
        },
      });
      const postings = [
        ...original.map((row) => materialChanged ? { ...row, title: 'Data Engineering Intern' } : row),
        posting('new-role'),
      ];
      expect(await discovery.discover({
        sourceId, postings, admissionVersion: 'v2', snapshotHash: oldEnvelope.snapshotHash,
        processed: { listings: [], decisions: [], counts: { raw: postings.length, valid: postings.length, eligible: 0, shelved: 0, filtered: 0, withheld: 0 } },
        baseline: false, observedAt: now, now, legacyActionableExternalIds: [],
        legacyActiveExternalIds: postings.map((row) => row.externalId),
      })).toMatchObject({ completed: true });
      expect(reopened).toEqual([postings.map((row) => row.externalId).sort((a, b) => a.localeCompare(b))]);
      for (const state of states) {
        const migrated = await repository.getRow(sourceId, state);
        expect(migrated).toMatchObject({
          state: 'queued', admissionVersion: 'v2', notificationBaseline: true, attemptCount: 0,
        });
        expect(migrated?.retryAt).toBeUndefined();
        expect(migrated?.leaseOwner).toBeUndefined();
        expect(migrated?.leaseExpiresAt).toBeUndefined();
      }
      expect(await repository.getRow(sourceId, 'new-role')).toMatchObject({ notificationBaseline: false });
      const plan = await planAdmissionV2Dispatch(sourceId, { ledger: repository, now: () => new Date(now) });
      expect(plan.messages.filter((message) => message.baseline).flatMap((message) => message.externalIds).sort()).toEqual([...states].sort());
      expect(plan.messages.filter((message) => !message.baseline).flatMap((message) => message.externalIds)).toEqual(['new-role']);
      // Once dispatched, the same-policy snapshot no longer creates actionable work.
      const envelope = normalizeSourceSnapshot({ sourceId, postings, admissionVersion: 'v2', observedAt: now });
      expect(planSnapshotDiff({ sourceId, snapshotHash: envelope.snapshotHash, admissionVersion: 'v2', now, complete: true, rows: envelope.rows, ledger: await repository.listLedger(sourceId) }).actionableExternalIds).toEqual([]);
    } finally {
      database.close();
    }
  });
});
