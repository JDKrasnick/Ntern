/**
 * Differential metadata evidence writes, end to end on the local Cloudflare
 * runtime.
 *
 * `wrangler dev` is Miniflare/workerd with a real D1 and real queue consumers.
 * This suite runs the same runtime with the compiled ingestion bundle, a real
 * D1 database, and a real (sanitized) Greenhouse response, so the collection
 * path is exercised as deployed instead of through a shim:
 *
 *   1. the operations HTTP surface in workerd (`/internal/role-metadata/...`)
 *      selects the candidate and enqueues the collection message, and
 *   2. the destination-verification consumer is delivered that exact message,
 *      with every D1 statement wrapped so the rows D1 billed are attributed to
 *      the table the statement touched.
 *
 * The claim under test: replaying one unchanged artifact advances the
 * observation row and nothing else — no evidence row, conflict row, or
 * per-posting review revision — while a changed artifact still replaces the
 * evidence and reaches the guarded repair plan.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

// Node globals are not in this file's eslint environment; the runtime's own
// constructors are used explicitly instead.
const { Response, Buffer, process, console } = globalThis;

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
// The runtime's own fetch, restored after every stubbed delivery.
const realFetch = globalThis.fetch;
const workerName = 'intern-notifs-e2e-metadata';
const operationsSecret = 'e2e-operations-secret';
const internalServiceSecret = 'e2e-internal-service-secret';
const destinationVerificationQueue = 'intern-notifs-destination-verification';
// Keep this at the newest date supported by the workerd version in package-lock.json.
const localCompatibilityDate = '2026-08-27';

const boardToken = 'figma';
const sourceId = `greenhouse-${boardToken}`;
const jobId = `${sourceId}-6178851004`;
const boardApiUrl = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`;
const apiUrl = `${boardApiUrl}/6178851004?pay_transparency=true&pay_input_ranges=true`;
const applyUrl = `https://job-boards.greenhouse.io/${boardToken}/jobs/6178851004`;
const capturedPayload = JSON.parse(await readFile(
  join(repositoryRoot, 'test/fixtures/metadata-evidence/greenhouse-figma-6178851004.json'), 'utf8'));
const roleMetadataExtractionVersion = Number(new RegExp('ROLE_METADATA_EXTRACTION_VERSION = (\\d+)')
  .exec(await readFile(join(repositoryRoot, 'src/role-metadata.ts'), 'utf8'))[1]);

let runtime;
let worker;
let database;
let shadowArtifacts;

async function createWorkerConfig(name, bundleDirectory, bundleName, env) {
  return {
    config: {
      name,
      type: 'worker',
      compatibilityDate: localCompatibilityDate,
      compatibilityFlags: ['nodejs_compat'],
      manifest: {
        mainModule: bundleName,
        modulesRoot: bundleDirectory,
        modules: { [bundleName]: { type: 'esm', contents: await readFile(join(bundleDirectory, bundleName), 'utf8') } },
      },
      env,
    },
  };
}

async function applyMigrations(d1) {
  const migrationsDirectory = join(repositoryRoot, 'cloudflare/migrations');
  const migrations = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDirectory, migration), 'utf8');
    await d1.batch(splitSqlQuery(sql).map((statement) => d1.prepare(statement)));
  }
}

/** Wraps a real D1 binding and attributes the rows D1 billed to each statement. */
function countingDatabase(d1) {
  const statements = [];
  const prepare = (sql) => {
    const build = (bound) => ({
      sql, statement: bound,
      bind: (...values) => build(bound.bind(...values)),
      async first() { return bound.first(); },
      async all() { return bound.all(); },
      async run() {
        const result = await bound.run();
        statements.push({ sql, rowsWritten: result.meta?.rows_written ?? 0, rowsRead: result.meta?.rows_read ?? 0 });
        return result;
      },
    });
    return build(d1.prepare(sql));
  };
  return {
    statements,
    prepare,
    async batch(list) {
      const results = await d1.batch(list.map((item) => item.statement));
      if (results.length !== list.length) throw new Error('D1 batch returned fewer results than statements');
      list.forEach((item, index) => statements.push({ sql: item.sql,
        rowsWritten: results[index]?.meta?.rows_written ?? 0, rowsRead: results[index]?.meta?.rows_read ?? 0 }));
      return results;
    },
  };
}

const rowsWrittenFor = (counter, pattern) => counter.statements
  .filter((statement) => pattern.test(statement.sql))
  .reduce((total, statement) => total + statement.rowsWritten, 0);

/** The tables a delivery actually wrote rows to, ignoring statements D1 billed nothing for. */
function writtenTables(counter) {
  const tables = new Set();
  for (const statement of counter.statements) {
    if (!statement.rowsWritten) continue;
    const match = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|INSERT\s+OR\s+\w+\s+INTO)\s+([a-z_]+)/iu.exec(statement.sql);
    tables.add(match ? match[1].toLowerCase() : statement.sql.slice(0, 40));
  }
  return [...tables].sort();
}

function jobDocument() {
  const destination = {
    classification: 'posting-detail', candidateUrl: applyUrl, finalUrl: applyUrl, provider: 'greenhouse',
    tenant: boardToken, expectedPostingId: '6178851004', inspectedAt: '2026-09-01T00:00:00.000Z', browserVisible: true,
  };
  const admission = {
    canonicalEmployer: { id: boardToken, displayName: 'Figma' },
    employerResolution: 'resolved', postingAttribution: 'attributed', destination,
    metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: true, alertEligible: true, reasonCodes: [],
    evaluatedAt: '2026-09-01T00:00:00.000Z', evidenceObservedAt: '2026-09-01T00:00:00.000Z',
  };
  return {
    jobId, company: 'Figma', title: capturedPayload.title, location: 'San Francisco, CA', locations: ['San Francisco, CA'],
    season: 'summer-2027', applyUrl, normalizedUrl: applyUrl, fingerprint: jobId, compensation: { raw: '' },
    sourceReferences: [{
      sourceId, externalId: '6178851004', document: 'greenhouse-figma', sourceUrl: boardApiUrl, row: 1,
      company: 'Figma', title: capturedPayload.title, location: 'San Francisco, CA', season: 'summer-2027',
      applyUrl, state: 'open', provenance: 'official-ats',
      providerEvidence: { provider: 'greenhouse', tenant: boardToken, postingId: '6178851004' },
      admission,
    }],
    technical: true, open: true, firstSeenAt: '2026-09-01T00:00:00.000Z', catalogVisibleAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-01T00:00:00.000Z', admission,
    notification: { smsPending: false, digestPending: false, smsSentAt: '2026-09-01T00:01:00.000Z' },
  };
}

/** The message the collect endpoint produces for this seeded role. */
function collectionMessage(metadataBackfillToken) {
  return { version: 1, jobId, sourceId, externalId: '6178851004',
    providerIdentity: { provider: 'greenhouse', sourceId, sourceUrl: boardApiUrl, tenant: boardToken, postingId: '6178851004' },
    candidateUrl: applyUrl, reason: 'historical-backfill', queuedAt: new Date().toISOString(),
    metadataExtractionVersion: roleMetadataExtractionVersion, metadataBackfillToken };
}

const wait = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

const dump = async (sql) => (await database.prepare(sql).all()).results;
const revisions = async () => ({
  metadata: (await database.prepare('SELECT revision FROM role_metadata_revision WHERE id = 1').first()).revision,
  jobs: await dump('SELECT job_id, revision FROM role_metadata_job_revision ORDER BY job_id'),
});

before(async () => {
  const bundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');
  runtime = new Miniflare({
    workers: [await createWorkerConfig(workerName, bundleDirectory, 'ingestion-worker.js', {
      INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
      OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
      DEPLOYMENT_ROLE: { type: 'text', value: 'ingestion' },
      IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: { type: 'text', value: 'false' },
      TRUSTED_COMMUNITY_CATALOG_ENABLED: { type: 'text', value: 'false' },
      PUBLIC_API_URL: { type: 'text', value: 'https://api.example.test' },
      DB: { type: 'd1', id: 'intern-notifs-e2e-metadata' },
      DESTINATION_VERIFICATION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-metadata-destination' },
      DESTINATION_VERIFICATION_DLQ: { type: 'queue', name: 'intern-notifs-e2e-metadata-destination-dlq' },
      SHADOW_EXTRACTION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-metadata-shadow' },
      SHADOW_EXTRACTION_ARTIFACTS: { type: 'r2', name: 'intern-notifs-e2e-metadata-artifacts' },
      SHADOW_EXTRACTION_DLQ: { type: 'queue', name: 'intern-notifs-e2e-metadata-shadow-dlq' },
    })],
  });
  await runtime.ready;
  database = await runtime.getD1Database('DB', workerName);
  shadowArtifacts = await runtime.getR2Bucket('SHADOW_EXTRACTION_ARTIFACTS', workerName);
  await applyMigrations(database);
  await database.prepare(`INSERT INTO catalog_items(pk, sk, kind, value) VALUES (?, 'META', 'internship', ?)`)
    .bind(`JOB#${jobId}`, JSON.stringify(jobDocument())).run();
  worker = await runtime.getWorker(workerName);
});

after(async () => {
  await runtime?.dispose();
});

async function operations(path, init = {}) {
  const response = await worker.fetch(`https://ingestion.example.test${path}`, {
    ...init, headers: { 'X-InternNotifs-Service-Key': internalServiceSecret, 'X-Operations-Key': operationsSecret,
      'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

/** Delivers one message to the compiled destination-verification consumer. */
async function deliver(body, injectedFetch) {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  const counter = countingDatabase(database);
  const settled = { ack: 0, retry: [] };
  globalThis.fetch = injectedFetch;
  try {
    await builtWorker.queue({ queue: destinationVerificationQueue, messages: [{
      id: `delivery-${Date.now()}-${Math.random().toString(16).slice(2)}`, body, attempts: 1, timestamp: new Date(),
      ack() { settled.ack += 1; },
      retry(options, error) { settled.retry.push({ options, error: error instanceof Error ? error.message : error }); },
    }] }, {
      DB: counter,
      DESTINATION_VERIFICATION_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
      DESTINATION_VERIFICATION_DLQ: { send: async () => undefined, sendBatch: async () => undefined },
      SHADOW_EXTRACTION_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
      SHADOW_EXTRACTION_ARTIFACTS: shadowArtifacts,
      SHADOW_EXTRACTION_DLQ: { send: async () => undefined, sendBatch: async () => undefined },
      IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'false',
      TRUSTED_COMMUNITY_CATALOG_ENABLED: 'false',
      DEPLOYMENT_ROLE: 'ingestion',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  return { counter, settled };
}

/** Serves the recorded real response for one board job, and nothing else. */
function payloadServer(payload, calls) {
  return async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    calls.push(url);
    if (url !== apiUrl) return new Response('unexpected outbound request', { status: 502 });
    return Response.json(payload);
  };
}

test('collects one real artifact, then replays it without rewriting evidence', async () => {
  // The operations surface selects the candidate, reserves it, and enqueues the
  // collection. The candidate is deterministic for this seeded role, so the
  // message this test hands to the consumer is exactly the one it produced.
  const collected = await operations('/internal/role-metadata/backfill', {
    method: 'POST', body: JSON.stringify({ action: 'collect', limit: 10 }),
  });
  assert.equal(collected.status, 200);
  assert.equal(collected.body.queued, 1);
  assert.equal(collected.body.exhausted, true);
  assert.equal(Buffer.from(collected.body.nextCursor, 'base64').toString(), `${jobId}\0${sourceId}`);
  assert.equal(collected.body.extractionVersion, roleMetadataExtractionVersion);
  const reservation = await dump('SELECT job_id, source_id, lease_until, retry_after FROM role_metadata_acquisition');
  assert.deepEqual(reservation.map((row) => [row.job_id, row.source_id]), [[jobId, sourceId]]);
  const message = collectionMessage(collected.body.collectionToken);
  const before = await revisions();
  const firstCalls = [];
  const first = await deliver(message, payloadServer(capturedPayload, firstCalls));
  assert.deepEqual(firstCalls, [apiUrl], 'the consumer must read the provider API once');
  assert.deepEqual(first.settled.retry, []);
  assert.equal(first.settled.ack, 1);

  const evidenceRows = () => dump(`SELECT source_class, source_id, source_url, artifact_hash, extraction_version, evidence, observed_at, is_current
    FROM role_metadata_evidence ORDER BY artifact_hash`);
  const evidence = await evidenceRows();
  assert.equal(evidence.length, 1);
  const artifact = JSON.parse(evidence[0].evidence);
  assert.equal(evidence[0].source_class, 'official-api');
  assert.equal(evidence[0].extraction_version, roleMetadataExtractionVersion);
  assert.equal(evidence[0].is_current, 1);
  // The real API band carries no interval field, so the period stays unknown
  // while the amount, the housing stipend, the locations and the publisher
  // timestamps are exactly what the employer published.
  assert.deepEqual(artifact.compensationRanges.map((range) => [range.currency, range.minAmount, range.maxAmount, range.period, range.applicabilityLabel]),
    [['USD', 46, 46, 'unknown', 'Internship']]);
  assert.deepEqual(artifact.housing.map((detail) => [detail.kind, detail.sourceText]),
    [['stipend', 'Figma also offers interns a housing stipend and travel reimbursement.']]);
  assert.deepEqual(artifact.locations.map((location) => location.name), ['San Francisco, CA', 'New York, NY']);
  assert.equal(artifact.employerPublishedAt.value, '2026-09-23T19:30:27.000Z');
  assert.equal(artifact.sourceUrl, apiUrl);
  const attempts = await dump('SELECT artifact_hash, extraction_version, outcome, observed_at FROM role_metadata_extraction_attempts');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'extracted');
  assert.equal(attempts[0].artifact_hash, artifact.artifactHash);
  const acquisition = await dump('SELECT report FROM role_metadata_acquisition');
  assert.equal(JSON.parse(acquisition[0].report).complete, true);
  const firstWritten = {
    evidence: rowsWrittenFor(first.counter, /role_metadata_evidence/u),
    conflicts: rowsWrittenFor(first.counter, /role_metadata_conflicts/u),
    attempts: rowsWrittenFor(first.counter, /role_metadata_extraction_attempts/u),
  };
  assert.ok(firstWritten.evidence > 0, 'a first observation must write its evidence row');
  assert.ok(firstWritten.attempts > 0, 'a first observation must write its attempt row');
  const jobsAfterFirst = await revisions();
  assert.notDeepEqual(jobsAfterFirst.jobs, before.jobs, 'new evidence must advance the per-posting revision');
  // The real downstream handoff ran: one content-addressed artifact, enqueued once.
  assert.equal((await shadowArtifacts.list()).objects.length, 1);
  // The audit agrees the role is collected and current. Collection is
  // staging-only, so the five accepted fields are still a projection delta.
  const audit = await operations('/internal/role-metadata/audit');
  assert.equal(audit.status, 200);
  assert.deepEqual(audit.body.collectionCoverage,
    { extractionVersion: roleMetadataExtractionVersion, eligible: 1, current: 1, pendingOrUnobserved: 0, stale: 0,
      complete: true, outcomes: { extracted: 1 }, backfillTokens: { [collected.body.collectionToken]: 1 } });
  assert.deepEqual(audit.body.projectionOnlyOmissions,
    [{ jobId, fields: ['compensation', 'housing', 'locations', 'employerPublishedAt', 'employerUpdatedAt'] }]);
  assert.deepEqual(audit.body.deferredProjections, []);

  // The same artifact, re-observed later: only the observation row advances.
  await wait(30);
  const replayCalls = [];
  const replay = await deliver(message, payloadServer(capturedPayload, replayCalls));
  assert.deepEqual(replayCalls, [apiUrl]);
  assert.deepEqual(replay.settled.retry, []);
  assert.equal(replay.settled.ack, 1);
  const replayWritten = {
    evidence: rowsWrittenFor(replay.counter, /role_metadata_evidence/u),
    conflicts: rowsWrittenFor(replay.counter, /role_metadata_conflicts/u),
    attempts: rowsWrittenFor(replay.counter, /role_metadata_extraction_attempts/u),
  };
  assert.equal(replayWritten.evidence, 0, 'an unchanged artifact must not rewrite or retire evidence');
  assert.equal(replayWritten.conflicts, 0, 'an unchanged artifact must not touch conflict rows');
  assert.ok(replayWritten.attempts > 0, 'the observation row must advance');
  // Bookkeeping may be written; evidence, conflicts and the catalog may not.
  assert.deepEqual(writtenTables(replay.counter),
    ['role_metadata_acquisition', 'role_metadata_extraction_attempts', 'shadow_extraction_posting_revisions']);
  const writtenTotal = (counter) => counter.statements.reduce((total, statement) => total + statement.rowsWritten, 0);
  // Reported measurement: what one real observation billed, and what replaying
  // that same artifact bills now, including index and trigger rows D1 counts.
  console.log(`metadata replay rows_written: first observation=${writtenTotal(first.counter)} replay=${writtenTotal(replay.counter)}`
    + ` (evidence=${replayWritten.evidence}, conflicts=${replayWritten.conflicts}, attempts=${replayWritten.attempts})`);
  assert.ok(writtenTotal(replay.counter) < writtenTotal(first.counter), 'a replay must bill less than the observation it replays');
  assert.deepEqual(await evidenceRows(), evidence);
  assert.deepEqual(await dump('SELECT * FROM role_metadata_conflicts'), []);
  const afterReplay = await revisions();
  assert.deepEqual(afterReplay.jobs, jobsAfterFirst.jobs, 'a replay must not expire a staged review');
  assert.equal(afterReplay.metadata, jobsAfterFirst.metadata + 1, 'only the observation trigger advances the metadata revision');
  assert.equal((await shadowArtifacts.list()).objects.length, 1,
    'an unchanged replay must not add a downstream artifact');
  const replayedAttempt = await dump('SELECT artifact_hash, observed_at FROM role_metadata_extraction_attempts');
  assert.equal(replayedAttempt.length, 1);
  assert.ok(replayedAttempt[0].observed_at > attempts[0].observed_at,
    'freshness lives in the observation row while the evidence row keeps its own time');
  const replayedAudit = await operations('/internal/role-metadata/audit');
  assert.equal(replayedAudit.status, 200);
  // Re-observing an unchanged artifact must not move what the audit reports:
  // the same coverage, the same omissions, and no deferred projection.
  assert.deepEqual(replayedAudit.body.collectionCoverage, audit.body.collectionCoverage);
  assert.deepEqual(replayedAudit.body.projectionOnlyOmissions, audit.body.projectionOnlyOmissions);
  assert.deepEqual(replayedAudit.body.deferredProjections, audit.body.deferredProjections);
});

test('a changed real artifact replaces its evidence and reaches the guarded repair plan', async () => {
  const beforeReplacement = await dump('SELECT artifact_hash, is_current FROM role_metadata_evidence ORDER BY artifact_hash');
  const changed = { ...capturedPayload,
    pay_input_ranges: [{ ...capturedPayload.pay_input_ranges[0], min_cents: 5500, max_cents: 6000 }] };
  const calls = [];
  const changedDelivery = await deliver(collectionMessage('changed-payload'), payloadServer(changed, calls));
  assert.deepEqual(calls, [apiUrl]);
  assert.deepEqual(changedDelivery.settled.retry, []);
  assert.ok(rowsWrittenFor(changedDelivery.counter, /role_metadata_evidence/u) > 0,
    'changed content must replace the evidence row');

  const replaced = await dump(`SELECT artifact_hash, is_current, evidence FROM role_metadata_evidence ORDER BY artifact_hash`);
  assert.equal(replaced.length, beforeReplacement.length + 1);
  assert.deepEqual(replaced.filter((row) => row.is_current === 1).map((row) => JSON.parse(row.evidence).compensationRanges[0].minAmount), [55]);
  assert.deepEqual(replaced.filter((row) => row.is_current === 0).map((row) => row.artifact_hash), beforeReplacement.map((row) => row.artifact_hash));

  // The guarded dry-run sees the new amount as a correction, so real changes
  // still flow into the plan that owns publication.
  const plan = await operations('/internal/role-metadata/backfill', { method: 'POST', body: JSON.stringify({ action: 'dry-run' }) });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.expectedJobs, 1);
  assert.equal(plan.body.correctionsByField.compensation ?? plan.body.fillsByField.compensation, 1);
  assert.deepEqual(plan.body.conflicts, []);
  assert.equal(plan.body.collectionCoverage.complete, true);
});

// The deterministic tests above serve a sanitized capture. This one reads the
// employer's API over the network, so it only runs on request:
// `ROLE_METADATA_LIVE=1 node --test test/e2e/role-metadata-write-reduction.e2e.mjs`.
// It makes read-only GET requests to a public board API, no credentials.
const liveEnabled = process.env.ROLE_METADATA_LIVE === '1';
test('reads the live provider response and replays it without rewriting evidence',
  { skip: liveEnabled ? false : 'set ROLE_METADATA_LIVE=1 to read the live provider API' }, async () => {
    const calls = [];
    const liveFetch = (request, init) => {
      calls.push(typeof request === 'string' ? request : request.url);
      return realFetch(request, init);
    };
    const rows = () => dump(`SELECT artifact_hash, extraction_version, evidence, observed_at, is_current
      FROM role_metadata_evidence ORDER BY artifact_hash`);
    const attempts = () => dump('SELECT artifact_hash, outcome, observed_at FROM role_metadata_extraction_attempts ORDER BY artifact_hash');

    const first = await deliver(collectionMessage('live-payload'), liveFetch);
    assert.deepEqual(first.settled.retry, []);
    assert.equal(first.settled.ack, 1);
    const observed = await rows();
    const attempt = await attempts();
    assert.ok(rowsWrittenFor(first.counter, /role_metadata_evidence/u) > 0);
    const newestAttempt = attempt.reduce((best, row) => (!best || row.observed_at > best.observed_at ? row : best), undefined);
    const current = observed.find((row) => row.is_current === 1 && row.artifact_hash === newestAttempt.artifact_hash);
    assert.ok(current, 'the live artifact must be the current evidence row');
    console.log(`live metadata collection: artifact=${current.artifact_hash.slice(0, 12)} observed_at=${current.observed_at}`);

    await wait(1_100);
    const replay = await deliver(collectionMessage('live-payload'), liveFetch);
    assert.deepEqual(replay.settled.retry, []);
    assert.equal(rowsWrittenFor(replay.counter, /role_metadata_evidence/u), 0,
      'the live posting changed between deliveries; re-record test/fixtures/metadata-evidence');
    assert.equal(rowsWrittenFor(replay.counter, /role_metadata_conflicts/u), 0);
    assert.deepEqual(await rows(), observed, 'the live replay must leave every evidence row untouched');
    const liveAttempt = (list) => list.find((row) => row.artifact_hash === current.artifact_hash);
    assert.ok(liveAttempt(await attempts()).observed_at > liveAttempt(attempt).observed_at,
      'the live replay must advance the observation row');
    assert.deepEqual(calls, [apiUrl, apiUrl]);
  });
