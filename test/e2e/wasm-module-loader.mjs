/**
 * Node cannot import a `.wasm` file as a module, but a compiled Worker bundle imports
 * its WebAssembly part exactly that way — and these suites import the compiled bundle
 * in-process to inject an outbound fetch and to count the rows D1 billed.
 *
 * This hook compiles the same bytes into a `WebAssembly.Module` and hands it over as
 * the module's default export, so the bundle under test in Node is the bundle that
 * gets uploaded rather than a variant of it.
 *
 * Usage: `register('./wasm-module-loader.mjs', import.meta.url)` before the import.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.wasm')) return nextLoad(url, context);
  const bytes = await readFile(fileURLToPath(url));
  return {
    format: 'module',
    shortCircuit: true,
    source: `export default new WebAssembly.Module(Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64'));`,
  };
}
