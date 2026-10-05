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

function setup(gate?: { phase: 'pre-claim' | 'post-claim'; entered: () => void; wait: Promise<void> }) {
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
    sink: {
      async commit(input) {
        if (gate?.phase === 'post-claim') { gate.entered(); await gate.wait; }
        await sink.commit(input);
      },
      revoke: sink.revoke.bind(sink),
    }, now, trustedCommunityCatalogEnabled: true, trustedCommunityAlertsEnabledForSource: () => true,
    resolveCanonicalEmployer: async () => ({ id: 'acme', displayName: 'Acme' }),
    resolvePriorContext: async (source, id) => (await store.getSourceOccurrence(source, id))?.occurrence,
    prober: { async probe({ applyUrl, externalId }) {
      probes++;
      if (gate?.phase === 'pre-claim') { gate.entered(); await gate.wait; }
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
    advance() { tick += 1000; }, setFail(value: boolean) { fail = value; },
    setAdmissionEnabled(value: boolean) { admissionEnabled = value; },
    metrics: () => ({ probes, snapshotWrites }),
  };
}


function notificationReceipts(database: DatabaseSync): number {
  return Number((database.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind = 'notification-event'").get() as { n: number }).n);
}


function pauseAt(phase: 'pre-claim' | 'post-claim') {
  let resume!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { resume = resolve; });
  return { phase, entered, wait, reached, resume };
}

async function qualifyingMessage(s: ReturnType<typeof setup>) {
  // A retained peer's first omission makes the later same-hash discovery
  // persist the silence fence instead of taking the snapshot reuse shortcut.
  await s.discover(1, [posting(), posting('omitted-peer')]);
  s.advance(); await s.discover(2);
  const plan = await planAdmissionV2Dispatch(sourceId, { ledger: s.ledger, now: s.now });
  const selected = plan.messages.filter(message => message.externalIds.includes('generic-role'));
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({ baseline: false, admissionVersion: 'v1', externalIds: ['generic-role'] });
  return selected[0]!;
}

function effectClaim(database: DatabaseSync) {
  return database.prepare('SELECT effect_claimed_at FROM ingestion_rows WHERE source_id = ? AND external_id = ?')
    .get(sourceId, 'generic-role') as { effect_claimed_at: string | null };
}

describe('durable silence changing during a leased admission', () => {
  it.each(['pre-claim', 'post-claim'] as const)(
    'rejects the stale %s evaluation and recovers a visible silent role',
    async phase => {
      const gate = pauseAt(phase);
      const s = setup(gate);
      let delivery: ReturnType<typeof processAdmissionV2Message> | undefined;
      try {
        const message = await qualifyingMessage(s);
        delivery = processAdmissionV2Message(message, {
          ledger: s.ledger, snapshots: s.snapshots, evaluator: s.evaluator, now: s.now,
        });
        const reached = await Promise.race([gate.reached.then(() => true), delivery.then(() => false)]);
        expect(reached).toBe(true);
        const leased = await s.ledger.getRow(sourceId, 'generic-role');
        expect(leased).toMatchObject({
          state: 'processing', notificationBaseline: false, qualificationCompleteSnapshots: 2,
        });
        if (phase === 'pre-claim') expect(effectClaim(s.database).effect_claimed_at).toBeNull();
        else expect(effectClaim(s.database).effect_claimed_at).not.toBeNull();

        s.advance(); const hash = await s.discover(3, [posting()], true);
        const fenced = await s.ledger.getRow(sourceId, 'generic-role');
        expect(hash).toBe(message.snapshotHash);
        expect(fenced).toMatchObject({
          state: 'processing', notificationBaseline: true, snapshotHash: leased!.snapshotHash,
          materialHash: leased!.materialHash, admissionVersion: 'v1',
          leaseOwner: leased!.leaseOwner, leaseExpiresAt: leased!.leaseExpiresAt,
        });
        if (phase === 'pre-claim') expect(effectClaim(s.database).effect_claimed_at).toBeNull();
        else expect(effectClaim(s.database).effect_claimed_at).not.toBeNull();

        gate.resume();
        const stale = await delivery;
        expect(notificationReceipts(s.database)).toBe(0);
        expect(stale).toMatchObject({ acknowledged: true, settled: 0, skipped: 1 });
        await s.ledger.acknowledgeHandoff(message.batchId, s.now().toISOString());
        const queued = await s.ledger.getRow(sourceId, 'generic-role');
        expect(queued).toMatchObject({ state: 'queued', notificationBaseline: true });
        expect(queued?.leaseOwner).toBeUndefined();
        expect(queued?.leaseExpiresAt).toBeUndefined();
        expect(effectClaim(s.database).effect_claimed_at).toBeNull();

        const recovery = await s.drain();
        expect(recovery).toHaveLength(1);
        expect(recovery[0]).toMatchObject({ baseline: true, admissionVersion: 'v1' });
        const occurrence = await s.store.getSourceOccurrence(sourceId, 'generic-role');
        expect(occurrence?.occurrence.trustedCommunityAlertQualification).toMatchObject({
          status: 'eligible', baselineSuppressed: true,
        });
        expect(occurrence?.occurrence.admission).toMatchObject({ catalogEligible: true, alertEligible: false });
        expect(await s.store.getJob(occurrence!.jobId)).toMatchObject({
          open: true, admission: { catalogEligible: true, alertEligible: false },
        });
        expect((await s.store.listOpen()).jobs).toHaveLength(1);
        expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({
          state: 'settled', decision: 'admitted', notificationBaseline: true, qualificationPending: false,
        });
        expect(notificationReceipts(s.database)).toBe(0);
        s.advance(); await s.discover(4, [posting()]);
        expect(await s.drain()).toHaveLength(0);
        expect(notificationReceipts(s.database)).toBe(0);
      } finally {
        gate.resume();
        if (delivery) await delivery;
        s.database.close();
      }
    },
  );

  it('publishes one new-role receipt when the qualifying evaluation is not fenced', async () => {
    const s = setup();
    try {
      const message = await qualifyingMessage(s);
      const result = await processAdmissionV2Message(message, {
        ledger: s.ledger, snapshots: s.snapshots, evaluator: s.evaluator, now: s.now,
      });
      expect(result).toMatchObject({ acknowledged: true, settled: 1, counts: { admitted: 1 } });
      const occurrence = await s.store.getSourceOccurrence(sourceId, 'generic-role');
      expect(occurrence?.occurrence.trustedCommunityAlertQualification).toMatchObject({
        status: 'eligible', consecutiveCompleteSnapshots: 2, baselineSuppressed: false,
      });
      expect(occurrence?.occurrence.admission).toMatchObject({ catalogEligible: true, alertEligible: true });
      expect((await s.store.listOpen()).jobs).toHaveLength(1);
      expect(notificationReceipts(s.database)).toBe(1);
    } finally {
      s.database.close();
    }
  });
});
