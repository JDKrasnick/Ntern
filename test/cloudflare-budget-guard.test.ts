import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationDatabases, assertApplicationRunning, evaluateCloudflareBudget, pauseCloudflareApplication,
  type BillableUsageRow, type CloudflareManagementApi } from '../src/cloudflare-budget.js';
import { readAccountWrites, runCloudflareBudgetGuard } from '../scripts/cloudflare-budget-guard.js';

const usage = (cost = 0, name = 'Workers CPU'): BillableUsageRow => ({
  ServiceName: name, BillingPeriodStart: '2026-09-24T00:00:00Z', ChargePeriodEnd: '2026-10-22T00:00:00Z',
  BillingCurrency: 'USD', ContractedCost: cost,
});
const now = new Date('2026-10-22T03:00:00Z');

function account(failConsumer = false) {
  const calls: Array<{ path: string; method: string }> = [];
  const paused = new Set<string>();
  const consumers = new Map([
    ['admission', [{ consumer_id: 'admission-c', script: 'intern-notifs-admission' }]],
    ['dev', [{ consumer_id: 'dev-c', script: 'intern-notifs-dev-ingestion' }]],
  ]);
  const api: CloudflareManagementApi = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const method = init.method ?? 'GET'; calls.push({ path, method });
    let result: unknown;
    if (path.startsWith('/d1/')) {
      const sql = JSON.parse(String(init.body)).sql as string;
      if (sql.startsWith('INSERT')) paused.add(path);
      result = [{ results: paused.has(path) ? [{ value: 'stopped' }] : [] }];
    } else if (path === '/billable-usage') result = [usage(40)];
    else if (path === '/workers/scripts') result = [
      { id: 'intern-notifs-ingestion' }, { id: 'intern-notifs-catalog-publisher' },
      { id: 'intern-notifs-dev-admission' }, { id: 'unrelated-worker' },
    ];
    else if (path.endsWith('/schedules')) result = method === 'PUT' ? [] : { schedules: [] };
    else if (path.includes('/queues?')) {
      // Exercise pagination past 100 unrelated resources.
      result = path.endsWith('page=1')
        ? Array.from({ length: 100 }, (_, i) => ({ queue_id: String(i), queue_name: `unrelated-${i}` }))
        : [{ queue_id: 'admission', queue_name: 'intern-notifs-admission-v2' },
          { queue_id: 'dev', queue_name: 'intern-notifs-dev-shadow-extraction' }];
    } else if (path.startsWith('/queues/')) {
      const id = path.split('/')[2]!;
      if (method === 'DELETE') {
        if (failConsumer && id === 'admission') throw new Error('Permission failure');
        consumers.set(id, []); result = {};
      } else result = consumers.get(id) ?? [];
    } else throw new Error(`Unexpected API path ${path}`);
    return result as T;
  };
  return { api, calls, paused, consumers };
}

afterEach(() => vi.unstubAllGlobals());

describe('measured Cloudflare account budget', () => {
  it('counts the shared D1 allowance once and does not double-charge reported writes', () => {
    const result = evaluateCloudflareBudget([usage(129, 'D1 - Rows Written (first 50 million included)'), usage(23)],
      178_639_725, 10_000);
    expect(result.estimatedUsageDollars).toBe(152);
    expect(result.reasons).toEqual(['account-usage-budget']);
    expect(evaluateCloudflareBudget([usage()], 50_000_000, 59_999).stop).toBe(false);
  });

  it('stops on delayed billing, aggregate hourly writes, and exact boundaries', () => {
    expect(evaluateCloudflareBudget([usage()], 80_000_000, 1).estimatedUsageDollars).toBe(30);
    expect(evaluateCloudflareBudget([usage()], 80_000_000, 1).stop).toBe(true);
    expect(evaluateCloudflareBudget([usage()], 1, 60_000).reasons).toEqual(['account-d1-write-rate']);
    expect(evaluateCloudflareBudget([usage(30)], 1, 1).stop).toBe(true);
    expect(evaluateCloudflareBudget([usage(5)], 1, 1).stop).toBe(true);
  });

  it('rejects missing, malformed, mixed-period or non-USD telemetry and invalid limits', () => {
    expect(() => evaluateCloudflareBudget([], 1, 1)).toThrow();
    expect(() => evaluateCloudflareBudget([{ ...usage(), BillingCurrency: 'EUR' }], 1, 1)).toThrow();
    expect(() => evaluateCloudflareBudget([usage(), { ...usage(), BillingPeriodStart: '2026-10-24' }], 1, 1)).toThrow();
    expect(() => evaluateCloudflareBudget([usage()], NaN, 1)).toThrow();
    expect(() => evaluateCloudflareBudget([usage()], 1, 1, 0)).toThrow();
  });

  it('queries every database in the account and fails closed on empty or errored analytics', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { viewer: { accounts: [
      { d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 70_000 } }] },
    ] } } })); vi.stubGlobal('fetch', fetcher);
    expect(await readAccountWrites('account', 'secret', '2026-10-22T02:00:00Z', now)).toBe(70_000);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(body.query).not.toContain('databaseId');
    expect(body.variables.since).toBe('2026-10-22T02:00:00Z');
    fetcher.mockResolvedValue(Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } }));
    await expect(readAccountWrites('account', 'secret', '2026-10-22T02:00:00Z', now)).rejects.toThrow('unavailable');
    fetcher.mockResolvedValue(Response.json({ errors: [{ message: 'Permission denied' }] }));
    await expect(readAccountWrites('account', 'secret', '2026-10-22T02:00:00Z', now)).rejects.toThrow('unavailable');
  });
});

describe('durable account shutdown', () => {
  it('latches and verifies both databases before disabling all project workers and consumers', async () => {
    const s = account(); const report = await pauseCloudflareApplication(s.api);
    expect(report.failures).toEqual([]);
    expect(report.latchedDatabases).toEqual(Object.values(applicationDatabases));
    expect(s.calls.slice(0, 4).every(call => call.path.startsWith('/d1/'))).toBe(true);
    expect(report.clearedWorkers).toEqual(['intern-notifs-ingestion', 'intern-notifs-catalog-publisher', 'intern-notifs-dev-admission']);
    expect(report.removedConsumers).toBe(2);
    expect(s.calls.some(call => call.path.includes('unrelated') && call.method !== 'GET')).toBe(false);
    const repeated = await pauseCloudflareApplication(s.api);
    expect(repeated.failures).toEqual([]); expect(repeated.removedConsumers).toBe(0);
    await expect(assertApplicationRunning(s.api)).rejects.toThrow('latched');
  });

  it('continues through a failed deletion, leaves latches set, and reports incomplete shutdown', async () => {
    const s = account(true); const report = await pauseCloudflareApplication(s.api);
    expect(report.failures).toContain('consumer:intern-notifs-admission-v2:admission-c');
    expect(report.failures).toContain('consumers:intern-notifs-admission-v2');
    expect(report.removedConsumers).toBe(1);
    expect(s.paused.size).toBe(2);
    expect(s.consumers.get('dev')).toEqual([]);
  });

  it('does not mutate in read-only mode and enforces a stop when telemetry is unavailable', async () => {
    const s = account(); const options = { api: s.api, now, writes: async () => 1,
      limits: { usageDollars: 30, hourlyWrites: 60_000 }, enforce: false };
    expect((await runCloudflareBudgetGuard(options)).stop).toBe(true);
    expect(s.calls.every(call => call.method === 'GET')).toBe(true);
    const report = await runCloudflareBudgetGuard({ ...options, enforce: true,
      writes: async () => { throw new Error('Analytics unavailable'); } });
    expect(report.telemetryUnavailable).toBe(true);
    expect(report.pause?.latchedDatabases).toHaveLength(2);
    expect(report.pause?.failures).toEqual([]);
  });
});
