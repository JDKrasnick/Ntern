/**
 * The compiled resvg WebAssembly module, as the ingestion Worker imports it.
 *
 * The `CompiledWasm` module rule in `wrangler.ingestion.jsonc` turns the import into
 * a `WebAssembly.Module`, which is uploaded as its own part (`resvg.wasm`) by both
 * Wrangler and the OpenTofu `files` map, so the wasm is compiled once per isolate
 * rather than parsed from bytes on every render.
 *
 * The import is deferred until the first SVG board logo has to be rendered. The
 * module is 2.5 MB, most runs never meet an SVG at all, and only this entry can
 * reference it, so the API Worker's bundle stays free of it and a unit test that
 * merely imports an entry point never has to load a WebAssembly module.
 */

import { createIconSvgRasterizer } from './svg-raster.js';
import type { IconSvgRasterizer } from '../src/svg-icon.js';

let loading: Promise<IconSvgRasterizer> | undefined;

export function loadIconSvgRasterizer(): Promise<IconSvgRasterizer> {
  loading ??= import('@resvg/resvg-wasm/index_bg.wasm')
    .then(({ default: wasm }) => createIconSvgRasterizer(wasm));
  return loading;
}

/** The renderer the sweep uses: it loads the module when it first needs it. */
export const rasterizeSvgIcon: IconSvgRasterizer = async (safeSvg) => (await loadIconSvgRasterizer())(safeSvg);
