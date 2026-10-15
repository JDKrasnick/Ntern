#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SHADOW_EXTRACTION_MODEL_ID, normalizeExactPostingDescription, shadowExtractionPrompt, validateShadowExtraction } from '../src/shadow-extraction.js';
import { inferShadowExtraction, shadowModelDefaults } from '../cloudflare/shadow-model-inference.js';
import { localShadowApiKey } from './shadow-model-cli.js';
import { postprocessRoleScopedExtraction } from '../src/shadow-extraction-postprocess.js';
import {
  evaluateShadowCase,
  parseShadowEvalCases,
  parseShadowRecordedRuns,
  shadowEvalFields,
  summarizeShadowEval,
  type ShadowEvalCase,
  type ShadowEvalCaseResult,
  type ShadowEvalFieldName,
  type ShadowRecordedRun,
} from '../src/shadow-extraction-eval.js';

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const has = (name: string) => args.includes(name);

const casesPath = option('--cases') ?? 'test/fixtures/shadow-extraction-eval.json';
const offlinePath = option('--offline');
const live = has('--live');
const roleScope = has('--role-scope');
const recordPath = option('--record');
const reportBase = option('--report') ?? 'eval/shadow-extraction-results';
const limitValue = Number(option('--limit') ?? 0);
if (!Number.isInteger(limitValue) || limitValue < 0) {
  console.error('--limit must be a positive integer or 0 for all cases'); process.exit(1);
}
const limit = limitValue;
if ((offlinePath === undefined) !== live) {
  console.error('Usage: tsx scripts/shadow-extraction-eval.ts (--offline <recorded.json> | --live) [--cases <dataset.json>] [--record <out.json>] [--report <base>] [--limit <n>] [--model <id>] [--role-scope]');
  process.exit(1);
}
if (recordPath !== undefined && !live) {
  console.error('--record is only valid with --live'); process.exit(1);
}
const model = option('--model') ?? SHADOW_EXTRACTION_MODEL_ID;
if (live) shadowModelDefaults(model);

const golden = parseShadowEvalCases(JSON.parse(await readFile(casesPath, 'utf8')) as unknown);

function resultFor(goldenCase: ShadowEvalCase, validation: ReturnType<typeof validateShadowExtraction>,
  inference?: { inputTokens: number; outputTokens: number; actualCostCents: number }): ShadowEvalCaseResult {
  if (validation.accepted) {
    const extraction = roleScope
      ? postprocessRoleScopedExtraction(validation.accepted, normalizeExactPostingDescription(goldenCase.title, goldenCase.description).completeness).extraction
      : validation.accepted;
    const evaluation = evaluateShadowCase(extraction, goldenCase.expected);
    return { id: goldenCase.id, valid: true, failures: [], classification: evaluation.classification, fields: evaluation.fields,
      ...(inference ? { cost: { inputTokens: inference.inputTokens, outputTokens: inference.outputTokens, actualCostCents: inference.actualCostCents } } : {}) };
  }
  return { id: goldenCase.id, valid: false, failures: validation.failures };
}

const results: ShadowEvalCaseResult[] = [];
const recorded: ShadowRecordedRun[] = [];

if (live) {
  const key = localShadowApiKey(model);
  for (const goldenCase of golden) {
    if (limit > 0 && results.length >= limit) break;
    const input = normalizeExactPostingDescription(goldenCase.title, goldenCase.description);
    const prompt = shadowExtractionPrompt(input);
    try {
      const inference = await inferShadowExtraction(key, input, prompt, fetch, shadowModelDefaults(model));
      const validation = validateShadowExtraction(inference.response, input);
      results.push(resultFor(goldenCase, validation, inference));
      if (recordPath !== undefined) recorded.push({ id: goldenCase.id, contentHash: input.contentHash, result: inference });
    } catch (error) {
      results.push({ id: goldenCase.id, valid: false, failures: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
} else {
  const fixture = parseShadowRecordedRuns(JSON.parse(await readFile(offlinePath!, 'utf8')) as unknown);
  const byId = new Map(fixture.cases.map((entry) => [entry.id, entry]));
  for (const goldenCase of golden) {
    const entry = byId.get(goldenCase.id);
    if (!entry) continue;
    const input = normalizeExactPostingDescription(goldenCase.title, goldenCase.description);
    if (entry.contentHash !== input.contentHash) throw new Error(`recorded contentHash mismatch for ${goldenCase.id}`);
    const validation = validateShadowExtraction(entry.result.response, input);
    results.push(resultFor(goldenCase, validation, entry.result));
  }
  if (results.length === 0) {
    console.error('No recorded cases matched the golden dataset'); process.exit(1);
  }
}

const mode = live ? 'live' : 'offline';
const recordedAt = new Date().toISOString();
const summary = { ...summarizeShadowEval(results), roleScopeApplied: roleScope };
const reportJson = `${reportBase}.json`;
const reportMd = `${reportBase}.md`;
await mkdir(dirname(reportJson), { recursive: true });
await writeFile(reportJson, `${JSON.stringify(summary, null, 2)}\n`);
if (recordPath !== undefined && recorded.length > 0) {
  const envelope = { version: 1, recordedAt, modelId: model, cases: recorded };
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(envelope, null, 2)}\n`);
}

const rate = (value: number | null) => value === null ? 'null' : value.toFixed(4);
const verdictOf = (field: ShadowEvalFieldName, result: ShadowEvalCaseResult) => {
  if (!result.valid) return '-';
  const verdict = result.fields.find((item) => item.field === field);
  return verdict ? { 'true-positive': 'TP', 'unsupported-claim': 'UC', 'value-mismatch': 'VM', 'false-negative': 'FN', 'true-negative': 'TN' }[verdict.verdict] : '-';
};
const classificationRow = (entry: { correct: number; total: number }) => `${entry.correct}/${entry.total}`;
const caseRows = results.map((result) => {
  const classification = result.classification ? `${result.classification.technical ? 'T' : 't'}/${result.classification.earlyCareer ? 'E' : 'e'}/${result.classification.disciplines ? 'D' : 'd'}`
    : result.valid ? '?' : 'invalid';
  const verdicts = result.valid ? shadowEvalFields.map((field) => `${field.slice(0, 4)}:${verdictOf(field, result)}`).join(' ') : (result.error ? `error: ${result.error.slice(0, 100)}` : result.failures.join('; ').slice(0, 200));
  return [result.id, result.valid ? 'yes' : 'no', classification, verdicts, result.cost ? String(result.cost.actualCostCents) : '-'].join(' | ');
}).join('\n');

await writeFile(reportMd, `# Shadow extraction evaluation

Mode: ${mode}
Role-scope postprocessing: ${roleScope ? 'applied' : 'not applied'}
Model: ${model}
Recorded at: ${recordedAt}
Cases: ${summary.cases} | Valid: ${summary.validCases} | Invalid: ${summary.invalidCases}

## Field gates

| field | TP | UC | VM | FN | TN | precision | recall | unsupported-claim rate | value-mismatch rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${shadowEvalFields.map((field) => {
  const counts = summary.fieldCounts[field];
  return `| ${field} | ${counts.truePositive} | ${counts.unsupportedClaim} | ${counts.valueMismatch} | ${counts.falseNegative} | ${counts.trueNegative} | ${rate(fieldRates(field, counts).precision)} | ${rate(fieldRates(field, counts).recall)} | ${rate(fieldRates(field, counts).unsupported)} | ${rate(fieldRates(field, counts).mismatch)} |`;
}).join('\n')}

## Classification

| label | correct / total |
| --- | --- |
| technical | ${classificationRow(summary.classification.technical)} |
| earlyCareer | ${classificationRow(summary.classification.earlyCareer)} |
| disciplines | ${classificationRow(summary.classification.disciplines)} |

## Cost

Input tokens: ${summary.cost.inputTokens}
Output tokens: ${summary.cost.outputTokens}
Total cost: ${summary.cost.actualCostCents} cents
Average cost per case: ${summary.cost.avgCostCentsPerCase === null ? 'null' : `${summary.cost.avgCostCentsPerCase.toFixed(3)} cents`}

## Cases

| id | valid | classification (T/E/D ok) | per-field verdicts | cost cents |
| --- | --- | --- | --- | --- |
${caseRows}

Raw pilot counts; not a weighted estimate.
`);
console.log(JSON.stringify(summary, null, 2));

function fieldRates(field: ShadowEvalFieldName, counts: { truePositive: number; unsupportedClaim: number; valueMismatch: number; falseNegative: number; trueNegative: number }) {
  const presentDen = counts.truePositive + counts.unsupportedClaim + counts.valueMismatch;
  const recallDen = counts.truePositive + counts.valueMismatch + counts.falseNegative;
  return {
    precision: presentDen > 0 ? counts.truePositive / presentDen : null,
    recall: recallDen > 0 ? counts.truePositive / recallDen : null,
    unsupported: presentDen > 0 ? counts.unsupportedClaim / presentDen : null,
    mismatch: presentDen > 0 ? counts.valueMismatch / presentDen : null,
  };
}
