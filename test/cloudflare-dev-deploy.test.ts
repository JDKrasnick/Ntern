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

it.each(['missing token', 'missing account', 'denied access'])('the real helper preflight stops before every mutation: %s', (fault) => {
  const directory = mkdtempSync(join(tmpdir(), 'dev-preflight-'));
  const log = join(directory, 'commands');
  try {
    for (const name of ['npm', 'wrangler']) writeFileSync(join(directory, name),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DEPLOY_TEST_LOG"\n', { mode: 0o755 });
    const fetchStub = join(directory, 'fetch.mjs');
    writeFileSync(fetchStub, "globalThis.fetch = async () => Response.json({success:false}, {status:403});\n");
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
    expect(result.stderr).toContain(fault === 'denied access' ? 'Dev profile request failed' : 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['scripts/verify-cloudflare-dev-profile.ts --preflight']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

type ConsumerSettings = { batch_size: number; max_concurrency: number | null; max_retries: number };
function liveProfile(overrides: { dropMaintenance?: boolean; staleAdmission?: boolean; consumers?: string[]; secondQueuePage?: boolean;
  queueName?: string; paused?: boolean; noQueue?: boolean; consumerType?: string; dlq?: string;
  settings?: Partial<ConsumerSettings> } = {}) {
  return async <T>(path: string): Promise<T> => {
    if (path.startsWith('/queues?')) {
      if (overrides.secondQueuePage && path.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => ({ queue_name: `other-${i}`, queue_id: String(i) })) as T;
      return (overrides.noQueue ? [] : [{ queue_name: 'intern-notifs-dev-admission-v2', queue_id: 'admission-id', settings: { delivery_paused: overrides.paused ?? false } }]) as T;
    }
    if (path.endsWith('/consumers')) return (overrides.consumers ?? ['intern-notifs-dev-admission']).map(script_name => ({ script_name, consumer_id: script_name,
      type: overrides.consumerType ?? 'worker', dead_letter_queue: overrides.dlq ?? 'intern-notifs-dev-admission-v2-dlq',
      settings: { batch_size: 1, max_concurrency: 1, max_retries: 2, ...overrides.settings },
    })) as T;
    const worker = path.split('/')[3]!;
    const role = worker === 'intern-notifs-dev' ? 'api' : worker.replace('intern-notifs-dev-', '');
    const config = JSON.parse(readFileSync(`wrangler.dev.${role}.jsonc`, 'utf8'));
    if (path.endsWith('/settings')) return { bindings: Object.entries(config.vars).map(([name, text]) => ({
      name, type: 'plain_text', text: role === 'admission' && name === 'ADMISSION_V2_QUEUE_NAME' && overrides.queueName
        ? overrides.queueName : overrides.staleAdmission && role === 'admission' && name === 'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST' ? 'old-cohort' : text,
    })) } as T;
    if (path.endsWith('/schedules')) return { schedules: (config.triggers?.crons ?? [])
      .filter((cron: string) => !(overrides.dropMaintenance && role === 'ingestion' && cron === '9-59/10 * * * *'))
      .map((cron: string) => ({ cron })) } as T;
    throw new Error(`Unexpected request: ${path}`);
  };
}

describe('live dev deployment parity', () => {
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
