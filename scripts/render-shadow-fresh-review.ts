#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

const reportPath = '.context/shadow-fresh50-gpt5mini-v10-projected.json';
const artifactsPath = '.context/shadow-fresh50-unique-artifacts/input';
const outputPath = '.context/shadow-fresh50-manual-review.md';
const report = JSON.parse(await readFile(reportPath, 'utf8')) as { records: Array<{ id: string; sourceId: string; extraction: { fields: Record<string, { status: string; value: unknown; evidence: string[] }> }; projectedFields: string[] }> };
const blocks: string[] = ['# Fresh 50 metadata review', '', 'Each retained tag is listed with its model value and verbatim evidence. Mark semantic correctness independently of structural validation.', ''];
for (const [index, record] of report.records.entries()) {
  const input = JSON.parse(await readFile(`${artifactsPath}/${record.id}.json`, 'utf8')) as { normalized: { title: string; completeness: string } };
  blocks.push(`## ${index + 1}. ${input.normalized.title}`, '', `- ID: \`${record.id}\``, `- Source: \`${record.sourceId}\`; input: ${input.normalized.completeness}`);
  if (record.projectedFields.length) blocks.push(`- Evidence projection removed: ${record.projectedFields.join(', ')}`);
  for (const [field, value] of Object.entries(record.extraction.fields)) {
    if (value.status !== 'present') continue;
    blocks.push(`- **${field}** — \`${JSON.stringify(value.value)}\``);
    for (const evidence of value.evidence) blocks.push(`  - Evidence: ${evidence.replace(/\n/g, ' ')}`);
  }
  blocks.push('');
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${blocks.join('\n')}\n`);
console.log(`Wrote ${report.records.length} roles to ${outputPath}`);
