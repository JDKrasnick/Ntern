import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it.each([
  ['old unresolved', 48, 48, false, 'fail', 1],
  ['unresolved before redeployment', 12, 1, false, 'fail', 1],
  ['recent unresolved', 1, 48, false, 'fail', 1],
  ['old recovered', 48, 48, true, 'pass', 1],
  ['recent recovered', 1, 48, true, 'pass', 1],
  ['bounded unresolved sample behind resolved history', 48, 48, false, 'fail', 250],
] as const)('the actual readiness collector retains durable incidents until recovery: %s', async (_label, ageHours, deploymentHours, resolved, expected, incidents) => {
  const directory = mkdtempSync(join(tmpdir(), 'ntern-soak-review-'));
  const path = join(directory, 'db.sqlite');
  const reportPath = join(directory, 'report.json');
  const sqlite = new DatabaseSync(path);
  try {
    const migrations = new URL('../cloudflare/migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
    }
    const failedAt = new Date(Date.now() - ageHours * 3_600_000).toISOString();
    const insert = sqlite.prepare(`INSERT INTO queue_failure_events(id,queue_name,message_id,source_id,delivery_attempt,payload_hash,
      category,diagnostic,first_failed_at,last_failed_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (let index = 0; index < incidents; index++) insert
      .run(`exhausted-${index}`, 'intern-notifs-dev-admission-v2', `lost-delivery-${index}`, 'source', 3, 'hash',
        'snapshot-missing', 'lost immutable snapshot', failedAt, failedAt, resolved ? new Date().toISOString() : null);
    if (incidents > 1) for (let index = 0; index < 1000; index++) insert
      .run(`resolved-${index}`, 'intern-notifs-dev-admission-v2', `recovered-${index}`, 'source', 3, 'hash',
        'snapshot-missing', 'recovered', failedAt, failedAt, new Date().toISOString());
    sqlite.close();
    await run(process.execPath, ['--import', 'tsx', '--import', './test/fixtures/dev-soak-durable-fetch.ts',
      './scripts/ingestion-v2-dev-soak.ts'], { env: { ...process.env,
      CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: '4d67a0f1b73641df84af0a283dd5b3d8',
      SOAK_TEST_DATABASE: path, SOAK_TEST_DEPLOYMENT_HOURS: String(deploymentHours),
      INGESTION_V2_SOAK_REPORT: reportPath, INGESTION_V2_DEV_SOURCES: 'source', INGESTION_V2_SOAK_WINDOW_HOURS: '24',
      INGESTION_V2_SOAK_STARTED_AT: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      INGESTION_V2_DEV_CONFIG: fileURLToPath(new URL('../wrangler.dev.ingestion.jsonc', import.meta.url)),
    } }).catch(error => {
      // Other readiness checks intentionally fail for this minimal incident fixture.
      if (error.code !== 1) throw error;
    });
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.checks.find((check: { name: string }) => check.name === 'no unresolved queue failures')?.status)
      .toBe(expected);
    expect(report.unresolvedFailures.length).toBe(resolved ? 0 : 1);
    expect(report.unresolvedFailures.reduce((count: number, group: { failures: number }) => count + group.failures, 0))
      .toBe(resolved ? 0 : Math.min(200, incidents));
  } finally {
    if (sqlite.isOpen) sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
