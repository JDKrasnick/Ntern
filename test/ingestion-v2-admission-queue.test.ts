import { describe, expect, it } from 'vitest';
import { processAdmissionV2Message } from '../src/ingestion-v2/admission/consumer.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import type { AcquireLeaseInput, AdmissionV2Ledger, MarkQueuedInput } from '../src/ingestion-v2/admission/ledger.js';
import { applyAdmissionReplay, planAdmissionReplay } from '../src/ingestion-v2/admission/operations.js';
import {
  AdmissionInfrastructureError,
  AdmissionRowTransientError,
} from '../src/ingestion-v2/admission/taxonomy.js';
import type {
  AdmissionFailure,
  AdmissionLeaseResult,
  AdmissionV2Handoff,
  AdmissionV2Message,
  AdmissionV2RowEvaluator,
  AdmissionV2SourceOverview,
} from '../src/ingestion-v2/admission/types.js';
import { buildAdmissionV2Messages } from '../src/ingestion-v2/admission/message.js';
import type {
  CompactIngestionRow,
  IngestionRowRecord,
  IngestionRowState,
  IngestionSnapshotObjectStore,
  IngestionSnapshotRecord,
  NormalizedSnapshotEnvelope,
} from '../src/ingestion-v2/types.js';

const SOURCE = 'community-example';
const HASH = 'a'.repeat(64);

class FakeLedger implements AdmissionV2Ledger {
  readonly rows = new Map<string, IngestionRowRecord>();
  readonly handoffs = new Map<string, AdmissionV2Handoff>();
  readonly snapshots = new Map<string, IngestionSnapshotRecord>();

  private key(sourceId: string, externalId: string) { return `${sourceId}\u0000${externalId}`; }
  private row(sourceId: string, externalId: string): IngestionRowRecord | undefined { return this.rows.get(this.key(sourceId, externalId)); }
  private save(row: IngestionRowRecord) { this.rows.set(this.key(row.sourceId, row.externalId), row); }
  private now(): string { return new Date().toISOString(); }

  seedSnapshot(record: IngestionSnapshotRecord) { this.snapshots.set(this.key(record.sourceId, record.snapshotHash), record); }
  seedRow(record: IngestionRowRecord) { this.save(record); }

  async markQueued(rows: readonly MarkQueuedInput[]): Promise<void> {
    for (const input of rows) {
      const row = this.row(input.sourceId, input.externalId);
      if (!row || !['pending', 'queued', 'processing'].includes(row.state)) continue;
      this.save({ ...row, state: 'queued', retryAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: input.now });
    }
  }

  async acquireLease(input: AcquireLeaseInput): Promise<AdmissionLeaseResult> {
    const row = this.row(input.sourceId, input.externalId);
    if (!row) return { outcome: 'no-op', reason: 'absent' };
    if (row.state === 'settled') return { outcome: 'settled', row };
    if (row.state === 'quarantined') return { outcome: 'quarantined', row };
    if (row.snapshotHash !== input.expectedSnapshotHash || row.materialHash !== input.expectedMaterialHash
      || row.admissionVersion !== input.expectedAdmissionVersion) return { outcome: 'no-op', reason: 'stale' };
    if (row.state === 'processing' && row.leaseExpiresAt && row.leaseExpiresAt > input.now) return { outcome: 'no-op', reason: 'leased' };
    const leased: IngestionRowRecord = {
      ...row, state: 'processing', leaseOwner: input.owner,
      leaseExpiresAt: new Date(Date.parse(input.now) + input.leaseMs).toISOString(), updatedAt: input.now,
    };
    this.save(leased);
    return { outcome: 'acquired', row: leased };
  }

  async releaseLease(sourceId: string, externalId: string, owner: string, now: string): Promise<boolean> {
    const row = this.row(sourceId, externalId);
    if (!row || row.state !== 'processing' || row.leaseOwner !== owner) return false;
    this.save({ ...row, state: 'queued', leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now });
    return true;
  }

  async settleRow(input: { sourceId: string; externalId: string; owner: string; now: string; decision: 'admitted' | 'blocked' | 'shelved'; jobId?: string; reason?: string }): Promise<boolean> {
    const row = this.row(input.sourceId, input.externalId);
    if (!row || row.state !== 'processing' || row.leaseOwner !== input.owner) return false;
    this.save({
      ...row, state: 'settled', decision: input.decision, attemptCount: row.attemptCount + 1,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.decision === 'blocked' ? { failureClass: 'blocked', failureDetail: input.reason } : {}),
      ...(input.decision === 'shelved' ? { failureClass: 'shelved', failureDetail: input.reason } : {}),
      settledAt: input.now, updatedAt: input.now, retryAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined,
    });
    return true;
  }

  async scheduleRowRetry(input: { sourceId: string; externalId: string; owner: string; now: string; attemptCount: number; retryAt: string; failure: AdmissionFailure }): Promise<boolean> {
    const row = this.row(input.sourceId, input.externalId);
    if (!row || row.state !== 'processing' || row.leaseOwner !== input.owner) return false;
    this.save({ ...row, state: 'queued', attemptCount: input.attemptCount, retryAt: input.retryAt, failureClass: input.failure.classification, failureDetail: input.failure.detail, updatedAt: input.now, leaseOwner: undefined, leaseExpiresAt: undefined });
    return true;
  }

  async quarantineRow(input: { sourceId: string; externalId: string; owner: string; now: string; attemptCount: number; failure: AdmissionFailure }): Promise<boolean> {
    const row = this.row(input.sourceId, input.externalId);
    if (!row || row.state !== 'processing' || row.leaseOwner !== input.owner) return false;
    this.save({ ...row, state: 'quarantined', attemptCount: input.attemptCount, failureClass: input.failure.classification, failureDetail: input.failure.detail, updatedAt: input.now, retryAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined });
    return true;
  }

  async reopenRows(sourceId: string, externalIds: readonly string[], now: string, options: { admissionVersion?: string } = {}): Promise<number> {
    let count = 0;
    for (const externalId of new Set(externalIds)) {
      const row = this.row(sourceId, externalId);
      if (!row || !['settled', 'quarantined', 'absent'].includes(row.state)) continue;
      this.save({
        ...row, state: 'queued', attemptCount: 0, retryAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined,
        failureClass: undefined, failureDetail: undefined, settledAt: undefined, decision: undefined,
        admissionVersion: options.admissionVersion ?? row.admissionVersion, updatedAt: now,
      });
      count += 1;
    }
    return count;
  }

  async reclaimExpiredLeases(now: string, limit: number): Promise<IngestionRowRecord[]> {
    const reclaimed: IngestionRowRecord[] = [];
    for (const row of this.rows.values()) {
      if (reclaimed.length >= limit) break;
      if (row.state === 'processing' && row.leaseExpiresAt && row.leaseExpiresAt <= now) {
        this.save({ ...row, state: 'queued', leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: now });
        reclaimed.push(row);
      }
    }
    return reclaimed;
  }

  async recordHandoff(handoff: AdmissionV2Handoff): Promise<void> {
    if (!this.handoffs.has(handoff.batchId)) this.handoffs.set(handoff.batchId, handoff);
  }

  async acknowledgeHandoff(batchId: string, now: string): Promise<void> {
    const handoff = this.handoffs.get(batchId);
    if (handoff && !handoff.acknowledgedAt) this.handoffs.set(batchId, { ...handoff, acknowledgedAt: now });
  }

  async listActiveHandoffs(sourceId: string, staleBefore: string): Promise<AdmissionV2Handoff[]> {
    return [...this.handoffs.values()].filter((handoff) => handoff.sourceId === sourceId && !handoff.acknowledgedAt && handoff.dispatchedAt > staleBefore);
  }

  async listRowsByState(sourceId: string, state: IngestionRowState, limit: number): Promise<IngestionRowRecord[]> {
    return [...this.rows.values()].filter((row) => row.sourceId === sourceId && row.state === state).slice(0, limit);
  }

  async getLedgerRow(sourceId: string, externalId: string): Promise<IngestionRowRecord | undefined> { return this.row(sourceId, externalId); }
  async getRow(sourceId: string, externalId: string): Promise<IngestionRowRecord | undefined> { return this.row(sourceId, externalId); }

  async listRowsPage(sourceId: string, options: { state?: IngestionRowState; cursor?: string; limit?: number } = {}): Promise<{ rows: IngestionRowRecord[]; cursor?: string }> {
    const limit = options.limit ?? 100;
    const rows = [...this.rows.values()].filter((row) => row.sourceId === sourceId && (!options.state || row.state === options.state)).slice(0, limit);
    return { rows };
  }

  async listDispatchableRows(sourceId: string, now: string, limit: number): Promise<IngestionRowRecord[]> {
    return [...this.rows.values()].filter((row) => {
      if (row.sourceId !== sourceId) return false;
      if ((row.state === 'pending' || row.state === 'queued') && (!row.retryAt || row.retryAt <= now)) return true;
      return row.state === 'processing' && Boolean(row.leaseExpiresAt && row.leaseExpiresAt <= now);
    }).slice(0, limit);
  }

  async listStalePolicyRows(sourceId: string, admissionVersion: string, limit: number): Promise<CompactIngestionRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.sourceId === sourceId && row.state === 'settled' && row.admissionVersion !== admissionVersion)
      .slice(0, limit)
      .map((row) => ({ externalId: row.externalId, snapshotHash: row.snapshotHash, materialHash: row.materialHash, admissionVersion: row.admissionVersion, state: row.state, attemptCount: row.attemptCount, consecutiveOmissions: row.consecutiveOmissions }));
  }

  async getSnapshot(sourceId: string, snapshotHash: string): Promise<IngestionSnapshotRecord | undefined> {
    return this.snapshots.get(this.key(sourceId, snapshotHash));
  }

  async listActiveSourceIds(limit: number): Promise<string[]> {
    return [...new Set([...this.snapshots.values()].filter((record) => record.state === 'active').map((record) => record.sourceId))].slice(0, limit);
  }

  async overview(sourceId: string): Promise<AdmissionV2SourceOverview> {
    const rows = [...this.rows.values()].filter((row) => row.sourceId === sourceId);
    return {
      sourceId,
      pending: rows.filter((row) => row.state === 'pending').length,
      queued: rows.filter((row) => row.state === 'queued').length,
      processing: rows.filter((row) => row.state === 'processing').length,
      settled: rows.filter((row) => row.state === 'settled').length,
      quarantined: rows.filter((row) => row.state === 'quarantined').length,
      absent: rows.filter((row) => row.state === 'absent').length,
    };
  }
}

class FakeSnapshots implements IngestionSnapshotObjectStore {
  private envelopes = new Map<string, NormalizedSnapshotEnvelope>();
  reads = 0;
  put(): Promise<void> { return Promise.resolve(); }
  get(): Promise<string | null> { return Promise.resolve(null); }
  delete(): Promise<void> { return Promise.resolve(); }
  putSnapshot(): Promise<{ key: string; bytes: number; existed: boolean }> { return Promise.resolve({ key: 'k', bytes: 0, existed: false }); }
  getSnapshot(sourceId: string, snapshotHash: string): Promise<NormalizedSnapshotEnvelope> {
    this.reads += 1;
    const envelope = this.envelopes.get(`${sourceId}\u0000${snapshotHash}`);
    if (!envelope) throw new Error(`Ingestion snapshot object missing at ${snapshotHash}`);
    return Promise.resolve(envelope);
  }
  seed(envelope: NormalizedSnapshotEnvelope) { this.envelopes.set(`${envelope.sourceId}\u0000${envelope.snapshotHash}`, envelope); }
}

function posting(externalId: string) {
  return {
    sourceId: SOURCE, externalId, document: 'board', row: 1, provenance: 'reviewed-community' as const,
    sourceUrl: `https://example.com/${externalId}`, applyUrl: `https://boards.example.com/jobs/${externalId}`,
    employer: { id: 'acme', name: 'Acme', authority: 'source-row' as const },
    title: `Software Engineering Intern ${externalId}`, locations: ['Remote'], content: [{ kind: 'description' as const, format: 'plain' as const, value: 'Build software. Summer 2027 internship.' }],
    lifecycleAuthority: 'posting' as const, sourceState: 'open' as const, fetchedAt: '2026-10-01T00:00:00.000Z',
  };
}

function envelope(externalIds: string[]): NormalizedSnapshotEnvelope {
  return {
    schemaVersion: 1, sourceId: SOURCE, snapshotHash: HASH, admissionVersion: 'standard-v1',
    documentCount: 1, rowCount: externalIds.length, observedAt: '2026-10-01T00:00:00.000Z',
    rows: externalIds.map((externalId) => ({ externalId, document: 'board', row: 1, materialHash: `m-${externalId}`, posting: posting(externalId), firstObservationEligible: true })),
  };
}

function snapshotRecord(overrides: Partial<IngestionSnapshotRecord> = {}): IngestionSnapshotRecord {
  return { sourceId: SOURCE, snapshotHash: HASH, objectKey: 'k', admissionVersion: 'standard-v1', documentCount: 1, rowCount: 3, state: 'active', isComplete: true, baseline: false, createdAt: '2026-10-01T00:00:00.000Z', activatedAt: '2026-10-01T00:00:00.000Z', ...overrides };
}

function ledgerRow(externalId: string, overrides: Partial<IngestionRowRecord> = {}): IngestionRowRecord {
  return {
    sourceId: SOURCE, externalId, snapshotHash: HASH, materialHash: `m-${externalId}`, admissionVersion: 'standard-v1',
    state: 'queued', attemptCount: 0, consecutiveOmissions: 0,
    firstObservedAt: '2026-10-01T00:00:00.000Z', lastObservedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function messagesFor(externalIds: string[]): AdmissionV2Message[] {
  return buildAdmissionV2Messages({ sourceId: SOURCE, snapshotHash: HASH, snapshotKey: 'k', admissionVersion: 'standard-v1', baseline: false, externalIds });
}

function setup(externalIds: string[]) {
  const ledger = new FakeLedger();
  const snapshots = new FakeSnapshots();
  snapshots.seed(envelope(externalIds));
  ledger.seedSnapshot(snapshotRecord());
  for (const externalId of externalIds) ledger.seedRow(ledgerRow(externalId));
  return { ledger, snapshots };
}

class CountingEvaluator implements AdmissionV2RowEvaluator {
  readonly calls = new Map<string, number>();
  constructor(private readonly behavior: (externalId: string, attempt: number) => Promise<{ kind: 'admitted' } | { kind: 'blocked'; reason: string } | { kind: 'shelved'; reason: string }>) {}
  async evaluate(context: { externalId: string; row: IngestionRowRecord }) {
    const attempt = (this.calls.get(context.externalId) ?? 0) + 1;
    this.calls.set(context.externalId, attempt);
    return { decision: await this.behavior(context.externalId, attempt) };
  }
}

describe('admission v2 queue consumer', () => {
  it('settles every row and acknowledges the message', async () => {
    const { ledger, snapshots } = setup(['a', 'b', 'c']);
    const evaluator = new CountingEvaluator(async () => ({ kind: 'admitted' }));
    const [message] = messagesFor(['a', 'b', 'c']);
    const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(result.acknowledged).toBe(true);
    expect(result.settled).toBe(3);
    expect(result.counts.admitted).toBe(3);
    expect((await ledger.getRow(SOURCE, 'a'))?.state).toBe('settled');
  });

  it('retries only the transient row while peers settle, then quarantines after two retries', async () => {
    const { ledger, snapshots } = setup(['ok', 'poison', 'ok2']);
    const evaluator = new CountingEvaluator(async (externalId) => {
      if (externalId !== 'poison') return { kind: 'admitted' };
      throw new AdmissionRowTransientError('upstream-server-error', '503');
    });
    const [message] = messagesFor(['ok', 'poison', 'ok2']);
    const first = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(first.acknowledged).toBe(true);
    expect(first.retried).toBe(1);
    expect(first.settled).toBe(2);
    expect((await ledger.getRow(SOURCE, 'poison'))).toMatchObject({ state: 'queued', retryAt: expect.any(String), attemptCount: 1 });
    expect(evaluator.calls.get('ok')).toBe(1);

    // Second attempt is due immediately in the fake; retry again.
    const second = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(second.retried).toBe(1);
    expect(evaluator.calls.get('ok')).toBe(1);
    // Third attempt exhausts and quarantines only the poison row.
    const third = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(third.quarantined).toBe(1);
    expect((await ledger.getRow(SOURCE, 'poison'))?.state).toBe('quarantined');
    expect(evaluator.calls.get('ok')).toBe(1);
  });

  it('retries a delivery on infrastructure failure without consuming an attempt', async () => {
    const { ledger, snapshots } = setup(['a', 'b']);
    const evaluator = new CountingEvaluator(async (externalId) => {
      if (externalId === 'b') throw new AdmissionInfrastructureError('d1-unavailable', 'connection lost');
      return { kind: 'admitted' };
    });
    const [message] = messagesFor(['a', 'b']);
    const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(result.acknowledged).toBe(false);
    expect(result.infrastructureFailure).toMatchObject({ kind: 'infrastructure', classification: 'd1-unavailable' });
    expect((await ledger.getRow(SOURCE, 'b'))).toMatchObject({ state: 'queued', attemptCount: 0 });
  });

  it('treats a duplicate delivery as a no-op', async () => {
    const { ledger, snapshots } = setup(['a']);
    const evaluator = new CountingEvaluator(async () => ({ kind: 'admitted' }));
    const [message] = messagesFor(['a']);
    await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    const second = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(second.skipped).toBe(1);
    expect(second.settled).toBe(0);
    expect(evaluator.calls.get('a')).toBe(1);
  });

  it('treats a lease reclaimed mid-evaluation as skipped, not a phantom settle', async () => {
    const { ledger, snapshots } = setup(['a']);
    const evaluator: AdmissionV2RowEvaluator = {
      async evaluate() {
        // Mimic a concurrent dispatcher reclaiming the lease while the row is
        // being evaluated, so the guarded settle can no longer apply.
        const row = (await ledger.getRow(SOURCE, 'a'))!;
        ledger.seedRow({ ...row, state: 'queued', leaseOwner: undefined, leaseExpiresAt: undefined });
        return { decision: { kind: 'admitted' } };
      },
    };
    const [message] = messagesFor(['a']);
    const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(result.settled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.acknowledged).toBe(true);
    expect((await ledger.getRow(SOURCE, 'a'))?.state).toBe('queued');
  });

  it('acknowledges a stale delivery as a no-op', async () => {
    const { ledger, snapshots } = setup(['a']);
    // The row advanced to a new material hash; the old message is stale.
    ledger.seedRow(ledgerRow('a', { materialHash: 'new-material', state: 'pending' }));
    const evaluator = new CountingEvaluator(async () => ({ kind: 'admitted' }));
    const [message] = messagesFor(['a']);
    const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(result.acknowledged).toBe(true);
    expect(result.skipped).toBe(1);
    expect(evaluator.calls.get('a')).toBeUndefined();
  });

  it('retries the delivery when the snapshot object is missing', async () => {
    const ledger = new FakeLedger();
    const snapshots = new FakeSnapshots();
    ledger.seedSnapshot(snapshotRecord());
    ledger.seedRow(ledgerRow('a'));
    const evaluator = new CountingEvaluator(async () => ({ kind: 'admitted' }));
    const [message] = messagesFor(['a']);
    const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(result.acknowledged).toBe(false);
    expect(result.infrastructureFailure?.classification).toBe('snapshot-missing');
  });
});

function mulberry32(seed: number): () => number {
  let value = seed;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScenarioResult {
  terminal: Record<string, { state: string; decision?: string; attemptCount: number }>;
  evaluateCalls: number;
}

/** Drive a full delivery to terminal state, forcing due retries between rounds. */
async function runScenario(input: {
  ids: string[];
  maxIds: number;
  transient: (externalId: string) => boolean;
  infrastructure?: (externalId: string) => boolean;
  duplicateEveryRound?: boolean;
}): Promise<ScenarioResult> {
  const { ledger, snapshots } = setup(input.ids);
  const calls = new Map<string, number>();
  const evaluator: AdmissionV2RowEvaluator = {
    async evaluate(context) {
      calls.set(context.externalId, (calls.get(context.externalId) ?? 0) + 1);
      if (input.infrastructure?.(context.externalId)) throw new AdmissionInfrastructureError('d1-unavailable', 'x');
      if (input.transient(context.externalId)) throw new AdmissionRowTransientError('upstream-server-error', '503');
      return { decision: { kind: 'admitted' } };
    },
  };
  const messages = buildAdmissionV2Messages({
    sourceId: SOURCE, snapshotHash: HASH, snapshotKey: 'k', admissionVersion: 'standard-v1',
    baseline: false, externalIds: input.ids, maxIds: input.maxIds,
  });
  for (let round = 0; round < 4; round += 1) {
    for (const message of messages) {
      const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
      if (input.duplicateEveryRound) await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
      if (!result.acknowledged && input.infrastructure) break;
    }
    // Make any scheduled retry due before the next round.
    for (const row of ledger.rows.values()) {
      if (row.state === 'queued' && row.retryAt) ledger.seedRow({ ...row, retryAt: '2000-01-01T00:00:00.000Z' });
    }
    if (![...ledger.rows.values()].some((row) => row.state === 'queued')) break;
  }
  const terminal: ScenarioResult['terminal'] = {};
  let totalCalls = 0;
  for (const row of ledger.rows.values()) {
    terminal[row.externalId] = { state: row.state, ...(row.decision ? { decision: row.decision } : {}), attemptCount: row.attemptCount };
    totalCalls += calls.get(row.externalId) ?? 0;
  }
  return { terminal, evaluateCalls: totalCalls };
}

describe('admission v2 property and determinism', () => {
  const ids = Array.from({ length: 30 }, (_, index) => `row-${String(index).padStart(3, '0')}`);

  it('is independent of input ordering (seed 20261002)', async () => {
    const random = mulberry32(20261002);
    const shuffled = [...ids].sort(() => random() - 0.5);
    const transient = (externalId: string) => ['row-003', 'row-017'].includes(externalId);
    const a = await runScenario({ ids, maxIds: 25, transient });
    const b = await runScenario({ ids: shuffled, maxIds: 25, transient });
    expect(b.terminal).toEqual(a.terminal);
  });

  it('yields identical terminal state regardless of batch partitioning', async () => {
    const transient = (externalId: string) => externalId.endsWith('7');
    const wide = await runScenario({ ids, maxIds: 25, transient });
    const narrow = await runScenario({ ids, maxIds: 3, transient });
    expect(narrow.terminal).toEqual(wide.terminal);
  });

  it('is invariant under duplicate delivery at every round', async () => {
    const transient = (externalId: string) => externalId.endsWith('9');
    const once = await runScenario({ ids, maxIds: 7, transient });
    const duplicated = await runScenario({ ids, maxIds: 7, transient, duplicateEveryRound: true });
    expect(duplicated.terminal).toEqual(once.terminal);
  });

  it('never lets a single row-local failure change peer outcomes', async () => {
    const peers = ids.filter((id) => id !== 'row-005');
    const withoutFailure = await runScenario({ ids: peers, maxIds: 25, transient: () => false });
    const withFailure = await runScenario({ ids, maxIds: 25, transient: (externalId) => externalId === 'row-005' });
    expect(withFailure.terminal['row-005']?.state).toBe('quarantined');
    for (const id of peers) {
      expect(withFailure.terminal[id]).toEqual(withoutFailure.terminal[id]);
    }
  });
});

describe('admission v2 dispatcher', () => {
  it('marks rows queued, records handoffs, and does not duplicate fresh work', async () => {
    const { ledger, snapshots } = setup(['a', 'b']);
    const first = await planAdmissionV2Dispatch(SOURCE, { ledger });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].externalIds).toEqual(['a', 'b']);
    expect((await ledger.getRow(SOURCE, 'a'))?.state).toBe('queued');
    expect(ledger.handoffs.size).toBe(1);
    // A second immediate run sees the fresh handoff and dispatches nothing.
    const second = await planAdmissionV2Dispatch(SOURCE, { ledger });
    expect(second.messages).toHaveLength(0);
    expect(snapshots).toBeDefined();
  });

  it('reissues a stale unacknowledged handoff', async () => {
    const { ledger } = setup(['a']);
    await planAdmissionV2Dispatch(SOURCE, { ledger, dispatchLeaseMs: 0 });
    const again = await planAdmissionV2Dispatch(SOURCE, { ledger, dispatchLeaseMs: 0 });
    expect(again.messages).toHaveLength(1);
  });

  it('reclaims an expired lease and redispatches the row', async () => {
    const { ledger } = setup(['a']);
    ledger.seedRow(ledgerRow('a', { state: 'processing', leaseOwner: 'dead', leaseExpiresAt: '2000-01-01T00:00:00.000Z' }));
    const plan = await planAdmissionV2Dispatch(SOURCE, { ledger });
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0].externalIds).toEqual(['a']);
  });
});

describe('admission v2 resource and contention', () => {
  it('downloads the snapshot once per batch, not once per row', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `row-${index}`);
    const { ledger, snapshots } = setup(ids);
    const evaluator = new CountingEvaluator(async () => ({ kind: 'admitted' }));
    const [message] = messagesFor(ids);
    await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(snapshots.reads).toBe(1);
    expect(evaluator.calls.size).toBe(25);
  });

  it('lets two concurrent consumers race for the same batch without double processing', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    const { ledger, snapshots } = setup(ids);
    const evaluator = new CountingEvaluator(async () => ({ kind: 'admitted' }));
    const [message] = messagesFor(ids);
    const [first, second] = await Promise.all([
      processAdmissionV2Message(message, { ledger, snapshots, evaluator }),
      processAdmissionV2Message(message, { ledger, snapshots, evaluator }),
    ]);
    const totalSettled = first.settled + second.settled;
    expect(totalSettled).toBe(ids.length);
    for (const id of ids) expect(evaluator.calls.get(id)).toBe(1);
  });
});

describe('admission v2 guarded replay', () => {
  it('previews and applies a replay for a quarantined row', async () => {
    const { ledger } = setup(['a']);
    ledger.seedRow(ledgerRow('a', { state: 'quarantined', attemptCount: 3, failureClass: 'upstream-server-error' }));
    const preview = await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a' });
    expect(preview).toMatchObject({ eligible: true, expectedTransition: 'quarantined->queued' });
    expect(preview.replayToken).toBeDefined();
    const applied = await applyAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a', replayToken: preview.replayToken! });
    expect(applied.applied).toBe(true);
    expect((await ledger.getRow(SOURCE, 'a'))?.state).toBe('queued');
    // A repeated apply is a no-op.
    const repeat = await applyAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a', replayToken: preview.replayToken! });
    expect(repeat.applied).toBe(false);
  });

  it('refuses to replay an in-flight row and refuses a stale token', async () => {
    const { ledger } = setup(['a', 'b']);
    ledger.seedRow(ledgerRow('a', { state: 'processing', leaseOwner: 'x', leaseExpiresAt: '2999-01-01T00:00:00.000Z' }));
    expect((await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a' })).eligible).toBe(false);
    ledger.seedRow(ledgerRow('b', { state: 'quarantined', attemptCount: 3 }));
    const preview = await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'b' });
    const applied = await applyAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'b', replayToken: 'wrong' });
    expect(applied).toEqual({ applied: false, reason: 'stale-replay-token' });
    expect(preview.replayToken).toBeDefined();
  });

  it('refuses to replay an ID absent from a retained snapshot', async () => {
    const { ledger } = setup(['a']);
    ledger.seedRow(ledgerRow('a', { state: 'quarantined', attemptCount: 3, snapshotHash: 'gone'.repeat(16) }));
    const preview = await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a' });
    expect(preview).toMatchObject({ eligible: false, reason: 'snapshot-not-retained' });
  });
});
