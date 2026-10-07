import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseLegacyDevAdmissionConsumer, verifyCloudflareDevProfile } from '../scripts/verify-cloudflare-dev-profile.js';

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
    expect(commands.slice(0, 4)).toEqual(['run cloudflare:dev:provision',
      'deploy --config wrangler.dev.ingestion.jsonc', 'scripts/verify-cloudflare-dev-profile.ts --release-legacy-consumer',
      'deploy --config wrangler.dev.admission.jsonc']);
    if (failAdmission) expect(commands).toHaveLength(4);
    else expect(commands.slice(4)).toEqual(['deploy --config wrangler.dev.catalog-publisher.jsonc',
      'deploy --config wrangler.dev.api.jsonc --containers-rollout=none', 'scripts/verify-cloudflare-dev-profile.ts']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function liveProfile(overrides: { dropMaintenance?: boolean; staleAdmission?: boolean; consumers?: string[]; secondQueuePage?: boolean } = {}) {
  return async <T>(path: string): Promise<T> => {
    if (path.startsWith('/queues?')) {
      if (overrides.secondQueuePage && path.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => ({ queue_name: `other-${i}`, queue_id: String(i) })) as T;
      return [{ queue_name: 'intern-notifs-dev-admission-v2', queue_id: 'admission-id' }] as T;
    }
    if (path.endsWith('/consumers')) return (overrides.consumers ?? ['intern-notifs-dev-admission']).map(script_name => ({ script_name, consumer_id: script_name })) as T;
    const worker = path.split('/')[3]!;
    const role = worker === 'intern-notifs-dev' ? 'api' : worker.replace('intern-notifs-dev-', '');
    const config = JSON.parse(readFileSync(`wrangler.dev.${role}.jsonc`, 'utf8'));
    if (path.endsWith('/settings')) return { bindings: Object.entries(config.vars).map(([name, text]) => ({
      name, type: 'plain_text', text: overrides.staleAdmission && role === 'admission' && name === 'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST' ? 'old-cohort' : text,
    })) } as T;
    if (path.endsWith('/schedules')) return { schedules: (config.triggers?.crons ?? [])
      .filter((cron: string) => !(overrides.dropMaintenance && role === 'ingestion' && cron === '9-59/10 * * * *'))
      .map((cron: string) => ({ cron })) } as T;
    throw new Error(`Unexpected request: ${path}`);
  };
}

describe('live dev deployment parity', () => {
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
