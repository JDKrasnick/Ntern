import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';
import { processAdmissionV2Message } from '../src/ingestion-v2/admission/consumer.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import { RuleBasedAdmissionV2Evaluator, type AdmissionDestinationProber } from '../src/ingestion-v2/admission/evaluator.js';
import { AdmissionInfrastructureError, AdmissionRowTransientError } from '../src/ingestion-v2/admission/taxonomy.js';
import { parseEnvelope, serializeEnvelope, snapshotObjectKey } from '../src/ingestion-v2/normalize.js';
import { IngestionV2ShadowDiscovery } from '../src/ingestion-v2/shadow-discovery.js';
import type { IngestionSnapshotObjectStore } from '../src/ingestion-v2/types.js';
import { processPosting } from '../src/ingestion/processor.js';
import type { SourcedPosting } from '../src/types.js';

const sourceId = 'vanshb03-summer-2027';
const roleId = 'silence-race';

function posting(externalId: string): SourcedPosting {
  return {
    sourceId, externalId, document: 'board', row: 1, provenance: 'reviewed-community',
    sourceUrl: 'https://example.com/board', applyUrl: `https://jobs.example.com/acme/${externalId}/apply`,
    employer: { id: 'acme', name: 'Acme', authority: 'source-row' }, title: 'Software Engineering Intern',
    locations: ['Remote'], content: [], lifecycleAuthority: 'posting', sourceState: 'open',
    fetchedAt: '2026-10-03T12:00:00Z',
  };
}

function setup() {
  const database = new DatabaseSync(':memory:');
  const directory = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    database.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  let beforeBatch: (() => Promise<void>) | undefined;
  const prepared = (sql: string, args: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...values: unknown[]) { return prepared(sql, values as SQLInputValue[]); },
    async first<T>() { return (database.prepare(sql).get(...args) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(sql).all(...args) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(sql).run(...args).changes) } }; },
  });
  const db: D1Database = { prepare: prepared, async batch(statements) {
    const hook = beforeBatch; beforeBatch = undefined; await hook?.();
    database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      database.exec('COMMIT'); return results;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  const objects = new Map<string, string>();
  const snapshots: IngestionSnapshotObjectStore = {
    async put(key, body) { objects.set(key, body); }, async get(key) { return objects.get(key) ?? null; },
    async delete(key) { objects.delete(key); },
    async putSnapshot(envelope) {
      const key = snapshotObjectKey(envelope.sourceId, envelope.snapshotHash);
      const body = serializeEnvelope(envelope); const existed = objects.has(key); objects.set(key, body);
      return { key, bytes: body.length, existed };
    },
    async getSnapshot(source, hash) {
      return parseEnvelope(objects.get(snapshotObjectKey(source, hash))!, { sourceId: source, snapshotHash: hash });
    },
  };
  const ledger = new D1IngestionV2Repository(db);
  const store = new D1InternshipStore(db);
  let tick = Date.parse('2026-10-03T12:00:00Z');
  const now = () => new Date(tick);
  const sink = new ReconcilerAdmissionV2CatalogSink(store, now);
  const prober: AdmissionDestinationProber = { async probe({ applyUrl, externalId }) {
    return { reachability: 'live', evidence: {
      url: applyUrl, title: 'Software Engineering Intern', description: 'Build software. Summer 2027 internship.',
      expectedPostingId: externalId, postingIdPresent: true, applicationFormPresent: true,
      closureState: 'open', confidence: { score: 1, level: 'high', recommendation: 'alert-eligible', signals: ['role-title', 'application-form'] },
    } };
  } };
  const discovery = new IngestionV2ShadowDiscovery({
    repository: ledger, snapshots, features: { shadowDiscoveryEnabled: true }, now, log() {},
    admissionEnabledForSource: () => true,
    reopenActionableRows: ({ sourceId: source, externalIds, admissionVersion, now: time }) =>
      ledger.reopenRows(source, externalIds, time, { admissionVersion }),
  });
  async function discover(rows: SourcedPosting[], sequence: number, baseline = false) {
    const result = await discovery.discover({
      sourceId, postings: rows, snapshotHash: 'legacy', admissionVersion: 'v1', baseline,
      completeFetchSequence: sequence, observedAt: now().toISOString(), now: now().toISOString(),
      legacyActionableExternalIds: [], legacyActiveExternalIds: rows.map((row) => row.externalId),
      processed: { listings: [], decisions: rows.map((row) => processPosting(row).decision),
        counts: { raw: rows.length, valid: rows.length, eligible: rows.length, shelved: 0, filtered: 0, withheld: 0 } },
    });
    expect(result.completed).toBe(true);
  }
  function evaluator(overrides: { prober?: AdmissionDestinationProber; sink?: typeof sink | { commit: typeof sink.commit; revoke: typeof sink.revoke } } = {}) {
    return new RuleBasedAdmissionV2Evaluator({
      sink: overrides.sink ?? sink, prober: overrides.prober ?? prober, now,
      trustedCommunityCatalogEnabled: true, trustedCommunityAlertsEnabledForSource: () => true,
      resolveCanonicalEmployer: async () => ({ id: 'acme', displayName: 'Acme' }),
      resolvePriorContext: async (source, externalId) => (await store.getSourceOccurrence(source, externalId))?.occurrence,
    });
  }
  const receipts = () => database.prepare("SELECT COUNT(*) AS n FROM catalog_items WHERE kind='notification-event'").get();
  return { database, ledger, store, snapshots, sink, prober, now, discover, evaluator, receipts,
    advance() { tick += 1000; }, beforeBatch(hook: () => Promise<void>) { beforeBatch = hook; } };
}

describe('notification silence changes during an owned admission lease', () => {
  it.each((['during-probe', 'after-claim', 'catalog-transaction'] as const).flatMap((phase) =>
    [false, true].map((published) => ({ phase, published }))))('fences $phase with prior publication=$published and persists quiet qualification', async ({ phase, published }) => {
    const s = setup();
    const role = posting(roleId);
    await s.discover([role, posting('omitted-peer')], 1);
    if (published) {
      const first = await planAdmissionV2Dispatch(sourceId, { ledger: s.ledger, now: s.now });
      for (const message of first.messages) {
        expect(await processAdmissionV2Message(message, { ledger: s.ledger, snapshots: s.snapshots, evaluator: s.evaluator(), now: s.now }))
          .toMatchObject({ acknowledged: true });
        await s.ledger.acknowledgeHandoff(message.batchId, s.now().toISOString());
      }
      expect((await s.store.getSourceOccurrence(sourceId, roleId))?.occurrence.trustedCommunityAlertQualification)
        .toMatchObject({ baselineSuppressed: false, status: 'pending' });
    }
    s.advance();
    await s.discover([role], 2);
    const plan = await planAdmissionV2Dispatch(sourceId, { ledger: s.ledger, now: s.now });
    const message = plan.messages.find((entry) => entry.externalIds.includes(roleId))!;
    expect(message.baseline).toBe(false);
    let capturedLease: Awaited<ReturnType<typeof s.ledger.getRow>>;
    let flipped = false;
    async function flipBaseline() {
      if (flipped) return; flipped = true;
      capturedLease = await s.ledger.getRow(sourceId, roleId);
      expect(capturedLease).toMatchObject({ state: 'processing', notificationBaseline: false, attemptCount: 0 });
      s.advance(); await s.discover([role], 3, true);
      const after = await s.ledger.getRow(sourceId, roleId);
      expect(after).toMatchObject({ state: 'processing', notificationBaseline: true,
        snapshotHash: capturedLease!.snapshotHash, materialHash: capturedLease!.materialHash,
        admissionVersion: capturedLease!.admissionVersion, leaseOwner: capturedLease!.leaseOwner,
        leaseExpiresAt: capturedLease!.leaseExpiresAt });
    }
    const evaluator = s.evaluator({
      prober: { async probe(args) {
        if (phase === 'during-probe' && args.externalId === roleId) await flipBaseline();
        return s.prober.probe(args);
      } },
      sink: { revoke: s.sink.revoke.bind(s.sink), async commit(args) {
        if (args.externalId === roleId) {
          if (phase === 'after-claim') await flipBaseline();
          if (phase === 'catalog-transaction') s.beforeBatch(flipBaseline);
        }
        return s.sink.commit(args);
      } },
    });
    const result = await processAdmissionV2Message(message, { ledger: s.ledger, snapshots: s.snapshots, evaluator, now: s.now });
    expect(result).toMatchObject({ acknowledged: true, skipped: message.externalIds.length, settled: 0, retried: 0, quarantined: 0 });
    expect(flipped).toBe(true);
    expect(await s.ledger.getRow(sourceId, roleId)).toMatchObject({ state: 'queued', notificationBaseline: true, attemptCount: 0 });
    expect((await s.ledger.getRow(sourceId, roleId))?.leaseOwner).toBeUndefined();
    expect(s.receipts()).toEqual({ n: 0 });
    if (!published) expect(await s.store.getSourceOccurrence(sourceId, roleId)).toBeUndefined();
    else expect((await s.store.getSourceOccurrence(sourceId, roleId))?.occurrence.trustedCommunityAlertQualification)
      .toMatchObject({ baselineSuppressed: false, status: 'pending' });
    // Reuse the old baseline=false ticket: the durable row wins on reevaluation.
    const quiet = await processAdmissionV2Message(message, { ledger: s.ledger, snapshots: s.snapshots, evaluator: s.evaluator(), now: s.now });
    expect(quiet).toMatchObject({ acknowledged: true, settled: 1, retried: 0 });
    const occurrence = await s.store.getSourceOccurrence(sourceId, roleId);
    expect(occurrence?.occurrence.trustedCommunityAlertQualification).toMatchObject({ baselineSuppressed: true });
    expect(occurrence?.occurrence.admission).toMatchObject({ catalogEligible: true, alertEligible: false });
    expect((await s.store.getJob(occurrence!.jobId))?.open).toBe(true);
    expect(s.receipts()).toEqual({ n: 0 });
    expect(await s.ledger.getRow(sourceId, roleId)).toMatchObject({ state: 'settled', attemptCount: 1, notificationBaseline: true });
    s.database.close();
  });

  it.each(['snapshot', 'material', 'policy', 'expiry'] as const)('does not release a replacement %s lease owned by the same batch', async (replacement) => {
    const s = setup(); await s.discover([posting(roleId)], 1);
    const row = (await s.ledger.getRow(sourceId, roleId))!;
    const lease = await s.ledger.acquireLease({ sourceId, externalId: roleId, owner: 'same-owner', now: s.now().toISOString(), leaseMs: 120_000,
      expectedSnapshotHash: row.snapshotHash, expectedMaterialHash: row.materialHash, expectedAdmissionVersion: 'v1' });
    expect(lease.outcome).toBe('acquired');
    const old = (await s.ledger.getRow(sourceId, roleId))!;
    const column = { snapshot: 'snapshot_hash', material: 'material_hash', policy: 'admission_version', expiry: 'lease_expires_at' }[replacement];
    s.database.prepare(`UPDATE ingestion_rows SET ${column}=? WHERE source_id=? AND external_id=?`).run('replacement', sourceId, roleId);
    const before = await s.ledger.getRow(sourceId, roleId);
    expect(await s.ledger.releaseLease(sourceId, roleId, 'same-owner', s.now().toISOString(), {
      expectedSnapshotHash: old.snapshotHash, expectedMaterialHash: old.materialHash, expectedAdmissionVersion: 'v1', expectedLeaseExpiresAt: old.leaseExpiresAt,
    })).toBe(false);
    expect(await s.ledger.getRow(sourceId, roleId)).toEqual(before);
    s.database.close();
  });

  it('guards asynchronous infrastructure-failure release against a same-owner reacquisition', async () => {
    const s = setup(); await s.discover([posting(roleId)], 1);
    const plan = await planAdmissionV2Dispatch(sourceId, { ledger: s.ledger, now: s.now });
    const message = plan.messages[0]!;
    const replacementExpiry = '2026-10-03T13:00:00.000Z';
    const evaluator = s.evaluator({ prober: { async probe() {
      s.database.prepare("UPDATE ingestion_rows SET lease_expires_at=? WHERE source_id=? AND external_id=?").run(replacementExpiry, sourceId, roleId);
      throw new AdmissionInfrastructureError('internal', 'lost async response');
    } } });
    const result = await processAdmissionV2Message(message, { ledger: s.ledger, snapshots: s.snapshots, evaluator, now: s.now });
    expect(result).toMatchObject({ acknowledged: false, settled: 0, retried: 0 });
    expect(await s.ledger.getRow(sourceId, roleId)).toMatchObject({ state: 'processing', leaseExpiresAt: replacementExpiry, attemptCount: 0 });
    s.database.close();
  });

  it.each(['retry', 'quarantine'] as const)('rejects a stale %s failure after actual same-owner lease reacquisition', async (transition) => {
    const s = setup(); await s.discover([posting(roleId)], 1);
    const initialAttempts = transition === 'quarantine' ? 2 : 0;
    s.database.prepare('UPDATE ingestion_rows SET attempt_count=? WHERE source_id=? AND external_id=?').run(initialAttempts, sourceId, roleId);
    const plan = await planAdmissionV2Dispatch(sourceId, { ledger: s.ledger, now: s.now });
    const message = plan.messages[0]!;
    let replacement: Awaited<ReturnType<typeof s.ledger.getRow>>;
    const evaluator = s.evaluator({ prober: { async probe() {
      const old = (await s.ledger.getRow(sourceId, roleId))!;
      // Move beyond the old expiry, then acquire through the real D1 primitive
      // using the same owner and unchanged snapshot/material/policy identity.
      for (let second = 0; second < 121; second += 1) s.advance();
      expect(await s.ledger.acquireLease({ sourceId, externalId: roleId, owner: old.leaseOwner!,
        now: s.now().toISOString(), leaseMs: 120_000, expectedSnapshotHash: old.snapshotHash,
        expectedMaterialHash: old.materialHash, expectedAdmissionVersion: old.admissionVersion })).toMatchObject({ outcome: 'acquired' });
      replacement = await s.ledger.getRow(sourceId, roleId);
      expect(replacement?.leaseExpiresAt).not.toBe(old.leaseExpiresAt);
      throw new AdmissionRowTransientError('upstream-server-error', 'old response arrived after reacquisition');
    } } });
    const result = await processAdmissionV2Message(message, { ledger: s.ledger, snapshots: s.snapshots, evaluator, now: s.now });
    expect(result).toMatchObject({ acknowledged: true, skipped: 1, settled: 0, retried: 0, quarantined: 0 });
    expect(await s.ledger.getRow(sourceId, roleId)).toEqual(replacement);
    expect(replacement).toMatchObject({ state: 'processing', attemptCount: initialAttempts });
    expect(s.receipts()).toEqual({ n: 0 });
    s.database.close();
  });

  it.each(['retry', 'quarantine'] as const)('rejects a stale %s after discovery flips baseline and immediately reevaluates quietly', async (transition) => {
    const s = setup(); const role = posting(roleId);
    await s.discover([role, posting('omitted-peer')], 1); s.advance();
    await s.discover([role], 2);
    const initialAttempts = transition === 'quarantine' ? 2 : 0;
    s.database.prepare('UPDATE ingestion_rows SET attempt_count=? WHERE source_id=? AND external_id=?').run(initialAttempts, sourceId, roleId);
    const plan = await planAdmissionV2Dispatch(sourceId, { ledger: s.ledger, now: s.now });
    const message = plan.messages.find((entry) => entry.externalIds.includes(roleId))!;
    const evaluator = s.evaluator({ prober: { async probe() {
      const before = (await s.ledger.getRow(sourceId, roleId))!;
      expect(before).toMatchObject({ state: 'processing', notificationBaseline: false, attemptCount: initialAttempts });
      s.advance(); await s.discover([role], 3, true);
      expect(await s.ledger.getRow(sourceId, roleId)).toMatchObject({ state: 'processing', notificationBaseline: true,
        leaseOwner: before.leaseOwner, leaseExpiresAt: before.leaseExpiresAt, materialHash: before.materialHash });
      throw new AdmissionRowTransientError('upstream-server-error', 'old unsilenced evaluation failed');
    } } });
    const result = await processAdmissionV2Message(message, { ledger: s.ledger, snapshots: s.snapshots, evaluator, now: s.now });
    expect(result).toMatchObject({ acknowledged: true, skipped: 1, settled: 0, retried: 0, quarantined: 0 });
    const queued = (await s.ledger.getRow(sourceId, roleId))!;
    expect(queued).toMatchObject({ state: 'queued', notificationBaseline: true, attemptCount: initialAttempts });
    expect(queued.leaseOwner).toBeUndefined();
    expect(queued.retryAt).toBeUndefined();
    expect(queued.failureClass).toBeUndefined();
    expect(s.receipts()).toEqual({ n: 0 });
    const quiet = await processAdmissionV2Message(message, { ledger: s.ledger, snapshots: s.snapshots, evaluator: s.evaluator(), now: s.now });
    expect(quiet).toMatchObject({ acknowledged: true, settled: 1, retried: 0, quarantined: 0 });
    const occurrence = (await s.store.getSourceOccurrence(sourceId, roleId))!;
    expect(occurrence.occurrence.trustedCommunityAlertQualification).toMatchObject({ baselineSuppressed: true });
    expect(occurrence.occurrence.admission).toMatchObject({ catalogEligible: true, alertEligible: false });
    expect((await s.store.getJob(occurrence.jobId))?.open).toBe(true);
    expect(s.receipts()).toEqual({ n: 0 });
    expect(await s.ledger.getRow(sourceId, roleId)).toMatchObject({ state: 'settled', attemptCount: initialAttempts + 1 });
    s.database.close();
  });
});
