import { describe, expect, it } from 'vitest';
import { companyIconResponse } from '../cloudflare/company-icon.js';
import { MAX_ICON_ASSET_BYTES, logoDevImageUrl } from '../src/employer-icon-discovery.js';
import type { HostResolver } from '../src/employer/safe-network.js';
import type { R2Bucket } from '../cloudflare/types.js';

const object = (contentType: string) => ({
  body: new ReadableStream({ start(controller) { controller.close(); } }), size: 12, httpMetadata: { contentType },
});

describe('company icon route', () => {
  it('serves only an icon linked to the requested canonical employer', async () => {
    const response = await companyIconResponse('acme', {
      async getCanonicalEmployer(id) { return id === 'acme' ? { id, displayName: 'Acme', iconKey: 'company-icons/acme/logo-v1.webp', reviewedAt: '', reviewedBy: '' } : undefined; },
    }, { async get(key) { return key === 'company-icons/acme/logo-v1.webp' ? object('image/webp') : null; } } as R2Bucket);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400');
    expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('revalidates the stable URL after an icon changes or is removed', async () => {
    let iconKey: string | undefined = 'company-icons/acme/logo-v1.webp';
    const employer = { async getCanonicalEmployer() {
      return { id: 'acme', displayName: 'Acme', iconKey, reviewedAt: '', reviewedBy: '' };
    } };
    const documents = { async get(key: string) {
      return { ...object('image/webp'), body: new Blob([key]).stream(), size: key.length };
    } } as unknown as R2Bucket;

    const first = await companyIconResponse('acme', employer, documents);
    expect(await first.text()).toBe('company-icons/acme/logo-v1.webp');
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400');

    iconKey = 'company-icons/acme/logo-v2.webp';
    const updated = await companyIconResponse('acme', employer, documents);
    expect(await updated.text()).toBe('company-icons/acme/logo-v2.webp');

    iconKey = undefined;
    const removed = await companyIconResponse('acme', employer, documents);
    expect(removed.status).toBe(404);
    expect(removed.headers.get('Cache-Control')).toBe('no-store');
  });

  it('hides missing, malformed, and non-image assets', async () => {
    const employer = { async getCanonicalEmployer() { return { id: 'acme', displayName: 'Acme', iconKey: 'company-icons/acme/logo-v1.webp', reviewedAt: '', reviewedBy: '' }; } };
    const asset = { async get() { return object('text/html'); } } as unknown as R2Bucket;
    await expect(companyIconResponse('not%2Fa-company', employer, asset)).resolves.toMatchObject({ status: 404 });
    await expect(companyIconResponse('acme', employer, asset)).resolves.toMatchObject({ status: 404 });
    await expect(companyIconResponse('acme', employer, { async get() { return object('image/svg+xml'); } } as unknown as R2Bucket))
      .resolves.toMatchObject({ status: 404 });
  });
});

describe('automatic company icon route', () => {
  const resolver: HostResolver = { async resolve() { return ['93.184.216.34']; } };
  const token = 'logo-dev-token';
  const imageUrl = logoDevImageUrl('acme.com', token);
  const image = (contentType = 'image/webp', body = new Uint8Array([1, 2, 3, 4])) =>
    new Response(body, { headers: { 'Content-Type': contentType } });
  const automaticEmployer = {
    async getCanonicalEmployer(id: string) {
      return id === 'acme' ? { id, displayName: 'Acme', reviewedAt: '', reviewedBy: '' } : undefined;
    },
  };
  const emptyDocuments = { async get() { return null; } } as unknown as R2Bucket;
  const providerFetch = (response: () => Response): typeof fetch => {
    const impl = async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (href !== imageUrl) throw new Error(`unexpected fetch: ${href}`);
      return response();
    };
    return impl as unknown as typeof fetch;
  };
  const automatic = (
    response: () => Response,
    options: {
      display?: boolean;
      domain?: string | undefined;
      retainIcon?: (employerId: string, asset: { bytes: Uint8Array; contentType: string }) => Promise<void>;
    } = {},
  ) =>
    companyIconResponse('acme', automaticEmployer, emptyDocuments, {
      automaticDomain: async () => ('domain' in options ? options.domain : 'acme.com'),
      ...(options.display === undefined ? {} : { automaticDisplay: async () => options.display! }),
      ...(options.retainIcon ? { retainIcon: options.retainIcon } : {}),
      logoDevImageToken: token, resolver, fetchImpl: providerFetch(response),
    });

  it('withholds an automatic icon until display is enabled', async () => {
    const disabled = await automatic(() => image(), { display: false });
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get('Cache-Control')).toBe('no-store');

    // Absent settings leave automatic display off by default.
    const unconfigured = await automatic(() => image());
    expect(unconfigured.status).toBe(404);
    expect(unconfigured.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves an automatic provider image with the reviewed security headers once display is enabled', async () => {
    const response = await automatic(() => image(), { display: true });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400');
    expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('hides an automatic icon the provider does not actually have', async () => {
    const response = await automatic(() => new Response(null, { status: 404 }), { display: true });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('hides an automatic icon whose body is oversized or mistyped', async () => {
    const mistyped = await automatic(() => image('image/svg+xml'), { display: true });
    expect(mistyped.status).toBe(404);

    const oversized = await automatic(() => image('image/webp', new Uint8Array(MAX_ICON_ASSET_BYTES + 1)), { display: true });
    expect(oversized.status).toBe(404);
  });

  it('hides an automatic icon when no resolved domain exists', async () => {
    const response = await automatic(() => image(), { display: true, domain: undefined });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('caches the provider image it just served when retention is licensed', async () => {
    const retained: Array<{ id: string; bytes: number[]; contentType: string }> = [];
    const response = await automatic(() => image('image/webp', new Uint8Array([9, 8, 7])), {
      display: true,
      retainIcon: async (id, asset) => { retained.push({ id, bytes: [...asset.bytes], contentType: asset.contentType }); },
    });

    expect(response.status).toBe(200);
    expect(retained).toEqual([{ id: 'acme', bytes: [9, 8, 7], contentType: 'image/webp' }]);
  });

  it('does not cache a provider response it never served', async () => {
    let calls = 0;
    const response = await automatic(() => new Response(null, { status: 404 }), {
      display: true,
      retainIcon: async () => { calls += 1; },
    });

    expect(response.status).toBe(404);
    expect(calls).toBe(0);
  });

  it('serves the icon even when the cache write fails', async () => {
    const response = await automatic(() => image(), {
      display: true,
      retainIcon: async () => { throw new Error('the documents bucket is unavailable'); },
    });

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
