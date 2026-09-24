import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

// Node's global constructor; the eslint `no-undef` rule does not know Node globals in this file.
const { Response } = globalThis;

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
/**
 * Fixtures must track the versions the workers actually run: a stale copy here
 * leaves seeded rows looking out of date, so the poller re-resolves them instead
 * of reusing and the reuse assertions fail.
 */
async function readConstant(relativePath, name) {
  const match = new RegExp(`${name} = (\\d+)`).exec(await readFile(join(repositoryRoot, relativePath), 'utf8'));
  if (!match) throw new Error(`${name} not found in ${relativePath}`);
  return Number(match[1]);
}
const roleMetadataExtractionVersion = await readConstant('src/role-metadata.ts', 'ROLE_METADATA_EXTRACTION_VERSION');
const sourceMetadataProcessingRevision = await readConstant('src/ingestion/processor.ts', 'SOURCE_METADATA_PROCESSING_REVISION');
/** Mirrors src/poll.ts: applicationPageMetadataVersion = ROLE_METADATA_EXTRACTION_VERSION + 1. */
const applicationPageMetadataVersion = roleMetadataExtractionVersion + 1;
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
          GREENHOUSE_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-greenhouse' },
          LEVER_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-lever' },
          ASHBY_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-ashby' },
          GITHUB_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-github' },
          GMAIL_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-gmail' },
          DESTINATION_VERIFICATION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-destination-verification' },
          DESTINATION_VERIFICATION_DLQ: { type: 'queue', name: 'intern-notifs-e2e-destination-verification-dlq' },
          SHADOW_EXTRACTION_QUEUE: { type: 'queue', name: 'intern-notifs-e2e-shadow-extraction' },
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
    unconfirmedSources: [],
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

test('passes real expanded-family roles and blocks malformed roles through repair and the public catalog', async () => {
  const database = await runtime.getD1Database('DB', apiWorkerName);
  const makeJob = (jobId, applyUrl, firstSeenAt) => ({
    jobId, company: 'Acme', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl, normalizedUrl: applyUrl, fingerprint: `fingerprint-${jobId}`, compensation: { raw: '' },
    sourceReferences: [{
      sourceId: 'community-list', externalId: jobId, document: jobId, sourceUrl: 'https://example.test/source', row: 1,
      company: 'Acme', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
      applyUrl, compensation: { raw: '' }, state: 'open',
    }],
    open: true, technical: true, firstSeenAt, catalogVisibleAt: firstSeenAt,
    lastSeenAt: '2026-09-19T00:00:00.000Z', notification: { smsPending: false, digestPending: false },
  });
  const olderUrl = 'https://apply.workable.com/acme-e2e/j/ABC123DEF0';
  // The non-tracking query keeps the canonical URLs distinct, so this merge
  // depends on the scoped provider identity rather than URL canonicalization.
  const newerUrl = `${olderUrl}/?department=engineering`;
  const familyCases = [
    ['eu-greenhouse', 'https://job-boards.eu.greenhouse.io/imc/jobs/4667854101', 'https://job-boards.eu.greenhouse.io/imc/jobs/software-engineer'],
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/ALTEN/744000142128541-ingenieur-developpeur-frontend-h-f-', 'https://jobs.smartrecruiters.com/ALTEN/software-engineer-intern'],
    ['successfactors', 'https://career4.successfactors.com/careers?career_ns=job_listing&company=colgate&career_job_req_id=169295', 'https://career4.successfactors.com/careers?career_ns=job_listing&career_job_req_id=169295'],
    ['workable', 'https://apply.workable.com/activate-interactive-pte-ltd/j/1AD6CF565A/', 'https://apply.workable.com/activate-interactive-pte-ltd/'],
    ['workable-apply', 'https://apply.workable.com/connectprep/j/D1C67258C0/apply', 'https://apply.workable.com/connectprep/j/software-engineer/apply'],
    ['microsoft', 'https://apply.careers.microsoft.com/careers/job/1970393556862170', 'https://apply.careers.microsoft.com/careers/job/software-engineer'],
    ['rippling', 'https://ats.rippling.com/4ag/jobs/71d97d10-87f2-4f53-88b7-97f27f392d24', 'https://ats.rippling.com/4ag/jobs/--------'],
    ['rippling-locale', 'https://ats.rippling.com/en-GB/greengas/jobs/b2938290-cc66-4f54-9888-bbe286c1d9b6', 'https://ats.rippling.com/en-GB/greengas/jobs/software-engineer'],
    ['eightfold', 'https://bostonscientific.eightfold.ai/careers/job/563602813483103', 'https://bostonscientific.eightfold.ai/careers'],
    ['paylocity', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4341435', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/software-engineer'],
    ['jobvite', 'https://jobs.jobvite.com/aarete/job/oBXLAfwD', 'https://jobs.jobvite.com/aarete/job/'],
    ['amazon', 'https://amazon.jobs/en/jobs/10394156/2026-fall-applied-science-internship', 'https://amazon.jobs/en/jobs/10394156software-engineer'],
    ['amazon-apply', 'https://www.amazon.jobs/jobs/10418355/apply', 'https://www.amazon.jobs/jobs/10418355software-engineer/apply'],
    ['google', 'https://www.google.com/about/careers/applications/jobs/results/100028133205254854', 'https://www.google.com/about/careers/applications/jobs/results/software-engineer'],
    ['custom-icims', 'https://careers.amd.com/jobs/90743?icims=1', 'https://careers.amd.com/jobs/software-engineer'],
    ['custom-successfactors', 'https://jobs.l3harris.com/job/Bristol/Software-Engineering-Intern-PA-19007/1428452600/?ats=successfactors', 'https://jobs.l3harris.com/job/Bristol/software-engineer'],
    ['myworkdaysite', 'https://wd1.myworkdaysite.com/recruiting/imeg/Imeg_Careers/job/Chicago-IL/Electrical-Engineering-Intern_R-16476', 'https://wd1.myworkdaysite.com/Imeg_Careers/openings/Electrical-Engineering-Intern_R-16476'],
    ['eu-lever', 'https://jobs.eu.lever.co/quantinuum/46b3f32c-a2ad-4d4d-bff6-b1bbebf3e382/apply', 'https://jobs.eu.lever.co/quantinuum/software-engineer/apply'],
    ['taleo', 'https://textron.taleo.net/careersection/textron/jobdetail.ftl?job=342550', 'https://textron.taleo.net/careersection/textron/moresearch.ftl?job=342550'],
    ['apple', 'https://jobs.apple.com/en-us/details/200664323/software-phd-internships', 'https://jobs.apple.com/en-us/details/software-intern'],
    ['bamboohr', 'https://lunaroutpost.bamboohr.com/careers/390/', 'https://lunaroutpost.bamboohr.com/careers/'],
    ['adp', 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=2cc1abe5-fdf4-41ed-b82d-9b34c651ef79&jobId=574462', 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?jobId=574462'],
    ['avature', 'https://pomerleau.avature.net/en_US/Jobs/JobDetail/3476', 'https://pomerleau.avature.net/en_US/Jobs/JobDetail/software-engineer'],
    ['employer-route', 'https://career.mlp.com/careers/job/755957778821', 'https://career.mlp.com/careers/search?job=755957778821'],
    ['pinpoint', 'https://impulsespace.pinpointhq.com/en/postings/2b03cd5d-4a58-48a0-81f4-ea8c8c7bcd2a', 'https://impulsespace.pinpointhq.com/en/postings/software-engineer'],
    ['applytojob', 'https://neboagency.applytojob.com/apply/AFMqe9Jb7b/Web-Development-Intern', 'https://neboagency.applytojob.com/apply/'],
    ['gusto', 'https://jobs.gusto.com/postings/single-grain-llc-ai-automation-internship-120b7ba9-6a00-4379-b022-0592f78fc3e6', 'https://jobs.gusto.com/postings/software-engineering-intern'],
  ];
  const matrixJobs = familyCases.flatMap(([family, goodUrl, badUrl]) => [
    makeJob(`matrix-${family}-good`, goodUrl, '2026-09-17T00:00:00.000Z'),
    makeJob(`matrix-${family}-bad`, badUrl, '2026-09-17T00:00:00.000Z'),
  ]);
  for (const value of [
    makeJob('workable-e2e-old', olderUrl, '2026-09-17T00:00:00.000Z'),
    makeJob('workable-e2e-new', newerUrl, '2026-09-18T00:00:00.000Z'),
    ...matrixJobs,
  ]) {
    await database.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, ?, ?)')
      .bind(`JOB#${value.jobId}`, 'META', 'internship', JSON.stringify(value)).run();
  }

  const previewResponse = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({ scope: 'identity', jobBatch: 1 }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.duplicateGroups, 1);
  assert.equal(preview.duplicateJobs, 1);
  assert.deepEqual(preview.conflicts, []);
  assert.ok(preview.samples.some((sample) => sample.canonicalJobId === 'workable-e2e-old'
    && sample.duplicateJobIds.includes('workable-e2e-new')
    && sample.providerIdentity === 'workable:acme-e2e:abc123def0'));

  const applyResponse = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({
      apply: true, scope: 'identity', jobBatch: 1, repairToken: preview.repairToken,
      expectedChanges: preview.expectedChanges, expectedDuplicateJobs: preview.duplicateJobs,
    }),
  });
  const applied = await applyResponse.json();
  assert.equal(applyResponse.status, 200, JSON.stringify(applied));
  assert.equal(applied.verification.expectedChanges, 0);
  assert.equal(applied.verification.duplicateJobs, 0);

  // A completed identity merge retires job IDs while the durable occurrence row
  // that named one of them stays behind. Seed exactly that shape, then repair it
  // through the paged occurrence path the production operation uses.
  const retiredOccurrence = {
    sourceId: 'community-list', externalId: 'workable-e2e-new', jobId: 'workable-e2e-new',
    occurrence: {
      sourceId: 'community-list', externalId: 'workable-e2e-new', document: 'workable-e2e-new',
      sourceUrl: 'https://example.test/source', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'New York', season: 'summer-2027', applyUrl: newerUrl, compensation: { raw: '' }, state: 'open',
    },
    present: true, consecutiveOmissions: 0, changedSnapshotHash: 'e2e', changedAt: '2026-09-18T00:00:00.000Z',
  };
  await database.prepare(`INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id)
    VALUES ('SOURCE#community-list', 'OCCURRENCE#workable-e2e-new', 'source-occurrence', ?, 'community-list', 'workable-e2e-new')`)
    .bind(JSON.stringify(retiredOccurrence)).run();

  const occurrencePreviewResponse = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({ scope: 'occurrences' }),
  });
  assert.equal(occurrencePreviewResponse.status, 200);
  const occurrencePreview = await occurrencePreviewResponse.json();
  assert.deepEqual(occurrencePreview.conflicts, []);
  assert.equal(occurrencePreview.canonicalJobs, 1);
  assert.equal(occurrencePreview.danglingOccurrences, 1);
  assert.ok(occurrencePreview.batches.length > 0);
  for (const batch of occurrencePreview.batches) {
    assert.ok(batch.jobIds.length <= 100 && batch.occurrenceKeys.length <= 125 && batch.contextRows.length <= 125);
    const batchResponse = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
      body: JSON.stringify({
        apply: true, scope: 'occurrences', finalize: false,
        applyBatch: { jobIds: batch.jobIds, contextRows: batch.contextRows, occurrenceKeys: batch.occurrenceKeys },
        repairToken: batch.repairToken, expectedChanges: batch.expectedChanges, expectedDuplicateJobs: batch.expectedDuplicateJobs,
        acceptCurrentSnapshot: true,
        expectedEligibleDuplicateGroups: batch.eligibleDuplicateGroups,
        expectedUnresolvedDuplicateGroups: batch.unresolvedDuplicateGroups,
      }),
    });
    const applied = await batchResponse.json();
    assert.equal(batchResponse.status, 200, JSON.stringify(applied));
    assert.equal(applied.applied, true);
  }
  const movedRow = await database.prepare("SELECT value FROM catalog_items WHERE pk = 'SOURCE#community-list' AND sk = 'OCCURRENCE#workable-e2e-new'").first();
  assert.equal(JSON.parse(movedRow.value).jobId, 'workable-e2e-old');
  assert.deepEqual((await (await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({ scope: 'occurrences' }),
  })).json()).expectedChanges, 0);
  // The catalog-wide occurrence apply is gone: repair applies one signed batch.
  const refusedResponse = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({
      apply: true, scope: 'occurrences', repairToken: occurrencePreview.batches[0].repairToken,
      expectedChanges: occurrencePreview.batches[0].expectedChanges, expectedDuplicateJobs: 0,
    }),
  });
  assert.equal(refusedResponse.status, 409);
  assert.equal(await refusedResponse.json().then((body) => body.message), 'Occurrence repair applies one signed batch at a time; send applyBatch');

  // The paged occurrence scope only reaches canonical jobs an identity merge
  // named. Reference classification for the rest of the catalog stays with the
  // catalog-wide repair, which the expanded-family matrix below still verifies.
  const catalogPreviewResponse = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({ scope: 'all', jobBatch: 1 }),
  });
  assert.equal(catalogPreviewResponse.status, 200);
  const catalogPreview = await catalogPreviewResponse.json();
  assert.deepEqual(catalogPreview.conflicts, []);
  const catalogApplyResponse = await api.fetch('https://api.example.test/internal/posting-identity-repair', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret },
    body: JSON.stringify({
      apply: true, scope: 'all', jobBatch: 1, repairToken: catalogPreview.repairToken,
      expectedChanges: catalogPreview.expectedChanges, expectedDuplicateJobs: catalogPreview.duplicateJobs,
    }),
  });
  const catalogApplied = await catalogApplyResponse.json();
  assert.equal(catalogApplyResponse.status, 200, JSON.stringify(catalogApplied));
  assert.equal(catalogApplied.verification.expectedChanges, 0);
  const refreshResponse = await api.fetch('https://api.example.test/internal/refresh-catalog', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': operationsSecret }, body: '{}',
  });
  assert.equal(refreshResponse.status, 200);

  for (const [family] of familyCases) {
    for (const expectedStatus of ['good', 'bad']) {
      const jobId = `matrix-${family}-${expectedStatus}`;
      const row = await database.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'META'")
        .bind(`JOB#${jobId}`).first();
      assert.ok(row, `missing durable ${jobId}`);
      const stored = JSON.parse(row.value);
      const status = expectedStatus === 'good' ? 'confirmed' : 'unconfirmed';
      assert.equal(stored.postingIdentityStatus, status, jobId);
      assert.equal(stored.sourceReferences[0].postingIdentityDecision.status, status, jobId);
    }
  }

  const catalogResponse = await api.fetch('https://api.example.test/jobs?limit=100');
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.ok(catalog.jobs.some((job) => job.jobId === 'workable-e2e-old'));
  assert.ok(!catalog.jobs.some((job) => job.jobId === 'workable-e2e-new'));
  for (const [family] of familyCases) {
    assert.ok(catalog.jobs.some((job) => job.jobId === `matrix-${family}-good`), family);
    assert.ok(!catalog.jobs.some((job) => job.jobId === `matrix-${family}-bad`), family);
  }
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
  const cacheKey = sha256([normalized.contentHash, 'gpt-5-mini-2025-08-07', 'shadow-extraction-prompt-v34',
    'shadow-extraction-schema-v5', 'exact-posting-markdown-v2'].join('\0'));
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
  assert.deepEqual(row, { state: 'disabled', attempts: 1, error: 'live model execution disabled by runtime flag' });
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

test('reconnects D1 inside each compiled destination queue consumer before queue settlement', async () => {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  for (const [queue, settlement] of [
    ['intern-notifs-destination-verification', 'retry'],
    ['intern-notifs-shadow-extraction', 'ack'],
  ]) {
    let firstCalls = 0;
    const statement = {
      bind() { return statement; },
      async first() {
        firstCalls += 1;
        if (firstCalls === 1) throw new Error('Connection closed');
        return null;
      },
      async all() { return { results: [] }; },
      async run() { return { meta: { changes: 0 } }; },
    };
    const database = { prepare() { return statement; }, async batch() { return []; } };
    const calls = { ack: 0, retry: [] };

    await builtWorker.queue({
      queue,
      messages: [{ id: `compiled-reconnect-${settlement}`, body: 'not-json', attempts: 1,
        ack() { calls.ack += 1; }, retry(options) { calls.retry.push(options); } }],
    }, { DB: database });

    assert.equal(firstCalls, 2, `${queue} must retry the transient D1 disconnect in-request`);
    if (settlement === 'retry') {
      assert.deepEqual(calls.retry, [{ delaySeconds: 300 }]);
      assert.equal(calls.ack, 0);
    } else {
      assert.equal(calls.ack, 1);
      assert.deepEqual(calls.retry, []);
    }
  }
});

// Payload generators copied from test/fixtures/production-scale.ts. The e2e file
// runs under bare `node --test`, which cannot import a TypeScript fixture, so the
// generators live here byte-for-byte while the sizing constants stay documented.
const productionScaleApplicationHosts = ['careers-a.example.test', 'careers-b.example.test'];
const productionScaleApplyUrl = (index) => `https://${productionScaleApplicationHosts[index % productionScaleApplicationHosts.length]}/board/role-${index}`;

/** Deterministic pseudo-random lowercase filler of exactly `length` characters. */
function pseudoRandomText(length, seed) {
  const bytes = Buffer.allocUnsafe(length);
  let state = (seed >>> 0) || 1;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = 97 + ((state >>> 26) % 26);
  }
  return bytes.toString('latin1');
}

function syntheticMarkdownTable({ rows, bytesPerRow, format = 'gfm', seed = 7 }) {
  const row = (index, detail) => format === 'gfm'
    ? `| Acme ${index} | Software Engineering Intern | Remote | [Apply](${productionScaleApplyUrl(index)}) | ${detail} |`
    : `<tr><td><strong>Acme ${index}</strong></td><td>Software Engineering Intern</td><td>Remote</td>`
      + `<td><a href="${productionScaleApplyUrl(index)}">Apply</a></td><td>${detail}</td></tr>`;
  const detailLength = Math.max(0, bytesPerRow - row(0, '').length - 1);
  const parts = format === 'gfm'
    ? ['| Company | Role | Location | Apply | Detail |', '| --- | --- | --- | --- | --- |']
    : ['# Board', '', '<table>', '<thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Detail</th></tr></thead>', '<tbody>'];
  for (let index = 0; index < rows; index += 1) {
    parts.push(row(index, pseudoRandomText(detailLength, seed + index)));
    if (format !== 'gfm' && index % 4 === 3) parts.push('');
  }
  parts.push(format === 'gfm' ? '' : '</tbody></table>');
  return `${parts.join('\n')}\n`;
}

function syntheticGreenhouseBoard({ jobs, bytesPerJob, boardToken, seed = 11 }) {
  const detailLength = Math.max(0, bytesPerJob - 600);
  return Array.from({ length: jobs }, (_, index) => ({
    id: 900_000 + index,
    internal_job_id: 500_000 + index,
    title: 'Software Engineering Intern',
    updated_at: '2026-09-10T12:00:00-04:00',
    // The reviewed board's allowed application host is boards.greenhouse.io, so the
    // generated row keeps the pre-migration Greenhouse host the adapter re-canonicalizes.
    absolute_url: `https://boards.greenhouse.io/${boardToken}/jobs/${900_000 + index}`,
    location: { name: 'Remote' },
    departments: [{ id: 1, name: 'Engineering' }],
    offices: [{ id: 2, name: 'Remote' }],
    content: `<div>${pseudoRandomText(detailLength, seed + index)}</div>`,
  }));
}

function syntheticLeverPages({ postingsPerPage, bytesPerPosting, site, seed = 13 }) {
  const detailLength = Math.max(0, bytesPerPosting - 400);
  return Array.from({ length: postingsPerPage }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    return {
      id,
      text: 'Software Engineering Intern, Summer 2027',
      applyUrl: `https://jobs.lever.co/${site}/${id}/apply`,
      hostedUrl: `https://jobs.lever.co/${site}/${id}`,
      descriptionPlain: pseudoRandomText(detailLength, seed + index),
      createdAt: 1_783_072_000_000 + index * 1_000,
      categories: { location: 'New York, NY', commitment: 'Internship' },
      workplaceType: 'hybrid',
    };
  });
}

function syntheticAshbyBoard({ postings, bytesPerPosting, board, seed = 17 }) {
  const detailLength = Math.max(0, bytesPerPosting - 400);
  return {
    apiVersion: '1',
    jobs: Array.from({ length: postings }, (_, index) => {
      const id = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
      return {
        id,
        title: 'Software Engineer Intern',
        location: 'New York',
        secondaryLocations: [],
        isListed: true,
        isRemote: false,
        workplaceType: 'Hybrid',
        descriptionHtml: `<p>${pseudoRandomText(detailLength, seed + index)}</p>`,
        descriptionPlain: null,
        publishedAt: '2026-08-09T12:00:00.000+00:00',
        employmentType: 'Intern',
        jobUrl: `https://jobs.ashbyhq.com/${board}/${id}`,
        applyUrl: `https://jobs.ashbyhq.com/${board}/${id}/application`,
      };
    }),
  };
}

test('keeps a production-scale scheduled cycle recoverable without direct dead letters', async () => {
  const bundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');
  const cycleWorkerName = 'intern-notifs-e2e-cycle';
  const cycleRuntime = new Miniflare({ workers: [
    await createWorkerConfig(cycleWorkerName, bundleDirectory, 'ingestion-worker.js', {
      DEPLOYMENT_ROLE: { type: 'text', value: 'ingestion' },
      DB: { type: 'd1', id: cycleWorkerName },
    }),
  ] });
  await cycleRuntime.ready;
  const database = await cycleRuntime.getD1Database('DB', cycleWorkerName);
  await applyMigrations(database);
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));

  const scheduledAt = '2026-09-15T12:00:00.000Z';
  // Reviewed sources that exist in the deployed registry, so the compiled worker
  // resolves each queued sourceId without a catalog write of its own.
  const githubSourceId = 'vanshb03-summer-2027';
  const githubDocuments = [
    { path: 'README.md', season: 'summer-2027', rows: 1_785, format: 'gfm' },
    { path: 'OFFSEASON_README.md', season: 'offseason-2027', rows: 1_244, format: 'html' },
  ];
  const greenhouseSourceId = 'greenhouse-figma';
  const greenhouseBoardToken = 'figma';
  const leverSourceId = 'lever-palantir';
  const leverSite = 'palantir';
  const ashbySourceId = 'ashby-pylon-labs';
  const ashbyBoardKey = 'pylon-labs';
  const sourceIds = [githubSourceId, greenhouseSourceId, leverSourceId, ashbySourceId];

  const documents = new Map(githubDocuments.map((document) => [
    `https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/${document.path}`,
    syntheticMarkdownTable({ rows: document.rows, bytesPerRow: 900, format: document.format }),
  ]));
  const githubRows = githubDocuments.reduce((total, document) => total + document.rows, 0);
  const greenhouseJobs = syntheticGreenhouseBoard({ jobs: 300, bytesPerJob: 8_000, boardToken: greenhouseBoardToken });
  const leverPostings = syntheticLeverPages({ postingsPerPage: 100, bytesPerPosting: 5_000, site: leverSite });
  const ashbyBoard = syntheticAshbyBoard({ postings: 200, bytesPerPosting: 5_000, board: ashbyBoardKey });

  // Every destination is pre-validated in D1 for the ATS providers, and the
  // reviewed-community rows are validated against a synthetic employer page
  // served here. No host outside this router is ever contacted.
  const employerPage = (url) => {
    const role = /role-(\d+)$/u.exec(new URL(url).pathname)?.[1] ?? '0';
    return '<!doctype html><html><head>'
      + `<title>Software Engineering Intern - Acme ${role}</title>`
      + `<meta name="description" content="Software engineering internship at Acme ${role}.">`
      + '</head><body><main>'
      + `<h1>Software Engineering Intern</h1><p>${'Join our engineering team to build internship tooling with a mentor. '.repeat(8)}</p>`
      + `<h2>Responsibilities</h2><p>${'Ship features behind review and keep the systems observable. '.repeat(8)}</p>`
      + '<h2>Requirements</h2><p>Current enrollment in a computer science or related program, and experience with at least one systems language.</p>'
      + '</main></body></html>';
  };
  const requestedUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requestedUrls.push(url);
    const { hostname, searchParams } = new URL(url);
    if (hostname === 'raw.githubusercontent.com') return new Response(documents.get(url) ?? '', { status: 200 });
    if (hostname === 'boards-api.greenhouse.io') return Response.json({ jobs: greenhouseJobs, meta: { total: greenhouseJobs.length } });
    if (hostname === 'api.lever.co') return Response.json(Number(searchParams.get('skip') ?? 0) === 0 ? leverPostings : []);
    if (hostname === 'api.ashbyhq.com') return Response.json(ashbyBoard);
    if (hostname.endsWith('.example.test')) {
      return init?.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        : new Response(employerPage(url), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    throw new Error(`unexpected provider request ${url}`);
  };

  const seededAt = '2026-09-14T12:00:00.000Z';
  const seedRows = [];
  const seedCatalogItem = (pk, sk, kind, value, columns = {}) => {
    const names = Object.keys(columns);
    const placeholders = Array.from({ length: 4 + names.length }, () => '?').join(', ');
    const updates = ['kind = excluded.kind', 'value = excluded.value', ...names.map((name) => `${name} = excluded.${name}`)];
    seedRows.push(database.prepare(
      `INSERT INTO catalog_items (pk, sk, kind, value${names.length ? `, ${names.join(', ')}` : ''}) VALUES (${placeholders})
      ON CONFLICT(pk, sk) DO UPDATE SET ${updates.join(', ')}`,
    ).bind(pk, sk, kind, JSON.stringify(value), ...names.map((name) => columns[name])));
  };
  const seedJob = ({ jobId, company, title, location, season, applyUrl, normalizedUrl, sourceReferences }) => {
    const job = {
      jobId, company, title, location, season, applyUrl, normalizedUrl,
      fingerprint: `e2e-fingerprint-${jobId}`,
      compensation: { raw: '' },
      requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false },
      sourceReferences, technical: true, open: true,
      firstSeenAt: seededAt, catalogVisibleAt: seededAt, lastSeenAt: seededAt,
      notification: { smsPending: false, digestPending: false },
      applicationUrlValidatedAt: seededAt,
      applicationPageMetadataVersion,
    };
    seedCatalogItem(`JOB#${jobId}`, 'META', 'internship', job, { url_key: normalizedUrl, catalog_state: 'OPEN' });
  };
  const seedSource = (sourceId, checkpoint) => {
    seedCatalogItem(`SOURCE#${sourceId}`, 'CHECKPOINT', 'checkpoint', checkpoint);
    seedCatalogItem(`SOURCE#${sourceId}`, 'HEALTH', 'source-health', {
      sourceId, state: 'healthy', sourceStatus: 'active', lastAttemptAt: seededAt, lastSuccessAt: seededAt,
      consecutiveFailures: 0, durationMs: 1_000,
    });
  };

  // GitHub rows carry no provider identity, so the poller only reuses a catalog row
  // whose occurrence reference matches the snapshot externalId exactly.
  const githubReferences = new Map();
  for (const document of githubDocuments) {
    for (let index = 0; index < document.rows; index += 1) {
      const applyUrl = productionScaleApplyUrl(index);
      const reference = {
        sourceId: githubSourceId, externalId: `${document.path}:${applyUrl}`, document: document.path,
        applyUrl, company: `Acme ${index}`, title: 'Software Engineering Intern',
        location: 'Remote', season: document.season, state: 'open', compensation: { raw: '' },
      };
      githubReferences.set(applyUrl, [...(githubReferences.get(applyUrl) ?? []), reference]);
    }
  }
  [...githubReferences.entries()].forEach(([applyUrl, sourceReferences], index) => seedJob({
    jobId: `e2e-github-${index}`, company: `Acme ${index}`, title: 'Software Engineering Intern', location: 'Remote',
    season: 'summer-2027', applyUrl, normalizedUrl: applyUrl, sourceReferences,
  }));
  const atsReference = ({ sourceId, externalId, applyUrl, company, title, location }) => ({
    sourceId, externalId, document: externalId, applyUrl, company, title, location,
    season: 'summer-2027', state: 'open', compensation: { raw: '' },
  });
  greenhouseJobs.forEach((job, index) => seedJob({
    jobId: `e2e-greenhouse-${index}`, company: 'Figma', title: job.title, location: job.location.name,
    season: 'summer-2027', applyUrl: job.absolute_url,
    normalizedUrl: `https://job-boards.greenhouse.io/${greenhouseBoardToken}/jobs/${job.id}`,
    sourceReferences: [atsReference({ sourceId: greenhouseSourceId, externalId: String(job.id), applyUrl: job.absolute_url,
      company: 'Figma', title: job.title, location: job.location.name })],
  }));
  leverPostings.forEach((posting, index) => seedJob({
    jobId: `e2e-lever-${index}`, company: 'Palantir Technologies', title: posting.text,
    location: posting.categories.location, season: 'summer-2027', applyUrl: posting.applyUrl,
    normalizedUrl: posting.applyUrl,
    sourceReferences: [atsReference({ sourceId: leverSourceId, externalId: posting.id, applyUrl: posting.applyUrl,
      company: 'Palantir Technologies', title: posting.text, location: posting.categories.location })],
  }));
  ashbyBoard.jobs.forEach((posting, index) => seedJob({
    jobId: `e2e-ashby-${index}`, company: 'Pylon', title: posting.title, location: posting.location,
    season: 'summer-2027', applyUrl: posting.applyUrl,
    normalizedUrl: `https://jobs.ashbyhq.com/${ashbyBoardKey}/${posting.id}`,
    sourceReferences: [atsReference({ sourceId: ashbySourceId, externalId: posting.id, applyUrl: posting.applyUrl,
      company: 'Pylon', title: posting.title, location: posting.location })],
  }));
  const githubActiveExternalIds = githubDocuments.flatMap((document) =>
    Array.from({ length: document.rows }, (_, index) => `${document.path}:${productionScaleApplyUrl(index)}`));
  seedSource(githubSourceId, {
    sourceId: githubSourceId, successfulFetches: 1, lastSuccessAt: seededAt, contentHash: 'e2e-github-content-hash',
    lastRowCount: githubRows, lastRawCount: githubRows, activeExternalIds: githubActiveExternalIds,
    metadataExtractionVersion: roleMetadataExtractionVersion, metadataProcessingRevision: sourceMetadataProcessingRevision,
  });
  seedSource(greenhouseSourceId, {
    sourceId: greenhouseSourceId, successfulFetches: 1, lastSuccessAt: seededAt, contentHash: 'e2e-greenhouse-content-hash',
    lastRowCount: greenhouseJobs.length, lastRawCount: greenhouseJobs.length,
    activeExternalIds: greenhouseJobs.map((job) => String(job.id)),
  });
  seedSource(leverSourceId, {
    sourceId: leverSourceId, successfulFetches: 1, lastSuccessAt: seededAt, contentHash: 'e2e-lever-content-hash',
    lastRowCount: leverPostings.length, lastRawCount: leverPostings.length,
    activeExternalIds: leverPostings.map((posting) => posting.id),
  });
  seedSource(ashbySourceId, {
    sourceId: ashbySourceId, successfulFetches: 1, lastSuccessAt: seededAt, contentHash: 'e2e-ashby-content-hash',
    lastRowCount: ashbyBoard.jobs.length, lastRawCount: ashbyBoard.jobs.length,
    activeExternalIds: ashbyBoard.jobs.map((posting) => posting.id),
  });
  for (let offset = 0; offset < seedRows.length; offset += 100) await database.batch(seedRows.slice(offset, offset + 100));

  const failureRows = async () => (await database.prepare('SELECT COUNT(*) AS count FROM queue_failure_events').first()).count;
  const failuresBefore = await failureRows();

  const recorder = () => ({ sent: [], async send(message) { this.sent.push(message); } });
  // A direct DLQ write would be a bug (the platform owns dead-lettering after the
  // configured retries), so the recorder fails loudly instead of passing silently.
  const deadLetterRecorder = () => ({
    sent: [],
    async send(message) {
      this.sent.push(message);
      throw new Error(`a cycle that acknowledges every message must not dead-letter: ${JSON.stringify(message)}`);
    },
  });
  const queues = { github: recorder(), greenhouse: recorder(), lever: recorder(), ashby: recorder(), destinationVerification: recorder() };
  const deadLetters = {
    github: deadLetterRecorder(), greenhouse: deadLetterRecorder(), lever: deadLetterRecorder(),
    ashby: deadLetterRecorder(), destinationVerification: deadLetterRecorder(),
  };
  const acks = [];
  const retries = [];
  const queued = (queue, sourceId, body) => {
    const id = `${queue}:${sourceId}`;
    return { id, body, attempts: 1, timestamp: new Date(scheduledAt),
      ack() { acks.push(id); },
      retry(options) { retries.push({ id, options }); } };
  };
  const environment = {
    DB: database,
    GITHUB_QUEUE: queues.github, GREENHOUSE_QUEUE: queues.greenhouse,
    LEVER_QUEUE: queues.lever, ASHBY_QUEUE: queues.ashby,
    GITHUB_DLQ: deadLetters.github, GREENHOUSE_DLQ: deadLetters.greenhouse,
    LEVER_DLQ: deadLetters.lever, ASHBY_DLQ: deadLetters.ashby,
    DESTINATION_VERIFICATION_QUEUE: queues.destinationVerification,
    DESTINATION_VERIFICATION_DLQ: deadLetters.destinationVerification,
    IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'false',
    TRUSTED_COMMUNITY_CATALOG_ENABLED: 'false',
    PUBLIC_API_URL: 'https://api.example.test',
  };
  const workMessage = (sourceId) => ({ version: 1, sourceId, scheduledAt });

  await builtWorker.queue({ queue: 'intern-notifs-github',
    messages: [queued('intern-notifs-github', githubSourceId, { sourceId: githubSourceId })] }, environment);
  await builtWorker.queue({ queue: 'intern-notifs-greenhouse',
    messages: [queued('intern-notifs-greenhouse', greenhouseSourceId, workMessage(greenhouseSourceId))] }, environment);
  await builtWorker.queue({ queue: 'intern-notifs-lever',
    messages: [queued('intern-notifs-lever', leverSourceId, workMessage(leverSourceId))] }, environment);
  await builtWorker.queue({ queue: 'intern-notifs-ashby',
    messages: [queued('intern-notifs-ashby', ashbySourceId, workMessage(ashbySourceId))] }, environment);

  const checkpoints = new Map();
  for (const sourceId of sourceIds) {
    const row = await database.prepare('SELECT value FROM catalog_items WHERE pk = ? AND sk = ?').bind(`SOURCE#${sourceId}`, 'CHECKPOINT').first();
    checkpoints.set(sourceId, JSON.parse(row.value));
  }
  const githubCheckpoint = checkpoints.get(githubSourceId);
  const pendingResolutionRows = githubCheckpoint.pendingResolutionRows ?? [];
  const occurrenceRows = await database.prepare(
    "SELECT source_id, COUNT(*) AS count FROM catalog_items WHERE kind = 'source-occurrence' GROUP BY source_id").all();
  const occurrenceCounts = new Map(occurrenceRows.results.map((row) => [row.source_id, row.count]));
  const githubResolvedRows = githubRows - pendingResolutionRows.length;
  const failuresAfter = await failureRows();
  const reusedGithubJobs = await database.prepare(
    "SELECT COUNT(*) AS count FROM catalog_items WHERE pk LIKE 'JOB#e2e-github-%' AND json_extract(value, '$.lastSeenAt') <> ?")
    .bind(seededAt).first();
  await cycleRuntime.dispose();
  globalThis.fetch = originalFetch;

  const deliveryIds = [
    `intern-notifs-github:${githubSourceId}`, `intern-notifs-greenhouse:${greenhouseSourceId}`,
    `intern-notifs-lever:${leverSourceId}`, `intern-notifs-ashby:${ashbySourceId}`,
  ];
  const retriedIds = new Set(retries.map(({ id }) => id));
  assert.ok(retries.every(({ id }) => deliveryIds.includes(id)),
    'only the source message that failed persistence may be returned to the platform');
  assert.ok(acks.every((id) => !retriedIds.has(id)),
    'a failed source message must not acknowledge before the platform retries it');
  assert.equal(new Set([...acks, ...retriedIds]).size, deliveryIds.length,
    'every scheduled source message must either acknowledge or request a durable platform retry');
  assert.deepEqual([...new Set([...acks, ...retriedIds])].sort(), [...deliveryIds].sort());
  for (const [name, deadLetter] of Object.entries(deadLetters)) {
    assert.deepEqual(deadLetter.sent, [], `${name} dead-letter queue must stay empty`);
  }
  assert.equal(failuresAfter, failuresBefore + retries.length,
    'each transient persistence failure must be recorded before the platform retries it');
  assert.deepEqual([...new Set(requestedUrls.map((url) => new URL(url).hostname))].sort(), [
    'api.ashbyhq.com', 'api.lever.co', 'boards-api.greenhouse.io', 'careers-a.example.test', 'careers-b.example.test',
    'raw.githubusercontent.com',
  ], 'only the four provider endpoints and the two synthetic employer hosts may be fetched');
  assert.equal(reusedGithubJobs.count, githubResolvedRows,
    'the poller should reuse the seeded catalog rows for the resolved slice');
  const deliveryBySourceId = new Map([
    [githubSourceId, `intern-notifs-github:${githubSourceId}`],
    [greenhouseSourceId, `intern-notifs-greenhouse:${greenhouseSourceId}`],
    [leverSourceId, `intern-notifs-lever:${leverSourceId}`],
    [ashbySourceId, `intern-notifs-ashby:${ashbySourceId}`],
  ]);
  for (const sourceId of sourceIds) {
    const deliveryId = deliveryBySourceId.get(sourceId);
    assert.equal(checkpoints.get(sourceId).successfulFetches, retriedIds.has(deliveryId) ? 1 : 2,
      `${sourceId} must either persist its second fetch or retain its last safe checkpoint for platform retry`);
  }
  assert.equal(githubCheckpoint.activeExternalIds.length, githubRows);
  for (const sourceId of sourceIds) {
    assert.ok((occurrenceCounts.get(sourceId) ?? 0) > 0, `${sourceId} should persist resolved source occurrences`);
  }
  assert.ok((occurrenceCounts.get(githubSourceId) ?? 0) >= githubResolvedRows,
    'every row resolved from the 3,029-row source should persist an occurrence');
  assert.ok(pendingResolutionRows.length > 0 && githubRows - pendingResolutionRows.length <= 100,
    'the bounded resolution pass should defer the remainder of a 3,029-row source');
  assert.deepEqual(queues.github.sent, [{ sourceId: githubSourceId }], 'the deferred rows must re-enqueue exactly once');
  assert.deepEqual(queues.greenhouse.sent, []);
  assert.deepEqual(queues.lever.sent, []);
  assert.deepEqual(queues.ashby.sent, []);
});
