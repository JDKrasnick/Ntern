/**
 * Lightweight production watch for the catalog dead-letter queues.
 *
 * Confirms the deferral contract the ingestion Worker now implements: a
 * source-scoped catalog failure records its health and failure-ledger rows and
 * is acknowledged on its final delivery, so the catalog DLQs hold poison only
 * and their backlog stops growing. This samples the four catalog DLQ depths,
 * compares them with the previous run's snapshot, and reports the delta.
 *
 * Read-only: it only calls Cloudflare's queue metrics endpoint.
 *
 * Exit code is 1 when a catalog DLQ grew, so a scheduled run surfaces a step
 * change. The calling workflow keeps that failure non-blocking because a stray
 * poison message is expected; a widening backlog is not.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run dlq:watch
 */

import { readFileSync, writeFileSync } from 'node:fs';

const CATALOG_QUEUES = ['github', 'greenhouse', 'lever', 'ashby'] as const;
const CONTEXT_QUEUES = ['destination-verification', 'gmail'] as const;
const ALL_QUEUES = [...CATALOG_QUEUES, ...CONTEXT_QUEUES];

const baselinePath = process.env.DLQ_BASELINE_FILE ?? '.dlq-baseline.json';

interface Baseline {
  capturedAt: string;
  counts: Record<string, number>;
}

interface QueueSummary {
  queue_id: string;
  queue_name: string;
}

interface QueueMetrics {
  backlog_count: number;
  backlog_bytes: number;
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
}

async function cloudflare<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { success: boolean; result: T; errors?: Array<{ message?: string }> };
  if (!response.ok || !body.success) {
    throw new Error(`Cloudflare request failed for ${path}: ${body.errors?.map((error) => error.message).join('; ') ?? response.status}`);
  }
  return body.result;
}

async function queueIdsByDlqName(): Promise<Map<string, string>> {
  const queues = await cloudflare<QueueSummary[]>('/queues?per_page=100');
  const byName = new Map<string, string>();
  for (const queue of queues) byName.set(queue.queue_name, queue.queue_id);
  const resolved = new Map<string, string>();
  for (const name of ALL_QUEUES) {
    const dlqName = `intern-notifs-${name}-dlq`;
    const id = byName.get(dlqName);
    if (id) resolved.set(name, id);
    else console.warn(`warning: ${dlqName} not found in the account`);
  }
  return resolved;
}

function readBaseline(): Baseline | undefined {
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}

const ids = await queueIdsByDlqName();
const previous = readBaseline();
const counts: Record<string, number> = {};
for (const [name, id] of ids) {
  const metrics = await cloudflare<QueueMetrics>(`/queues/${id}/metrics`);
  counts[name] = metrics.backlog_count;
}

const lines: string[] = [];
lines.push('Catalog DLQ watch');
lines.push('');
lines.push('| Queue | Previous | Current | Delta |');
lines.push('| --- | ---: | ---: | ---: |');
const grownCatalog: string[] = [];
for (const name of ALL_QUEUES) {
  if (counts[name] === undefined) continue;
  const was = previous?.counts[name];
  const delta = was === undefined ? undefined : counts[name]! - was;
  if ((CATALOG_QUEUES as readonly string[]).includes(name) && delta !== undefined && delta > 0) grownCatalog.push(`${name} +${delta}`);
  const marker = delta === undefined ? '' : delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '0';
  lines.push(`| ${name} | ${was ?? '-'} | ${counts[name]} | ${marker} |`);
}
lines.push('');
if (previous) lines.push(`Compared with the snapshot captured ${previous.capturedAt}.`);
else lines.push('No previous snapshot found; recording the first baseline.');

const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: 'a' });
}

writeFileSync(baselinePath, `${JSON.stringify({ capturedAt: new Date().toISOString(), counts }, null, 2)}\n`);

if (grownCatalog.length) {
  console.error(`\nCatalog DLQ backlog grew since the last snapshot: ${grownCatalog.join(', ')}.`);
  console.error('A source-scoped catalog failure is now deferred and acked, so growth means either poison (an unknown reviewed source or a malformed body) or a regression of the deferral.');
  process.exit(1);
}
console.log('\nCatalog DLQ backlog did not grow.');
