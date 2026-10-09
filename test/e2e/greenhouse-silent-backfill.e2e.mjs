import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';
register('./wasm-module-loader.mjs', import.meta.url);
const { Request, Response } = globalThis;
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const localCompatibilityDate = '2026-08-27';
async function moduleManifest(bundleDirectory, bundleName) {
  const modules = { [bundleName]: { type: 'esm', contents: await readFile(join(bundleDirectory, bundleName), 'utf8') } };
  if (existsSync(join(bundleDirectory, 'resvg.wasm'))) {
    modules['resvg.wasm'] = { type: 'wasm', contents: await readFile(join(bundleDirectory, 'resvg.wasm')) };
  }
  return modules;
}

async function createWorkerConfig(name, bundleDirectory, bundleName, env) {
  return {
    config: {
      name,
      type: 'worker',
      compatibilityDate: localCompatibilityDate,
      compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: bundleName, modulesRoot: bundleDirectory, modules: await moduleManifest(bundleDirectory, bundleName) },
      env,
    },
  };
}

async function applyMigrations(d1) {
  const migrationsDirectory = join(repositoryRoot, 'cloudflare/migrations');
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort((left, right) => left.localeCompare(right));
  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDirectory, migration), 'utf8');
    await d1.batch(splitSqlQuery(sql).map((statement) => d1.prepare(statement)));
  }
}


for (const [token, name, applyUrl] of [
  ['voloridgeinvestmentmanagement', 'Voloridge Investment Management', 'https://job-boards.greenhouse.io/voloridgeinvestmentmanagement/jobs/5001'],
  ['janestreet', 'Jane Street', 'https://www.janestreet.com/join-jane-street/position/5001/'],
]) test(`compiled quiet backfill retains ${token} in D1 and a complete R2 snapshot`, async () => {
  const id = `greenhouse-${token}`, workerName = `quiet-${token}`;
  const runtime = new Miniflare({ workers: [await createWorkerConfig(workerName,
    join(repositoryRoot, 'cloudflare/dist/ingestion'), 'ingestion-worker.js', {
      DB: { type: 'd1', id: workerName }, DOCUMENTS: { type: 'r2', name: workerName },
    })] });
  const realFetch = globalThis.fetch;
  try {
    await runtime.ready;
    const DB = await runtime.getD1Database('DB', workerName), DOCUMENTS = await runtime.getR2Bucket('DOCUMENTS', workerName);
    await applyMigrations(DB);
    const pausedAt = new Date(Date.now() - 60000).toISOString();
    for (const [sk, kind, value] of [
      ['HEALTH', 'source-health', { sourceId: id, sourceStatus: 'paused', state: 'healthy', changedAt: pausedAt,
        lastAttemptAt: pausedAt, consecutiveFailures: 0, durationMs: 0 }],
      ['CHECKPOINT', 'source-checkpoint', { sourceId: id, successfulFetches: 3, lastRowCount: 0 }],
    ]) await DB.prepare('INSERT INTO catalog_items(pk,sk,kind,value) VALUES (?,?,?,?)').bind(`SOURCE#${id}`, sk, kind, JSON.stringify(value)).run();
    let fetches = 0;
    globalThis.fetch = async (input) => {
      fetches++;
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (url.hostname === 'boards-api.greenhouse.io') return Response.json(url.pathname.endsWith('/jobs') ? { jobs: [{
        id: 5001, internal_job_id: 5001, title: 'Software Engineering Intern, Summer 2027', absolute_url: applyUrl,
        location: { name: 'New York, NY' }, content: '<p>Build software. Summer 2027 internship.</p>',
        updated_at: '2026-10-08T12:00:00.000Z', departments: [], offices: [],
      }] } : { name });
      return new Response('<html><title>Software Engineering Intern, Summer 2027</title><body>Apply for this internship</body></html>', { headers: { 'content-type': 'text/html' } });
    };
    const { default: worker } = await import('../../cloudflare/dist/ingestion/ingestion-worker.js');
    const response = await worker.fetch(new Request(`https://ingestion.test/internal/poll-source?provider=greenhouse&sourceId=${id}&seedOnly=true`, {
      method: 'POST', headers: { 'X-Operations-Key': 'test-operations', 'X-InternNotifs-Service-Key': 'test-internal' },
    }), { DB, DOCUMENTS, OPERATIONS_SHARED_SECRET: 'test-operations', INTERNAL_SERVICE_SECRET: 'test-internal',
      INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: id,
      GREENHOUSE_QUEUE: { async send() {} } });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    const cp = JSON.parse((await DB.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk='CHECKPOINT'").bind(`SOURCE#${id}`).first()).value);
    assert.deepEqual(cp.activeExternalIds, ['5001']);
    assert.equal((await DB.prepare("SELECT COUNT(*) n FROM catalog_items WHERE kind='notification-event'").first()).n, 0);
    const snapshot = await DB.prepare('SELECT * FROM ingestion_snapshots WHERE source_id=? AND is_complete=1').bind(id).first();
    assert.equal(snapshot.row_count, 1);
    assert.ok(await DOCUMENTS.get(snapshot.object_key));
    const health = JSON.parse((await DB.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk='HEALTH'").bind(`SOURCE#${id}`).first()).value);
    assert.equal(health.sourceStatus, 'paused');
    assert.equal(health.state, 'healthy');
    const activeHealth = { ...health, sourceStatus: 'active', changedAt: new Date().toISOString() };
    await DB.prepare("UPDATE catalog_items SET value=? WHERE pk=? AND sk='HEALTH'").bind(JSON.stringify(activeHealth), `SOURCE#${id}`).run();
    const beforeFetches = fetches, settled = { ack: 0, retries: 0 };
    await worker.queue({ queue: 'intern-notifs-greenhouse', messages: [{ id: 'late-quiet-continuation', attempts: 1,
      timestamp: new Date(), body: { version: 1, sourceId: id, scheduledAt: new Date().toISOString(),
        force: true, forceRequestedAt: new Date(Date.now() - 1000).toISOString(), seedOnly: true },
      ack() { settled.ack++; }, retry() { settled.retries++; },
    }] }, { DB, DOCUMENTS, GREENHOUSE_QUEUE: { async send() {} } });
    assert.deepEqual(settled, { ack: 1, retries: 0 });
    assert.equal(fetches, beforeFetches, 'obsolete quiet delivery must never reach the provider');
    const after = JSON.parse((await DB.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk='HEALTH'").bind(`SOURCE#${id}`).first()).value);
    assert.deepEqual(after, activeHealth, 'obsolete quiet work must not degrade or mutate source health');
    assert.equal((await DB.prepare("SELECT COUNT(*) n FROM catalog_items WHERE kind='notification-event'").first()).n, 0);
  } finally { globalThis.fetch = realFetch; await runtime.dispose(); }
});
