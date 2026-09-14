import { createHash } from 'node:crypto';
import { mergeRoleMetadataEvidence, projectRoleMetadata, ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import {
  deterministicBaselineFields,
  fieldBaselineConformance,
  parseShadowPublicationPolicy,
  policyAllows,
  shadowExtractionEvidence,
  shadowPublicationFields,
  shadowPublicationFingerprint,
  shadowPublishableFields,
  type BaselineState,
  type ShadowPublicationField,
} from '../src/shadow-publication.js';
import { SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PREPROCESSING_VERSION, SHADOW_EXTRACTION_PROMPT_VERSION,
  SHADOW_EXTRACTION_SCHEMA_VERSION, type ShadowExtraction, type ShadowValidationResult } from '../src/shadow-extraction.js';
import { D1CatalogAdmissionStore } from './catalog-admission-store.js';
import { D1InternshipStore } from './d1-store.js';
import type { D1Database, R2Bucket } from './types.js';

const evaluationFields = ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education', 'eligibility'] as const;
type EvaluationField = typeof evaluationFields[number];
const evaluationOutcomes = ['correct-present', 'correct-absent', 'false-positive', 'false-negative', 'wrong-value', 'wrong-status'] as const;
type EvaluationOutcome = typeof evaluationOutcomes[number];
const maxArtifactBytes = 100_000;
const rolloutReviewTarget = 25;
const rolloutMetricFloor = 0.95;

interface RunRow {
  run_key: string;
  job_id: string;
  source_id: string;
  external_id: string;
  source_url: string;
  content_hash: string;
  response_key: string;
}

async function artifact(bucket: R2Bucket, key: string): Promise<{ extraction: ShadowExtraction; validation: ShadowValidationResult }> {
  const object = await bucket.get(key);
  if (!object || object.size === undefined || object.size > maxArtifactBytes) throw new Error('Validated extraction artifact is unavailable or oversized');
  const parsed = JSON.parse(await new Response(object.body).text()) as { validation?: ShadowValidationResult };
  if (!parsed.validation?.accepted || parsed.validation.failures.length) throw new Error('Extraction artifact is not validator-accepted');
  return { extraction: parsed.validation.accepted, validation: parsed.validation };
}

async function completedRun(db: D1Database, runKey: string): Promise<RunRow> {
  const run = await db.prepare(`SELECT run_key, job_id, source_id, external_id, source_url, content_hash, response_key
    FROM shadow_extraction_runs WHERE run_key = ? AND state = 'completed'`).bind(runKey).first<RunRow>();
  if (!run?.response_key) throw new Error('Completed extraction run was not found');
  return run;
}

async function currentRevision(db: D1Database, run: RunRow): Promise<{ observed_at: string }> {
  const revision = await db.prepare(`SELECT content_hash, observed_at FROM shadow_extraction_posting_revisions
    WHERE job_id = ? AND source_id = ? AND external_id = ?`).bind(run.job_id, run.source_id, run.external_id)
    .first<{ content_hash: string; observed_at: string }>();
  if (!revision || revision.content_hash !== run.content_hash) throw new Error('Posting revision is no longer current');
  return revision;
}

function evaluationMatches(field: { status: string }, outcome: EvaluationOutcome): boolean {
  if (outcome === 'correct-present' || outcome === 'false-positive' || outcome === 'wrong-value') return field.status === 'present';
  if (outcome === 'correct-absent') return field.status === 'not-stated';
  if (outcome === 'false-negative') return field.status !== 'present';
  return true;
}

async function evaluationSummary(db: D1Database) {
  const rows = await db.prepare(`SELECT e.field, e.outcome, r.model_id, r.prompt_version, r.schema_version, r.preprocessing_version, COUNT(*) AS count
    FROM shadow_extraction_evaluations e JOIN shadow_extraction_runs r ON r.run_key = e.run_key
    GROUP BY e.field, e.outcome, r.model_id, r.prompt_version, r.schema_version, r.preprocessing_version
    ORDER BY r.schema_version, e.field, e.outcome`).all<{ field: string; outcome: EvaluationOutcome; model_id: string; prompt_version: string;
      schema_version: string; preprocessing_version: string; count: number }>();
  const summarize = (selected: typeof rows.results) => Object.fromEntries(evaluationFields.map(field => {
    const counts = Object.fromEntries(evaluationOutcomes.map(outcome => [outcome, 0])) as Record<EvaluationOutcome, number>;
    for (const row of selected.filter(item => item.field === field)) counts[row.outcome] += row.count;
    const precisionDenominator = counts['correct-present'] + counts['false-positive'] + counts['wrong-value'];
    const recallDenominator = counts['correct-present'] + counts['false-negative'] + counts['wrong-value'];
    return [field, { ...counts, precision: precisionDenominator ? counts['correct-present'] / precisionDenominator : null,
      recall: recallDenominator ? counts['correct-present'] / recallDenominator : null }];
  }));
  const isCurrent = (row: typeof rows.results[number]) => row.model_id === SHADOW_EXTRACTION_MODEL_ID
    && row.prompt_version === SHADOW_EXTRACTION_PROMPT_VERSION && row.schema_version === SHADOW_EXTRACTION_SCHEMA_VERSION
    && row.preprocessing_version === SHADOW_EXTRACTION_PREPROCESSING_VERSION;
  return { version: { model: SHADOW_EXTRACTION_MODEL_ID, prompt: SHADOW_EXTRACTION_PROMPT_VERSION,
    schema: SHADOW_EXTRACTION_SCHEMA_VERSION, preprocessing: SHADOW_EXTRACTION_PREPROCESSING_VERSION },
  all: summarize(rows.results), current: summarize(rows.results.filter(isCurrent)),
  versions: rows.results.map(row => ({ model: row.model_id, prompt: row.prompt_version, schema: row.schema_version,
    preprocessing: row.preprocessing_version, field: row.field, outcome: row.outcome, count: row.count })) };
}

async function rolloutQualityGate(db: D1Database) {
  const rows = await db.prepare(`SELECT cohort.run_key, evaluations.field, evaluations.outcome
    FROM (
      SELECT run_key FROM shadow_extraction_runs
      WHERE state = 'completed' AND origin IN ('provider-poll', 'scheduled-verification')
        AND model_id = ? AND prompt_version = ? AND schema_version = ? AND preprocessing_version = ?
      ORDER BY completed_at, run_key
      LIMIT ?
    ) cohort
    LEFT JOIN shadow_extraction_evaluations evaluations ON evaluations.run_key = cohort.run_key
    ORDER BY cohort.run_key, evaluations.field`).bind(SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PROMPT_VERSION,
      SHADOW_EXTRACTION_SCHEMA_VERSION, SHADOW_EXTRACTION_PREPROCESSING_VERSION, rolloutReviewTarget)
    .all<{ run_key: string; field: string | null; outcome: EvaluationOutcome | null }>();
  const evaluationsByRun = new Map<string, Map<string, EvaluationOutcome>>();
  for (const row of rows.results) {
    const evaluations = evaluationsByRun.get(row.run_key) ?? new Map<string, EvaluationOutcome>();
    if (row.field && row.outcome) evaluations.set(row.field, row.outcome);
    evaluationsByRun.set(row.run_key, evaluations);
  }
  const reviewedRuns = [...evaluationsByRun.entries()].filter(([, evaluations]) =>
    evaluationFields.every(field => evaluations.has(field)) && evaluations.size === evaluationFields.length);
  const fields = Object.fromEntries(shadowPublicationFields.map(field => {
    const counts = Object.fromEntries(evaluationOutcomes.map(outcome => [outcome, 0])) as Record<EvaluationOutcome, number>;
    for (const [, evaluations] of reviewedRuns) {
      const outcome = evaluations.get(field);
      if (outcome) counts[outcome] += 1;
    }
    const precisionDenominator = counts['correct-present'] + counts['false-positive'] + counts['wrong-value'];
    const recallDenominator = counts['correct-present'] + counts['false-negative'] + counts['wrong-value'];
    const precision = precisionDenominator ? counts['correct-present'] / precisionDenominator : null;
    const recall = recallDenominator ? counts['correct-present'] / recallDenominator : null;
    return [field, { ...counts, precision, recall, positiveExamples: counts['correct-present'],
      passed: reviewedRuns.length === rolloutReviewTarget && precision !== null && recall !== null
        && precision >= rolloutMetricFloor && recall >= rolloutMetricFloor && counts['wrong-status'] === 0 }];
  })) as Record<ShadowPublicationField, Record<EvaluationOutcome, number> & {
    precision: number | null;
    recall: number | null;
    positiveExamples: number;
    passed: boolean;
  }>;
  return {
    cohort: { targetRuns: rolloutReviewTarget, selectedRuns: evaluationsByRun.size, fullyReviewedRuns: reviewedRuns.length,
      origins: ['provider-poll', 'scheduled-verification'] },
    thresholds: { minimumPrecision: rolloutMetricFloor, minimumRecall: rolloutMetricFloor },
    fields,
  };
}

export async function handleShadowPublication(request: Request, env: {
  DB: D1Database;
  SHADOW_EXTRACTION_ARTIFACTS: R2Bucket;
  LLM_METADATA_PUBLICATION_POLICY_JSON?: string;
}, refreshProjection: () => Promise<unknown>): Promise<Response> {
  const policy = parseShadowPublicationPolicy(env.LLM_METADATA_PUBLICATION_POLICY_JSON);
  if (request.method === 'GET') {
    const receipts = await env.DB.prepare(`SELECT policy_version, count(*) AS count FROM shadow_publication_receipts
      WHERE revoked_at IS NULL GROUP BY policy_version`).all<{ policy_version: string; count: number }>();
    return Response.json({ enabled: policy.enabled, version: policy.version, allowedFields: policy.allowedFields,
      cohortSize: policy.cohort.length, activeReceipts: receipts.results, evaluations: await evaluationSummary(env.DB),
      rolloutQualityGate: await rolloutQualityGate(env.DB),
      extractionScope: { classification: ['technical', 'earlyCareer', 'disciplines'],
        metadata: [...evaluationFields], publishedMetadata: ['compensation', 'locations', 'workMode'],
        deterministicBaseline: { covered: [...deterministicBaselineFields], llmOnly: ['eligibility'] } } },
    { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'POST') return Response.json({ message: 'Method not allowed' }, { status: 405 });
  const input = await request.json().catch(() => null) as {
    action?: unknown;
    runKey?: unknown;
    acceptedFields?: unknown;
    evaluations?: unknown;
  } | null;
  if (typeof input?.runKey !== 'string' || !/^[a-f0-9]{64}$/u.test(input.runKey)) {
    return Response.json({ message: 'A valid runKey is required' }, { status: 400 });
  }
  try {
    const run = await completedRun(env.DB, input.runKey);
    const reviewed = await artifact(env.SHADOW_EXTRACTION_ARTIFACTS, run.response_key);
    if (input.action === 'record-evaluation') {
      if (!Array.isArray(input.evaluations) || !input.evaluations.length) throw new Error('At least one field evaluation is required');
      const evaluations = input.evaluations as Array<{ field?: unknown; outcome?: unknown }>;
      if (evaluations.some(value => typeof value.field !== 'string' || !evaluationFields.includes(value.field as EvaluationField)
        || typeof value.outcome !== 'string' || !evaluationOutcomes.includes(value.outcome as EvaluationOutcome))
        || new Set(evaluations.map(value => value.field)).size !== evaluations.length) throw new Error('Field evaluations are invalid or duplicated');
      for (const value of evaluations) if (!evaluationMatches(reviewed.extraction.fields[value.field as EvaluationField], value.outcome as EvaluationOutcome)) {
        throw new Error(`${String(value.field)} evaluation is inconsistent with the extraction status`);
      }
      const evaluatedAt = new Date().toISOString();
      await env.DB.batch(evaluations.map(value => env.DB.prepare(`INSERT INTO shadow_extraction_evaluations (run_key, field, outcome, evaluated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(run_key, field) DO UPDATE SET outcome = excluded.outcome, evaluated_at = excluded.evaluated_at`)
        .bind(run.run_key, value.field, value.outcome, evaluatedAt)));
      const baselineRows = await env.DB.prepare(`SELECT field, baseline_state FROM shadow_extraction_baseline_differences
        WHERE run_key = ?`).bind(run.run_key).all<{ field: string; baseline_state: string }>();
      const baselineByField = new Map(baselineRows.results.map(row => [row.field, row.baseline_state]));
      const conformance = evaluations.map(value => fieldBaselineConformance(String(value.field), String(value.outcome),
        (baselineByField.get(String(value.field)) as BaselineState | undefined) ?? 'unavailable'));
      return Response.json({ runKey: run.run_key, recorded: evaluations.length, conformance,
        evaluation: await evaluationSummary(env.DB) });
    }
    if (input.action !== 'create-receipt' || !Array.isArray(input.acceptedFields) || input.acceptedFields.length === 0
      || input.acceptedFields.some(field => typeof field !== 'string' || !policy.allowedFields.includes(field as ShadowPublicationField))
      || new Set(input.acceptedFields).size !== input.acceptedFields.length) throw new Error('Policy-allowed acceptedFields are required');
    if (!policy.enabled || !policyAllows(policy, { sourceId: run.source_id, externalId: run.external_id, contentHash: run.content_hash })) {
      throw new Error('Run is not in the exact enabled cohort');
    }
    const revision = await currentRevision(env.DB, run);
    const acceptedFields = [...input.acceptedFields].sort() as ShadowPublicationField[];
    const outcomes = await env.DB.prepare(`SELECT field FROM shadow_extraction_field_outcomes WHERE run_key = ? AND accepted = 1`)
      .bind(run.run_key).all<{ field: string }>();
    if (acceptedFields.some(field => !outcomes.results.some(outcome => outcome.field === field))) throw new Error('Receipt fields are not validator-accepted');
    const evaluations = await env.DB.prepare(`SELECT field FROM shadow_extraction_evaluations WHERE run_key = ? AND outcome = 'correct-present'`)
      .bind(run.run_key).all<{ field: string }>();
    if (acceptedFields.some(field => !evaluations.results.some(evaluation => evaluation.field === field))) throw new Error('Receipt fields have not passed human evaluation');
    const publishable = shadowPublishableFields(reviewed.extraction, acceptedFields);
    if (publishable.length !== acceptedFields.length) throw new Error('Receipt fields do not contain publishable values');
    const jobs = new D1InternshipStore(env.DB);
    const job = await jobs.getJob(run.job_id);
    if (!job) throw new Error('Catalog job was not found');
    if (!job.sourceReferences.some(reference => reference.sourceId === run.source_id && reference.externalId === run.external_id)) {
      throw new Error('Exact source occurrence is no longer attached to the catalog job');
    }
    await currentRevision(env.DB, run);
    const evidenceFingerprint = shadowPublicationFingerprint({ jobId: run.job_id, sourceId: run.source_id, externalId: run.external_id,
      contentHash: run.content_hash, runKey: run.run_key, policyVersion: policy.version, allowedFields: acceptedFields });
    const receiptId = createHash('sha256').update(`receipt\0${evidenceFingerprint}`).digest('hex');
    const existingReceipt = await env.DB.prepare(`SELECT receipt_id FROM shadow_publication_receipts
      WHERE receipt_id = ? AND revoked_at IS NULL`).bind(receiptId).first<{ receipt_id: string }>();
    if (!existingReceipt) {
      const qualityGate = await rolloutQualityGate(env.DB);
      const blockedFields = policy.allowedFields.filter(field => !qualityGate.fields[field].passed);
      if (blockedFields.length) throw new Error(`Natural production quality gate has not passed for: ${blockedFields.join(', ')}`);
    }
    await env.DB.prepare(`INSERT INTO shadow_publication_receipts
      (receipt_id, job_id, source_id, external_id, content_hash, run_key, policy_version, accepted_fields, evidence_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(receipt_id) DO NOTHING`).bind(receiptId, run.job_id, run.source_id, run.external_id,
        run.content_hash, run.run_key, policy.version, JSON.stringify(acceptedFields), evidenceFingerprint, new Date().toISOString()).run();
    const active = await env.DB.prepare(`SELECT accepted_fields FROM shadow_publication_receipts
      WHERE run_key = ? AND content_hash = ? AND revoked_at IS NULL`).bind(run.run_key, run.content_hash).all<{ accepted_fields: string }>();
    const publishedFields = [...new Set(active.results.flatMap(row => {
      const fields = JSON.parse(row.accepted_fields) as unknown;
      return Array.isArray(fields) ? fields.filter((field): field is ShadowPublicationField => typeof field === 'string'
        && ['compensation', 'locations', 'workMode'].includes(field)) : [];
    }))].sort();
    const evidence = shadowExtractionEvidence({ extraction: reviewed.extraction, sourceId: run.source_id, sourceUrl: run.source_url,
      contentHash: run.content_hash, observedAt: revision.observed_at, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, allowedFields: publishedFields });
    if (!evidence) throw new Error('Extraction contains no publishable evidence');
    const sourceReferences = job.sourceReferences.map(reference => reference.sourceId === run.source_id && reference.externalId === run.external_id
      ? { ...reference, metadataEvidence: mergeRoleMetadataEvidence(reference.metadataEvidence, [evidence]) } : reference);
    const projected = projectRoleMetadata({ ...job, sourceReferences });
    const operations = new D1CatalogAdmissionStore(env.DB);
    await operations.recordRoleMetadataEvidence(run.job_id, [evidence], projected.conflicts, revision.observed_at,
      { sourceId: run.source_id, sourceClasses: ['reviewed-shadow'] });
    await jobs.putInternship(projected.job);
    await refreshProjection();
    return Response.json({ receiptId, evidenceFingerprint, policyVersion: policy.version, acceptedFields, publishedFields, published: true });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : 'Shadow publication operation failed' }, { status: 409 });
  }
}
