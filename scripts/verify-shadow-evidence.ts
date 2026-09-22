#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const cohorts = [
  ['first', '.context/shadow-fresh50-gpt5mini-v14.json', '.context/shadow-fresh50-gpt5mini-v14-projected.json', '.context/shadow-fresh50-unique-artifacts/input'],
  ['second', '.context/shadow-second-cohort-gpt5mini-v14.json', '.context/shadow-second-cohort-gpt5mini-v14-projected.json', '.context/shadow-second-cohort-artifacts/input'],
  ['third', '.context/shadow-third-cohort-gpt5mini-v14.json', '.context/shadow-third-cohort-gpt5mini-v14-projected.json', '.context/shadow-third-cohort-artifacts/input'],
] as const;
const out = process.argv[2] ?? '.context/shadow-evidence-verification.json';
type Field = { status: string; evidence?: string[] };
// Evidence is verbatim apart from extraction's observed quote/control-character
// corruption, so compare lexical tokens rather than byte-level punctuation.
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const rows: unknown[] = [];
for (const [cohort, rawPath, projectedPath, inputRoot] of cohorts) {
  for (const [kind, path, fieldRoot] of [['raw', rawPath, 'raw'], ['projected', projectedPath, 'extraction']] as const) {
    const report = JSON.parse(await readFile(path, 'utf8')) as { records: Array<{ id: string; valid: boolean; raw?: { fields: Record<string, Field> }; extraction?: { fields: Record<string, Field> } }> };
    for (const record of report.records) {
      const input = JSON.parse(await readFile(join(inputRoot, `${record.id}.json`), 'utf8')) as { normalized: { description: string } };
      const fields = fieldRoot === 'raw' ? record.raw?.fields : record.extraction?.fields;
      for (const [field, claim] of Object.entries(fields ?? {})) if (claim.status === 'present') {
        const evidence = claim.evidence ?? [];
        const unsupported = evidence.filter((span) => !norm(input.normalized.description).includes(norm(span)));
        rows.push({ cohort, kind, id: record.id, field, valid: record.valid, evidenceCount: evidence.length, unsupportedEvidence: unsupported });
      }
    }
  }
}
const output = { generatedAt: new Date().toISOString(), claims: rows };
await mkdir(dirname(out), { recursive: true }); await writeFile(out, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Verified ${rows.length} positive claims; wrote ${out}`);
