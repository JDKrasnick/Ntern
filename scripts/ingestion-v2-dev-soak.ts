/**
 * Read-only health gate for the production-mirrored Cloudflare dev ingestion
 * stack. It samples durable D1 state, every work queue/DLQ, the active cron
 * schedule, and the public dev catalog. Scheduled workflow runs retain the JSON
 * report so a 24-hour or seven-day soak can be assessed without mutating dev.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnvelope } from '../src/ingestion-v2/normalize.js';
import { INGESTION_V2_D1_WRITE_LIMIT, INGESTION_V2_RUN_LIMIT } from '../cloudflare/ingestion-health-alert.js';

const DEFAULT_DATABASE_ID = 'cedc86d8-69a5-4a72-a1e6-f5629d722338';
const DEFAULT_API_URL = 'https://intern-notifs-dev.jdkrasnick.workers.dev';
const DEFAULT_WORKER = 'intern-notifs-dev-ingestion';
const DEV_CONFIG = JSON.parse(readFileSync(new URL('../wrangler.dev.ingestion.jsonc', import.meta.url), 'utf8')) as { vars: Record<string, string>; triggers: { crons: string[] } };
const EXPECTED_CRONS = (JSON.parse(readFileSync(new URL('../wrangler.ingestion.jsonc', import.meta.url), 'utf8')) as { triggers: { crons: string[] } }).triggers.crons;
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
  windowStartedAt: string;
  windowHours: number;
  soakStartedAt: string;
  runtime: Array<{ status: string; requests: number; errors: number; cpuTimeP99: number; memoryUsageBytesP99: number }>;
  canary: {
    sourceId: string;
    health?: SourceHealth;
    activeSnapshot?: Record<string, unknown>;
    shadowComparison?: Record<string, unknown>;
    rows: Array<Record<string, unknown>>;
    pendingHandoffs: number;
    staleHandoffs: number;
    expiredLeases: number;
    r2SnapshotValid: boolean;
  };
  canaries?: Array<DevSoakSample['canary']>;
  schedules: string[];
  controlMismatches: string[];
  publication?: { generatedAt?: string; version?: string; count?: number };
  maintenance: Array<Record<string, unknown>>;
  unresolvedFailures: Array<Record<string, unknown>>;
  exhaustedFailures: Array<Record<string, unknown>>;
  queues: Record<string, QueueMetrics>;
  cronCount: number;
  publicCatalogStatus: number;
}

export function evaluateDevSoak(sample: DevSoakSample, now = new Date(sample.capturedAt)): Check[] {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, status: ok ? 'pass' : 'fail', detail });
  };
  const missing = EXPECTED_CRONS.filter((cron) => !sample.schedules.includes(cron));
  const unexpected = sample.schedules.filter((cron) => !EXPECTED_CRONS.includes(cron));
  check('production cron parity', missing.length === 0 && unexpected.length === 0
    && sample.schedules.length === EXPECTED_CRONS.length,
  `${sample.schedules.length}/${EXPECTED_CRONS.length} triggers; missing=${missing.join(';')}; unexpected=${unexpected.join(';')}`);
  check('dev rollout controls', sample.controlMismatches.length === 0,
    sample.controlMismatches.join('; ') || 'tracked V2 controls and outbound suppression match');
  const elapsedHours = (now.getTime() - Date.parse(sample.soakStartedAt)) / 3_600_000;
  check('dev soak elapsed', elapsedHours >= sample.windowHours, `${elapsedHours.toFixed(1)}/${sample.windowHours} clean observation hours since latest deployment`);
  check('Worker runtime healthy', sample.runtime.length > 0
    && sample.runtime.every((row) => row.status === 'success' && row.errors === 0),
    sample.runtime.map((row) => `${row.status}: ${row.requests} requests, ${row.errors} errors`).join('; ') || 'missing runtime analytics');
  const memoryP99 = Math.max(...sample.runtime.map((row) => row.memoryUsageBytesP99));
  const cpuP99 = Math.max(...sample.runtime.map((row) => row.cpuTimeP99));
  checks.push({ name: 'Worker resource headroom', status: memoryP99 <= 120 * 1024 * 1024 && cpuP99 <= 60_000_000 ? 'pass' : 'warn',
    detail: `memory p99 ${(memoryP99 / 1024 / 1024).toFixed(1)} MiB; CPU p99 ${(cpuP99 / 1_000_000).toFixed(2)} s (whole ingestion Worker)` });
  check('public dev catalog', sample.publicCatalogStatus === 200, `HTTP ${sample.publicCatalogStatus}`);

  const canaries = sample.canaries ?? [sample.canary];
  for (const canary of canaries) {
    const sourceCheck = (name: string, ok: boolean, detail: string): void =>
      check(canaries.length > 1 ? `${canary.sourceId}: ${name}` : name, ok, detail);
    const health = canary.health;
    const successAgeMinutes = health?.lastSuccessAt
      ? Math.max(0, (now.getTime() - Date.parse(health.lastSuccessAt)) / 60_000)
      : Number.POSITIVE_INFINITY;
    sourceCheck('canary source health', health?.state === 'healthy' && health.sourceStatus !== 'paused'
      && (health.consecutiveFailures ?? 0) === 0,
    `${health?.state ?? 'missing'}/${health?.sourceStatus ?? 'unknown'}, failures=${health?.consecutiveFailures ?? 'unknown'}`);
    sourceCheck('canary polling freshness', successAgeMinutes <= 60,
      Number.isFinite(successAgeMinutes) ? `${successAgeMinutes.toFixed(1)} minutes since success` : 'no successful poll');
    sourceCheck('complete active snapshot', canary.activeSnapshot?.is_complete === 1,
      canary.activeSnapshot ? `snapshot ${canary.activeSnapshot.snapshot_hash}` : 'missing active snapshot');
    const comparisonAge = now.getTime() - Date.parse(String(canary.shadowComparison?.observed_at));
    sourceCheck('recent shadow comparison', canary.shadowComparison?.complete === 1
      && comparisonAge >= 0 && comparisonAge <= 60 * 60_000,
      canary.shadowComparison ? `observed ${canary.shadowComparison.observed_at}` : 'missing comparison');
    const costWindow = canary.shadowComparison;
    const windowRunCount = Number(costWindow?.window_run_count ?? 0);
    const windowD1RowsWritten = Number(costWindow?.window_d1_rows_written ?? 0);
    sourceCheck('V2 cost window initialized', typeof costWindow?.window_started_at === 'string',
      costWindow?.window_started_at ? `started ${costWindow.window_started_at}` : 'missing cost window');
    sourceCheck('V2 shadow run budget', windowRunCount < INGESTION_V2_RUN_LIMIT,
      `${windowRunCount}/${INGESTION_V2_RUN_LIMIT} runs in current one-hour window`);
    sourceCheck('V2 D1 write budget', windowD1RowsWritten < INGESTION_V2_D1_WRITE_LIMIT,
      `${windowD1RowsWritten}/${INGESTION_V2_D1_WRITE_LIMIT} rows in current one-hour window`);
    sourceCheck('R2 snapshot integrity', canary.r2SnapshotValid, 'immutable R2 envelope matches D1 hash, policy, and row count');
    sourceCheck('snapshot comparison identity', Boolean(canary.activeSnapshot?.snapshot_hash)
      && canary.activeSnapshot?.snapshot_hash === canary.shadowComparison?.snapshot_hash
      && canary.activeSnapshot?.admission_version === canary.shadowComparison?.admission_version, 'active snapshot and comparison hash/policy match');
    const rowCount = canary.rows.reduce((sum, row) => sum + Number(row.rows ?? 0), 0);
    const quarantined = canary.rows
      .filter((row) => row.state === 'quarantined')
      .reduce((sum, row) => sum + Number(row.rows ?? 0), 0);
    sourceCheck('canary row ledger populated', rowCount > 0, `${rowCount} durable row(s)`);
    sourceCheck('no quarantined canary rows', quarantined === 0, `${quarantined} quarantined row(s)`);
    sourceCheck('no stale admission handoff', canary.staleHandoffs === 0,
      `${canary.staleHandoffs} handoff(s) older than 15 minutes`);
    sourceCheck('no expired admission lease', canary.expiredLeases === 0,
      `${canary.expiredLeases} expired processing lease(s)`);
  }
  const maintenance = sample.maintenance.find((row) => String(row.key).endsWith(':ingestion_v2_admission_dispatch'));
  const maintenanceValue = maintenance?.value ? JSON.parse(String(maintenance.value)) as { status?: string } : undefined;
  const maintenanceAgeMinutes = maintenance?.updated_at
    ? Math.max(0, (now.getTime() - Date.parse(String(maintenance.updated_at))) / 60_000)
    : Number.POSITIVE_INFINITY;
  check('scheduled admission maintenance', maintenanceValue?.status === 'complete' && maintenanceAgeMinutes <= 60,
    maintenance ? `${maintenanceValue?.status ?? 'unknown'}, ${maintenanceAgeMinutes.toFixed(1)} minutes ago` : 'missing phase marker');
  const publicationAge = now.getTime() - Date.parse(sample.publication?.generatedAt ?? '');
  check('fresh R2 catalog publication', /^[a-f0-9]{20}$/.test(sample.publication?.version ?? '')
    && Number.isSafeInteger(sample.publication?.count) && Number(sample.publication?.count) >= 0
    && publicationAge >= 0 && publicationAge <= 30 * 60_000,
  sample.publication ? `generated ${sample.publication.generatedAt}, ${sample.publication.count} groups` : 'missing R2 catalog pointer');
  const r2Phase = sample.maintenance.find((row) => row.key === 'maintenance_phase:catalog_projection_r2:catalog_projection_r2_complete');
  const r2Age = now.getTime() - Date.parse(String(r2Phase?.updated_at));
  check('scheduled R2 publication', Boolean(r2Phase) && r2Age >= 0 && r2Age <= 30 * 60_000,
    r2Phase ? `completed ${r2Phase.updated_at}` : 'missing R2 cron completion');
  check('no unresolved queue failures', sample.unresolvedFailures.length === 0,
    `${sample.unresolvedFailures.length} unresolved failure group(s) in ${sample.windowHours}h`);
  check('no exhausted queue deliveries', sample.exhaustedFailures.length === 0,
    `${sample.exhaustedFailures.length} final-delivery failure group(s) in ${sample.windowHours}h`);

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
  const sourceIds = [...new Set((process.env.INGESTION_V2_DEV_SOURCES
    ?? process.env.INGESTION_V2_DEV_CANARY ?? DEV_CONFIG.vars.INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST
    ?? DEFAULT_CANARY).split(',').map((source) => source.trim()).filter(Boolean))];
  if (!sourceIds.length) throw new Error('at least one dev source is required');
  const windowHours = Number(process.env.INGESTION_V2_SOAK_WINDOW_HOURS ?? '24');
  const output = process.env.INGESTION_V2_SOAK_REPORT
    ?? '.context/verification/ingestion-v2/dev-soak/report.json';
  if (!Number.isFinite(windowHours) || windowHours <= 0 || windowHours > 168) throw new Error('soak window must be between 0 and 168 hours');
  const capturedAt = new Date();
  const deploymentResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/deployments`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  const deploymentBody = await deploymentResponse.json() as { success: boolean; result?: { deployments: Array<{ created_on: string }> } };
  const deploymentAt = new Date(deploymentBody.result?.deployments[0]?.created_on ?? '');
  if (!deploymentResponse.ok || !deploymentBody.success || !Number.isFinite(deploymentAt.getTime())) throw new Error('could not identify latest dev deployment');
  const rollingWindowStart = new Date(capturedAt.getTime() - windowHours * 3_600_000);
  const configuredWindowStart = process.env.INGESTION_V2_SOAK_STARTED_AT
    ? new Date(process.env.INGESTION_V2_SOAK_STARTED_AT)
    : undefined;
  if (configuredWindowStart && (!Number.isFinite(configuredWindowStart.getTime()) || configuredWindowStart > capturedAt)) {
    throw new Error('INGESTION_V2_SOAK_STARTED_AT must be an ISO-8601 timestamp');
  }
  const windowStart = new Date(Math.max(rollingWindowStart.getTime(), deploymentAt.getTime(), configuredWindowStart?.getTime() ?? 0)).toISOString();
  const staleHandoffBefore = new Date(capturedAt.getTime() - 15 * 60_000).toISOString();

  async function cloudflare<T>(path: string): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
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

  const placeholders = sourceIds.map(() => '?').join(',');
  const [healthRows, snapshots, comparisons, rowStates, handoffs, leases, failures, exhaustedFailures, maintenance, queues, schedules, settings, catalog, publication, runtime] = await Promise.all([
    query<{ pk: string; value: string }>(`SELECT pk, value FROM catalog_items WHERE pk IN (${placeholders}) AND sk = 'HEALTH'`, sourceIds.map((source) => `SOURCE#${source}`)),
    query<Record<string, unknown>>(`SELECT source_id, snapshot_hash, object_key, admission_version, row_count, document_count, state,
      is_complete, baseline, activated_at FROM ingestion_snapshots
      WHERE source_id IN (${placeholders}) AND state = 'active' ORDER BY activated_at DESC`, sourceIds),
    query<Record<string, unknown>>(`SELECT source_id, snapshot_hash, admission_version, complete, observed_at, updated_at, run_count,
      window_started_at, window_run_count, window_d1_rows_written
      FROM ingestion_v2_shadow_comparisons WHERE source_id IN (${placeholders})`, sourceIds),
    query<Record<string, unknown>>(`SELECT source_id, state, COALESCE(decision, '') AS decision, COUNT(*) AS rows,
      SUM(attempt_count) AS attempts, MAX(updated_at) AS latest_update FROM ingestion_rows
      WHERE source_id IN (${placeholders}) GROUP BY source_id, state, decision ORDER BY source_id, state, decision`, sourceIds),
    query<{ source_id: string; pending: number; stale: number }>(`SELECT source_id, COUNT(*) AS pending,
      SUM(CASE WHEN dispatched_at < ? THEN 1 ELSE 0 END) AS stale
      FROM ingestion_admission_handoffs WHERE source_id IN (${placeholders}) AND acknowledged_at IS NULL GROUP BY source_id`, [staleHandoffBefore, ...sourceIds]),
    query<{ source_id: string; expired: number }>(`SELECT source_id, COUNT(*) AS expired FROM ingestion_rows
      WHERE source_id IN (${placeholders}) AND state = 'processing' AND lease_expires_at < ? GROUP BY source_id`, [...sourceIds, capturedAt.toISOString()]),
    query<Record<string, unknown>>(`SELECT queue_name, category, COUNT(*) AS failures, MAX(last_failed_at) AS latest
      FROM queue_failure_events WHERE resolved_at IS NULL AND last_failed_at >= ?
      GROUP BY queue_name, category ORDER BY queue_name, category`, [windowStart]),
    query<Record<string, unknown>>(`SELECT queue_name, COALESCE(source_id, '') AS source_id, category,
      COUNT(*) AS failures, MAX(last_failed_at) AS latest
      FROM queue_failure_events WHERE delivery_attempt >= CASE WHEN queue_name = 'intern-notifs-dev-gmail' THEN 6 ELSE 3 END AND last_failed_at >= ?
      GROUP BY queue_name, source_id, category ORDER BY queue_name, source_id, category`, [windowStart]),
    query<Record<string, unknown>>(`SELECT key, value, updated_at FROM system_state
      WHERE key IN ('maintenance_phase:maintenance:ingestion_v2_admission_dispatch',
      'maintenance_phase:maintenance:maintenance_complete',
      'maintenance_phase:catalog_projection_r2:catalog_projection_r2_complete') ORDER BY key`),
    cloudflare<QueueSummary[]>('/queues?per_page=100'),
    cloudflare<{ schedules: Array<{ cron: string }> }>(`/workers/scripts/${workerName}/schedules`),
    cloudflare<{ bindings: Array<{ name: string; type: string; text?: string }> }>(`/workers/scripts/${workerName}/settings`),
    fetch(`${publicApiUrl}/catalog?limit=1`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/intern-notifs-dev-documents/objects/public-catalog/v1/current`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
    }).then(async (response) => {
      if (!response.ok) return undefined;
      const pointer = await response.json() as NonNullable<DevSoakSample['publication']>;
      return { generatedAt: pointer.generatedAt, version: pointer.version, count: pointer.count };
    }),
    fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query($account: String!, $since: Time!, $worker: String!) { viewer { accounts(filter: { accountTag: $account }) {
        workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $since, scriptName: $worker }) {
          dimensions { status } sum { requests errors } quantiles { cpuTimeP99 memoryUsageBytesP99 } } } } }`,
      variables: { account: accountId, since: new Date(Math.max(capturedAt.getTime() - 3_600_000, deploymentAt.getTime())).toISOString(), worker: workerName } }),
    }).then(async (response) => {
      const body = await response.json() as { errors?: unknown; data?: { viewer: { accounts: Array<{ workersInvocationsAdaptive: Array<{ dimensions: { status: string }; sum: { requests: number; errors: number }; quantiles: { cpuTimeP99: number; memoryUsageBytesP99: number } }> }> } } };
      if (!response.ok || body.errors) throw new Error('Worker runtime analytics unavailable');
      return body.data?.viewer.accounts[0]?.workersInvocationsAdaptive.map((row) => ({ status: row.dimensions.status, ...row.sum, ...row.quantiles })) ?? [];
    }),
  ]);

  const relevantQueueNames = new Set(QUEUE_SUFFIXES.flatMap((suffix) => [
    `intern-notifs-dev-${suffix}`, `intern-notifs-dev-${suffix}-dlq`,
  ]));
  const queueMetrics = Object.fromEntries(await Promise.all(queues
    .filter((queue) => relevantQueueNames.has(queue.queue_name))
    .map(async (queue) => [queue.queue_name, await cloudflare<QueueMetrics>(`/queues/${queue.queue_id}/metrics`)] as const)));
  const canaries = await Promise.all(sourceIds.map(async (sourceId): Promise<DevSoakSample['canary']> => {
    const health = healthRows.find((row) => row.pk === `SOURCE#${sourceId}`);
    const snapshot = snapshots.find((row) => row.source_id === sourceId);
    const comparison = comparisons.find((row) => row.source_id === sourceId);
    const handoff = handoffs.find((row) => row.source_id === sourceId);
    let r2SnapshotValid = false;
    if (snapshot) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/intern-notifs-dev-documents/objects/${snapshot.object_key}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        try {
          const envelope = parseEnvelope(await response.text(), { sourceId, snapshotHash: String(snapshot.snapshot_hash) });
          r2SnapshotValid = envelope.sourceId === sourceId && envelope.snapshotHash === snapshot.snapshot_hash
            && envelope.admissionVersion === snapshot.admission_version && envelope.rowCount === snapshot.row_count;
        } catch { /* A corrupt snapshot is a failed integrity check, not a missing report. */ }
      }
    }
    const sourceHealth = health ? JSON.parse(health.value) as SourceHealth : undefined;
    return { sourceId, ...(sourceHealth ? { health: { state: sourceHealth.state, sourceStatus: sourceHealth.sourceStatus,
      lastSuccessAt: sourceHealth.lastSuccessAt, lastAttemptAt: sourceHealth.lastAttemptAt, consecutiveFailures: sourceHealth.consecutiveFailures } } : {}),
      ...(snapshot ? { activeSnapshot: snapshot } : {}), ...(comparison ? { shadowComparison: comparison } : {}),
      rows: rowStates.filter((row) => row.source_id === sourceId), pendingHandoffs: handoff?.pending ?? 0,
      staleHandoffs: handoff?.stale ?? 0, expiredLeases: leases.find((row) => row.source_id === sourceId)?.expired ?? 0, r2SnapshotValid };
  }));
  const controlMismatches = Object.entries(DEV_CONFIG.vars).filter(([name]) => name.startsWith('INGESTION_V2_') || name === 'OUTBOUND_NOTIFICATIONS_ENABLED')
    .filter(([name, expected]) => settings.bindings.find((binding) => binding.name === name && binding.type === 'plain_text')?.text !== expected)
    .map(([name]) => `${name} differs from tracked dev configuration`);
  const sample: DevSoakSample = {
    capturedAt: capturedAt.toISOString(), windowStartedAt: windowStart, windowHours, runtime,
    soakStartedAt: new Date(Math.max(deploymentAt.getTime(), configuredWindowStart?.getTime() ?? 0)).toISOString(),
    canary: canaries[0]!, canaries, schedules: schedules.schedules.map(({ cron }) => cron), controlMismatches,
    ...(publication ? { publication } : {}),
    maintenance,
    unresolvedFailures: failures,
    exhaustedFailures,
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
