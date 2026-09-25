import { LEDGER_FAILURE_PK, LEDGER_FAILURE_SK } from './dlq-operations.js';
import type { SourceHealth } from '../src/types.js';
import type { D1Database } from './types.js';

/** Failure categories that name an ingestion defect rather than a transient
 * provider or network hiccup. `transport` and `http` normally recover on the
 * queue's own bounded retry, so they are excluded to keep this alert actionable;
 * a non-transient http status (401/403/404) quarantines the source instead and
 * surfaces through the quarantine signal. */
const INGESTION_BUG_CATEGORIES = ['json', 'identity', 'quality', 'capacity', 'link', 'persistence'] as const;

/** Work queues whose per-message failures are ingestion bugs. Destination
 * verification is excluded because its failures already alert through the DLQ
 * and admission-incident signals. */
const INGESTION_WORK_QUEUES = [
  'intern-notifs-github', 'intern-notifs-greenhouse', 'intern-notifs-lever', 'intern-notifs-ashby',
  'intern-notifs-gmail', 'intern-notifs-resume-job-import', 'intern-notifs-shadow-extraction',
] as const;

const DEFAULT_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_STARVATION_DAYS = 7;
const MAX_DETAIL_ITEMS = 20;

export type IngestionHealthSignals = { signals: string[]; details: string };

type FailureRow = { queue_name: string; source_id: string | null; category: string; n: number; last_failed_at: string };
type HealthRow = { pk: string; value: string };
type MarkerRow = { value: string };

/**
 * Names the ingestion conditions beyond the DLQ that an operator should hear
 * about, from the per-message failure ledger and the stored source health. The
 * signals are category-level so the once-a-day alert dedupe key stays stable,
 * while the details carry the specific sources. Reading the ledger rather than
 * the live queues keeps the check non-consuming and side-effect free.
 */
export async function ingestionHealthSignals(
  db: D1Database,
  observedAt: Date,
  options: { windowMs?: number; starvationDays?: number } = {},
): Promise<IngestionHealthSignals> {
  const windowMs = options.windowMs ?? DEFAULT_FAILURE_WINDOW_MS;
  const starvationMs = (options.starvationDays ?? DEFAULT_STARVATION_DAYS) * 24 * 60 * 60_000;
  const since = new Date(observedAt.getTime() - windowMs).toISOString();
  const signals = new Set<string>();
  const details: string[] = [];

  // 1. Unresolved failures in a category that indicates a defect. A failure the
  // queue later recovered from is resolved and deliberately excluded.
  const placeholders = INGESTION_WORK_QUEUES.map(() => '?').join(', ');
  const failures = (await db.prepare(`SELECT queue_name, source_id, category, COUNT(*) AS n, MAX(last_failed_at) AS last_failed_at
      FROM queue_failure_events
      WHERE resolved_at IS NULL AND last_failed_at >= ? AND queue_name IN (${placeholders})
      GROUP BY queue_name, source_id, category
      ORDER BY n DESC, last_failed_at DESC`)
    .bind(since, ...INGESTION_WORK_QUEUES).all<FailureRow>()).results;
  const bugFailures = failures.filter((row) => (INGESTION_BUG_CATEGORIES as readonly string[]).includes(row.category));
  if (bugFailures.length) {
    for (const row of bugFailures) signals.add(`source-failure-${row.category}`);
    details.push(`unresolved ingestion failures in the last ${Math.round(windowMs / 60_000)}m: ${bugFailures
      .slice(0, MAX_DETAIL_ITEMS).map((row) => `${row.source_id ?? row.queue_name} ${row.category} x${row.n}`).join('; ')}`);
  }

  // 2. Quarantined sources and (3) catalog starvation both come from one scan of
  // the stored source health. A source is "active" unless it is paused: shadow
  // sources still poll and a change there is not a public catalog change.
  const healthRows = (await db.prepare(`SELECT pk, value FROM catalog_items WHERE sk = 'HEALTH'`).all<HealthRow>()).results;
  const quarantined: string[] = [];
  let newestChangeMs = 0;
  let activeSources = 0;
  for (const row of healthRows) {
    let health: SourceHealth | undefined;
    try { health = JSON.parse(row.value) as SourceHealth; } catch { continue; }
    if (!health) continue;
    if (health.state === 'quarantined') quarantined.push(health.sourceId ?? row.pk.replace(/^SOURCE#/u, ''));
    if (health.sourceStatus === undefined || health.sourceStatus === 'active') {
      activeSources += 1;
      const changed = health.lastChangedAt ? Date.parse(health.lastChangedAt) : 0;
      if (Number.isFinite(changed) && changed > newestChangeMs) newestChangeMs = changed;
    }
  }
  if (quarantined.length) {
    signals.add('source-quarantined');
    details.push(`quarantined sources: ${quarantined.slice(0, MAX_DETAIL_ITEMS).join(', ')}`
      + (quarantined.length > MAX_DETAIL_ITEMS ? ` (+${quarantined.length - MAX_DETAIL_ITEMS} more)` : ''));
  }
  if (activeSources > 0 && observedAt.getTime() - newestChangeMs > starvationMs) {
    signals.add('catalog-starvation');
    details.push(`no active source changed since ${newestChangeMs ? new Date(newestChangeMs).toISOString() : 'never'} `
      + `(${activeSources} active source(s), threshold ${Math.round(starvationMs / 86_400_000)}d)`);
  }

  // 4. A failure the ledger could not record is invisible everywhere else.
  const marker = await db.prepare('SELECT value FROM catalog_items WHERE pk = ? AND sk = ?')
    .bind(LEDGER_FAILURE_PK, LEDGER_FAILURE_SK).first<MarkerRow>();
  if (marker?.value) {
    try {
      const parsed = JSON.parse(marker.value) as { at?: string; queueName?: string; messageId?: string };
      if (parsed.at && observedAt.getTime() - Date.parse(parsed.at) <= windowMs) {
        signals.add('failure-ledger-unavailable');
        details.push(`failure-ledger write failed at ${parsed.at} for ${parsed.queueName ?? 'unknown'} message ${parsed.messageId ?? 'unknown'}`);
      }
    } catch { /* a malformed marker is not itself an alert */ }
  }

  return { signals: [...signals].sort(), details: details.join('\n') };
}
