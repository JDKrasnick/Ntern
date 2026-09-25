/**
 * Bounded SVG rasterization for board logos that are published only as SVG.
 *
 * The public icon route serves AVIF, PNG, and WebP only, because a browser opening
 * an SVG directly runs its script on the API origin. Some employers publish their
 * board logo as an SVG with no raster beside it, so the document is rasterized and
 * only the resulting PNG is stored: the publisher's document never reaches a
 * client, an R2 key, or the API origin.
 *
 * `safeIconSvg` narrows an untrusted document to a bounded, inert one before any
 * renderer sees it, and the renderer is injected — `cloudflare/svg-raster.ts` wraps
 * resvg and the ingestion Worker supplies it — so these rules stay pure, directly
 * testable, and independent of the rasterizer's own dependency.
 *
 * The sanitizer rejects rather than rewrites. A document that needs rewriting to be
 * safe is one we cannot reason about, and every rejection simply falls through to
 * the next candidate or to the monogram.
 */

/** A larger document than this is not a board logo, and is not worth rendering. */
export const MAX_ICON_SVG_BYTES = 512 * 1024;
/** Rendered width in pixels; the icon tile is square, so height follows the ratio. */
export const ICON_SVG_RASTER_WIDTH = 256;

/**
 * Rasterizes a document `safeIconSvg` already accepted. Returns the PNG bytes, or
 * undefined when the document cannot be rendered. Implementations never throw: a
 * logo is never worth failing a sweep.
 */
export type IconSvgRasterizer = (safeSvg: Uint8Array) => Promise<Uint8Array | undefined>;

/**
 * Constructs that can execute script, load a remote resource, or expand an entity.
 * A board logo needs none of them:
 *
 * - `<!doctype` / `<!entity` are how entity expansion ("billion laughs") is declared.
 * - `<script>`, `<foreignObject>`, and the embedded-document elements run or embed
 *   live content. The element name may carry a namespace prefix (`<svg:script>`).
 * - a SMIL animation element can retarget `href`/`src` after the static document was
 *   scanned, so a mark that needs to animate is refused.
 * - `@import` in a style loads a remote stylesheet, in either the `url(…)` or the
 *   bare-substring form.
 * - `xml:base` re-bases every relative reference off the employer's domain.
 * - an `on*=` attribute is an event handler.
 * - `javascript:` is a script URL.
 * - a non-`data:` scheme in `href`/`src` makes the renderer fetch a remote resource,
 *   and a protocol-relative `//host/path` does the same with no scheme at all.
 * - `url(//…)` in a style or attribute does the same through CSS.
 *
 * Everything else — paths, shapes, gradients, filters, text, and embedded `data:`
 * images — is allowed, so the stored PNG looks like the logo the employer published.
 */
const SVG_DANGEROUS = [
  /<!doctype/iu, /<!entity/iu, /<\?xml-stylesheet/iu,
  /<(?:[a-z0-9]+:)?script/iu, /<(?:[a-z0-9]+:)?foreignobject/iu,
  /<(?:[a-z0-9]+:)?iframe/iu, /<(?:[a-z0-9]+:)?embed/iu, /<(?:[a-z0-9]+:)?object/iu,
  /<(?:[a-z0-9]+:)?(?:animate|set|animatetransform|animatemotion|discard)\b/iu,
  /@import/iu,
  /xml:base\s*=/iu,
  /(?:^|[\s"'<(])on[a-z]{3,}\s*=/iu,
  /javascript:/iu,
  /(?:href|src)\s*=\s*["']?\s*(?!data:)[a-z][a-z0-9+.-]*:/iu,
  /(?:href|src)\s*=\s*["']?\s*\/\//iu,
  /url\(\s*["']?\s*(?:https?:)?\/\//iu,
];

const SVG_LEADING = /^(?:\uFEFF|\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->)+/u;

/**
 * Resolves XML character references, which are legal everywhere an ASCII character
 * is and can spell a construct the patterns above look for (`&#x68;ttps://…`).
 * Repeated a few times so a doubly-encoded reference is also settled; benign
 * references (a copyright sign in a text node) decode to ordinary characters.
 */
function decodeXmlCharacterReferences(document: string): string {
  let decoded = document;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(/&#(x[0-9a-f]+|\d+);/giu, (whole, code: string) => {
      const value = code[0]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

/**
 * The document bytes when `bytes` is a bounded SVG that cannot execute script, load
 * a remote resource, or expand an entity; undefined otherwise.
 */
export function safeIconSvg(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_SVG_BYTES) return undefined;
  let document: string;
  try { document = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
  if (!/^<svg[\s>]/iu.test(document.replace(SVG_LEADING, ''))) return undefined;
  const decoded = decodeXmlCharacterReferences(document);
  return SVG_DANGEROUS.some((pattern) => pattern.test(document) || pattern.test(decoded)) ? undefined : bytes;
}
