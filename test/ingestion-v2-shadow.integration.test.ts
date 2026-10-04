import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { IngestionV2ShadowDiscovery } from '../src/ingestion-v2/shadow-discovery.js';
import { planSnapshotDiff } from '../src/ingestion-v2/diff.js';
import { processAdmissionV2Message } from '../src/ingestion-v2/admission/consumer.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import { bootstrapAdmissionSnapshot } from '../src/ingestion-v2/admission/migration.js';
import { parseEnvelope, serializeEnvelope, snapshotObjectKey } from '../src/ingestion-v2/normalize.js';
import type { IngestionSnapshotObjectStore, NormalizedSnapshotEnvelope } from '../src/ingestion-v2/types.js';
import { processSnapshot } from '../src/ingestion/processor.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import type { SourceSnapshot } from '../src/types.js';

const sourceId = 'community-example';
const observedAt = '2026-10-01T00:00:00.000Z';

class MemoryObjectStore implements IngestionSnapshotObjectStore {
  readonly objects = new Map<string, string>();
  putCalls = 0;
  async put(key: string, body: string): Promise<void> {
    this.putCalls += 1;
    this.objects.set(key, body);
  }
  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async putSnapshot(envelope: NormalizedSnapshotEnvelope): Promise<{ key: string; bytes: number; existed: boolean }> {
    const key = snapshotObjectKey(envelope.sourceId, envelope.snapshotHash);
    const body = serializeEnvelope(envelope);
    const existing = await this.get(key);
    if (existing !== null) {
      parseEnvelope(existing, { sourceId: envelope.sourceId, snapshotHash: envelope.snapshotHash });
      return { key, bytes: existing.length, existed: true };
    }
    await this.put(key, body);
    return { key, bytes: body.length, existed: false };
  }
  async getSnapshot(source: string, hash: string): Promise<NormalizedSnapshotEnvelope> {
    const raw = await this.get(snapshotObjectKey(source, hash));
    if (raw === null) throw new Error('missing');
    return parseEnvelope(raw, { sourceId: source, snapshotHash: hash });
  }
}

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

interface BoardRow {
  company: string;
  position: string;
  location: string;
  url: string;
  salary?: string;
}

function markdown(rows: BoardRow[]): string {
  const header = '| Company | Position | Location | Posting | Salary |\n| --- | --- | --- | --- | --- |\n';
  return header + rows.map((row) => `| ${row.company} | ${row.position} | ${row.location} | [Apply](${row.url}) | ${row.salary ?? '$50/hr'} |`).join('\n') + '\n';
}

interface Harness {
  database: DatabaseSync;
  repository: D1IngestionV2Repository;
  snapshots: MemoryObjectStore;
  discovery: IngestionV2ShadowDiscovery;
  adapter: GitHubMarkdownAdapter;
  reopened: string[][];
  discover: (documents: Record<string, BoardRow[]>, options?: { admissionVersion?: string }) => Promise<void>;
  setAdmissionEnabled: (enabled: boolean) => void;
  fetch: () => Promise<SourceSnapshot>;
}

function harness(initial: Record<string, BoardRow[]>, admissionEnabled = false): Harness {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql', '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql', '0049_ingestion_v2_cost_windows.sql', '0050_ingestion_v2_omission_closure.sql', '0051_ingestion_v2_qualification_cadence.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const repository = new D1IngestionV2Repository(sqliteD1(database));
  const snapshots = new MemoryObjectStore();
  const reopened: string[][] = [];
  let admissionActive = admissionEnabled;
  const discovery = new IngestionV2ShadowDiscovery({
    repository,
    snapshots,
    features: { shadowDiscoveryEnabled: true },
    now: () => new Date(observedAt),
    log: () => undefined,
    admissionEnabledForSource: () => admissionActive,
    reopenActionableRows: async ({ sourceId: source, externalIds, admissionVersion, now }) => {
      reopened.push([...externalIds]);
      return repository.reopenRows(source, [...externalIds], now, { admissionVersion });
    },
  });
  let documents = initial;
  const documentsById = [
    { path: 'README.md', branch: 'main', season: 'summer-2027' },
    { path: 'SECOND.md', branch: 'main', season: 'summer-2027' },
  ];
  const adapter = new GitHubMarkdownAdapter({
    id: sourceId,
    owner: 'example',
    repo: 'jobs',
    documents: documentsById,
    fetchImpl: async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.split('/').pop() ?? 'README.md';
      if (!(path in documents)) return new Response('not found', { status: 404 });
      return new Response(markdown(documents[path] ?? []), { headers: { etag: `"etag-${path}-${JSON.stringify(documents[path])}"` } });
    },
  });
  const fetch = async () => await adapter.fetch() as unknown as SourceSnapshot;
  const discover: (next: Record<string, BoardRow[]>, options?: { admissionVersion?: string }) => Promise<void> = async (next, options = {}) => {
    documents = next;
    const snapshot = await fetch();
    await discovery.discover({
      sourceId,
      postings: snapshot.postings,
      processed: processSnapshot(snapshot),
      snapshotHash: snapshot.contentHash,
      admissionVersion: options.admissionVersion ?? 'standard-v1',
      baseline: false,
      observedAt,
      legacyActionableExternalIds: [],
      legacyActiveExternalIds: snapshot.postings.map((posting) => posting.externalId),
      now: observedAt,
    });
  };
  return {
    database, repository, snapshots, discovery, adapter, reopened, discover, fetch,
    setAdmissionEnabled: (enabled) => { admissionActive = enabled; },
  };
}

const rowA: BoardRow = { company: 'Acme', position: 'Software Engineering Intern', location: 'Remote', url: 'https://jobs.example.test/acme/1' };
const rowB: BoardRow = { company: 'Beta', position: 'Machine Learning Intern', location: 'NYC', url: 'https://jobs.example.test/beta/1' };
const rowC: BoardRow = { company: 'Gamma', position: 'Data Science Intern', location: 'Austin', url: 'https://jobs.example.test/gamma/1' };
const rowD: BoardRow = { company: 'Delta', position: 'Backend Engineering Intern', location: 'Seattle', url: 'https://jobs.example.test/delta/1' };
const rowS: BoardRow = { company: 'Sigma', position: 'Security Engineering Intern', location: 'Remote', url: 'https://jobs.example.test/sigma/1' };

const basePostingId = (path: string, url: string) => `${path}:${url}`;

describe('ingestion v2 shadow discovery integration', () => {
  it('discovers a new row that appears below several known rows', async () => {
    const subject = harness({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] });
    expect((await subject.repository.getShadowComparison(sourceId))?.counts.new).toBe(4);

    await subject.discover({ 'README.md': [rowA, rowB, rowC, rowD], 'SECOND.md': [rowS] });
    const comparison = await subject.repository.getShadowComparison(sourceId);
    expect(comparison?.counts.new).toBe(1);
    expect(comparison?.v2Only.samples).toEqual([basePostingId('README.md', rowD.url)]);
    expect(comparison?.counts.missing).toBe(0);
    subject.database.close();
  });

  it('discovers a new row in the second configured document', async () => {
    const subject = harness({ 'README.md': [rowA], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA], 'SECOND.md': [rowS] });
    const rowS2: BoardRow = { company: 'Sigma', position: 'Site Reliability Intern', location: 'Remote', url: 'https://jobs.example.test/sigma/2' };
    await subject.discover({ 'README.md': [rowA], 'SECOND.md': [rowS, rowS2] });
    const comparison = await subject.repository.getShadowComparison(sourceId);
    expect(comparison?.counts.new).toBe(1);
    expect(comparison?.v2Only.samples).toEqual([basePostingId('SECOND.md', rowS2.url)]);
    subject.database.close();
  });

  it('detects a change without a changed external id', async () => {
    const subject = harness({ 'README.md': [rowA], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA], 'SECOND.md': [rowS] });
    const changed: BoardRow = { ...rowA, position: 'Software Engineering Intern II', salary: '$70/hr' };
    await subject.discover({ 'README.md': [changed], 'SECOND.md': [rowS] });
    const comparison = await subject.repository.getShadowComparison(sourceId);
    expect(comparison?.counts.changed).toBe(1);
    expect(comparison?.v2Only.samples).toEqual([basePostingId('README.md', rowA.url)]);
    subject.database.close();
  });

  it('creates no actionable work for an unchanged full board', async () => {
    const subject = harness({ 'README.md': [rowA, rowB], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA, rowB], 'SECOND.md': [rowS] });
    const putCalls = subject.snapshots.putCalls;
    await subject.discover({ 'README.md': [rowA, rowB], 'SECOND.md': [rowS] });
    const comparison = await subject.repository.getShadowComparison(sourceId);
    expect(comparison?.counts).toMatchObject({ new: 0, changed: 0, missing: 0, unchanged: 3 });
    expect(comparison?.v2Actionable.count).toBe(0);
    expect(comparison).toMatchObject({ d1RowsWritten: 1, r2Bytes: 0 });
    expect(subject.snapshots.putCalls).toBe(putCalls);
    subject.database.close();
  });

  it('reactivates the original immutable snapshot when board content returns', async () => {
    const original = { 'README.md': [rowA, rowB], 'SECOND.md': [rowS] };
    const subject = harness(original);
    await subject.discover(original);
    const firstHash = (await subject.repository.overview(sourceId)).currentSnapshotHash!;

    const changedRow = { ...rowB, position: 'Machine Learning Intern II' };
    await subject.discover({ 'README.md': [rowA, changedRow], 'SECOND.md': [rowS] });
    const secondHash = (await subject.repository.overview(sourceId)).currentSnapshotHash!;
    expect(secondHash).not.toBe(firstHash);
    expect(await subject.repository.getSnapshot(sourceId, firstHash)).toMatchObject({ state: 'terminal' });

    await subject.discover(original);
    expect((await subject.repository.overview(sourceId)).currentSnapshotHash).toBe(firstHash);
    expect(await subject.repository.getSnapshot(sourceId, firstHash)).toMatchObject({ state: 'active' });
    expect((await subject.repository.getSnapshot(sourceId, firstHash))?.terminalAt).toBeUndefined();
    expect((await subject.repository.getSnapshot(sourceId, firstHash))?.expiresAt).toBeUndefined();
    expect(await subject.repository.getSnapshot(sourceId, secondHash)).toMatchObject({ state: 'terminal' });
    const active = subject.database.prepare(
      "SELECT COUNT(*) AS count FROM ingestion_snapshots WHERE source_id = ? AND state = 'active'",
    ).get(sourceId) as { count: number };
    expect(active.count).toBe(1);
    subject.database.close();
  });

  it('records one omission then reappearance when a row returns', async () => {
    const subject = harness({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA, rowC], 'SECOND.md': [rowS] });
    const betaId = basePostingId('README.md', rowB.url);
    const afterMissing = await subject.repository.getShadowComparison(sourceId);
    expect(afterMissing?.counts.missing).toBe(1);
    expect(await subject.repository.getRow(sourceId, betaId)).toMatchObject({ consecutiveOmissions: 1, state: 'settled' });

    await subject.discover({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] });
    const afterReturn = await subject.repository.getShadowComparison(sourceId);
    // A row that returned before closure simply resumes with no actionable work.
    expect(afterReturn?.counts).toMatchObject({ new: 0, changed: 0, reappeared: 0, missing: 0 });
    expect(afterReturn?.v2Actionable.count).toBe(0);
    expect(await subject.repository.getRow(sourceId, betaId)).toMatchObject({ consecutiveOmissions: 0, state: 'settled' });
    subject.database.close();
  });

  it('closes a row only after two complete missing snapshots', async () => {
    const subject = harness({ 'README.md': [rowA, rowC], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA, rowC], 'SECOND.md': [rowS] });
    const gammaId = basePostingId('README.md', rowC.url);
    await subject.discover({ 'README.md': [rowA], 'SECOND.md': [rowS] });
    expect(await subject.repository.getRow(sourceId, gammaId)).toMatchObject({ consecutiveOmissions: 1, state: 'settled' });
    await subject.discover({ 'README.md': [rowA], 'SECOND.md': [rowS] });
    expect(await subject.repository.getRow(sourceId, gammaId)).toMatchObject({ consecutiveOmissions: 2, state: 'absent' });
    // An absent row is not re-counted.
    await subject.discover({ 'README.md': [rowA], 'SECOND.md': [rowS] });
    expect(await subject.repository.getRow(sourceId, gammaId)).toMatchObject({ consecutiveOmissions: 2, state: 'absent' });
    subject.database.close();
  });

  it('preserves omission counts for an incomplete snapshot', async () => {
    const subject = harness({ 'README.md': [rowA, rowB], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA, rowB], 'SECOND.md': [rowS] });
    const ledger = await subject.repository.listLedger(sourceId);
    const diff = planSnapshotDiff({
      sourceId,
      snapshotHash: 'incomplete',
      admissionVersion: 'standard-v1',
      complete: false,
      now: observedAt,
      rows: [],
      ledger,
    });
    expect(diff.omissionUpdates).toEqual([]);
    expect(diff.actionableExternalIds).toEqual([]);
    expect(await subject.repository.getRow(sourceId, basePostingId('README.md', rowB.url))).toMatchObject({ consecutiveOmissions: 0 });
    subject.database.close();
  });

  it('reopens only materially changed rows for the admission lane when a producer is attached', async () => {
    const subject = harness({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] }, true);
    await subject.discover({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] });
    // The first pass reopens every brand-new row as dispatchable work.
    expect(subject.reopened[0]?.length).toBe(4);
    subject.reopened.length = 0;

    const changed: BoardRow = { ...rowC, position: 'Data Science Intern II' };
    await subject.discover({ 'README.md': [rowA, rowB, changed], 'SECOND.md': [rowS] });
    const changedId = basePostingId('README.md', rowC.url);
    expect(subject.reopened).toEqual([[changedId]]);
    const reopenedRow = await subject.repository.getRow(sourceId, changedId);
    expect(reopenedRow?.state).toBe('queued');
    expect(reopenedRow?.attemptCount).toBe(0);

    // A repeated identical board reopens nothing.
    subject.reopened.length = 0;
    await subject.discover({ 'README.md': [rowA, rowB, changed], 'SECOND.md': [rowS] });
    expect(subject.reopened).toEqual([]);
    subject.database.close();
  });

  it('preserves retry state across an unrelated addition and fences discovery-first policy migration', async () => {
    const board = { 'README.md': [rowA, rowB], 'SECOND.md': [rowS] };
    const subject = harness(board, true);
    await subject.discover(board);
    const rowId = basePostingId('README.md', rowA.url);
    const initial = await subject.repository.getRow(sourceId, rowId);
    expect(initial).toBeDefined();
    const lease = await subject.repository.acquireLease({
      sourceId, externalId: rowId, owner: 'retry-owner', now: '2026-10-01T00:00:00.000Z', leaseMs: 60_000,
      expectedSnapshotHash: initial!.snapshotHash, expectedMaterialHash: initial!.materialHash, expectedAdmissionVersion: initial!.admissionVersion,
    });
    expect(lease.outcome).toBe('acquired');
    expect(await subject.repository.scheduleRowRetry({
      sourceId, externalId: rowId, owner: 'retry-owner', now: '2026-10-01T00:00:01.000Z',
      expectedSnapshotHash: initial!.snapshotHash, expectedMaterialHash: initial!.materialHash, expectedAdmissionVersion: initial!.admissionVersion,
      attemptCount: 1, retryAt: '2026-10-01T00:01:01.000Z',
      failure: { kind: 'row-transient', classification: 'destination-timeout', detail: 'timed out' },
    })).toBe(true);

    await subject.discover({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] });
    const afterPeerChange = await subject.repository.getRow(sourceId, rowId);
    expect(afterPeerChange).toMatchObject({
      state: 'queued', attemptCount: 1, retryAt: '2026-10-01T00:01:01.000Z', failureClass: 'destination-timeout',
    });
    expect(afterPeerChange?.snapshotHash).not.toBe(initial?.snapshotHash);

    const policyLease = await subject.repository.acquireLease({
      sourceId, externalId: rowId, owner: 'policy-owner', now: '2026-10-01T00:02:00.000Z', leaseMs: 60_000,
      expectedSnapshotHash: afterPeerChange!.snapshotHash, expectedMaterialHash: afterPeerChange!.materialHash,
      expectedAdmissionVersion: afterPeerChange!.admissionVersion,
    });
    expect(policyLease.outcome).toBe('acquired');
    expect(await subject.repository.settleRow({
      sourceId, externalId: rowId, owner: 'policy-owner', now: '2026-10-01T00:02:01.000Z',
      expectedSnapshotHash: afterPeerChange!.snapshotHash, expectedMaterialHash: afterPeerChange!.materialHash,
      expectedAdmissionVersion: afterPeerChange!.admissionVersion, decision: 'blocked', reason: 'old policy',
    })).toBe(true);
    await subject.discover({ 'README.md': [rowA, rowB, rowC], 'SECOND.md': [rowS] }, { admissionVersion: 'standard-v2' });
    expect(await subject.repository.getRow(sourceId, rowId)).toMatchObject({
      state: 'queued', admissionVersion: 'standard-v2', notificationBaseline: true,
    });
    const plan = await planAdmissionV2Dispatch(sourceId, { ledger: subject.repository });
    expect(plan.messages.find((message) => message.externalIds.includes(rowId))?.baseline).toBe(true);
    subject.database.close();
  });

  it('bootstraps and silently settles a board observed before admission was enabled', async () => {
    const subject = harness({ 'README.md': [rowA], 'SECOND.md': [rowS] });
    const board = { 'README.md': [rowA], 'SECOND.md': [rowS] };
    await subject.discover(board);
    expect(subject.reopened).toEqual([]);
    expect((await subject.repository.listLedger(sourceId)).every((row) => row.attemptCount === 0)).toBe(true);

    subject.setAdmissionEnabled(true);
    await subject.discover(board);
    expect(subject.reopened).toEqual([]);
    const overview = await subject.repository.overview(sourceId);
    const snapshot = await subject.repository.getSnapshot(sourceId, overview.currentSnapshotHash!);
    expect(snapshot).toBeDefined();
    expect(await bootstrapAdmissionSnapshot(sourceId, snapshot!.snapshotHash, snapshot!.admissionVersion, {
      ledger: subject.repository,
      now: () => new Date('2026-10-01T00:10:00.000Z'),
    })).toBe(2);

    const plan = await planAdmissionV2Dispatch(sourceId, {
      ledger: subject.repository,
      now: () => new Date('2026-10-01T00:10:01.000Z'),
    });
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0].baseline).toBe(true);
    const observedBaselines: boolean[] = [];
    await processAdmissionV2Message(plan.messages[0], {
      ledger: subject.repository,
      snapshots: subject.snapshots,
      evaluator: {
        async evaluate(context) {
          observedBaselines.push(context.baseline);
          return { decision: { kind: 'admitted', jobId: `JOB#${context.externalId}` } };
        },
      },
      now: () => new Date('2026-10-01T00:10:02.000Z'),
    });
    expect(observedBaselines).toEqual([true, true]);
    expect((await subject.repository.listLedger(sourceId)).every((row) => row.state === 'settled' && row.attemptCount === 1)).toBe(true);
    await subject.discover(board);
    expect((await subject.repository.listLedger(sourceId)).every((row) => row.attemptCount === 1)).toBe(true);
    expect(await bootstrapAdmissionSnapshot(sourceId, snapshot!.snapshotHash, snapshot!.admissionVersion, {
      ledger: subject.repository,
      now: () => new Date('2026-10-01T00:20:00.000Z'),
    })).toBe(0);
    subject.database.close();
  });

  it('replaces a stale successful comparison with a durable failed status', async () => {
    const board = { 'README.md': [rowA], 'SECOND.md': [rowS] };
    const subject = harness(board);
    await subject.discover(board);
    expect((await subject.repository.getShadowComparison(sourceId))?.status).toBe('complete');

    const snapshot = await subject.fetch();
    const failedDiscovery = new IngestionV2ShadowDiscovery({
      repository: subject.repository,
      snapshots: {
        put: (key, body) => subject.snapshots.put(key, body),
        get: (key) => subject.snapshots.get(key),
        delete: (key) => subject.snapshots.delete(key),
        async putSnapshot() { throw new Error('R2 unavailable'); },
        getSnapshot: (source, hash) => subject.snapshots.getSnapshot(source, hash),
      },
      features: { shadowDiscoveryEnabled: true },
      now: () => new Date(observedAt),
      log: () => undefined,
    });
    await failedDiscovery.discover({
      sourceId,
      postings: snapshot.postings,
      processed: processSnapshot(snapshot),
      snapshotHash: snapshot.contentHash,
      admissionVersion: 'standard-v2',
      baseline: false,
      observedAt,
      legacyActionableExternalIds: [],
      legacyActiveExternalIds: snapshot.postings.map((posting) => posting.externalId),
      now: observedAt,
    });

    expect(await subject.repository.getShadowComparison(sourceId)).toMatchObject({
      complete: false,
      status: 'failed',
      d1RowsWritten: 0,
      r2Bytes: 0,
    });
    const { run_count: runCount } = subject.database.prepare(
      'SELECT run_count FROM ingestion_v2_shadow_comparisons WHERE source_id = ?',
    ).get(sourceId) as { run_count: number };
    expect(runCount).toBe(2);
    subject.database.close();
  });

  it('is idempotent across a repeated identical delivery', async () => {
    const subject = harness({ 'README.md': [rowA, rowB], 'SECOND.md': [rowS] });
    await subject.discover({ 'README.md': [rowA, rowB], 'SECOND.md': [rowS] });
    const firstLedger = await subject.repository.listLedger(sourceId);
    const objectCount = subject.snapshots.objects.size;
    const putCalls = subject.snapshots.putCalls;

    await subject.discover({ 'README.md': [rowA, rowB], 'SECOND.md': [rowS] });
    expect(await subject.repository.listLedger(sourceId)).toEqual(firstLedger);
    // The content-addressed object is never rewritten, and the ledger write is a no-op.
    expect(subject.snapshots.objects.size).toBe(objectCount);
    expect(subject.snapshots.putCalls).toBe(putCalls);
    const { run_count: runCount } = subject.database.prepare(
      'SELECT run_count FROM ingestion_v2_shadow_comparisons WHERE source_id = ?',
    ).get(sourceId) as { run_count: number };
    expect(runCount).toBe(2);
    subject.database.close();
  });
});
