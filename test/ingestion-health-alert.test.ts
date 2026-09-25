import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ingestionHealthSignals } from '../cloudflare/ingestion-health-alert.js';
import type { D1Database } from '../cloudflare/types.js';

/** A fake D1 over an in-memory SQLite database, covering prepare/bind/first/all. */
function fakeDb(sql: DatabaseSync): D1Database {
  const statement = (query: string, args: unknown[]) => ({
    async first() { return sql.prepare(query).get(...(args as never[])); },
    async all() { return { results: sql.prepare(query).all(...(args as never[])) }; },
    async run() { return sql.prepare(query).run(...(args as never[])); },
  });
  return {
    prepare(query: string) {
      return {
        ...statement(query, []),
        bind: (...args: unknown[]) => statement(query, args),
      };
    },
    async batch() { return []; },
  } as unknown as D1Database;
}

function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE queue_failure_events (
    id TEXT PRIMARY KEY, queue_name TEXT, message_id TEXT, delivery_attempt INTEGER,
    category TEXT, diagnostic TEXT, source_id TEXT, resolved_at TEXT, last_failed_at TEXT)`);
  sql.exec('CREATE TABLE catalog_items (pk TEXT, sk TEXT, kind TEXT, value TEXT, PRIMARY KEY (pk, sk))');
  return { sql, db: fakeDb(sql) };
}

const failure = (sql: DatabaseSync, input: { id: string; queue: string; source: string; category: string; at: string; resolvedAt?: string }) => {
  sql.prepare(`INSERT INTO queue_failure_events (id, queue_name, message_id, delivery_attempt, category, diagnostic, source_id, resolved_at, last_failed_at)
    VALUES (?, ?, ?, 1, ?, 'diag', ?, ?, ?)`)
    .run(input.id, input.queue, input.id, input.category, input.source, input.resolvedAt ?? null, input.at);
};

const health = (sql: DatabaseSync, sourceId: string, value: Record<string, unknown>) => {
  sql.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, \'HEALTH\', \'source-health\', ?)')
    .run(`SOURCE#${sourceId}`, JSON.stringify({ sourceId, ...value }));
};

describe('ingestion health signals', () => {
  const observedAt = new Date('2026-09-25T12:00:00Z');

  it('names defect failures, quarantine, an unavailable ledger, and starvation', async () => {
    const { sql, db } = setup();
    try {
      // Unresolved defect failure -> signal. Resolved failure and transient
      // transport failure -> no signal.
      failure(sql, { id: 'a', queue: 'intern-notifs-ashby', source: 'ashby-acme', category: 'json', at: '2026-09-25T11:30:00Z' });
      failure(sql, { id: 'b', queue: 'intern-notifs-github', source: 'gh-acme', category: 'quality', at: '2026-09-25T11:00:00Z', resolvedAt: '2026-09-25T11:05:00Z' });
      failure(sql, { id: 'c', queue: 'intern-notifs-github', source: 'gh-acme', category: 'transport', at: '2026-09-25T11:40:00Z' });
      // A paused/quarantined source and an active source that last changed 10 days ago.
      health(sql, 'ashby-acme', { state: 'quarantined', sourceStatus: 'paused', quarantineReason: 'schema changed' });
      health(sql, 'gh-acme', { state: 'healthy', sourceStatus: 'active', lastChangedAt: '2026-09-15T12:00:00Z' });
      sql.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (\'OPERATIONS#LEDGER_FAILURE\', \'LAST\', \'queue-failure-ledger-failure\', ?)')
        .run(JSON.stringify({ at: '2026-09-25T11:50:00Z', queueName: 'intern-notifs-github', messageId: 'm1' }));

      const result = await ingestionHealthSignals(db, observedAt);
      expect(result.signals).toEqual(['catalog-starvation', 'failure-ledger-unavailable', 'source-failure-json', 'source-quarantined']);
      expect(result.details).toContain('ashby-acme json x1');
      expect(result.details).toContain('quarantined sources: ashby-acme');
      expect(result.details).toContain('no active source changed');
      expect(result.details).not.toContain('transport');
      expect(result.details).not.toContain('quality');
    } finally { sql.close(); }
  });

  it('stays quiet when failures recovered, the only failure is transient, and the catalog is fresh', async () => {
    const { sql, db } = setup();
    try {
      failure(sql, { id: 'a', queue: 'intern-notifs-github', source: 'gh-acme', category: 'json', at: '2026-09-25T11:00:00Z', resolvedAt: '2026-09-25T11:10:00Z' });
      failure(sql, { id: 'b', queue: 'intern-notifs-github', source: 'gh-acme', category: 'transport', at: '2026-09-25T11:40:00Z' });
      health(sql, 'gh-acme', { state: 'healthy', sourceStatus: 'active', lastChangedAt: '2026-09-25T11:30:00Z' });

      expect(await ingestionHealthSignals(db, observedAt)).toEqual({ signals: [], details: '' });
    } finally { sql.close(); }
  });

  it('ignores failures and ledger markers older than the window', async () => {
    const { sql, db } = setup();
    try {
      failure(sql, { id: 'a', queue: 'intern-notifs-ashby', source: 'ashby-acme', category: 'identity', at: '2026-09-20T00:00:00Z' });
      health(sql, 'ashby-acme', { state: 'healthy', sourceStatus: 'active', lastChangedAt: '2026-09-15T12:00:00Z' });
      sql.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (\'OPERATIONS#LEDGER_FAILURE\', \'LAST\', \'queue-failure-ledger-failure\', ?)')
        .run(JSON.stringify({ at: '2026-09-20T00:00:00Z', queueName: 'intern-notifs-github', messageId: 'm1' }));

      // 10 days quiet with the default 7-day threshold still starves; the point
      // here is the windowed filters, so widen the starvation threshold too.
      const result = await ingestionHealthSignals(db, observedAt, { starvationDays: 30 });
      expect(result.signals).toEqual([]);
    } finally { sql.close(); }
  });
});
