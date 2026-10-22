/** Account controls shared by the webhook and the independent spending guard. */
export type CloudflareManagementApi = <T>(path: string, init?: RequestInit) => Promise<T>;
export const BILLING_SHUTDOWN_RETRY_SECONDS = 3_600;

export const applicationDatabases = {
  production: '4e389f1c-7c6d-48e1-aa97-dc4cb1769bb8',
  dev: 'cedc86d8-69a5-4a72-a1e6-f5629d722338',
} as const;

const applicationWorker = (name: string) => name === 'intern-notifs' || name.startsWith('intern-notifs-');
const latchSql = `INSERT INTO system_state (key, value, updated_at)
  VALUES ('billing_shutdown', 'stopped', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  WHERE system_state.value <> 'stopped'`;

export async function assertApplicationRunning(api: CloudflareManagementApi,
  databases: readonly string[] = Object.values(applicationDatabases)): Promise<void> {
  for (const id of databases) {
    const result = await api<Array<{ results: Array<{ value: string }> }>>(`/d1/database/${id}/query`, {
      method: 'POST', body: JSON.stringify({ sql: "SELECT value FROM system_state WHERE key = 'billing_shutdown'" }),
    });
    if (!Array.isArray(result) || !Array.isArray(result[0]?.results)) throw new Error('Billing latch could not be verified');
    if (result[0].results.some(row => row.value === 'stopped')) {
      throw new Error('Billing shutdown is latched; restore service only through an explicitly reviewed recovery');
    }
  }
}

export interface ApplicationPauseReport {
  latchedDatabases: string[];
  clearedWorkers: string[];
  removedConsumers: number;
  failures: string[];
}

export async function pauseCloudflareApplication(api: CloudflareManagementApi): Promise<ApplicationPauseReport> {
  const report: ApplicationPauseReport = { latchedDatabases: [], clearedWorkers: [], removedConsumers: 0, failures: [] };
  const attempt = async (label: string, action: () => Promise<void>): Promise<void> => {
    try { await action(); } catch { report.failures.push(label); }
  };
  // The durable latches come first. A failure in resource discovery or any
  // management operation must not prevent either environment from stopping.
  for (const id of Object.values(applicationDatabases)) {
    await attempt(`latch:${id}`, async () => {
      await api(`/d1/database/${id}/query`, { method: 'POST', body: JSON.stringify({ sql: latchSql }) });
      const verified = await api<Array<{ results: Array<{ value: string }> }>>(`/d1/database/${id}/query`, {
        method: 'POST', body: JSON.stringify({ sql: "SELECT value FROM system_state WHERE key = 'billing_shutdown'" }),
      });
      if (!verified[0]?.results?.some(row => row.value === 'stopped')) throw new Error('Billing latch is not set');
      report.latchedDatabases.push(id);
    });
  }
  await attempt('discover-workers', async () => {
    const workers = await api<Array<{ id: string }>>('/workers/scripts');
    for (const worker of workers.filter(worker => applicationWorker(worker.id))) {
      await attempt(`schedules:${worker.id}`, async () => {
        const path = `/workers/scripts/${encodeURIComponent(worker.id)}/schedules`;
        await api(path, { method: 'PUT', body: '[]' });
        const verified = await api<{ schedules: unknown[] }>(path);
        if (!Array.isArray(verified.schedules) || verified.schedules.length) throw new Error('Schedules remain active');
        report.clearedWorkers.push(worker.id);
      });
    }
  });
  await attempt('discover-queues', async () => {
    for (let page = 1; ; page++) {
      const queues = await api<Array<{ queue_id: string; queue_name: string }>>(`/queues?per_page=100&page=${page}`);
      for (const queue of queues.filter(queue => applicationWorker(queue.queue_name))) {
        const path = `/queues/${encodeURIComponent(queue.queue_id)}/consumers`;
        await attempt(`consumers:${queue.queue_name}`, async () => {
          const consumers = await api<Array<{ consumer_id: string; script?: string; script_name?: string }>>(path);
          for (const consumer of consumers) {
            const script = consumer.script ?? consumer.script_name;
            if (!script || !applicationWorker(script)) throw new Error('Unexpected queue consumer owner');
            await attempt(`consumer:${queue.queue_name}:${consumer.consumer_id}`, async () => {
              await api(`${path}/${encodeURIComponent(consumer.consumer_id)}`, { method: 'DELETE' });
              report.removedConsumers++;
            });
          }
          if ((await api<unknown[]>(path)).length) throw new Error('Queue consumers remain active');
        });
      }
      if (queues.length < 100) break;
    }
  });
  return report;
}

export interface BillableUsageRow {
  ServiceName: string;
  BillingPeriodStart: string;
  ChargePeriodEnd: string;
  BillingCurrency: string;
  ContractedCost: number;
}

export function evaluateCloudflareBudget(rows: BillableUsageRow[], actualCycleWrites: number,
  actualHourWrites: number, usageLimitDollars = 5, hourlyWriteLimit = 60_000) {
  if (!rows.length || rows.some(row => !row.ServiceName || row.BillingCurrency !== 'USD'
    || !Number.isFinite(row.ContractedCost) || row.ContractedCost < 0
    || !Number.isFinite(Date.parse(row.BillingPeriodStart)) || !Number.isFinite(Date.parse(row.ChargePeriodEnd)))
    || [actualCycleWrites, actualHourWrites].some(n => !Number.isSafeInteger(n) || n < 0)
    || !Number.isFinite(usageLimitDollars) || usageLimitDollars <= 0
    || !Number.isSafeInteger(hourlyWriteLimit) || hourlyWriteLimit <= 0) {
    throw new Error('Budget telemetry or limits are invalid');
  }
  if (new Set(rows.map(row => row.BillingPeriodStart)).size !== 1) throw new Error('Ambiguous billing period');
  const reportedUsageDollars = rows.reduce((sum, row) => sum + row.ContractedCost, 0);
  const reportedD1WriteDollars = rows.filter(row => row.ServiceName.startsWith('D1 - Rows Written'))
    .reduce((sum, row) => sum + row.ContractedCost, 0);
  // The account-wide Analytics query includes production, dev and proof DBs.
  // Replace (never add twice) the delayed D1 charge, conservatively rounding
  // paid write units up. Other products still use Cloudflare's daily bill feed.
  const estimatedD1WriteDollars = Math.ceil(Math.max(0, actualCycleWrites - 50_000_000) / 1_000_000);
  const estimatedUsageDollars = reportedUsageDollars - reportedD1WriteDollars
    + Math.max(reportedD1WriteDollars, estimatedD1WriteDollars);
  const reasons = [
    ...(estimatedUsageDollars >= usageLimitDollars ? ['account-usage-budget'] : []),
    ...(actualHourWrites >= hourlyWriteLimit ? ['account-d1-write-rate'] : []),
  ];
  return { reportedUsageDollars, estimatedUsageDollars, actualCycleWrites, actualHourWrites,
    usageLimitDollars, hourlyWriteLimit, reasons, stop: reasons.length > 0 };
}
