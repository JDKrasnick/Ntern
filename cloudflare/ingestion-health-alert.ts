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
 * and admission-incident signals. Kept in step with the consumers in
 * `wrangler.ingestion.jsonc` by a configuration test. */
export const INGESTION_WORK_QUEUES = [
  'intern-notifs-github', 'intern-notifs-greenhouse', 'intern-notifs-lever', 'intern-notifs-ashby',
  'intern-notifs-gmail', 'intern-notifs-resume-job-import', 'intern-notifs-shadow-extraction',
  'intern-notifs-admission-v2',
] as const;

const DEFAULT_FAILURE_WINDOW_MS = 24 * 60 * 60_000;
export const INGESTION_V2_COST_WINDOW_MS = 60 * 60_000;
export const INGESTION_V2_RUN_LIMIT = 60;
export const INGESTION_V2_D1_WRITE_LIMIT = 100_000;
const MAX_DETAIL_ITEMS = 20;

export type IngestionHealthSignals = { signals: string[]; details: string };

type FailureRow = { queue_name: string; source_id: string | null; category: string; n: number; last_failed_at: string };
type HealthRow = { pk: string; value: string };
type MarkerRow = { value: string };
type V2CostRow = {
  source_id: string;
  window_started_at: string;
  window_run_count: number;
  window_d1_rows_written: number;
};

/**
 * Names the ingestion conditions beyond the DLQ that an operator should hear
 * about: unresolved source failures by category, quarantined sources, and a
 * failure-ledger write that never landed. Signals are category-level so the
 * once-a-day alert dedupe key stays stable, while the details carry the specific
 * sources. Reading the ledger rather than the live queues keeps the check
 * non-consuming and side-effect free. Publication stalling while polls succeed
 * is a different failure and alerts through the catalog-recency signal.
 */
export async function ingestionHealthSignals(
  db: D1Database,
  observedAt: Date,
  options: { windowMs?: number; v2CostWindowMs?: number; v2RunLimit?: number; v2D1WriteLimit?: number } = {},
): Promise<IngestionHealthSignals> {
  const windowMs = options.windowMs ?? DEFAULT_FAILURE_WINDOW_MS;
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

  // 2. Quarantined sources, from stored source health. A disabled source keeps no
  // health row, so only a live quarantine appears here.
  // `kind` is the leading column of catalog_items_kind_pk_sk, so naming it lets
  // SQLite use that index instead of scanning the whole catalog on every pass.
  const healthRows = (await db.prepare(`SELECT pk, value FROM catalog_items WHERE sk = 'HEALTH' AND kind = 'source-health'`).all<HealthRow>()).results;
  const quarantined: string[] = [];
  for (const row of healthRows) {
    let health: SourceHealth | undefined;
    try { health = JSON.parse(row.value) as SourceHealth; } catch { continue; }
    if (!health) continue;
    if (health.state === 'quarantined') quarantined.push(health.sourceId ?? row.pk.replace(/^SOURCE#/u, ''));
  }
  if (quarantined.length) {
    signals.add('source-quarantined');
    details.push(`quarantined sources: ${quarantined.slice(0, MAX_DETAIL_ITEMS).join(', ')}`
      + (quarantined.length > MAX_DETAIL_ITEMS ? ` (+${quarantined.length - MAX_DETAIL_ITEMS} more)` : ''));
  }

  // 3. A failure the ledger could not record is invisible everywhere else.
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

  // 4. The shadow comparison is already written once per V2 discovery run.
  // Its tumbling counters expose runaway continuation loops and write
  // amplification without creating a second per-run telemetry write.
  const v2CostSince = new Date(observedAt.getTime() - (options.v2CostWindowMs ?? INGESTION_V2_COST_WINDOW_MS)).toISOString();
  const v2RunLimit = options.v2RunLimit ?? INGESTION_V2_RUN_LIMIT;
  const v2D1WriteLimit = options.v2D1WriteLimit ?? INGESTION_V2_D1_WRITE_LIMIT;
  const v2Costs = (await db.prepare(`SELECT source_id, window_started_at, window_run_count, window_d1_rows_written
      FROM ingestion_v2_shadow_comparisons
      WHERE window_started_at >= ? AND updated_at >= ?
        AND (window_run_count >= ? OR window_d1_rows_written >= ?)
      ORDER BY window_d1_rows_written DESC, window_run_count DESC
      LIMIT ?`)
    .bind(v2CostSince, v2CostSince, v2RunLimit, v2D1WriteLimit, MAX_DETAIL_ITEMS).all<V2CostRow>()).results;
  if (v2Costs.some((row) => row.window_run_count >= v2RunLimit)) signals.add('ingestion-v2-run-rate');
  if (v2Costs.some((row) => row.window_d1_rows_written >= v2D1WriteLimit)) signals.add('ingestion-v2-d1-write-rate');
  if (v2Costs.length) {
    details.push(`ingestion V2 one-hour cost limits exceeded: ${v2Costs
      .map((row) => `${row.source_id} ${row.window_run_count} runs/${row.window_d1_rows_written} D1 rows since ${row.window_started_at}`)
      .join('; ')}`);
  }

  return { signals: [...signals].sort(), details: details.join('\n') };
}
