import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { measureDlqGrowth, recordDlqBaseline } from '../cloudflare/dlq-growth-alert.js';
import type { D1Database, Queue } from '../cloudflare/types.js';

describe('DLQ growth alert evidence', () => {
  it('baselines existing backlog and reports only increases in readable queues', async () => {
    const sql = new DatabaseSync(':memory:');
    sql.exec('CREATE TABLE catalog_items (pk TEXT, sk TEXT, kind TEXT, value TEXT, PRIMARY KEY (pk, sk))');
    const db = {
      prepare(query: string) {
        return {
          bind(...args: Array<string | number>) {
            return {
              async first() { return sql.prepare(query).get(...args); },
              async run() { return sql.prepare(query).run(...args); },
            };
          },
        };
      },
    } as unknown as D1Database;
    const queue = (count: number) => ({ metrics: async () => ({ backlogCount: count, backlogBytes: 0 }) }) as Queue;
    try {
      const first = await measureDlqGrowth(db, { github: queue(140), greenhouse: queue(3) });
      expect(first).toEqual({ counts: { github: 140, greenhouse: 3 }, increases: {}, changed: true });
      await recordDlqBaseline(db, first.counts);

      const second = await measureDlqGrowth(db, {
        github: queue(142), greenhouse: { metrics: async () => { throw new Error('unavailable'); } } as unknown as Queue,
      });
      expect(second).toEqual({ counts: { github: 142, greenhouse: 3 }, increases: { github: 2 }, changed: true });
      await recordDlqBaseline(db, second.counts);
      expect(await measureDlqGrowth(db, { github: queue(142), greenhouse: queue(3) }))
        .toEqual({ counts: { github: 142, greenhouse: 3 }, increases: {}, changed: false });

      expect(await measureDlqGrowth(db, { github: queue(141), greenhouse: queue(3) }))
        .toEqual({ counts: { github: 141, greenhouse: 3 }, increases: {}, changed: true });
    } finally {
      sql.close();
    }
  });
});
