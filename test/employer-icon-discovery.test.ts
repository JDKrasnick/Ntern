import { describe, expect, it } from 'vitest';
import { discoverEmployerIcon, logoDevIconRequest, verifyEmployerIconAsset } from '../src/employer-icon-discovery.js';

describe('employer icon discovery', () => {
  it('prioritizes a verified organization JSON-LD logo over presentation assets', () => {
    const result = discoverEmployerIcon('Acme Labs', 'https://acme.test/', `
      <title>Acme Labs | Careers</title>
      <script type="application/ld+json">{"@type":"Organization","name":"Acme Labs","logo":"/assets/logo.webp"}</script>
      <meta property="og:image" content="https://acme.test/social.png">
      <link rel="icon" href="/favicon.ico">`);
    expect(result.verifiedName).toBe(true);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'json-ld-logo', assetUrl: 'https://acme.test/assets/logo.webp', confidence: 'high' }),
      expect.objectContaining({ source: 'open-graph-image', confidence: 'medium' }),
    ]));
  });

  it('does not elevate an unverified page or accept non-HTTPS assets', () => {
    const result = discoverEmployerIcon('Acme', 'https://other.test/', `
      <title>Unrelated Holdings</title><link rel="icon" href="http://other.test/favicon.ico">
      <link rel="apple-touch-icon" href="/touch.png">`);
    expect(result.verifiedName).toBe(false);
    expect(result.candidates).toEqual([expect.objectContaining({ source: 'apple-touch-icon', confidence: 'low' })]);
  });

  it('rejects unusable candidate assets before they reach review', () => {
    expect(verifyEmployerIconAsset(new Response('', { status: 404 }))).toMatchObject({ accepted: false, reason: 'asset returned HTTP 404' });
    expect(verifyEmployerIconAsset(new Response('', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ accepted: false, reason: 'asset is not a supported image' });
    expect(verifyEmployerIconAsset(new Response('', { headers: { 'Content-Type': 'image/webp', 'Content-Length': '1500001' } }))).toMatchObject({ accepted: false, reason: 'asset exceeds the 1.5 MB review limit' });
    expect(verifyEmployerIconAsset(new Response('', { headers: { 'Content-Type': 'image/webp', 'Content-Length': '512' } }))).toEqual({ accepted: true, contentType: 'image/webp', bytes: 512 });
    expect(verifyEmployerIconAsset(new Response('', { headers: { 'Content-Type': 'image/svg+xml', 'Content-Length': '0' } }))).toEqual({ accepted: true, contentType: 'image/svg+xml' });
  });

  it('uses Logo.dev first without leaking its publishable token into review output', () => {
    const candidate = logoDevIconRequest('figma.com', 'public-token')!;
    expect(candidate.requestUrl).toContain('token=public-token');
    expect(candidate.candidate).toMatchObject({ source: 'logo-dev', assetUrl: 'https://img.logo.dev/figma.com?format=webp&size=256' });
    expect(JSON.stringify(candidate.candidate)).not.toContain('public-token');
    expect(logoDevIconRequest('not/a-domain', 'public-token')).toBeUndefined();
  });
});
