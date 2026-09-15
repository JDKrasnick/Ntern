import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiWorkerName = 'intern-notifs-e2e-api';
const ingestionWorkerName = 'intern-notifs-e2e-ingestion';
const internalServiceSecret = 'e2e-internal-service-secret';
const operationsSecret = 'e2e-operations-secret';
// Keep this at the newest date supported by the workerd version in package-lock.json.
const localCompatibilityDate = '2026-08-27';

let runtime;
let api;
let ingestion;

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
        modules: {
          [bundleName]: {
            type: 'esm',
            contents: await readFile(join(bundleDirectory, bundleName), 'utf8'),
          },
        },
      },
      env,
    },
  };
}

async function applyMigrations(database) {
  const migrationsDirectory = join(repositoryRoot, 'cloudflare/migrations');
  const migrations = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDirectory, migration), 'utf8');
    await database.batch(splitSqlQuery(sql).map((statement) => database.prepare(statement)));
  }
}

before(async () => {
  const apiBundleDirectory = join(repositoryRoot, 'cloudflare/dist/api');
  const ingestionBundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');

  runtime = new Miniflare({
    workers: [
      await createWorkerConfig(apiWorkerName, apiBundleDirectory, 'api-worker.js', {
        INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
        OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
        DEPLOYMENT_ROLE: { type: 'text', value: 'api' },
        IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: { type: 'text', value: 'false' },
        PUBLIC_API_URL: { type: 'text', value: 'https://api.example.test' },
        AUTH_DEV_MODE: { type: 'text', value: 'true' },
        AUTH_SESSION_SECRET: { type: 'text', value: 'e2e-auth-session-secret-at-least-32-characters' },
        DB: { type: 'd1', id: 'intern-notifs-e2e' },
        INGESTION: { type: 'worker', workerName: ingestionWorkerName },
      }),
      await createWorkerConfig(
        ingestionWorkerName,
        ingestionBundleDirectory,
        'ingestion-worker.js',
        {
          INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
          OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
          DEPLOYMENT_ROLE: { type: 'text', value: 'ingestion' },
          DB: { type: 'd1', id: 'intern-notifs-e2e' },
          DESTINATION_VERIFICATION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-destination-verification' },
          DESTINATION_VERIFICATION_DLQ: { type: 'queue', name: 'intern-notifs-e2e-destination-verification-dlq' },
        },
      ),
    ],
  });

  await runtime.ready;
  await applyMigrations(await runtime.getD1Database('DB', apiWorkerName));
  api = await runtime.getWorker(apiWorkerName);
  ingestion = await runtime.getWorker(ingestionWorkerName);
});

after(async () => {
  await runtime?.dispose();
});

test('reports both deployed roles through the real service binding', async () => {
  const denied = await api.fetch('https://api.example.test/internal/deployment');
  assert.equal(denied.status, 404);

  const response = await api.fetch('https://api.example.test/internal/deployment', {
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    api: { role: 'api', version: null },
    ingestion: { role: 'ingestion', version: null },
  });
});

test('preserves operation authentication across the Worker boundary', async () => {
  const denied = await api.fetch('https://api.example.test/internal/backfill?provider=invalid', {
    method: 'POST',
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { message: 'Not found' });

  const response = await api.fetch('https://api.example.test/internal/backfill?provider=invalid', {
    method: 'POST',
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { message: 'provider is invalid' });
});

test('keeps the ingestion Worker private without service authentication', async () => {
  const response = await ingestion.fetch('https://ingestion.example.test/internal/backfill?provider=invalid', {
    method: 'POST',
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { message: 'Not found' });
});

test('reports the admission baseline and queue health through the authenticated service boundary', async () => {
  const denied = await api.fetch('https://api.example.test/internal/admission/health');
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { message: 'Not found' });

  const privateResponse = await ingestion.fetch('https://ingestion.example.test/internal/admission/health', {
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(privateResponse.status, 404);
  assert.deepEqual(await privateResponse.json(), { message: 'Not found' });

  const response = await api.fetch('https://api.example.test/internal/admission/health', {
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    queues: {
      work: { backlogCount: 0, backlogBytes: 0 },
      deadLetter: { backlogCount: 0, backlogBytes: 0 },
    },
    freshness: { fresh: 0, due: 0, stale: 0, staleEligible: 0, missing: 0 },
    validationCoverage: { validated: 0, missing: 0 },
    activeIncidents: 0,
    operations: {
      scheduled: 0,
      leased: 0,
      backfillQueued: 0,
      backfillCompleted: 0,
      repairStaged: 0,
      repairApplied: 0,
    },
  });
});

test('returns the bounded admission audit through the compiled API and ingestion Workers', async () => {
  const response = await api.fetch('https://api.example.test/internal/admission/audit?limit=1', {
    headers: { 'X-Operations-Key': operationsSecret },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    scanned: 0,
    eligible: 0,
    review: 0,
    legacyUnclassified: 0,
    byReason: {},
    bySource: {},
    byDestination: {},
    withNotificationHistory: 0,
    freshness: { fresh: 0, due: 0, stale: 0, staleEligible: 0, missing: 0 },
    validationCoverage: { validated: 0, missing: 0 },
    continuationConflicts: 0,
    closureSignals: {},
    operations: {
      scheduled: 0,
      leased: 0,
      backfillQueued: 0,
      backfillCompleted: 0,
      repairStaged: 0,
      repairApplied: 0,
    },
    unresolvedEmployers: [],
    unresolvedEmployerOccurrences: 0,
    records: [],
  });
});

test('runs the paged posting-identity integrity gate through the compiled API Worker', async () => {
  const denied = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audit: true, jobBatch: 1 }),
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { message: 'Not found' });

  const response = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({ audit: true, jobBatch: 1 }),
  });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.deepEqual(report.occurrenceCounts, {
    confirmed: 0, unconfirmed: 0, legacy: 0, quarantined: 0, confirmedCoverage: null,
  });
  assert.deepEqual(report.gate, {
    passed: true, exactDuplicateGroups: 0, aliasConflicts: 0, untrackedQuarantines: 0,
    presentationBlockers: 0, legacyOccurrences: 0, projectionMismatches: 0,
    duplicateOccurrenceReferences: 0, danglingOccurrenceReferences: 0,
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.pages, 1);
  assert.equal(report.jobsScanned, 0);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.outboxRows, 0);
});

test('keeps public catalog requests on the API Worker', async () => {
  const response = await api.fetch('https://api.example.test/jobs');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).jobs, []);
});

test('honors a one-job audit batch through the compiled API Worker', async () => {
  const database = await runtime.getD1Database('DB', apiWorkerName);
  const makeJob = (jobId) => ({
    jobId, company: 'Paged Employer', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl: `https://careers.example.test/jobs/${jobId}`, normalizedUrl: `https://careers.example.test/jobs/${jobId}`,
    fingerprint: `fingerprint-${jobId}`, compensation: { raw: '' }, sourceReferences: [], open: true, technical: true,
    firstSeenAt: '2026-08-01T00:00:00.000Z', catalogVisibleAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-02T00:00:00.000Z', notification: { smsPending: false, digestPending: false },
  });
  for (const jobId of ['page-a', 'page-b']) {
    await database.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, ?, ?)')
      .bind(`JOB#${jobId}`, 'META', 'internship', JSON.stringify(makeJob(jobId))).run();
  }

  const response = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({ audit: true, jobBatch: 1 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    pages: 2,
    jobsScanned: 2,
    occurrenceCounts: { confirmed: 0, unconfirmed: 0, legacy: 0, quarantined: 0, confirmedCoverage: null },
    gate: {
      passed: true, exactDuplicateGroups: 0, aliasConflicts: 0, untrackedQuarantines: 0,
      presentationBlockers: 0, legacyOccurrences: 0, projectionMismatches: 0,
      duplicateOccurrenceReferences: 0, danglingOccurrenceReferences: 0,
    },
    duplicateAlertGroups: 0,
    unknownUrlFamilyCandidates: [],
    providerGroups: 0,
    duplicateGroups: 0,
    duplicateJobs: 0,
    eligibleDuplicateGroups: 0,
    eligibleDuplicateJobs: 0,
    unresolvedDuplicateGroups: 0,
    presentationDisagreements: [],
    samples: [],
    conflicts: [],
    outboxRows: 0,
  });
});

test('runs a dev account through signup, verification, sign-in, and private reads', async () => {
  const email = `review-${randomUUID()}@example.test`;
  const password = 'Review-only password 175!';
  const signup = await api.fetch('https://api.example.test/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, ageAttested: true, termsVersion: '2026-08-25', privacyVersion: '2026-08-26' }),
  });
  assert.equal(signup.status, 201);
  const signupBody = await signup.json();
  assert.equal(signupBody.delivery, 'development');
  assert.match(signupBody.confirmationCode, /^\d{6}$/);

  const confirm = await api.fetch('https://api.example.test/auth/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: signupBody.confirmationCode }),
  });
  assert.equal(confirm.status, 204);
  const signin = await api.fetch('https://api.example.test/auth/signin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(signin.status, 200);
  const { token } = await signin.json();
  const preferences = await api.fetch('https://api.example.test/me/preferences', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(preferences.status, 200);
  const preferencesBody = await preferences.json();
  assert.equal(typeof preferencesBody.userId, 'string');
  assert.deepEqual({ ...preferencesBody, userId: '<user>' }, { userId: '<user>', filter: {}, alertsEnabled: false, onboardingComplete: false });
});

test('processes a compiled shadow queue event through R2 and exposes its disabled state to operations', async () => {
  const bundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');
  const shadowRuntime = new Miniflare({ workers: [
    await createWorkerConfig('intern-notifs-e2e-shadow', bundleDirectory, 'ingestion-worker.js', {
      SHADOW_EXTRACTION_ENABLED: { type: 'text', value: 'false' },
      INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
      OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
      DB: { type: 'd1', id: 'intern-notifs-e2e-shadow' },
      SHADOW_EXTRACTION_ARTIFACTS: { type: 'r2', name: 'intern-notifs-e2e-shadow' },
    }),
  ] });
  await shadowRuntime.ready;
  const database = await shadowRuntime.getD1Database('DB', 'intern-notifs-e2e-shadow');
  await applyMigrations(database);
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');
  const normalized = { title: 'Software Engineering Intern', description: 'Austin\n$50 - $60 per hour', completeness: 'complete' };
  normalized.contentHash = sha256(JSON.stringify(normalized));
  const cacheKey = sha256([normalized.contentHash, 'gpt-4o-mini-2024-07-18', 'shadow-extraction-prompt-v9',
    'shadow-extraction-schema-v5', 'exact-posting-markdown-v1'].join('\0'));
  const identity = { provider: 'greenhouse', sourceId: 'greenhouse-review', tenant: 'review', postingId: '175', sourceUrl: 'https://example.test/175' };
  const runKey = sha256(['review-job', 'greenhouse-review', '175', normalized.contentHash, cacheKey].join('\0'));
  const inputKey = `shadow-input/${runKey}.json`;
  const observedAt = new Date().toISOString();
  await database.prepare(`INSERT INTO shadow_extraction_posting_revisions (job_id, source_id, external_id, content_hash, observed_at)
    VALUES (?, ?, ?, ?, ?)`).bind('review-job', 'greenhouse-review', '175', normalized.contentHash, observedAt).run();
  const bucket = await shadowRuntime.getR2Bucket('SHADOW_EXTRACTION_ARTIFACTS', 'intern-notifs-e2e-shadow');
  await bucket.put(inputKey, JSON.stringify({ version: 1, normalized, baseline: { compensation: 'incomplete' }, identity: {
    jobId: 'review-job', sourceId: 'greenhouse-review', externalId: '175', sourceUrl: identity.sourceUrl,
    providerIdentity: identity, observedAt,
  } }));
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  let acked = false;
  await builtWorker.queue({ queue: 'intern-notifs-shadow-extraction', messages: [{ id: 'review-message',
    body: { version: 1, runKey, cacheKey, jobId: 'review-job', sourceId: 'greenhouse-review', externalId: '175',
      sourceUrl: identity.sourceUrl, providerIdentity: identity, contentHash: normalized.contentHash, inputKey, queuedAt: observedAt },
    attempts: 1, ack() { acked = true; }, retry() { throw new Error('disabled execution should not retry'); } }] }, {
    DB: database, SHADOW_EXTRACTION_ARTIFACTS: bucket, SHADOW_EXTRACTION_ENABLED: 'false',
  });
  const row = await database.prepare('SELECT state, attempts, error FROM shadow_extraction_runs WHERE run_key = ?').bind(runKey).first();
  const worker = await shadowRuntime.getWorker('intern-notifs-e2e-shadow');
  const summary = await worker.fetch('https://ingestion.example.test/internal/operations/shadow-extraction', {
    headers: { 'X-InternNotifs-Service-Key': internalServiceSecret, 'X-Operations-Key': operationsSecret },
  });
  const summaryBody = await summary.json();
  await shadowRuntime.dispose();

  assert.equal(acked, true);
  assert.deepEqual(row, { state: 'disabled', attempts: 1, error: 'live model execution disabled or credential unavailable' });
  assert.equal(summary.status, 200);
  assert.ok(summaryBody.runs.some((item) => item.state === 'disabled' && item.count === 1));
  assert.deepEqual(summaryBody.providerOutbox, { pending: 0 });
});

test('delays a D1-overload retry in the compiled ingestion queue consumer', async () => {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  const retries = [];
  const statement = {
    bind() { return statement; },
    async first() { return null; },
    async all() { throw new Error('D1_ERROR: too many requests'); },
    async run() { return { meta: { changes: 1 } }; },
  };
  const database = { prepare() { return statement; }, async batch() { return []; } };

  await builtWorker.queue({
    queue: 'intern-notifs-greenhouse',
    messages: [{
      id: 'd1-overload', body: { sourceId: 'greenhouse-acme' }, attempts: 1, timestamp: new Date(),
      ack() { throw new Error('a D1 overload must not acknowledge the message'); },
      retry(options) { retries.push(options); },
    }],
  }, { DB: database });

  assert.deepEqual(retries, [{ delaySeconds: 60 }]);
});

test('uses the longer D1-overload delay after the first compiled queue delivery', async () => {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  const retries = [];
  const statement = {
    bind() { return statement; },
    async first() { return null; },
    async all() { throw new Error('D1_ERROR: database busy'); },
    async run() { return { meta: { changes: 1 } }; },
  };
  const database = { prepare() { return statement; }, async batch() { return []; } };

  await builtWorker.queue({
    queue: 'intern-notifs-greenhouse',
    messages: [{
      id: 'd1-overload-retry', body: { sourceId: 'greenhouse-acme' }, attempts: 2, timestamp: new Date(),
      ack() { throw new Error('a D1 overload must not acknowledge the message'); },
      retry(options) { retries.push(options); },
    }],
  }, { DB: database });

  assert.deepEqual(retries, [{ delaySeconds: 300 }]);
});
