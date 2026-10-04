import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1IngestionV2Repository, R2IngestionSnapshotStore } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement, R2Bucket } from '../cloudflare/types.js';
import { IngestionV2ShadowDiscovery } from '../src/ingestion-v2/shadow-discovery.js';
import { processPosting } from '../src/ingestion/processor.js';
import { processAdmissionV2Message } from '../src/ingestion-v2/admission/consumer.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import { RuleBasedAdmissionV2Evaluator } from '../src/ingestion-v2/admission/evaluator.js';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';
import { AdmissionRowTransientError } from '../src/ingestion-v2/admission/taxonomy.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { SourcedPosting } from '../src/types.js';

const sourceId = 'vanshb03-summer-2027';
function posting(externalId = 'generic-role'): SourcedPosting {
  return {
    sourceId, externalId, document: 'board', row: 1, provenance: 'reviewed-community',
    sourceUrl: 'https://example.com/board', applyUrl: `https://jobs.example.com/acme/${externalId}/apply`,
    employer: { id: 'acme', name: 'Acme', authority: 'source-row' },
    title: 'Software Engineering Intern', locations: ['Remote'], content: [],
    lifecycleAuthority: 'posting', sourceState: 'open', fetchedAt: '2026-10-03T12:00:00Z',
  };
}

function setup() {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(query).run(...values).changes) } }; },
  });
  const db: D1Database = { prepare: prepared, async batch(statements) {
    database.exec('BEGIN');
    try {
      const result = []; for (const statement of statements) result.push(await statement.run());
      database.exec('COMMIT'); return result;
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  const objects = new Map<string, string>();
  let snapshotWrites = 0;
  const snapshots = new R2IngestionSnapshotStore({
    async get(key: string) { const body = objects.get(key); return body ? { body: new Response(body).body } : null; },
    async put(key: string, value: string) { snapshotWrites++; objects.set(key, value); },
    async delete(key: string) { objects.delete(key); },
  } as unknown as R2Bucket);
  const ledger = new D1IngestionV2Repository(db);
  let tick = Date.parse('2026-10-03T12:00:00Z');
  const now = () => new Date(tick);
  const store = new D1InternshipStore(db);
  const sink = new ReconcilerAdmissionV2CatalogSink(store, now);
  let probes = 0;
  let fail = false;
  let admissionEnabled = true;
  const evaluator = new RuleBasedAdmissionV2Evaluator({
    sink, now, trustedCommunityCatalogEnabled: true, trustedCommunityAlertsEnabledForSource: () => true,
    resolveCanonicalEmployer: async () => ({ id: 'acme', displayName: 'Acme' }),
    resolvePriorContext: async (source, id) => (await store.getSourceOccurrence(source, id))?.occurrence,
    prober: { async probe({ applyUrl, externalId }) {
      probes++;
      if (fail) throw new AdmissionRowTransientError('upstream-server-error', '503');
      return { reachability: 'live', evidence: {
        url: applyUrl, title: 'Software Engineering Intern', description: 'Build software. Summer 2027 internship.',
        expectedPostingId: externalId, postingIdPresent: true, applicationFormPresent: true,
        closureState: 'open', confidence: { score: 1, level: 'high', recommendation: 'alert-eligible', signals: ['role-title', 'application-form'] },
      } };
    } },
  });
  const discovery = new IngestionV2ShadowDiscovery({
    repository: ledger, snapshots, features: { shadowDiscoveryEnabled: true }, now, log() {},
    admissionEnabledForSource: () => admissionEnabled,
    reopenActionableRows: ({ sourceId: source, externalIds, admissionVersion, now: time }) =>
      ledger.reopenRows(source, externalIds, time, { admissionVersion }),
  });
  async function discover(sequence?: number, rows = [posting()], baseline = false, policy = 'v1') {
    const decisions = rows.map(p => processPosting(p).decision);
    const result = await discovery.discover({
      sourceId, postings: rows, processed: { decisions, listings: [], counts: {} } as never,
      snapshotHash: 'legacy', admissionVersion: policy, baseline, completeFetchSequence: sequence,
      observedAt: now().toISOString(), now: now().toISOString(), legacyActionableExternalIds: [],
      legacyActiveExternalIds: rows.map(p => p.externalId),
    });
    expect(result.completed).toBe(true);
    return result.snapshotHash!;
  }
  async function drain() {
    const plan = await planAdmissionV2Dispatch(sourceId, { ledger, now });
    for (const message of plan.messages) {
      const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator, now });
      if (result.acknowledged) await ledger.acknowledgeHandoff(message.batchId, now().toISOString());
    }
    return plan.messages;
  }
  return { database, ledger, snapshots, store, evaluator, discover, drain, now,
    advance() { tick += 900_000; }, setFail(value: boolean) { fail = value; },
    setAdmissionEnabled(value: boolean) { admissionEnabled = value; },
    metrics: () => ({ probes, snapshotWrites }),
  };
}


function notificationReceipts(database: DatabaseSync): number {
  return Number((database.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind = 'notification-event'").get() as { n: number }).n);
}

describe('retained role baseline origin across material replacement', () => {
  it('keeps a quarantined unpublished baseline role silent while a new neighbor promotes', async () => {
    const s = setup();
    try {
      const original = posting('baseline-poison');
      s.setFail(true);
      await s.discover(1, [original], true);
      for (let attempt = 0; attempt < 3; attempt++) {
        await s.drain();
        s.advance();
      }
      const before = (await s.ledger.getRow(sourceId, original.externalId))!;
      expect(before).toMatchObject({ state: 'quarantined', attemptCount: 3, notificationBaseline: true });
      expect(await s.store.getSourceOccurrence(sourceId, original.externalId)).toBeUndefined();
      expect((await s.store.listOpen()).jobs).toHaveLength(0);
      expect(notificationReceipts(s.database)).toBe(0);
      const retained = await s.snapshots.getSnapshot(sourceId, before.snapshotHash);
      expect(retained.rows[0]?.firstObservationEligible).toBe(true);

      s.setFail(false);
      const changed: SourcedPosting = { ...original, content: [{
        kind: 'description', format: 'plain', value: 'Build software. Summer 2027 internship. Updated application details.',
      }] };
      const neighbor = posting('new-neighbor');
      await s.discover(2, [changed, neighbor]);
      const replaced = (await s.ledger.getRow(sourceId, original.externalId))!;
      expect(replaced.materialHash).not.toBe(before.materialHash);
      expect(replaced).toMatchObject({ state: 'queued', notificationBaseline: true, firstObservedAt: before.firstObservedAt });
      const replacementSnapshot = await s.snapshots.getSnapshot(sourceId, replaced.snapshotHash);
      expect(replacementSnapshot.rows.find(row => row.externalId === original.externalId)?.firstObservationEligible).toBe(true);
      expect(await s.ledger.getRow(sourceId, neighbor.externalId)).toMatchObject({ notificationBaseline: false });
      await s.drain();
      expect(notificationReceipts(s.database)).toBe(0);
      s.advance();
      await s.discover(3, [changed, neighbor]);
      await s.drain();

      const baselineOccurrence = (await s.store.getSourceOccurrence(sourceId, original.externalId))!;
      expect(baselineOccurrence.occurrence.trustedCommunityAlertQualification?.baselineSuppressed).toBe(true);
      expect(baselineOccurrence.occurrence.admission).toMatchObject({ catalogEligible: true, alertEligible: false });
      expect(await s.store.getJob(baselineOccurrence.jobId)).toMatchObject({ open: true, technical: true, admission: { alertEligible: false } });
      expect(await s.ledger.getRow(sourceId, original.externalId)).toMatchObject({
        state: 'settled', notificationBaseline: true, qualificationPending: false,
        qualificationCompleteSnapshots: 2, firstObservedAt: before.firstObservedAt,
      });
      const freshOccurrence = (await s.store.getSourceOccurrence(sourceId, neighbor.externalId))!;
      expect(freshOccurrence.occurrence.trustedCommunityAlertQualification).toMatchObject({
        status: 'eligible', basis: 'two-complete-snapshots', baselineSuppressed: false,
      });
      expect(await s.store.getJob(freshOccurrence.jobId)).toMatchObject({ open: true, admission: { alertEligible: true } });
      expect((await s.store.listOpen()).jobs).toHaveLength(2);
      expect(notificationReceipts(s.database)).toBe(1);
      const receipts = s.database.prepare("SELECT value FROM catalog_items WHERE kind = 'notification-event'").all();
      expect(JSON.stringify(receipts)).toContain('new-neighbor');
      expect(JSON.stringify(receipts)).not.toContain('baseline-poison');
      s.advance();
      await s.discover(4, [changed, neighbor]);
      expect(await s.drain()).toHaveLength(0);
      expect(notificationReceipts(s.database)).toBe(1);
    } finally { s.database.close(); }
  });
});
