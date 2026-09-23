import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { recentD1OverloadCount } from '../cloudflare/d1-overload-alert.js';
import type { D1Database } from '../cloudflare/types.js';

describe('recent D1 overload alert evidence', () => {
  it('counts only recent overload failures across queues', async () => {
    const sql = new DatabaseSync(':memory:');
    sql.exec('CREATE TABLE queue_failure_events (last_failed_at TEXT, diagnostic TEXT)');
    const insert = sql.prepare('INSERT INTO queue_failure_events VALUES (?, ?)');
    insert.run('2026-09-23T04:39:59Z', 'D1_ERROR: D1 DB is overloaded. Requests queued for too long.');
    insert.run('2026-09-23T04:40:00Z', 'D1_ERROR: D1 DB is overloaded. Requests queued for too long.');
    insert.run('2026-09-23T04:59:00Z', 'HTTP 429 upstream');
    const db = {
      prepare(query: string) {
        return {
          bind(since: string) {
            return { async first() { return sql.prepare(query).get(since); } };
          },
        };
      },
    } as unknown as D1Database;
    expect(await recentD1OverloadCount(db, new Date('2026-09-23T05:10:00Z'))).toBe(1);
    sql.close();
  });
});
