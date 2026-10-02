import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { register } from 'node:module';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

register('./wasm-module-loader.mjs', import.meta.url);

const { Response } = globalThis;
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const ingestionWorkerName = 'intern-notifs-e2e-v2-ingestion';
const internalServiceSecret = 'e2e-internal-service-secret';
const operationsSecret = 'e2e-operations-secret';
const localCompatibilityDate = '2026-08-27';

let runtime;
let ingestion;
let database;
let documentsBucket;

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

// The reviewed source the worker resolves by id: vanshb03/Summer2027-Internships.
const sourceId = 'vanshb03-summer-2027';
const sourceDocuments = [
  { path: 'README.md', branch: 'dev', season: 'summer-2027', rows: 24 },
  { path: 'OFFSEASON_README.md', branch: 'dev', season: 'offseason-2027', rows: 8 },
];

// Curated sources require at least two application hosts with no single host
// above the concentration ceiling, so rows alternate across two hosts.
const applicationHosts = ['careers-a.example.test', 'careers-b.example.test'];
const applyUrl = (index) => `https://${applicationHosts[index % applicationHosts.length]}/board/role-${index}`;

function markdownTable(rows) {
  const header = '| Company | Position | Location | Posting | Salary |\n| --- | --- | --- | --- | --- |\n';
  return header + Array.from({ length: rows }, (_, index) => {
    return `| Acme ${index} | Software Engineering Intern ${index} | Remote | [Apply](${applyUrl(index)}) | $50/hr |`;
  }).join('\n') + '\n';
}

const documentBodies = new Map(sourceDocuments.map((document) => [
  `https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/${document.branch}/${document.path}`,
  markdownTable(document.rows),
]));
const boardRows = sourceDocuments.reduce((total, document) => total + document.rows, 0);

const originalFetch = globalThis.fetch;

before(async () => {
  const bundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');
  runtime = new Miniflare({
    workers: [
      await createWorkerConfig(ingestionWorkerName, bundleDirectory, 'ingestion-worker.js', {
        INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
        OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
        DEPLOYMENT_ROLE: { type: 'text', value: 'ingestion' },
        INGESTION_V2_SHADOW_DISCOVERY_ENABLED: { type: 'text', value: 'true' },
        DB: { type: 'd1', id: 'intern-notifs-e2e-v2' },
        DOCUMENTS: { type: 'r2', name: 'intern-notifs-e2e-v2-documents' },
        GITHUB_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-v2-github' },
        GITHUB_DLQ: { type: 'queue', name: 'intern-notifs-e2e-v2-github-dlq' },
        DESTINATION_VERIFICATION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-v2-destination-verification' },
        DESTINATION_VERIFICATION_DLQ: { type: 'queue', name: 'intern-notifs-e2e-v2-destination-verification-dlq' },
      }),
    ],
  });
  await runtime.ready;
  database = await runtime.getD1Database('DB', ingestionWorkerName);
  documentsBucket = await runtime.getR2Bucket('DOCUMENTS', ingestionWorkerName);
  await applyMigrations(database);
  ingestion = await runtime.getWorker(ingestionWorkerName);
});

after(async () => {
  globalThis.fetch = originalFetch;
  await runtime?.dispose();
});

function employerPage() {
  return '<!doctype html><html><head><title>Software Engineering Intern</title>'
    + '<meta name="description" content="Software engineering internship."></head><body><main>'
    + `<h1>Software Engineering Intern</h1><p>${'Build internship tooling with a mentor. '.repeat(8)}</p>`
    + '<h2>Requirements</h2><p>Current enrollment in a computer science program.</p></main></body></html>';
}

function installFetchStub() {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const { hostname } = new URL(url);
    if (hostname === 'raw.githubusercontent.com') return new Response(documentBodies.get(url) ?? '', { status: 200 });
    if (hostname.endsWith('.example.test')) {
      return init?.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        : new Response(employerPage(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    throw new Error(`unexpected provider request ${url}`);
  };
}

function recorder() {
  return { sent: [], async send(message) { this.sent.push(message); } };
}

function deliver(body) {
  const queues = { github: recorder(), destinationVerification: recorder() };
  const deadLetters = { github: recorder(), destinationVerification: recorder() };
  const settled = { ack: 0, retries: [] };
  const environment = {
    DB: database,
    DOCUMENTS: documentsBucket,
    GITHUB_QUEUE: queues.github,
    GITHUB_DLQ: deadLetters.github,
    DESTINATION_VERIFICATION_QUEUE: queues.destinationVerification,
    DESTINATION_VERIFICATION_DLQ: deadLetters.destinationVerification,
    INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true',
    IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'false',
    TRUSTED_COMMUNITY_CATALOG_ENABLED: 'false',
    PUBLIC_API_URL: 'https://api.example.test',
  };
  return (async () => {
    const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
    await builtWorker.queue({
      queue: 'intern-notifs-github',
      messages: [{
        id: `v2-delivery-${Date.now()}`,
        body,
        attempts: 1,
        timestamp: new Date('2026-10-01T00:00:00.000Z'),
        ack() { settled.ack += 1; },
        retry(options, error) { settled.retries.push({ options, error: error instanceof Error ? error.message : error }); },
      }],
    }, environment);
    return { settled, queues };
  })();
}

test('runs V2 shadow discovery for a reviewable source without enqueuing admission work', async () => {
  installFetchStub();
  const first = await deliver({ sourceId });
  assert.equal(first.settled.ack, 1, JSON.stringify(first.settled.retries));

  const snapshots = await database.prepare(
    'SELECT snapshot_hash, object_key, row_count, state, is_complete FROM ingestion_snapshots WHERE source_id = ?',
  ).bind(sourceId).all();
  assert.equal(snapshots.results.length, 1, 'the complete board must persist exactly one snapshot');
  const snapshot = snapshots.results[0];
  assert.equal(snapshot.is_complete, 1);
  assert.match(snapshot.object_key, /^ingestion-v2\/snapshots\/vanshb03-summer-2027\/[a-f0-9]{64}\.json$/u);
  assert.equal(snapshot.row_count, boardRows);

  const object = await documentsBucket.get(snapshot.object_key);
  assert.ok(object, 'the content-addressed snapshot object must exist in R2');

  const rows = await database.prepare(
    'SELECT COUNT(*) AS count FROM ingestion_rows WHERE source_id = ?',
  ).bind(sourceId).first();
  assert.equal(rows.count, boardRows);

  // Shadow mode sends no admission message: the recorded provider sends carry no
  // batch identity or snapshot hash.
  const sent = [...first.queues.github.sent, ...first.queues.destinationVerification.sent];
  assert.equal(sent.some((message) => JSON.stringify(message).includes('snapshotHash')), false);

  const comparison = await database.prepare(
    'SELECT metrics_json FROM ingestion_v2_shadow_comparisons WHERE source_id = ?',
  ).bind(sourceId).first();
  assert.ok(comparison, 'a shadow comparison is recorded');
  const metrics = JSON.parse(comparison.metrics_json);
  assert.equal(metrics.complete, true);
  assert.equal(metrics.counts.total, boardRows);
});

test('repeats the delivery with identical durable state', async () => {
  installFetchStub();
  const before = await database.prepare('SELECT COUNT(*) AS count FROM ingestion_snapshots WHERE source_id = ?').bind(sourceId).first();
  const beforeRows = await database.prepare('SELECT COUNT(*) AS count FROM ingestion_rows WHERE source_id = ?').bind(sourceId).first();

  const second = await deliver({ sourceId });
  assert.equal(second.settled.ack, 1, JSON.stringify(second.settled.retries));

  const after = await database.prepare('SELECT COUNT(*) AS count FROM ingestion_snapshots WHERE source_id = ?').bind(sourceId).first();
  const afterRows = await database.prepare('SELECT COUNT(*) AS count FROM ingestion_rows WHERE source_id = ?').bind(sourceId).first();
  assert.equal(after.count, before.count, 'a repeated delivery must not create a second snapshot row');
  assert.equal(afterRows.count, beforeRows.count, 'a repeated delivery must not duplicate ledger rows');

  const comparison = await database.prepare(
    'SELECT run_count FROM ingestion_v2_shadow_comparisons WHERE source_id = ?',
  ).bind(sourceId).first();
  assert.equal(comparison.run_count, 2);
});

test('serves shadow counts only to the authenticated operations caller', async () => {
  const denied = await ingestion.fetch('https://ingestion.example.test/internal/operations/ingestion-v2', {
    headers: { 'X-InternNotifs-Service-Key': internalServiceSecret },
  });
  assert.equal(denied.status, 404);

  const allowed = await ingestion.fetch('https://ingestion.example.test/internal/operations/ingestion-v2?sourceId=' + sourceId, {
    headers: { 'X-InternNotifs-Service-Key': internalServiceSecret, 'X-Operations-Key': operationsSecret },
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.sourceId, sourceId);
  assert.equal(body.comparison.sourceId, sourceId);
  assert.equal(body.comparison.counts.total, boardRows);
});
