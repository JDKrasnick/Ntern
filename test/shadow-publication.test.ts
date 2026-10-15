import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseShadowPublicationPolicy, policyAllows, shadowExtractionEvidence, shadowPublicationFields } from '../src/shadow-publication.js';
import cloudflareWorker, { type Environment } from '../cloudflare/worker.js';
import { reconcileRoleMetadata, projectRoleMetadata, mergeRoleMetadataEvidence, ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PREPROCESSING_VERSION, SHADOW_EXTRACTION_PROMPT_VERSION,
  SHADOW_EXTRACTION_SCHEMA_VERSION, type ShadowExtraction } from '../src/shadow-extraction.js';
import type { Internship, RoleMetadataEvidence } from '../src/types.js';
import type { R2Bucket } from '../cloudflare/types.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { publishProspectiveShadowMetadata, naturalShadowCohortSql } from '../cloudflare/shadow-publication.js';
import { mergeSourceOccurrence } from '../src/identity/source-occurrence.js';

const hash = 'a'.repeat(64);
const releaseApproval = { model: SHADOW_EXTRACTION_MODEL_ID, prompt: SHADOW_EXTRACTION_PROMPT_VERSION,
  schema: SHADOW_EXTRACTION_SCHEMA_VERSION, preprocessing: SHADOW_EXTRACTION_PREPROCESSING_VERSION,
  approvedAt: '2026-10-15T16:00:00.000Z', reason: 'Owner approves all seven fields after model evaluation and source spot checks.' };

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
    '0026_shadow_extraction_origin.sql', '0032_shadow_extraction_input_completeness.sql', '0033_shadow_publication_projection.sql', '0055_shadow_natural_cohort.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  database.prepare(`INSERT INTO shadow_extraction_runs
    (run_key, job_id, source_id, external_id, source_url, posting_identity, content_hash, model_id, prompt_version,
      schema_version, preprocessing_version, state, input_key, response_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`).run(
    hash, 'job-1', 'greenhouse-acme', '123', 'https://jobs.example/123', '{}', hash, SHADOW_EXTRACTION_MODEL_ID,
    SHADOW_EXTRACTION_PROMPT_VERSION, SHADOW_EXTRACTION_SCHEMA_VERSION, SHADOW_EXTRACTION_PREPROCESSING_VERSION, 'input', 'response',
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
  it('binds release approval to the exact profile and requires it for a historical prospective cohort', () => {
    const policy = { enabled: true, version: 'full-metadata-2026-10-v1', mode: 'prospective-provider-poll',
      startsAt: '2026-09-24T03:20:27.000Z', allowedFields: [...shadowPublicationFields], maxReceipts: null,
      cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }], releaseApproval };
    expect(parseShadowPublicationPolicy(JSON.stringify(policy)).enabled).toBe(true);
    for (const key of ['model', 'prompt', 'schema', 'preprocessing'] as const) {
      expect(parseShadowPublicationPolicy(JSON.stringify({ ...policy, releaseApproval: { ...releaseApproval, [key]: 'different' } })).enabled).toBe(false);
    }
    expect(parseShadowPublicationPolicy(JSON.stringify({ ...policy, releaseApproval: undefined })).enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ ...policy, cohort: [...policy.cohort, ...policy.cohort] })).enabled).toBe(false);
  });

  it('publishes all seven validated fields from an approved exact revision without inventing human evaluations', async () => {
    const { database, artifacts } = await publicationDatabase();
    const full = structuredClone(extraction);
    full.fields.compensation = { status: 'present', value: [{ min: 40, max: 50, currency: 'USD', period: 'hour' }],
      evidence: ['$40–$50 USD per hour'], qualifiers: ['Pay depends on degree level.'] };
    for (const [field, quote] of [['housing', 'No housing or relocation assistance.'], ['timing', 'January–June 2027, 40 hours per week.'],
      ['education', 'Currently pursuing a bachelor’s degree.'], ['eligibility', 'Must have permission to work in the US; sponsorship is unavailable.']] as const) {
      full.fields[field] = { status: 'present', value: [quote], evidence: [quote], qualifiers: [] };
    }
    const validation = { accepted: full, failures: [], fieldOutcomes: [] };
    await artifacts.put('response', new TextEncoder().encode(JSON.stringify({ validation })).buffer);
    for (const field of shadowPublicationFields) database.prepare(`INSERT OR REPLACE INTO shadow_extraction_field_outcomes
      (run_key, field, status, accepted) VALUES (?, ?, 'present', 1)`).run(hash, field);
    const policy = { enabled: true, version: 'full-metadata-2026-10-v1', allowedFields: [...shadowPublicationFields],
      cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }], releaseApproval };
    const env = { OPERATIONS_SHARED_SECRET: 'secret', PUBLIC_API_URL: 'https://intern-notifs.test', DB: d1(database), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
      LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) } as unknown as Environment;
    const send = (action: string, extra = {}) => cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
      method: 'POST', headers: { 'X-Operations-Key': 'secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, runKey: hash, acceptedFields: [...shadowPublicationFields], ...extra }),
    }), env);
    expect((await send('create-receipt')).status).toBe(409);
    const response = await send('publish-approved', { deferProjection: true });
    expect(response.status).toBe(200);
    const result = await response.json() as { publishedFields: string[] };
    expect(result.publishedFields).toHaveLength(7);
    const jobs = new D1InternshipStore(d1(database));
    const job = (await jobs.getJob('job-1'))!;
    expect(job.postingFacts).toHaveLength(7);
    expect(job.postingFacts?.find(fact => fact.field === 'compensation')?.statements).toEqual(['USD 40–50/hour']);
    expect(job.postingFacts?.find(fact => fact.field === 'workMode')?.statements).toEqual(['Onsite']);
    const publicResponse = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/jobs/job-1'), env);
    expect(publicResponse.status).toBe(200);
    expect((await publicResponse.json() as { postingFacts: unknown[] }).postingFacts).toHaveLength(7);
    expect(job.postingFacts?.find(fact => fact.field === 'housing')?.statements).toEqual(['No housing or relocation assistance.']);
    expect(job.postingFacts?.find(fact => fact.field === 'eligibility')?.statements[0]).toContain('sponsorship is unavailable');
    expect(job.compensation.ranges?.[0]).toMatchObject({ minAmount: 40, maxAmount: 50 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM shadow_extraction_evaluations').get()).toEqual({ count: 0 });
    // More than one approved field subset may create receipts for the same run.
    expect((await send('publish-approved', { acceptedFields: ['locations'], deferProjection: true })).status).toBe(200);
    expect(database.prepare('SELECT projected_at FROM shadow_publication_receipts').get()).toEqual({ projected_at: null });
    expect((await send('refresh-approved', { runKeys: [hash, 'b'.repeat(64)] })).status).toBe(409);
    expect((await send('refresh-approved', { runKeys: [hash] })).status).toBe(200);
    expect(database.prepare('SELECT projected_at FROM shadow_publication_receipts').get()).not.toEqual({ projected_at: null });
    expect((await send('publish-approved')).status).toBe(200);
    expect(database.prepare('SELECT COUNT(*) AS count FROM shadow_publication_receipts').get()).toEqual({ count: 2 });
    database.prepare(`UPDATE shadow_extraction_posting_revisions SET content_hash = ?`).run('b'.repeat(64));
    expect((await send('publish-approved')).status).toBe(409);
    const replacement = shadowExtractionEvidence({ extraction, sourceId: 'greenhouse-acme', sourceUrl: 'https://jobs.example/123',
      contentHash: 'b'.repeat(64), observedAt: new Date().toISOString(), extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, allowedFields: ['locations'] })!;
    const revised = projectRoleMetadata({ ...job, sourceReferences: job.sourceReferences.map(ref => ({ ...ref,
      metadataEvidence: mergeRoleMetadataEvidence(ref.metadataEvidence, [replacement]) })) }).job;
    expect(revised.postingFacts?.map(fact => fact.field)).toEqual(['locations']);
    expect(revised.postingFacts?.[0]?.contentHash).toBe('b'.repeat(64));
    const previous = { ...job.sourceReferences[0]!, shadowContentHash: 'a'.repeat(64), shadowMetadataHash: 'c'.repeat(64) };
    const changed = mergeSourceOccurrence(previous, { ...previous, metadataEvidence: [], shadowMetadataHash: 'd'.repeat(64) });
    expect(changed.metadataEvidence).toEqual([]);
    expect(projectRoleMetadata({ ...job, sourceReferences: [changed] }).job.postingFacts).toBeUndefined();
  });

  it('keeps independent verification mandatory for an explicitly approved prospective release', async () => {
    const { database, artifacts } = await publicationDatabase();
    const policy = { enabled: true, version: 'full-metadata-2026-10-v1', mode: 'prospective-provider-poll',
      startsAt: '2026-09-24T00:00:00.000Z', allowedFields: [...shadowPublicationFields], cohort: [], maxReceipts: null, releaseApproval };
    database.prepare(`UPDATE shadow_extraction_runs SET origin='provider-poll', input_completeness='complete',
      created_at='2026-10-15T00:00:00.000Z', completed_at='2026-10-15T00:00:00.000Z'`).run();
    database.prepare(`UPDATE shadow_extraction_posting_revisions SET observed_at='2026-10-15T00:00:00.000Z'`).run();
    await artifacts.put('response', new TextEncoder().encode(JSON.stringify({ validation: { accepted: extraction, failures: [] },
      verification: { policyVersion: policy.version, startsAt: policy.startsAt, acceptedFields: ['locations'] } })).buffer);
    const env = { DB: d1(database), DOCUMENTS: new MemoryR2(), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
      LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) };
    expect(await publishProspectiveShadowMetadata(env, async () => undefined)).toEqual({ result: 'projected', runKey: hash });
    const job = (await new D1InternshipStore(d1(database)).getJob('job-1'))!;
    expect(job.postingFacts?.map(fact => fact.field)).toEqual(['locations']);
    expect(database.prepare('SELECT COUNT(*) AS count FROM shadow_extraction_evaluations').get()).toEqual({ count: 0 });
  });
  it('hides the runtime probe from unauthenticated callers', async () => {
    const { database } = await publicationDatabase();
    const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-extraction/probe',
      { method: 'POST' }), { OPERATIONS_SHARED_SECRET: 'secret', DB: d1(database) } as unknown as Environment);
    expect(response.status).toBe(404);
  });
  it('finds the first current-version completions through a covering index without sorting history', async () => {
    const { database } = await publicationDatabase();
    seedRolloutQualityGate(database);
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${naturalShadowCohortSql}`).all(SHADOW_EXTRACTION_MODEL_ID,
      SHADOW_EXTRACTION_PROMPT_VERSION, SHADOW_EXTRACTION_SCHEMA_VERSION, SHADOW_EXTRACTION_PREPROCESSING_VERSION, 25);
    expect(JSON.stringify(plan)).toContain('shadow_extraction_natural_cohort');
    expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
  });
  it('fails closed for absent, malformed, duplicate, and unsupported policies', () => {
    expect(parseShadowPublicationPolicy(undefined).enabled).toBe(false);
    expect(parseShadowPublicationPolicy('{oops').enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['unsupported'], cohort: [] })).enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['locations', 'locations'], cohort: [] })).enabled).toBe(false);
  });

  it('requires all three exact cohort identity parts', () => {
    const policy = parseShadowPublicationPolicy(JSON.stringify({ enabled: true, version: 'v1', allowedFields: ['locations'], cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] }));
    expect(policyAllows(policy, { sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash })).toBe(true);
    expect(policyAllows(policy, { sourceId: 'greenhouse-acme', externalId: '124', contentHash: hash })).toBe(false);
  });

  it('accepts an explicit unlimited prospective cap but keeps its field and time gates', () => {
    const policy = { enabled: true, version: 'prospective-provider-poll-2026-09-v1', mode: 'prospective-provider-poll',
      startsAt: '2026-09-24T03:20:27.000Z', allowedFields: ['compensation', 'locations'], cohort: [], maxReceipts: null };
    expect(parseShadowPublicationPolicy(JSON.stringify(policy)).maxReceipts).toBeNull();
    expect(parseShadowPublicationPolicy(JSON.stringify({ ...policy, maxReceipts: undefined })).enabled).toBe(false);
    expect(parseShadowPublicationPolicy(JSON.stringify({ ...policy, allowedFields: ['unsupported'] })).enabled).toBe(false);
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
    database.prepare("UPDATE shadow_extraction_runs SET model_id = 'previous-model' WHERE run_key = ?").run(hash);
    database.prepare('DELETE FROM shadow_extraction_evaluations WHERE run_key != ?').run(hash);
    expect(await createReceipt(database, artifacts, 'v2', ['workMode'])).toEqual(repeated);
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

  it('publishes only verified post-activation provider observations and resumes once', async () => {
    const { database, artifacts } = await publicationDatabase();
    const policy = { enabled: true, version: 'prospective-provider-poll-2026-09-test', mode: 'prospective-provider-poll',
      startsAt: '2026-09-24T00:00:00.000Z', allowedFields: ['locations'], cohort: [], maxReceipts: 1 };
    const env = { DB: d1(database), DOCUMENTS: new MemoryR2(), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
      LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) };
    let refreshes = 0;
    const refresh = async () => { refreshes += 1; };
    database.prepare(`UPDATE shadow_extraction_runs SET origin = 'backfill', input_completeness = 'complete',
      created_at = '2026-09-26T00:01:00.000Z', completed_at = '2026-09-26T00:01:00.000Z', model_id = ?, prompt_version = ?, schema_version = ?, preprocessing_version = ? WHERE run_key = ?`)
      .run(SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PROMPT_VERSION, SHADOW_EXTRACTION_SCHEMA_VERSION, SHADOW_EXTRACTION_PREPROCESSING_VERSION, hash);
    database.prepare(`UPDATE shadow_extraction_posting_revisions SET observed_at = '2026-09-26T00:01:00.000Z'`).run();
    await artifacts.put('response', new TextEncoder().encode(JSON.stringify({ validation: { accepted: extraction, failures: [] },
      verification: { policyVersion: policy.version, startsAt: policy.startsAt, acceptedFields: ['locations'] } })).buffer);
    expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({ result: 'none' });
    database.prepare("UPDATE shadow_extraction_runs SET origin = 'provider-poll' WHERE run_key = ?").run(hash);
    expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({ result: 'quality-gate-pending', runKey: hash });
    expect((database.prepare('SELECT COUNT(*) AS count FROM shadow_publication_receipts').get() as { count: number }).count).toBe(0);
    expect(refreshes).toBe(0);
    seedRolloutQualityGate(database);
    expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({ result: 'projected', runKey: hash });
    expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({ result: 'none' });
    expect(refreshes).toBe(1);
    expect((database.prepare('SELECT COUNT(*) AS count FROM shadow_publication_receipts').get() as { count: number }).count).toBe(1);
    // An already authorized projection can resume after the active model
    // changes, even while the new version's review cohort is pending.
    database.prepare("UPDATE shadow_extraction_runs SET model_id = 'previous-model' WHERE run_key = ?").run(hash);
    database.prepare('DELETE FROM shadow_extraction_evaluations').run();
    database.prepare('UPDATE shadow_publication_receipts SET projected_at = NULL').run();
    // An earlier unreceipted current-version candidate must not starve recovery.
    database.prepare(`INSERT INTO shadow_extraction_runs
      (run_key, job_id, source_id, external_id, source_url, posting_identity, content_hash, model_id, prompt_version,
       schema_version, preprocessing_version, state, input_key, response_key, created_at, updated_at, origin, input_completeness)
      SELECT ?, job_id, source_id, external_id, source_url, posting_identity, content_hash, ?, prompt_version,
        schema_version, preprocessing_version, state, input_key, response_key, '2026-09-25T00:00:00.000Z', updated_at, origin, input_completeness
      FROM shadow_extraction_runs WHERE run_key = ?`).run('b'.repeat(64), SHADOW_EXTRACTION_MODEL_ID, hash);
    expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({ result: 'projected', runKey: hash });
    expect(refreshes).toBe(2);
    expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({ result: 'quality-gate-pending', runKey: 'b'.repeat(64) });
  });

  it.each(['closed', 'detached', 'transient'] as const)(
    'continues past a %s receipt recovery after a projection failure', async recovery => {
      const { database, artifacts } = await publicationDatabase();
      seedRolloutQualityGate(database);
      const policy = { enabled: true, version: 'recovery-lifecycle-test', mode: 'prospective-provider-poll',
        startsAt: '2026-09-24T00:00:00.000Z', allowedFields: ['locations'], cohort: [], maxReceipts: null };
      database.prepare(`UPDATE shadow_extraction_runs SET origin = 'provider-poll', input_completeness = 'complete',
        created_at = '2026-09-26T00:01:00.000Z', completed_at = '2026-09-26T00:01:00.000Z' WHERE run_key = ?`).run(hash);
      database.prepare("UPDATE shadow_extraction_posting_revisions SET observed_at = '2026-09-26T00:01:00.000Z'").run();
      await artifacts.put('response', new TextEncoder().encode(JSON.stringify({ validation: { accepted: extraction, failures: [] },
        verification: { policyVersion: policy.version, startsAt: policy.startsAt, acceptedFields: ['locations'] } })).buffer);
      const env = { DB: d1(database), DOCUMENTS: new MemoryR2(), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
        LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) };
      await expect(publishProspectiveShadowMetadata(env, async () => { throw new Error('temporary projection failure'); }))
        .rejects.toThrow('temporary projection failure');
      const jobs = new D1InternshipStore(env.DB);
      const job = (await jobs.getJob('job-1'))!;
      if (recovery === 'closed') await jobs.putInternship({ ...job, open: false });
      if (recovery === 'detached') await jobs.putInternship({ ...job, sourceReferences: [] });
      const nextRun = 'b'.repeat(64);
      await jobs.putInternship({ ...job, jobId: 'job-2', open: true, normalizedUrl: 'https://jobs.example/124', fingerprint: 'second',
        location: 'Location not specified', sourceReferences: job.sourceReferences.map(reference => ({ ...reference, externalId: '124', metadataEvidence: [] })) });
      database.prepare(`INSERT INTO shadow_extraction_runs
        (run_key, job_id, source_id, external_id, source_url, posting_identity, content_hash, model_id, prompt_version,
          schema_version, preprocessing_version, state, input_key, response_key, created_at, completed_at, updated_at, origin, input_completeness)
        SELECT ?, 'job-2', source_id, '124', source_url, posting_identity, content_hash, model_id, prompt_version,
          schema_version, preprocessing_version, state, input_key, response_key, '2026-09-27T00:01:00.000Z', completed_at,
          updated_at, origin, input_completeness FROM shadow_extraction_runs WHERE run_key = ?`).run(nextRun, hash);
      database.prepare(`INSERT INTO shadow_extraction_posting_revisions (job_id, source_id, external_id, content_hash, observed_at)
        VALUES ('job-2', 'greenhouse-acme', '124', ?, '2026-09-27T00:01:00.000Z')`).run(hash);
      let refreshes = 0;
      const refresh = async () => { refreshes += 1; };
      expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({
        result: recovery === 'transient' ? 'projected' : 'skipped', runKey: hash,
      });
      expect(database.prepare('SELECT result FROM shadow_publication_decisions WHERE run_key = ?').get(hash))
        .toEqual({ result: recovery === 'transient' ? 'receipted' : 'skipped' });
      expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({ result: 'projected', runKey: nextRun });
      expect(await publishProspectiveShadowMetadata(env, refresh)).toEqual({ result: 'none' });
      expect(refreshes).toBe(recovery === 'transient' ? 2 : 1);
      const projected = (await jobs.getJob('job-2'))!;
      expect(projected.location).toBe('Austin, TX');
      expect(projected.notification).toEqual({ smsPending: false, digestPending: false });
      expect(database.prepare('SELECT projected_at FROM shadow_publication_receipts WHERE run_key = ?').get(nextRun))
        .toMatchObject({ projected_at: expect.any(String) });
    });

  it('publishes a verified provider run after the old receipt cap is reached', async () => {
    const { database, artifacts } = await publicationDatabase();
    const policy = { enabled: true, version: 'prospective-provider-poll-2026-09-test', mode: 'prospective-provider-poll',
      startsAt: '2026-09-24T00:00:00.000Z', allowedFields: ['locations'], cohort: [], maxReceipts: null };
    database.prepare(`UPDATE shadow_extraction_runs SET origin = 'provider-poll', input_completeness = 'complete',
      created_at = '2026-09-26T00:01:00.000Z', completed_at = '2026-09-26T00:01:00.000Z', model_id = ?, prompt_version = ?, schema_version = ?, preprocessing_version = ? WHERE run_key = ?`)
      .run(SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PROMPT_VERSION, SHADOW_EXTRACTION_SCHEMA_VERSION, SHADOW_EXTRACTION_PREPROCESSING_VERSION, hash);
    database.prepare(`UPDATE shadow_extraction_posting_revisions SET observed_at = '2026-09-26T00:01:00.000Z'`).run();
    seedRolloutQualityGate(database);
    for (let index = 0; index < 25; index += 1) {
      database.prepare(`INSERT INTO shadow_publication_receipts
        (receipt_id, job_id, source_id, external_id, content_hash, run_key, policy_version, accepted_fields, evidence_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`prior-${index}`, 'job-1', 'greenhouse-acme', `prior-${index}`, hash, hash,
          policy.version, '["locations"]', `prior-${index}`, '2026-09-24T00:00:00.000Z');
    }
    await artifacts.put('response', new TextEncoder().encode(JSON.stringify({ validation: { accepted: extraction, failures: [] },
      verification: { policyVersion: policy.version, startsAt: policy.startsAt, acceptedFields: ['locations'] } })).buffer);
    const env = { DB: d1(database), DOCUMENTS: new MemoryR2(), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
      LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) };
    expect(await publishProspectiveShadowMetadata(env, async () => {})).toEqual({ result: 'projected', runKey: hash });
    expect((database.prepare('SELECT COUNT(*) AS count FROM shadow_publication_receipts').get() as { count: number }).count).toBe(26);
  });

  it('does not use a current model review cohort to publish an older model output', async () => {
    const { database, artifacts } = await publicationDatabase();
    seedRolloutQualityGate(database);
    const policy = { enabled: true, version: 'old-model-test', mode: 'prospective-provider-poll',
      startsAt: '2026-09-24T00:00:00.000Z', allowedFields: ['locations'], cohort: [], maxReceipts: null };
    database.prepare(`UPDATE shadow_extraction_runs SET origin = 'provider-poll', input_completeness = 'complete',
      created_at = '2026-09-26T00:01:00.000Z', model_id = 'previous-model' WHERE run_key = ?`).run(hash);
    database.prepare(`UPDATE shadow_extraction_posting_revisions SET observed_at = '2026-09-26T00:01:00.000Z'`).run();
    await artifacts.put('response', new TextEncoder().encode(JSON.stringify({ validation: { accepted: extraction, failures: [] },
      verification: { policyVersion: policy.version, startsAt: policy.startsAt, acceptedFields: ['locations'] } })).buffer);
    const env = { DB: d1(database), DOCUMENTS: new MemoryR2(), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
      LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify(policy) };
    expect(await publishProspectiveShadowMetadata(env, async () => {})).toEqual({ result: 'none' });
    expect((database.prepare('SELECT COUNT(*) AS count FROM shadow_publication_receipts').get() as { count: number }).count).toBe(0);
  });

  it.each(['model_id', 'prompt_version', 'schema_version', 'preprocessing_version'] as const)(
    'rejects a new manual receipt with stale %s even when the current review gate passes', async column => {
      const { database, artifacts } = await publicationDatabase();
      seedRolloutQualityGate(database);
      database.prepare(`UPDATE shadow_extraction_runs SET ${column} = 'previous-version' WHERE run_key = ?`).run(hash);
      database.prepare(`INSERT INTO shadow_extraction_evaluations (run_key, field, outcome, evaluated_at)
        VALUES (?, 'locations', 'correct-present', '2026-10-14T00:00:00.000Z')`).run(hash);
      const response = await cloudflareWorker.fetch(new Request('https://intern-notifs.test/internal/operations/shadow-publication', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'secret' },
        body: JSON.stringify({ action: 'create-receipt', runKey: hash, acceptedFields: ['locations'] }),
      }), { OPERATIONS_SHARED_SECRET: 'secret', DB: d1(database), SHADOW_EXTRACTION_ARTIFACTS: artifacts,
        LLM_METADATA_PUBLICATION_POLICY_JSON: JSON.stringify({ enabled: true, version: 'manual-stale', allowedFields: ['locations'],
          cohort: [{ sourceId: 'greenhouse-acme', externalId: '123', contentHash: hash }] }) } as unknown as Environment);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: 'New receipts require the current model/prompt/schema/preprocessing version' });
      expect(database.prepare('SELECT COUNT(*) AS count FROM shadow_publication_receipts').get()).toEqual({ count: 0 });
    });
});
