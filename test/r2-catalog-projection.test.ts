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
  it.each(['missing', 'malformed', 'changed', 'shortened', 'index'])('invalidates an unchanged %s page set and repairs it on publication', async (fault) => {
    const { bucket, objects } = fakeBucket();
    const projection = new R2CatalogProjection(bucket);
    const groups = groupCatalogJobs(Array.from({ length: 101 }, (_, index) => role(index))).map(catalogGroupDetails);
    const now = new Date().toISOString();
    await projection.publish(groups, now);
    const pointerKey = 'public-catalog/v1/current';
    const pointer = JSON.parse(new TextDecoder().decode(objects.get(pointerKey)));
    const pageKey = `public-catalog/v1/${pointer.version}/1`;
    if (fault === 'missing') objects.delete(pageKey);
    if (fault === 'malformed') objects.set(pageKey, new TextEncoder().encode('{').buffer);
    if (fault === 'changed') objects.set(pageKey, new TextEncoder().encode(JSON.stringify([groups[0]])).buffer);
    if (fault === 'shortened') objects.set(pageKey, new TextEncoder().encode('[]').buffer);
    if (fault === 'index') {
      pointer.groupPages[groups[100]!.group.groupId] = 0;
      objects.set(pointerKey, new TextEncoder().encode(JSON.stringify(pointer)).buffer);
    }
    await projection.revalidate(groups, now);
    expect(objects.has(pointerKey)).toBe(false);
    await projection.publish(groups, now);
    expect((await projection.list('100', 1))?.groups).toEqual(groups.slice(100));
  });

  it('repairs an incomplete active version even when publication runs before D1 revalidation', async () => {
    const { bucket, objects, failNextPage } = fakeBucket();
    const projection = new R2CatalogProjection(bucket);
    const groups = groupCatalogJobs([role(0)]).map(catalogGroupDetails);
    const now = new Date().toISOString();
    await projection.publish(groups, now);
    const pageKey = [...objects.keys()].find((key) => key.endsWith('/0'))!;
    objects.delete(pageKey);
    await projection.publish(groups, now);
    expect((await projection.list())?.groups).toEqual(groups);
    objects.delete(pageKey);
    failNextPage();
    await expect(projection.publish(groups, now)).rejects.toThrow('R2 write failed');
    expect(await projection.list()).toBeUndefined();
  });

  it('retains complete pages across an unchanged D1 generation and renews its pointer', async () => {
    const { bucket, objects } = fakeBucket();
    const projection = new R2CatalogProjection(bucket);
    const groups = groupCatalogJobs([role(0)]).map(catalogGroupDetails);
    const first = new Date(Date.now() - 60_000).toISOString();
    await projection.publish(groups, first, 'watermark');
    const page = [...objects.entries()].find(([key]) => key.endsWith('/0'))!;
    const generatedAt = new Date().toISOString();
    await projection.revalidate(groups, generatedAt, 'watermark');
    expect(objects.get(page[0])).toBe(page[1]);
    expect(objects.size).toBe(2);
    const pointer = JSON.parse(new TextDecoder().decode(objects.get('public-catalog/v1/current')));
    expect(pointer.generatedAt).toBe(generatedAt);
    expect((await projection.list())?.groups).toHaveLength(1);
  });

  it('invalidates changed admission content even when the live watermark is unchanged', async () => {
    const { bucket, objects } = fakeBucket();
    const projection = new R2CatalogProjection(bucket);
    const groups = groupCatalogJobs([role(0)], { includeClosed: true }).map(catalogGroupDetails);
    await projection.publish(groups, new Date().toISOString(), 'watermark');
    const closed = groupCatalogJobs([{ ...role(0), open: false }], { includeClosed: true }).map(catalogGroupDetails);
    await projection.revalidate(closed, new Date().toISOString(), 'watermark');
    expect(objects.has('public-catalog/v1/current')).toBe(false);
    expect(await projection.list()).toBeUndefined();
  });

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

  it('reads filtered pages with bounded concurrency instead of one page per round trip', async () => {
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
    const filtered = await projection.listFiltered(undefined, 1, { query: 'Special' });
    expect(filtered?.groups).toHaveLength(1);
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
