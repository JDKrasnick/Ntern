import { describe, expect, it } from 'vitest';
import { MAX_ICON_SVG_BYTES, safeIconSvg } from '../src/svg-icon.js';
import { createIconSvgRasterizer } from '../cloudflare/svg-raster.js';
import { rasterDimensions } from '../src/employer-icon-discovery.js';
import { readFileSync } from 'node:fs';

const bytes = (value: string) => new TextEncoder().encode(value);
const svg = (body: string) => bytes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`);

describe('board-logo SVG sanitizing', () => {
  it('accepts an ordinary logo document', () => {
    expect(safeIconSvg(svg('<path d="M0 0h100v100H0z" fill="#0af"/>'))).toBeDefined();
    // A prolog, comments, gradients, text, and an embedded data: image are all fine.
    const rich = bytes('<?xml version="1.0" encoding="utf-8"?>'
      + '<!-- Exported by a design tool -->\n'
      + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">'
      + '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>'
      + '<path d="M4 4h56v56H4z" fill="url(#g)"/>'
      + '<image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="8" height="8"/>'
      + '<text x="4" y="60">ACME</text></svg>');
    expect(safeIconSvg(rich)).toBeDefined();
  });

  it('refuses a document that could execute, fetch, or expand', () => {
    const dangerous = [
      '<!DOCTYPE svg [<!ENTITY x "y">]>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      '<script>alert(1)</script>',
      '<SCRIPT xlink:href="data:,">alert(1)</SCRIPT>',
      '<foreignObject><body onload="alert(1)"/></foreignObject>',
      '<iframe src="https://evil.test/x"/>',
      '<object data="https://evil.test/x"/>',
      '<path d="M0 0" onload="alert(1)"/>',
      '<a href="javascript:alert(1)"><path d="M0 0"/></a>',
      '<image href="https://evil.test/x.png" width="8" height="8"/>',
      '<image xlink:href="//evil.test/x.png" width="8" height="8"/>',
      '<image src="http://evil.test/x.png" width="8" height="8"/>',
      '<rect style="fill:url(https://evil.test/x.svg#g)"/>',
      '<rect style="fill:url(//evil.test/x.svg#g)"/>',
      '<?xml-stylesheet href="https://evil.test/x.css"?>',
      // Character references are legal XML and must not hide any of the above.
      '<image href="&#x68;ttps://evil.test/x.png" width="8" height="8"/>',
      '<a href="java&#115;cript:alert(1)"><path d="M0 0"/></a>',
      '<image xlink:href="https&#58;//evil.test/x.png" width="8" height="8"/>',
      // Namespace-prefixed element names.
      '<svg:script>alert(1)</svg:script>',
      '<xlink:script>alert(1)</xlink:script>',
      '<svg:foreignObject><body/></svg:foreignObject>',
      // CSS import in either form, and an off-domain base URI.
      '<style>@import "https://evil.test/x.css";</style>',
      '<style>@import url(https://evil.test/x.css);</style>',
      '<image xml:base="https://evil.test/" href="x.png" width="8" height="8"/>',
      // SMIL can retarget a reference after a static scan.
      '<a><animate attributeName="href" to="https://evil.test"/></a>',
      '<image><set attributeName="xlink:href" to="https://evil.test/x.png"/></image>',
    ];
    for (const body of dangerous) {
      expect(safeIconSvg(svg(body)), body).toBeUndefined();
      expect(safeIconSvg(bytes(body)), body).toBeUndefined();
    }
  });

  it('still accepts benign character references in text', () => {
    expect(safeIconSvg(svg('<text x="4" y="60" fill="#fff">ACME &#169; 2026</text>'))).toBeDefined();
  });

  it('refuses a document that is not a bounded SVG at all', () => {
    expect(safeIconSvg(new Uint8Array(0))).toBeUndefined();
    expect(safeIconSvg(bytes('<html><body><svg/></body></html>'))).toBeUndefined();
    expect(safeIconSvg(bytes('{"logo":"https://acme.test/x.svg"}'))).toBeUndefined();
    // A PNG whose bytes are not UTF-8: the raster path owns those.
    expect(safeIconSvg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]))).toBeUndefined();
    // An SVG document larger than any board logo is refused rather than rendered.
    const oversized = new Uint8Array(MAX_ICON_SVG_BYTES + 1);
    oversized.set(bytes('<svg xmlns="http://www.w3.org/2000/svg">').subarray(0, 40));
    expect(safeIconSvg(oversized)).toBeUndefined();
  });
});

describe('board-logo SVG rasterizing', () => {
  // The real resvg module the Worker ships, so the renderer under test is the one
  // that runs in production rather than a stand-in for it.
  const rasterize = createIconSvgRasterizer(
    readFileSync(new URL('../node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url)),
  );

  it('renders a square mark to a PNG at the icon width', async () => {
    const png = await rasterize(safeIconSvg(svg('<rect width="100" height="100" fill="#0af"/>'))!);
    expect(png).toBeDefined();
    expect([...png!.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(rasterDimensions(png!)).toEqual({ width: 256, height: 256 });
  });

  it('preserves the document’s aspect ratio', async () => {
    const wide = bytes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 300"><rect width="1400" height="300" fill="#333"/></svg>');
    const png = await rasterize(safeIconSvg(wide)!);
    expect(rasterDimensions(png!)).toEqual({ width: 256, height: 55 });
  });

  it('returns nothing rather than throwing when a document cannot be drawn', async () => {
    // Well-formed enough to pass the sanitizer, but not a drawable document.
    await expect(rasterize(safeIconSvg(bytes('<svg xmlns="http://www.w3.org/2000/svg"><path d="not-a-path"/></svg>'))!))
      .resolves.toBeDefined();
    await expect(rasterize(new Uint8Array(0))).resolves.toBeUndefined();
  });
});
