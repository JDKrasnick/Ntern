#!/usr/bin/env node
/**
 * Give the Worker's WebAssembly part a stable name.
 *
 * Wrangler emits a module rule's file as `<content-hash>-<basename>` and imports it
 * by that name, which is fine for `wrangler deploy` and useless for the OpenTofu
 * upload: the `files` map key has to equal the import specifier, so a hash in the
 * name would put a content hash in `infra/cloudflare/main.tf` and break the plan the
 * next time the dependency moves.
 *
 * The bundle therefore ships exactly one wasm module — the SVG rasterizer — and this
 * step renames it to `resvg.wasm` and rewrites the specifier in the built JavaScript
 * and its source map, so both the Wrangler upload and the OpenTofu upload carry the
 * same stable part name.
 *
 * Usage: node scripts/prepare-worker-modules.mjs <bundle-directory>
 */

import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STABLE_NAME = 'resvg.wasm';
const directory = process.argv[2];
if (!directory) {
  console.error('Usage: node scripts/prepare-worker-modules.mjs <bundle-directory>');
  process.exit(1);
}

const entries = await readdir(directory);
// A previous run's renamed module is not a second module; Wrangler writes the
// content-hashed name, and the stable name is this script's own output.
const emitted = entries.filter((entry) => entry.endsWith('.wasm') && entry !== STABLE_NAME);
// A bundle that imports no WebAssembly has nothing to prepare — the API Worker's
// bundle is one, because only the ingestion entry carries the rasterizer.
if (!emitted.length && !entries.includes(STABLE_NAME)) {
  console.log(`${directory}: no wasm module to prepare`);
  process.exit(0);
}
if (emitted.length !== 1) {
  console.error(`${directory}: expected exactly one wasm module, found ${emitted.length} (${emitted.join(', ') || 'none'})`);
  process.exit(1);
}
const [source] = emitted;
await rename(join(directory, source), join(directory, STABLE_NAME));

const rewritten = [];
for (const entry of entries.filter((name) => name.endsWith('.js') || name.endsWith('.js.map'))) {
  const path = join(directory, entry);
  const contents = await readFile(path, 'utf8');
  if (!contents.includes(source)) continue;
  await writeFile(path, contents.split(source).join(STABLE_NAME));
  rewritten.push(entry);
}
if (!rewritten.length) {
  console.error(`${directory}: no built file referenced ${source}, so the module would not resolve`);
  process.exit(1);
}
console.log(`${directory}: ${source} → ${STABLE_NAME}, specifier rewritten in ${rewritten.join(', ')}`);
