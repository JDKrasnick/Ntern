import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ICON_ASSET_BYTES } from '../src/employer-icon-discovery.js';
const native = vi.hoisted(() => ({ live: 0, failRender: false, failEncode: false, png: new Uint8Array([1, 2, 3]) }));
vi.mock('@resvg/resvg-wasm', () => ({
  initWasm: vi.fn(async () => undefined),
  Resvg: class {
    constructor() { native.live++; }
    free() { native.live--; }
    render() {
      if (native.failRender) throw Error('render failed');
      native.live++;
      return {
        free() { native.live--; native.png.fill(0); },
        asPng() { if (native.failEncode) throw Error('encode failed'); return native.png; },
      };
    }
  },
}));
import { createIconSvgRasterizer } from '../cloudflare/svg-raster.js';
describe('SVG native allocation lifecycle', () => {
  beforeEach(() => { native.live = 0; native.failRender = false; native.failEncode = false; native.png = new Uint8Array([1, 2, 3]); });
  it('releases every native image and renderer across repeated sweeps while preserving PNG bytes', async () => {
    const render = createIconSvgRasterizer(new Uint8Array());
    for (let i = 0; i < 200; i++) {
      native.png = new Uint8Array([1, 2, 3]);
      expect(await render(new TextEncoder().encode('<svg/>'))).toEqual(new Uint8Array([1, 2, 3]));
      expect(native.live).toBe(0);
    }
  });
  it.each(['render', 'encode'])('releases allocations after %s failure', async (phase) => {
    native.failRender = phase === 'render'; native.failEncode = phase === 'encode';
    expect(await createIconSvgRasterizer(new Uint8Array())(new TextEncoder().encode('<svg/>'))).toBeUndefined();
    expect(native.live).toBe(0);
  });
  it('releases oversized rejected PNGs', async () => {
    native.png = new Uint8Array(MAX_ICON_ASSET_BYTES + 1);
    expect(await createIconSvgRasterizer(new Uint8Array())(new TextEncoder().encode('<svg/>'))).toBeUndefined();
    expect(native.live).toBe(0);
  });
});
