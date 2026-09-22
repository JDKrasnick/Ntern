#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const configs = [
  ['first', '.context/shadow-fresh50-gpt5mini-v14-projected.json', '.context/shadow-fresh50-unique-artifacts/input'],
  ['second', '.context/shadow-second-cohort-gpt5mini-v14-projected.json', '.context/shadow-second-cohort-artifacts/input'],
  ['third', '.context/shadow-third-cohort-gpt5mini-v14-projected.json', '.context/shadow-third-cohort-artifacts/input'],
] as const;
const cues: Record<string, RegExp> = {
  compensation: /\$\s?\d|pay range|hourly rate|salary range|compensation/i,
  locations: /\b(?:location|office|based|onsite|on-site|hybrid|remote)\b/i,
  workMode: /\b(?:hybrid|remote|on-?site|in person|in-person)\b/i,
  housing: /\b(?:housing|relocation stipend|relocation support|corporate housing)\b/i,
  timing: /\b(?:weeks?|months?|summer|fall|winter|spring|full[- ]time|part[- ]time|hours? per week|start(?:ing)?\b|end date)\b/i,
  education: /\b(?:degree|bachelor|master|phd|ph\.d|gpa|enrolled|pursuing|student)\b/i,
  eligibility: /\b(?:sponsor(?:ship)?|authorized to work|citizen(?:ship)?|clearance|export control|visa)\b/i,
};
const candidates: unknown[] = [];
for (const [cohort, reportPath, inputRoot] of configs) {
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { records: Array<{ id: string; extraction: { fields: Record<string, { status: string }> } }> };
  for (const record of report.records) {
    const input = JSON.parse(await readFile(join(inputRoot, `${record.id}.json`), 'utf8')) as { normalized: { title: string; description: string } };
    for (const [field, cue] of Object.entries(cues)) if (record.extraction.fields[field]?.status !== 'present' && cue.test(input.normalized.description)) {
      candidates.push({ cohort, id: record.id, title: input.normalized.title, field, excerpts: input.normalized.description.split(/(?<=[.!?])\s+/u).filter((line) => cue.test(line)).slice(0, 3) });
    }
  }
}
const out = '.context/shadow-omission-candidates.json'; await mkdir(dirname(out), { recursive: true }); await writeFile(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), candidates }, null, 2)}\n`);
console.log(`Wrote ${candidates.length} omission candidates to ${out}`);
