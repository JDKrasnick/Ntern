import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preflightCloudflareDevTransfer, releaseLegacyDevAdmissionConsumer, verifyCloudflareDevProfile } from '../scripts/verify-cloudflare-dev-profile.js';

const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts['cloudflare:dev:deploy'] as string;

it.each([false, true])('transfers the consumer before enabling its new owner; failure=%s', (failAdmission) => {
  const directory = mkdtempSync(join(tmpdir(), 'dev-deploy-'));
  const log = join(directory, 'commands');
  try {
    for (const name of ['npm', 'wrangler', 'tsx']) writeFileSync(join(directory, name),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n' +
      'if [ "$DEPLOY_TEST_FAIL" = true ] && [ "$*" = "deploy --config wrangler.dev.admission.jsonc" ]; then exit 1; fi\n', { mode: 0o755 });
    const run = () => execFileSync('/bin/sh', ['-c', command], { env: { ...process.env,
      PATH: directory, DEPLOY_TEST_LOG: log, DEPLOY_TEST_FAIL: String(failAdmission),
    } });
    if (failAdmission) expect(run).toThrow(); else run();
    const commands = readFileSync(log, 'utf8').trim().split('\n');
    expect(commands.slice(0, 5)).toEqual(['scripts/verify-cloudflare-dev-profile.ts --preflight', 'run cloudflare:dev:provision',
      'deploy --config wrangler.dev.ingestion.jsonc', 'scripts/verify-cloudflare-dev-profile.ts --release-legacy-consumer',
      'deploy --config wrangler.dev.admission.jsonc']);
    if (failAdmission) expect(commands).toHaveLength(5);
    else expect(commands.slice(5)).toEqual(['deploy --config wrangler.dev.catalog-publisher.jsonc',
      'deploy --config wrangler.dev.api.jsonc --containers-rollout=none', 'scripts/verify-cloudflare-dev-profile.ts']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.each(['missing token', 'missing account', 'denied access', 'delayed delivery'])('the real helper preflight stops before every mutation: %s', (fault) => {
  const directory = mkdtempSync(join(tmpdir(), 'dev-preflight-'));
  const log = join(directory, 'commands');
  try {
    for (const name of ['npm', 'wrangler']) writeFileSync(join(directory, name),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n', { mode: 0o755 });
    const fetchStub = join(directory, 'fetch.mjs');
    writeFileSync(fetchStub, fault === 'delayed delivery'
      ? "globalThis.fetch = async () => Response.json({success:true,result:[{queue_name:'intern-notifs-dev-admission-v2',queue_id:'test-queue',settings:{delivery_delay:86400}}]});\n"
      : "globalThis.fetch = async () => Response.json({success:false}, {status:403});\n");
    writeFileSync(join(directory, 'tsx'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n' +
      'exec "$DEPLOY_TEST_NODE" --import "$DEPLOY_TEST_FETCH_STUB" --import "$DEPLOY_TEST_LOADER" "$DEPLOY_TEST_REPO/$1" "$2"\n', { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: directory, DEPLOY_TEST_LOG: log,
      DEPLOY_TEST_NODE: process.execPath, DEPLOY_TEST_REPO: resolve('.'),
      DEPLOY_TEST_LOADER: resolve('node_modules/tsx/dist/loader.mjs'), DEPLOY_TEST_FETCH_STUB: fetchStub,
    };
    Reflect.deleteProperty(env, 'CLOUDFLARE_API_TOKEN');
    Reflect.deleteProperty(env, 'CLOUDFLARE_ACCOUNT_ID');
    if (fault !== 'missing token') env.CLOUDFLARE_API_TOKEN = 'test-token';
    if (fault !== 'missing account') env.CLOUDFLARE_ACCOUNT_ID = '4d67a0f1b73641df84af0a283dd5b3d8';
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: directory, env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(fault === 'delayed delivery' ? 'initial delivery delay must be zero'
      : fault === 'denied access' ? 'Dev profile request failed' : 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['scripts/verify-cloudflare-dev-profile.ts --preflight']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.each([false, true])('provisions immediate admission delivery and then passes the real helpers; existing=%s', async (existing) => {
  const directory = mkdtempSync(join(tmpdir(), 'dev-delivery-'));
  const log = join(directory, 'commands');
  const delayFile = join(directory, 'delay');
  try {
    writeFileSync(delayFile, '86400');
    writeFileSync(join(directory, 'npx'), '#!/bin/sh\n' +
      'printf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n' +
      'case "$*" in\n' +
      '"wrangler queues info intern-notifs-dev-admission-v2") test "$DEPLOY_TEST_EXISTING" = true || exit 1;;\n' +
      '"wrangler queues create intern-notifs-dev-admission-v2 --message-retention-period-secs 86400 --delivery-delay-secs 0"|' +
      '"wrangler queues update intern-notifs-dev-admission-v2 --message-retention-period-secs 86400 --delivery-delay-secs 0") printf 0 > "$DEPLOY_TEST_DELAY_FILE";;\n' +
      '"wrangler vectorize list --json") printf \'[{"name":"intern-notifs-dev-resume-bank-v1","config":{"dimensions":768,"metric":"cosine","preset":"@cf/baai/bge-base-en-v1.5"}}]\\n\';;\n' +
      'esac\n', { mode: 0o755 });
    execFileSync('/bin/bash', ['scripts/provision-cloudflare-dev.sh'], { env: { ...process.env,
      PATH: `${directory}:${process.env.PATH}`, DEPLOY_TEST_LOG: log, DEPLOY_TEST_DELAY_FILE: delayFile,
      DEPLOY_TEST_EXISTING: String(existing),
    } });
    const delay = Number(readFileSync(delayFile, 'utf8'));
    expect(delay).toBe(0);
    const mutations = readFileSync(log, 'utf8').trim().split('\n').filter(line => /queues (create|update)/u.test(line));
    expect(mutations).toHaveLength(18);
    expect(mutations.filter(line => line.includes('--delivery-delay-secs'))).toEqual([
      `wrangler queues ${existing ? 'update' : 'create'} intern-notifs-dev-admission-v2 --message-retention-period-secs 86400 --delivery-delay-secs 0`,
    ]);
    await expect(preflightCloudflareDevTransfer(liveProfile({ delay }))).resolves.toBeUndefined();
    await expect(verifyCloudflareDevProfile(liveProfile({ delay }))).resolves.toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

type ConsumerSettings = { batch_size: number; max_concurrency: number | null; max_retries: number };
type ResourceDrift = { role: string; name: string; mutation: 'missing' | 'type' | 'target' | 'environment' | 'entrypoint' | 'conflicting-id' | 'id-only' };
function liveProfile(overrides: { dropMaintenance?: boolean; staleAdmission?: boolean; consumers?: string[]; secondQueuePage?: boolean;
  queueName?: string; paused?: boolean; noQueue?: boolean; consumerType?: string; dlq?: string;
  settings?: Partial<ConsumerSettings>; delay?: number; missingDelay?: boolean; resourceDrift?: ResourceDrift } = {}) {
  return async <T>(path: string): Promise<T> => {
    if (path.startsWith('/queues?')) {
      if (overrides.secondQueuePage && path.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => ({ queue_name: `other-${i}`, queue_id: String(i) })) as T;
      return (overrides.noQueue ? [] : [{ queue_name: 'intern-notifs-dev-admission-v2', queue_id: 'admission-id', settings: {
        delivery_paused: overrides.paused ?? false, ...(overrides.missingDelay ? {} : { delivery_delay: overrides.delay ?? 0 }),
      } }]) as T;
    }
    if (path.endsWith('/consumers')) return (overrides.consumers ?? ['intern-notifs-dev-admission']).map(script_name => ({ script_name, consumer_id: script_name,
      type: overrides.consumerType ?? 'worker', dead_letter_queue: overrides.dlq ?? 'intern-notifs-dev-admission-v2-dlq',
      settings: { batch_size: 1, max_concurrency: 1, max_retries: 2, ...overrides.settings },
    })) as T;
    const worker = path.split('/')[3]!;
    const role = worker === 'intern-notifs-dev' ? 'api' : worker.replace('intern-notifs-dev-', '');
    const config = JSON.parse(readFileSync(`wrangler.dev.${role}.jsonc`, 'utf8'));
    const resources: Array<Record<string, unknown>> = [
      ...(config.d1_databases ?? []).map((b: { binding: string; database_id: string }) => ({ name: b.binding, type: 'd1', database_id: b.database_id, id: b.database_id })),
      ...(config.r2_buckets ?? []).map((b: { binding: string; bucket_name: string }) => ({ name: b.binding, type: 'r2_bucket', bucket_name: b.bucket_name })),
      ...(config.queues?.producers ?? []).map((b: { binding: string; queue: string }) => ({ name: b.binding, type: 'queue', queue_name: b.queue })),
      ...(config.services ?? []).map((b: { binding: string; service: string }) => ({ name: b.binding, type: 'service', service: b.service, environment: 'production' })),
    ];
    const drift = overrides.resourceDrift;
    if (drift?.role === role) {
      const index = resources.findIndex((b) => b.name === drift.name);
      const binding = resources[index]!;
      if (drift.mutation === 'missing') resources.splice(index, 1);
      else if (drift.mutation === 'type') binding.type = 'plain_text';
      else if (drift.mutation === 'environment') binding.environment = 'staging';
      else if (drift.mutation === 'entrypoint') binding.entrypoint = 'OtherHandler';
      else if (drift.mutation === 'id-only') Reflect.deleteProperty(binding, 'database_id');
      else if (drift.mutation === 'conflicting-id') binding.id = 'wrong-db';
      else {
        const targetFields: Record<string, string> = { d1: 'database_id', r2_bucket: 'bucket_name', queue: 'queue_name', service: 'service' };
        binding[targetFields[String(binding.type)]!] = 'intern-notifs-production-resource';
      }
    }
    if (path.endsWith('/settings')) return { bindings: [...Object.entries(config.vars).map(([name, text]) => ({
      name, type: 'plain_text', text: role === 'admission' && name === 'ADMISSION_V2_QUEUE_NAME' && overrides.queueName
        ? overrides.queueName : overrides.staleAdmission && role === 'admission' && name === 'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST' ? 'old-cohort' : text,
    })), ...resources] } as T;
    if (path.endsWith('/schedules')) return { schedules: (config.triggers?.crons ?? [])
      .filter((cron: string) => !(overrides.dropMaintenance && role === 'ingestion' && cron === '9-59/10 * * * *'))
      .map((cron: string) => ({ cron })) } as T;
    throw new Error(`Unexpected request: ${path}`);
  };
}

describe('live dev deployment parity', () => {
  const requiredResources = ['ingestion', 'admission', 'catalog-publisher', 'api'].flatMap(role => {
    const config = JSON.parse(readFileSync(`wrangler.dev.${role}.jsonc`, 'utf8'));
    return [...(config.d1_databases ?? []), ...(config.r2_buckets ?? []), ...(config.queues?.producers ?? []), ...(config.services ?? [])]
      .flatMap(({ binding: name }: { binding: string }) => ['missing', 'type', 'target'].map(mutation => ({ role, name, mutation } as ResourceDrift)));
  });
  it.each(requiredResources)('rejects resource drift: $role/$name/$mutation', async resourceDrift => {
    await expect(verifyCloudflareDevProfile(liveProfile({ resourceDrift }))).rejects.toThrow(`${resourceDrift.name} resource binding differs`);
  });
  it.each(['environment', 'entrypoint'] as const)('rejects a different ingestion service %s', async mutation => {
    await expect(verifyCloudflareDevProfile(liveProfile({ resourceDrift: { role: 'api', name: 'INGESTION', mutation } }))).rejects.toThrow('INGESTION resource binding differs');
  });
  it('accepts the older D1 id format and rejects conflicting identities', async () => {
    await expect(verifyCloudflareDevProfile(liveProfile({ resourceDrift: { role: 'admission', name: 'DB', mutation: 'id-only' } }))).resolves.toBeUndefined();
    await expect(verifyCloudflareDevProfile(liveProfile({ resourceDrift: { role: 'admission', name: 'DB', mutation: 'conflicting-id' } }))).rejects.toThrow('DB resource binding differs');
  });
  it.each([{ delay: 86400 }, { delay: 60 }, { missingDelay: true }])('rejects admission delay before mutations and in final verification: %j', async overrides => {
    await expect(preflightCloudflareDevTransfer(liveProfile(overrides))).rejects.toThrow('initial delivery delay must be zero');
    await expect(verifyCloudflareDevProfile(liveProfile(overrides))).rejects.toThrow('initial delivery delay must be zero');
  });
  it('rejects incorrect admission routing before accepting queue ownership', async () => {
    await expect(verifyCloudflareDevProfile(liveProfile({ queueName: 'intern-notifs-admission-v2' }))).rejects.toThrow('ADMISSION_V2_QUEUE_NAME');
  });
  it('rejects a paused queue even with the expected dedicated consumer', async () => {
    await expect(verifyCloudflareDevProfile(liveProfile({ paused: true }))).rejects.toThrow('delivery is paused');
  });
  it.each([
    { settings: { batch_size: 100 } }, { settings: { max_concurrency: null } }, { settings: { max_retries: 0 } },
    { dlq: '' }, { dlq: 'intern-notifs-admission-v2-dlq' }, { consumerType: 'http_pull' },
  ])('rejects unsafe admission consumption settings: %j', async overrides => {
    await expect(verifyCloudflareDevProfile(liveProfile(overrides))).rejects.toThrow('delivery settings differ');
  });
  it('preflights a legacy owner without requiring the repaired live profile', async () => {
    await expect(preflightCloudflareDevTransfer(liveProfile({ dropMaintenance: true, consumers: ['intern-notifs-dev-ingestion'] }))).resolves.toBeUndefined();
  });
  it('permits first-time queue provisioning after authenticated listing', async () => {
    await expect(preflightCloudflareDevTransfer(liveProfile({ noQueue: true }))).resolves.toBeUndefined();
    await expect(verifyCloudflareDevProfile(liveProfile({ noQueue: true }))).rejects.toThrow('Missing dev admission queue');
  });
  it('fails preflight on paused delivery or an unknown consumer', async () => {
    await expect(preflightCloudflareDevTransfer(liveProfile({ paused: true }))).rejects.toThrow('delivery is paused');
    await expect(preflightCloudflareDevTransfer(liveProfile({ consumers: ['other'] }))).rejects.toThrow('unexpected dev admission consumer');
  });
  it('releases only the legacy dev consumer and preserves the dedicated owner', async () => {
    const deleted: string[] = [];
    await releaseLegacyDevAdmissionConsumer(liveProfile({ consumers: ['intern-notifs-dev-ingestion', 'intern-notifs-dev-admission'] }),
      async path => { deleted.push(path); });
    expect(deleted).toEqual(['/queues/admission-id/consumers/intern-notifs-dev-ingestion']);
  });
  it.each([[], ['intern-notifs-dev-admission']].map(consumers => [consumers]))('retries an already completed consumer release: %j', async (consumers) => {
    await releaseLegacyDevAdmissionConsumer(liveProfile({ consumers }), async () => { throw new Error('unexpected deletion'); });
  });
  it('refuses to delete an unexpected consumer', async () => {
    await expect(releaseLegacyDevAdmissionConsumer(liveProfile({ consumers: ['intern-notifs-ingestion'] }),
      async () => { throw new Error('unexpected deletion'); })).rejects.toThrow('unexpected dev admission consumer');
  });
  it('accepts shared maintenance timing and finds the queue beyond page one', async () => {
    await expect(verifyCloudflareDevProfile(liveProfile({ secondQueuePage: true }))).resolves.toBeUndefined();
  });
  it('rejects missing general maintenance despite aggregate cron parity', async () => {
    await expect(verifyCloudflareDevProfile(liveProfile({ dropMaintenance: true }))).rejects.toThrow('cron ownership differs');
  });
  it('rejects a stale admission writer cohort', async () => {
    await expect(verifyCloudflareDevProfile(liveProfile({ staleAdmission: true }))).rejects.toThrow('CATALOG_WRITER_SOURCE_ALLOWLIST');
  });
  it.each([[], ['intern-notifs-dev-ingestion'], ['intern-notifs-dev-ingestion', 'intern-notifs-dev-admission']].map(consumers => [consumers]))('rejects incomplete consumer transfer: %j', async (consumers) => {
    await expect(verifyCloudflareDevProfile(liveProfile({ consumers }))).rejects.toThrow('exactly one dedicated');
  });
});
