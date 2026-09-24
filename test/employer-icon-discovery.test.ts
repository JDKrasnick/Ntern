import { describe, expect, it } from 'vitest';
import {
  bannerAssetShapeUsable, brandfetchSearchUrl, iconSvgAsset, isPlatformBannerUrl, logoDevImageUrl,
  logoDevSearchUrl, parseIconPageEvidence, rasterDimensions,
  iconAssetType, platformLogoUrls, proposedDomainMatchesEmployer, validIconAsset,
} from '../src/employer-icon-discovery.js';
import { parseIconProposal, plausibleEmployerName } from '../src/employer-icon-resolution.js';

const org = (value: Record<string, unknown>) =>
  `<!doctype html><html><head><title>Careers</title><script type="application/ld+json">${JSON.stringify(value)}</script></head></html>`;

/** A PNG with a real IHDR, which is all the dimension reader needs. */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A JPEG whose first marker is a baseline frame header. */
function jpegBytes(width: number, height: number): Uint8Array {
  // SOI, then an APP0 segment (marker, length 4) the scan skips, then SOF0 at
  // index 8: length, precision, height, width.
  const bytes = new Uint8Array(32);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8], 0);
  bytes[13] = height >> 8; bytes[14] = height & 0xff;
  bytes[15] = width >> 8; bytes[16] = width & 0xff;
  return bytes;
}

/** An extended-format WebP, whose canvas size is 24 bits of width then height. */
function webpExtendedBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  bytes.set([width - 1 & 0xff, (width - 1) >> 8 & 0xff, (width - 1) >> 16 & 0xff], 24);
  bytes.set([height - 1 & 0xff, (height - 1) >> 8 & 0xff, (height - 1) >> 16 & 0xff], 27);
  return bytes;
}

/** A lossless WebP, whose 14-bit width and height share one little-endian word. */
function webpLosslessBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12);
  bytes[20] = 0x2f;
  new DataView(bytes.buffer).setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true);
  return bytes;
}

/** A lossy WebP, whose 14-bit dimensions precede the bitstream. */
function webpLossyBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  new DataView(bytes.buffer).setUint16(26, width, true);
  new DataView(bytes.buffer).setUint16(28, height, true);
  return bytes;
}

describe('page evidence parsing', () => {
  it('reads an organization domain from sameAs as well as url', () => {
    // The shape real publishers emit: schema.org puts an Organization's site in
    // `sameAs`, and Stripe's own hiringOrganization does exactly this.
    const page = parseIconPageEvidence(org({
      '@type': 'JobPosting',
      title: 'Software Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Stripe', sameAs: 'https://stripe.com' },
    }));
    expect(page.organizations).toEqual([{ name: 'Stripe', domains: ['stripe.com'] }]);
  });

  it('collects every canonical URL an organization publishes, once each', () => {
    const page = parseIconPageEvidence(org({
      '@type': 'Organization', name: 'Acme',
      url: 'https://www.acme.com/about',
      sameAs: ['https://acme.com', 'https://twitter.com/acme', 'not a url'],
    }));
    expect(page.organizations).toEqual([{ name: 'Acme', domains: ['acme.com', 'twitter.com'] }]);
  });

  it('keeps an organization that names the employer but publishes no site', () => {
    const page = parseIconPageEvidence(org({ '@type': 'Organization', name: 'Acme' }));
    expect(page.organizations).toEqual([{ name: 'Acme' }]);
  });

  it('reads organisations nested in a graph and in a top-level array', () => {
    const page = parseIconPageEvidence(
      '<html><head><title>Roles</title>'
      + `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'WebSite', name: 'x' }, { '@type': 'Corporation', name: 'Acme', url: 'https://acme.com' }] })}</script>`
      + `<script type="application/ld+json">${JSON.stringify([{ '@type': ['Organization', 'Employer'], name: 'Globex', url: 'https://globex.com' }])}</script>`
      + '</head></html>',
    );
    expect(page.organizations).toEqual([
      { name: 'Acme', domains: ['acme.com'] },
      { name: 'Globex', domains: ['globex.com'] },
    ]);
  });

  it('survives a malformed structured-data block without losing the rest of the page', () => {
    const page = parseIconPageEvidence(
      '<html><head><title>Careers at Acme</title><meta property="og:site_name" content="Acme">'
      + '<script type="application/ld+json">{ not json }</script>'
      + `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Acme', url: 'https://acme.com' })}</script>`
      + '</head></html>',
    );
    expect(page.title).toBe('Careers at Acme');
    expect(page.ogSiteName).toBe('Acme');
    expect(page.organizations).toEqual([{ name: 'Acme', domains: ['acme.com'] }]);
  });

  it('never treats an image property as a domain', () => {
    const page = parseIconPageEvidence(org({
      '@type': 'Organization', name: 'Acme', logo: 'https://cdn.example/logo.png',
    }));
    expect(page.organizations).toEqual([{ name: 'Acme' }]);
  });

  it('reads the employer site and name its ATS board declares', () => {
    // Ashby publishes the employer's own site in its board payload.
    const ashby = parseIconPageEvidence(
      '<html><head><title>Rivian and Volkswagen Group Technologies Jobs</title></head><body>'
      + `<script>window.__appData={"organization":{"publicWebsite":"https://rivianvw.tech/","customJobsPageUrl":null}}</script>`
      + '</body></html>',
    );
    expect(ashby.declaredWebsite).toBe('rivianvw.tech');
    expect(ashby.declaredEmployerName).toBe('Rivian and Volkswagen Group Technologies');

    // Greenhouse publishes the employer's name in its own payload.
    const greenhouse = parseIconPageEvidence(
      '<html><head><title>Job Application for Summer Intern at IMC</title></head><body>'
      + '<script>{"company_name":"IMC"}</script></body></html>',
    );
    expect(greenhouse.declaredEmployerName).toBe('IMC');
    expect(greenhouse.declaredWebsite).toBeUndefined();

    // Lever names the employer only in the title.
    expect(parseIconPageEvidence('<html><head><title>Hermeus jobs</title></head></html>').declaredEmployerName).toBe('Hermeus');
    // The employer's careers page still resolves to the employer's domain.
    expect(parseIconPageEvidence('<html><body><script>{"publicWebsite":"https://x.test/","customJobsPageUrl":"https://www.retellai.com/careers"}</script></body></html>').declaredWebsite)
      .toBe('x.test');
    expect(parseIconPageEvidence('<html><body><script>{"customJobsPageUrl":"https://www.retellai.com/careers"}</script></body></html>').declaredWebsite)
      .toBe('retellai.com');
  });

  it('accepts a proposed domain only when the domain itself names the employer', () => {
    const evidence = parseIconPageEvidence('<html><head><title>Rivian and Volkswagen Group Technologies</title></head></html>');
    // The catalog name is `RV Tech`; the company calls itself something else, and
    // the board says so. Either name is enough, the domain is the judge.
    expect(proposedDomainMatchesEmployer(evidence, 'RV Tech', 'Rivian and Volkswagen Group Technologies')).toBe(true);
    expect(proposedDomainMatchesEmployer(evidence, 'RV Tech')).toBe(false);

    const unrelated = parseIconPageEvidence('<html><head><title>Pylon AI</title><meta property="og:site_name" content="Pylon AI"></head></html>');
    expect(proposedDomainMatchesEmployer(unrelated, 'Pylon')).toBe(true);
    expect(proposedDomainMatchesEmployer(unrelated, 'Base Power')).toBe(false);
  });
});

describe('domain proposal payload', () => {
  it('accepts only a well-formed proposal and reduces it to a registrable domain', () => {
    expect(parseIconProposal({ domain: 'Example.com', confidence: 0.95, reason: 'the employer states it' }))
      .toMatchObject({ domain: 'example.com', confidence: 0.95 });
    // A model often answers with the URL it saw; that is normalized, never used raw.
    expect(parseIconProposal({ domain: 'https://www.example.com/careers', confidence: 0.9, reason: 'ok' })?.domain)
      .toBe('example.com');
    expect(parseIconProposal({ domain: 'example.com:443', confidence: 0.9, reason: 'ok' })?.domain).toBe('example.com');
    expect(parseIconProposal({ domain: null, confidence: 0.9, reason: 'no idea' })?.domain).toBeNull();

    // Structural rejections: extra keys, bad confidence, empty reason, junk domain.
    expect(parseIconProposal({ domain: 'example.com', confidence: 0.9, reason: 'ok', extra: 1 })).toBeUndefined();
    expect(parseIconProposal({ domain: 'example.com', confidence: 1.4, reason: 'ok' })).toBeUndefined();
    expect(parseIconProposal({ domain: 'example.com', confidence: 0.9, reason: '   ' })).toBeUndefined();
    expect(parseIconProposal({ domain: 'localhost', confidence: 0.9, reason: 'ok' })).toBeUndefined();
    expect(parseIconProposal({ domain: 42, confidence: 0.9, reason: 'ok' })).toBeUndefined();
    expect(parseIconProposal('example.com')).toBeUndefined();
  });

  it('treats a landing-page title as no employer name at all', () => {
    // Axon's own board is titled "Join Our Talent Community"; it names a page.
    expect(plausibleEmployerName('Join Our Talent Community')).toBe(false);
    expect(plausibleEmployerName('Careers')).toBe(false);
    expect(plausibleEmployerName('Students and Graduates')).toBe(false);
    expect(plausibleEmployerName(undefined)).toBe(false);

    expect(plausibleEmployerName('Astranis')).toBe(true);
    expect(plausibleEmployerName('RV Tech')).toBe(true);
    expect(plausibleEmployerName('Rivian and Volkswagen Group Technologies')).toBe(true);
  });
});

describe('uploaded board logo', () => {
  it('picks the logo each platform serves for the employer’s own board', () => {
    // Ashby, square preferred because an icon tile is square.
    expect(platformLogoUrls('<script>{"logoSquareImageUrl":"https://app.ashbyhq.com/api/images/org-theme-logo/1cea/9d.png","logoWordmarkImageUrl":"https://app.ashbyhq.com/api/images/org-theme-wordmark/1cea/9d.png"}</script>')[0])
      .toBe('https://app.ashbyhq.com/api/images/org-theme-logo/1cea/9d.png');
    // Ashby with no square logo falls back to the wordmark.
    expect(platformLogoUrls('<script>{"logoSquareImageUrl":null,"logoWordmarkImageUrl":"https://app.ashbyhq.com/api/images/org-theme-wordmark/694/8c.png"}</script>')[0])
      .toBe('https://app.ashbyhq.com/api/images/org-theme-wordmark/694/8c.png');

    // Greenhouse and Lever serve it as og:image, across their shards.
    expect(platformLogoUrls('<meta property="og:image" content="https://s101-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/204/510/original/Logo-IMC-Blue.png?1773245307">')[0])
      .toBe('https://s101-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/204/510/original/Logo-IMC-Blue.png?1773245307');
    expect(platformLogoUrls('<meta property="og:image" content="https://lever-client-logos.s3-us-west-2.amazonaws.com/b8300af6-1586196845320.png">')[0])
      .toBe('https://lever-client-logos.s3-us-west-2.amazonaws.com/b8300af6-1586196845320.png');
    expect(platformLogoUrls('<meta property="og:image" content="https://lever-client-logos.s3.us-west-2.amazonaws.com/c0bce04e-1654061968773.png">')[0])
      .toBe('https://lever-client-logos.s3.us-west-2.amazonaws.com/c0bce04e-1654061968773.png');
  });

  it('keeps an SVG board logo but ranks a usable raster ahead of it', () => {
    // Ashby serves some boards an SVG square logo. It cannot be stored, and the
    // raster beside it must therefore come first.
    const urls = platformLogoUrls(
      '<meta property="og:image" content="https://app.ashbyhq.com/api/images/org-theme-social/1cea/social.png">'
      + '<script>{"logoSquareImageUrl":"https://app.ashbyhq.com/api/images/org-theme-logo/1cea/square.svg","logoWordmarkImageUrl":"https://app.ashbyhq.com/api/images/org-theme-wordmark/1cea/word.svg"}</script>',
    );
    expect(urls[0]).toBe('https://app.ashbyhq.com/api/images/org-theme-social/1cea/social.png');
    // With only SVG art available the square logo still leads, and the caller
    // falls through when it turns out to be unusable.
    expect(platformLogoUrls('<script>{"logoSquareImageUrl":"https://app.ashbyhq.com/api/images/org-theme-logo/1cea/square.svg"}</script>'))
      .toEqual(['https://app.ashbyhq.com/api/images/org-theme-logo/1cea/square.svg']);
    // Two rasters keep their source order: the square logo before the wordmark.
    expect(platformLogoUrls(
      '<meta property="og:image" content="https://app.ashbyhq.com/api/images/org-theme-social/1cea/social.png">'
      + '<script>{"logoSquareImageUrl":"https://app.ashbyhq.com/api/images/org-theme-logo/1cea/square.png","logoWordmarkImageUrl":"https://app.ashbyhq.com/api/images/org-theme-wordmark/1cea/word.png"}</script>',
    )).toEqual([
      'https://app.ashbyhq.com/api/images/org-theme-logo/1cea/square.png',
      'https://app.ashbyhq.com/api/images/org-theme-wordmark/1cea/word.png',
      'https://app.ashbyhq.com/api/images/org-theme-social/1cea/social.png',
    ]);
  });

  it('refuses an og:image that is not a board logo', () => {
    // A role banner, a client CDN, or a platform image is not the employer's mark.
    for (const content of [
      'https://cdn.example.com/role-banner.png',
      'https://media.licdn.com/dms/image/abc.png',
      'https://job-boards.greenhouse.io/images/share.png',
      'https://s101-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/other/x.png',
      'http://s101-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/a.png',
      'https://app.ashbyhq.com/api/images/org-theme-banner/abc/def.png',
      'https://lever-client-logos.s3.us-west-2.amazonaws.com.evil.test/x.png',
    ]) {
      expect(platformLogoUrls(`<meta property="og:image" content="${content}">`)).toEqual([]);
    }
    expect(platformLogoUrls('<html><head><title>Open roles</title></head></html>')).toEqual([]);
  });

  it('reads the Greenhouse board logo and banner a board publishes instead of og:image', () => {
    // The current board renderer serializes its payload inside a script, so every
    // key and value arrives escaped, and `og:image` is emitted with no value at all.
    const logo = 'https://s4-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/377/100/original/Figma-icon-sm.png?1726';
    const banner = 'https://s3-recruiting.cdn.greenhouse.io/job_board_renderer/job_board_configurations/banners/400/334/900/original/banner.png?1';
    const escaped = `<meta property="og:image"/><script>window.x={"boardConfiguration":{\\"logo\\":{\\"href\\":\\"https://www.figma.com\\",\\"url\\":\\"${logo}\\"},\\"banner_url\\":\\"${banner}\\"}}</script>`;
    // The board logo is the employer's mark, so it outranks the banner.
    expect(platformLogoUrls(escaped)).toEqual([logo, banner]);
    // The plain (unescaped) serialization is read the same way.
    expect(platformLogoUrls(`<script>{"logo":{"href":null,"url":"${logo}"},"banner_url":"${banner}"}</script>`))
      .toEqual([logo, banner]);
    // A board with no uploaded logo publishes only the banner, and no og:image.
    expect(platformLogoUrls(`<script>{"logo":{"href":"https://acme.test","url":null},"banner_url":"${banner}"}</script>`))
      .toEqual([banner]);
    // The rendered image is read when the payload is not present at all.
    expect(platformLogoUrls(`<div class="banner-container"><img src="${banner}" alt="Banner" class="banner"/></div>`))
      .toEqual([banner]);
  });

  it('marks only Greenhouse banner art as a banner', () => {
    const banner = 'https://s9-recruiting.cdn.greenhouse.io/job_board_renderer/job_board_configurations/banners/400/032/800/original/CareerPageBanner_1400x300.png';
    expect(isPlatformBannerUrl(banner)).toBe(true);
    expect(isPlatformBannerUrl('https://s4-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/377/100/original/Figma-icon-sm.png')).toBe(false);
    expect(isPlatformBannerUrl('https://app.ashbyhq.com/api/images/org-theme-logo/1cea/9d.png')).toBe(false);
    // A host that merely looks like the banner CDN is not it.
    expect(isPlatformBannerUrl('https://cdn.greenhouse.io.evil.test/job_board_renderer/job_board_configurations/banners/a.png')).toBe(false);
    expect(platformLogoUrls('<meta property="og:image" content="https://cdn.greenhouse.io.evil.test/job_board_renderer/job_board_configurations/banners/a.png">')).toEqual([]);
  });

  it('recognizes an SVG however the server labels it', () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(iconSvgAsset('image/svg+xml', svg)).toBe(svg);
    expect(iconSvgAsset('image/svg+xml; charset=utf-8', svg)).toBe(svg);
    // Ashby answers an SVG from a `.png` path, and a logo bucket may declare nothing.
    expect(iconSvgAsset('binary/octet-stream', svg)).toBe(svg);
    expect(iconSvgAsset(null, svg)).toBe(svg);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(iconSvgAsset('binary/octet-stream', png)).toBeUndefined();
    expect(iconSvgAsset('image/png', svg)).toBeUndefined();
    expect(iconSvgAsset('text/html', new TextEncoder().encode('<svg/>'))).toBeUndefined();
  });

  it('measures a banner from its own bytes and refuses a promotional strip', () => {
    // 1400×300 is the careers banner; 200×200 is the employer's square mark.
    expect(rasterDimensions(pngBytes(1400, 300))).toEqual({ width: 1400, height: 300 });
    expect(bannerAssetShapeUsable(pngBytes(1400, 300))).toBe(false);
    expect(bannerAssetShapeUsable(pngBytes(1200, 900))).toBe(true);
    expect(bannerAssetShapeUsable(pngBytes(400, 400))).toBe(true);
    // A 4:1 strip and a tall crop are both refused.
    expect(bannerAssetShapeUsable(pngBytes(2000, 500))).toBe(false);
    expect(bannerAssetShapeUsable(pngBytes(300, 900))).toBe(false);
    // Unshapeable bytes are refused rather than guessed at.
    expect(rasterDimensions(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(bannerAssetShapeUsable(new TextEncoder().encode('<svg/>'))).toBe(false);
  });

  it('measures the other containers the logo hosts serve', () => {
    expect(rasterDimensions(jpegBytes(1410, 301))).toEqual({ width: 1410, height: 301 });
    expect(rasterDimensions(webpExtendedBytes(996, 196))).toEqual({ width: 996, height: 196 });
    expect(rasterDimensions(webpLosslessBytes(512, 512))).toEqual({ width: 512, height: 512 });
    expect(rasterDimensions(webpLossyBytes(800, 800))).toEqual({ width: 800, height: 800 });
  });

  it('resolves an asset type from its bytes when the server declares nothing useful', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const avif = Uint8Array.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    // Lever's bucket serves PNGs as binary/octet-stream, so the header cannot be trusted alone.
    for (const declared of [null, undefined, 'application/octet-stream', 'binary/octet-stream']) {
      expect(iconAssetType(declared, png)).toBe('image/png');
      expect(iconAssetType(declared, jpeg)).toBe('image/jpeg');
      expect(iconAssetType(declared, webp)).toBe('image/webp');
      expect(iconAssetType(declared, avif)).toBe('image/avif');
      expect(iconAssetType(declared, svg)).toBeUndefined();
    }
    // A declared type still decides, and an SVG is refused however it is declared.
    expect(iconAssetType('image/png; charset=binary', svg)).toBe('image/png');
    expect(iconAssetType('image/svg+xml', png)).toBeUndefined();
    expect(iconAssetType('text/html', png)).toBeUndefined();
    expect(iconAssetType(null, new Uint8Array(0))).toBeUndefined();
  });
});

describe('provider request construction', () => {
  it('escapes the employer name into each provider URL', () => {
    expect(logoDevSearchUrl('Acme & Co')).toBe('https://api.logo.dev/search?q=Acme%20%26%20Co');
    expect(brandfetchSearchUrl('Acme & Co', 'client id')).toBe('https://api.brandfetch.io/v2/search/Acme%20%26%20Co?c=client%20id');
  });

  it('always asks the image endpoint for a 404 rather than a generated monogram', () => {
    const url = logoDevImageUrl('www.acme.com', 'secret token');
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('img.logo.dev');
    // Reduced to the registrable domain, and the credential travels only here.
    expect(parsed.pathname).toBe('/acme.com');
    expect(parsed.searchParams.get('fallback')).toBe('404');
    expect(parsed.searchParams.get('token')).toBe('secret token');
  });

  it('accepts only raster icons within the size ceiling', () => {
    expect(validIconAsset('image/webp', 1_024)).toBe(true);
    expect(validIconAsset('image/png; charset=binary', 1_024)).toBe(true);
    // An SVG can run script on the API origin, and an empty body is not an icon.
    expect(validIconAsset('image/svg+xml', 1_024)).toBe(false);
    expect(validIconAsset('text/html', 1_024)).toBe(false);
    expect(validIconAsset('image/webp', 0)).toBe(false);
    expect(validIconAsset('image/webp', 3 * 1_024 * 1_024)).toBe(false);
    expect(validIconAsset(undefined, 1_024)).toBe(false);
  });
});
