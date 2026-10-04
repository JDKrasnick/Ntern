import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';
import { RuleBasedAdmissionV2Evaluator } from '../src/ingestion-v2/admission/evaluator.js';
import { reconcileIngestionV2Omissions } from '../src/ingestion-v2/omission-closure.js';
import { IngestionV2ShadowDiscovery } from '../src/ingestion-v2/shadow-discovery.js';
import { planSnapshotDiff } from '../src/ingestion-v2/diff.js';
import { normalizeSourceSnapshot, parseEnvelope, serializeEnvelope, snapshotObjectKey } from '../src/ingestion-v2/normalize.js';
import type { IngestionRowRecord, IngestionSnapshotObjectStore } from '../src/ingestion-v2/types.js';
import type { CatalogAdmission, SourceOccurrenceState, Internship } from '../src/types.js';

const now = '2026-10-04T12:00:00.000Z';
const later = '2026-10-04T12:01:00.000Z';
const leaseExpiresAt = '2026-10-04T12:10:00.000Z';
const input = { sourceId: 'source', snapshotHash: 'absent', admissionVersion: 'v1', observedAt: later };

function subject() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  let failBatch = false;
  let failAfterCommit = false;
  let beforeBatch: (() => void) | undefined;
  const prepared = (sql: string, args: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...values: unknown[]) { return prepared(sql, values as SQLInputValue[]); },
    async first<T>() { return (sqlite.prepare(sql).get(...args) as T | undefined) ?? null; },
    async all<T>() { return { results: sqlite.prepare(sql).all(...args) as T[] }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
  });
  const db: D1Database = {
    prepare: (sql) => prepared(sql),
    async batch(statements) {
      const hook = beforeBatch; beforeBatch = undefined; hook?.();
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (let i = 0; i < statements.length; i += 1) {
          if (failBatch && i === 1) { failBatch = false; throw new Error('injected rollback'); }
          results.push(await statements[i]!.run());
        }
        sqlite.exec('COMMIT');
        if (failAfterCommit) { failAfterCommit = false; throw new Error('lost response after commit'); }
        return results;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const store = new D1InternshipStore(db);
  const repository = new D1IngestionV2Repository(db);
  const sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(later));
  return {
    sqlite, store, repository, sink,
    failRollback() { failBatch = true; },
    failResponse() { failAfterCommit = true; },
    race(hook: () => void) { beforeBatch = hook; },
  };
}

function admission(): CatalogAdmission {
  return {
    canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved',
    postingAttribution: 'attributed', destination: {
      classification: 'application-form', candidateUrl: 'https://jobs.example.com/role',
      provider: 'unknown', inspectedAt: now, closureState: 'open', browserVisible: true,
    }, metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt: now, evidenceObservedAt: now,
  };
}

function observation(externalId: string, sourceId = 'source', jobId = externalId) {
  const decision = { status: 'unconfirmed' as const, reason: 'unrecognized-url-family' as const,
    reviewFamilyKey: 'jobs.example.com', observedAt: now };
  const occurrence: SourceOccurrenceState = {
    sourceId, externalId, jobId, present: true, consecutiveOmissions: 0, changedAt: now,
    changedSnapshotHash: 'present', occurrence: {
      sourceId, externalId, document: 'README.md', sourceUrl: 'https://example.com/board', row: 1,
      company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: 'https://jobs.example.com/role', compensation: { raw: '' }, state: 'open',
      technical: true, admission: admission(), postingIdentityDecision: decision,
    },
  };
  const job: Internship = {
    jobId, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl: occurrence.occurrence.applyUrl, normalizedUrl: occurrence.occurrence.applyUrl,
    fingerprint: jobId, compensation: { raw: '' }, sourceReferences: [occurrence.occurrence],
    technical: true, open: true, firstSeenAt: now, lastSeenAt: now,
    notification: { smsPending: false, digestPending: false },
  };
  return { decision, occurrence, job };
}

function row(externalId: string): IngestionRowRecord {
  return {
    sourceId: 'source', externalId, snapshotHash: 'present', materialHash: externalId,
    admissionVersion: 'v1', state: 'settled', notificationBaseline: true, attemptCount: 0,
    consecutiveOmissions: 0, firstObservedAt: now, lastObservedAt: now, updatedAt: now,
  };
}

async function seed(s: ReturnType<typeof subject>, ids: string[]) {
  await s.repository.putSnapshot({
    sourceId: 'source', snapshotHash: 'absent', objectKey: 'absent', admissionVersion: 'v1',
    documentCount: 1, rowCount: 0, state: 'staged', isComplete: true, baseline: false, createdAt: later,
  });
  await s.repository.activateSnapshot('source', 'absent', later);
  for (const id of ids) await s.store.commitPostingObservation(observation(id));
  await s.repository.putRows(ids.map(row));
}

async function omit(s: ReturnType<typeof subject>, ids: string[], count: number) {
  await s.repository.applyOmissions('source', ids.map((externalId) => ({ externalId,
    consecutiveOmissions: count, becomesAbsent: count >= 2 })), later);
}

describe('durable public omission closure', () => {
  it('keeps the first omission public, closes the second, and does not repeat completed effects', async () => {
    const s = subject(); await seed(s, ['role']);
    await omit(s, ['role'], 1);
    expect(await reconcileIngestionV2Omissions(s, input)).toMatchObject({ attempted: 0 });
    expect((await s.store.getJob('role'))?.open).toBe(true);
    await omit(s, ['role'], 2);
    expect(await reconcileIngestionV2Omissions(s, input)).toMatchObject({ completed: 1 });
    expect((await s.store.getSourceOccurrence('source', 'role'))).toMatchObject({
      present: false, consecutiveOmissions: 2, occurrence: { state: 'closed' },
    });
    expect((await s.store.getJob('role'))?.open).toBe(false);
    expect(await reconcileIngestionV2Omissions(s, input)).toMatchObject({ attempted: 0 });
    expect(s.sqlite.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind='notification-event'").get()).toEqual({ n: 0 });
  });

  it.each(['rollback', 'response'] as const)('recovers an absent row after %s failure without another diff transition', async (failure) => {
    const s = subject(); await seed(s, ['role']); await omit(s, ['role'], 2);
    if (failure === 'rollback') s.failRollback(); else s.failResponse();
    await expect(reconcileIngestionV2Omissions(s, input)).rejects.toThrow('remain pending');
    expect(await s.repository.getRow('source', 'role')).toMatchObject({ state: 'absent' });
    expect(await s.repository.listPendingOmissionClosures('source', 25)).toHaveLength(1);
    expect((await s.store.getJob('role'))?.open).toBe(failure === 'rollback');
    await reconcileIngestionV2Omissions(s, input);
    expect((await s.store.getJob('role'))?.open).toBe(false);
    expect(await s.repository.listPendingOmissionClosures('source', 25)).toHaveLength(0);
  });

  it('preserves a live peer and removes only the revoked occurrence from canonical admission', async () => {
    const s = subject(); await seed(s, ['role']);
    await s.store.commitPostingObservation(observation('peer-role', 'peer', 'role'));
    await s.sink.revoke({ sourceId: 'source', externalId: 'role', reason: 'destination-gone', admissionVersion: 'v2' });
    const job = await s.store.getJob('role');
    expect(job).toMatchObject({ open: true, admission: { catalogEligible: true } });
    expect(job?.sourceReferences.find((ref) => ref.sourceId === 'source')).toMatchObject({ state: 'closed', admission: { catalogEligible: false } });
    expect(job?.sourceReferences.find((ref) => ref.sourceId === 'peer')?.state).toBe('open');
    await s.sink.revoke({ sourceId: 'peer', externalId: 'peer-role', reason: 'shelved', admissionVersion: 'v2' });
    expect(await s.store.getJob('role')).toMatchObject({ open: false, admission: { catalogEligible: false } });
  });

  it.each(['rollback', 'response'] as const)('replays a revoke after %s failure and makes a completed duplicate a no-op', async (failure) => {
    const s = subject(); await seed(s, ['role']);
    const revoke = { sourceId: 'source', externalId: 'role', reason: 'destination-gone', admissionVersion: 'v2' };
    if (failure === 'rollback') s.failRollback(); else s.failResponse();
    await expect(s.sink.revoke(revoke)).rejects.toThrow();
    await s.sink.revoke(revoke);
    expect(await s.store.getJob('role')).toMatchObject({ open: false, admission: { catalogEligible: false } });
    const before = s.sqlite.prepare("SELECT pk, sk, value FROM catalog_items ORDER BY pk, sk").all();
    await s.sink.revoke(revoke);
    expect(s.sqlite.prepare("SELECT pk, sk, value FROM catalog_items ORDER BY pk, sk").all()).toEqual(before);
  });

  it('fences a deferred old terminal rejection after a replacement is publicly admitted', async () => {
    const s = subject(); await seed(s, ['role']);
    const leased = { ...row('role'), state: 'processing' as const, leaseOwner: 'old-owner', leaseExpiresAt };
    await s.repository.putRows([leased]);
    const evaluator = new RuleBasedAdmissionV2Evaluator({ sink: s.sink,
      prober: { async probe() { throw new Error('deterministic rejection must not probe'); } },
      now: () => new Date(later) });
    const evaluated = await evaluator.evaluate({
      sourceId: 'source', externalId: 'role', snapshotHash: 'present', admissionVersion: 'v1',
      baseline: false, row: leased, posting: {
        sourceId: 'source', externalId: 'role', sourceUrl: 'https://example.com/board', fetchedAt: now,
        employer: { name: 'Acme', authority: 'source-row' }, title: 'Sales Intern', content: [], locations: ['Remote'],
        applyUrl: 'https://jobs.example.com/role', sourceState: 'open', lifecycleAuthority: 'source',
      },
    });
    expect(evaluated.decision.kind).not.toBe('admitted');
    expect(await s.repository.claimRowEffect({ sourceId: 'source', externalId: 'role', owner: 'old-owner', now: later,
      expectedSnapshotHash: 'present', expectedMaterialHash: 'role', expectedAdmissionVersion: 'v1' })).toBe(true);
    await s.repository.putRows([{ ...row('role'), snapshotHash: 'replacement', materialHash: 'new-material', updatedAt: later }]);
    await s.store.commitPostingObservation(observation('role'));
    const before = s.sqlite.prepare("SELECT pk, sk, value FROM catalog_items ORDER BY pk, sk").all();
    await evaluated.commitEffect?.();
    expect(s.sqlite.prepare("SELECT pk, sk, value FROM catalog_items ORDER BY pk, sk").all()).toEqual(before);
    expect(await s.store.getJob('role')).toMatchObject({ open: true, admission: { catalogEligible: true } });
  });

  it('atomically rejects a replacement racing a claimed revoke transaction', async () => {
    const s = subject(); await seed(s, ['role']);
    s.sqlite.prepare("UPDATE ingestion_rows SET state='processing', lease_owner='old-owner', lease_expires_at=?, effect_claimed_at=? WHERE external_id='role'").run(leaseExpiresAt, now);
    s.race(() => s.sqlite.prepare("UPDATE ingestion_rows SET state='settled', material_hash='replacement', effect_claimed_at=NULL, lease_owner=NULL WHERE external_id='role'").run());
    await s.sink.revoke({ sourceId: 'source', externalId: 'role', reason: 'destination-gone', admissionVersion: 'v1',
      effectFence: { snapshotHash: 'present', materialHash: 'role', admissionVersion: 'v1', leaseOwner: 'old-owner', leaseExpiresAt } });
    expect((await s.store.getJob('role'))?.open).toBe(true);
    expect((await s.store.getSourceOccurrence('source', 'role'))?.occurrence.state).toBe('open');
  });

  it.each(['policy', 'material', 'reacquired-lease'] as const)('makes an old claimed revoke a no-op after %s replacement', async (replacement) => {
    const s = subject(); await seed(s, ['role']);
    s.sqlite.prepare("UPDATE ingestion_rows SET state='processing', lease_owner='owner', lease_expires_at=?, effect_claimed_at=? WHERE external_id='role'").run(leaseExpiresAt, now);
    if (replacement === 'policy') s.sqlite.prepare("UPDATE ingestion_rows SET admission_version='v2' WHERE external_id='role'").run();
    if (replacement === 'material') s.sqlite.prepare("UPDATE ingestion_rows SET material_hash='replacement' WHERE external_id='role'").run();
    if (replacement === 'reacquired-lease') s.sqlite.prepare("UPDATE ingestion_rows SET lease_expires_at='2026-10-04T12:20:00.000Z' WHERE external_id='role'").run();
    const before = s.sqlite.prepare("SELECT pk, sk, value FROM catalog_items ORDER BY pk, sk").all();
    await s.sink.revoke({ sourceId: 'source', externalId: 'role', reason: 'destination-gone', admissionVersion: 'v1',
      effectFence: { snapshotHash: 'present', materialHash: 'role', admissionVersion: 'v1', leaseOwner: 'owner', leaseExpiresAt } });
    expect(s.sqlite.prepare("SELECT pk, sk, value FROM catalog_items ORDER BY pk, sk").all()).toEqual(before);
  });

  it('prevents an old claimed positive effect from reopening a newly revoked occurrence', async () => {
    const s = subject(); await seed(s, ['role']);
    const original = observation('role');
    await s.sink.revoke({ sourceId: 'source', externalId: 'role', reason: 'destination-gone', admissionVersion: 'v2' });
    s.sqlite.prepare("UPDATE ingestion_rows SET state='settled', admission_version='v2', material_hash='new-material' WHERE external_id='role'").run();
    const before = s.sqlite.prepare("SELECT pk, sk, value FROM catalog_items ORDER BY pk, sk").all();
    await s.sink.commit({ sourceId: 'source', externalId: 'role', baseline: false, admissionVersion: 'v1',
      jobId: 'role', listing: { ...original.occurrence.occurrence, fetchedAt: now }, admission: admission(), notify: false,
      effectFence: { snapshotHash: 'present', materialHash: 'role', admissionVersion: 'v1', leaseOwner: 'owner', leaseExpiresAt } });
    expect(s.sqlite.prepare("SELECT pk, sk, value FROM catalog_items ORDER BY pk, sk").all()).toEqual(before);
    expect((await s.store.getSourceOccurrence('source', 'role'))?.occurrence.state).toBe('closed');
    expect((await s.store.getJob('role'))?.open).toBe(false);
  });

  it('rejects a reappearance racing the catalog transaction', async () => {
    const s = subject(); await seed(s, ['role']); await omit(s, ['role'], 2);
    s.race(() => s.sqlite.prepare("UPDATE ingestion_rows SET state='pending', closure_pending=0, consecutive_omissions=0 WHERE external_id='role'").run());
    expect(await reconcileIngestionV2Omissions(s, input)).toMatchObject({ superseded: 1, completed: 0 });
    expect((await s.store.getJob('role'))?.open).toBe(true);
    expect((await s.store.getSourceOccurrence('source', 'role'))?.occurrence.state).toBe('open');
  });

  it('rejects stale active snapshots and cancels pending closure when a row reappears', async () => {
    const s = subject(); await seed(s, ['role']); await omit(s, ['role'], 2);
    await s.repository.putRows([{ ...row('role'), snapshotHash: 'reappeared', updatedAt: later }]);
    expect(await s.repository.listPendingOmissionClosures('source', 25)).toHaveLength(0);
    expect(await reconcileIngestionV2Omissions(s, { ...input, snapshotHash: 'stale' })).toMatchObject({ attempted: 0 });
    expect((await s.store.getJob('role'))?.open).toBe(true);
  });

  it.each(['pending', 'queued', 'processing', 'quarantined'] as const)('closes a formerly published %s row while retaining its admission history', async (state) => {
    const s = subject(); await seed(s, ['role']);
    await s.repository.putRows([{ ...row('role'), materialHash: 'changed', state, attemptCount: 3,
      failureClass: 'transient-http', failureDetail: 'provider unavailable' }]);
    await omit(s, ['role'], 1);
    expect(await reconcileIngestionV2Omissions(s, input)).toMatchObject({ attempted: 0 });
    expect((await s.store.getJob('role'))?.open).toBe(true);
    await omit(s, ['role'], 2);
    await reconcileIngestionV2Omissions(s, input);
    expect((await s.store.getJob('role'))?.open).toBe(false);
    expect(await s.repository.getRow('source', 'role')).toMatchObject({ state, attemptCount: 3,
      consecutiveOmissions: 2, failureDetail: 'provider unavailable' });
    expect(await s.repository.listDispatchableRows('source', later, 25)).toHaveLength(0);
    const lease = await s.repository.acquireLease({ sourceId: 'source', externalId: 'role',
      owner: 'late-consumer', now: later, leaseMs: 60_000,
      expectedSnapshotHash: 'present', expectedMaterialHash: 'changed', expectedAdmissionVersion: 'v1' });
    expect(lease.outcome).not.toBe('acquired');
  });

  it('defers an already claimed publication, then closes it after effect settlement', async () => {
    const s = subject(); await seed(s, ['role']);
    s.sqlite.prepare("UPDATE ingestion_rows SET state='processing', lease_owner='consumer', effect_claimed_at=? WHERE external_id='role'").run(now);
    await omit(s, ['role'], 2);
    await expect(reconcileIngestionV2Omissions(s, input)).rejects.toThrow('bounded continuation');
    expect((await s.store.getJob('role'))?.open).toBe(true);
    const settled = await s.repository.settleRow({ sourceId: 'source', externalId: 'role', owner: 'consumer', now: later,
      expectedSnapshotHash: 'present', expectedMaterialHash: 'role', expectedAdmissionVersion: 'v1',
      decision: 'admitted', effectClaimed: true });
    expect(settled).toBe(true);
    await reconcileIngestionV2Omissions(s, input);
    expect((await s.store.getJob('role'))?.open).toBe(false);
  });

  it('prevents an evaluating consumer from claiming a publication after two omissions', async () => {
    const s = subject(); await seed(s, ['role']);
    s.sqlite.prepare("UPDATE ingestion_rows SET state='processing', lease_owner='consumer' WHERE external_id='role'").run();
    await omit(s, ['role'], 2);
    expect(await s.repository.claimRowEffect({ sourceId: 'source', externalId: 'role', owner: 'consumer', now: later,
      expectedSnapshotHash: 'present', expectedMaterialHash: 'role', expectedAdmissionVersion: 'v1' })).toBe(false);
    await reconcileIngestionV2Omissions(s, input);
    expect((await s.store.getJob('role'))?.open).toBe(false);
  });

  it('rejects an older retained active snapshot racing the closure transaction', async () => {
    const s = subject(); await seed(s, ['role']); await omit(s, ['role'], 2);
    await s.repository.putSnapshot({
      sourceId: 'source', snapshotHash: 'newer', objectKey: 'newer', admissionVersion: 'v1',
      documentCount: 1, rowCount: 0, state: 'staged', isComplete: true, baseline: false, createdAt: later,
    });
    s.race(() => s.sqlite.prepare("UPDATE ingestion_snapshots SET state='active', activated_at='2026-10-04T12:02:00.000Z' WHERE snapshot_hash='newer'").run());
    await expect(reconcileIngestionV2Omissions(s, input)).rejects.toThrow('bounded continuation');
    expect((await s.store.getJob('role'))?.open).toBe(true);
    expect(await s.repository.hasPendingOmissionClosures('source')).toBe(true);
    expect(await reconcileIngestionV2Omissions(s, { ...input, snapshotHash: 'newer' })).toMatchObject({ completed: 1 });
    expect((await s.store.getJob('role'))?.open).toBe(false);
  });

  it('reopens an unchanged quarantined reappearance and clears the old qualification streak', async () => {
    const s = subject(); await seed(s, ['role']);
    await s.repository.putRows([{ ...row('role'), state: 'quarantined', attemptCount: 3,
      qualificationCompleteSnapshots: 2, qualificationObservedSequence: 8, qualificationPending: true }]);
    await omit(s, ['role'], 2);
    const diff = planSnapshotDiff({ sourceId: 'source', snapshotHash: 'present', admissionVersion: 'v1', complete: true,
      now: later, rows: [{ externalId: 'role', materialHash: 'role' }], ledger: await s.repository.listLedger('source') });
    expect(diff.rows[0]?.classification).toBe('reappeared');
    expect(planSnapshotDiff({ sourceId: 'source', snapshotHash: 'absent', admissionVersion: 'v1', complete: true,
      now: later, rows: [], ledger: await s.repository.listLedger('source') }).omissionUpdates).toHaveLength(0);
    await s.repository.putRows([row('role')]);
    expect(await s.repository.getRow('source', 'role')).toMatchObject({ state: 'settled', attemptCount: 0,
      consecutiveOmissions: 0, qualificationCompleteSnapshots: 0, qualificationPending: false });
    expect((await s.repository.getRow('source', 'role'))?.qualificationObservedSequence).toBeUndefined();
    expect(await s.repository.reopenRows('source', ['role'], later)).toBe(1);
  });

  it('keeps new admission work durable when a closure continuation fails and recovers on snapshot reuse', async () => {
    const s = subject(); await seed(s, ['old-role']); await omit(s, ['old-role'], 2);
    const objects = new Map<string, string>();
    const snapshots: IngestionSnapshotObjectStore = {
      async put(key, body) { objects.set(key, body); }, async get(key) { return objects.get(key) ?? null; },
      async delete(key) { objects.delete(key); },
      async putSnapshot(envelope) {
        const key = snapshotObjectKey(envelope.sourceId, envelope.snapshotHash);
        const body = serializeEnvelope(envelope); const existed = objects.has(key); objects.set(key, body);
        return { key, bytes: body.length, existed };
      },
      async getSnapshot(sourceId, hash) {
        return parseEnvelope(objects.get(snapshotObjectKey(sourceId, hash))!, { sourceId, snapshotHash: hash });
      },
    };
    let lifecycleCalls = 0;
    const discovery = new IngestionV2ShadowDiscovery({
      repository: s.repository, snapshots, features: { shadowDiscoveryEnabled: true }, log: () => undefined,
      admissionEnabledForSource: () => true,
      reopenActionableRows: ({ sourceId, externalIds, now }) => s.repository.reopenRows(sourceId, externalIds, now),
      reconcileOmissions: async (args) => {
        lifecycleCalls += 1;
        if (lifecycleCalls === 1) throw new Error('continuation failure');
        await reconcileIngestionV2Omissions(s, args);
      },
    });
    const postings = [{ sourceId: 'source', externalId: 'new-role', sourceUrl: 'https://example.com/board',
      fetchedAt: later, employer: { name: 'Acme', authority: 'source-row' as const }, title: 'Software Engineering Intern',
      content: [], locations: ['Remote'], applyUrl: 'https://jobs.example.com/new-role', sourceState: 'open' as const,
      lifecycleAuthority: 'source' as const }];
    const envelope = normalizeSourceSnapshot({ sourceId: 'source', postings, admissionVersion: 'v1', observedAt: later });
    const args = { sourceId: 'source', postings, snapshotHash: envelope.snapshotHash, admissionVersion: 'v1',
      observedAt: later, now: later, baseline: false, legacyActiveExternalIds: ['new-role'], legacyActionableExternalIds: [],
      processed: { listings: [], decisions: [], counts: { raw: 1, valid: 1, eligible: 1, shelved: 0, filtered: 0, withheld: 0 } } };
    expect(await discovery.discover(args)).toMatchObject({ completed: false });
    expect(await s.repository.getRow('source', 'new-role')).toMatchObject({ state: 'queued' });
    expect(await discovery.discover(args)).toMatchObject({ completed: true });
    expect(lifecycleCalls).toBe(2);
    expect(await s.repository.getRow('source', 'new-role')).toMatchObject({ state: 'queued' });
    expect((await s.store.getJob('old-role'))?.open).toBe(false);
  });

  it('drains more than one bounded pass and lets healthy rows progress around a failing effect', async () => {
    const s = subject(); const ids = Array.from({ length: 57 }, (_, i) => `role-${String(i).padStart(3, '0')}`);
    await seed(s, ids); await omit(s, ids, 2);
    let calls = 0;
    const failing = { repository: s.repository, sink: { async closeOmission(args: Parameters<typeof s.sink.closeOmission>[0]) {
      calls += 1; if (args.externalId === ids[0]) throw new Error('poison effect');
      await s.sink.closeOmission(args);
    } } };
    await expect(reconcileIngestionV2Omissions(failing, input)).rejects.toThrow('remain pending');
    expect(calls).toBe(25);
    expect(await s.repository.listPendingOmissionClosures('source', 1000)).toHaveLength(25);
    await expect(reconcileIngestionV2Omissions(s, input)).rejects.toThrow('bounded continuation');
    expect(await reconcileIngestionV2Omissions(s, input)).toMatchObject({ attempted: 8, completed: 8 });
    expect(await s.repository.listPendingOmissionClosures('source', 25)).toHaveLength(0);
  });
});
