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

/**
 * A DLQ stand-in that leases what a peek returns, like the real API: the next
 * peek starts after the messages this one handed back, so consecutive peeks
 * return different subsets until the lease lapses. `retire` takes a message out
 * of the DLQ without this plan disposing of it, which is what makes its `ref`
 * unpurgeable.
 */
function dlqFake(messages: PeekedMessage[], leaseSize = messages.length) {
  const held = new Map(messages.map((message) => [message.ref, message]));
  const peeks: string[][] = [];
  const events: string[] = [];
  let cursor = 0;
  const purge = vi.fn(async (_queueId: string, refs: string[]): Promise<{ failedRefs: string[] }> => {
    events.push('purge');
    const failedRefs = refs.filter((ref) => !held.has(ref));
    for (const ref of refs) held.delete(ref);
    return { failedRefs };
  });
  return {
    peeks, events,
    retire(id: string) { for (const [ref, message] of held) if (message.id === id) held.delete(ref); },
    api: {
      async resolveQueueId(name: string) { return name; },
      async peek(_queueId: string, limit: number) {
        const available = [...held.values()];
        if (!available.length) { peeks.push([]); return []; }
        const start = cursor % available.length;
        const leased = [...available.slice(start), ...available.slice(0, start)].slice(0, Math.min(limit, leaseSize));
        cursor = (start + leased.length) % available.length;
        peeks.push(leased.map((message) => message.id));
        return leased;
      },
      purge,
    },
  };
}

function subject(messages: PeekedMessage[], health: DlqDependencies['sourceHealth'] = async () => undefined,
  leaseSize = messages.length) {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync('cloudflare/migrations/0001_initial.sql', 'utf8'));
  database.exec(readFileSync('cloudflare/migrations/0015_dlq_recovery.sql', 'utf8'));
  const fake = dlqFake(messages, leaseSize);
  const send = vi.fn(async (message: unknown) => { void message; fake.events.push('send'); });
  const queue: Queue = { send, async sendBatch() {} };
  const dependencies: DlqDependencies = {
    db: sqliteD1(database), sourceHealth: health, now: () => new Date('2026-09-04T12:00:00.000Z'),
    workQueues: { greenhouse: queue, lever: queue, ashby: queue, github: queue, gmail: queue, 'destination-verification': queue },
    api: fake.api,
  };
  return { database, dependencies, send, purge: fake.api.purge, events: fake.events, fake };
}

const catalogMessage = (id: string, sourceId = 'lever-acme'): PeekedMessage => ({
  id, attempts: 3, timestampMs: Date.parse('2026-09-04T10:00:00.000Z'), ref: `private-${id}`,
  body: { version: 1, sourceId, scheduledAt: '2026-09-04T09:00:00.000Z', runId: 'old-run' },
});

const destinationMessage = (id: string, label = '42'): PeekedMessage => ({
  id, attempts: 5, timestampMs: Date.parse('2026-09-04T10:00:00.000Z'), ref: `private-${id}`,
  body: {
    version: 1, jobId: 'job-1', sourceId: 'greenhouse-acme', externalId: `gh-${label}`,
    providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-acme', sourceUrl: 'https://boards.greenhouse.io/acme', postingId: label },
    candidateUrl: `https://boards.greenhouse.io/acme/jobs/${label}`, reason: 'content-change',
    queuedAt: '2026-09-04T09:00:00.000Z', idempotencyKey: `idem-${label}`, metadataExtractionVersion: 7,
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
    // A repeated apply is a no-op: the plan already disposed of its messages.
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .resolves.toMatchObject({ appliedCount: 0, conflicts: [] });
    expect(send).toHaveBeenCalledTimes(1);
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
    // The message that could not be purged is reported rather than thrown, and
    // the plan stays retryable for exactly that message.
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .resolves.toMatchObject({ appliedCount: 1, conflicts: ['m1'] });
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .resolves.toMatchObject({ appliedCount: 1, conflicts: [] });
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

describe('DLQ replay from the selection the plan peeked', () => {
  it('applies a selection seen by the plan peek even when a later peek is disjoint', async () => {
    const { database, dependencies, send, purge, fake } = subject(
      [catalogMessage('m1'), catalogMessage('m2'), catalogMessage('m3'), catalogMessage('m4')], undefined, 2);
    const plan = await planDlq({ queue: 'lever', action: 'replay', messageIds: ['m1', 'm2'], expectedCount: 2,
      reason: 'Page inspection limit was fixed' }, dependencies);
    expect(plan).toMatchObject({ expectedCount: 2, stagedCount: 2 });
    expect(fake.peeks).toEqual([['m1', 'm2']]);

    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .resolves.toMatchObject({ appliedCount: 2, conflicts: [], appliedAt: '2026-09-04T12:00:00.000Z' });
    // apply never peeked, so the lease that hides m1 and m2 from the next peek
    // cannot invalidate a plan that was valid when it was planned.
    expect(fake.peeks).toEqual([['m1', 'm2']]);
    expect((await dependencies.api.peek('intern-notifs-lever-dlq', 100)).map((message) => message.id)).toEqual(['m3', 'm4']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith('intern-notifs-lever-dlq', ['private-m1', 'private-m2']);
    database.close();
  });

  it('replays the planned messages in planned order with the payload the plan peeked', async () => {
    const messages = [destinationMessage('d1', '1'), destinationMessage('d2', '2'), destinationMessage('d3', '3')];
    const { database, dependencies, send, purge } = subject(messages);
    const plan = await planDlq({ queue: 'destination-verification', action: 'replay', messageIds: ['d3', 'd2', 'd1'],
      expectedCount: 3, reason: 'Consumer fix landed; safe to re-verify' }, dependencies);
    await applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 3 }, dependencies);
    expect(send.mock.calls.map(([body]) => body)).toEqual([messages[2]!.body, messages[1]!.body, messages[0]!.body]);
    expect(purge).toHaveBeenCalledWith('intern-notifs-destination-verification-dlq', ['private-d3', 'private-d2', 'private-d1']);
    database.close();
  });

  it('reports a message that left the DLQ as a conflict and replays the rest', async () => {
    const { database, dependencies, send, purge, fake } = subject(
      [catalogMessage('m1'), catalogMessage('m2'), catalogMessage('m3'), catalogMessage('m4')], undefined, 2);
    const plan = await planDlq({ queue: 'lever', action: 'replay', messageIds: ['m1', 'm2'], expectedCount: 2,
      reason: 'Page inspection limit was fixed' }, dependencies);
    fake.retire('m1');

    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .resolves.toMatchObject({ appliedCount: 1, conflicts: ['m1'], appliedAt: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith('intern-notifs-lever-dlq', ['private-m1', 'private-m2']);
    // The vanished message keeps its disposition unrecorded and the plan open.
    expect(database.prepare('SELECT message_id FROM dlq_disposition_audit').all()).toEqual([{ message_id: 'm2' }]);
    expect(database.prepare('SELECT applied_at FROM dlq_repair_plans').get()).toEqual({ applied_at: null });

    // A retry only touches what is still pending: nothing is replayed twice.
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .resolves.toMatchObject({ appliedCount: 0, conflicts: ['m1'] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('rejects a stale token or expected count and no-ops a repeated apply', async () => {
    const { database, dependencies, send, purge } = subject([catalogMessage('m1')]);
    const plan = await planDlq({ queue: 'lever', action: 'replay', messageIds: ['m1'], expectedCount: 1, reason: 'fixed' }, dependencies);
    await expect(applyDlq({ planId: plan.planId, repairToken: 'stale-token', expectedCount: 1 }, dependencies))
      .rejects.toThrow('token is invalid');
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2 }, dependencies))
      .rejects.toThrow('Expected count does not match');
    expect(send).not.toHaveBeenCalled();
    expect(purge).not.toHaveBeenCalled();
    expect(database.prepare('SELECT applied_at, applying_at FROM dlq_repair_plans').get())
      .toMatchObject({ applied_at: null, applying_at: null });

    const applied = await applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 1 }, dependencies);
    expect(applied).toMatchObject({ appliedCount: 1, conflicts: [] });
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalog_items').get()).toMatchObject({ count: 0 });

    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 1 }, dependencies))
      .resolves.toMatchObject({ appliedCount: 0, conflicts: [], appliedAt: applied.appliedAt });
    expect(send).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledTimes(1);
    database.close();
  });

  it('discards the planned selection and records the disposition audit', async () => {
    const { database, dependencies, send, purge } = subject([catalogMessage('m1'), catalogMessage('m2')]);
    const plan = await planDlq({ queue: 'lever', action: 'discard', messageIds: ['m1', 'm2'], expectedCount: 2,
      reason: 'Superseded retry' }, dependencies);
    await expect(applyDlq({ planId: plan.planId, repairToken: plan.repairToken, expectedCount: 2, actor: 'ops-owner' }, dependencies))
      .resolves.toMatchObject({ action: 'discard', appliedCount: 2, conflicts: [] });
    expect(send).not.toHaveBeenCalled();
    expect(purge).toHaveBeenCalledWith('intern-notifs-lever-dlq', ['private-m1', 'private-m2']);
    expect(database.prepare('SELECT message_id, operation, classification, actor FROM dlq_disposition_audit ORDER BY message_id').all())
      .toEqual([
        { message_id: 'm1', operation: 'discard', classification: 'discarded', actor: 'ops-owner' },
        { message_id: 'm2', operation: 'discard', classification: 'discarded', actor: 'ops-owner' },
      ]);
    database.close();
  });

  it('clears the staged selection with the plan that owns it', async () => {
    const { database, dependencies } = subject([catalogMessage('m1')]);
    await planDlq({ queue: 'lever', action: 'replay', messageIds: ['m1'], expectedCount: 1, reason: 'fixed' }, dependencies);
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalog_items').get()).toMatchObject({ count: 1 });
    // An applyable plan keeps its selection; an expired one does not outlive it.
    await cleanupDlqRecords(dependencies.db, new Date('2026-09-04T12:05:00.000Z'));
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalog_items').get()).toMatchObject({ count: 1 });
    await cleanupDlqRecords(dependencies.db, new Date('2026-09-04T12:20:00.000Z'));
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalog_items').get()).toMatchObject({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM dlq_repair_plans').get()).toMatchObject({ count: 0 });
    database.close();
  });
});
