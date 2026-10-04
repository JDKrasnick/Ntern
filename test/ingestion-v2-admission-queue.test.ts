import { describe, expect, it } from 'vitest';
import { processAdmissionV2Message } from '../src/ingestion-v2/admission/consumer.js';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import { RuleBasedAdmissionV2Evaluator } from '../src/ingestion-v2/admission/evaluator.js';
import type { AcquireLeaseInput, AdmissionV2Ledger, ExpectedAdmissionIdentity, MarkQueuedInput } from '../src/ingestion-v2/admission/ledger.js';
import { applyAdmissionReplay, planAdmissionReplay } from '../src/ingestion-v2/admission/operations.js';
import { migrateAdmissionPolicy } from '../src/ingestion-v2/admission/migration.js';
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
import { MemoryInternshipStore } from '../src/store.js';
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

  async markQueued(rows: readonly MarkQueuedInput[]): Promise<MarkQueuedInput[]> {
    const marked: MarkQueuedInput[] = [];
    for (const input of rows) {
      const row = this.row(input.sourceId, input.externalId);
      if (!row || !['pending', 'queued'].includes(row.state)
        || row.snapshotHash !== input.snapshotHash || row.materialHash !== input.materialHash
        || row.admissionVersion !== input.admissionVersion || row.consecutiveOmissions >= 2
        || (row.retryAt && row.retryAt > input.now)
        || (row.leaseExpiresAt && row.leaseExpiresAt > input.now)) continue;
      this.save({ ...row, state: 'queued', retryAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: input.now });
      marked.push(input);
    }
    return marked;
  }

  async acquireLease(input: AcquireLeaseInput): Promise<AdmissionLeaseResult> {
    const row = this.row(input.sourceId, input.externalId);
    if (!row) return { outcome: 'no-op', reason: 'absent' };
    if (row.state === 'settled') return { outcome: 'settled', row };
    if (row.state === 'quarantined') return { outcome: 'quarantined', row };
    if (row.snapshotHash !== input.expectedSnapshotHash || row.materialHash !== input.expectedMaterialHash
      || row.admissionVersion !== input.expectedAdmissionVersion) return { outcome: 'no-op', reason: 'stale' };
    if (row.state === 'processing' && row.leaseExpiresAt && row.leaseExpiresAt > input.now) return { outcome: 'no-op', reason: 'leased' };
    if (row.retryAt && row.retryAt > input.now) return { outcome: 'no-op', reason: 'retry-not-due' };
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

  private identityMatches(row: IngestionRowRecord, input: ExpectedAdmissionIdentity): boolean {
    return row.snapshotHash === input.expectedSnapshotHash
      && row.materialHash === input.expectedMaterialHash
      && row.admissionVersion === input.expectedAdmissionVersion;
  }

  async claimRowEffect(input: ExpectedAdmissionIdentity & { sourceId: string; externalId: string; owner: string; now: string }): Promise<boolean> {
    const row = this.row(input.sourceId, input.externalId);
    return Boolean(row && row.state === 'processing' && row.leaseOwner === input.owner && this.identityMatches(row, input));
  }

  async settleRow(input: ExpectedAdmissionIdentity & { sourceId: string; externalId: string; owner: string; now: string; decision: 'admitted' | 'blocked' | 'shelved'; jobId?: string; reason?: string }): Promise<boolean> {
    const row = this.row(input.sourceId, input.externalId);
    if (!row || row.state !== 'processing' || row.leaseOwner !== input.owner || !this.identityMatches(row, input)) return false;
    this.save({
      ...row, state: 'settled', decision: input.decision, attemptCount: row.attemptCount + 1,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.decision === 'blocked' ? { failureClass: 'blocked', failureDetail: input.reason } : {}),
      ...(input.decision === 'shelved' ? { failureClass: 'shelved', failureDetail: input.reason } : {}),
      settledAt: input.now, updatedAt: input.now, retryAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined,
    });
    return true;
  }

  async scheduleRowRetry(input: ExpectedAdmissionIdentity & { sourceId: string; externalId: string; owner: string; now: string; attemptCount: number; retryAt: string; failure: AdmissionFailure }): Promise<boolean> {
    const row = this.row(input.sourceId, input.externalId);
    if (!row || row.state !== 'processing' || row.leaseOwner !== input.owner || !this.identityMatches(row, input)) return false;
    this.save({ ...row, state: 'queued', attemptCount: input.attemptCount, retryAt: input.retryAt, failureClass: input.failure.classification, failureDetail: input.failure.detail, updatedAt: input.now, leaseOwner: undefined, leaseExpiresAt: undefined });
    return true;
  }

  async quarantineRow(input: ExpectedAdmissionIdentity & { sourceId: string; externalId: string; owner: string; now: string; attemptCount: number; failure: AdmissionFailure }): Promise<boolean> {
    const row = this.row(input.sourceId, input.externalId);
    if (!row || row.state !== 'processing' || row.leaseOwner !== input.owner || !this.identityMatches(row, input)) return false;
    this.save({ ...row, state: 'quarantined', attemptCount: input.attemptCount, failureClass: input.failure.classification, failureDetail: input.failure.detail, updatedAt: input.now, retryAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined });
    return true;
  }

  async reopenRows(sourceId: string, externalIds: readonly string[], now: string, options: {
    admissionVersion?: string;
    notificationBaseline?: boolean;
  } = {}): Promise<number> {
    let count = 0;
    for (const externalId of new Set(externalIds)) {
      const row = this.row(sourceId, externalId);
      if (!row || !['settled', 'quarantined', 'absent'].includes(row.state)) continue;
      this.save({
        ...row, state: 'queued', attemptCount: 0, retryAt: undefined, leaseOwner: undefined, leaseExpiresAt: undefined,
        failureClass: undefined, failureDetail: undefined, settledAt: undefined, decision: undefined,
        admissionVersion: options.admissionVersion ?? row.admissionVersion,
        notificationBaseline: options.notificationBaseline ?? row.notificationBaseline,
        updatedAt: now,
      });
      count += 1;
    }
    return count;
  }

  async reopenUnprocessedRows(sourceId: string, snapshotHash: string, admissionVersion: string, now: string, limit: number): Promise<number> {
    const candidates = [...this.rows.values()]
      .filter((row) => row.sourceId === sourceId && row.snapshotHash === snapshotHash
        && row.admissionVersion === admissionVersion && row.state === 'settled' && row.attemptCount === 0)
      .sort((left, right) => left.externalId.localeCompare(right.externalId))
      .slice(0, limit);
    return this.reopenRows(sourceId, candidates.map((row) => row.externalId), now);
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

  async listActiveSourceIds(limit: number, afterSourceId?: string): Promise<string[]> {
    return [...new Set([...this.snapshots.values()].filter((record) => record.state === 'active').map((record) => record.sourceId))]
      .sort().filter((sourceId) => !afterSourceId || sourceId > afterSourceId).slice(0, limit);
  }
  private dispatchSourceCursor?: string;
  async getDispatchSourceCursor(): Promise<string | undefined> { return this.dispatchSourceCursor; }
  async setDispatchSourceCursor(sourceId: string | undefined): Promise<void> { this.dispatchSourceCursor = sourceId; }

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

function postingUrl(externalId: string): string {
  const postingId = 100_000 + ([...externalId].reduce(
    (total, character) => Math.imul(total, 31) + character.charCodeAt(0),
    17,
  ) >>> 0) % 9_000_000;
  return `https://job-boards.greenhouse.io/acme/jobs/${postingId}`;
}

function posting(externalId: string) {
  return {
    sourceId: SOURCE, externalId, document: 'board', row: 1, provenance: 'reviewed-community' as const,
    sourceUrl: `https://example.com/${externalId}`, applyUrl: postingUrl(externalId),
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

  it('does not commit an effect when material changes during evaluation', async () => {
    const { ledger, snapshots } = setup(['a']);
    let effects = 0;
    const evaluator: AdmissionV2RowEvaluator = {
      async evaluate() {
        ledger.seedRow(ledgerRow('a', {
          snapshotHash: 'b'.repeat(64),
          materialHash: 'm-a-replacement',
          state: 'queued',
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
        }));
        return {
          decision: { kind: 'admitted', jobId: 'JOB#A' },
          jobId: 'JOB#A',
          async commitEffect() { effects += 1; },
        };
      },
    };
    const [message] = messagesFor(['a']);

    const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });

    expect(result).toMatchObject({ acknowledged: true, settled: 0, skipped: 1 });
    expect(effects).toBe(0);
    expect(await ledger.getRow(SOURCE, 'a')).toMatchObject({
      snapshotHash: 'b'.repeat(64), materialHash: 'm-a-replacement', state: 'queued',
    });
  });

  it('retries only the transient row while peers settle, then quarantines after two retries', async () => {
    const { ledger, snapshots } = setup(['ok', 'poison', 'ok2']);
    const evaluator = new CountingEvaluator(async (externalId) => {
      if (externalId !== 'poison') return { kind: 'admitted' };
      throw new AdmissionRowTransientError('upstream-server-error', '503');
    });
    const [message] = messagesFor(['ok', 'poison', 'ok2']);
    let timestamp = Date.parse('2026-10-01T00:00:00.000Z');
    const dependencies = { ledger, snapshots, evaluator, now: () => new Date(timestamp) };
    const first = await processAdmissionV2Message(message, dependencies);
    expect(first.acknowledged).toBe(true);
    expect(first.retried).toBe(1);
    expect(first.settled).toBe(2);
    expect((await ledger.getRow(SOURCE, 'poison'))).toMatchObject({ state: 'queued', retryAt: expect.any(String), attemptCount: 1 });
    expect(evaluator.calls.get('ok')).toBe(1);

    const earlyDuplicate = await processAdmissionV2Message(message, dependencies);
    expect(earlyDuplicate.skipped).toBe(3);
    expect(evaluator.calls.get('poison')).toBe(1);

    timestamp += 60_000;
    const second = await processAdmissionV2Message(message, dependencies);
    expect(second.retried).toBe(1);
    expect(evaluator.calls.get('ok')).toBe(1);
    const secondEarlyDuplicate = await processAdmissionV2Message(message, dependencies);
    expect(secondEarlyDuplicate.skipped).toBe(3);
    expect(evaluator.calls.get('poison')).toBe(2);

    // The third due attempt exhausts and quarantines only the poison row.
    timestamp += 5 * 60_000;
    const third = await processAdmissionV2Message(message, dependencies);
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

  it('treats D1 timeout wording as systemic without consuming a row attempt', async () => {
    const { ledger, snapshots } = setup(['a']);
    const evaluator = new CountingEvaluator(async () => {
      throw new Error('D1_ERROR: query timed out while committing');
    });
    const [message] = messagesFor(['a']);
    const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(result).toMatchObject({
      acknowledged: false,
      infrastructureFailure: { kind: 'infrastructure', classification: 'd1-unavailable' },
    });
    expect(await ledger.getRow(SOURCE, 'a')).toMatchObject({ state: 'queued', attemptCount: 0 });
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

  it('keeps baseline and incremental rows in separate messages', async () => {
    const { ledger } = setup(['baseline', 'incremental']);
    ledger.seedRow(ledgerRow('baseline', { notificationBaseline: true }));
    ledger.seedRow(ledgerRow('incremental', { notificationBaseline: false }));

    const plan = await planAdmissionV2Dispatch(SOURCE, { ledger });

    expect(plan.messages).toHaveLength(2);
    expect(plan.messages.map(({ baseline, externalIds }) => ({ baseline, externalIds }))).toEqual([
      { baseline: true, externalIds: ['baseline'] },
      { baseline: false, externalIds: ['incremental'] },
    ]);
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
  it('publishes 24 peers once while one poison row retries and quarantines', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => index === 12 ? 'poison' : `valid-${String(index).padStart(2, '0')}`);
    const { ledger, snapshots } = setup(ids);
    const store = new MemoryInternshipStore();
    const evaluator = new RuleBasedAdmissionV2Evaluator({
      now: () => new Date('2026-10-03T12:00:00.000Z'),
      sink: new ReconcilerAdmissionV2CatalogSink(store, () => new Date('2026-10-03T12:00:00.000Z')),
      async resolveCanonicalEmployer() { return { id: 'acme', displayName: 'Acme' }; },
      prober: {
        async probe({ externalId }) {
          if (externalId === 'poison') throw new AdmissionRowTransientError('upstream-server-error', '503');
          return {
            reachability: 'live' as const,
            evidence: {
              url: postingUrl(externalId),
              title: `Software Engineering Intern ${externalId}`,
              description: 'Build software. Summer 2027 internship.',
              expectedPostingId: new URL(postingUrl(externalId)).pathname.split('/').at(-1),
              postingIdPresent: true,
              applicationFormPresent: true,
              closureState: 'open' as const,
              confidence: { score: 1, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: ['role-title', 'application-form'] },
            },
          };
        },
      },
    });
    const [message] = messagesFor(ids);
    const first = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    expect(first).toMatchObject({ settled: 24, retried: 1, quarantined: 0 });
    expect(first.counts).toEqual({ admitted: 24, blocked: 0, shelved: 0 });
    expect(store.jobs.size).toBe(24);
    expect(store.occurrences.size).toBe(24);
    expect(store.notificationEvents.size).toBe(24);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const poison = (await ledger.getRow(SOURCE, 'poison'))!;
      ledger.seedRow({ ...poison, retryAt: '2000-01-01T00:00:00.000Z' });
      await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    }
    expect(await ledger.getRow(SOURCE, 'poison')).toMatchObject({ state: 'quarantined', attemptCount: 3 });
    expect(store.jobs.size).toBe(24);
    expect(store.occurrences.size).toBe(24);
    expect(store.notificationEvents.size).toBe(24);
  });

  it('keeps a largest-allowed batch inside the CPU, heap, snapshot, and probe bounds', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `row-${index}`);
    const { ledger, snapshots } = setup(ids);
    let activeProbes = 0;
    let peakProbes = 0;
    const evaluator = new CountingEvaluator(async () => {
      activeProbes += 1;
      peakProbes = Math.max(peakProbes, activeProbes);
      await Promise.resolve();
      activeProbes -= 1;
      return { kind: 'admitted' };
    });
    const [message] = messagesFor(ids);
    const heapBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();
    await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
    const cpu = process.cpuUsage(cpuBefore);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    const heapGrowthMb = Math.max(0, process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
    expect(snapshots.reads).toBe(1);
    expect(evaluator.calls.size).toBe(25);
    expect(peakProbes).toBe(1);
    expect(cpuMs).toBeLessThan(1_000);
    expect(heapGrowthMb).toBeLessThan(32);
  });

  it('measures a concurrency-one backlog draining in bounded 25-row deliveries', async () => {
    const ids = Array.from({ length: 75 }, (_, index) => `row-${String(index).padStart(3, '0')}`);
    const { ledger, snapshots } = setup(ids);
    const evaluator = new CountingEvaluator(async () => ({ kind: 'admitted' }));
    const messages = messagesFor(ids);
    const startedAt = performance.now();
    let settled = 0;
    for (const message of messages) {
      const result = await processAdmissionV2Message(message, { ledger, snapshots, evaluator });
      settled += result.settled;
    }
    const elapsedSeconds = Math.max((performance.now() - startedAt) / 1_000, 0.001);
    const measuredDrainRate = settled / elapsedSeconds;
    expect(messages).toHaveLength(3);
    expect(settled).toBe(75);
    expect(measuredDrainRate).toBeGreaterThan(0);
    expect(snapshots.reads).toBe(3);
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
    const { ledger, snapshots } = setup(['a']);
    ledger.seedRow(ledgerRow('a', { state: 'quarantined', attemptCount: 3, failureClass: 'upstream-server-error' }));
    const preview = await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a' }, { snapshots });
    expect(preview).toMatchObject({ eligible: true, expectedTransition: 'quarantined->queued' });
    expect(preview.replayToken).toBeDefined();
    const applied = await applyAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a', replayToken: preview.replayToken! }, { snapshots });
    expect(applied.applied).toBe(true);
    expect((await ledger.getRow(SOURCE, 'a'))?.state).toBe('queued');
    // A repeated apply is a no-op.
    const repeat = await applyAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a', replayToken: preview.replayToken! }, { snapshots });
    expect(repeat.applied).toBe(false);
  });

  it('refuses to replay an in-flight row and refuses a stale token', async () => {
    const { ledger, snapshots } = setup(['a', 'b']);
    ledger.seedRow(ledgerRow('a', { state: 'processing', leaseOwner: 'x', leaseExpiresAt: '2999-01-01T00:00:00.000Z' }));
    expect((await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a' }, { snapshots })).eligible).toBe(false);
    ledger.seedRow(ledgerRow('b', { state: 'quarantined', attemptCount: 3 }));
    const preview = await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'b' }, { snapshots });
    const applied = await applyAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'b', replayToken: 'wrong' }, { snapshots });
    expect(applied).toEqual({ applied: false, reason: 'stale-replay-token' });
    expect(preview.replayToken).toBeDefined();
  });

  it('refuses to replay an ID absent from a retained snapshot', async () => {
    const { ledger, snapshots } = setup(['a']);
    ledger.seedRow(ledgerRow('a', { state: 'quarantined', attemptCount: 3, snapshotHash: 'gone'.repeat(16) }));
    const preview = await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a' }, { snapshots });
    expect(preview).toMatchObject({ eligible: false, reason: 'snapshot-not-retained' });
  });

  it('refuses a ledger row missing from the retained complete snapshot object', async () => {
    const { ledger, snapshots } = setup(['other']);
    ledger.seedRow(ledgerRow('a', { state: 'quarantined', attemptCount: 3 }));
    const preview = await planAdmissionReplay(ledger, { sourceId: SOURCE, externalId: 'a' }, { snapshots });
    expect(preview).toMatchObject({ eligible: false, reason: 'row-not-in-retained-snapshot' });
  });
});

describe('admission v2 policy migration', () => {
  it('regrades stale settled rows under the current version without touching peers', async () => {
    const ledger = new FakeLedger();
    ledger.seedRow(ledgerRow('stale-1', { state: 'settled', decision: 'admitted', admissionVersion: 'standard-v1', attemptCount: 1, jobId: 'JOB#1' }));
    ledger.seedRow(ledgerRow('stale-2', { state: 'settled', decision: 'admitted', admissionVersion: 'standard-v1', attemptCount: 1 }));
    ledger.seedRow(ledgerRow('current', { state: 'settled', decision: 'admitted', admissionVersion: 'standard-v2' }));
    ledger.seedRow(ledgerRow('poison', { state: 'quarantined', attemptCount: 3, admissionVersion: 'standard-v1' }));

    const result = await migrateAdmissionPolicy(SOURCE, 'standard-v2', { ledger });
    expect(result.reopened).toBe(2);
    expect(result.remaining).toBe(false);
    expect(await ledger.getRow(SOURCE, 'stale-1')).toMatchObject({
      state: 'queued', admissionVersion: 'standard-v2', attemptCount: 0, notificationBaseline: true,
    });
    expect(await ledger.getRow(SOURCE, 'stale-2')).toMatchObject({ notificationBaseline: true });
    expect(await ledger.getRow(SOURCE, 'poison')).toMatchObject({ state: 'quarantined', attemptCount: 3 });
    // A settled row already on the current version is left alone and stays visible.
    expect(await ledger.getRow(SOURCE, 'current')).toMatchObject({ state: 'settled', decision: 'admitted' });
    // The migration never suppresses the source or clears a job identity.
    expect(await ledger.getRow(SOURCE, 'stale-1')).toMatchObject({ jobId: 'JOB#1' });
  });

  it('bounds each pass and lets new work dispatch while stale rows remain', async () => {
    const ledger = new FakeLedger();
    for (const id of ['stale-1', 'stale-2', 'stale-3']) {
      ledger.seedRow(ledgerRow(id, { state: 'settled', decision: 'admitted', admissionVersion: 'standard-v1' }));
    }
    // A genuinely new row that must publish even while other rows are still stale.
    ledger.seedSnapshot(snapshotRecord());
    ledger.seedRow(ledgerRow('fresh', { state: 'pending', admissionVersion: 'standard-v2' }));

    const first = await migrateAdmissionPolicy(SOURCE, 'standard-v2', { ledger, batchSize: 1 });
    expect(first.reopened).toBe(1);
    expect(first.remaining).toBe(true);
    // The fresh row dispatches on its own without waiting for the stale backlog.
    const plan = await planAdmissionV2Dispatch(SOURCE, { ledger });
    expect(plan.messages.map((message) => message.externalIds).flat()).toContain('fresh');
  });
});
