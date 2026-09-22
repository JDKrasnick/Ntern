#!/usr/bin/env node
/** Score frozen shadow reports against evidence-bearing, source-derived labels. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { shadowEvalFields, shadowValuesMatch, type ShadowEvalFieldName } from '../src/shadow-extraction-eval.js';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const labelsPath = option('--labels'); const rawPath = option('--raw-report'); const projectedPath = option('--projected-report'); const outputBase = option('--out');
if (!labelsPath || !rawPath || !projectedPath || !outputBase) throw new Error('Usage: tsx scripts/score-shadow-human-labels.ts --labels <labels.json> --raw-report <raw.json> --projected-report <projected.json> --out <base>');

type Status = 'present' | 'not-stated';
type Label = { status: Status; value?: unknown; sourceEvidence: string[]; notes: string };
type Fields = Record<string, { status: string; value: unknown }>;
type ExtractionRecord = { id: string; valid: boolean; extraction?: { fields: Fields }; raw?: { fields: Fields } };
type Counts = { TP: number; UC: number; VM: number; FN: number; TN: number };
const empty = (): Counts => ({ TP: 0, UC: 0, VM: 0, FN: 0, TN: 0 });
const rate = (n: number, d: number) => d ? n / d : null;
const metrics = (counts: Counts) => ({ ...counts, precision: rate(counts.TP, counts.TP + counts.UC + counts.VM), recall: rate(counts.TP, counts.TP + counts.VM + counts.FN) });
const readable = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : value;
const valuesMatch = (field: ShadowEvalFieldName, actual: unknown, expected: unknown) => ['compensation', 'locations', 'workMode'].includes(field)
  ? shadowValuesMatch(field, actual, expected)
  : JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));

const labels = JSON.parse(await readFile(labelsPath, 'utf8')) as { cohort: string; labels: Array<{ id: string; fields: Record<ShadowEvalFieldName, Label> }> };
const raw = JSON.parse(await readFile(rawPath, 'utf8')) as { records: ExtractionRecord[]; validCases: number; totalCases: number };
const projected = JSON.parse(await readFile(projectedPath, 'utf8')) as { records: ExtractionRecord[]; validCases: number; totalCases: number; present: Record<string, number>; tagsRemovedByEvidenceProjection: number };
if (!Array.isArray(labels.labels) || labels.labels.length === 0) throw new Error('labels.labels must be non-empty');
const byId = new Map(labels.labels.map((label) => [label.id, label]));
if (byId.size !== labels.labels.length || byId.size !== raw.records.length || raw.records.length !== projected.records.length) throw new Error('Labels, raw report, and projected report must have the same unique record count');
for (const record of raw.records) {
  const label = byId.get(record.id); if (!label) throw new Error(`Missing label for ${record.id}`);
  for (const field of shadowEvalFields) {
    const item = label.fields[field];
    if (!item || (item.status !== 'present' && item.status !== 'not-stated') || !Array.isArray(item.sourceEvidence) || typeof item.notes !== 'string') throw new Error(`Invalid ${field} label for ${record.id}`);
    if (item.status === 'present' && !('value' in item)) throw new Error(`Present ${field} label missing value for ${record.id}`);
    if (item.status === 'present' && item.sourceEvidence.length === 0) throw new Error(`Present ${field} label missing source evidence for ${record.id}`);
    if (item.status === 'not-stated' && 'value' in item) throw new Error(`Not-stated ${field} label has a value for ${record.id}`);
  }
}
const rawById = new Map(raw.records.map((record) => [record.id, record])); const finalById = new Map(projected.records.map((record) => [record.id, record]));
function score(name: 'raw' | 'projected', conditional: boolean) {
  const aggregate = empty(); const fields = Object.fromEntries(shadowEvalFields.map((field) => [field, empty()])) as Record<ShadowEvalFieldName, Counts>;
  const roles: Array<{ id: string; valid: boolean; verdicts: Record<ShadowEvalFieldName, keyof Counts> }> = [];
  for (const labelRecord of labels.labels) {
    const record = (name === 'raw' ? rawById : finalById).get(labelRecord.id)!;
    if (conditional && !record.valid) continue;
    const verdicts = {} as Record<ShadowEvalFieldName, keyof Counts>;
    for (const field of shadowEvalFields) {
      const label = labelRecord.fields[field]; const predicted = record.valid ? (name === 'raw' ? record.raw?.fields[field] : record.extraction?.fields[field]) : undefined;
      let result: keyof Counts;
      if (label.status === 'not-stated') result = predicted?.status === 'present' ? 'UC' : 'TN';
      else if (predicted?.status !== 'present') result = 'FN';
      else result = valuesMatch(field, predicted.value, label.value) ? 'TP' : 'VM';
      verdicts[field] = result; aggregate[result]++; fields[field][result]++;
    }
    roles.push({ id: labelRecord.id, valid: record.valid, verdicts });
  }
  return { cases: roles.length, aggregate: metrics(aggregate), fields: Object.fromEntries(shadowEvalFields.map((field) => [field, metrics(fields[field])])), roles };
}
const result = { cohort: labels.cohort, provenance: { labelsPath, rawPath, projectedPath, denominator: labels.labels.length, rawValid: raw.validCases, finalValid: projected.validCases, finalRetainedTags: Object.values(projected.present).reduce((a, b) => a + b, 0), tagsRemovedByEvidenceProjection: projected.tagsRemovedByEvidenceProjection }, raw: { endToEnd: score('raw', false), conditionalOnValid: score('raw', true) }, projected: { endToEnd: score('projected', false), conditionalOnValid: score('projected', true) } };
await mkdir(dirname(`${outputBase}.json`), { recursive: true }); await writeFile(`${outputBase}.json`, `${JSON.stringify(result, null, 2)}\n`);
const table = (title: string, section: ReturnType<typeof score>) => `## ${title}\n\nCases: ${section.cases}\n\n| field | TP | UC | VM | FN | TN | precision | recall |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n| all | ${section.aggregate.TP} | ${section.aggregate.UC} | ${section.aggregate.VM} | ${section.aggregate.FN} | ${section.aggregate.TN} | ${readable(section.aggregate.precision)} | ${readable(section.aggregate.recall)} |\n${shadowEvalFields.map((field) => { const c = section.fields[field]; return `| ${field} | ${c.TP} | ${c.UC} | ${c.VM} | ${c.FN} | ${c.TN} | ${readable(c.precision)} | ${readable(c.recall)} |`; }).join('\n')}\n`;
await writeFile(`${outputBase}.md`, `# ${labels.cohort} v14 human-label score\n\nDenominator: ${result.provenance.denominator} roles; raw valid: ${raw.validCases}/${raw.totalCases}; final valid: ${projected.validCases}/${projected.totalCases}; final retained tags: ${result.provenance.finalRetainedTags}; tags removed: ${projected.tagsRemovedByEvidenceProjection}.\n\n${table('Raw end-to-end', result.raw.endToEnd)}\n${table('Raw conditional on valid response', result.raw.conditionalOnValid)}\n${table('Projected end-to-end', result.projected.endToEnd)}\n${table('Projected conditional on valid response', result.projected.conditionalOnValid)}\n`);
console.log(JSON.stringify(result.provenance, null, 2));
