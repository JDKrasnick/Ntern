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
    const envelope = await (await DOCUMENTS.get(snapshot.object_key)).json();
    assert.equal(envelope.schemaVersion, 3);
    assert.ok(envelope.rows.every(row => row.posting.contentCompleteness === 'index-only'
      && row.posting.content.every(part => part.value === '')));
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


test('compiled oversized Greenhouse discovery retains the whole index across detail and unchanged deliveries', async () => {
  const token = 'lucidmotors', id = `greenhouse-${token}`, workerName = 'oversized-index';
  const runtime = new Miniflare({ workers: [await createWorkerConfig(workerName,
    join(repositoryRoot, 'cloudflare/dist/ingestion'), 'ingestion-worker.js', {
      DB: { type: 'd1', id: workerName }, DOCUMENTS: { type: 'r2', name: workerName },
    })] });
  const realFetch = globalThis.fetch;
  try {
    await runtime.ready;
    const DB = await runtime.getD1Database('DB', workerName), DOCUMENTS = await runtime.getR2Bucket('DOCUMENTS', workerName);
    await applyMigrations(DB);
    const jobs = Array.from({ length: 21 }, (_, i) => ({
      id: 70000 + i, internal_job_id: 70000 + i,
      title: 'Software Engineering Intern, Summer 2027',
      absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${70000 + i}`,
      location: { name: 'New York, NY' }, updated_at: '2026-10-12T12:00:00.000Z',
      content: `<p>Unique description ${i}. Software internship. Summer 2027. Pays $50/hour.</p>`,
      departments: [], offices: [],
    }));
    let fullRequests = 0, detailRequests = 0;
    globalThis.fetch = async input => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (url.hostname !== 'boards-api.greenhouse.io') return new Response('<html><title>Software Engineering Intern, Summer 2027</title><body>Software internship application</body></html>');
      const detail = /\/jobs\/(\d+)$/.exec(url.pathname);
      if (detail) { detailRequests++; return Response.json(jobs.find(job => String(job.id) === detail[1])); }
      if (!url.pathname.endsWith('/jobs')) return Response.json({ name: 'Lucid Motors' });
      if (url.searchParams.get('content') === 'false') return Response.json({ jobs: jobs.map(job => ({ ...job, content: undefined })) });
      fullRequests++;
      return new Response('x'.repeat(8 * 1024 * 1024 + 1));
    };
    const { default: worker } = await import('../../cloudflare/dist/ingestion/ingestion-worker.js');
    const env = { DB, DOCUMENTS, OPERATIONS_SHARED_SECRET: 'test-operations', INTERNAL_SERVICE_SECRET: 'test-internal',
      INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: id,
      GREENHOUSE_QUEUE: { async send() {} } };
    let firstHash;
    for (let delivery = 0; delivery < 3; delivery++) {
      const response = await worker.fetch(new Request(`https://ingestion.test/internal/poll-source?provider=greenhouse&sourceId=${id}`, {
        method: 'POST', headers: { 'X-Operations-Key': 'test-operations', 'X-InternNotifs-Service-Key': 'test-internal' },
      }), env);
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      const cp = JSON.parse((await DB.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk='CHECKPOINT'").bind(`SOURCE#${id}`).first()).value);
      assert.equal(cp.activeExternalIds.length, jobs.length);
      const snapshot = await DB.prepare("SELECT * FROM ingestion_snapshots WHERE source_id=? AND state='active'").bind(id).first();
      assert.equal(snapshot.row_count, jobs.length);
      const envelope = await (await DOCUMENTS.get(snapshot.object_key)).json();
      assert.deepEqual(envelope.rows.map(row => row.externalId).sort(), jobs.map(job => String(job.id)).sort());
      assert.ok(envelope.rows.every(row => row.posting.contentCompleteness === 'index-only' && row.posting.content.every(part => part.value === '')));
      firstHash ??= snapshot.snapshot_hash;
      assert.equal(snapshot.snapshot_hash, firstHash, 'detail slices must not change the index snapshot');
    }
    assert.equal(fullRequests, 1);
    assert.equal(detailRequests, jobs.length);
    assert.equal((await DB.prepare("SELECT COUNT(*) n FROM ingestion_rows WHERE source_id=? AND state='absent'").bind(id).first()).n, 0);
    assert.equal((await DB.prepare("SELECT COUNT(*) n FROM catalog_items WHERE kind='notification-event'").first()).n, 0);
  } finally { globalThis.fetch = realFetch; await runtime.dispose(); }
});


for (const [provider, token] of [['lever', 'acds'], ['ashby', 'sentry']]) {
  test(`compiled ${provider} quiet backfill preserves an established checkpoint without alerts`, async () => {
    const id = `${provider}-${token}`, workerName = `quiet-${provider}`;
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
        ['CHECKPOINT', 'source-checkpoint', { sourceId: id, successfulFetches: 865, activeExternalIds: [], lastRowCount: 0 }],
      ]) await DB.prepare('INSERT INTO catalog_items(pk,sk,kind,value) VALUES (?,?,?,?)')
        .bind(`SOURCE#${id}`, sk, kind, JSON.stringify(value)).run();
      const postingId = '11111111-1111-4111-8111-111111111111';
      const applyUrl = provider === 'lever' ? `https://jobs.lever.co/${token}/${postingId}/apply`
        : `https://jobs.ashbyhq.com/${token}/${postingId}/application`;
      let fetches = 0;
      globalThis.fetch = async input => {
        fetches++;
        const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
        if (url.hostname === 'api.lever.co') return Response.json([{
          id: postingId, text: 'Software Engineering Intern, Summer 2027', descriptionPlain: 'Build software systems.',
          createdAt: 1783072000000, categories: { location: 'New York, NY', commitment: 'Internship' },
          hostedUrl: `https://jobs.lever.co/${token}/${postingId}`, applyUrl,
        }]);
        if (url.hostname === 'api.ashbyhq.com') return Response.json({ apiVersion: '1', jobs: [{
          id: postingId, title: 'Software Engineering Intern, Summer 2027', location: 'New York, NY',
          isListed: true, employmentType: 'Intern', publishedAt: '2026-08-09T12:00:00Z',
          descriptionPlain: 'Build software systems.', jobUrl: `https://jobs.ashbyhq.com/${token}/${postingId}`, applyUrl,
        }] });
        return new Response('<html><title>Software Engineering Intern, Summer 2027</title><body>Apply for this internship</body></html>',
          { headers: { 'content-type': 'text/html' } });
      };
      const { default: worker } = await import('../../cloudflare/dist/ingestion/ingestion-worker.js');
      const response = await worker.fetch(new Request(`https://ingestion.test/internal/poll-source?provider=${provider}&sourceId=${id}&seedOnly=true`, {
        method: 'POST', headers: { 'X-Operations-Key': 'test-operations', 'X-InternNotifs-Service-Key': 'test-internal' },
      }), { DB, DOCUMENTS, OPERATIONS_SHARED_SECRET: 'test-operations', INTERNAL_SERVICE_SECRET: 'test-internal',
        INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: id,
        LEVER_QUEUE: { async send() {} }, ASHBY_QUEUE: { async send() {} } });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      const cp = JSON.parse((await DB.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk='CHECKPOINT'").bind(`SOURCE#${id}`).first()).value);
      assert.deepEqual(cp.activeExternalIds, [postingId]);
      assert.equal((await DB.prepare("SELECT COUNT(*) n FROM catalog_items WHERE kind='notification-event'").first()).n, 0);
      const snapshot = await DB.prepare('SELECT * FROM ingestion_snapshots WHERE source_id=? AND is_complete=1').bind(id).first();
      assert.equal(snapshot.row_count, 1);
      const envelope = await (await DOCUMENTS.get(snapshot.object_key)).json();
      assert.equal(envelope.rows[0].externalId, postingId);
      const health = JSON.parse((await DB.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk='HEALTH'").bind(`SOURCE#${id}`).first()).value);
      assert.equal(health.sourceStatus, 'paused');
      const activeHealth = { ...health, sourceStatus: 'active', changedAt: new Date().toISOString() };
      await DB.prepare("UPDATE catalog_items SET value=? WHERE pk=? AND sk='HEALTH'").bind(JSON.stringify(activeHealth), `SOURCE#${id}`).run();
      const beforeFetches = fetches, delivered = { ack: 0, retries: 0 };
      await worker.queue({ queue: `intern-notifs-${provider}`, messages: [{ id: 'late-quiet-delivery', attempts: 1,
        timestamp: new Date(), body: { version: 1, sourceId: id, scheduledAt: new Date().toISOString(),
          force: true, forceRequestedAt: new Date(Date.now() - 1000).toISOString(), seedOnly: true },
        ack() { delivered.ack++; }, retry() { delivered.retries++; },
      }] }, { DB, DOCUMENTS, LEVER_QUEUE: { async send() {} }, ASHBY_QUEUE: { async send() {} } });
      assert.deepEqual(delivered, { ack: 1, retries: 0 });
      assert.equal(fetches, beforeFetches);
      const after = JSON.parse((await DB.prepare("SELECT value FROM catalog_items WHERE pk=? AND sk='HEALTH'").bind(`SOURCE#${id}`).first()).value);
      assert.deepEqual(after, activeHealth);
    } finally { globalThis.fetch = realFetch; await runtime.dispose(); }
  });
}
