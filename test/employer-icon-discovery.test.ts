import { describe, expect, it } from 'vitest';
import {
  brandfetchSearchUrl, logoDevImageUrl, logoDevSearchUrl, parseIconPageEvidence,
  proposedDomainMatchesEmployer, validIconAsset,
} from '../src/employer-icon-discovery.js';
import { parseIconProposal, plausibleEmployerName } from '../src/employer-icon-resolution.js';

const org = (value: Record<string, unknown>) =>
  `<!doctype html><html><head><title>Careers</title><script type="application/ld+json">${JSON.stringify(value)}</script></head></html>`;

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
