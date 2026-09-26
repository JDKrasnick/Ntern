import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import ingestionWorker from '../cloudflare/ingestion-worker.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { Environment } from '../cloudflare/worker.js';

vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: vi.fn() } }));

function reconnectingD1(): { db: D1Database; first: ReturnType<typeof vi.fn> } {
  const first = vi.fn().mockRejectedValueOnce(new Error('Connection closed')).mockResolvedValue(null);
  const statement = { bind: vi.fn(), first, all: vi.fn(), run: vi.fn() } as unknown as D1PreparedStatement;
  return { db: { prepare: vi.fn(() => statement), batch: vi.fn() }, first };
}

/** A real in-memory D1 carrying the tables the destination-verification
 * consumer reads, so the worker boundary is exercised against actual SQL. */
function migratedD1(): { database: DatabaseSync; db: D1Database } {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0003_billing_shutdown.sql', '0007_catalog_admission.sql',
    '0008_catalog_admission_occurrence_repair.sql', '0010_posting_identity.sql',
    '0012_destination_verification_schedule.sql', '0015_dlq_recovery.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next); },
    async first<T>() { return (database.prepare(query).get(...(values as never[])) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...(values as never[])) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(query).run(...(values as never[])).changes) } }; },
  });
  return { database, db: { prepare: (query) => prepared(query),
    batch: async (statements) => Promise.all(statements.map((statement) => statement.run())) } };
}

const destinationBody = (idempotencyKey: string) => ({
  version: 1, jobId: 'job-1', sourceId: 'greenhouse-acme', externalId: '7654321',
  candidateUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321',
  providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-acme',
    sourceUrl: 'https://boards.greenhouse.io/acme', tenant: 'acme', postingId: '7654321' },
  reason: 'daily-retry', queuedAt: '2026-09-25T00:00:00Z', idempotencyKey,
});

describe('destination queue D1 resilience integration', () => {
  it.each([
    ['intern-notifs-destination-verification', 'retry'],
    ['intern-notifs-shadow-extraction', 'ack'],
  ] as const)('reconnects D1 in the %s consumer before its queue-specific settlement', async (queue, settlement) => {
    const { db, first } = reconnectingD1();
    const message = { id: `reconnect-${settlement}`, body: 'not-json', ack: vi.fn(), retry: vi.fn() };

    await ingestionWorker.queue({ queue, messages: [message] }, { DB: db } as Environment);

    expect(first).toHaveBeenCalledTimes(2);
    if (settlement === 'retry') {
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
      expect(message.ack).not.toHaveBeenCalled();
    } else {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it('resolves a pending destination-verification failure row through the worker boundary', async () => {
    const { database, db } = migratedD1();
    // The completion short-circuit settles this message without a job row, so the
    // test isolates the ledger resolution the ack now performs.
    await db.prepare('INSERT INTO destination_verification_completions (idempotency_key, completed_at) VALUES (?, ?)')
      .bind('ledger-complete', '2026-09-25T00:00:00Z').run();
    await db.prepare(`INSERT INTO queue_failure_events
      (id, queue_name, message_id, delivery_attempt, payload_hash, category, diagnostic, first_failed_at, last_failed_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .bind('failure-1', 'intern-notifs-destination-verification', 'ledger-message-1', 1, 'hash', 'transport',
        '[url] timed out', '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z').run();
    const message = { id: 'ledger-message-1', attempts: 2, timestamp: new Date('2026-09-25T00:00:00Z'),
      body: destinationBody('ledger-complete'), ack: vi.fn(), retry: vi.fn() };

    await ingestionWorker.queue({ queue: 'intern-notifs-destination-verification', messages: [message] },
      { DB: db } as unknown as Environment);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(database.prepare('SELECT resolved_at FROM queue_failure_events WHERE message_id = ?').get('ledger-message-1'))
      .toMatchObject({ resolved_at: expect.any(String) });
  });
});
