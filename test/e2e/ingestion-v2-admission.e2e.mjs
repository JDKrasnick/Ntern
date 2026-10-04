import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const ingestionWorkerName = 'intern-notifs-e2e-admission-ingestion';
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

const sourceId = 'vanshb03-summer-2027';
const sourceDocuments = [
  { path: 'README.md', branch: 'dev', season: 'summer-2027', rows: 4 },
];
const applicationHosts = ['careers-a.example.test', 'careers-b.example.test'];
const applyUrl = (index) => index === 4
  ? 'https://job-boards.greenhouse.io/acme/jobs/1004'
  : `https://${applicationHosts[index % applicationHosts.length]}/board/role-${index}`;

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

const destinationStatus = new Map();
const originalFetch = globalThis.fetch;

function employerPage() {
  return '<!doctype html><html><head><title>Software Engineering Intern</title>'
    + '<meta name="description" content="Software engineering internship."></head><body><main>'
    + `<h1>Software Engineering Intern</h1><p>${'Build internship tooling with a mentor. '.repeat(8)}</p>`
    + '<h2>Requirements</h2><p>Current enrollment in a computer science program.</p></main></body></html>';
}

function installFetchStub() {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    const { hostname } = parsed;
    if (hostname === 'raw.githubusercontent.com') return new Response(documentBodies.get(url) ?? '', { status: 200 });
    if (hostname === 'cloudflare-dns.com') {
      // The admission prober resolves every destination host over DoH before it
      // fetches, so answer A queries with a public address and AAAA emptily.
      const type = parsed.searchParams.get('type');
      const answers = type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [];
      return new Response(JSON.stringify({ Answer: answers }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (hostname.endsWith('.example.test') || hostname === 'job-boards.greenhouse.io') {
      const status = destinationStatus.get(hostname) ?? 200;
      if (init?.method === 'HEAD') return new Response(null, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      return new Response(status >= 400 ? 'error' : employerPage(), { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    throw new Error(`unexpected provider request ${url}`);
  };
}

function recorder() {
  return { sent: [], async send(message) { this.sent.push(message); } };
}

async function deliverGithub(overrides = {}, messageOverrides = {}) {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  const queues = { github: recorder(), destinationVerification: recorder(), admission: recorder() };
  const settled = { ack: 0, retries: [] };
  const environment = {
    DB: database, DOCUMENTS: documentsBucket,
    GITHUB_QUEUE: queues.github, GITHUB_DLQ: recorder(),
    DESTINATION_VERIFICATION_QUEUE: queues.destinationVerification, DESTINATION_VERIFICATION_DLQ: recorder(),
    ADMISSION_V2_QUEUE: queues.admission, ADMISSION_V2_DLQ: recorder(),
    INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true',
    INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: '',
    INGESTION_V2_ADMISSION_ENABLED: 'true',
    INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: '',
    INGESTION_V2_CATALOG_WRITER_ENABLED: 'false',
    INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: '',
    INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: '',
    INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST: '',
    IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'false',
    TRUSTED_COMMUNITY_CATALOG_ENABLED: 'false',
    PUBLIC_API_URL: 'https://api.example.test',
    ...overrides,
  };
  await builtWorker.queue({
    queue: 'intern-notifs-github',
    messages: [{ id: `v2-board-${Date.now()}`, body: { sourceId, ...messageOverrides }, attempts: 1, timestamp: new Date(), ack() { settled.ack += 1; }, retry(options, error) { settled.retries.push({ options, error: String(error) }); } }],
  }, environment);
  return settled;
}

function admissionBatchId(snapshotHash, admissionVersion, externalIds, baseline = false) {
  const ordered = [...new Set(externalIds)].sort();
  return createHash('sha256').update(['admission-v2', sourceId, snapshotHash, admissionVersion, baseline ? 'baseline' : 'incremental', ordered.join(',')].join('|')).digest('hex');
}

function buildMessages(rows, snapshotHash, admissionVersion, baseline = false) {
  const ordered = rows.map((row) => row.external_id).sort();
  const messages = [];
  for (let offset = 0; offset < ordered.length; offset += 25) {
    const externalIds = ordered.slice(offset, offset + 25);
    messages.push({
      version: 1,
      batchId: admissionBatchId(snapshotHash, admissionVersion, externalIds, baseline),
      sourceId,
      snapshotHash,
      snapshotKey: `ingestion-v2/snapshots/${sourceId}/${snapshotHash}.json`,
      admissionVersion,
      externalIds,
      baseline,
    });
  }
  return messages;
}

async function deliverAdmission(messages, overrides = {}) {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  // Mirror the dispatcher's durable handoff receipt, which is recorded before
  // the message is sent and acknowledged by the consumer after all rows settle.
  for (const body of messages) {
    await database.prepare(`
      INSERT OR IGNORE INTO ingestion_admission_handoffs
        (batch_id, source_id, snapshot_hash, admission_version, baseline, external_ids, dispatched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(body.batchId, body.sourceId, body.snapshotHash, body.admissionVersion, body.baseline ? 1 : 0, JSON.stringify(body.externalIds), new Date().toISOString()).run();
  }
  const deadLetter = recorder();
  const settled = { ack: 0, retries: [] };
  const environment = {
    DB: database, DOCUMENTS: documentsBucket,
    ADMISSION_V2_QUEUE: recorder(), ADMISSION_V2_DLQ: deadLetter,
    GITHUB_QUEUE: recorder(), GITHUB_DLQ: recorder(),
    DESTINATION_VERIFICATION_QUEUE: recorder(), DESTINATION_VERIFICATION_DLQ: recorder(),
    INGESTION_V2_ADMISSION_ENABLED: 'true',
    INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: '',
    ...overrides,
  };
  await builtWorker.queue({
    queue: 'intern-notifs-admission-v2',
    messages: messages.map((body, index) => ({
      id: `v2-admission-${index}-${Date.now()}`,
      body, attempts: 1, timestamp: new Date(),
      ack() { settled.ack += 1; },
      retry(options, error) { settled.retries.push({ options, error: String(error) }); },
    })),
  }, environment);
  return { settled, deadLetter };
}

async function boardSnapshot() {
  const snapshot = await database.prepare(
    'SELECT snapshot_hash, admission_version FROM ingestion_snapshots WHERE source_id = ? AND state = ?',
  ).bind(sourceId, 'active').first();
  const rows = await database.prepare(
    'SELECT external_id, state FROM ingestion_rows WHERE source_id = ? ORDER BY external_id',
  ).bind(sourceId).all();
  return { snapshot, rows: rows.results };
}

async function setRowsState(state) {
  await database.prepare('UPDATE ingestion_rows SET state = ?, retry_at = NULL, decision = NULL WHERE source_id = ?').bind(state, sourceId).run();
}

async function makeRetriesDue() {
  await database.prepare('UPDATE ingestion_rows SET retry_at = ? WHERE source_id = ? AND state = ?')
    .bind('2000-01-01T00:00:00.000Z', sourceId, 'queued').run();
}

before(async () => {
  const bundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');
  runtime = new Miniflare({
    workers: [
      await createWorkerConfig(ingestionWorkerName, bundleDirectory, 'ingestion-worker.js', {
        INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
        OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
        DEPLOYMENT_ROLE: { type: 'text', value: 'ingestion' },
        INGESTION_V2_SHADOW_DISCOVERY_ENABLED: { type: 'text', value: 'true' },
        INGESTION_V2_ADMISSION_ENABLED: { type: 'text', value: 'true' },
        DB: { type: 'd1', id: 'intern-notifs-e2e-admission' },
        DOCUMENTS: { type: 'r2', name: 'intern-notifs-e2e-admission-documents' },
        GITHUB_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-admission-github' },
        GITHUB_DLQ: { type: 'queue', name: 'intern-notifs-e2e-admission-github-dlq' },
        ADMISSION_V2_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-admission-v2' },
        ADMISSION_V2_DLQ: { type: 'queue', name: 'intern-notifs-e2e-admission-v2-dlq' },
        DESTINATION_VERIFICATION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-admission-destination-verification' },
        DESTINATION_VERIFICATION_DLQ: { type: 'queue', name: 'intern-notifs-e2e-admission-destination-verification-dlq' },
      }),
    ],
  });
  await runtime.ready;
  database = await runtime.getD1Database('DB', ingestionWorkerName);
  documentsBucket = await runtime.getR2Bucket('DOCUMENTS', ingestionWorkerName);
  await applyMigrations(database);
  const reviewedAt = '2026-10-03T00:00:00.000Z';
  await database.batch([
    database.prepare(`INSERT INTO canonical_employers
      (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind('acme', 'Acme', reviewedAt, 'e2e', reviewedAt, reviewedAt),
    database.prepare(`INSERT INTO employer_mappings
      (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind('e2e-greenhouse-acme', 'greenhouse', 'acme', 'acme', reviewedAt, 'e2e', reviewedAt),
  ]);
  ingestion = await runtime.getWorker(ingestionWorkerName);
  installFetchStub();
  const seeded = await deliverGithub();
  assert.equal(seeded.ack, 1, JSON.stringify(seeded.retries));
  // Admission only dispatches pending/queued work; shadow discovery settled the
  // rows, so the canary marks them pending before delivering an admission message.
  await setRowsState('pending');
});

after(async () => {
  globalThis.fetch = originalFetch;
  await runtime?.dispose();
});

test('drains a queued delivery without evaluating rows when admission is disabled', async () => {
  const { snapshot, rows } = await boardSnapshot();
  const before = await database.prepare('SELECT external_id, state, attempt_count FROM ingestion_rows WHERE source_id = ? ORDER BY external_id')
    .bind(sourceId).all();
  const messages = buildMessages(rows, snapshot.snapshot_hash, snapshot.admission_version);
  const delivery = await deliverAdmission(messages, { INGESTION_V2_ADMISSION_ENABLED: 'false' });
  assert.equal(delivery.settled.ack, messages.length);
  assert.deepEqual(delivery.settled.retries, []);
  const afterRows = await database.prepare('SELECT external_id, state, attempt_count FROM ingestion_rows WHERE source_id = ? ORDER BY external_id')
    .bind(sourceId).all();
  assert.deepEqual(afterRows.results, before.results, 'disabled admission must not lease or evaluate a row');
  const activeHandoffs = await database.prepare('SELECT COUNT(*) AS count FROM ingestion_admission_handoffs WHERE source_id = ? AND acknowledged_at IS NULL')
    .bind(sourceId).first();
  assert.equal(activeHandoffs.count, 0, 'disabled draining must not suppress redispatch after re-enable');
});

test('settles a complete board through the queue and acknowledges the handoff', async () => {
  const { snapshot, rows } = await boardSnapshot();
  assert.equal(rows.length, boardRows);
  destinationStatus.clear();
  const delivery = await deliverAdmission(buildMessages(rows, snapshot.snapshot_hash, snapshot.admission_version));
  assert.equal(delivery.settled.ack, 1, JSON.stringify(delivery.settled.retries));

  const settled = await database.prepare('SELECT COUNT(*) AS count FROM ingestion_rows WHERE source_id = ? AND state = ?')
    .bind(sourceId, 'settled').first();
  assert.equal(settled.count, boardRows, 'every row must settle independently');
  const handoffs = await database.prepare('SELECT COUNT(*) AS count FROM ingestion_admission_handoffs WHERE source_id = ? AND acknowledged_at IS NOT NULL')
    .bind(sourceId).first();
  assert.equal(handoffs.count, 1, 'the handoff receipt must be acknowledged');
  const canaryReceipts = await database.prepare(
    'SELECT COUNT(*) AS count, COALESCE(SUM(notify), 0) AS notifications FROM ingestion_v2_admission_decisions WHERE source_id = ?',
  ).bind(sourceId).first();
  const admitted = await database.prepare("SELECT COUNT(*) AS count FROM ingestion_rows WHERE source_id = ? AND decision = 'admitted'")
    .bind(sourceId).first();
  assert.equal(canaryReceipts.count, admitted.count, 'every admitted row must have one durable non-publishing canary receipt');
  assert.ok(canaryReceipts.notifications >= 0);
});

test('treats a duplicate admission delivery as a no-op', async () => {
  const before = await database.prepare('SELECT attempt_count, state FROM ingestion_rows WHERE source_id = ? ORDER BY external_id').bind(sourceId).all();
  const { snapshot, rows } = await boardSnapshot();
  const delivery = await deliverAdmission(buildMessages(rows, snapshot.snapshot_hash, snapshot.admission_version));
  assert.equal(delivery.settled.ack, 1);
  const after = await database.prepare('SELECT attempt_count, state FROM ingestion_rows WHERE source_id = ? ORDER BY external_id').bind(sourceId).all();
  assert.deepEqual(after.results, before.results, 'a duplicate delivery must not rewrite settled rows');
});

test('quarantines only the permanently failing row after two retries', async () => {
  await setRowsState('pending');
  destinationStatus.set('careers-b.example.test', 503);
  const { snapshot, rows } = await boardSnapshot();
  const messages = buildMessages(rows, snapshot.snapshot_hash, snapshot.admission_version);

  await deliverAdmission(messages);
  await makeRetriesDue();
  await deliverAdmission(messages);
  await makeRetriesDue();
  await deliverAdmission(messages);

  const counts = await database.prepare('SELECT state, COUNT(*) AS count FROM ingestion_rows WHERE source_id = ? GROUP BY state').bind(sourceId).all();
  const byState = Object.fromEntries(counts.results.map((row) => [row.state, row.count]));
  assert.ok(byState.quarantined >= 1, JSON.stringify(byState));
  assert.ok(byState.settled >= 1, JSON.stringify(byState));
  const quarantined = await database.prepare('SELECT attempt_count, failure_class FROM ingestion_rows WHERE source_id = ? AND state = ? LIMIT 1')
    .bind(sourceId, 'quarantined').first();
  assert.equal(quarantined.attempt_count, 3);
  assert.equal(quarantined.failure_class, 'upstream-server-error');
  destinationStatus.clear();
});

test('a transient destination can fail twice and settle on its third attempt', async () => {
  await database.prepare(`UPDATE ingestion_rows SET state = 'pending', attempt_count = 0, retry_at = NULL,
    decision = NULL, failure_class = NULL, failure_detail = NULL WHERE source_id = ?`).bind(sourceId).run();
  destinationStatus.set('careers-b.example.test', 503);
  const { snapshot, rows } = await boardSnapshot();
  const messages = buildMessages(rows, snapshot.snapshot_hash, snapshot.admission_version);
  await deliverAdmission(messages);
  await makeRetriesDue();
  await deliverAdmission(messages);
  await makeRetriesDue();
  destinationStatus.clear();
  const recovered = await deliverAdmission(messages);
  assert.equal(recovered.settled.ack, messages.length);
  const failedRows = await database.prepare('SELECT COUNT(*) AS count FROM ingestion_rows WHERE source_id = ? AND state <> ?')
    .bind(sourceId, 'settled').first();
  assert.equal(failedRows.count, 0);
  const recoveredAttempts = await database.prepare('SELECT MIN(attempt_count) AS minimum, MAX(attempt_count) AS maximum FROM ingestion_rows WHERE source_id = ?')
    .bind(sourceId).first();
  assert.ok(recoveredAttempts.maximum >= 3, JSON.stringify(recoveredAttempts));
});

test('a missing snapshot retries systemically and leaves a durable failure record', async () => {
  const { snapshot, rows } = await boardSnapshot();
  const missingHash = 'f'.repeat(64);
  const [message] = buildMessages(rows, missingHash, snapshot.admission_version);
  const delivered = await deliverAdmission([message]);
  assert.equal(delivered.settled.ack, 0);
  assert.equal(delivered.settled.retries.length, 1);
  const failure = await database.prepare(`SELECT source_id, resolved_at FROM queue_failure_events
    WHERE queue_name = 'intern-notifs-admission-v2' ORDER BY last_failed_at DESC LIMIT 1`).first();
  assert.equal(failure.source_id, sourceId);
  assert.equal(failure.resolved_at, null);
});

test('returns a stale delivery as a no-op', async () => {
  const { snapshot, rows } = await boardSnapshot();
  // Advance one row's material hash so the original message intent no longer matches.
  await database.prepare('UPDATE ingestion_rows SET material_hash = ?, state = ? WHERE source_id = ? AND external_id = ?')
    .bind('advanced-material', 'pending', sourceId, rows[0].external_id).run();
  const delivery = await deliverAdmission(buildMessages(rows, snapshot.snapshot_hash, snapshot.admission_version));
  assert.equal(delivery.settled.ack, 1);
  const row = await database.prepare('SELECT state FROM ingestion_rows WHERE source_id = ? AND external_id = ?').bind(sourceId, rows[0].external_id).first();
  assert.equal(row.state, 'pending', 'a stale message must not process the advanced row');
});

test('guards row inspection and replay behind the operations boundary', async () => {
  await database.prepare(`UPDATE ingestion_rows SET state = 'quarantined', attempt_count = 3,
    failure_class = 'upstream-server-error', failure_detail = '503'
    WHERE source_id = ? AND external_id = (SELECT external_id FROM ingestion_rows WHERE source_id = ? ORDER BY external_id LIMIT 1)`)
    .bind(sourceId, sourceId).run();
  const denied = await ingestion.fetch(`https://ingestion.example.test/internal/operations/ingestion/rows?sourceId=${sourceId}`, {
    headers: { 'X-InternNotifs-Service-Key': internalServiceSecret },
  });
  assert.equal(denied.status, 404);

  const allowed = await ingestion.fetch(`https://ingestion.example.test/internal/operations/ingestion/rows?sourceId=${sourceId}`, {
    headers: { 'X-InternNotifs-Service-Key': internalServiceSecret, 'X-Operations-Key': operationsSecret },
  });
  assert.equal(allowed.status, 200);
  const page = await allowed.json();
  assert.equal(page.overview.sourceId, sourceId);
  assert.ok(page.overview.quarantined >= 1);
  assert.ok(Array.isArray(page.rows));

  const target = await database.prepare('SELECT external_id FROM ingestion_rows WHERE source_id = ? AND state = ? LIMIT 1')
    .bind(sourceId, 'quarantined').first();
  const previewResponse = await ingestion.fetch('https://ingestion.example.test/internal/operations/ingestion/rows/replay', {
    method: 'POST',
    headers: { 'X-InternNotifs-Service-Key': internalServiceSecret, 'X-Operations-Key': operationsSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, externalId: target.external_id }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.eligible, true);

  const applyResponse = await ingestion.fetch('https://ingestion.example.test/internal/operations/ingestion/rows/replay', {
    method: 'POST',
    headers: { 'X-InternNotifs-Service-Key': internalServiceSecret, 'X-Operations-Key': operationsSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, externalId: target.external_id, replayToken: preview.replayToken }),
  });
  assert.equal(applyResponse.status, 200);
  const applied = await applyResponse.json();
  assert.equal(applied.applied, true);
  const reopened = await database.prepare('SELECT state FROM ingestion_rows WHERE source_id = ? AND external_id = ?').bind(sourceId, target.external_id).first();
  assert.equal(reopened.state, 'queued');

  await database.prepare(`INSERT INTO ingestion_rows
    (source_id, external_id, snapshot_hash, material_hash, admission_version, state, attempt_count,
     consecutive_omissions, first_observed_at, last_observed_at, updated_at)
    SELECT source_id, 'ghost-not-in-snapshot', snapshot_hash, material_hash, admission_version, 'quarantined', 3,
      0, first_observed_at, last_observed_at, updated_at
    FROM ingestion_rows WHERE source_id = ? LIMIT 1`).bind(sourceId).run();
  const ghostResponse = await ingestion.fetch('https://ingestion.example.test/internal/operations/ingestion/rows/replay', {
    method: 'POST',
    headers: { 'X-InternNotifs-Service-Key': internalServiceSecret, 'X-Operations-Key': operationsSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, externalId: 'ghost-not-in-snapshot' }),
  });
  assert.equal(ghostResponse.status, 200);
  const ghost = await ghostResponse.json();
  assert.equal(ghost.eligible, false);
  assert.equal(ghost.reason, 'row-not-in-retained-snapshot');
});

test('rehearses guarded bootstrap, live publication, closure, rollback, and re-enable', async () => {
  const ownershipOverrides = {
    INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true',
    INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: sourceId,
    INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: sourceId,
    INGESTION_V2_CATALOG_WRITER_ENABLED: 'true',
    INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: sourceId,
    INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: sourceId,
    INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST: sourceId,
  };
  // Repair state intentionally dirtied by the preceding boundary probes, then
  // take a fresh complete snapshot before planning the guarded bootstrap.
  await database.prepare('DELETE FROM ingestion_rows WHERE source_id = ? AND external_id = ?')
    .bind(sourceId, 'ghost-not-in-snapshot').run();
  documentBodies.set(
    `https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md`,
    markdownTable(4),
  );
  const refreshed = await deliverGithub();
  assert.equal(refreshed.ack, 1, JSON.stringify(refreshed.retries));
  await database.prepare(`UPDATE ingestion_rows SET state = 'settled', lease_owner = NULL, lease_expires_at = NULL
    WHERE source_id = ? AND state IN ('queued', 'processing')`).bind(sourceId).run();

  const healthRow = await database.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'HEALTH'")
    .bind(`SOURCE#${sourceId}`).first();
  const health = JSON.parse(healthRow.value);
  await database.prepare("UPDATE catalog_items SET value = ? WHERE pk = ? AND sk = 'HEALTH'")
    .bind(JSON.stringify({ ...health, sourceStatus: 'paused', configVersion: (health.configVersion ?? 0) + 1 }), `SOURCE#${sourceId}`).run();

  // A cutover recovery runs with the final source-scoped policy while the
  // source remains paused. This makes the bootstrap receipt bind to the same
  // evaluator version that will own live catalog writes after resume.
  const recovered = await deliverGithub(ownershipOverrides, { force: true });
  assert.equal(recovered.ack, 1, JSON.stringify(recovered.retries));
  await database.prepare(`UPDATE ingestion_rows SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL
    WHERE source_id = ? AND state IN ('queued', 'processing')`).bind(sourceId).run();

  const headers = {
    'X-InternNotifs-Service-Key': internalServiceSecret,
    'X-Operations-Key': operationsSecret,
    'Content-Type': 'application/json',
  };
  const previewResponse = await ingestion.fetch('https://ingestion.example.test/internal/operations/ingestion/bootstrap', {
    method: 'POST', headers, body: JSON.stringify({ sourceId }),
  });
  const previewText = await previewResponse.text();
  assert.equal(previewResponse.status, 200, previewText);
  const preview = JSON.parse(previewText);
  assert.equal(preview.sourceStatus, 'paused');
  assert.equal(preview.activeRows, 4);
  assert.equal(preview.actionableRows, 4);
  assert.equal(preview.expectedNotifications, 0);

  const applyResponse = await ingestion.fetch('https://ingestion.example.test/internal/operations/ingestion/bootstrap', {
    method: 'POST', headers, body: JSON.stringify({
      sourceId, apply: true, repairToken: preview.repairToken,
      expectedActive: preview.activeRows, expectedActionable: preview.actionableRows,
    }),
  });
  const applyText = await applyResponse.text();
  assert.equal(applyResponse.status, 200, applyText);
  const receipt = JSON.parse(applyText);
  assert.equal(receipt.expectedNotifications, 0);
  const notificationBaseline = await database.prepare(
    'SELECT COUNT(*) AS count FROM ingestion_rows WHERE source_id = ? AND state = ? AND notification_baseline = 1',
  ).bind(sourceId, 'pending').first();
  assert.equal(notificationBaseline.count, 4);

  const notificationsBeforeBaseline = await database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'notification-event'").first();
  let current = await boardSnapshot();
  const baselineDelivery = await deliverAdmission(
    buildMessages(current.rows, current.snapshot.snapshot_hash, current.snapshot.admission_version, true),
    {
      ...ownershipOverrides,
      TRUSTED_COMMUNITY_CATALOG_ENABLED: 'true',
    },
  );
  assert.equal(baselineDelivery.settled.ack, 1, JSON.stringify(baselineDelivery.settled.retries));
  const notificationsAfterBaseline = await database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'notification-event'").first();
  assert.equal(notificationsAfterBaseline.count, notificationsBeforeBaseline.count, 'bootstrap baseline must stay silent');
  const pausedHealthRow = await database.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'HEALTH'")
    .bind(`SOURCE#${sourceId}`).first();
  const pausedHealth = JSON.parse(pausedHealthRow.value);
  await database.prepare("UPDATE catalog_items SET value = ? WHERE pk = ? AND sk = 'HEALTH'")
    .bind(JSON.stringify({ ...pausedHealth, sourceStatus: 'active', configVersion: (pausedHealth.configVersion ?? 0) + 1 }), `SOURCE#${sourceId}`).run();

  // A genuinely new post-baseline row crosses discovery, R2, D1, the admission
  // queue, the live catalog sink, and the deterministic notification outbox.
  documentBodies.set(
    `https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md`,
    markdownTable(5),
  );
  const changed = await deliverGithub(ownershipOverrides);
  assert.equal(changed.ack, 1, JSON.stringify(changed.retries));
  current = await boardSnapshot();
  const pendingRows = current.rows.filter((row) => row.state === 'pending' || row.state === 'queued');
  assert.equal(pendingRows.length, 1);
  const incrementalMessages = buildMessages(pendingRows, current.snapshot.snapshot_hash, current.snapshot.admission_version);
  const liveOverrides = {
    ...ownershipOverrides,
    TRUSTED_COMMUNITY_CATALOG_ENABLED: 'true',
  };
  const incremental = await deliverAdmission(incrementalMessages, liveOverrides);
  assert.equal(incremental.settled.ack, 1, JSON.stringify(incremental.settled.retries));
  const notificationsAfterNew = await database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'notification-event'").first();
  const newRowDiagnostic = await database.prepare(
    'SELECT external_id, state, decision, job_id, notification_baseline FROM ingestion_rows WHERE source_id = ? AND external_id = ?',
  ).bind(sourceId, `README.md:${applyUrl(4)}`).first();
  const newOccurrenceDiagnostic = await database.prepare(
    "SELECT value FROM catalog_items WHERE kind = 'source-occurrence' AND source_id = ? AND external_id = ?",
  ).bind(sourceId, `README.md:${applyUrl(4)}`).first();
  assert.equal(notificationsAfterNew.count, notificationsAfterBaseline.count + 1,
    JSON.stringify({ newRowDiagnostic, newOccurrenceDiagnostic }));
  await deliverAdmission(incrementalMessages, liveOverrides);
  const notificationsAfterDuplicate = await database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'notification-event'").first();
  assert.equal(notificationsAfterDuplicate.count, notificationsAfterNew.count, 'duplicate delivery must not notify twice');

  const unchanged = await deliverGithub(ownershipOverrides);
  assert.equal(unchanged.ack, 1, JSON.stringify(unchanged.retries));
  const unchangedWork = await database.prepare("SELECT COUNT(*) AS count FROM ingestion_rows WHERE source_id = ? AND state IN ('pending','queued','processing')")
    .bind(sourceId).first();
  assert.equal(unchangedWork.count, 0);

  // Two complete omissions close the removed row. The first cadence retains it.
  documentBodies.set(
    `https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md`,
    markdownTable(4),
  );
  await deliverGithub(ownershipOverrides);
  const removedExternalId = `README.md:${applyUrl(4)}`;
  const afterOneOmission = await database.prepare('SELECT state, consecutive_omissions FROM ingestion_rows WHERE source_id = ? AND external_id = ?')
    .bind(sourceId, removedExternalId).first();
  assert.notEqual(afterOneOmission.state, 'absent');
  await deliverGithub(ownershipOverrides);
  const afterTwoOmissions = await database.prepare('SELECT state, consecutive_omissions FROM ingestion_rows WHERE source_id = ? AND external_id = ?')
    .bind(sourceId, removedExternalId).first();
  assert.equal(afterTwoOmissions.state, 'absent');
  assert.equal(afterTwoOmissions.consecutive_omissions, 2);

  // Roll back admission while a row is pending, prove the disabled consumer
  // drains without mutation, then re-enable and settle the same durable work.
  const rollbackTarget = current.rows[0].external_id;
  await database.prepare("UPDATE ingestion_rows SET state = 'pending', retry_at = NULL WHERE source_id = ? AND external_id = ?")
    .bind(sourceId, rollbackTarget).run();
  current = await boardSnapshot();
  const rollbackMessage = buildMessages(
    current.rows.filter((row) => row.external_id === rollbackTarget),
    current.snapshot.snapshot_hash,
    current.snapshot.admission_version,
  );
  await deliverAdmission(rollbackMessage, { INGESTION_V2_ADMISSION_ENABLED: 'false' });
  assert.equal((await database.prepare('SELECT state FROM ingestion_rows WHERE source_id = ? AND external_id = ?')
    .bind(sourceId, rollbackTarget).first()).state, 'pending');
  await deliverAdmission(rollbackMessage, liveOverrides);
  assert.equal((await database.prepare('SELECT state FROM ingestion_rows WHERE source_id = ? AND external_id = ?')
    .bind(sourceId, rollbackTarget).first()).state, 'settled');
});
