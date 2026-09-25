import { describe, expect, it } from 'vitest';
import {
  applicationUrlMatchesContracts,
  assertPublicHttpsUrl,
  isPublicIpAddress,
  safeFetchText,
} from '../src/employer/index.js';

const publicResolver = { resolve: async () => ['93.184.216.34'] };

describe('public-host enforcement', () => {
  it.each([
    '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.0.1',
    '192.168.1.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::', '::1',
    '::ffff:127.0.0.1', '64:ff9b:1::1', 'fc00::1', 'fe80::1', '2001:db8::1', '3fff::1',
  ])('rejects reserved address %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'accepts globally routable address %s',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it('requires HTTPS, no credentials, and every DNS result to be public', async () => {
    await expect(assertPublicHttpsUrl('http://example.com', publicResolver)).rejects.toThrow(/HTTPS/);
    await expect(assertPublicHttpsUrl('https://user@example.com', publicResolver)).rejects.toThrow(/credentials/);
    await expect(assertPublicHttpsUrl('https://example.com:8443', publicResolver)).rejects.toThrow(/standard HTTPS port/);
    await expect(assertPublicHttpsUrl('https://service.local/path', publicResolver)).rejects.toThrow(/not public/);
    await expect(assertPublicHttpsUrl('https://example.com', { resolve: async () => ['93.184.216.34', '127.0.0.1'] }))
      .rejects.toThrow(/non-public/);
    await expect(assertPublicHttpsUrl('https://[::1]/admin', publicResolver)).rejects.toThrow(/non-public/);
    await expect(assertPublicHttpsUrl('https://example.com/path', publicResolver)).resolves.toBeInstanceOf(URL);
  });
});

describe('bounded safe fetch', () => {
  it('revalidates DNS for each redirect and rejects a private destination', async () => {
    const resolver = {
      resolve: async (host: string) => host === 'public.test' ? ['93.184.216.34'] : ['127.0.0.1'],
    };
    const fetcher = async () => new Response(null, { status: 302, headers: { location: 'https://private.test/admin' } });
    await expect(safeFetchText('https://public.test', { resolver, fetcher })).rejects.toThrow(/non-public/);
  });

  it('enforces redirect and body limits', async () => {
    const redirecting = async () => new Response(null, { status: 302, headers: { location: '/again' } });
    await expect(safeFetchText('https://public.test', { resolver: publicResolver, fetcher: redirecting, maxRedirects: 1 }))
      .rejects.toThrow(/Redirect limit/);

    const oversized = async () => new Response('123456', { status: 200 });
    await expect(safeFetchText('https://public.test', { resolver: publicResolver, fetcher: oversized, maxBodyBytes: 5 }))
      .rejects.toThrow(/body exceeds/);
  });

  it('enforces a request timeout even for an injected fetcher', async () => {
    const stalled = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    await expect(safeFetchText('https://public.test', { resolver: publicResolver, fetcher: stalled, timeoutMs: 5 }))
      .rejects.toThrow(/timed out/);
  });

  it('applies the timeout while streaming the response body', async () => {
    const stalledBody = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
    }));
    await expect(safeFetchText('https://public.test', { resolver: publicResolver, fetcher: stalledBody, timeoutMs: 5 }))
      .rejects.toThrow(/timed out/);
  });

  it('keeps the bounded prefix of an oversized body when truncation is requested', async () => {
    const oversized = async () => new Response('0123456789', { status: 200 });
    const truncated = await safeFetchText('https://public.test', {
      resolver: publicResolver, fetcher: oversized, maxBodyBytes: 5, onOversize: 'truncate',
    });
    expect(truncated.body).toBe('01234');
    expect(truncated.status).toBe(200);

    // The default stays fail-closed for every existing caller.
    await expect(safeFetchText('https://public.test', { resolver: publicResolver, fetcher: oversized, maxBodyBytes: 5 }))
      .rejects.toThrow(/body exceeds/);
  });
});

describe('approved application host contracts', () => {
  const contracts = [{ host: 'careers.example.com', pathPrefix: '/jobs' }];

  it('requires HTTPS, an exact host, and a path boundary', () => {
    expect(applicationUrlMatchesContracts('https://careers.example.com/jobs/123', contracts)).toBe(true);
    expect(applicationUrlMatchesContracts('https://careers.example.com/jobs-archive/123', contracts)).toBe(false);
    expect(applicationUrlMatchesContracts('https://careers.example.com.attacker.test/jobs/123', contracts)).toBe(false);
    expect(applicationUrlMatchesContracts('http://careers.example.com/jobs/123', contracts)).toBe(false);
    expect(applicationUrlMatchesContracts('https://careers.example.com:8443/jobs/123', contracts)).toBe(false);
  });

  it('allows subdomains only when a contract explicitly opts in', () => {
    expect(applicationUrlMatchesContracts('https://us.careers.example.com/jobs/1', contracts)).toBe(false);
    expect(applicationUrlMatchesContracts('https://us.careers.example.com/jobs/1', [
      { host: 'careers.example.com', includeSubdomains: true, pathPrefix: '/jobs' },
    ])).toBe(true);
  });
});
