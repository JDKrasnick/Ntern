#!/usr/bin/env node
/** Read-only live-source availability evidence for the frozen shadow cohorts. */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

const roots = ['.context/shadow-fresh50-unique-artifacts/input', '.context/shadow-second-cohort-artifacts/input', '.context/shadow-third-cohort-artifacts/input'];
const output = process.argv[2] ?? '.context/shadow-live-source-probe.json';
type Entry = { id: string; title: string; sourceUrl: string };
const entries: Entry[] = [];
for (const root of roots) for (const file of await readdir(root)) {
  if (!file.endsWith('.json')) continue;
  const input = JSON.parse(await readFile(join(root, file), 'utf8')) as { identity: { sourceUrl: string }; normalized: { title: string } };
  entries.push({ id: basename(file, '.json'), title: input.normalized.title, sourceUrl: input.identity.sourceUrl });
}
const settled = await Promise.all(entries.map(async (entry) => {
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(entry.sourceUrl, { headers: { 'user-agent': 'InternNotifs source verification (read-only)' }, signal: AbortSignal.timeout(20_000) });
    const body = await response.text();
    return { ...entry, checkedAt: startedAt, status: response.status, finalUrl: response.url, contentType: response.headers.get('content-type'), bytes: body.length,
      visibleTitleMatch: body.toLowerCase().includes(entry.title.toLowerCase()) };
  } catch (error) { return { ...entry, checkedAt: startedAt, status: null, error: error instanceof Error ? error.message : String(error) }; }
}));
await mkdir('.context', { recursive: true });
await writeFile(output, `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), entries: settled }, null, 2)}\n`);
console.log(`Wrote ${settled.length} live source probes to ${output}`);
