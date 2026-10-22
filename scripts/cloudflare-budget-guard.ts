import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applicationDatabases, assertApplicationRunning, evaluateCloudflareBudget, pauseCloudflareApplication,
  type BillableUsageRow, type CloudflareManagementApi } from '../src/cloudflare-budget.js';

export function cloudflareManagementApi(accountId: string, token: string): CloudflareManagementApi {
  return async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      ...init, signal: AbortSignal.timeout(20_000), headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers,
      },
    });
    const body = await response.json() as { success?: boolean; result: T };
    if (!response.ok || body.success !== true) throw new Error(`Cloudflare management request failed (${response.status})`);
    return body.result;
  };
}

export async function readAccountWrites(accountId: string, token: string, since: string, now: Date): Promise<number> {
  const query = `query AccountWrites($account: string!, $since: Time!, $until: Time!) {
    viewer { accounts(filter: {accountTag: $account}) {
      d1AnalyticsAdaptiveGroups(limit: 1, filter: {datetime_geq: $since, datetime_lt: $until}) {
        sum { rowsWritten }
      }
    } }
  }`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { account: accountId, since, until: now.toISOString() } }),
  });
  const body = await response.json() as { errors?: unknown[] | null;
    data?: { viewer?: { accounts?: Array<{ d1AnalyticsAdaptiveGroups?: Array<{ sum: { rowsWritten: number } }> }> } } };
  const accounts = body.data?.viewer?.accounts;
  const groups = accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  const writes = groups?.[0]?.sum.rowsWritten;
  // Missing data is not a measured zero. Halt on unavailable telemetry.
  if (!response.ok || body.errors?.length || accounts?.length !== 1 || groups?.length !== 1
    || writes === undefined || !Number.isSafeInteger(writes) || writes < 0) {
    throw new Error('Account-wide D1 usage is unavailable');
  }
  return writes;
}

export async function inspectCloudflareBudget(api: CloudflareManagementApi,
  writes: (since: string, now: Date) => Promise<number>, now: Date,
  limits: { usageDollars: number; hourlyWrites: number }) {
  const rows = await api<BillableUsageRow[]>('/billable-usage');
  if (!Array.isArray(rows) || !rows.length) throw new Error('Billable usage is unavailable');
  const since = rows[0]!.BillingPeriodStart;
  if (!Number.isFinite(Date.parse(since)) || Date.parse(since) > now.getTime()) throw new Error('Invalid billing period');
  const [cycleWrites, hourWrites] = await Promise.all([
    writes(since, now), writes(new Date(now.getTime() - 3_600_000).toISOString(), now),
  ]);
  return evaluateCloudflareBudget(rows, cycleWrites, hourWrites, limits.usageDollars, limits.hourlyWrites);
}

export async function runCloudflareBudgetGuard(options: {
  api: CloudflareManagementApi; writes: (since: string, now: Date) => Promise<number>;
  now: Date; enforce: boolean; limits: { usageDollars: number; hourlyWrites: number };
}) {
  let budget: Awaited<ReturnType<typeof inspectCloudflareBudget>> | undefined;
  let telemetryUnavailable = false;
  try { budget = await inspectCloudflareBudget(options.api, options.writes, options.now, options.limits); }
  catch { telemetryUnavailable = true; }
  const stop = telemetryUnavailable || budget?.stop === true;
  const pause = stop && options.enforce ? await pauseCloudflareApplication(options.api) : undefined;
  return { capturedAt: options.now.toISOString(), enforce: options.enforce, budget, telemetryUnavailable, stop, pause };
}

async function main(): Promise<number> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error('Cloudflare account and API token are required');
  const api = cloudflareManagementApi(accountId, token);
  if (process.argv.includes('--check-running')) {
    await assertApplicationRunning(api, [applicationDatabases.production]);
    console.log('Production billing latch is clear');
    return 0;
  }
  const report = await runCloudflareBudgetGuard({ api, writes: (since, now) => readAccountWrites(accountId, token, since, now),
    now: new Date(), enforce: process.argv.includes('--enforce'), limits: {
      usageDollars: Number(process.env.CLOUDFLARE_USAGE_BUDGET_DOLLARS ?? 5),
      hourlyWrites: Number(process.env.CLOUDFLARE_D1_WRITES_PER_HOUR ?? 60_000),
    } });
  const output = process.env.CLOUDFLARE_BUDGET_REPORT ?? '.context/verification/budget/report.json';
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  return report.stop ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('Cloudflare budget verification failed; service must remain paused');
    process.exitCode = 1;
  });
}
