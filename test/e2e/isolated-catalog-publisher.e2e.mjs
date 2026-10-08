import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

let runtime, db, bucket, worker, env;
before(async () => {
  const contents = await readFile(new URL('../../cloudflare/dist/catalog-publisher/catalog-publisher-worker.js', import.meta.url), 'utf8');
  runtime = new Miniflare({ workers: [{ config: {
    name: 'isolated-publisher-e2e', type: 'worker', compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'publisher.js', modules: { 'publisher.js': { type: 'esm', contents } } },
    env: { DB: { type: 'd1', id: 'isolated-publisher-e2e' }, DOCUMENTS: { type: 'r2', name: 'isolated-publisher-e2e' },
      SHADOW_EXTRACTION_ARTIFACTS: { type: 'r2', name: 'isolated-publisher-e2e' },
      INGESTION_V2_ISOLATED_WORKERS_ENABLED: { type: 'text', value: 'true' },
      LLM_METADATA_PUBLICATION_POLICY_JSON: { type: 'text', value: '{"enabled":false}' } },
  } }, { config: {
    name: 'scheduled-caller-e2e', type: 'worker', compatibilityDate: '2026-08-27',
    manifest: { mainModule: 'caller.js', modules: { 'caller.js': { type: 'esm',
      contents: 'export default { fetch(request,env) { return env.CATALOG_PUBLISHER.fetch(request); } };' } } },
    env: { CATALOG_PUBLISHER: { type: 'worker', workerName: 'isolated-publisher-e2e' } },
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
async function runPublisher(event, environment) {
  const response = await worker.fetch(scheduleRequest(event), environment);
  assert.equal(response.status, 200, `isolated publication failed: ${response.status}`);
  assert.deepEqual(await response.json(), { completed: true });
}
const scheduleRequest = (event) => new globalThis.Request('https://isolated.internal/internal/scheduled', { method: 'POST', body: JSON.stringify(event) });
const scheduled = (cron) => runPublisher({ cron, scheduledTime: Date.now() }, env);
const marker = (scope) => db.prepare('SELECT value,updated_at FROM system_state WHERE key=?').bind(`maintenance_phase:${scope}:${scope}_complete`).first();

test('the established ingestion cron completes general maintenance and private admission dispatch', async () => {
  const event = { cron: '9-59/10 * * * *', scheduledTime: Date.now() };
  const profile = JSON.parse(await readFile(new URL('../../wrangler.dev.ingestion.jsonc', import.meta.url), 'utf8'));
  const admission = (await import('../../cloudflare/dist/admission/admission-worker.js')).default;
  const ingestion = (await import('../../cloudflare/dist/ingestion/ingestion-worker.js')).default;
  const queue = { async send() {}, async sendBatch() {} };
  const environment = { ...profile.vars, DB: db, DOCUMENTS: bucket, SHADOW_EXTRACTION_ARTIFACTS: bucket,
    DESTINATION_VERIFICATION_QUEUE: queue, DESTINATION_VERIFICATION_DLQ: queue, ADMISSION_V2_QUEUE: queue };
  assert.ok(profile.triggers.crons.includes(event.cron));
  assert.deepEqual(JSON.parse(await readFile(new URL('../../wrangler.dev.admission.jsonc', import.meta.url), 'utf8')).triggers.crons, []);
  await ingestion.scheduled(event, { ...environment, ADMISSION_WORKER: { fetch: request => admission.fetch(request, environment) } });
  const general = await marker('maintenance');
  assert.equal(JSON.parse(general.value).status, 'complete');
  const dispatch = await db.prepare("SELECT value FROM system_state WHERE key='maintenance_phase:admission_v2:dispatch'").first();
  assert.equal(JSON.parse(dispatch.value).status, 'complete');
  assert.equal(JSON.parse(dispatch.value).observedAt, new Date(event.scheduledTime).toISOString());
});

test('the native private service binding reaches the compiled publisher and activates matching real D1/R2 pointers', async () => {
  const caller = await runtime.getWorker('scheduled-caller-e2e');
  for (const cron of ['1,11,21,31,41,51 * * * *', '5,15,25,35,45,55 * * * *']) {
    const response = await caller.fetch('https://isolated.internal/internal/scheduled', {
      method: 'POST', body: JSON.stringify({ cron, scheduledTime: Date.now() }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { completed: true });
  }
  const d1 = await db.prepare("SELECT value FROM catalog_items WHERE pk='CATALOG_PROJECTION' AND sk='CURRENT'").first();
  const r2 = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  assert.equal(JSON.parse(d1.value).version, r2.version);
  assert.equal(r2.count, 1);
});

test('compiled publication retains public provenance without hydrating internal occurrence diagnostics', async () => {
  const row = await db.prepare("SELECT value FROM catalog_items WHERE pk='JOB#isolated-role'").first();
  const diagnostic = 'private occurrence diagnostic '.repeat(1200);
  const fields = ['metadataEvidence', 'admission', 'postingIdentityDecision', 'trustedCommunityAlertQualification', 'metadataExtraction', 'sourceMetadataProcessing'];
  const reference = { sourceId: 'greenhouse-figma', sourceUrl: 'https://boards.greenhouse.io/figma', externalId: 'reference-role',
    provenance: 'official-ats', state: 'open', postedAt: '2026-10-06', providerTimestamp: { value: '2026-10-06T12:00:00Z', semantics: 'published' },
    ...Object.fromEntries(fields.map(field => [field, { diagnostic }])) };
  const job = { ...JSON.parse(row.value), jobId: 'reference-role', sourceReferences: [reference] };
  await db.prepare("INSERT INTO catalog_items(pk,sk,kind,value) VALUES ('JOB#reference-role','INTERNSHIP','internship',?)").bind(JSON.stringify(job)).run();
  const caller = await runtime.getWorker('scheduled-caller-e2e');
  const publish = async () => {
    for (const cron of ['1,11,21,31,41,51 * * * *', '5,15,25,35,45,55 * * * *']) {
      const response = await caller.fetch('https://isolated.internal/internal/scheduled', { method: 'POST', body: JSON.stringify({ cron, scheduledTime: Date.now() }) });
      assert.equal(response.status, 200);
    }
  };
  try {
    await publish();
    const pointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
    const groups = JSON.parse(await (await bucket.get(`public-catalog/v1/${pointer.pageVersion ?? pointer.version}/0`)).text());
    const role = groups.flatMap(group => group.roles).find(role => role.jobId === 'reference-role');
    assert.ok(role);
    assert.deepEqual(role.sourceReferences, [{ sourceId: reference.sourceId, sourceUrl: reference.sourceUrl, externalId: reference.externalId,
      provenance: reference.provenance, state: reference.state, postedAt: reference.postedAt, providerTimestamp: reference.providerTimestamp }]);
    const stored = JSON.parse((await db.prepare("SELECT value FROM catalog_items WHERE pk='JOB#reference-role'").first()).value);
    for (const field of fields) assert.equal(stored.sourceReferences[0][field].diagnostic, diagnostic);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind='notification-event'").first()).n, 0);
  } finally {
    await db.prepare("DELETE FROM catalog_items WHERE pk='JOB#reference-role'").run();
    await publish();
  }
});

test('compiled manual admission dispatch stays source-scoped, bounded, and separate from cron completion', async () => {
  const admission = (await import('../../cloudflare/dist/admission/admission-worker.js')).default;
  const source = 'greenhouse-manual-fixture', other = 'lever-other-fixture', hash = 'c'.repeat(64), policy = 'manual-policy', now = new Date().toISOString();
  const cursor = await db.prepare('SELECT source_cursor FROM ingestion_v2_dispatch_state WHERE singleton=1').first();
  const naturalMarker = await db.prepare("SELECT value FROM system_state WHERE key='maintenance_phase:admission_v2:dispatch'").first();
  const sends = [];
  const environment = { ...env, INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: `${source},${other}`,
    INGESTION_V2_ADMISSION_ENABLED: 'true', INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: `${source},${other}`,
    INGESTION_V2_CATALOG_WRITER_ENABLED: 'true', INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: `${source},${other}`,
    INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: `${source},${other}`,
    ADMISSION_V2_QUEUE: { async sendBatch(messages) { sends.push(...messages); } } };
  const dispatch = () => admission.fetch(new globalThis.Request('https://isolated.internal/internal/dispatch', { method: 'POST', body: JSON.stringify({ sourceId: source }) }), environment);
  try {
    for (const id of [source, other]) await db.prepare("INSERT INTO ingestion_snapshots(source_id,snapshot_hash,object_key,admission_version,document_count,row_count,state,is_complete,baseline,created_at,activated_at) VALUES (?,?,?,?,1,?,'active',1,1,?,?)")
      .bind(id, hash, `ingestion-v2/snapshots/${id}/${hash}.json`, policy, id === source ? 501 : 1, now, now).run();
    for (let start = 0; start < 501; start += 25) await db.batch(Array.from({ length: Math.min(25, 501 - start) }, (_, offset) =>
      db.prepare("INSERT INTO ingestion_rows(source_id,external_id,snapshot_hash,material_hash,admission_version,state,notification_baseline,first_observed_at,last_observed_at,updated_at) VALUES (?,?,?,?,?,'pending',1,?,?,?)")
        .bind(source, `row-${String(start + offset).padStart(4, '0')}`, hash, hash, policy, now, now, now)));
    await db.prepare("INSERT INTO ingestion_rows(source_id,external_id,snapshot_hash,material_hash,admission_version,state,notification_baseline,first_observed_at,last_observed_at,updated_at) VALUES (?,?,?,?,?,'pending',1,?,?,?)")
      .bind(other, 'other-row', hash, hash, policy, now, now, now).run();
    const response = await dispatch(); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.rows, 500); assert.equal(result.sources, 1);
    assert.equal(sends.reduce((n, message) => n + message.body.externalIds.length, 0), 500);
    assert.ok(sends.every(message => message.body.sourceId === source && message.body.baseline === true));
    assert.equal((await db.prepare("SELECT count(*) AS n FROM ingestion_rows WHERE source_id=? AND state='pending'").bind(source).first()).n, 1);
    assert.equal((await db.prepare("SELECT state FROM ingestion_rows WHERE source_id=?").bind(other).first()).state, 'pending');
    const count = sends.length; assert.equal((await dispatch()).status, 409); assert.equal(sends.length, count);
    await db.prepare("UPDATE ingestion_rows SET state='settled' WHERE source_id=?").bind(source).run();
    const unacknowledged = await dispatch(); assert.equal(unacknowledged.status, 409);
    assert.match((await unacknowledged.json()).message, /handoffs must drain/);
    await db.prepare('UPDATE ingestion_admission_handoffs SET acknowledged_at=? WHERE source_id=?').bind(now, source).run();
    await db.prepare('UPDATE ingestion_snapshots SET is_complete=0 WHERE source_id=?').bind(source).run();
    const incomplete = await dispatch(); assert.equal(incomplete.status, 409);
    assert.match((await incomplete.json()).message, /Complete active snapshot/);
    assert.equal(sends.length, count);
    assert.deepEqual(await db.prepare('SELECT source_cursor FROM ingestion_v2_dispatch_state WHERE singleton=1').first(), cursor);
    assert.deepEqual(await db.prepare("SELECT value FROM system_state WHERE key='maintenance_phase:admission_v2:dispatch'").first(), naturalMarker);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind='notification-event'").first()).n, 0);
  } finally {
    for (const id of [source, other]) {
      await db.prepare('DELETE FROM ingestion_admission_handoffs WHERE source_id=?').bind(id).run();
      await db.prepare('DELETE FROM ingestion_rows WHERE source_id=?').bind(id).run();
      await db.prepare('DELETE FROM ingestion_snapshots WHERE source_id=?').bind(id).run();
    }
  }
});

test('the real profile CLI rejects broken routes and delayed delivery before validated compiled dispatch', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'dev-profile-e2e-'));
  const responsesFile = join(directory, 'responses.json');
  const source = 'greenhouse-figma';
  const hash = 'a'.repeat(64);
  const policy = 'review-policy';
  const now = new Date().toISOString();
  const profile = JSON.parse(await readFile(join(root, 'wrangler.dev.admission.jsonc'), 'utf8'));
  const handler = (await import('../../cloudflare/dist/admission/admission-worker.js')).default;
  try {
    const responses = {
      '/queues?per_page=100&page=1': [{ queue_id: 'review-queue', queue_name: 'intern-notifs-dev-admission-v2', settings: { delivery_delay: 0 } }],
      '/queues/review-queue/consumers': [{ script_name: 'intern-notifs-dev-admission', type: 'worker',
        dead_letter_queue: 'intern-notifs-dev-admission-v2-dlq', settings: { batch_size: 1, max_concurrency: 1, max_retries: 2 } }],
    };
    for (const role of ['ingestion', 'admission', 'catalog-publisher', 'api']) {
      const config = JSON.parse(await readFile(join(root, `wrangler.dev.${role}.jsonc`), 'utf8'));
      responses[`/workers/scripts/${config.name}/settings`] = { bindings: [
        ...Object.entries(config.vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
        ...(config.d1_databases ?? []).map(b => ({ name: b.binding, type: 'd1', database_id: b.database_id })),
        ...(config.r2_buckets ?? []).map(b => ({ name: b.binding, type: 'r2_bucket', bucket_name: b.bucket_name })),
        ...(config.queues?.producers ?? []).map(b => ({ name: b.binding, type: 'queue', queue_name: b.queue })),
        ...(config.services ?? []).map(b => ({ name: b.binding, type: 'service', service: b.service })),
      ] };
      responses[`/workers/scripts/${config.name}/schedules`] = { schedules: (config.triggers?.crons ?? []).map(cron => ({ cron })) };
    }
    for (const fault of ['missing-producer', 'production-producer', 'delayed', 'healthy']) {
      const fixture = globalThis.structuredClone(responses);
      const bindings = fixture['/workers/scripts/intern-notifs-dev-admission/settings'].bindings;
      const producer = bindings.findIndex(b => b.name === 'ADMISSION_V2_QUEUE');
      if (fault === 'missing-producer') bindings.splice(producer, 1);
      if (fault === 'production-producer') bindings[producer].queue_name = 'intern-notifs-admission-v2';
      if (fault === 'delayed') fixture['/queues?per_page=100&page=1'][0].settings.delivery_delay = 86400;
      await writeFile(responsesFile, JSON.stringify(fixture));
      await db.batch([
        db.prepare('DELETE FROM ingestion_admission_handoffs WHERE source_id=?').bind(source),
        db.prepare('DELETE FROM ingestion_rows WHERE source_id=?').bind(source),
        db.prepare('DELETE FROM ingestion_snapshots WHERE source_id=?').bind(source),
        db.prepare("INSERT INTO ingestion_snapshots (source_id,snapshot_hash,object_key,admission_version,document_count,row_count,state,is_complete,baseline,created_at,activated_at) VALUES (?,?,?,?,1,1,'active',1,0,?,?)").bind(source, hash, `ingestion-v2/snapshots/${source}/${hash}.json`, policy, now, now),
        db.prepare("INSERT INTO ingestion_rows (source_id,external_id,snapshot_hash,material_hash,admission_version,state,first_observed_at,last_observed_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?,?)").bind(source, 'review-row', hash, 'b'.repeat(64), policy, now, now, now),
      ]);
      const verified = spawnSync(process.execPath, ['--import', join(root, 'test/fixtures/dev-profile-fetch.mjs'),
        '--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'scripts/verify-cloudflare-dev-profile.ts')], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: 'review-token',
          CLOUDFLARE_ACCOUNT_ID: 'review-account', DEV_PROFILE_TEST_RESPONSES: responsesFile },
      });
      const sends = [];
      if (verified.status === 0) await handler.fetch(scheduleRequest({ cron: '9-59/10 * * * *', scheduledTime: Date.now() }), {
        ...profile.vars, DB: db, ADMISSION_V2_QUEUE: { async sendBatch(messages) { sends.push(...messages); } },
      });
      const row = await db.prepare('SELECT state,attempt_count FROM ingestion_rows WHERE source_id=?').bind(source).first();
      const handoffs = await db.prepare('SELECT external_ids,acknowledged_at FROM ingestion_admission_handoffs WHERE source_id=?').bind(source).all();
      if (fault === 'healthy') {
        assert.equal(verified.status, 0, verified.stderr);
        assert.equal(sends.length, 1);
        assert.deepEqual(sends[0].body.externalIds, ['review-row']);
        assert.equal(row.state, 'queued');
        assert.equal(handoffs.results.length, 1);
        assert.equal(handoffs.results[0].acknowledged_at, null);
      } else {
        assert.equal(verified.status, 1, `${fault}: ${verified.stdout} ${verified.stderr}`);
        assert.match(verified.stderr, fault === 'delayed' ? /initial delivery delay/ : /ADMISSION_V2_QUEUE resource binding differs/);
        assert.deepEqual(row, { state: 'pending', attempt_count: 0 });
        assert.equal(sends.length, 0);
        assert.equal(handoffs.results.length, 0);
      }
    }
  } finally {
    await db.batch([
      db.prepare('DELETE FROM ingestion_admission_handoffs WHERE source_id=?').bind(source),
      db.prepare('DELETE FROM ingestion_rows WHERE source_id=?').bind(source),
      db.prepare('DELETE FROM ingestion_snapshots WHERE source_id=?').bind(source),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

test('disabled publisher does no database work and exposes no public operations', async () => {
  await worker.scheduled({ cron: '1-51/10 * * * *', scheduledTime: Date.now() }, {
    INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'false', DB: { prepare() { throw Error('unexpected read'); } },
  });
  assert.equal((await worker.fetch(scheduleRequest({ cron: '1,11,21,31,41,51 * * * *', scheduledTime: Date.now() }), { INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'false', DB: { prepare() { throw Error('unexpected read'); } } })).status, 404);
  assert.equal((await worker.fetch(new globalThis.Request('https://example.com/internal/operations'))).status, 404);
});

test('native legacy deliveries and delegated publication share a lease and converge without notifications', async () => {
  const event = { cron: '1-51/10 * * * *', scheduledTime: Date.now() };
  await Promise.all([worker.scheduled(event, env), scheduled('1,11,21,31,41,51 * * * *')]);
  await Promise.all([
    worker.scheduled({ ...event, cron: '4,14,24,34,44,54 * * * *' }, env),
    scheduled('5,15,25,35,45,55 * * * *'),
  ]);
  const pointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  const d1 = JSON.parse((await db.prepare("SELECT value FROM catalog_items WHERE pk='CATALOG_PROJECTION' AND sk='CURRENT'").first()).value);
  assert.equal(pointer.version, d1.version); assert.equal(pointer.count, 1);
  assert.equal(await db.prepare("SELECT count(*) n FROM system_state WHERE key='maintenance_lease:catalog_publisher'").first('n'), 0);
  assert.equal(await db.prepare("SELECT count(*) n FROM catalog_items WHERE kind='notification-event'").first('n'), 0);
});

test('a busy publisher lease does not advance completion markers', async () => {
  const before = await marker('catalog_projection');
  await db.prepare("INSERT INTO system_state(key,value,updated_at) VALUES('maintenance_lease:catalog_publisher',?,?)")
    .bind(JSON.stringify({ owner: 'busy-holder', expiresAt: Date.now() + 60_000 }), new Date().toISOString()).run();
  try {
    await worker.scheduled({ cron: '1-51/10 * * * *', scheduledTime: Date.now() }, env);
    await scheduled('1,11,21,31,41,51 * * * *');
    assert.deepEqual(await marker('catalog_projection'), before);
  } finally {
    await db.prepare("DELETE FROM system_state WHERE key='maintenance_lease:catalog_publisher'").run();
  }
});

test('publishes the matching D1 generation to real local R2 without notification events', async () => {
  await scheduled('1,11,21,31,41,51 * * * *');
  assert.equal(JSON.parse((await marker('catalog_projection')).value).status, 'complete');
  await scheduled('5,15,25,35,45,55 * * * *');
  const pointer = await bucket.get('public-catalog/v1/current'); assert.ok(pointer);
  const value = JSON.parse(await pointer.text()); assert.equal(value.count, 1);
  assert.equal(JSON.parse((await marker('catalog_projection_r2')).value).status, 'complete');
  const notifications = await db.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind='notification-event'").first();
  assert.equal(notifications.n, 0);
});

test('R2 failure invalidates the old pointer and does not advance the completion marker; retry recovers', async () => {
  const before = await marker('catalog_projection_r2');
  const failing = { ...env, DOCUMENTS: { get: bucket.get.bind(bucket), delete: bucket.delete.bind(bucket), async put(key, value, options) {
    if (key.endsWith('/current') && JSON.parse(new TextDecoder().decode(value)).schemaVersion === 0) return bucket.put(key, value, options);
    throw new Error('R2 unavailable');
  } } };
  await assert.rejects(runPublisher({ cron: '5,15,25,35,45,55 * * * *', scheduledTime: Date.now() }, failing), /R2 unavailable/);
  assert.equal(JSON.parse(await (await bucket.get('public-catalog/v1/current')).text()).schemaVersion, 0);
  assert.deepEqual(await marker('catalog_projection_r2'), before);
  await scheduled('5,15,25,35,45,55 * * * *');
  assert.ok(await bucket.get('public-catalog/v1/current'));
});

test('compiled publication defers an internal R2 page failure without claiming completion or retrying in the delivery', async () => {
  const cron = '5,15,25,35,45,55 * * * *';
  const before = await marker('catalog_projection_r2');
  await bucket.put('public-catalog/v1/current', JSON.stringify({ schemaVersion: 0, generatedAt: new Date().toISOString() }));
  let pageAttempts = 0;
  const failing = { ...env, DOCUMENTS: { get: bucket.get.bind(bucket), delete: bucket.delete.bind(bucket), async put(key, value, options) {
    if (!key.endsWith('/current')) { pageAttempts++; throw new Error('put: We encountered an internal error. Please try again. (10001)'); }
    return bucket.put(key, value, options);
  } } };
  const response = await worker.fetch(scheduleRequest({ cron, scheduledTime: Date.now() }), failing);
  assert.equal(response.status, 503); assert.equal(response.headers.get('Retry-After'), '600');
  assert.deepEqual(await response.json(), { completed: false, deferred: true, failureClass: 'r2-internal' });
  assert.equal(pageAttempts, 1); assert.deepEqual(await marker('catalog_projection_r2'), before);
  const failure = await db.prepare("SELECT value FROM system_state WHERE key='maintenance_phase:catalog_projection_r2:catalog_projection_r2'").first();
  assert.equal(JSON.parse(failure.value).status, 'failed');
  assert.equal(await db.prepare("SELECT count(*) n FROM system_state WHERE key='maintenance_lease:catalog_publisher'").first('n'), 0);
  assert.equal(JSON.parse(await (await bucket.get('public-catalog/v1/current')).text()).schemaVersion, 0);
  await runPublisher({ cron, scheduledTime: Date.now() + 600_000 }, env);
  assert.equal(JSON.parse(await (await bucket.get('public-catalog/v1/current')).text()).schemaVersion, 1);
  assert.equal(await db.prepare("SELECT count(*) n FROM catalog_items WHERE kind='notification-event'").first('n'), 0);
});

for (const committed of [false, true]) test(`compiled ingestion preserves staged pages when R2 activation acknowledgement fails (committed=${committed})`, async () => {
  const cron = '5,15,25,35,45,55 * * * *';
  const before = await marker('catalog_projection_r2');
  await bucket.put('public-catalog/v1/current', JSON.stringify({ schemaVersion: 0, generatedAt: new Date().toISOString() }));
  let activationAttempts = 0, attemptedPointer;
  const failing = { ...env, DOCUMENTS: { get: bucket.get.bind(bucket), delete: bucket.delete.bind(bucket), async put(key, value, options) {
    const payload = key.endsWith('/current') ? JSON.parse(new TextDecoder().decode(value)) : undefined;
    if (payload?.schemaVersion === 1) {
      activationAttempts++; attemptedPointer = payload;
      if (committed) await bucket.put(key, value, options);
      throw new Error('put: We encountered an internal error. Please try again. (10001)');
    }
    return bucket.put(key, value, options);
  } } };
  const ingestion = (await import('../../cloudflare/dist/ingestion/ingestion-worker.js')).default;
  const event = { cron, scheduledTime: Date.now() };
  await ingestion.scheduled(event, { ...failing, CATALOG_PUBLISHER: { fetch: request => worker.fetch(request, failing) } });
  assert.equal(activationAttempts, 1); assert.deepEqual(await marker('catalog_projection_r2'), before);
  for (let page = 0; page * 100 < attemptedPointer.count; page++) {
    assert.ok(await bucket.get(`public-catalog/v1/${attemptedPointer.pageVersion}/${page}`), 'uncertain activation pages must remain retained');
  }
  assert.equal(JSON.parse(await (await bucket.get('public-catalog/v1/current')).text()).schemaVersion, 0);
  await runPublisher({ cron, scheduledTime: Date.now() + 600_000 }, env);
  const recovered = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  const d1 = JSON.parse((await db.prepare("SELECT value FROM catalog_items WHERE pk='CATALOG_PROJECTION' AND sk='CURRENT'").first()).value);
  assert.equal(recovered.version, d1.version); assert.equal(recovered.schemaVersion, 1);
  assert.equal(await db.prepare("SELECT count(*) n FROM catalog_items WHERE kind='notification-event'").first('n'), 0);
});

test('compiled D1 refresh and native publication defer only the documented R2 internal failure', async () => {
  const cron = '1,11,21,31,41,51 * * * *';
  const before = await marker('catalog_projection');
  const failing = { ...env, DOCUMENTS: { get() { throw new Error('get: We encountered an internal error. Please try again. (10001)'); } } };
  const response = await worker.fetch(scheduleRequest({ cron, scheduledTime: Date.now() }), failing);
  assert.equal(response.status, 503); assert.equal(response.headers.get('Retry-After'), '600');
  assert.deepEqual(await marker('catalog_projection'), before);
  await worker.scheduled({ cron, scheduledTime: Date.now() }, failing);
  assert.deepEqual(await marker('catalog_projection'), before);
  await assert.rejects(worker.fetch(scheduleRequest({ cron, scheduledTime: Date.now() }), { ...env,
    DOCUMENTS: { get() { throw new Error('get: Precondition failed. (10031)'); } } }), /D1 catalog projection failed/);
  await runPublisher({ cron, scheduledTime: Date.now() + 600_000 }, env);
  await scheduled('5,15,25,35,45,55 * * * *');
  assert.equal(await db.prepare("SELECT count(*) n FROM catalog_items WHERE kind='notification-event'").first('n'), 0);
});

test('legacy scheduled expression repairs real R2 pages without double ownership or notifications', async () => {
  const old = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  await bucket.delete(`public-catalog/v1/${old.pageVersion ?? old.version}/0`);
  const scheduledTime = Date.now();
  await runPublisher({ cron: '4-54/10 * * * *', scheduledTime }, env);
  const pointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  assert.equal(pointer.schemaVersion, 1);
  assert.equal(pointer.version, old.version);
  assert.ok(await bucket.get(`public-catalog/v1/${pointer.pageVersion ?? pointer.version}/0`));
  assert.equal(JSON.parse((await marker('catalog_projection_r2')).value).observedAt, new Date(scheduledTime).toISOString());
  assert.equal((await worker.fetch(scheduleRequest({ cron: '4-54/10 * * * *', scheduledTime }), {
    INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'false', DB: { prepare() { throw Error('unexpected disabled publisher read'); } },
  })).status, 404);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind='notification-event'").first()).n, 0);
});

test('unchanged catalog cycles retire and repair missing or corrupt active pages', async () => {
  for (const fault of ['missing', 'malformed', 'changed']) {
    const pointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
    const pageKey = `public-catalog/v1/${pointer.pageVersion ?? pointer.version}/0`;
    const original = await (await bucket.get(pageKey)).text();
    if (fault === 'missing') await bucket.delete(pageKey);
    if (fault === 'malformed') await bucket.put(pageKey, '{');
    if (fault === 'changed') {
      const altered = JSON.parse(original);
      altered[0].roles[0].title = 'Corrupted title';
      await bucket.put(pageKey, JSON.stringify(altered));
    }
    await scheduled('1,11,21,31,41,51 * * * *');
    assert.equal(JSON.parse(await (await bucket.get('public-catalog/v1/current')).text()).schemaVersion, 0, `${fault} page must retire its pointer`);
    await scheduled('5,15,25,35,45,55 * * * *');
    const repaired = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
    assert.equal(repaired.version, pointer.version);
    assert.equal(await (await bucket.get(`public-catalog/v1/${repaired.pageVersion ?? repaired.version}/0`)).text(), original);
    assert.equal(JSON.parse((await marker('catalog_projection_r2')).value).status, 'complete');
  }
});

test('repairs a corrupt later page across a failed repair without exposing a partial multi-page catalog', async () => {
  const originalJob = JSON.parse((await db.prepare("SELECT value FROM catalog_items WHERE pk='JOB#isolated-role'").first()).value);
  await db.batch(Array.from({ length: 101 }, (_, index) => {
    const jobId = `multi-page-${index}`;
    const job = { ...originalJob, jobId, company: `Employer ${index}`, fingerprint: jobId,
      applyUrl: `https://example.com/${jobId}`, normalizedUrl: `https://example.com/${jobId}` };
    return db.prepare("INSERT INTO catalog_items(pk,sk,kind,value) VALUES (?,'INTERNSHIP','internship',?)")
      .bind(`JOB#${jobId}`, JSON.stringify(job));
  }));
  await scheduled('1,11,21,31,41,51 * * * *');
  await scheduled('5,15,25,35,45,55 * * * *');
  const pointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  assert.equal(pointer.count, 102);
  const keys = [0, 1].map(index => `public-catalog/v1/${pointer.pageVersion ?? pointer.version}/${index}`);
  const pages = await Promise.all(keys.map(async key => (await bucket.get(key)).text()));
  await bucket.put(keys[1], '[]');
  await scheduled('1,11,21,31,41,51 * * * *');
  assert.equal(JSON.parse(await (await bucket.get('public-catalog/v1/current')).text()).schemaVersion, 0);
  const completion = await marker('catalog_projection_r2');
  const failing = { ...env, DOCUMENTS: { get: bucket.get.bind(bucket), delete: bucket.delete.bind(bucket),
    async put(key, value) {
      if (/\/[a-f0-9]{20}\/1$/.test(key)) throw new Error('second page write failed');
      return bucket.put(key, value);
    } } };
  await assert.rejects(runPublisher({ cron: '5,15,25,35,45,55 * * * *', scheduledTime: Date.now() }, failing), /second page write failed/);
  assert.equal(JSON.parse(await (await bucket.get('public-catalog/v1/current')).text()).schemaVersion, 0);
  assert.deepEqual(await marker('catalog_projection_r2'), completion);
  await scheduled('5,15,25,35,45,55 * * * *');
  const repaired = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  assert.equal(repaired.version, pointer.version);
  for (let index = 0; index < keys.length; index++) assert.equal(await (await bucket.get(`public-catalog/v1/${repaired.pageVersion ?? repaired.version}/${index}`)).text(), pages[index]);
  const notifications = await db.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind='notification-event'").first();
  assert.equal(notifications.n, 0);
});

test('billing shutdown preserves the published catalog', async () => {
  await db.prepare("INSERT OR REPLACE INTO system_state(key,value,updated_at) VALUES ('billing_shutdown','stopped',?)").bind(new Date().toISOString()).run();
  const before = await marker('catalog_projection');
  await assert.rejects(scheduled('1,11,21,31,41,51 * * * *'), /503/); assert.deepEqual(await marker('catalog_projection'), before);
});

test('retains a healthy unchanged multi-page catalog across the D1 refresh', async () => {
  await db.prepare("DELETE FROM system_state WHERE key='billing_shutdown'").run();
  const before = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  await scheduled('1,11,21,31,41,51 * * * *');
  const after = await bucket.get('public-catalog/v1/current');
  assert.ok(after, 'unchanged healthy multi-page pointer must remain readable');
  assert.equal(JSON.parse(await after.text()).version, before.version);
});

test('a paused unchanged D1 renewal cannot resurrect a pointer after a newer closed-role generation publishes', async () => {
  await db.prepare("DELETE FROM catalog_items WHERE pk LIKE 'JOB#multi-page-%'").run();
  await scheduled('1,11,21,31,41,51 * * * *');
  await scheduled('5,15,25,35,45,55 * * * *');
  const oldPointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  let intercepted = false;
  const delayed = { ...env, DOCUMENTS: { put: bucket.put.bind(bucket), delete: bucket.delete.bind(bucket), async get(key) {
    const object = await bucket.get(key);
    if (/\/[^/]+\/\d+$/.test(key) && !intercepted) { intercepted = true; enter(); await released; }
    return object;
  } } };
  const staleRenewal = runPublisher({ cron: '1,11,21,31,41,51 * * * *', scheduledTime: Date.now() }, delayed);
  await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(Error('renewal did not reach a page read')), 5000))]);
  let freshPointer;
  try {
    const row = await db.prepare("SELECT value FROM catalog_items WHERE pk='JOB#isolated-role'").first();
    const job = JSON.parse(row.value); job.open = false;
    await db.prepare("UPDATE catalog_items SET value=? WHERE pk='JOB#isolated-role'").bind(JSON.stringify(job)).run();
    // Simulate an expired holder so the newer generation can proceed while the
    // old request remains paused. Its eventual release must preserve a new owner.
    await db.prepare("UPDATE system_state SET value=json_set(value,'$.expiresAt',0) WHERE key='maintenance_lease:catalog_publisher'").run();
    await scheduled('1,11,21,31,41,51 * * * *');
    await scheduled('5,15,25,35,45,55 * * * *');
    freshPointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
    assert.notEqual(freshPointer.version, oldPointer.version);
    await db.prepare("INSERT INTO system_state(key,value,updated_at) VALUES('maintenance_lease:catalog_publisher',?,?)")
      .bind(JSON.stringify({ owner: 'new-holder', expiresAt: Date.now() + 60_000 }), new Date().toISOString()).run();
    release(); await staleRenewal;
    const held = JSON.parse((await db.prepare("SELECT value FROM system_state WHERE key='maintenance_lease:catalog_publisher'").first()).value);
    assert.equal(held.owner, 'new-holder', 'an expired holder must not release its successor');
    const finalPointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
    assert.equal(finalPointer.version, freshPointer.version, 'stale renewal must not overwrite the newer published generation');
    const finalPage = JSON.parse(await (await bucket.get(`public-catalog/v1/${finalPointer.pageVersion ?? finalPointer.version}/0`)).text());
    assert.equal(finalPage[0].roles[0].open, false, 'the public projection must keep the role closed');
  } finally {
    release();
    try { await staleRenewal; } finally {
      await db.prepare("DELETE FROM system_state WHERE key='maintenance_lease:catalog_publisher'").run();
    }
  }
});


test('production-size D1 projection reaches real R2 without hydrating the whole catalog', async () => {
  const old = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  const template = JSON.parse(await (await bucket.get(`public-catalog/v1/${old.pageVersion ?? old.version}/0`)).text())[0];
  const hash = createHash('sha256'), keys = [], pending = [];
  const generatedAt = new Date().toISOString();
  let totalCardBytes = 0;
  for (let index = 0; index < 5059; index++) {
    const groupId = `scaled-group-${index}`, company = `Scaled Employer ${index}`;
    const role = { ...template.roles[0], jobId: `scaled-job-${index}`, company,
      compensation: { raw: `USD 30/hour; 開示された給与; ${index}; `.repeat(index < 100 ? 800 : 400) } };
    const group = { group: { ...template.group, groupId, company, featuredRole: role }, roles: [role] };
    const value = JSON.stringify(group), digest = createHash('sha256').update(value).digest('hex').slice(0, 20);
    totalCardBytes += Buffer.byteLength(value);
    const key = `GROUP#${groupId}#${digest}`;
    hash.update(value).update('\0'); keys.push(key);
    pending.push(db.prepare("INSERT INTO catalog_items(pk,sk,kind,value,catalog_sort_key) VALUES ('CATALOG_PROJECTION#GROUPS',?,'catalog-projection',?,?)")
      .bind(key, value, String(5059 - index).padStart(8, '0')));
    if (pending.length === 25) await db.batch(pending.splice(0));
  }
  if (pending.length) await db.batch(pending);
  const version = hash.digest('hex').slice(0, 20);
  await db.prepare("INSERT OR REPLACE INTO catalog_items(pk,sk,kind,value) VALUES ('CATALOG_PROJECTION#MANIFESTS',?,'catalog-projection-manifest',?)")
    .bind(version, JSON.stringify({ createdAt: generatedAt, keys })).run();
  await db.prepare("UPDATE catalog_items SET value=? WHERE pk='CATALOG_PROJECTION' AND sk='CURRENT'")
    .bind(JSON.stringify({ schemaVersion: 6, version, generatedAt, retainedVersions: [] })).run();
  let hydrated = 0, written = 0, maximumPending = 0, maximumPageBytes = 0;
  const boundedDb = { batch: db.batch.bind(db), prepare(sql) {
    const wrap = statement => new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...values) => wrap(target.bind(...values));
      if (key === 'all') return async (...args) => {
        const page = await target.all(...args);
        if (page.results[0]?.catalog_sort_key !== undefined) {
          hydrated += page.results.length;
          maximumPending = Math.max(maximumPending, hydrated - written);
          assert.ok(hydrated - written <= 100, 'full catalog retained before R2 publication');
        }
        return page;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return wrap(db.prepare(sql));
  } };
  const boundedBucket = { get: bucket.get.bind(bucket), delete: bucket.delete.bind(bucket), async put(key, value, options) {
    if (/\/[a-f0-9]{20}\/\d+$/.test(key)) {
      maximumPageBytes = Math.max(maximumPageBytes, value.byteLength);
      const page = JSON.parse(new TextDecoder().decode(value));
      assert.ok(page.length <= 100); written += page.length;
    }
    return bucket.put(key, value, options);
  } };
  await runPublisher({ cron: '4-54/10 * * * *', scheduledTime: Date.now() }, { ...env, DB: boundedDb, DOCUMENTS: boundedBucket });
  const pointer = JSON.parse(await (await bucket.get('public-catalog/v1/current')).text());
  assert.equal(pointer.version, version); assert.equal(pointer.count, 5059);
  assert.equal(hydrated, 5059); assert.equal(written, 5059); assert.equal(maximumPending, 100);
  assert.ok(totalCardBytes >= 128_000_000, 'fixture must match the live serialized catalog volume');
  assert.ok(maximumPageBytes > 4 * 1024 * 1024, 'fixture must cover valid production pages above 4 MiB');
  assert.ok(maximumPageBytes <= 8 * 1024 * 1024, 'page allocation must remain bounded');
  for (const [index, expected] of [[0, 100], [50, 59]]) {
    assert.equal(JSON.parse(await (await bucket.get(`public-catalog/v1/${pointer.pageVersion ?? pointer.version}/${index}`)).text()).length, expected);
  }
  assert.equal(JSON.parse((await marker('catalog_projection_r2')).value).status, 'complete');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM catalog_items WHERE kind='notification-event'").first()).n, 0);
});
