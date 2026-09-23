import type { D1Database, Queue } from './types.js';

const snapshotPk = 'OPERATIONS#DLQ';
const snapshotSk = 'BASELINE';

export interface DlqGrowth {
  counts: Record<string, number>;
  increases: Record<string, number>;
  changed: boolean;
}

/** A missing metric is never interpreted as a drained queue. */
export async function measureDlqGrowth(db: D1Database, queues: Record<string, Queue | undefined>): Promise<DlqGrowth> {
  const row = await db.prepare('SELECT value FROM catalog_items WHERE pk = ? AND sk = ?')
    .bind(snapshotPk, snapshotSk).first<{ value: string }>();
  const previous = row ? JSON.parse(row.value) as Record<string, number> : {};
  const counts = { ...previous };
  const increases: Record<string, number> = {};
  const entries = Object.entries(queues);
  const measured = await Promise.allSettled(entries.map(async ([name, queue]) => {
    if (!queue?.metrics) return undefined;
    const metric = await queue.metrics();
    return { name, count: metric.backlogCount };
  }));
  for (const [index, result] of measured.entries()) {
    if (result.status === 'rejected') {
      console.warn(JSON.stringify({ event: 'dlq_metric_unavailable', queue: entries[index]?.[0] }));
      continue;
    }
    if (!result.value) continue;
    const { name, count } = result.value;
    if (!Number.isSafeInteger(count) || count < 0) continue;
    if (previous[name] !== undefined && count > previous[name]) increases[name] = count - previous[name];
    counts[name] = count;
  }
  return { counts, increases, changed: JSON.stringify(counts) !== JSON.stringify(previous) };
}

export async function recordDlqBaseline(db: D1Database, counts: Record<string, number>): Promise<void> {
  await db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, 'operations-dlq-baseline', ?)
    ON CONFLICT(pk, sk) DO UPDATE SET value = excluded.value`)
    .bind(snapshotPk, snapshotSk, JSON.stringify(counts)).run();
}
