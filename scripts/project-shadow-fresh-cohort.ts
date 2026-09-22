#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeExactPostingDescription, projectShadowExtractionToSupportedFields, type ShadowExtraction } from '../src/shadow-extraction.js';
import { postprocessRoleScopedExtraction } from '../src/shadow-extraction-postprocess.js';

type Record = { id: string; valid: boolean; sourceId: string; inputCompleteness?: string; response?: unknown; raw?: ShadowExtraction; guarded?: ShadowExtraction; changes?: unknown[] };
type Report = { records: Record[] };
const option = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const reportPath = option('--report') ?? '.context/shadow-fresh50-gpt5mini-v10-projected.json';
const artifactsPath = option('--artifacts') ?? '.context/shadow-fresh50-unique-artifacts';
const sourceReport = option('--source-report');
const version = option('--version') ?? 'v11';
const prefix = option('--prefix') ?? 'gpt5mini';
const basePaths = [0, 10, 20, 30, 40].map((offset) => `.context/shadow-fresh50-${prefix}-${version}-${offset}.json`);
const retryPath = option('--retry');
const base = sourceReport ? (JSON.parse(await readFile(sourceReport, 'utf8')) as Report).records
  : (await Promise.all(basePaths.map(async (path) => (JSON.parse(await readFile(path, 'utf8')) as Report).records))).flat();
const retried = retryPath ? (JSON.parse(await readFile(retryPath, 'utf8')) as Report).records : [];
const chosen = new Map(base.map((record) => [record.id, record]));
for (const record of retried) chosen.set(record.id, record);
const fields = ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education', 'eligibility'];
const present: Record<string, number> = Object.fromEntries(fields.map((field) => [field, 0]));
const removed: Record<string, number> = Object.fromEntries(fields.map((field) => [field, 0]));
const records: Array<Record<string, unknown>> = [];
for (const record of chosen.values()) {
  const artifact = JSON.parse(await readFile(`${artifactsPath}/input/${record.id}.json`, 'utf8')) as { normalized: { title: string; description: string; completeness: string } };
  const input = normalizeExactPostingDescription(artifact.normalized.title, artifact.normalized.description, artifact.normalized.completeness === 'incomplete');
  let extraction = record.raw ? postprocessRoleScopedExtraction(record.raw, input.completeness).extraction : record.guarded;
  let projectedFields: string[] = [];
  if (!extraction) {
    const projection = projectShadowExtractionToSupportedFields(record.response, input);
    if (!projection.accepted) {
      records.push({ id: record.id, sourceId: record.sourceId, valid: false, failures: projection.failures });
      continue;
    }
    projectedFields = projection.removedFields;
    extraction = postprocessRoleScopedExtraction(projection.accepted, input.completeness).extraction;
  }
  for (const [field, value] of Object.entries(extraction.fields)) if (value.status === 'present') present[field]++;
  for (const field of projectedFields) removed[field]++;
  records.push({ id: record.id, sourceId: record.sourceId, valid: true, extraction, projectedFields });
}
const report = { version: 1, purpose: 'Fresh 50-content cohort after prompt retry and conservative evidence projection. Structural validity is not factual accuracy; manual labels remain required.',
  totalCases: chosen.size, validCases: records.filter((record) => record.valid).length, invalidCases: records.filter((record) => !record.valid).length,
  present, tagsRemovedByEvidenceProjection: removed, records };
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ totalCases: report.totalCases, validCases: report.validCases, invalidCases: report.invalidCases, present, tagsRemovedByEvidenceProjection: removed }, null, 2));
