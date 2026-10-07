import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const roles = ['ingestion', 'admission', 'catalog-publisher', 'api'] as const;
type Profile = { name: string; vars: Record<string, string>; triggers?: { crons: string[] } };
type Load = <T>(path: string) => Promise<T>;
type Consumer = { consumer_id?: string; script_name?: string; script?: string; service?: string };
const consumerOwner = (consumer: Consumer) => consumer.script_name ?? consumer.script ?? consumer.service;

async function loadAdmissionQueue(load: Load): Promise<{ queue_id: string }> {
  for (let page = 1; ; page++) {
    const queues = await load<Array<{ queue_name: string; queue_id: string }>>(`/queues?per_page=100&page=${page}`);
    const queue = queues.find((queue) => queue.queue_name === 'intern-notifs-dev-admission-v2');
    if (queue) return queue;
    if (queues.length < 100) throw new Error('Missing dev admission queue');
  }
}

/** Wrangler adds declared consumers but does not delete omitted consumers. */
export async function releaseLegacyDevAdmissionConsumer(load: Load, remove: (path: string) => Promise<void>): Promise<void> {
  const queue = await loadAdmissionQueue(load);
  const consumers = await load<Consumer[]>(`/queues/${queue.queue_id}/consumers`);
  if (consumers.some((consumer) => !['intern-notifs-dev-ingestion', 'intern-notifs-dev-admission'].includes(consumerOwner(consumer) ?? ''))) {
    throw new Error('Refusing to transfer an unexpected dev admission consumer');
  }
  const legacy = consumers.filter((consumer) => consumerOwner(consumer) === 'intern-notifs-dev-ingestion');
  if (legacy.some((consumer) => !consumer.consumer_id)) throw new Error('Missing legacy dev consumer identity');
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
      load<{ bindings: Array<{ name: string; type: string; text?: string }> }>(`/workers/scripts/${profile.name}/settings`),
      load<{ schedules: Array<{ cron: string }> }>(`/workers/scripts/${profile.name}/schedules`),
    ]);
    for (const [name, expected] of Object.entries(profile.vars).filter(([name]) =>
      name.startsWith('INGESTION_V2_') || ['OUTBOUND_NOTIFICATIONS_ENABLED', 'DEPLOYMENT_ROLE', 'LLM_METADATA_PUBLICATION_POLICY_JSON'].includes(name))) {
      if (settings.bindings.find((binding) => binding.name === name && binding.type === 'plain_text')?.text !== expected) {
        throw new Error(`${profile.name}: ${name} differs from dev profile`);
      }
    }
    const expectedCrons = [...(profile.triggers?.crons ?? [])].sort();
    const liveCrons = schedules.schedules.map(({ cron }) => cron).sort();
    if (JSON.stringify(expectedCrons) !== JSON.stringify(liveCrons)) throw new Error(`${profile.name}: cron ownership differs`);
  }
  const admissionQueue = await loadAdmissionQueue(load);
  const consumers = await load<Consumer[]>(`/queues/${admissionQueue.queue_id}/consumers`);
  if (consumers.length !== 1 || consumerOwner(consumers[0]!) !== 'intern-notifs-dev-admission') {
    throw new Error('Dev admission queue must have exactly one dedicated admission consumer');
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
