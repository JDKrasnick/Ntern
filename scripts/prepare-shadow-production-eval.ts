#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

type Run = { run_key: string; source_id: string; external_id: string; content_hash: string; input_key: string; response_key: string; completed_at: string };

const option = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const cohortPath = option('--cohort') ?? '.context/pr324-cohort.json';
const poolPath = option('--random-pool') ?? '.context/shadow-eval-random-pool.json';
const outputPath = option('--out') ?? 'eval/shadow-production-eval-manifest.json';
const cohort = (JSON.parse(await readFile(cohortPath, 'utf8')) as { 0: { results: Run[] } })[0].results;
const pool = (JSON.parse(await readFile(poolPath, 'utf8')) as { 0: { results: Run[] } })[0].results;
const cohortKeys = new Set(cohort.map((run) => run.run_key));
const random = pool.filter((run) => !cohortKeys.has(run.run_key)).slice(0, 25);
if (cohort.length !== 25 || random.length !== 25) throw new Error(`Expected 25 audited and 25 random cases; got ${cohort.length} and ${random.length}`);

const cases = [
  ...cohort.map((run) => ({ id: run.run_key, split: 'audited', reviewState: 'reviewed', run })),
  ...random.map((run) => ({ id: run.run_key, split: 'random-holdout', reviewState: 'pending', run })),
];
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({
  version: 1,
  tool: 'braintrust',
  purpose: 'Metadata extraction postprocessing evaluation. The 25-case audited development split is labelled; the frozen random holdout requires independent human labels before it can score a variant.',
  selection: {
    audited: 'First 25 completed natural provider-poll runs using shadow-extraction-schema-v5 and shadow-extraction-prompt-v9.',
    random: 'First 25 non-overlapping rows from a read-only ORDER BY random() pool captured 2026-09-21; selection is frozen by run key below.',
    maximumCases: 50,
  },
  cases,
}, null, 2)}\n`);
console.log(`Wrote ${cases.length}-case manifest to ${outputPath}`);
