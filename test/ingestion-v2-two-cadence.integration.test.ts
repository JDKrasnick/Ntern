import { readFileSync } from 'node:fs';
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
import { MemoryInternshipStore } from '../src/store.js';
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
  for (const file of ['0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql',
    '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql',
    '0050_ingestion_v2_omission_closure.sql', '0051_ingestion_v2_qualification_cadence.sql']) {
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
  const store = new MemoryInternshipStore();
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

describe('trusted community two complete cadence promotion', () => {
  it.each(['settled', 'queued', 'processing'] as const)('preserves %s qualification ownership when source admission is disabled', async (state) => {
    const s = setup();
    const hash = await s.discover(1); await s.drain();
    if (state !== 'settled') await s.discover(2);
    if (state === 'processing') {
      const row = (await s.ledger.getRow(sourceId, 'generic-role'))!;
      await s.ledger.acquireLease({
        sourceId, externalId: row.externalId, owner: 'active-owner', now: s.now().toISOString(), leaseMs: 120_000,
        expectedSnapshotHash: hash, expectedMaterialHash: row.materialHash, expectedAdmissionVersion: row.admissionVersion,
      });
    }
    const before = await s.ledger.getRow(sourceId, 'generic-role');
    expect(before).toMatchObject({ state, qualificationPending: true });
    const snapshot = await s.ledger.getSnapshot(sourceId, hash);
    s.setAdmissionEnabled(false);
    await s.discover(3);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toEqual(before);
    expect(await s.ledger.getSnapshot(sourceId, hash)).toEqual(snapshot);
    expect(s.metrics()).toEqual({ probes: 1, snapshotWrites: 1 });
    expect(s.store.notificationEvents.size).toBe(0);
    if (state === 'settled') expect(await s.drain()).toHaveLength(0);
  });

  it('promotes the durable occurrence and existing job once; duplicate and third cadence remain silent', async () => {
    const s = setup();
    const hash = await s.discover(1);
    const first = await s.drain();
    expect(first).toHaveLength(1);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ state: 'settled', qualificationPending: true, completeFetchSequence: 1 });
    expect((await s.store.getSourceOccurrence(sourceId, 'generic-role'))?.occurrence.admission).toMatchObject({ catalogEligible: true, alertEligible: false });
    expect(s.store.notificationEvents.size).toBe(0);
    await s.discover(1);
    expect(await s.drain()).toHaveLength(0);
    s.advance();
    expect(await s.discover(2)).toBe(hash);
    const second = await s.drain();
    expect(second).toHaveLength(1);
    await processAdmissionV2Message(second[0]!, { ledger: s.ledger, snapshots: s.snapshots, evaluator: s.evaluator, now: s.now });
    const occurrence = await s.store.getSourceOccurrence(sourceId, 'generic-role');
    expect(occurrence?.occurrence.trustedCommunityAlertQualification).toMatchObject({ status: 'eligible', basis: 'two-complete-snapshots', consecutiveCompleteSnapshots: 2 });
    expect(occurrence?.occurrence.admission?.alertEligible).toBe(true);
    expect(await s.store.getJob(occurrence!.jobId)).toMatchObject({ open: true, admission: { alertEligible: true }, notification: { smsPending: true, digestPending: true } });
    expect(s.store.jobs.size).toBe(1);
    expect(s.store.notificationEvents.size).toBe(1);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ completeFetchSequence: 2, qualificationPending: false });
    s.advance(); await s.discover(3);
    expect(await s.drain()).toHaveLength(0);
    expect(s.metrics()).toEqual({ probes: 2, snapshotWrites: 1 });
  });

  it('requires explicit cadence and does not count retry or continuation deliveries', async () => {
    const s = setup();
    await s.discover(); await s.drain();
    expect((await s.store.getSourceOccurrence(sourceId, 'generic-role'))?.occurrence.trustedCommunityAlertQualification?.consecutiveCompleteSnapshots).toBe(0);
    await s.discover(); expect(await s.drain()).toHaveLength(0);
    await s.discover(1); s.setFail(true); await s.drain();
    const retry = await s.ledger.getRow(sourceId, 'generic-role');
    expect(retry).toMatchObject({ state: 'queued', attemptCount: 1 });
    await s.discover(1);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ state: 'queued', attemptCount: 1, retryAt: retry!.retryAt });
    s.advance(); s.setFail(false); await s.drain();
    expect(s.store.notificationEvents.size).toBe(0);
    await s.discover(); expect(await s.drain()).toHaveLength(0);
    await s.discover(2); await s.drain();
    expect(s.store.notificationEvents.size).toBe(1);
  });

  it('resets the streak after an omitted complete cadence', async () => {
    const s = setup();
    await s.discover(1); await s.drain();
    await s.discover(2, [posting('peer')]); await s.drain();
    s.advance(); await s.discover(3); await s.drain();
    expect(s.store.notificationEvents.size).toBe(0);
    expect((await s.store.getSourceOccurrence(sourceId, 'generic-role'))?.occurrence.trustedCommunityAlertQualification?.consecutiveCompleteSnapshots).toBe(1);
    s.advance(); await s.discover(4); await s.drain();
    expect(s.store.notificationEvents.size).toBe(1);
  });

  it('requires two cadences of changed material and resets a sequence gap', async () => {
    const s = setup();
    await s.discover(1); await s.drain();
    const changed = { ...posting(), title: 'Software Engineering Intern - Infrastructure' };
    s.advance(); await s.discover(2, [changed]); await s.drain();
    expect(s.store.notificationEvents.size).toBe(0);
    const firstChanged = (await s.store.getSourceOccurrence(sourceId, 'generic-role'))?.occurrence.trustedCommunityAlertQualification;
    expect(firstChanged).toMatchObject({ consecutiveCompleteSnapshots: 1, lastCountedSuccessfulFetchSequence: 2 });
    s.advance(); await s.discover(4, [changed]); await s.drain();
    expect(s.store.notificationEvents.size).toBe(0);
    expect((await s.store.getSourceOccurrence(sourceId, 'generic-role'))?.occurrence.trustedCommunityAlertQualification?.consecutiveCompleteSnapshots).toBe(1);
    s.advance(); await s.discover(5, [changed]); await s.drain();
    expect(s.store.notificationEvents.size).toBe(1);
  });

  it('preserves processing ownership during reused snapshot cadence updates', async () => {
    const s = setup();
    const hash = await s.discover(1); await s.drain();
    s.advance(); await s.discover(2);
    const row = (await s.ledger.getRow(sourceId, 'generic-role'))!;
    await s.ledger.acquireLease({
      sourceId, externalId: row.externalId, owner: 'active-owner', now: s.now().toISOString(), leaseMs: 120_000,
      expectedSnapshotHash: hash, expectedMaterialHash: row.materialHash, expectedAdmissionVersion: row.admissionVersion,
    });
    await s.discover(3);
    expect(await s.ledger.getRow(sourceId, row.externalId)).toMatchObject({ state: 'processing', leaseOwner: 'active-owner', completeFetchSequence: 1 });
    expect(await s.ledger.getSnapshot(sourceId, hash)).toMatchObject({ completeFetchSequence: 3 });
    await s.discover(2);
    expect(await s.ledger.getSnapshot(sourceId, hash)).toMatchObject({ completeFetchSequence: 3 });
    expect(s.metrics().snapshotWrites).toBe(1);
  });

  it('does not observe retained omitted or absent rows even with matching snapshot hash', async () => {
    const s = setup();
    const hash = await s.discover(1); await s.drain();
    await s.ledger.applyOmissions(sourceId, [{ externalId: 'generic-role', consecutiveOmissions: 1, becomesAbsent: false }], s.now().toISOString());
    expect(await s.ledger.recordCompleteCadence(sourceId, hash, 'v1', 2, s.now().toISOString())).toBe(0);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ qualificationObservedSequence: 1, qualificationCompleteSnapshots: 1 });
    await s.ledger.applyOmissions(sourceId, [{ externalId: 'generic-role', consecutiveOmissions: 2, becomesAbsent: true }], s.now().toISOString());
    expect(await s.ledger.recordCompleteCadence(sourceId, hash, 'v1', 3, s.now().toISOString())).toBe(0);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ state: 'absent', qualificationObservedSequence: 1, qualificationCompleteSnapshots: 1 });
  });

  it('retains two cadence observations before first queue consumption', async () => {
    const s = setup();
    await s.discover(1);
    await s.discover(1);
    await s.discover(2);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ state: 'queued', qualificationObservedSequence: 2, qualificationCompleteSnapshots: 2 });
    await s.drain();
    expect(s.metrics().probes).toBe(1);
    expect(s.store.notificationEvents.size).toBe(1);
    expect((await s.store.getSourceOccurrence(sourceId, 'generic-role'))?.occurrence.trustedCommunityAlertQualification).toMatchObject({ status: 'eligible', consecutiveCompleteSnapshots: 2 });
  });

  it('does not lose a newer cadence arriving between evaluation and settlement', async () => {
    const s = setup();
    await s.discover(1);
    const plan = await planAdmissionV2Dispatch(sourceId, { ledger: s.ledger, now: s.now });
    for (const message of plan.messages) {
      const result = await processAdmissionV2Message(message, {
        ledger: s.ledger, snapshots: s.snapshots, now: s.now,
        evaluator: { async evaluate(context) {
          const evaluation = await s.evaluator.evaluate(context);
          await s.discover(2);
          return evaluation;
        } },
      });
      expect(result.acknowledged).toBe(true);
      await s.ledger.acknowledgeHandoff(message.batchId, s.now().toISOString());
    }
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ state: 'queued', qualificationPending: true, qualificationObservedSequence: 2, completeFetchSequence: 1 });
    s.advance(); await s.drain();
    expect(s.store.notificationEvents.size).toBe(1);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ state: 'settled', completeFetchSequence: 2 });
  });

  it('queues all 570 pending promotions while each dispatcher pass stays bounded at 500 rows', async () => {
    const s = setup();
    const rows = Array.from({ length: 570 }, (_, index) => posting(`role-${String(index).padStart(3, '0')}`));
    await s.discover(1, rows);
    expect((await s.drain()).flatMap(message => message.externalIds)).toHaveLength(500);
    expect((await s.drain()).flatMap(message => message.externalIds)).toHaveLength(70);
    expect(s.store.notificationEvents.size).toBe(0);
    s.advance(); await s.discover(2, rows);
    expect((await s.drain()).flatMap(message => message.externalIds)).toHaveLength(500);
    expect((await s.drain()).flatMap(message => message.externalIds)).toHaveLength(70);
    expect(s.store.notificationEvents.size).toBe(570);
    expect(s.store.jobs.size).toBe(570);
    expect(s.store.occurrences.size).toBe(570);
    for (const row of rows) {
      expect(await s.ledger.getRow(sourceId, row.externalId)).toMatchObject({ state: 'settled', qualificationPending: false, completeFetchSequence: 2 });
      const occurrence = await s.store.getSourceOccurrence(sourceId, row.externalId);
      expect(occurrence?.occurrence.trustedCommunityAlertQualification).toMatchObject({ status: 'eligible', consecutiveCompleteSnapshots: 2 });
      expect(await s.store.getJob(occurrence!.jobId)).toMatchObject({ open: true, admission: { alertEligible: true } });
    }
    s.advance(); await s.discover(3, rows);
    expect(await s.drain()).toHaveLength(0);
    expect(s.metrics()).toEqual({ probes: 1140, snapshotWrites: 1 });
  }, 20_000);

  it('reprobes only the new pending role among 570 quiet baseline roles', async () => {
    const s = setup();
    const baseline = Array.from({ length: 570 }, (_, index) => posting(`baseline-${index}`));
    await s.discover(1, baseline, true); await s.drain(); await s.drain();
    expect(s.metrics().probes).toBe(570);
    const rows = [...baseline, posting()];
    s.advance(); await s.discover(2, rows); await s.drain();
    expect(s.metrics().probes).toBe(571);
    s.advance(); await s.discover(3, rows); await s.drain();
    expect(s.metrics().probes).toBe(572);
    expect(s.store.notificationEvents.size).toBe(1);
    expect(s.store.jobs.size).toBe(571);
    for (const row of baseline) {
      expect(await s.ledger.getRow(sourceId, row.externalId)).toMatchObject({ state: 'settled', notificationBaseline: true, qualificationPending: false });
    }
  }, 20_000);

  it('recovers a promotion after the durable commit succeeds but settlement sees failure', async () => {
    const s = setup();
    await s.discover(1); await s.drain();
    const commit = s.store.commitPostingObservation.bind(s.store);
    let failed = false;
    s.store.commitPostingObservation = async input => {
      const result = await commit(input);
      if (!failed) { failed = true; throw new AdmissionRowTransientError('evidence-acquisition', 'lost commit response'); }
      return result;
    };
    s.advance(); await s.discover(2); await s.drain();
    expect(s.store.notificationEvents.size).toBe(1);
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ state: 'queued', attemptCount: 1 });
    s.advance(); await s.drain();
    expect(await s.ledger.getRow(sourceId, 'generic-role')).toMatchObject({ state: 'settled', qualificationPending: false, completeFetchSequence: 2 });
    expect(s.store.notificationEvents.size).toBe(1);
    expect(s.store.jobs.size).toBe(1);
  });

  it.each(['baseline', 'policy'] as const)('keeps %s work permanently silent', async (mode) => {
    const s = setup();
    await s.discover(1, [posting()], mode === 'baseline'); await s.drain();
    s.advance(); await s.discover(2, [posting()], false, mode === 'policy' ? 'v2' : 'v1'); await s.drain();
    s.advance(); await s.discover(3, [posting()], false, mode === 'policy' ? 'v2' : 'v1');
    expect(await s.drain()).toHaveLength(0);
    const row = await s.ledger.getRow(sourceId, 'generic-role');
    expect(row).toMatchObject({ state: 'settled', qualificationPending: false, notificationBaseline: true });
    const occurrence = await s.store.getSourceOccurrence(sourceId, 'generic-role');
    expect(occurrence?.occurrence.trustedCommunityAlertQualification?.baselineSuppressed).toBe(true);
    expect(await s.store.getJob(occurrence!.jobId)).toMatchObject({ open: true });
    expect(s.store.notificationEvents.size).toBe(0);
  });
});
