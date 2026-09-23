import { describe, expect, it } from 'vitest';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import type { Internship } from '../src/types.js';
import { R2CatalogProjection, R2CatalogReadStore } from '../cloudflare/r2-catalog-projection.js';
import type { D1Database, R2Bucket } from '../cloudflare/types.js';

function role(index: number): Internship {
  const id = `job-${index}`;
  const observed = '2026-09-23T00:00:00.000Z';
  return { jobId: id, company: `Employer ${index}`, title: index === 150 ? 'Special Software Intern' : 'Software Intern',
    location: 'Remote', season: 'summer-2027', applyUrl: `https://careers.example.test/${id}`,
    normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id, compensation: { raw: '' },
    sourceReferences: [], technical: true, open: true, firstSeenAt: observed, catalogVisibleAt: observed,
    lastSeenAt: observed, notification: { smsPending: false, digestPending: false } };
}

function fakeBucket() {
  const objects = new Map<string, ArrayBuffer>();
  let failPage = false;
  const bucket = {
    async put(key: string, value: ArrayBuffer | ReadableStream | null) {
      if (failPage && /\/[^/]+\/0$/.test(key)) throw new Error('R2 write failed');
      if (!(value instanceof ArrayBuffer)) throw new Error('Expected a JSON buffer');
      objects.set(key, value);
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { body: new Response(bytes).body! } : null;
    },
    async delete(key: string) { objects.delete(key); },
  } as R2Bucket;
  return { bucket, objects, failNextPage: () => { failPage = true; } };
}

describe('R2 catalog projection', () => {
  it('reads role pages with bounded concurrency for the days index', async () => {
    const { bucket } = fakeBucket();
    const groups = groupCatalogJobs(Array.from({ length: 501 }, (_, index) => role(index)), { includeClosed: true }).map(catalogGroupDetails);
    let active = 0;
    let peak = 0;
    const measuredBucket = { ...bucket, async get(key: string) {
      if (/\/[^/]+\/\d+$/.test(key)) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }
      return bucket.get(key);
    } } as R2Bucket;
    const projection = new R2CatalogProjection(measuredBucket);
    await projection.publish(groups, new Date().toISOString());
    await projection.roles({}, {});
    expect(peak).toBe(4);
  });

  it('publishes complete pages before the pointer and serves page and search cursors', async () => {
    const { bucket, objects, failNextPage } = fakeBucket();
    const projection = new R2CatalogProjection(bucket);
    const groups = groupCatalogJobs(Array.from({ length: 205 }, (_, index) => role(index)), { includeClosed: true }).map(catalogGroupDetails);
    const now = new Date().toISOString();
    await projection.publish(groups, now);
    expect(objects.size).toBe(4);
    const page = await projection.list('99', 3);
    expect(page?.groups.map((item) => item.group.groupId)).toEqual(groups.slice(99, 102).map((item) => item.group.groupId));
    expect(page?.cursor).toBe('102');
    const filtered = await projection.listFiltered(undefined, 1, { query: 'Special' });
    expect(filtered?.groups).toHaveLength(1);
    expect(filtered?.groups[0]?.roles[0]?.title).toBe('Special Software Intern');
    const noD1 = { prepare() { throw new Error('Public read reached D1'); },
      async batch() { throw new Error('Public read reached D1'); } } as D1Database;
    const reader = new R2CatalogReadStore(noD1, bucket);
    expect((await reader.listCatalogProjection('99', 3))?.groups).toEqual(page?.groups);
    expect((await reader.listCatalogProjectionFiltered(undefined, 1, { query: 'Special' }))?.groups).toEqual(filtered?.groups);
    expect((await reader.getCatalogProjectionGroup(groups[150]!.group.groupId))?.group.groupId).toBe(groups[150]!.group.groupId);

    const pointerBefore = objects.get('public-catalog/v1/current');
    failNextPage();
    await expect(projection.publish([...groups, catalogGroupDetails(groupCatalogJobs([role(205)])[0]!)], now)).rejects.toThrow('R2 write failed');
    expect(objects.get('public-catalog/v1/current')).toBe(pointerBefore);
    expect((await projection.list('204', 2))?.groups).toHaveLength(1);
  });
});
