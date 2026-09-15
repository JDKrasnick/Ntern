import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { applyDlq, cleanupDlqRecords, inspectDlq, planDlq, recordQueueFailure, recordQueueFailureBestEffort, resolveQueueFailures, type DlqDependencies, type PeekedMessage } from '../cloudflare/dlq-operations.js';
import type { D1Database, D1PreparedStatement, Queue } from '../cloudflare/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;
function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query); const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return { prepare: (query) => prepared(query), batch: async (statements) => Promise.all(statements.map((statement) => statement.run())) };
}

function subject(messages: PeekedMessage[], health: DlqDependencies['sourceHealth'] = async () => undefined) {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync('cloudflare/migrations/0015_dlq_recovery.sql', 'utf8'));
  const events: string[] = [];
  const send = vi.fn(async (message: unknown) => { void message; events.push('send'); });
  const purge = vi.fn(async (queueId: string, refs: string[]): Promise<{ failedRefs: string[] }> => {
    void queueId; void refs; events.push('purge'); return { failedRefs: [] };
  });
  const queue: Queue = { send, async sendBatch() {} };
  const dependencies: DlqDependencies = {
    db: sqliteD1(database), sourceHealth: health, now: () => new Date('2026-09-04T12:00:00.000Z'),
    workQueues: { greenhouse: queue, lever: queue, ashby: queue, github: queue, gmail: queue, 'destination-verification': queue },
    api: { async resolveQueueId(name) { return name; }, async peek() { return messages; }, purge },
  };
  return { database, dependencies, send, purge, events };
}

const catalogMessage = (id: string, sourceId = 'lever-acme'): PeekedMessage => ({
  id, attempts: 3, timestampMs: Date.parse('2026-09-04T10:00:00.000Z'), ref: `private-${id}`,
  body: { version: 1, sourceId, scheduledAt: '2026-09-04T09:00:00.000Z', runId: 'old-run' },
});

const destinationMessage = (id: string): PeekedMessage => ({
  id, attempts: 5, timestampMs: Date.parse('2026-09-04T10:00:00.000Z'), ref: `private-${id}`,
  body: {
    version: 1, jobId: 'job-1', sourceId: 'greenhouse-acme', externalId: 'gh-42',
    providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-acme', sourceUrl: 'https://boards.greenhouse.io/acme', postingId: '42' },
    candidateUrl: 'https://boards.greenhouse.io/acme/jobs/42', reason: 'content-change',
    queuedAt: '2026-09-04T09:00:00.000Z', idempotencyKey: 'idem-42', metadataExtractionVersion: 7,
    metadataArtifactHash: 'artifact-hash-42', shadowOrigin: 'provider-poll',
  },
});

describe('protected DLQ operations', () => {
  it('inspects sanitized summaries without consuming or exposing bodies and refs', async () => {
    const { database, dependencies, purge } = subject([catalogMessage('m1')], async () => ({
      sourceId: 'lever-acme', state: 'degraded', sourceStatus: 'active', lastAttemptAt: 'now', consecutiveFailures: 1,
      durationMs: 1, lastSafeDiagnostic: 'bounded diagnostic',
    }));
    const result = await inspectDlq({ queue: 'lever', limit: 100 }, dependencies);
    expect(result).toMatchObject({ count: 1, messages: [{ messageId: 'm1', attempts: 3, sourceId: 'lever-acme',
      logicalWorkKey: 'lever-acme', currentHealth: 'degraded', latestDiagnostic: 'bounded diagnostic' }] });
    expect(JSON.stringify(result)).not.toContain('private-m1');
    expect(JSON.stringify(result)).not.toContain('old-run');
    expect(purge).not.toHaveBeenCalled();
    database.close();
  });

  it('surfaces the ledgered failure category and diagnostic for a non-GitHub catalog queue', async () => {
    const { database, dependencies } = subject([catalogMessage('m1')]);
    await recordQueueFailure({ db: dependencies.db, queueName: 'intern-notifs-lever', messageId: 'm1', attempts: 3,
      sourceId: 'lever-acme', sourceKind: 'lever', body: { sourceId: 'lever-acme' },
      error: new Error('fetch to https://api.lever.co/v0/postings timed out') });
    const result = await inspectDlq({ queue: 'lever', limit: 100 }, dependencies);
    expect(result.messages[0]).toMatchObject({ messageId: 'm1', failureCategory: 'transport', latestDiagnostic: 'fetch to [url] timed out', failureProvenance: 'ledgered' });
    expect(result.classificationCounts).toEqual({ ledgered: 1, 'missing-ledger': 0, 'not-applicable': 0 });
    database.close();
  });

  it('marks catalog messages with no ledger event as unclassified instead of inferring a transient', async () => {
    const { database, dependencies } = subject([catalogMessage('historical')]);
    const result = await inspectDlq({ queue: 'github', limit: 100 }, dependencies);
    expect(result.messages[0]).toMatchObject({ messageId: 'historical', failureProvenance: 'missing-ledger' });
    expect(result.messages[0]).not.toHaveProperty('failureCategory');
    expect(result.classificationCounts).toEqual({ ledgered: 0, 'missing-ledger': 1, 'not-applicable': 0 });
    database.close();
  });

  it('surfaces the durable source-health category when the failure ledger is missing', async () => {
    const { database, dependencies } = subject([catalogMessage('m1')], async () => ({
      sourceId: 'lever-acme', state: 'degraded', sourceStatus: 'active', lastAttemptAt: 'now', consecutiveFailures: 1,
      durationMs: 1, diagnosticCategory: 'persistence', lastSafeDiagnostic: 'D1_ERROR: internal error; reference = abc',
    }));
    const result = await inspectDlq({ queue: 'lever', limit: 100 }, dependencies);
    expect(result.messages[0]).toMatchObject({ messageId: 'm1', failureProvenance: 'missing-ledger',
      currentHealthCategory: 'persistence' });
    expect(result.messages[0]).not.toHaveProperty('failureCategory');
    database.close();
  });

  it('keeps malformed messages inspectable and selectively discardable', async () => {
    const malformed: PeekedMessage = { id: 'broken', attempts: 5, ref: 'private-broken', body: '{not-json' };
    const { database, dependencies, purge } = subject([malformed]);
    await expect(inspectDlq({ queue: 'github', limit: 1 }, dependencies)).resolves.toMatchObject({
      messages: [{ messageId: 'broken', logicalWorkKey: 'unattributed:broken' }],
    });
    const plan = await planDlq({ queue: 'github', action: 'discard', messageIds: ['broken'], expectedCount: 1,
      reason: 'Malformed and cannot be replayed safely' }, dependencies);
    expect(plan.irreversible).toBe(true);
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 1 }, dependencies))
      .resolves.toMatchObject({ action: 'discard', appliedCount: 1 });
    expect(purge).toHaveBeenCalledWith('intern-notifs-github-dlq', ['private-broken']);
    database.close();
  });

  it('enforces the queue allowlist and plan expiry', async () => {
    const { database, dependencies } = subject([catalogMessage('m1')]);
    await expect(inspectDlq({ queue: 'not-a-real-queue' }, dependencies)).rejects.toThrow('allowlisted');
    const plan = await planDlq({ queue: 'lever', action: 'discard', messageIds: ['m1'], expectedCount: 1,
      reason: 'Superseded retry' }, dependencies);
    dependencies.now = () => new Date('2026-09-04T12:15:00.000Z');
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 1 }, dependencies))
      .rejects.toThrow('expired');
    database.close();
  });

  it('deduplicates catalog replay by source and pushes before exact purge', async () => {
    const { database, dependencies, send, purge, events } = subject([catalogMessage('m1'), catalogMessage('m2')]);
    const plan = await planDlq({ queue: 'lever', action: 'replay', messageIds: ['m1', 'm2'], expectedCount: 2,
      reason: 'Page inspection limit was fixed' }, dependencies);
    const result = await applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies);
    expect(result).toMatchObject({ action: 'replay', appliedCount: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'lever-acme', scheduledAt: '2026-09-04T12:00:00.000Z' }));
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('force');
    expect(purge).toHaveBeenCalledWith('intern-notifs-lever-dlq', ['private-m1', 'private-m2']);
    expect(events).toEqual(['send', 'purge']);
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .rejects.toThrow('already been applied');
    database.close();
  });

  it('replays a destination-verification message verbatim so consumer guards engage', async () => {
    const { database, dependencies, send, purge, events } = subject([destinationMessage('d1')]);
    const plan = await planDlq({ queue: 'destination-verification', action: 'replay', messageIds: ['d1'], expectedCount: 1,
      reason: 'Consumer #120 fix landed; safe to re-verify' }, dependencies);
    const result = await applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 1 }, dependencies);
    expect(result).toMatchObject({ queue: 'destination-verification', action: 'replay', appliedCount: 1 });
    // The exact stored body is re-enqueued: current-revision fields, idempotency
    // key, and shadow origin survive so the consumer settles obsolete/duplicate
    // messages and preserves shadow provenance without a catalog collapse.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(destinationMessage('d1').body);
    expect(events).toEqual(['send', 'purge']);
    expect(purge).toHaveBeenCalledWith('intern-notifs-destination-verification-dlq', ['private-d1']);
    expect(database.prepare('SELECT classification FROM dlq_disposition_audit').get()).toMatchObject({ classification: 'replayed' });
    database.close();
  });

  it('allows only one concurrent apply to acquire a repair plan', async () => {
    const { database, dependencies, send } = subject([catalogMessage('m1')]);
    const plan = await planDlq({ queue: 'lever', action: 'replay', messageIds: ['m1'], expectedCount: 1,
      reason: 'Transport issue is resolved' }, dependencies);
    const results = await Promise.allSettled([
      applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 1 }, dependencies),
      applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 1 }, dependencies),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    database.close();
  });

  it('classifies a successful pre-instrumentation GitHub replay as historical transient', async () => {
    const { database, dependencies } = subject([catalogMessage('legacy', 'github-pitt-csc')]);
    const plan = await planDlq({ queue: 'github', action: 'replay', messageIds: ['legacy'], expectedCount: 1,
      reason: 'Reproduce an unattributed historical failure' }, dependencies);
    await applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 1 }, dependencies);
    expect(database.prepare('SELECT classification, diagnostic FROM dlq_disposition_audit').get()).toEqual({
      classification: 'historical-transient',
      diagnostic: 'Original failure predates instrumentation and cannot be reconstructed.',
    });
    database.close();
  });

  it('rejects selection drift and count mismatches, but no longer blocks destination replay', async () => {
    const drift = subject([catalogMessage('m1')]);
    await expect(planDlq({ queue: 'lever', action: 'discard', messageIds: ['missing'], expectedCount: 1, reason: 'obsolete' }, drift.dependencies))
      .rejects.toThrow('Selection drift');
    await expect(planDlq({ queue: 'lever', action: 'discard', messageIds: ['m1'], expectedCount: 2, reason: 'obsolete' }, drift.dependencies))
      .rejects.toThrow('expectedCount');
    drift.database.close();

    const quarantined = subject([catalogMessage('m1')], async () => ({ sourceId: 'lever-acme', state: 'quarantined',
      sourceStatus: 'paused', lastAttemptAt: 'now', consecutiveFailures: 2, durationMs: 1 }));
    await expect(planDlq({ queue: 'lever', action: 'replay', messageIds: ['m1'], expectedCount: 1, reason: 'retry' }, quarantined.dependencies))
      .rejects.toThrow('recover, verify, and resume');
    quarantined.database.close();
  });

  it('retries a failed purge without sending an already-recorded replay twice', async () => {
    const { database, dependencies, send, purge } = subject([catalogMessage('m1'), catalogMessage('m2')]);
    const plan = await planDlq({ queue: 'lever', action: 'replay', messageIds: ['m1', 'm2'], expectedCount: 2, reason: 'fixed' }, dependencies);
    purge.mockResolvedValueOnce({ failedRefs: ['private-m1'] }).mockResolvedValueOnce({ failedRefs: [] });
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .rejects.toThrow('plan remains retryable');
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies)).resolves.toMatchObject({ appliedCount: 2 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(purge.mock.calls[1]?.[1]).toEqual(['private-m1']);
    database.close();
  });

  it('retains exact GitHub attribution, resolves it, and removes old metadata', async () => {
    const { database, dependencies } = subject([]);
    await recordQueueFailure({ db: dependencies.db, queueName: 'intern-notifs-github', messageId: 'm1', attempts: 3,
      timestamp: new Date('2026-09-04T10:00:00.000Z'), sourceId: 'github-pitt-csc', sourceKind: 'markdown',
      body: { sourceId: 'github-pitt-csc' }, error: new Error('https://secret.example/role timed out'),
      now: new Date('2026-07-01T00:00:00.000Z') });
    const stored = database.prepare('SELECT * FROM queue_failure_events').get() as Record<string, unknown>;
    expect(stored).toMatchObject({ message_id: 'm1', delivery_attempt: 3, source_id: 'github-pitt-csc',
      category: 'transport', resolved_at: null });
    expect(stored.diagnostic).toBe('[url] timed out');
    await resolveQueueFailures(dependencies.db, 'intern-notifs-github', 'm1', new Date('2026-07-02T00:00:00.000Z'));
    expect(database.prepare('SELECT resolved_at FROM queue_failure_events').get()).toMatchObject({ resolved_at: '2026-07-02T00:00:00.000Z' });
    await cleanupDlqRecords(dependencies.db, new Date('2026-09-04T12:00:00.000Z'));
    expect(database.prepare('SELECT COUNT(*) AS count FROM queue_failure_events').get()).toMatchObject({ count: 0 });
    database.close();
  });

  it('does not throw when failure-ledger persistence is unavailable', async () => {
    const run = vi.fn(async () => { throw new Error('D1 unavailable'); });
    const db = {
      prepare: () => ({ bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, run }),
      async batch() { return []; },
    } as D1Database;
    await expect(recordQueueFailureBestEffort({ db, queueName: 'intern-notifs-github', messageId: 'm1', attempts: 4,
      body: { sourceId: 'github-pitt-csc' }, error: new Error('upstream failed') })).resolves.toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
