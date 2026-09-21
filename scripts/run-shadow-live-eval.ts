#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inferOpenAIShadowExtraction } from '../cloudflare/openai-shadow-inference.js';
import { evaluateShadowCase, summarizeShadowEval, type ShadowEvalCaseResult, type ShadowEvalExpected } from '../src/shadow-extraction-eval.js';
import { normalizeExactPostingDescription, shadowExtractionPrompt, validateShadowExtraction, type ShadowExtraction } from '../src/shadow-extraction.js';
import { postprocessRoleScopedExtraction } from '../src/shadow-extraction-postprocess.js';

type Run = { run_key: string; source_id: string };
type Manifest = { cases: Array<{ split: string; run: Run }> };
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const has = (name: string) => process.argv.includes(name);
const manifestPath = option('--manifest') ?? '.context/shadow-production-eval-manifest.json';
const artifactsPath = option('--artifacts') ?? '.context/pr324-artifacts';
const split = option('--split') ?? 'audited';
const model = option('--model') ?? 'gpt-5-mini-2025-08-07';
const maxCostCents = Number(option('--max-cost-cents') ?? 300);
const maxOutputTokens = Number(option('--max-output-tokens') ?? 1400);
const reasoningEffort = option('--reasoning-effort') ?? 'minimal';
const reportPath = option('--report') ?? 'eval/shadow-live-eval.json';
const offset = Number(option('--offset') ?? 0);
const limit = Number(option('--limit') ?? 50);
if (!Number.isSafeInteger(maxCostCents) || maxCostCents < 1 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1
  || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Cost, output, offset, and limit values are invalid');
if (!['minimal', 'low', 'medium', 'high'].includes(reasoningEffort)) throw new Error('reasoning effort must be minimal, low, medium, or high');

function apiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const match = readFileSync('.env', 'utf8').match(/^OPENAI_KEY=(.+)$/mu);
  if (!match) throw new Error('OPENAI_API_KEY or OPENAI_KEY in .env is required');
  return match[1]!.trim();
}
const notStated = { status: 'not-stated' as const };
const forcePresent = { status: 'present' as const, value: true };
function humanExpected(run: Run, extraction: ShadowExtraction, description: string): ShadowEvalExpected {
  const fields = Object.fromEntries(Object.entries(extraction.fields).map(([name, field]) => [name, field.status === 'present'
    ? { status: 'present', value: field.value } : { status: field.status }])) as ShadowEvalExpected['fields'];
  if (run.source_id === 'greenhouse-vardaspace') {
    const place = description.match(/\bon[- ]site in ([^.\n]+)/iu)?.[1]?.trim();
    fields.locations = place ? { status: 'present', value: [place] } : notStated;
  } else if (run.source_id === 'greenhouse-celonis') fields.locations = notStated;
  if (run.source_id === 'greenhouse-celonis') fields.workMode = notStated;
  if (run.source_id === 'ashby-sentry' || run.source_id === 'ashby-skydio' || run.source_id === 'greenhouse-oneethos') fields.eligibility = notStated;
  if (run.source_id === 'greenhouse-schonfeld') fields.timing = forcePresent;
  if (run.source_id === 'ashby-terranova') fields.housing = forcePresent;
  if (run.run_key === '33dd2f36d1ebc431495192c31ca6f8951df3dc4b33ca8703db9489837c7c287a') { fields.housing = forcePresent; fields.timing = forcePresent; }
  return { classification: extraction.classification, fields };
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
const cases = manifest.cases.filter((entry) => entry.split === split).slice(offset, offset + limit);
if (cases.length === 0 || cases.length > 50) throw new Error(`Expected 1-50 ${split} cases, got ${cases.length}`);
if (maxCostCents < cases.length) throw new Error(`At least one accounted cent is reserved for each of ${cases.length} cases`);
const key = apiKey();
let spentCents = 0;
const baseline: ShadowEvalCaseResult[] = [];
const guarded: ShadowEvalCaseResult[] = [];
const records: Array<{ id: string; inputTokens?: number; outputTokens?: number; actualCostCents?: number; validationFailures?: string[]; response?: unknown; error?: string }> = [];
async function runCase(entry: (typeof cases)[number]) {
  if (spentCents >= maxCostCents) throw new Error(`Refusing to exceed ${maxCostCents} cents`);
  const inputArtifact = JSON.parse(await readFile(`${artifactsPath}/input/${entry.run.run_key}.json`, 'utf8')) as { normalized: { title: string; description: string; completeness: string } };
  const recordedArtifact = JSON.parse(await readFile(`${artifactsPath}/response/${entry.run.run_key}.json`, 'utf8')) as { validation: { accepted?: ShadowExtraction } };
  if (!recordedArtifact.validation.accepted) throw new Error(`${entry.run.run_key} lacks a recorded accepted extraction for its human label`);
  const input = normalizeExactPostingDescription(inputArtifact.normalized.title, inputArtifact.normalized.description, inputArtifact.normalized.completeness === 'incomplete');
  const expected = humanExpected(entry.run, recordedArtifact.validation.accepted, input.description);
  try {
    const inference = await inferOpenAIShadowExtraction(key, input, shadowExtractionPrompt(input), fetch, { model, maxOutputTokens,
      reasoningEffort: model.startsWith('gpt-5-') ? reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' : undefined });
    spentCents += inference.actualCostCents;
    const validation = validateShadowExtraction(inference.response, input);
    records.push({ id: entry.run.run_key, inputTokens: inference.inputTokens, outputTokens: inference.outputTokens, actualCostCents: inference.actualCostCents, validationFailures: validation.failures, response: inference.response });
    if (!validation.accepted) {
      baseline.push({ id: entry.run.run_key, valid: false, failures: validation.failures, fields: [] });
      guarded.push({ id: entry.run.run_key, valid: false, failures: validation.failures, fields: [] });
      return;
    }
    const scored = evaluateShadowCase(validation.accepted, expected);
    baseline.push({ id: entry.run.run_key, valid: true, failures: [], ...scored, cost: inference });
    const guard = postprocessRoleScopedExtraction(validation.accepted);
    const guardedScored = evaluateShadowCase(guard.extraction, expected);
    guarded.push({ id: entry.run.run_key, valid: true, failures: [], ...guardedScored, cost: inference });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    records.push({ id: entry.run.run_key, error: message });
    baseline.push({ id: entry.run.run_key, valid: false, failures: [], error: message, fields: [] });
    guarded.push({ id: entry.run.run_key, valid: false, failures: [], error: message, fields: [] });
  }
}
await Promise.all(cases.map(runCase));
const report = { version: 1, split, model, reasoningEffort, maxCostCents, spentCents, maxOutputTokens, baseline: summarizeShadowEval(baseline), roleScopeGuard: summarizeShadowEval(guarded), records };
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (has('--fail-on-invalid') && report.baseline.invalidCases > 0) process.exitCode = 1;
