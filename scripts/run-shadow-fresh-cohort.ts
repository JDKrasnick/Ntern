#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inferOpenAIShadowExtraction } from '../cloudflare/openai-shadow-inference.js';
import { normalizeExactPostingDescription, shadowExtractionPrompt, validateShadowExtraction } from '../src/shadow-extraction.js';
import { postprocessRoleScopedExtraction } from '../src/shadow-extraction-postprocess.js';

type Run = { run_key: string; source_id: string; external_id: string; content_hash: string };
const option = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const runsPath = option('--runs') ?? '.context/shadow-fresh50-unique-runs.json';
const artifactsPath = option('--artifacts') ?? '.context/shadow-fresh50-unique-artifacts';
const reportPath = option('--report') ?? '.context/shadow-fresh50-gpt5mini-v9.json';
const model = option('--model') ?? 'gpt-5-mini-2025-08-07';
const maxOutputTokens = Number(option('--max-output-tokens') ?? 1400);
const maxCostCents = Number(option('--max-cost-cents') ?? 100);
const reasoningEffort = option('--reasoning-effort') ?? 'minimal';
const offset = Number(option('--offset') ?? 0);
const limit = Number(option('--limit') ?? 50);
const concurrency = Number(option('--concurrency') ?? 1);
if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || !Number.isSafeInteger(maxCostCents) || maxCostCents < 1
  || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
  || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error('Invalid token, cost, offset, limit, or concurrency');
if (!['minimal', 'low', 'medium', 'high'].includes(reasoningEffort)) throw new Error('Invalid reasoning effort');

function apiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const match = readFileSync('.env', 'utf8').match(/^OPENAI_KEY=(.+)$/mu);
  if (!match) throw new Error('OPENAI_API_KEY or OPENAI_KEY in .env is required');
  return match[1]!.trim();
}

const allRuns = JSON.parse(await readFile(runsPath, 'utf8')) as Run[];
const runs = allRuns.slice(offset, offset + limit);
if (runs.length === 0 || runs.length > 50 || new Set(runs.map((run) => run.content_hash)).size !== runs.length) throw new Error('Runs must be 1-50 unique posting contents');
const key = apiKey();
let spentCents = 0;
const records: Array<Record<string, unknown>> = [];
const rawPresent: Record<string, number> = {};
const guardedPresent: Record<string, number> = {};
const changedByField: Record<string, number> = {};
async function processRun(run: Run) {
  const artifact = JSON.parse(await readFile(`${artifactsPath}/input/${run.run_key}.json`, 'utf8')) as { normalized: { title: string; description: string; completeness: string } };
  const input = normalizeExactPostingDescription(artifact.normalized.title, artifact.normalized.description, artifact.normalized.completeness === 'incomplete');
  if (spentCents >= maxCostCents) throw new Error(`Cost ceiling reached before ${run.run_key}`);
  try {
    const inference = await inferOpenAIShadowExtraction(key, input, shadowExtractionPrompt(input), fetch, { model, maxOutputTokens,
      reasoningEffort: model.startsWith('gpt-5-') ? reasoningEffort as 'minimal' | 'low' | 'medium' | 'high' : undefined });
    spentCents += inference.actualCostCents;
    const validation = validateShadowExtraction(inference.response, input);
    if (!validation.accepted) {
      records.push({ id: run.run_key, sourceId: run.source_id, inputCompleteness: input.completeness, valid: false, failures: validation.failures,
        inputTokens: inference.inputTokens, outputTokens: inference.outputTokens, actualCostCents: inference.actualCostCents, response: inference.response });
      return;
    }
    const guard = postprocessRoleScopedExtraction(validation.accepted, input.completeness);
    for (const [field, value] of Object.entries(validation.accepted.fields)) if (value.status === 'present') rawPresent[field] = (rawPresent[field] ?? 0) + 1;
    for (const [field, value] of Object.entries(guard.extraction.fields)) if (value.status === 'present') guardedPresent[field] = (guardedPresent[field] ?? 0) + 1;
    for (const change of guard.changes) changedByField[change.field] = (changedByField[change.field] ?? 0) + 1;
    records.push({ id: run.run_key, sourceId: run.source_id, externalId: run.external_id, inputCompleteness: input.completeness, valid: true,
      inputTokens: inference.inputTokens, outputTokens: inference.outputTokens, actualCostCents: inference.actualCostCents,
      raw: validation.accepted, guarded: guard.extraction, changes: guard.changes });
  } catch (error) {
    records.push({ id: run.run_key, sourceId: run.source_id, valid: false, error: error instanceof Error ? error.message : String(error) });
  }
}
let nextRun = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
  while (nextRun < runs.length) {
    const run = runs[nextRun++]!;
    await processRun(run);
  }
}));
const validCases = records.filter((record) => record.valid).length;
const report = { version: 1, purpose: 'Fresh, independently selected 50-content cohort. Outputs require human labels before accuracy scoring.', model, reasoningEffort, offset,
  maxOutputTokens, maxCostCents, spentCents, totalCases: runs.length, validCases, invalidCases: runs.length - validCases, rawPresent, guardedPresent,
  tagsRemovedByPostprocess: Object.fromEntries(Object.keys(rawPresent).map((field) => [field, (rawPresent[field] ?? 0) - (guardedPresent[field] ?? 0)])), changedByField, records };
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ totalCases: report.totalCases, validCases, invalidCases: report.invalidCases, spentCents, rawPresent, guardedPresent,
  tagsRemovedByPostprocess: report.tagsRemovedByPostprocess, changedByField }, null, 2));
