import { createHash } from 'node:crypto';
import {
  SHADOW_EXTRACTION_MODEL_ID,
  SHADOW_EXTRACTION_PREPROCESSING_VERSION,
  SHADOW_EXTRACTION_PROMPT_VERSION,
  SHADOW_EXTRACTION_SCHEMA_VERSION,
  shadowExtractionOrigins,
  normalizeExactPostingDescription,
  shadowExtractionCacheKey,
  shadowExtractionPrompt,
  projectShadowExtractionToSupportedFields,
  validateShadowExtraction,
  type NormalizedPostingInput,
  type ShadowExtractionOrigin,
  type ShadowStatus,
  type ShadowValidationResult,
} from '../src/shadow-extraction.js';
import type { ProviderIdentity } from '../src/types.js';
import type { D1Database, D1PreparedStatement, MessageBatch, Queue, R2Bucket } from './types.js';
import { inferOpenAIShadowExtraction } from './openai-shadow-inference.js';

export interface ShadowExtractionMessage {
  version: 1;
  runKey: string;
  cacheKey: string;
  jobId: string;
  sourceId: string;
  externalId: string;
  sourceUrl: string;
  providerIdentity: ProviderIdentity;
  contentHash: string;
  inputKey: string;
  queuedAt: string;
  origin: ShadowExtractionOrigin;
}

export interface ShadowInferenceResult {
  response: unknown;
  inputTokens: number;
  outputTokens: number;
  actualCostCents: number;
}

export type ShadowBaseline = Partial<Record<'compensation' | 'locations' | 'workMode' | 'housing' | 'timing' | 'education' | 'eligibility', ShadowStatus>>;

export interface ShadowExtractionEnvironment {
  DB: D1Database;
  SHADOW_EXTRACTION_QUEUE: Queue;
  SHADOW_EXTRACTION_ARTIFACTS: R2Bucket;
  /** Live execution remains false until pilot evaluation and cost headroom are approved. */
  SHADOW_EXTRACTION_ENABLED?: string;
  SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS?: string;
  SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS?: string;
  OPENAI_KEY?: string;
}

const leaseMs = 5 * 60_000;
const retentionDays = 30;
const maxInputBytes = 40_000;

function safeKeyPart(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('Shadow extraction hash is invalid');
  return value;
}

function messageValid(value: unknown): value is ShadowExtractionMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ShadowExtractionMessage>;
  return message.version === 1 && typeof message.runKey === 'string' && /^[a-f0-9]{64}$/u.test(message.runKey)
    && typeof message.cacheKey === 'string' && /^[a-f0-9]{64}$/u.test(message.cacheKey)
    && typeof message.jobId === 'string' && typeof message.sourceId === 'string' && typeof message.externalId === 'string'
    && typeof message.sourceUrl === 'string' && typeof message.contentHash === 'string' && /^[a-f0-9]{64}$/u.test(message.contentHash)
    && typeof message.inputKey === 'string' && /^shadow-input\/[a-f0-9]{64}\.json$/u.test(message.inputKey)
    && (message.origin === undefined || shadowExtractionOrigins.some((origin) => origin === message.origin))
    && Boolean(message.providerIdentity);
}

function readJson(value: unknown): ShadowExtractionMessage {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!messageValid(parsed)) throw new Error('Shadow extraction message is invalid');
  return { ...parsed, origin: parsed.origin ?? 'legacy-unknown' };
}

function parseCents(value: string | undefined): number | undefined {
  if (!value?.trim() || !/^\d+$/u.test(value.trim())) return undefined;
  const cents = Number(value);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function month(now: Date): string { return now.toISOString().slice(0, 7); }

function r2Key(contentHash: string): string { return `shadow-input/${safeKeyPart(contentHash)}.json`; }

async function r2Text(bucket: R2Bucket, key: string): Promise<string> {
  const object = await bucket.get(key);
  if (!object || object.size === undefined || object.size > maxInputBytes + 2_000) throw new Error('Shadow extraction input is unavailable or oversized');
  return new Response(object.body).text();
}

/** The producer stores only immutable artifact references on Queue. It does not
 * put descriptions, prompts, URLs to fetch, or model instructions in messages. */
export async function enqueueShadowExtraction(env: Pick<ShadowExtractionEnvironment, 'DB' | 'SHADOW_EXTRACTION_QUEUE' | 'SHADOW_EXTRACTION_ARTIFACTS'>, input: {
  jobId: string;
  sourceId: string;
  externalId: string;
  sourceUrl: string;
  providerIdentity: ProviderIdentity;
  title: string;
  description: string;
  observedAt: string;
  incomplete?: boolean;
  baseline?: ShadowBaseline;
  origin?: ShadowExtractionOrigin;
}): Promise<ShadowExtractionMessage | undefined> {
  const origin = input.origin ?? 'legacy-unknown';
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  const serialize = (candidate: ReturnType<typeof normalizeExactPostingDescription>) => JSON.stringify({
    version: 1, normalized: candidate, baseline: input.baseline ?? {}, identity: {
      jobId: input.jobId, sourceId: input.sourceId, externalId: input.externalId, sourceUrl: input.sourceUrl,
      providerIdentity: input.providerIdentity, observedAt: input.observedAt, origin,
    }, retention: { expiresAt: new Date(Date.parse(input.observedAt) + retentionDays * 86_400_000).toISOString() } });
  let normalized = normalizeExactPostingDescription(input.title, input.description, input.incomplete);
  if (!normalized.title || !normalized.description) return undefined;
  let stored = serialize(normalized);
  const artifactLimit = maxInputBytes + 2_000;
  if (bytes(stored) > artifactLimit) {
    // JSON escaping means raw description bytes cannot be subtracted from the
    // serialized size to measure envelope overhead. Search the actual artifact
    // size so escaped text keeps the largest byte-bounded prefix that fits.
    let low = 1;
    let high = bytes(normalized.description);
    let fitting: { normalized: typeof normalized; stored: string } | undefined;
    while (low <= high) {
      const budget = Math.floor((low + high) / 2);
      const candidate = normalizeExactPostingDescription(input.title, input.description, input.incomplete, budget);
      const candidateStored = serialize(candidate);
      if (candidate.title && candidate.description && bytes(candidateStored) <= artifactLimit) {
        fitting = { normalized: candidate, stored: candidateStored };
        low = budget + 1;
      } else {
        high = budget - 1;
      }
    }
    if (!fitting) return undefined;
    normalized = fitting.normalized;
    stored = fitting.stored;
  }
  const cacheKey = shadowExtractionCacheKey(normalized);
  const runKey = shadowReportFingerprint({ jobId: input.jobId, sourceId: input.sourceId, externalId: input.externalId,
    contentHash: normalized.contentHash, cacheKey });
  // The normalized text is content-addressed by cacheKey, while this artifact
  // also holds posting-specific baseline state and therefore must not be shared.
  const inputKey = r2Key(runKey);
  await env.SHADOW_EXTRACTION_ARTIFACTS.put(inputKey, new TextEncoder().encode(stored).buffer, { httpMetadata: { contentType: 'application/json' } });
  const message: ShadowExtractionMessage = { version: 1, runKey, cacheKey, jobId: input.jobId, sourceId: input.sourceId,
    externalId: input.externalId, sourceUrl: input.sourceUrl, providerIdentity: input.providerIdentity,
    contentHash: normalized.contentHash, inputKey, queuedAt: input.observedAt, origin };
  await env.DB.prepare(`INSERT INTO shadow_extraction_posting_revisions (job_id, source_id, external_id, content_hash, observed_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, source_id, external_id) DO UPDATE SET content_hash = excluded.content_hash, observed_at = excluded.observed_at
    WHERE shadow_extraction_posting_revisions.observed_at <= excluded.observed_at`).bind(message.jobId, message.sourceId, message.externalId,
    message.contentHash, message.queuedAt).run();
  await env.SHADOW_EXTRACTION_QUEUE.send(message);
  return message;
}

/** Atomic reservation checks the already-forecast app spend and the monthly
 * shadow envelope before an inference call. A missing value fails closed. */
export async function reserveShadowCost(db: D1Database, now: Date, runKey: string, leaseToken: string, reserveCents: number, env: Pick<ShadowExtractionEnvironment, 'SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS' | 'SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS'>): Promise<boolean> {
  const forecast = parseCents(env.SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS);
  const headroom = parseCents(env.SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS);
  if (forecast === undefined || headroom === undefined || reserveCents <= 0) return false;
  const period = month(now);
  const prior = await db.prepare(`SELECT state, reserved_cents FROM shadow_extraction_cost_ledger
    WHERE period = ? AND lease_token = ?`).bind(period, leaseToken).first<{ state: string; reserved_cents: number }>();
  if (prior?.state === 'reserved' && prior.reserved_cents >= reserveCents) return true;
  const allowance = Math.min(headroom, Math.max(0, 2_000 - forecast));
  if (reserveCents > allowance) return false;
  const result = await db.prepare(`INSERT INTO shadow_extraction_cost_ledger (period, lease_token, run_key, reserved_cents, actual_cents, state, created_at, updated_at)
    SELECT ?, ?, ?, ?, 0, 'reserved', ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM shadow_extraction_cost_ledger WHERE period = ? AND lease_token = ?)
      AND COALESCE((SELECT SUM(CASE WHEN state = 'reserved' AND reserved_cents > actual_cents THEN reserved_cents
        WHEN state IN ('reserved', 'reconciled') THEN actual_cents ELSE 0 END)
        FROM shadow_extraction_cost_ledger WHERE period = ?), 0) + ? <= ?`).bind(
    period, leaseToken, runKey, reserveCents, now.toISOString(), now.toISOString(), period, leaseToken, period, reserveCents, allowance,
  ).run();
  if (result.meta.changes === 1) return true;
  const existing = await db.prepare(`SELECT state, reserved_cents FROM shadow_extraction_cost_ledger
    WHERE period = ? AND lease_token = ?`).bind(period, leaseToken).first<{ state: string; reserved_cents: number }>();
  return existing?.state === 'reserved' && existing.reserved_cents >= reserveCents;
}

async function releaseShadowCost(db: D1Database, now: Date, runKey: string, leaseToken: string): Promise<void> {
  await db.prepare(`UPDATE shadow_extraction_cost_ledger SET state = 'released', updated_at = ?
    WHERE lease_token = ? AND run_key = ? AND state = 'reserved'`)
    .bind(now.toISOString(), leaseToken, runKey).run();
}

async function claimRun(db: D1Database, message: ShadowExtractionMessage, now: Date): Promise<string | undefined> {
  const until = new Date(now.getTime() + leaseMs).toISOString();
  const leaseToken = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO shadow_extraction_runs (
      run_key, job_id, source_id, external_id, source_url, posting_identity, content_hash, model_id, prompt_version, schema_version, preprocessing_version,
      state, attempts, lease_until, lease_token, cache_key, input_key, origin, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_key) DO UPDATE SET state = 'running', attempts = shadow_extraction_runs.attempts + 1, lease_until = excluded.lease_until,
      lease_token = excluded.lease_token, updated_at = excluded.updated_at
    WHERE shadow_extraction_runs.state IN ('queued', 'transient-failure') OR (shadow_extraction_runs.state = 'running' AND shadow_extraction_runs.lease_until < ?)`)
    .bind(message.runKey, message.jobId, message.sourceId, message.externalId, message.sourceUrl, JSON.stringify(message.providerIdentity), message.contentHash,
      SHADOW_EXTRACTION_MODEL_ID, SHADOW_EXTRACTION_PROMPT_VERSION, SHADOW_EXTRACTION_SCHEMA_VERSION, SHADOW_EXTRACTION_PREPROCESSING_VERSION,
      until, leaseToken, message.cacheKey, message.inputKey, message.origin ?? 'legacy-unknown', now.toISOString(), now.toISOString(), now.toISOString()).run();
  if (result.meta.changes !== 1) return undefined;
  await db.prepare('INSERT INTO shadow_extraction_claims (lease_token, run_key, claimed_at) VALUES (?, ?, ?)')
    .bind(leaseToken, message.runKey, now.toISOString()).run();
  return leaseToken;
}

async function currentRevision(db: D1Database, message: ShadowExtractionMessage): Promise<boolean> {
  const row = await db.prepare(`SELECT content_hash FROM shadow_extraction_posting_revisions
    WHERE job_id = ? AND source_id = ? AND external_id = ?`).bind(message.jobId, message.sourceId, message.externalId).first<{ content_hash: string }>();
  return row?.content_hash === message.contentHash;
}

function finishRunStatement(db: D1Database, message: ShadowExtractionMessage, leaseToken: string, state: 'disabled' | 'completed' | 'invalid-output' | 'transient-failure' | 'obsolete', now: Date, values: { responseKey?: string; validation?: unknown; error?: string; inputTokens?: number; outputTokens?: number; actualCostCents?: number } = {}): D1PreparedStatement {
  return db.prepare(`UPDATE shadow_extraction_runs SET state = ?, lease_until = '', response_key = ?, validation = ?, error = ?, input_tokens = ?, output_tokens = ?, actual_cost_cents = ?, completed_at = ?, updated_at = ?
    WHERE run_key = ? AND content_hash = ? AND state = 'running' AND lease_token = ?`).bind(state, values.responseKey ?? null, values.validation ? JSON.stringify(values.validation) : null,
    values.error ?? null, values.inputTokens ?? null, values.outputTokens ?? null, values.actualCostCents ?? null, now.toISOString(), now.toISOString(), message.runKey, message.contentHash, leaseToken);
}

async function finishRun(db: D1Database, message: ShadowExtractionMessage, leaseToken: string, state: 'disabled' | 'completed' | 'invalid-output' | 'transient-failure' | 'obsolete', now: Date, values: { responseKey?: string; validation?: unknown; error?: string; inputTokens?: number; outputTokens?: number; actualCostCents?: number } = {}): Promise<boolean> {
  const result = await finishRunStatement(db, message, leaseToken, state, now, values).run();
  return result.meta.changes === 1;
}

async function reconcileUsage(db: D1Database, message: ShadowExtractionMessage, leaseToken: string, startedAt: Date, response: ShadowInferenceResult, now: Date): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO shadow_extraction_usage (lease_token, run_key, input_tokens, output_tokens, actual_cost_cents, recorded_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shadow_extraction_claims WHERE lease_token = ? AND run_key = ?)`)
      .bind(leaseToken, message.runKey, response.inputTokens, response.outputTokens, response.actualCostCents, now.toISOString(), leaseToken, message.runKey),
    db.prepare(`UPDATE shadow_extraction_cost_ledger SET actual_cents = ?, state = 'reconciled', updated_at = ?
      WHERE period = ? AND lease_token = ? AND run_key = ?
        AND EXISTS (SELECT 1 FROM shadow_extraction_usage WHERE lease_token = ? AND run_key = ?)`)
      .bind(response.actualCostCents, now.toISOString(), month(startedAt), leaseToken, message.runKey, leaseToken, message.runKey),
  ]);
}

function runAnalysisStatements(db: D1Database, runKey: string, leaseToken: string, validation: ShadowValidationResult, baseline: ShadowBaseline | undefined, recordedAt: Date): D1PreparedStatement[] {
  const fieldOutcomes = validation.fieldOutcomes.map((outcome) => db.prepare(`INSERT INTO shadow_extraction_field_outcomes (run_key, field, status, accepted, failure)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shadow_extraction_runs WHERE run_key = ? AND lease_token = ?)
    ON CONFLICT(run_key, field) DO UPDATE SET status = excluded.status, accepted = excluded.accepted, failure = excluded.failure`)
    .bind(runKey, outcome.field, outcome.status, outcome.accepted ? 1 : 0, outcome.failure ?? null, runKey, leaseToken));
  const baselineDifferences = validation.fieldOutcomes.flatMap((outcome) => {
    const baselineState = baseline?.[outcome.field as keyof ShadowBaseline];
    return baselineState ? [db.prepare(`INSERT INTO shadow_extraction_baseline_differences (run_key, field, baseline_state, shadow_state, differs, recorded_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shadow_extraction_runs WHERE run_key = ? AND lease_token = ?)
      ON CONFLICT(run_key, field) DO UPDATE SET baseline_state = excluded.baseline_state,
        shadow_state = excluded.shadow_state, differs = excluded.differs, recorded_at = excluded.recorded_at`)
      .bind(runKey, outcome.field, baselineState, outcome.status, baselineState === outcome.status ? 0 : 1, recordedAt.toISOString(), runKey, leaseToken)] : [];
  });
  return [...fieldOutcomes, ...baselineDifferences];
}

async function finishRunWithAnalysis(db: D1Database, message: ShadowExtractionMessage, leaseToken: string, state: 'completed' | 'invalid-output', now: Date, values: { responseKey: string; validation: ShadowValidationResult; inputTokens?: number; outputTokens?: number; actualCostCents?: number }, baseline: ShadowBaseline | undefined): Promise<boolean> {
  const [finished] = await db.batch([
    finishRunStatement(db, message, leaseToken, state, now, values),
    ...runAnalysisStatements(db, message.runKey, leaseToken, values.validation, baseline, now),
  ]);
  return finished?.meta.changes === 1;
}

/** Validator failures grouped by cause. The mapping is exhaustive over the
 * strings `validateShadowExtraction` can emit, so `other` appears only if a new
 * failure message lands without a category. `not-stated is invalid for
 * incomplete input` is its own category: the validator raises it only when the
 * artifact is bounded, so it is never a model defect. */
const failureCategorySql = `CASE
        WHEN failure IN ('response is not the extraction contract', 'invalid classification')
          OR failure LIKE '%: invalid field contract'
          OR failure LIKE '%: status/value inconsistency' THEN 'model-schema'
        WHEN failure LIKE '%: not-stated is invalid for incomplete input' THEN 'input-incomplete'
        WHEN failure LIKE '%: invalid evidence'
          OR failure LIKE '%: supporting passage absent from artifact'
          OR failure LIKE '%: numeric or unit inconsistency' THEN 'model-evidence'
        WHEN failure LIKE '%: unsupported work mode'
          OR failure LIKE '%: location is not a geographic place' THEN 'model-normalization'
        ELSE 'other'
      END`;

/** Invalid-output failures with the run dimensions needed to attribute them to a
 * source artifact. `json_valid` keeps one unreadable row from failing the whole
 * response, and `LIKE '%: ...'` matches only the field-prefixed validator
 * messages that `validateShadowExtraction` records under `failures`. */
const invalidOutputFailuresSql = `SELECT runs.origin AS origin, runs.input_completeness AS input_completeness, json_each.value AS failure
      FROM shadow_extraction_runs runs, json_each(runs.validation, '$.failures')
      WHERE runs.state = 'invalid-output' AND runs.validation IS NOT NULL AND json_valid(runs.validation)`;

export async function shadowExtractionSummary(db: D1Database): Promise<Record<string, unknown>> {
  const [runs, costs, versions, origins, coverage, failures, inputCompleteness, validationFailures, failureAttribution, baselineDifferences, usage, handoffs, providerOutbox] = await Promise.all([
    db.prepare('SELECT state, COUNT(*) AS count, AVG(CASE WHEN completed_at IS NOT NULL THEN (julianday(completed_at) - julianday(created_at)) * 86400000 END) AS latency_ms FROM shadow_extraction_runs GROUP BY state').all(),
    db.prepare(`SELECT period, SUM(CASE WHEN state = 'reserved' THEN reserved_cents ELSE 0 END) AS reserved_cents,
      SUM(actual_cents) AS actual_cents, COUNT(*) AS attempts FROM shadow_extraction_cost_ledger
      GROUP BY period ORDER BY period DESC LIMIT 2`).all(),
    db.prepare('SELECT model_id, prompt_version, schema_version, preprocessing_version, COUNT(*) AS count FROM shadow_extraction_runs GROUP BY model_id, prompt_version, schema_version, preprocessing_version').all(),
    db.prepare('SELECT origin, state, COUNT(*) AS count FROM shadow_extraction_runs GROUP BY origin, state ORDER BY origin, state').all(),
    db.prepare(`SELECT field, status, SUM(accepted) AS accepted, COUNT(*) AS total
      FROM shadow_extraction_field_outcomes GROUP BY field, status ORDER BY field, status`).all(),
    db.prepare(`SELECT state, COUNT(*) AS count FROM shadow_extraction_runs
      WHERE state IN ('invalid-output', 'transient-failure', 'obsolete') GROUP BY state`).all(),
    db.prepare(`SELECT origin, state, COALESCE(input_completeness, 'unknown') AS completeness, COUNT(*) AS count
      FROM shadow_extraction_runs GROUP BY origin, state, COALESCE(input_completeness, 'unknown')
      ORDER BY origin, state, completeness`).all(),
    db.prepare(`SELECT ${failureCategorySql} AS category, failure, COUNT(*) AS count
      FROM (${invalidOutputFailuresSql}) validation_failures
      GROUP BY category, failure ORDER BY category, failure`).all(),
    db.prepare(`SELECT origin, COALESCE(input_completeness, 'unknown') AS completeness, ${failureCategorySql} AS category, COUNT(*) AS count
      FROM (${invalidOutputFailuresSql}) failure_sources
      GROUP BY origin, completeness, category ORDER BY origin, completeness, category`).all(),
    db.prepare(`SELECT field, baseline_state, shadow_state, COUNT(*) AS count
      FROM shadow_extraction_baseline_differences WHERE differs = 1 GROUP BY field, baseline_state, shadow_state`).all(),
    db.prepare(`SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(actual_cost_cents), 0) AS actual_cost_cents FROM shadow_extraction_usage`).all(),
    db.prepare(`SELECT json_extract(report, '$.shadowHandoff.outcome') AS outcome,
      json_extract(report, '$.shadowHandoff.method') AS method, COUNT(*) AS count,
      MAX(json_extract(report, '$.shadowHandoff.observedAt')) AS latest
      FROM role_metadata_acquisition WHERE json_extract(report, '$.shadowHandoff.outcome') IS NOT NULL
      GROUP BY outcome, method ORDER BY outcome, method`).all(),
    db.prepare("SELECT COUNT(*) AS pending FROM catalog_items WHERE kind = 'provider-shadow-verification' AND sk = 'PENDING'").first(),
  ]);
  return { runs: runs.results, coverage: coverage.results, failures: failures.results, costs: costs.results,
    usage: usage.results[0] ?? { input_tokens: 0, output_tokens: 0, actual_cost_cents: 0 }, versions: versions.results,
    origins: origins.results, inputCompleteness: inputCompleteness.results, validationFailures: validationFailures.results,
    failureAttribution: failureAttribution.results,
    baselineDifferences: baselineDifferences.results, handoffs: handoffs.results,
    providerOutbox: providerOutbox ?? { pending: 0 } };
}

export async function processShadowExtractionBatch(batch: MessageBatch<unknown>, env: ShadowExtractionEnvironment, now = () => new Date(), infer?: (input: NormalizedPostingInput, prompt: ReturnType<typeof shadowExtractionPrompt>) => Promise<ShadowInferenceResult>): Promise<void> {
  const apiKey = env.OPENAI_KEY;
  const inference = infer ?? (apiKey
    ? (input: NormalizedPostingInput, prompt: ReturnType<typeof shadowExtractionPrompt>) => inferOpenAIShadowExtraction(apiKey, input, prompt, fetch, {
      model: SHADOW_EXTRACTION_MODEL_ID, maxOutputTokens: 1400, reasoningEffort: 'minimal',
    })
    : undefined);
  for (const queued of batch.messages) {
    let message: ShadowExtractionMessage;
    try { message = readJson(queued.body); } catch { queued.ack(); continue; }
    const startedAt = now();
    let leaseToken: string | undefined;
    try {
      leaseToken = await claimRun(env.DB, message, startedAt);
      if (!leaseToken) { queued.ack(); continue; }
      if (!await currentRevision(env.DB, message)) {
        await finishRun(env.DB, message, leaseToken, 'obsolete', now(), { error: 'a newer posting revision is current' }); queued.ack(); continue;
      }
      const parsed = JSON.parse(await r2Text(env.SHADOW_EXTRACTION_ARTIFACTS, message.inputKey)) as { normalized?: NormalizedPostingInput; baseline?: ShadowBaseline };
      const normalized = parsed.normalized;
      if (normalized?.completeness === 'complete' || normalized?.completeness === 'incomplete') {
        await env.DB.prepare(`UPDATE shadow_extraction_runs SET input_completeness = ?
          WHERE run_key = ? AND state = 'running' AND lease_token = ?`)
          .bind(normalized.completeness, message.runKey, leaseToken).run();
      }
      if (!normalized || normalized.contentHash !== message.contentHash || shadowExtractionCacheKey(normalized) !== message.cacheKey) {
        await finishRun(env.DB, message, leaseToken, 'invalid-output', now(), { error: 'input identity or version mismatch' }); queued.ack(); continue;
      }
      if (env.SHADOW_EXTRACTION_ENABLED !== 'true' || !inference) {
        await finishRun(env.DB, message, leaseToken, 'disabled', now(), { error: 'live model execution disabled or credential unavailable' }); queued.ack(); continue;
      }
      const cached = await env.DB.prepare('SELECT response_key, validation, expires_at FROM shadow_extraction_cache WHERE cache_key = ?')
        .bind(message.cacheKey).first<{ response_key: string; validation: string; expires_at: string }>();
      if (cached) {
        const checkedAt = now();
        if (!await currentRevision(env.DB, message)) {
          await finishRun(env.DB, message, leaseToken, 'obsolete', checkedAt, { error: 'a newer posting revision arrived before cache reuse' });
          queued.ack(); continue;
        }
        const retained = Date.parse(cached.expires_at) > checkedAt.getTime()
          ? await env.SHADOW_EXTRACTION_ARTIFACTS.get(cached.response_key) : null;
        if (retained) {
          const validation = JSON.parse(cached.validation) as ShadowValidationResult;
          await finishRunWithAnalysis(env.DB, message, leaseToken, 'completed', checkedAt,
            { responseKey: cached.response_key, validation }, parsed.baseline);
          queued.ack(); continue;
        }
        await env.DB.prepare('DELETE FROM shadow_extraction_cache WHERE cache_key = ? AND response_key = ?')
          .bind(message.cacheKey, cached.response_key).run();
      }
      // Conservative upper bound: 5 cents/request. Actual model cost is reconciled below.
      if (!await reserveShadowCost(env.DB, startedAt, message.runKey, leaseToken, 5, env)) {
        await finishRun(env.DB, message, leaseToken, 'disabled', now(), { error: 'cost headroom unavailable' }); queued.ack(); continue;
      }
      const response = await inference(normalized, shadowExtractionPrompt(normalized));
      if (!Number.isSafeInteger(response.inputTokens) || response.inputTokens < 0
        || !Number.isSafeInteger(response.outputTokens) || response.outputTokens < 0
        || !Number.isSafeInteger(response.actualCostCents) || response.actualCostCents < 0) {
        throw new Error('model usage is invalid');
      }
      await reconcileUsage(env.DB, message, leaseToken, startedAt, response, now());
      if (!await currentRevision(env.DB, message)) {
        await finishRun(env.DB, message, leaseToken, 'obsolete', now(), { error: 'a newer posting revision arrived during inference', inputTokens: response.inputTokens,
          outputTokens: response.outputTokens, actualCostCents: response.actualCostCents }); queued.ack(); continue;
      }
      const rawValidation = validateShadowExtraction(response.response, normalized);
      const projection = rawValidation.accepted ? undefined : projectShadowExtractionToSupportedFields(response.response, normalized);
      const validation = projection?.accepted
        ? { ...validateShadowExtraction(projection.accepted, normalized), projectedFields: projection.removedFields }
        : rawValidation;
      const responseKey = `shadow-response/${message.runKey}/${leaseToken}.json`;
      await env.SHADOW_EXTRACTION_ARTIFACTS.put(responseKey, new TextEncoder().encode(JSON.stringify({ response: response.response, validation, rawValidation,
        projection: projection ? { removedFields: projection.removedFields, failures: projection.failures } : undefined })).buffer, { httpMetadata: { contentType: 'application/json' } });
      const state = validation.accepted ? 'completed' : 'invalid-output';
      const completedAt = now();
      const finished = await finishRunWithAnalysis(env.DB, message, leaseToken, state, completedAt, { responseKey, validation,
        inputTokens: response.inputTokens, outputTokens: response.outputTokens, actualCostCents: response.actualCostCents }, parsed.baseline);
      if (!finished) { queued.ack(); continue; }
      if (validation.accepted) await env.DB.prepare(`INSERT INTO shadow_extraction_cache (cache_key, response_key, validation, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO NOTHING`).bind(message.cacheKey, responseKey, JSON.stringify(validation), completedAt.toISOString(), new Date(completedAt.getTime() + retentionDays * 86_400_000).toISOString()).run();
      queued.ack();
    } catch (error) {
      // A claim can be reclaimed while a model call is in flight. Its terminal
      // write is fenced, so a late failure cannot replace the newer result.
      if (leaseToken) {
        const failedAt = now();
        await releaseShadowCost(env.DB, failedAt, message.runKey, leaseToken);
        await finishRun(env.DB, message, leaseToken, 'transient-failure', failedAt, { error: error instanceof Error ? error.message.slice(0, 500) : 'unknown failure' });
      }
      if ((queued.attempts ?? 1) >= 2) queued.ack(); else queued.retry({ delaySeconds: 300 }, error);
    }
  }
}

export function shadowReportFingerprint(message: Pick<ShadowExtractionMessage, 'jobId' | 'sourceId' | 'externalId' | 'contentHash' | 'cacheKey'>): string {
  return createHash('sha256').update(`${message.jobId}\0${message.sourceId}\0${message.externalId}\0${message.contentHash}\0${message.cacheKey}`).digest('hex');
}
