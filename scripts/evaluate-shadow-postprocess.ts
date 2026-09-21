#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ShadowExtraction } from '../src/shadow-extraction.js';
import { evaluateShadowCase, summarizeShadowEval, type ShadowEvalCaseResult, type ShadowEvalExpected } from '../src/shadow-extraction-eval.js';
import { postprocessRoleScopedExtraction } from '../src/shadow-extraction-postprocess.js';

type Run = { run_key: string; source_id: string };
type Manifest = { cases: Array<{ split: string; run: Run }> };
const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const manifestPath = option('--manifest') ?? '.context/shadow-production-eval-manifest.json';
const artifactsPath = option('--artifacts') ?? '.context/pr324-artifacts';
const reportPath = option('--report') ?? 'eval/shadow-postprocess-audited.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
const audited = manifest.cases.filter((entry) => entry.split === 'audited');
if (audited.length !== 25) throw new Error(`Expected exactly 25 audited cases, got ${audited.length}`);

const notStated = { status: 'not-stated' as const };
const forcePresent = { status: 'present' as const, value: true };
function humanExpected(run: Run, extraction: ShadowExtraction, description: string): ShadowEvalExpected {
  const fields = Object.fromEntries(Object.entries(extraction.fields).map(([name, field]) => [name, field.status === 'present'
    ? { status: 'present', value: field.value } : { status: field.status }])) as ShadowEvalExpected['fields'];
  // These overrides are the independently reviewed errors from the first-25 audit.
  if (run.source_id === 'greenhouse-vardaspace') {
    const place = description.match(/\bon[- ]site in ([^.\n]+)/iu)?.[1]?.trim();
    fields.locations = place ? { status: 'present', value: [place] } : notStated;
  } else if (run.source_id === 'greenhouse-celonis') fields.locations = notStated;
  if (run.source_id === 'greenhouse-celonis') fields.workMode = notStated;
  if (run.source_id === 'ashby-sentry' || run.source_id === 'ashby-skydio' || run.source_id === 'greenhouse-oneethos') fields.eligibility = notStated;
  if (run.source_id === 'greenhouse-schonfeld') fields.timing = forcePresent;
  if (run.source_id === 'ashby-terranova') fields.housing = forcePresent;
  if (run.run_key === '33dd2f36d1ebc431495192c31ca6f8951df3dc4b33ca8703db9489837c7c287a') {
    fields.housing = forcePresent; fields.timing = forcePresent;
  }
  return { classification: extraction.classification, fields };
}

async function extractionFor(runKey: string): Promise<ShadowExtraction> {
  const raw = JSON.parse(await readFile(`${artifactsPath}/response/${runKey}.json`, 'utf8')) as { validation: { accepted?: ShadowExtraction } };
  if (!raw.validation.accepted) throw new Error(`${runKey} does not contain a validated extraction`);
  return raw.validation.accepted;
}

const baseline: ShadowEvalCaseResult[] = [];
const guarded: ShadowEvalCaseResult[] = [];
const changes: Array<{ id: string; changes: ReturnType<typeof postprocessRoleScopedExtraction>['changes'] }> = [];
for (const entry of audited) {
  const extraction = await extractionFor(entry.run.run_key);
  const source = JSON.parse(await readFile(`${artifactsPath}/input/${entry.run.run_key}.json`, 'utf8')) as { normalized: { description: string } };
  const expected = humanExpected(entry.run, extraction, source.normalized.description);
  const baselineEval = evaluateShadowCase(extraction, expected);
  baseline.push({ id: entry.run.run_key, valid: true, failures: [], ...baselineEval });
  const result = postprocessRoleScopedExtraction(extraction);
  const guardedEval = evaluateShadowCase(result.extraction, expected);
  guarded.push({ id: entry.run.run_key, valid: true, failures: [], ...guardedEval });
  if (result.changes.length) changes.push({ id: entry.run.run_key, changes: result.changes });
}
const report = { version: 1, scope: 'audited 25-case development split only; frozen random holdout remains unlabelled', baseline: summarizeShadowEval(baseline), roleScopeGuard: summarizeShadowEval(guarded), changes };
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
