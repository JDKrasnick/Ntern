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
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, must-revalidate');
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
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=60, must-revalidate');

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
  });
});
