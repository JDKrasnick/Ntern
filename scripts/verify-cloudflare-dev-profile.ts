import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const roles = ['ingestion', 'admission', 'catalog-publisher', 'api'] as const;
type Profile = { name: string; vars: Record<string, string>; triggers?: { crons: string[] };
  d1_databases?: Array<{ binding: string; database_id: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  services?: Array<{ binding: string; service: string; environment?: string; entrypoint?: string }>;
  queues?: { producers?: Array<{ binding: string; queue: string }>; consumers?: Array<{
  queue: string; max_batch_size: number; max_concurrency: number; max_retries: number;
  dead_letter_queue: string; max_batch_timeout?: number; retry_delay?: number;
}> } };
type Load = <T>(path: string) => Promise<T>;
type Consumer = { consumer_id?: string; script_name?: string; script?: string; service?: string; type?: string;
  dead_letter_queue?: string; settings?: { batch_size?: number; max_concurrency?: number | null; max_retries?: number;
    max_wait_time_ms?: number; retry_delay?: number } };
type DevQueue = { queue_id: string; queue_name: string; settings?: { delivery_paused?: boolean; delivery_delay?: number } };
type Binding = { name: string; type: string; text?: string; database_id?: string; id?: string;
  bucket_name?: string; queue_name?: string; service?: string; environment?: string; entrypoint?: string };
const consumerOwner = (consumer: Consumer) => consumer.script_name ?? consumer.script ?? consumer.service;

function validateAdmissionQueueDelivery(queue: DevQueue): void {
  if (queue.settings?.delivery_paused === true) throw new Error('Dev admission queue delivery is paused');
  if (queue.settings?.delivery_delay !== 0) throw new Error('Dev admission queue initial delivery delay must be zero');
}

function validateResourceBindings(profile: Profile, bindings: Binding[]): void {
  const requireBinding = (name: string, type: string, matches: (binding: Binding) => boolean): void => {
    const binding = bindings.find((binding) => binding.name === name);
    if (!binding || binding.type !== type || !matches(binding)) {
      throw new Error(`${profile.name}: ${name} resource binding differs from dev profile`);
    }
  };
  for (const expected of profile.d1_databases ?? []) {
    requireBinding(expected.binding, 'd1', (binding) =>
      (binding.database_id ?? binding.id) === expected.database_id
      && (binding.id === undefined || binding.id === expected.database_id));
  }
  for (const expected of profile.r2_buckets ?? []) {
    requireBinding(expected.binding, 'r2_bucket', (binding) => binding.bucket_name === expected.bucket_name);
  }
  for (const expected of profile.queues?.producers ?? []) {
    requireBinding(expected.binding, 'queue', (binding) => binding.queue_name === expected.queue);
  }
  for (const expected of profile.services ?? []) {
    requireBinding(expected.binding, 'service', (binding) => binding.service === expected.service
      && (binding.environment ?? 'production') === (expected.environment ?? 'production')
      && (binding.entrypoint ?? 'default') === (expected.entrypoint ?? 'default'));
  }
}

async function findAdmissionQueue(load: Load): Promise<DevQueue | undefined> {
  for (let page = 1; ; page++) {
    const queues = await load<DevQueue[]>(`/queues?per_page=100&page=${page}`);
    const queue = queues.find((queue) => queue.queue_name === 'intern-notifs-dev-admission-v2');
    if (queue) return queue;
    if (queues.length < 100) return undefined;
  }
}

async function loadAdmissionQueue(load: Load): Promise<DevQueue> {
  const queue = await findAdmissionQueue(load);
  if (!queue) throw new Error('Missing dev admission queue');
  return queue;
}

function validateTransferConsumers(consumers: Consumer[]): void {
  if (consumers.some((consumer) => consumer.type !== 'worker' || !['intern-notifs-dev-ingestion', 'intern-notifs-dev-admission'].includes(consumerOwner(consumer) ?? ''))) {
    throw new Error('Refusing to transfer an unexpected dev admission consumer');
  }
  if (consumers.some((consumer) => consumerOwner(consumer) === 'intern-notifs-dev-ingestion' && !consumer.consumer_id)) {
    throw new Error('Missing legacy dev consumer identity');
  }
}

/** Check credentials and queue read access before any provisioning or deployment. */
export async function preflightCloudflareDevTransfer(load: Load): Promise<void> {
  const queue = await findAdmissionQueue(load);
  // First-time provisioning creates this queue after authenticated listing succeeds.
  if (!queue) return;
  validateAdmissionQueueDelivery(queue);
  validateTransferConsumers(await load<Consumer[]>(`/queues/${queue.queue_id}/consumers`));
}

/** Wrangler adds declared consumers but does not delete omitted consumers. */
export async function releaseLegacyDevAdmissionConsumer(load: Load, remove: (path: string) => Promise<void>): Promise<void> {
  const queue = await loadAdmissionQueue(load);
  const consumers = await load<Consumer[]>(`/queues/${queue.queue_id}/consumers`);
  validateTransferConsumers(consumers);
  const legacy = consumers.filter((consumer) => consumerOwner(consumer) === 'intern-notifs-dev-ingestion');
  for (const consumer of legacy) await remove(`/queues/${queue.queue_id}/consumers/${consumer.consumer_id}`);
}

/** Deployment parity is immediate; source health and the clean soak are separate gates. */
export async function verifyCloudflareDevProfile(load: Load): Promise<void> {
  for (const role of roles) {
    const profile = JSON.parse(readFileSync(new URL(`../wrangler.dev.${role}.jsonc`, import.meta.url), 'utf8')) as Profile;
    const expectedName = role === 'api' ? 'intern-notifs-dev' : `intern-notifs-dev-${role}`;
    if (profile.name !== expectedName || profile.vars.OUTBOUND_NOTIFICATIONS_ENABLED !== 'false') {
      throw new Error(`Unsafe dev profile: ${role}`);
    }
    const [settings, schedules] = await Promise.all([
      load<{ bindings: Binding[] }>(`/workers/scripts/${profile.name}/settings`),
      load<{ schedules: Array<{ cron: string }> }>(`/workers/scripts/${profile.name}/schedules`),
    ]);
    for (const [name, expected] of Object.entries(profile.vars).filter(([name]) =>
      name.startsWith('INGESTION_V2_') || ['OUTBOUND_NOTIFICATIONS_ENABLED', 'DEPLOYMENT_ROLE', 'LLM_METADATA_PUBLICATION_POLICY_JSON', 'ADMISSION_V2_QUEUE_NAME'].includes(name))) {
      if (settings.bindings.find((binding) => binding.name === name && binding.type === 'plain_text')?.text !== expected) {
        throw new Error(`${profile.name}: ${name} differs from dev profile`);
      }
    }
    validateResourceBindings(profile, settings.bindings);
    const expectedCrons = [...(profile.triggers?.crons ?? [])].sort();
    const liveCrons = schedules.schedules.map(({ cron }) => cron).sort();
    if (JSON.stringify(expectedCrons) !== JSON.stringify(liveCrons)) throw new Error(`${profile.name}: cron ownership differs`);
  }
  const admissionQueue = await loadAdmissionQueue(load);
  validateAdmissionQueueDelivery(admissionQueue);
  const consumers = await load<Consumer[]>(`/queues/${admissionQueue.queue_id}/consumers`);
  if (consumers.length !== 1 || consumerOwner(consumers[0]!) !== 'intern-notifs-dev-admission') {
    throw new Error('Dev admission queue must have exactly one dedicated admission consumer');
  }
  const admission = JSON.parse(readFileSync(new URL('../wrangler.dev.admission.jsonc', import.meta.url), 'utf8')) as Profile;
  const expected = admission.queues?.consumers?.find(({ queue }) => queue === admissionQueue.queue_name);
  if (!expected) throw new Error('Missing checked dev admission consumer');
  const consumer = consumers[0]!;
  if (consumer.type !== 'worker' || consumer.dead_letter_queue !== expected.dead_letter_queue
    || consumer.settings?.batch_size !== expected.max_batch_size
    || consumer.settings?.max_concurrency !== expected.max_concurrency
    || consumer.settings?.max_retries !== expected.max_retries
    || (expected.max_batch_timeout !== undefined && consumer.settings?.max_wait_time_ms !== expected.max_batch_timeout * 1000)
    || (expected.retry_delay !== undefined && consumer.settings?.retry_delay !== expected.retry_delay)) {
    throw new Error('Dev admission consumer delivery settings differ from checked profile');
  }
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
  const request = async <T>(path: string, method = 'GET'): Promise<T> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as { success: boolean; result: T };
    if (!response.ok || !body.success) throw new Error(`Dev profile request failed: ${path} (${response.status})`);
    return body.result;
  };
  if (process.argv.includes('--preflight')) {
    await preflightCloudflareDevTransfer(request);
    console.log('Dev transfer credentials, queue read access, and existing ownership checked.');
    return;
  }
  if (process.argv.includes('--release-legacy-consumer')) {
    await releaseLegacyDevAdmissionConsumer(request, async (path) => { await request(path, 'DELETE'); });
    console.log('Legacy dev admission consumer released; any dedicated consumer is preserved.');
    return;
  }
  await verifyCloudflareDevProfile(request);
  console.log('All four dev Worker profiles, cron owners, and the admission consumer match.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
}
