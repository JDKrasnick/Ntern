import { describe, expect, it } from 'vitest';
import { companyIconResponse } from '../cloudflare/company-icon.js';
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
    expect(response.headers.get('Cache-Control')).toContain('immutable');
  });

  it('hides missing, malformed, and non-image assets', async () => {
    const employer = { async getCanonicalEmployer() { return { id: 'acme', displayName: 'Acme', iconKey: 'company-icons/acme/logo-v1.webp', reviewedAt: '', reviewedBy: '' }; } };
    const asset = { async get() { return object('text/html'); } } as unknown as R2Bucket;
    await expect(companyIconResponse('not%2Fa-company', employer, asset)).resolves.toMatchObject({ status: 404 });
    await expect(companyIconResponse('acme', employer, asset)).resolves.toMatchObject({ status: 404 });
  });
});
