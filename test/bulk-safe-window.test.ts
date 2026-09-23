import { describe, expect, it, vi } from 'vitest';
import { assessBulkSafeWindow } from '../cloudflare/bulk-safe-window.js';
import type { D1Database, Queue } from '../cloudflare/types.js';

const db = (count: number) => ({
  prepare: () => ({ bind: () => ({ first: async () => ({ count }) }) }),
}) as unknown as D1Database;
const queue = (count: number) => ({ metrics: async () => ({ backlogCount: count, backlogBytes: 0 }) }) as Queue;
const now = new Date('2026-09-23T06:00:00.000Z');

describe('manual bulk operation window', () => {
  it('defers immediately after D1 overload without sampling queues', async () => {
    const metrics = vi.fn(async () => ({ backlogCount: 0, backlogBytes: 0 }));
    expect(await assessBulkSafeWindow(db(1), { github: { metrics } as unknown as Queue }, now))
      .toEqual({ ready: false, reason: 'recent-d1-overload' });
    expect(metrics).not.toHaveBeenCalled();
  });

  it('requires every work queue to report zero backlog', async () => {
    expect(await assessBulkSafeWindow(db(0), { github: queue(1), greenhouse: queue(0) }, now))
      .toEqual({ ready: false, reason: 'queue-busy', queues: ['github'] });
    expect(await assessBulkSafeWindow(db(0), { github: queue(0), greenhouse: undefined }, now))
      .toEqual({ ready: false, reason: 'queue-metrics-unavailable', queues: ['greenhouse'] });
    expect(await assessBulkSafeWindow(db(0), { github: queue(0), greenhouse: queue(0) }, now))
      .toEqual({ ready: true });
  });
});
