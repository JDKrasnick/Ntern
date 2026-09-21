import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseShadowPublicationPolicy, policyAllows, shadowExtractionEvidence } from '../src/shadow-publication.js';
import cloudflareWorker, { type Environment } from '../cloudflare/worker.js';
import { reconcileRoleMetadata, ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PREPROCESSING_VERSION, SHADOW_EXTRACTION_PROMPT_VERSION,
  SHADOW_EXTRACTION_SCHEMA_VERSION, type ShadowExtraction } from '../src/shadow-extraction.js';
import type { Internship, RoleMetadataEvidence } from '../src/types.js';
import type { R2Bucket } from '../cloudflare/types.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';

const hash = 'a'.repeat(64);

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(query) {
      let values: SQLInputValue[] = [];
      const statement: D1PreparedStatement = {
        bind(...next) { values = next as SQLInputValue[]; return statement; },
        async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
        async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
        async run() { const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
      };
      return statement;
    },
    async batch(statements) { return Promise.all(statements.map(statement => statement.run())); },
  };
}

class MemoryR2 implements R2Bucket {
  values = new Map<string, Uint8Array>();
  async put(key: string, value: ArrayBuffer | ReadableStream | null) {
    if (!(value instanceof ArrayBuffer)) throw new Error('test requires array buffer');
    this.values.set(key, new Uint8Array(value));
  }
  async get(key: string) {
    const value = this.values.get(key);
    return value ? { size: value.byteLength, body: new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } }) } : null;
  }
  async delete(key: string) { this.values.delete(key); }
}

const extraction: ShadowExtraction = {
  classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software'] },
  fields: {
    compensation: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
    locations: { value: ['Austin, TX'], status: 'present', evidence: ['Location: Austin, TX'], qualifiers: [] },
    workMode: { value: 'On-site', status: 'present', evidence: ['Work mode: On-site'], qualifiers: [] },
    housing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, timing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
    education: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, eligibility: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
  },
};

async function publicationDatabase(): Promise<{ database: DatabaseSync; artifacts: MemoryR2 }> {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0003_billing_shutdown.sql', '0015_role_metadata_enrichment.sql', '0020_shadow_extraction.sql', '0021_shadow_extraction_fencing.sql',
    '0022_shadow_extraction_cache_expiry.sql', '0023_shadow_extraction_attempt_costs.sql', '0024_shadow_publication_receipts.sql', '0025_shadow_extraction_evaluations.sql',
    '0026_shadow_extraction_origin.sql', '0027_shadow_extraction_input_completeness.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  database.prepare(`INSERT INTO shadow_extraction_runs
    (run_key, job_id, source_id, external_id, source_url, posting_identity, content_hash, model_id, prompt_version,
      schema_version, preprocessing_version, state, input_key, response_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`).run(
    hash, 'job-1', 'greenhouse-acme', '123', 'https://jobs.example/123', '{}', hash, 'model', 'prompt', 'schema', 'preprocessing', 'input', 'response',
    '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z',
  );
  database.prepare(`INSERT INTO shadow_extraction_posting_revisions (job_id, source_id, external_id, content_hash, observed_at)
    VALUES (?, ?, ?, ?, ?)`).run('job-1', 'greenhouse-acme', '123', hash, '2026-09-08T00:00:00.000Z');
  for (const field of ['locations', 'workMode']) database.prepare(`INSERT INTO shadow_extraction_field_outcomes
    (run_key, field, status, accepted) VALUES (?, ?, 'present', 1)`).run(hash, field);
  database.prepare(`INSERT INTO shadow_extraction_baseline_differences
    (run_key, field, baseline_state, shadow_state, differs, recorded_at) VALUES (?, 'locations', 'present', 'present', 0, ?)`)
    .run(hash, '2026-09-08T00:00:00.000Z');
  database.prepare(`INSERT INTO shadow_extraction_baseline_differences
    (run_key, field, baseline_state, shadow_state, differs, recorded_at) VALUES (?, 'workMode', 'not-stated', 'present', 1, ?)`)
    .run(hash, '2026-09-08T00:00:00.000Z');
  const jobs = new D1InternshipStore(d1(database));
  const reference = { sourceId: 'greenhouse-acme', externalId: '123', document: 'source', sourceUrl: 'https://jobs.example/123', row: 1,
    company: 'Acme', title: 'Software Intern', location: 'Location not specified', season: 'summer-2027', applyUrl: 'https://jobs.example/123',
    compensation: { raw: '' }, state: 'open' as const };
  await jobs.putInternship({ jobId: 'job-1', company: 'Acme', title: 'Software Intern', location: 'Location not specified', season: 'summer-2027',
    applyUrl: 'https://jobs.example/123', normalizedUrl: 'https://jobs.example/123', fingerprint: 'fingerprint', compensation: { raw: '' },
    sourceReferences: [reference], technical: true, open: true, firstSeenAt: '2026-09-08T00:00:00.000Z', lastSeenAt: '2026-09-08T00:00:00.000Z',
    notification: { smsPending: false, digestPending: false } } satisfies Internship);
  const artifacts = new MemoryR2();
  const validation = { accepted: extraction, failures: [], fieldOutcomes: Object.entries(extraction.fields).map(([field, value]) => ({ field, status: value.status, accepted: true })) };
  await artifacts.put('response', new TextEncoder().encode(JSON.stringify({ response: extraction, validation })).buffer);
  return { database, artifacts };
}

function seedRolloutQualityGate(database: DatabaseSync): void {
  const fields = ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education', 'eligibility'] as const;
  for (let index = 1; index <= 25; index += 1) {
    const runKey = index.toString(16).padStart(64, '0');
    const timestamp = `2026-09-${String(index).padStart(2, '0')}T00:00:00.000Z`;
    database.prepare(`INSERT INTO shadow_extraction_runs
      (run_key, job_id, source_id, external_id, source_url, posting_identity, content_hash, model_id, prompt_version,
        schema_version, preprocessing_version, state, input_key, response_key, created_at, completed_at, updated_at, origin)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, 'provider-poll')`).run(
      runKey, `gate-job-${index}`, `greenhouse-gate-${index}`, String(index), `https://jobs.example/${index}`, runKey,
      SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PROMPT_VERSION, SHADOW_EXTRACTION_SCHEMA_VERSION,
      SHADOW_EXTRACTION_PREPROCESSING_VERSION, `input-${index}`, `response-${index}`, timestamp, timestamp, timestamp,
    );
    for (const field of fields) database.prepare(`INSERT INTO shadow_extraction_evaluations (run_key, field, outcome, evaluated_at)
      VALUES (?, ?, ?, ?)`).run(runKey, field, field === 'locations' || field === 'workMode' ? 'correct-present' : 'correct-absent', timestamp);
  }
}

async function createReceipt(database: DatabaseSync, artifacts: MemoryR2, version: string, acceptedFields: string[]) {
  const policy = { enabled: true, version, allowedFields: ['locations', 'workMode'],
    cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] };
  const environment = { OPERATIONS_SHARED_SECRET: 'secret', DB: d1(database), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
    LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) } as unknown as Environment;
  const evaluation = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'secret' },
    body: JSON.stringify({ action: 'record-evaluation', runKey: hash,
      evaluations: acceptedFields.map(field => ({ field, outcome: 'correct-present' })) }),
  }), environment);
  expect(evaluation.status).toBe(200);
  const evaluationBody = await evaluation.json() as { conformance: Array<{ field: string; baseline: string; advisory: string }> };
  expect(evaluationBody.conformance).toEqual(acceptedFields.map(field => field === 'locations'
    ? { field, baseline: 'present', advisory: 'deterministic-confirm' }
    : { field, baseline: 'not-stated', advisory: 'deterministic-conflict' }));
  const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'secret' },
    body: JSON.stringify({ action: 'create-receipt', runKey: hash, acceptedFields }),
  }), environment);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ receiptId: string; evidenceFingerprint: string }>;
}

describe('shadow publication policy', () => {
  it('fails closed for absent, malformed, duplicate, and unsupported policies', () => {
    expect(parseShadowPublicationPolicy(undefined).enabled).toBe(false);
    expect(parseShadowPublicationPolicy('{oops').enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['housing'], cohort: [] })).enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['locations', 'locations'], cohort: [] })).enabled).toBe(false);
  });

  it('requires all three exact cohort identity parts', () => {
    const policy = parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['locations'], cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] }));
    expect(policyAllows(policy, { sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash })).toBe(true);
    expect(policyAllows(policy, { sourceId: 'greenhouse-acme', externalId: '124', contentHash: hash })).toBe(false);
  });

  it('converts only supported, receipt-allowed fields with quoted provenance', () => {
    const extraction: ShadowExtraction = {
      classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software'] },
      fields: {
        compensation: { value: [{ min: 50, max: 60, currency: 'USD', period: 'hour' }], status: 'present', evidence: ['$50 - $60 per hour'], qualifiers: [] },
        locations: { value: ['Austin, TX'], status: 'present', evidence: ['Location: Austin, TX'], qualifiers: [] },
        workMode: { value: 'hybrid', status: 'present', evidence: ['Work mode: hybrid'], qualifiers: [] },
        housing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, timing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
        education: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, eligibility: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      },
    };
    const evidence = shadowExtractionEvidence({ extraction, sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123', contentHash: hash,
      observedAt: '2026-09-08T00:00:00.000Z', extractionVersion: 1, allowedFields: ['locations', 'workMode'] });
    expect(evidence?.compensationRanges).toBeUndefined();
    expect(evidence?.locations?.[0]).toMatchObject({ name: 'Austin, TX', workMode: 'unspecified' });
    expect(evidence?.workMode?.provenance[0]?.source).toBe('reviewed-shadow');
  });

  it('uses reviewed shadow fields only as fallback to direct official evidence', () => {
    const extraction: ShadowExtraction = {
      classification: { technical: 'yes', earlyCareer: 'yes', disciplines: ['software'] },
      fields: {
        compensation: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
        locations: { value: ['Austin, TX'], status: 'present', evidence: ['Location: Austin, TX'], qualifiers: [] },
        workMode: { value: 'hybrid', status: 'present', evidence: ['Work mode: hybrid'], qualifiers: [] },
        housing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, timing: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
        education: { value: null, status: 'not-stated', evidence: [], qualifiers: [] }, eligibility: { value: null, status: 'not-stated', evidence: [], qualifiers: [] },
      },
    };
    const shadow = shadowExtractionEvidence({ extraction, sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123', contentHash: hash,
      observedAt: '2026-09-08T00:00:00.000Z', extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, allowedFields: ['locations', 'workMode'] })!;
    const official: RoleMetadataEvidence = {
      schemaVersion: 1, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, artifactHash: 'official', sourceClass: 'official-page',
      sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123', observedAt: '2026-09-08T00:00:00.000Z', exactPosting: true,
      workMode: { value: 'remote', provenance: [{ source: 'official-page', sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123',
        contentHash: 'official', observedAt: '2026-09-08T00:00:00.000Z', evidenceCode: 'page-work-mode' }] },
    };
    const metadata = reconcileRoleMetadata([shadow, official]).metadata;
    expect(metadata?.workMode?.value).toBe('remote');
    expect(metadata?.locations?.[0]?.name).toBe('Austin, TX');
  });

  it('rejects publication before the selected field passes human evaluation', async () => {
    const { database, artifacts } = await publicationDatabase();
    const policy = { enabled: true, version: 'v1', allowedFields: ['locations'],
      cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] };
    const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'secret' },
      body: JSON.stringify({ action: 'create-receipt', runKey: hash, acceptedFields: ['locations'] }),
    }), { OPERATIONS_SHARED_SECRET: 'secret', DB: d1(database), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
      LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) } as unknown as Environment);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'Receipt fields have not passed human evaluation' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM shadow_publication_receipts').get()).toEqual({ count: 0 });
  });

  it('blocks new receipts until 25 natural current-version runs are fully reviewed', async () => {
    const { database, artifacts } = await publicationDatabase();
    const policy = { enabled: true, version: 'expanded-v1', allowedFields: ['locations'],
      cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] };
    database.prepare(`INSERT INTO shadow_extraction_evaluations (run_key, field, outcome, evaluated_at)
      VALUES (?, 'locations', 'correct-present', ?)`).run(hash, '2026-09-08T00:00:00.000Z');
    const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'secret' },
      body: JSON.stringify({ action: 'create-receipt', runKey: hash, acceptedFields: ['locations'] }),
    }), { OPERATIONS_SHARED_SECRET: 'secret', DB: d1(database), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
      LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) } as unknown as Environment);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'Natural production quality gate has not passed for: locations' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM shadow_publication_receipts').get()).toEqual({ count: 0 });
  });

  it('reports and passes the bounded natural quality gate without qualifying compensation on absent-only examples', async () => {
    const { database, artifacts } = await publicationDatabase();
    seedRolloutQualityGate(database);
    const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
      headers: { 'X-Operations-Key': 'secret' },
    }), { OPERATIONS_SHARED_SECRET: 'secret', DB: d1(database), SHADOW_EXTRACTION_ARTIFACTS: artifacts } as unknown as Environment);
    expect(response.status).toBe(200);
    const body = await response.json() as { rolloutQualityGate: {
      cohort: { targetRuns: number; selectedRuns: number; fullyReviewedRuns: number };
      fields: Record<string, { positiveExamples: number; precision: number | null; recall: number | null; passed: boolean }>;
    } };
    expect(body.rolloutQualityGate.cohort).toMatchObject({ targetRuns: 25, selectedRuns: 25, fullyReviewedRuns: 25 });
    expect(body.rolloutQualityGate.fields.locations).toMatchObject({ positiveExamples: 25, precision: 1, recall: 1, passed: true });
    expect(body.rolloutQualityGate.fields.workMode).toMatchObject({ positiveExamples: 25, precision: 1, recall: 1, passed: true });
    expect(body.rolloutQualityGate.fields.compensation).toMatchObject({ positiveExamples: 0, precision: null, recall: null, passed: false });
  });

  it('keeps the first completed cohort fixed when an older transient run completes later', async () => {
    const { database, artifacts } = await publicationDatabase();
    const delayedRunKey = 'b'.repeat(64);
    database.prepare(`INSERT INTO shadow_extraction_runs
      (run_key, job_id, source_id, external_id, source_url, posting_identity, content_hash, model_id, prompt_version,
        schema_version, preprocessing_version, state, input_key, created_at, updated_at, origin)
      VALUES (?, 'delayed-job', 'greenhouse-delayed', 'delayed', 'https://jobs.example/delayed', '{}', ?, ?, ?, ?, ?,
        'transient-failure', 'input-delayed', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', 'provider-poll')`).run(
      delayedRunKey, delayedRunKey, SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PROMPT_VERSION,
      SHADOW_EXTRACTION_SCHEMA_VERSION, SHADOW_EXTRACTION_PREPROCESSING_VERSION,
    );
    seedRolloutQualityGate(database);
    database.prepare(`UPDATE shadow_extraction_runs SET state = 'completed', response_key = 'response-delayed',
      completed_at = '2026-09-26T00:00:00.000Z', updated_at = '2026-09-26T00:00:00.000Z' WHERE run_key = ?`).run(delayedRunKey);

    const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
      headers: { 'X-Operations-Key': 'secret' },
    }), { OPERATIONS_SHARED_SECRET: 'secret', DB: d1(database), SHADOW_EXTRACTION_ARTIFACTS: artifacts } as unknown as Environment);
    expect(response.status).toBe(200);
    const body = await response.json() as { rolloutQualityGate: {
      cohort: { targetRuns: number; selectedRuns: number; fullyReviewedRuns: number };
      fields: Record<string, { passed: boolean }>;
    } };
    expect(body.rolloutQualityGate.cohort).toEqual({ targetRuns: 25, selectedRuns: 25, fullyReviewedRuns: 25,
      origins: ['provider-poll', 'scheduled-verification'] });
    expect(body.rolloutQualityGate.fields.locations.passed).toBe(true);
    expect(body.rolloutQualityGate.fields.workMode.passed).toBe(true);
  });

  it('keeps changed review decisions append-only and identical receipt creation idempotent', async () => {
    const { database, artifacts } = await publicationDatabase();
    seedRolloutQualityGate(database);
    const first = await createReceipt(database, artifacts, 'v1', ['locations']);
    const second = await createReceipt(database, artifacts, 'v2', ['workMode']);
    const repeated = await createReceipt(database, artifacts, 'v2', ['workMode']);
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(repeated).toEqual(second);
    const rows = database.prepare(`SELECT receipt_id, policy_version, accepted_fields, evidence_fingerprint
      FROM shadow_publication_receipts ORDER BY policy_version`).all();
    expect(rows).toEqual([
      { receipt_id: first.receiptId, policy_version: 'v1', accepted_fields: '["locations"]', evidence_fingerprint: first.evidenceFingerprint },
      { receipt_id: second.receiptId, policy_version: 'v2', accepted_fields: '["workMode"]', evidence_fingerprint: second.evidenceFingerprint },
    ]);
    const published = JSON.parse((database.prepare("SELECT value FROM catalog_items WHERE pk = 'JOB#job-1' AND sk = 'META'").get() as { value: string }).value) as Internship;
    expect(published.locations).toEqual(['Austin, TX']);
    expect(published.workMode).toBe('onsite');
    expect(published.notification).toEqual({ smsPending: false, digestPending: false });
  });
});
