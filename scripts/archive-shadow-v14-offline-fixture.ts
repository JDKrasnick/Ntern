#!/usr/bin/env node
/** Make a self-contained, immutable-input fixture for future offline v14 evaluation. */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root = '.context/shadow-v14-offline-fixture';
const cohorts = [
  ['first', '.context/shadow-fresh50-unique-artifacts/input', '.context/shadow-fresh50-gpt5mini-v14.json', '.context/shadow-fresh50-gpt5mini-v14-projected.json'],
  ['second', '.context/shadow-second-cohort-artifacts/input', '.context/shadow-second-cohort-gpt5mini-v14.json', '.context/shadow-second-cohort-gpt5mini-v14-projected.json'],
  ['third', '.context/shadow-third-cohort-artifacts/input', '.context/shadow-third-cohort-gpt5mini-v14.json', '.context/shadow-third-cohort-gpt5mini-v14-projected.json'],
] as const;
await mkdir(root, { recursive: true });
for (const [cohort, input, raw, projected] of cohorts) {
  await cp(input, join(root, cohort, 'input'), { recursive: true, force: true });
  await cp(raw, join(root, cohort, 'raw-v14.json'), { force: true });
  await cp(projected, join(root, cohort, 'projected-v14.json'), { force: true });
  await cp(`.context/shadow-${cohort}-v14-human-labels.json`, join(root, cohort, 'human-labels.json'), { force: true });
}
for (const file of ['.context/shadow-live-source-probe.json', '.context/shadow-live-inclusion-manifest.json']) {
  await cp(file, join(root, file.split('/').at(-1)!), { force: true });
}
await writeFile(join(root, 'README.md'), `# Frozen shadow v14 offline fixture\n\nThis is a transfer-ready, self-contained copy of the 100 frozen inputs, raw v14 responses, projected v14 responses, human labels, and the later live-page inclusion/exclusion record. Do not replace any v14 input/output here; score only with a new output path. The evaluation denominator is defined by \`shadow-live-inclusion-manifest.json\`, not by the input count. \`manifest.json\` supplies SHA-256 checksums for integrity verification.\n`);
async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    if ((await stat(path)).isDirectory()) found.push(...await files(path)); else found.push(path);
  }
  return found;
}
const manifest = await Promise.all((await files(root)).filter((file) => !file.endsWith('manifest.json')).map(async (file) => ({
  path: relative(root, file), bytes: (await stat(file)).size, sha256: createHash('sha256').update(await readFile(file)).digest('hex'),
})));
await writeFile(join(root, 'manifest.json'), `${JSON.stringify({ version: 1, fixture: 'shadow-v14-frozen-100', generatedAt: new Date().toISOString(), records: manifest.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`);
console.log(`Archived ${manifest.length} files at ${root}`);
