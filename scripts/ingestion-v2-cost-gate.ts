/** Read-only, out-of-band production guard for ingestion V2 D1 cost windows. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INGESTION_V2_COST_WINDOW_MS,
  INGESTION_V2_D1_WRITE_LIMIT,
  INGESTION_V2_RUN_LIMIT,
} from '../cloudflare/ingestion-health-alert.js';

const DEFAULT_DATABASE_ID = '4e389f1c-7c6d-48e1-aa97-dc4cb1769bb8';

export interface IngestionV2CostWindow {
  source_id: string;
  window_started_at: string | null;
  window_run_count: number;
  window_d1_rows_written: number;
  updated_at: string;
}

export interface IngestionV2CostCheck {
  sourceId: string;
  status: 'pass' | 'fail';
  detail: string;
}

export function evaluateIngestionV2CostWindows(rows: IngestionV2CostWindow[]): IngestionV2CostCheck[] {
  if (!rows.length) return [{ sourceId: 'all', status: 'fail', detail: 'no V2 cost window updated in the last hour' }];
  return rows.map((row) => {
    const failures = [
      ...(!row.window_started_at ? ['window not initialized'] : []),
      ...(row.window_run_count >= INGESTION_V2_RUN_LIMIT
        ? [`${row.window_run_count} runs exceeds ${INGESTION_V2_RUN_LIMIT - 1}`] : []),
      ...(row.window_d1_rows_written >= INGESTION_V2_D1_WRITE_LIMIT
        ? [`${row.window_d1_rows_written} D1 rows exceeds ${INGESTION_V2_D1_WRITE_LIMIT - 1}`] : []),
    ];
    return {
      sourceId: row.source_id,
      status: failures.length ? 'fail' : 'pass',
      detail: failures.join('; ') || `${row.window_run_count} runs, ${row.window_d1_rows_written} D1 rows`,
    };
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<number> {
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const databaseId = process.env.CLOUDFLARE_PROD_D1_DATABASE_ID ?? DEFAULT_DATABASE_ID;
  const output = process.env.INGESTION_V2_COST_REPORT
    ?? '.context/verification/ingestion-v2/production-cost/report.json';
  const capturedAt = new Date();
  const since = new Date(capturedAt.getTime() - INGESTION_V2_COST_WINDOW_MS).toISOString();
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sql: `SELECT source_id, window_started_at, window_run_count, window_d1_rows_written, updated_at
        FROM ingestion_v2_shadow_comparisons WHERE updated_at >= ? ORDER BY source_id`,
      params: [since],
    }),
  });
  const body = (await response.json()) as {
    success: boolean;
    errors?: Array<{ message?: string }>;
    result?: Array<{ results: IngestionV2CostWindow[] }>;
  };
  if (!response.ok || !body.success) throw new Error(
    `D1 query failed: ${body.errors?.map((error) => error.message).join('; ') ?? response.status}`,
  );
  const rows = body.result?.[0]?.results ?? [];
  const checks = evaluateIngestionV2CostWindows(rows);
  const report = {
    capturedAt: capturedAt.toISOString(),
    thresholds: { windowMs: INGESTION_V2_COST_WINDOW_MS, runs: INGESTION_V2_RUN_LIMIT, d1RowsWritten: INGESTION_V2_D1_WRITE_LIMIT },
    rows,
    checks,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

  const summary = [
    '# Ingestion V2 production cost gate', '',
    `Captured: \`${report.capturedAt}\``, '',
    '| Source | Status | Detail |', '| --- | --- | --- |',
    ...checks.map((check) => `| ${check.sourceId} | ${check.status.toUpperCase()} | ${check.detail} |`),
    '', `Report: \`${output}\``,
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
  return checks.some((check) => check.status === 'fail') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
