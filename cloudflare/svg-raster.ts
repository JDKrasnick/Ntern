/**
 * The resvg WebAssembly renderer behind `IconSvgRasterizer`.
 *
 * Only a document `safeIconSvg` already accepted reaches this module, and only the
 * rendered PNG leaves it. The renderer is initialized once per isolate and never
 * throws: an SVG it cannot draw costs that employer its board logo, nothing more.
 *
 * Fonts are never loaded. resvg would otherwise try the filesystem, which a Worker
 * does not have, and a mark that is nothing but live text is not one we want to
 * store anyway; every shape the ATS boards publish is outlined.
 */

import { Resvg, initWasm, type InitInput } from '@resvg/resvg-wasm';
import { MAX_ICON_ASSET_BYTES } from '../src/employer-icon-discovery.js';
import { ICON_SVG_RASTER_WIDTH, type IconSvgRasterizer } from '../src/svg-icon.js';

export function createIconSvgRasterizer(wasm: InitInput): IconSvgRasterizer {
  let ready: Promise<void> | undefined;
  const initialize = (): Promise<void> => {
    // A rejected initialization must not be cached: the next sweep gets a fresh one.
    ready ??= initWasm(wasm).then(() => undefined, (error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
  return async (safeSvg) => {
    try {
      await initialize();
      const image = new Resvg(safeSvg, {
        fitTo: { mode: 'width', value: ICON_SVG_RASTER_WIDTH },
        font: { loadSystemFonts: false },
      }).render();
      const png = image.asPng();
      return png.byteLength > 0 && png.byteLength <= MAX_ICON_ASSET_BYTES ? png : undefined;
    } catch {
      return undefined;
    }
  };
}
