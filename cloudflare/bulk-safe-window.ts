import { recentD1OverloadCount } from './d1-overload-alert.js';
import type { D1Database, Queue } from './types.js';

export type BulkWindow =
  | { ready: true }
  | { ready: false; reason: 'recent-d1-overload' | 'queue-busy' | 'queue-metrics-unavailable'; queues?: string[] };

/** Check immediately before a manual operation that could contend with D1. */
export async function assessBulkSafeWindow(
  db: D1Database,
  workQueues: Record<string, Queue | undefined>,
  now: Date,
  options: { allowQueuedWork?: boolean } = {},
): Promise<BulkWindow> {
  if (await recentD1OverloadCount(db, now) > 0) return { ready: false, reason: 'recent-d1-overload' };
  // Read-only audits and capped repair batches do not add a catalog-sized D1
  // write workload. They may run alongside normal queue processing, but never
  // after a recent D1 overload.
  if (options.allowQueuedWork) return { ready: true };
  const entries = Object.entries(workQueues);
  const measured = await Promise.allSettled(entries.map(async ([name, queue]) => {
    if (!queue?.metrics) return { name, count: undefined };
    return { name, count: (await queue.metrics()).backlogCount };
  }));
  const unavailable: string[] = [];
  const busy: string[] = [];
  for (const [index, result] of measured.entries()) {
    const name = entries[index]![0];
    const count = result.status === 'fulfilled' ? result.value.count : undefined;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      unavailable.push(name);
    } else if (count > 0) busy.push(name);
  }
  if (unavailable.length) return { ready: false, reason: 'queue-metrics-unavailable', queues: unavailable };
  if (busy.length) return { ready: false, reason: 'queue-busy', queues: busy };
  return { ready: true };
}
