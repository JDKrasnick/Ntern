import type { D1Database } from './types.js';

/** Inspect the indexed failure ledger during maintenance, away from a failed delivery. */
export async function recentD1OverloadCount(db: D1Database, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 30 * 60_000).toISOString();
  const row = await db.prepare(`SELECT count(*) AS count FROM queue_failure_events
    WHERE last_failed_at >= ? AND diagnostic LIKE '%D1 DB is overloaded%'`)
    .bind(since).first<{ count: number }>();
  return Number(row?.count ?? 0);
}
