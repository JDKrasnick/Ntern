import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { catalogGroupDetails, groupCatalogJobs, type CatalogGroupDetails } from '../src/catalog-groups.js';
import type { Internship } from '../src/types.js';
import { R2CatalogProjection, R2CatalogReadStore } from '../cloudflare/r2-catalog-projection.js';
import type { D1Database, D1PreparedStatement, R2Bucket } from '../cloudflare/types.js';

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
    async put(key: string, value: ArrayBuffer | ReadableStream | null, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const current = objects.get(key);
      if (options?.onlyIf?.etagMatches && (!current || createHash('md5').update(new Uint8Array(current)).digest('hex') !== options.onlyIf.etagMatches)) return null;
      if (options?.onlyIf?.etagDoesNotMatch === '*' && current) return null;
      if (failPage && /\/[^/]+\/0$/.test(key)) throw new Error('R2 write failed');
      if (!(value instanceof ArrayBuffer)) throw new Error('Expected a JSON buffer');
      objects.set(key, value);
      return { etag: createHash('md5').update(new Uint8Array(value)).digest('hex') };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { body: new Response(bytes).body!, etag: createHash('md5').update(new Uint8Array(bytes)).digest('hex') } : null;
    },
    async delete(key: string) { objects.delete(key); },
  } as R2Bucket;
  return { bucket, objects, failNextPage: () => { failPage = true; } };
}

function streamed(groups: CatalogGroupDetails[], generatedAt = new Date().toISOString()) {
  const hash = createHash('sha256');
  for (const group of groups) hash.update(JSON.stringify(group)).update('\0');
  return { version: hash.digest('hex').slice(0, 20), generatedAt,
    groups: (async function* () { yield* groups; })() };
}

describe('streamed R2 publication', () => {
  const groups = () => groupCatalogJobs(Array.from({ length: 251 }, (_, index) => role(index)), { includeClosed: true }).map(catalogGroupDetails);
  const pointer = (objects: Map<string, ArrayBuffer>) => JSON.parse(new TextDecoder().decode(objects.get('public-catalog/v1/current')!));
  const pageKey = (value: { version: string; pageVersion?: string }, index: number) => `public-catalog/v1/${value.pageVersion ?? value.version}/${index}`;

  it('publishes each bounded page before reading the next and exposes the complete immutable view', async () => {
    const values = groups(), source = streamed(values);
    const { bucket, objects } = fakeBucket();
    let read = 0, written = 0, largestPending = 0;
    source.groups = (async function* () {
      for (const group of values) {
        read += 1; largestPending = Math.max(largestPending, read - written);
        if (read - written > 100) throw new Error('whole-catalog hydration resumed');
        yield group;
      }
    })();
    const projection = new R2CatalogProjection({ ...bucket, async put(key, value, options) {
      if (/\/[a-f0-9]{20}\/\d+$/.test(key)) written += JSON.parse(new TextDecoder().decode(value as ArrayBuffer)).length;
      return bucket.put(key, value, options);
    } });
    expect(await projection.publishStream(source)).toEqual({ groups: 251, roles: 251 });
    expect(largestPending).toBe(100);
    const published = pointer(objects);
    expect(published).toMatchObject({ schemaVersion: 1, count: 251, version: source.version });
    expect(published.pageVersion).toMatch(/^[a-f0-9]{20}$/);
    expect((await projection.list(undefined, 500))?.groups).toEqual(values);
    expect((await projection.group(values[250]!.group.groupId))?.roles[0]?.jobId).toBe(values[250]!.roles[0]!.jobId);
  });

  it('keeps the private namespace across unchanged streaming, renewal and full publication', async () => {
    const values = groups(), { bucket, objects } = fakeBucket(), projection = new R2CatalogProjection(bucket);
    const first = new Date(Date.now() - 60_000).toISOString(), later = new Date().toISOString();
    await projection.publishStream(streamed(values, first));
    const published = pointer(objects), keys = [...objects.keys()];
    await projection.publishStream(streamed(values, later));
    await projection.revalidate(values, later);
    await projection.publish(values, later);
    expect(pointer(objects).pageVersion).toBe(published.pageVersion);
    expect([...objects.keys()]).toEqual(keys);
    expect((await projection.list(undefined, 500))?.groups).toEqual(values);
  });

  it('repairs a late missing page by copying validated pages without changing their immutable bytes', async () => {
    const values = groups(), { bucket, objects } = fakeBucket(), projection = new R2CatalogProjection(bucket);
    await projection.publishStream(streamed(values));
    const original = pointer(objects), first = objects.get(pageKey(original, 0));
    objects.delete(pageKey(original, 2));
    await projection.publishStream(streamed(values));
    const repaired = pointer(objects);
    expect(repaired.version).toBe(original.version);
    expect(repaired.pageVersion).not.toBe(original.pageVersion);
    expect(objects.get(pageKey(original, 0))).toBe(first);
    expect((await projection.list(undefined, 500))?.groups).toEqual(values);
  });

  it('cleans a partial candidate after a page-write failure and preserves the active view', async () => {
    const values = groups(), { bucket, objects } = fakeBucket(), projection = new R2CatalogProjection(bucket);
    await projection.publish(values.slice(0, 1), new Date(Date.now() - 60_000).toISOString());
    const before = [...objects.entries()];
    const failing = new R2CatalogProjection({ ...bucket, async put(key, value, options) {
      if (/\/[a-f0-9]{20}\/1$/.test(key)) throw new Error('partial candidate failure');
      return bucket.put(key, value, options);
    } });
    await expect(failing.publishStream(streamed(values))).rejects.toThrow('partial candidate failure');
    expect([...objects.entries()]).toEqual(before);
  });

  it.each(['incomplete', 'corrupt'])('rejects a %s manifest stream without overwriting active page bytes', async (fault) => {
    const values = groups(), { bucket, objects } = fakeBucket(), projection = new R2CatalogProjection(bucket);
    await projection.publish(values, new Date(Date.now() - 60_000).toISOString());
    const original = pointer(objects), bytes = objects.get(pageKey(original, 0));
    const source = streamed(values);
    source.groups = (async function* () {
      if (fault === 'incomplete') yield* values.slice(0, 250);
      else for (const value of values) yield { ...value, roles: value.roles.map(item => ({ ...item, open: false })) };
    })();
    await expect(projection.publishStream(source)).rejects.toThrow('does not match its manifest');
    expect(objects.get(pageKey(original, 0))).toBe(bytes);
    expect(pointer(objects).schemaVersion).toBe(0);
    expect(objects.get(pageKey(original, 0))).toBe(bytes);
    expect([...objects.keys()].filter(key => key !== 'public-catalog/v1/current')).toHaveLength(3);
  });

  it.each([false, true])('a delayed streamed candidate cannot replace a newer closed generation (existing pointer: %s)', async (existing) => {
    const values = groups(), { bucket, objects } = fakeBucket(), projection = new R2CatalogProjection(bucket);
    const first = new Date(Date.now() - 60_000).toISOString(), later = new Date().toISOString();
    if (existing) await projection.publish(values.slice(0, 1), first);
    const closed = groupCatalogJobs(Array.from({ length: 251 }, (_, index) => ({ ...role(index), open: false })), { includeClosed: true }).map(catalogGroupDetails);
    let raced = false;
    const delayed = new R2CatalogProjection({ ...bucket, async put(key, value, options) {
      if (!raced && /\/[a-f0-9]{20}\/0$/.test(key)) {
        raced = true;
        await projection.publish(closed, later);
      }
      return bucket.put(key, value, options);
    } });
    expect(await delayed.publishStream(streamed(values, first))).toMatchObject({ skipped: true });
    expect(pointer(objects).version).toBe(streamed(closed, later).version);
    expect((await projection.list(undefined, 500))?.groups).toEqual(closed);
    expect([...objects.keys()].filter(key => /\/[a-f0-9]{20}\/\d+$/.test(key))).toHaveLength(existing ? 4 : 3);
  });

  it('preserves activated pages when a lost acknowledgement races with a newer renewal', async () => {
    const values = groups(), { bucket, objects } = fakeBucket(), projection = new R2CatalogProjection(bucket);
    const first = new Date(Date.now() - 60_000).toISOString(), later = new Date().toISOString();
    const uncertain = new R2CatalogProjection({ ...bucket, async put(key, value, options) {
      const result = await bucket.put(key, value, options);
      if (key === 'public-catalog/v1/current') {
        await projection.revalidate(values, later);
        throw new Error('activation acknowledgement lost');
      }
      return result;
    } });
    await expect(uncertain.publishStream(streamed(values, first))).rejects.toThrow('activation acknowledgement lost');
    expect(pointer(objects).generatedAt).toBe(later);
    expect((await projection.list(undefined, 500))?.groups).toEqual(values);
  });

  it('rejects an oversized page before activation instead of exhausting the isolate', async () => {
    const values = groups(), { bucket, objects } = fakeBucket(), projection = new R2CatalogProjection(bucket);
    await projection.publish(values.slice(0, 1), new Date(Date.now() - 60_000).toISOString());
    const original = [...objects.entries()];
    const large = values.map(value => ({ ...value, roles: value.roles.map(item => ({ ...item, compensation: { raw: 'x'.repeat(50_000) } })) }));
    await expect(projection.publishStream(streamed(large))).rejects.toThrow('page exceeds its memory budget');
    expect([...objects.entries()]).toEqual(original);
  });
});

describe('R2 catalog projection', () => {
  it('falls back to the durable closed D1 generation when every R2 write is unavailable', async () => {
    const database = new DatabaseSync(':memory:');
    const migrations = new URL('../cloudflare/migrations/', import.meta.url);
    for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
      database.exec(readFileSync(new URL(name, migrations), 'utf8'));
    }
    const prepared = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
      bind: (...next) => prepared(sql, next),
      async first<T>() { return (database.prepare(sql).get(...params as (string | number | null)[]) as T | undefined) ?? null; },
      async all<T>() { return { results: database.prepare(sql).all(...params as (string | number | null)[]) as T[] }; },
      async run() { return { meta: { changes: Number(database.prepare(sql).run(...params as (string | number | null)[]).changes) } }; },
    });
    const db: D1Database = { prepare: prepared, async batch(statements) { return Promise.all(statements.map(statement => statement.run())); } };
    const { bucket } = fakeBucket();
    const first = new Date(Date.now() - 60_000).toISOString();
    const later = new Date().toISOString();
    const open = groupCatalogJobs([role(0)], { includeClosed: true }).map(catalogGroupDetails);
    const closed = groupCatalogJobs([{ ...role(0), open: false }], { includeClosed: true }).map(catalogGroupDetails);
    const store = new D1InternshipStore(db);
    const projection = new R2CatalogProjection(bucket);
    try {
      await store.putCatalogProjection(open, first);
      await projection.publish(open, first);
      const reader = new R2CatalogReadStore(db, bucket);
      expect((await reader.listCatalogProjection())?.groups[0]?.roles[0]?.open).toBe(true);
      await store.putCatalogProjection(closed, later);
      const unavailable = new R2CatalogProjection({ ...bucket, async put() { throw new Error('all R2 writes unavailable'); } });
      await expect(unavailable.revalidate(closed, later)).rejects.toThrow('all R2 writes unavailable');
      await expect(unavailable.invalidate(later)).rejects.toThrow('all R2 writes unavailable');
      // Physical R2 bytes remain stale, but every public read path uses D1.
      expect((await projection.list())?.groups[0]?.roles[0]?.open).toBe(true);
      expect((await reader.listCatalogProjection())?.groups[0]?.roles[0]?.open).toBe(false);
      expect((await reader.listCatalogProjectionFiltered(undefined, 25, {}))?.groups).toEqual([]);
      expect((await reader.getCatalogProjectionGroup(closed[0]!.group.groupId))?.roles[0]?.open).toBe(false);
      expect(await reader.listCatalogProjectionRoles({}, {})).toEqual([]);
    } finally { database.close(); }
  });

  it.each(['renewal', 'invalidation', 'publication', 'initial-publication'])('a paused %s cannot replace a newer closed-role generation', async (operation) => {
    const { bucket } = fakeBucket();
    const projection = new R2CatalogProjection(bucket);
    const open = groupCatalogJobs([role(0)], { includeClosed: true }).map(catalogGroupDetails);
    const closed = groupCatalogJobs([{ ...role(0), open: false }], { includeClosed: true }).map(catalogGroupDetails);
    const first = new Date(Date.now() - 60_000).toISOString();
    const later = new Date().toISOString();
    if (operation !== 'initial-publication') await projection.publish(open, first);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    const delayed = new R2CatalogProjection({ ...bucket, async get(key) {
      const object = await bucket.get(key);
      // Pause after the old pointer has been captured. Its ETag is now stale.
      if (key.endsWith('/current') && !intercepted) { intercepted = true; enter(); await released; }
      return object;
    } });
    const pending = operation === 'renewal' ? delayed.revalidate(open, first)
      : operation === 'invalidation' ? delayed.invalidate(first) : delayed.publish(open, first);
    await entered;
    try { await projection.publish(closed, later); } finally { release(); }
    await pending;
    expect((await projection.list())?.groups[0]?.roles[0]?.open).toBe(false);
  });

  it('keeps a newer retirement fenced against an older publication before the next R2 cron', async () => {
    const { bucket } = fakeBucket();
    const projection = new R2CatalogProjection(bucket);
    const groups = groupCatalogJobs([role(0)]).map(catalogGroupDetails);
    const first = new Date(Date.now() - 60_000).toISOString();
    const later = new Date().toISOString();
    await projection.publish(groups, first);
    await projection.invalidate(later);
    await projection.publish(groups, first);
    await projection.revalidate(groups, first);
    expect(await projection.list()).toBeUndefined();
    await projection.publish(groups, later);
    expect((await projection.list())?.groups).toEqual(groups);
  });

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
    expect(await projection.list()).toBeUndefined();
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
    expect(JSON.parse(new TextDecoder().decode(objects.get('public-catalog/v1/current'))).schemaVersion).toBe(0);
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
    const indexedD1 = { prepare(sql: string) {
      if (!sql.startsWith('SELECT value FROM catalog_items WHERE pk = ? AND sk = ?')) throw new Error('Public read scanned D1');
      return { bind(pk: string, sk: string) {
        expect([pk, sk]).toEqual(['CATALOG_PROJECTION', 'CURRENT']);
        return { async first() { return { value: JSON.stringify({ generatedAt: now }) }; } };
      } };
    },
      async batch() { throw new Error('Public read wrote D1'); } } as unknown as D1Database;
    const reader = new R2CatalogReadStore(indexedD1, bucket);
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
