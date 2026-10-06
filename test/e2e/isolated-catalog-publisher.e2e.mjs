import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

let runtime, db, bucket, worker, env;
before(async () => {
  const contents = await readFile(new URL('../../cloudflare/dist/catalog-publisher/catalog-publisher-worker.js', import.meta.url), 'utf8');
  runtime = new Miniflare({ workers: [{ config: {
    name: 'isolated-publisher-e2e', type: 'worker', compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'publisher.js', modules: { 'publisher.js': { type: 'esm', contents } } },
    env: { DB: { type: 'd1', id: 'isolated-publisher-e2e' }, DOCUMENTS: { type: 'r2', name: 'isolated-publisher-e2e' } },
  } }] });
  await runtime.ready;
  db = await runtime.getD1Database('DB', 'isolated-publisher-e2e');
  bucket = await runtime.getR2Bucket('DOCUMENTS', 'isolated-publisher-e2e');
  const migrations = new URL('../../cloudflare/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter((x) => x.endsWith('.sql')).sort()) {
    await db.batch(splitSqlQuery(await readFile(new URL(name, migrations), 'utf8')).map((sql) => db.prepare(sql)));
  }
  worker = (await import('../../cloudflare/dist/catalog-publisher/catalog-publisher-worker.js')).default;
  env = { DB: db, DOCUMENTS: bucket, SHADOW_EXTRACTION_ARTIFACTS: bucket,
    INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'true', LLM_METADATA_PUBLICATION_POLICY_JSON: '{"enabled":false}' };
  const now = new Date().toISOString();
  const job = { jobId: 'isolated-role', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl: 'https://example.com/role', normalizedUrl: 'https://example.com/role', fingerprint: 'isolated-role',
    compensation: { raw: '' }, sourceReferences: [], technical: true, open: true,
    firstSeenAt: now, lastSeenAt: now, catalogVisibleAt: now, notification: { smsPending: false, digestPending: false } };
  await db.prepare("INSERT INTO catalog_items (pk,sk,kind,value) VALUES ('JOB#isolated-role','INTERNSHIP','internship',?)").bind(JSON.stringify(job)).run();
});
after(async () => { await runtime?.dispose(); });
const scheduled = (cron) => worker.scheduled({ cron, scheduledTime: Date.now() }, env);
const marker = (scope) => db.prepare('SELECT value,updated_at FROM system_state WHERE key=?').bind(`maintenance_phase:${scope}:${scope}_complete`).first();

test('disabled publisher does no database work and exposes no public operations', async () => {
  await worker.scheduled({ cron: '1-51/10 * * * *', scheduledTime: Date.now() }, { INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'false', DB: { prepare() { throw Error('unexpected read'); } } });
  assert.equal((await worker.fetch(new globalThis.Request('https://example.com/internal/operations'))).status, 404);
});

test('publishes the matching D1 generation to real local R2 without notification events', async () => {
  await scheduled('1-51/10 * * * *');
  assert.equal(JSON.parse((await marker('catalog_projection')).value).status, 'complete');
  await scheduled('4,14,24,34,44,54 * * * *');
  const pointer = await bucket.get('public-catalog/v1/current'); assert.ok(pointer);
  const value = JSON.parse(await pointer.text()); assert.equal(value.count, 1);
  assert.equal(JSON.parse((await marker('catalog_projection_r2')).value).status, 'complete');
  const notifications = await db.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind='notification-event'").first();
  assert.equal(notifications.n, 0);
});

test('R2 failure invalidates the old pointer and does not advance the completion marker; retry recovers', async () => {
  const before = await marker('catalog_projection_r2');
  const failing = { ...env, DOCUMENTS: { get: bucket.get.bind(bucket), delete: bucket.delete.bind(bucket), async put() { throw new Error('R2 unavailable'); } } };
  await assert.rejects(worker.scheduled({ cron: '4,14,24,34,44,54 * * * *', scheduledTime: Date.now() }, failing), /R2 unavailable/);
  assert.equal(await bucket.get('public-catalog/v1/current'), null);
  assert.deepEqual(await marker('catalog_projection_r2'), before);
  await scheduled('4,14,24,34,44,54 * * * *');
  assert.ok(await bucket.get('public-catalog/v1/current'));
});

test('unchanged catalog cycles retire and repair missing or corrupt active pages', async () => {
  for (const fault of ['missing', 'malformed', 'changed']) {
    const pointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
    const pageKey = `public-catalog/v1/${pointer.version}/0`;
    const original = await (await bucket.get(pageKey)).text();
    if (fault === 'missing') await bucket.delete(pageKey);
    if (fault === 'malformed') await bucket.put(pageKey, '{');
    if (fault === 'changed') {
      const altered = JSON.parse(original);
      altered[0].roles[0].title = 'Corrupted title';
      await bucket.put(pageKey, JSON.stringify(altered));
    }
    await scheduled('1-51/10 * * * *');
    assert.equal(await bucket.get('public-catalog/v1/current'), null, `${fault} page must retire its pointer`);
    await scheduled('4,14,24,34,44,54 * * * *');
    const repaired = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
    assert.equal(repaired.version, pointer.version);
    assert.equal(await (await bucket.get(pageKey)).text(), original);
    assert.equal(JSON.parse((await marker('catalog_projection_r2')).value).status, 'complete');
  }
});

test('billing shutdown preserves the published catalog', async () => {
  await db.prepare("INSERT OR REPLACE INTO system_state(key,value,updated_at) VALUES ('billing_shutdown','stopped',?)").bind(new Date().toISOString()).run();
  const before = await marker('catalog_projection');
  await scheduled('1-51/10 * * * *'); assert.deepEqual(await marker('catalog_projection'), before);
});
