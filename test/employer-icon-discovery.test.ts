import { describe, expect, it } from 'vitest';
import {
  brandfetchSearchUrl, logoDevImageUrl, logoDevSearchUrl, parseIconPageEvidence, validIconAsset,
} from '../src/employer-icon-discovery.js';

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
