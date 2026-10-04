/**
 * Read-only health gate for the production-mirrored Cloudflare dev ingestion
 * stack. It samples durable D1 state, every work queue/DLQ, the active cron
 * schedule, and the public dev catalog. Scheduled workflow runs retain the JSON
 * report so a 24-hour or seven-day soak can be assessed without mutating dev.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INGESTION_V2_D1_WRITE_LIMIT, INGESTION_V2_RUN_LIMIT } from '../cloudflare/ingestion-health-alert.js';

const DEFAULT_DATABASE_ID = 'cedc86d8-69a5-4a72-a1e6-f5629d722338';
const DEFAULT_API_URL = 'https://intern-notifs-dev.jdkrasnick.workers.dev';
const DEFAULT_WORKER = 'intern-notifs-dev-ingestion';
const DEFAULT_CANARY = 'northwestern-fintech-2027-quant';
const QUEUE_SUFFIXES = [
  'greenhouse', 'lever', 'ashby', 'github', 'gmail',
  'destination-verification', 'shadow-extraction', 'resume-job-import', 'admission-v2',
] as const;

interface QueueSummary { queue_id: string; queue_name: string }
interface QueueMetrics { backlog_count: number; backlog_bytes: number }
interface SourceHealth {
  state?: string;
  sourceStatus?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  consecutiveFailures?: number;
}
interface Check { name: string; status: 'pass' | 'warn' | 'fail'; detail: string }

export interface DevSoakSample {
  capturedAt: string;
  windowHours: number;
  canary: {
    sourceId: string;
    health?: SourceHealth;
    activeSnapshot?: Record<string, unknown>;
    shadowComparison?: Record<string, unknown>;
    rows: Array<Record<string, unknown>>;
    pendingHandoffs: number;
    staleHandoffs: number;
    expiredLeases: number;
  };
  maintenance: Array<Record<string, unknown>>;
  unresolvedFailures: Array<Record<string, unknown>>;
  queues: Record<string, QueueMetrics>;
  cronCount: number;
  publicCatalogStatus: number;
}

export function evaluateDevSoak(sample: DevSoakSample, now = new Date(sample.capturedAt)): Check[] {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, status: ok ? 'pass' : 'fail', detail });
  };
  check('production cron parity', sample.cronCount === 11, `${sample.cronCount}/11 triggers active`);
  check('public dev catalog', sample.publicCatalogStatus === 200, `HTTP ${sample.publicCatalogStatus}`);

  const health = sample.canary.health;
  const successAgeMinutes = health?.lastSuccessAt
    ? Math.max(0, (now.getTime() - Date.parse(health.lastSuccessAt)) / 60_000)
    : Number.POSITIVE_INFINITY;
  check('canary source health', health?.state === 'healthy' && health.sourceStatus !== 'paused'
    && (health.consecutiveFailures ?? 0) === 0,
  `${health?.state ?? 'missing'}/${health?.sourceStatus ?? 'unknown'}, failures=${health?.consecutiveFailures ?? 'unknown'}`);
  check('canary polling freshness', successAgeMinutes <= 60,
    Number.isFinite(successAgeMinutes) ? `${successAgeMinutes.toFixed(1)} minutes since success` : 'no successful poll');
  check('complete active snapshot', sample.canary.activeSnapshot?.is_complete === 1,
    sample.canary.activeSnapshot ? `snapshot ${sample.canary.activeSnapshot.snapshot_hash}` : 'missing active snapshot');
  check('recent shadow comparison', Boolean(sample.canary.shadowComparison),
    sample.canary.shadowComparison ? `observed ${sample.canary.shadowComparison.observed_at}` : 'missing comparison');
  const costWindow = sample.canary.shadowComparison;
  const windowRunCount = Number(costWindow?.window_run_count ?? 0);
  const windowD1RowsWritten = Number(costWindow?.window_d1_rows_written ?? 0);
  check('V2 cost window initialized', typeof costWindow?.window_started_at === 'string',
    costWindow?.window_started_at ? `started ${costWindow.window_started_at}` : 'missing cost window');
  check('V2 shadow run budget', windowRunCount < INGESTION_V2_RUN_LIMIT,
    `${windowRunCount}/${INGESTION_V2_RUN_LIMIT} runs in current one-hour window`);
  check('V2 D1 write budget', windowD1RowsWritten < INGESTION_V2_D1_WRITE_LIMIT,
    `${windowD1RowsWritten}/${INGESTION_V2_D1_WRITE_LIMIT} rows in current one-hour window`);
  const maintenance = sample.maintenance.find((row) => String(row.key).endsWith(':ingestion_v2_admission_dispatch'));
  const maintenanceValue = maintenance?.value ? JSON.parse(String(maintenance.value)) as { status?: string } : undefined;
  const maintenanceAgeMinutes = maintenance?.updated_at
    ? Math.max(0, (now.getTime() - Date.parse(String(maintenance.updated_at))) / 60_000)
    : Number.POSITIVE_INFINITY;
  check('scheduled admission maintenance', maintenanceValue?.status === 'complete' && maintenanceAgeMinutes <= 60,
    maintenance ? `${maintenanceValue?.status ?? 'unknown'}, ${maintenanceAgeMinutes.toFixed(1)} minutes ago` : 'missing phase marker');
  const rowCount = sample.canary.rows.reduce((sum, row) => sum + Number(row.rows ?? 0), 0);
  const quarantined = sample.canary.rows
    .filter((row) => row.state === 'quarantined')
    .reduce((sum, row) => sum + Number(row.rows ?? 0), 0);
  check('canary row ledger populated', rowCount > 0, `${rowCount} durable row(s)`);
  check('no quarantined canary rows', quarantined === 0, `${quarantined} quarantined row(s)`);
  check('no stale admission handoff', sample.canary.staleHandoffs === 0,
    `${sample.canary.staleHandoffs} handoff(s) older than 15 minutes`);
  check('no expired admission lease', sample.canary.expiredLeases === 0,
    `${sample.canary.expiredLeases} expired processing lease(s)`);
  check('no unresolved queue failures', sample.unresolvedFailures.length === 0,
    `${sample.unresolvedFailures.length} unresolved failure group(s) in ${sample.windowHours}h`);

  for (const suffix of QUEUE_SUFFIXES) {
    const dlqName = `intern-notifs-dev-${suffix}-dlq`;
    const metrics = sample.queues[dlqName];
    check(`${suffix} DLQ empty`, metrics?.backlog_count === 0,
      metrics ? `${metrics.backlog_count} message(s)` : 'queue missing');
    const workName = `intern-notifs-dev-${suffix}`;
    const work = sample.queues[workName];
    if (!work) checks.push({ name: `${suffix} work queue present`, status: 'fail', detail: 'queue missing' });
    else if (work.backlog_count > 100) checks.push({
      name: `${suffix} work backlog`, status: 'warn', detail: `${work.backlog_count} message(s); inspect drain trend`,
    });
  }
  return checks;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<number> {
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const databaseId = process.env.CLOUDFLARE_DEV_D1_DATABASE_ID ?? DEFAULT_DATABASE_ID;
  const publicApiUrl = (process.env.DEV_PUBLIC_API_URL ?? DEFAULT_API_URL).replace(/\/+$/u, '');
  const workerName = process.env.DEV_INGESTION_WORKER ?? DEFAULT_WORKER;
  const canary = process.env.INGESTION_V2_DEV_CANARY ?? DEFAULT_CANARY;
  const windowHours = Number(process.env.INGESTION_V2_SOAK_WINDOW_HOURS ?? '24');
  const output = process.env.INGESTION_V2_SOAK_REPORT
    ?? '.context/verification/ingestion-v2/dev-soak/report.json';
  const capturedAt = new Date();
  const windowStart = new Date(capturedAt.getTime() - windowHours * 3_600_000).toISOString();
  const staleHandoffBefore = new Date(capturedAt.getTime() - 15 * 60_000).toISOString();

  async function cloudflare<T>(path: string): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { success: boolean; result: T; errors?: Array<{ message?: string }> };
    if (!response.ok || !body.success) throw new Error(
      `Cloudflare request failed for ${path}: ${body.errors?.map((error) => error.message).join('; ') ?? response.status}`,
    );
    return body.result;
  }

  async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    const body = (await response.json()) as {
      success: boolean; errors?: Array<{ message?: string }>; result?: Array<{ results: T[] }>;
    };
    if (!response.ok || !body.success) throw new Error(
      `D1 query failed: ${body.errors?.map((error) => error.message).join('; ') ?? response.status}`,
    );
    return body.result?.[0]?.results ?? [];
  }

  const [healthRows, snapshots, comparisons, rowStates, handoffs, leases, failures, maintenance, queues, schedules, catalog] = await Promise.all([
    query<{ value: string }>("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'HEALTH'", [`SOURCE#${canary}`]),
    query<Record<string, unknown>>(`SELECT snapshot_hash, admission_version, row_count, document_count, state,
      is_complete, baseline, activated_at FROM ingestion_snapshots
      WHERE source_id = ? AND state = 'active' ORDER BY activated_at DESC LIMIT 1`, [canary]),
    query<Record<string, unknown>>(`SELECT snapshot_hash, admission_version, complete, observed_at, updated_at, run_count,
      window_started_at, window_run_count, window_d1_rows_written
      FROM ingestion_v2_shadow_comparisons WHERE source_id = ? AND observed_at >= ?`, [canary, windowStart]),
    query<Record<string, unknown>>(`SELECT state, COALESCE(decision, '') AS decision, COUNT(*) AS rows,
      SUM(attempt_count) AS attempts, MAX(updated_at) AS latest_update FROM ingestion_rows
      WHERE source_id = ? GROUP BY state, decision ORDER BY state, decision`, [canary]),
    query<{ pending: number; stale: number }>(`SELECT COUNT(*) AS pending,
      SUM(CASE WHEN dispatched_at < ? THEN 1 ELSE 0 END) AS stale
      FROM ingestion_admission_handoffs WHERE source_id = ? AND acknowledged_at IS NULL`, [staleHandoffBefore, canary]),
    query<{ expired: number }>(`SELECT COUNT(*) AS expired FROM ingestion_rows
      WHERE source_id = ? AND state = 'processing' AND lease_expires_at < ?`, [canary, capturedAt.toISOString()]),
    query<Record<string, unknown>>(`SELECT queue_name, category, COUNT(*) AS failures, MAX(last_failed_at) AS latest
      FROM queue_failure_events WHERE resolved_at IS NULL AND last_failed_at >= ?
      GROUP BY queue_name, category ORDER BY queue_name, category`, [windowStart]),
    query<Record<string, unknown>>(`SELECT key, value, updated_at FROM system_state
      WHERE key IN ('maintenance_phase:maintenance:ingestion_v2_admission_dispatch',
      'maintenance_phase:maintenance:maintenance_complete') ORDER BY key`),
    cloudflare<QueueSummary[]>('/queues?per_page=100'),
    cloudflare<{ schedules: Array<{ cron: string }> }>(`/workers/scripts/${workerName}/schedules`),
    fetch(`${publicApiUrl}/catalog?limit=1`),
  ]);

  const relevantQueueNames = new Set(QUEUE_SUFFIXES.flatMap((suffix) => [
    `intern-notifs-dev-${suffix}`, `intern-notifs-dev-${suffix}-dlq`,
  ]));
  const queueMetrics = Object.fromEntries(await Promise.all(queues
    .filter((queue) => relevantQueueNames.has(queue.queue_name))
    .map(async (queue) => [queue.queue_name, await cloudflare<QueueMetrics>(`/queues/${queue.queue_id}/metrics`)] as const)));
  const handoff = handoffs[0];
  const sample: DevSoakSample = {
    capturedAt: capturedAt.toISOString(),
    windowHours,
    canary: {
      sourceId: canary,
      ...(healthRows[0] ? { health: JSON.parse(healthRows[0].value) as SourceHealth } : {}),
      ...(snapshots[0] ? { activeSnapshot: snapshots[0] } : {}),
      ...(comparisons[0] ? { shadowComparison: comparisons[0] } : {}),
      rows: rowStates,
      pendingHandoffs: handoff?.pending ?? 0,
      staleHandoffs: handoff?.stale ?? 0,
      expiredLeases: leases[0]?.expired ?? 0,
    },
    maintenance,
    unresolvedFailures: failures,
    queues: queueMetrics,
    cronCount: schedules.schedules.length,
    publicCatalogStatus: catalog.status,
  };
  const checks = evaluateDevSoak(sample, capturedAt);
  const report = { ...sample, checks };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    '# Ingestion V2 dev soak checkpoint', '',
    `Captured: \`${sample.capturedAt}\``, '',
    '| Check | Status | Detail |', '| --- | --- | --- |',
    ...checks.map((entry) => `| ${entry.name} | ${entry.status.toUpperCase()} | ${entry.detail} |`),
    '', `Report: \`${output}\``,
  ];
  const summary = lines.join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
  return checks.some((entry) => entry.status === 'fail') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
