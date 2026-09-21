#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { evaluateShadowCase, summarizeShadowEval, type ShadowEvalCaseResult, type ShadowEvalExpected } from '../src/shadow-extraction-eval.js';
import { normalizeExactPostingDescription, validateShadowExtraction, type ShadowExtraction } from '../src/shadow-extraction.js';
import { postprocessRoleScopedExtraction } from '../src/shadow-extraction-postprocess.js';

type Run = { run_key: string; source_id: string };
type Manifest = { cases: Array<{ split: string; run: Run }> };
type Report = { records: Array<{ id: string; response?: unknown; inputTokens?: number; outputTokens?: number; actualCostCents?: number }> };
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const reportPath = option('--report') ?? '.context/shadow-gpt5mini-low-v11.json';
const manifestPath = option('--manifest') ?? '.context/shadow-production-eval-manifest.json';
const artifactsPath = option('--artifacts') ?? '.context/pr324-artifacts';
const outputPath = option('--out') ?? 'eval/shadow-live-rescored.json';
const split = option('--split') ?? 'audited';
const notStated = { status: 'not-stated' as const };
const forcePresent = { status: 'present' as const, value: true };
function expected(run: Run, extraction: ShadowExtraction, description: string): ShadowEvalExpected {
  const fields = Object.fromEntries(Object.entries(extraction.fields).map(([name, field]) => [name, field.status === 'present' ? { status: 'present', value: field.value } : { status: field.status }])) as ShadowEvalExpected['fields'];
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
const report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
const byId = new Map(report.records.map((record) => [record.id, record]));
const results: ShadowEvalCaseResult[] = [];
for (const entry of manifest.cases.filter((item) => item.split === split)) {
  const record = byId.get(entry.run.run_key);
  const old = JSON.parse(await readFile(`${artifactsPath}/response/${entry.run.run_key}.json`, 'utf8')) as { validation: { accepted?: ShadowExtraction } };
  const source = JSON.parse(await readFile(`${artifactsPath}/input/${entry.run.run_key}.json`, 'utf8')) as { normalized: { title: string; description: string; completeness: string } };
  if (!record?.response || !old.validation.accepted) { results.push({ id: entry.run.run_key, valid: false, failures: ['missing recorded response'], fields: [] }); continue; }
  const input = normalizeExactPostingDescription(source.normalized.title, source.normalized.description, source.normalized.completeness === 'incomplete');
  const validation = validateShadowExtraction(record.response, input);
  if (!validation.accepted) { results.push({ id: entry.run.run_key, valid: false, failures: validation.failures, fields: [] }); continue; }
  const scored = evaluateShadowCase(postprocessRoleScopedExtraction(validation.accepted, input.completeness).extraction, expected(entry.run, old.validation.accepted, input.description));
  results.push({ id: entry.run.run_key, valid: true, failures: [], ...scored, cost: record.inputTokens === undefined || record.outputTokens === undefined || record.actualCostCents === undefined ? undefined : { inputTokens: record.inputTokens, outputTokens: record.outputTokens, actualCostCents: record.actualCostCents } });
}
const output = summarizeShadowEval(results);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
