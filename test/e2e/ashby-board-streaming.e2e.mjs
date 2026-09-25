/**
 * Streamed Ashby board acquisition, end to end on the local Cloudflare runtime.
 *
 * `wrangler dev` is Miniflare/workerd with a real D1 and real queue consumers.
 * This suite runs the same runtime with the compiled ingestion bundle, a real
 * D1 database and R2 bucket, and a fabricated multi-megabyte Ashby board, then
 * delivers the exact messages the destination-verification consumer receives.
 *
 * Two claims:
 *   1. a board past the 2 MB acquisition ceiling still yields the requested
 *      posting (the fix), and
 *   2. one batch-scoped acquirer serves every posting the same board publishes,
 *      which is the shape production uses (max_batch_size 5).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

const { Response, TextEncoder, ReadableStream, console } = globalThis;
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const realFetch = globalThis.fetch;
const workerName = 'intern-notifs-e2e-ashby';
const operationsSecret = 'e2e-operations-secret';
const internalServiceSecret = 'e2e-internal-service-secret';
const destinationVerificationQueue = 'intern-notifs-destination-verification';
// Keep this at the newest date supported by the workerd version in package-lock.json.
const localCompatibilityDate = '2026-08-27';

const roleMetadataExtractionVersion = Number(new RegExp('ROLE_METADATA_EXTRACTION_VERSION = (\\d+)')
  .exec(await readFile(join(repositoryRoot, 'src/role-metadata.ts'), 'utf8'))[1]);

const tenant = 'acme';
const sourceId = `ashby-${tenant}`;
const boardUrl = `https://api.ashbyhq.com/posting-api/job-board/${tenant}?includeCompensation=true`;
const postingA = '11111111-1111-4111-8111-111111111111';
const postingB = '22222222-2222-4222-8222-222222222222';
const jobId = (postingId) => `${sourceId}-${postingId}`;
const applyUrl = (postingId) => `https://jobs.ashbyhq.com/${tenant}/${postingId}`;

/** A real-shaped board, padded past the old 2 MB buffering ceiling. */
function boardBytes() {
  const filler = 'x'.repeat(20_000);
  const rows = Array.from({ length: 150 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Role ${index}`, descriptionPlain: filler,
  }));
  return new TextEncoder().encode(JSON.stringify({
    jobs: [
      { id: postingA, title: 'Streaming Intern', descriptionPlain: 'Build streaming acquisition for board A.', jobUrl: applyUrl(postingA) },
      ...rows.map((row) => ({ ...row, jobUrl: `https://jobs.ashbyhq.com/${tenant}/${row.id}` })),
      { id: postingB, title: 'Batch Intern', descriptionPlain: 'Serve board B from the same batch.', jobUrl: applyUrl(postingB) },
    ],
  }));
}

let runtime;
let database;
let shadowArtifacts;
let board;

async function createWorkerConfig(name, bundleDirectory, bundleName, env) {
  return {
    config: {
      name, type: 'worker', compatibilityDate: localCompatibilityDate, compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: bundleName, modulesRoot: bundleDirectory,
        modules: { [bundleName]: { type: 'esm', contents: await readFile(join(bundleDirectory, bundleName), 'utf8') } } },
      env,
    },
  };
}

async function applyMigrations(d1) {
  const migrationsDirectory = join(repositoryRoot, 'cloudflare/migrations');
  const migrations = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith('.sql')).sort((left, right) => left.localeCompare(right));
  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDirectory, migration), 'utf8');
    await d1.batch(splitSqlQuery(sql).map((statement) => d1.prepare(statement)));
  }
}

function jobDocument(postingId, index) {
  const destination = {
    classification: 'posting-detail', candidateUrl: applyUrl(postingId), finalUrl: applyUrl(postingId), provider: 'ashby',
    tenant, expectedPostingId: postingId, inspectedAt: '2026-09-01T00:00:00.000Z', browserVisible: true,
  };
  const admission = {
    canonicalEmployer: { id: tenant, displayName: 'Acme' }, employerResolution: 'resolved', postingAttribution: 'attributed',
    destination, metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: true, alertEligible: true, reasonCodes: [],
    evaluatedAt: '2026-09-01T00:00:00.000Z', evidenceObservedAt: '2026-09-01T00:00:00.000Z',
  };
  return {
    jobId: jobId(postingId), company: 'Acme', title: index === 0 ? 'Streaming Intern' : 'Batch Intern',
    location: 'Remote', locations: ['Remote'], season: 'summer-2027', applyUrl: applyUrl(postingId), normalizedUrl: applyUrl(postingId),
    fingerprint: jobId(postingId), compensation: { raw: '' },
    sourceReferences: [{
      sourceId, externalId: postingId, document: 'ashby-acme', sourceUrl: boardUrl, row: index + 1,
      company: 'Acme', title: index === 0 ? 'Streaming Intern' : 'Batch Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: applyUrl(postingId), state: 'open', provenance: 'official-ats',
      providerEvidence: { provider: 'ashby', tenant, postingId },
      admission,
    }],
    technical: true, open: true, firstSeenAt: '2026-09-01T00:00:00.000Z', catalogVisibleAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-01T00:00:00.000Z', admission,
    notification: { smsPending: false, digestPending: false, smsSentAt: '2026-09-01T00:01:00.000Z' },
  };
}

/** A historical-backfill collection message for one posting on the board. */
function collectionMessage(postingId, token) {
  return {
    version: 1, jobId: jobId(postingId), sourceId, externalId: postingId,
    providerIdentity: { provider: 'ashby', sourceId, sourceUrl: boardUrl, tenant, postingId },
    candidateUrl: applyUrl(postingId), reason: 'historical-backfill', queuedAt: new Date().toISOString(),
    metadataExtractionVersion: roleMetadataExtractionVersion, metadataBackfillToken: token,
  };
}

before(async () => {
  board = boardBytes();
  assert.ok(board.byteLength > 2_000_000, 'the fabricated board must exceed the buffering ceiling');
  const bundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');
  runtime = new Miniflare({
    workers: [await createWorkerConfig(workerName, bundleDirectory, 'ingestion-worker.js', {
      INTERNAL_SERVICE_SECRET: { type: 'text', value: internalServiceSecret },
      OPERATIONS_SHARED_SECRET: { type: 'text', value: operationsSecret },
      DEPLOYMENT_ROLE: { type: 'text', value: 'ingestion' },
      IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: { type: 'text', value: 'false' },
      TRUSTED_COMMUNITY_CATALOG_ENABLED: { type: 'text', value: 'false' },
      PUBLIC_API_URL: { type: 'text', value: 'https://api.example.test' },
      DB: { type: 'd1', id: 'intern-notifs-e2e-ashby' },
      DESTINATION_VERIFICATION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-ashby-destination' },
      DESTINATION_VERIFICATION_DLQ: { type: 'queue', name: 'intern-notifs-e2e-ashby-destination-dlq' },
      SHADOW_EXTRACTION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-ashby-shadow' },
      SHADOW_EXTRACTION_ARTIFACTS: { type: 'r2', name: 'intern-notifs-e2e-ashby-artifacts' },
      SHADOW_EXTRACTION_DLQ: { type: 'queue', name: 'intern-notifs-e2e-ashby-shadow-dlq' },
    })],
  });
  await runtime.ready;
  database = await runtime.getD1Database('DB', workerName);
  shadowArtifacts = await runtime.getR2Bucket('SHADOW_EXTRACTION_ARTIFACTS', workerName);
  await applyMigrations(database);
  for (const [index, postingId] of [postingA, postingB].entries()) {
    await database.prepare(`INSERT INTO catalog_items(pk, sk, kind, value) VALUES (?, 'META', 'internship', ?)`)
      .bind(`JOB#${jobId(postingId)}`, JSON.stringify(jobDocument(postingId, index))).run();
  }
});

after(async () => {
  await runtime?.dispose();
});

/** Serves the fabricated board as a chunked JSON stream. */
function boardServer(calls) {
  return async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    calls.push(url);
    if (url !== boardUrl) return new Response('unexpected outbound request', { status: 502 });
    let index = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (index >= board.byteLength) return controller.close();
        controller.enqueue(board.slice(index, index + 65_536));
        index += 65_536;
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } });
  };
}

/** Delivers one batch of messages to the compiled destination-verification consumer. */
async function deliver(bodies, injectedFetch) {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  const settled = bodies.map(() => ({ ack: 0, retry: [] }));
  globalThis.fetch = injectedFetch;
  try {
    await builtWorker.queue({ queue: destinationVerificationQueue, messages: bodies.map((body, index) => ({
      id: `delivery-${Date.now()}-${index}`, body, attempts: 1, timestamp: new Date(),
      ack() { settled[index].ack += 1; },
      retry(options, error) { settled[index].retry.push({ options, error: error instanceof Error ? error.message : error }); },
    })) }, {
      DB: database,
      DESTINATION_BROWSER: { fetch: async () => { throw new Error('the e2e runtime has no browser binding'); } },
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
  return settled;
}

test('streams a fabricated multi-megabyte board and persists the posting artifact', async () => {
  const calls = [];
  const [settled] = await deliver([collectionMessage(postingA, 'ashby-single')], boardServer(calls));
  assert.deepEqual(settled.retry, [], JSON.stringify(settled.retry));
  assert.equal(settled.ack, 1);
  assert.deepEqual(calls, [boardUrl], 'the consumer reads the provider board once');
  const objects = (await shadowArtifacts.list()).objects;
  assert.equal(objects.length, 1, 'the streamed artifact must reach the shadow handoff');
  console.log(`ashby e2e single: board=${board.byteLength}B artifacts=${objects.length}`);
});

test('one batch acquires every posting the same board publishes', async () => {
  const before = (await shadowArtifacts.list()).objects.length;
  assert.equal(before, 1, 'the previous test must have persisted exactly posting A');
  // The regression under review: two postings from the same board in one batch.
  // Production runs one acquirer per batch (max_batch_size 5), so this is the
  // normal shape, not an edge case. A and B hash to different artifact keys, so
  // a healthy run adds exactly one new object (B) while A is rewritten.
  const calls = [];
  const [first, second] = await deliver(
    [collectionMessage(postingA, 'ashby-batch-a'), collectionMessage(postingB, 'ashby-batch-b')], boardServer(calls));
  assert.deepEqual(first.retry, [], `first message retried: ${JSON.stringify(first.retry)}`);
  assert.deepEqual(second.retry, [], `second message retried: ${JSON.stringify(second.retry)}`);
  assert.equal(first.ack, 1);
  assert.equal(second.ack, 1);
  const after = (await shadowArtifacts.list()).objects.length;
  console.log(`ashby e2e batch: board=${board.byteLength}B fetches=${calls.length} artifacts=${after}`);
  assert.equal(calls.length, 1, 'the board must be fetched once for the whole batch so the provider is not throttled');
  assert.equal(after, before + 1,
    'each posting in the batch must persist its own artifact; one artifact means the second posting was served the first posting\'s streamed payload');
});
