import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1InternshipStore, CATALOG_PROJECTION_BATCH_BYTES } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import type { EducationLevel, Internship, InternshipIdentity } from '../src/types.js';

function job(jobId: string, title: string): Internship {
  return {
    jobId,
    company: 'Acme',
    title,
    location: 'New York, NY',
    season: 'summer-2027',
    applyUrl: `https://careers.example.test/${jobId}`,
    normalizedUrl: `https://careers.example.test/${jobId}`,
    fingerprint: jobId,
    compensation: { raw: '' },
    sourceReferences: [],
    technical: true,
    open: true,
    firstSeenAt: '2026-08-25T00:00:00.000Z',
    catalogVisibleAt: '2026-08-25T00:00:00.000Z',
    lastSeenAt: '2026-08-25T00:00:00.000Z',
    employerCategory: 'normal',
    requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false },
    notification: { smsPending: false, digestPending: false },
  };
}

type SqliteValue = string | number | bigint | null | Uint8Array;

function sqliteD1(
  database: DatabaseSync,
  inspectRows?: (query: string, rows: unknown[]) => void,
  rpc?: { maxBatchBytes: number; batchBytes: number[]; batchSizes?: number[] },
  beforeRun?: (query: string) => void | Promise<void>,
): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query);
    const bound = values as SqliteValue[];
    const payload = query.length + values.reduce<number>((total, value) => total + String(value).length, 0);
    return {
      __payload: payload,
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() {
        const results = statement.all(...bound) as T[];
        inspectRows?.(query, results);
        return { results };
      },
      async run() { await beforeRun?.(query); return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    } as D1PreparedStatement & { __payload: number };
  };
  return {
    prepare(query: string) { return prepared(query); },
    async batch(statements: D1PreparedStatement[]) {
      // A production `batch()` is a single RPC call and D1 refuses an argument
      // over 32 MiB, so the fake enforces the same ceiling on the bound payload.
      const bytes = statements.reduce((total, statement) => total + (statement as D1PreparedStatement & { __payload: number }).__payload, 0);
      rpc?.batchBytes.push(bytes);
      rpc?.batchSizes?.push(statements.length);
      if (rpc && bytes > rpc.maxBatchBytes) {
        throw new Error(`D1_ERROR: Serialized RPC arguments or return values are limited to ${rpc.maxBatchBytes} bytes, but the size of this value was: ${bytes} bytes.`);
      }
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
}

describe('D1 filtered catalog projection', () => {
  afterEach(() => vi.useRealTimers());

  it('continues serving a complete projection after a missed daily refresh without loading catalog jobs', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-15T05:30:00.000Z');
    vi.setSystemTime(now);
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        catalog_sort_key TEXT, PRIMARY KEY (pk, sk)
      )
    `);
    const details = catalogGroupDetails(groupCatalogJobs([job('stale-projection', 'Software Engineering Intern')])[0]!);
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, ?, ?, ?)');
    insert.run('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', JSON.stringify({
      version: 'last-complete', generatedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1_000).toISOString(), schemaVersion: 4,
    }), null);
    insert.run('CATALOG_PROJECTION#last-complete', `GROUP#${details.group.groupId}`, 'catalog-projection', JSON.stringify(details), '00000000');
    insert.run('JOB#unbounded-fallback', 'META', 'internship', JSON.stringify(job('unbounded-fallback', 'Should not load')), null);
    try {
      const queries: string[] = [];
      const store = new D1InternshipStore(sqliteD1(database, (query) => queries.push(query)));
      await expect(store.listCatalogProjection(undefined, 25)).resolves.toMatchObject({ groups: [{ group: { groupId: details.group.groupId } }] });
      expect(queries.some((query) => query.includes("kind = 'internship'"))).toBe(false);
    } finally {
      database.close();
    }
  });

  it('reads a bounded release-day index from projected roles instead of catalog job rows', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        catalog_sort_key TEXT, PRIMARY KEY (pk, sk)
      )
    `);
    const at = (jobId: string, visibleAt: string) => ({
      ...job(jobId, 'Software Engineering Intern'),
      firstSeenAt: visibleAt,
      catalogVisibleAt: visibleAt,
      lastSeenAt: visibleAt,
    });
    const queries: string[] = [];
    const store = new D1InternshipStore(sqliteD1(database, (query) => queries.push(query)));
    try {
      await store.putCatalogProjection(
        groupCatalogJobs([
          at('august', '2026-08-25T12:00:00.000Z'),
          at('september', '2026-09-18T01:00:00.000Z'),
          at('october', '2026-10-04T12:00:00.000Z'),
        ]).map(catalogGroupDetails),
        new Date().toISOString(),
      );
      queries.length = 0;

      await expect(store.listCatalogProjectionRoles(
        { status: 'open', educationLevel: 'undergraduate' },
        { from: '2026-09-01', to: '2026-09-30' },
      )).resolves.toMatchObject([{ jobId: 'september' }]);
      await expect(store.listCatalogProjectionFiltered(undefined, 25, {
        status: 'open', educationLevel: 'undergraduate', day: '2026-09-17', dayZone: 'America/Los_Angeles',
      })).resolves.toMatchObject({ groups: [{ roles: [{ jobId: 'september' }] }] });
      expect(queries.some((query) => query.includes("json_each(projection.value, '$.roles')"))).toBe(true);
      expect(queries.some((query) => query.includes("kind = 'internship'"))).toBe(false);
    } finally {
      database.close();
    }
  });

  it('still rejects projections older than the bounded recovery window', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-15T05:30:00.000Z');
    vi.setSystemTime(now);
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    database.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, ?, ?)').run(
      'CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', JSON.stringify({
        version: 'expired', generatedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000).toISOString(), schemaVersion: 4,
      }),
    );
    try {
      await expect(new D1InternshipStore(sqliteD1(database)).listCatalogProjection()).resolves.toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('writes a projection larger than the D1 RPC ceiling in byte-bounded batches', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T00:00:00.000Z'));
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    // A live catalog whose serialized projection passed D1's 32 MiB per-RPC
    // ceiling aborted every refresh on this write and froze the feed on its last
    // good version, so the projection write has to bound itself by payload
    // rather than by row or statement count.
    const groups = Array.from({ length: 14 }, (_, index) => catalogGroupDetails(groupCatalogJobs([
      job(`rpc-${index}`, `Software Engineering Intern ${'x'.repeat(900_000)}`),
    ])[0]!));
    const batchBytes: number[] = [];
    try {
      const store = new D1InternshipStore(sqliteD1(database, undefined, { maxBatchBytes: 32 * 1024 * 1024, batchBytes }));
      await expect(store.putCatalogProjection(groups, new Date().toISOString())).resolves.toBeUndefined();
      expect(batchBytes.length).toBeGreaterThan(1);
      expect(Math.max(...batchBytes)).toBeLessThanOrEqual(CATALOG_PROJECTION_BATCH_BYTES);
      expect(batchBytes.reduce((total, bytes) => total + bytes, 0)).toBeGreaterThan(32 * 1024 * 1024);
      expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 14 });
      await expect(store.listCatalogProjection(undefined, 25)).resolves.toMatchObject({ groups: expect.arrayContaining([expect.objectContaining({ group: expect.objectContaining({ roleCount: 1 }) })]) });
    } finally {
      database.close();
    }
    // A production-sized projection write is a heavy local simulation.
  }, 30_000);

  it('writes only the pointer when the projection content has not changed', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    const batches: number[] = [];
    try {
      const store = new D1InternshipStore(sqliteD1(database, undefined, { maxBatchBytes: 32 * 1024 * 1024, batchBytes: batches }));
      const details = [catalogGroupDetails(groupCatalogJobs([job('one', 'Software Engineering Intern')])[0]!)];
      await store.putCatalogProjection(details, '2026-09-18T00:00:00.000Z');
      const writesForFirstRefresh = batches.length;

      // The next tick sees the same cards: the pointer is restated (readers cap a
      // projection by its age) and not one card row is rewritten.
      await store.putCatalogProjection(structuredClone(details), '2026-09-18T00:10:00.000Z');
      expect(batches.length).toBe(writesForFirstRefresh);
      expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 1 });

      // A card that changes inside its stable id still rewrites.
      const changed = structuredClone(details);
      changed[0]!.group.titles = ['Renamed Intern'];
      await store.putCatalogProjection(changed, '2026-09-18T00:20:00.000Z');
      expect(batches.length).toBeGreaterThan(writesForFirstRefresh);
    } finally {
      database.close();
    }
  });

  it('lists and filters the catalog through bounded composite-key pages', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (pk, sk)
      )
    `);
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < 205; index++) {
      const item = job(`job-${String(index).padStart(3, '0')}`, 'Software Engineering Intern');
      insert.run(`JOB#${String(index).padStart(3, '0')}`, 'META', 'internship', JSON.stringify(item));
    }
    insert.run('JOB#099', 'SECOND', 'internship', JSON.stringify(job('shared-key', 'Data Engineering Intern')));
    insert.run('JOB#filtered', 'META', 'internship', JSON.stringify({ ...job('filtered', 'Software Engineering Intern'), technical: false }));
    insert.run('OTHER', 'META', 'checkpoint', '{}');
    const pageSizes: number[] = [];
    try {
      const store = new D1InternshipStore(sqliteD1(database, (query, rows) => {
        if (/SELECT pk, sk, value FROM catalog_items/iu.test(query)) pageSizes.push(rows.length);
      }));
      const listed = await store.listCatalog();
      expect(listed).toHaveLength(206);
      expect(listed.some((item) => item.jobId === 'shared-key')).toBe(true);
      expect(listed.some((item) => item.jobId === 'filtered')).toBe(false);
      expect(listed.every((item) => item.employerCategory === 'normal')).toBe(true);
      expect(pageSizes).toEqual([100, 100, 7]);
    } finally {
      database.close();
    }
  });

  it('packs a production-sized projection within D1 query and binding budgets', async () => {
    const template = catalogGroupDetails(groupCatalogJobs([job('template', 'Software Engineering Intern')])[0]!);
    const groups = Array.from({ length: 1_503 }, (_, index) => ({
      ...template,
      group: { ...template.group, groupId: `group-${index}` },
      roles: template.roles.map((role) => ({ ...role, jobId: `job-${index}` })),
    }));
    const batchSizes: number[] = []; const batchBytes: number[] = [];
    let maxBoundParameters = 0;
    const database = {
      prepare() {
        const statement: D1PreparedStatement & { __payload: number } = {
          __payload: 0,
          bind(...values: unknown[]) {
            maxBoundParameters = Math.max(maxBoundParameters, values.length);
            statement.__payload = values.reduce<number>((total, value) => total + String(value).length, 0);
            return statement;
          },
          async first<T>() { return null as T | null; },
          async all<T>() { return { results: [] as T[] }; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
      async batch(statements: D1PreparedStatement[]) {
        batchSizes.push(statements.length);
        batchBytes.push(statements.reduce((total, statement) => total + (statement as D1PreparedStatement & { __payload: number }).__payload, 0));
        return statements.map(() => ({ meta: { changes: 1 } }));
      },
    } satisfies D1Database;

    await new D1InternshipStore(database).putCatalogProjection(groups, '2026-08-27T00:00:00.000Z');

    // Statements stay inside D1's 100 bound-parameter allowance, each `batch()`
    // inside the RPC argument ceiling, and the whole write inside the paid
    // per-invocation query budget.
    expect(maxBoundParameters).toBeLessThanOrEqual(100);
    expect(batchSizes.reduce((total, size) => total + size, 0)).toBe(61);
    expect(batchSizes.length).toBeLessThan(61);
    expect(Math.max(...batchBytes)).toBeLessThanOrEqual(CATALOG_PROJECTION_BATCH_BYTES);
    expect(batchBytes.reduce((total, bytes) => total + bytes, 0)).toBeGreaterThan(3 * 1024 * 1024);
  });

  it('writes only the cards a refresh changed and orders them by the card itself', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        catalog_sort_key TEXT,
        PRIMARY KEY (pk, sk)
      )
    `);
    const template = catalogGroupDetails(groupCatalogJobs([job('template', 'Software Engineering Intern')])[0]!);
    const groups = Array.from({ length: 26 }, (_, index) => ({
      ...template,
      group: { ...template.group, groupId: `group-${String(index).padStart(2, '0')}` },
      roles: template.roles.map((role) => ({ ...role, jobId: `job-${index}` })),
    }));
    const rows = () => database.prepare("SELECT sk, value, catalog_sort_key FROM catalog_items WHERE kind = 'catalog-projection' ORDER BY sk").all() as Array<{ sk: string; value: string; catalog_sort_key: string }>;
    try {
      const store = new D1InternshipStore(sqliteD1(database));
      // The reader rejects a projection older than the recovery window, so the
      // pointer is stamped now and only its content digest decides a rewrite.
      const generatedAt = new Date().toISOString();
      await store.putCatalogProjection(groups, generatedAt);
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 26 });
      // The order key is the card's own recency, so a card's position never
      // depends on how many cards happened to be built before it.
      expect(database.prepare("SELECT MIN(catalog_sort_key) AS first, MAX(catalog_sort_key) AS last FROM catalog_items WHERE kind = 'catalog-projection'").get())
        .toEqual({ first: `${template.group.updatedAt}#group-00`, last: `${template.group.updatedAt}#group-25` });
      const page = await store.listCatalogProjection(undefined, 25);
      expect(page?.groups.map((group) => group.group.groupId))
        .toEqual(Array.from({ length: 25 }, (_, index) => `group-${String(25 - index).padStart(2, '0')}`));
      expect(page?.cursor).toBe('25');

      // The old row remains briefly for requests that already read its pointer,
      // but the new manifest makes only the renamed card visible.
      const before = rows();
      const changed = structuredClone(groups);
      changed[3]!.group.titles = ['Renamed Intern'];
      await store.putCatalogProjection(changed, generatedAt);
      const after = rows();
      expect(after).toHaveLength(before.length + 1);
      const beforeKeys = new Set(before.map((row) => row.sk));
      const afterKeys = new Set(after.map((row) => row.sk));
      expect([...afterKeys].filter((key) => !beforeKeys.has(key))).toHaveLength(1);
      expect([...beforeKeys].filter((key) => !afterKeys.has(key))).toHaveLength(0);
      expect(after.filter((row) => beforeKeys.has(row.sk))).toEqual(before);
      expect((await store.listCatalogProjection(undefined, 50))?.groups).toHaveLength(26);

      // A group that leaves the catalog takes its row with it, and a group that
      // arrives adds exactly one row.
      const withoutFirst = changed.slice(1);
      const arrived = { ...template, group: { ...template.group, groupId: 'group-99' },
        roles: template.roles.map((role) => ({ ...role, jobId: 'job-new' })) };
      await store.putCatalogProjection([...withoutFirst, arrived], generatedAt);
      const current = rows();
      expect(current).toHaveLength(after.length + 1);
      expect(current.some((row) => row.sk.startsWith('GROUP#group-00#'))).toBe(true);
      expect(current.some((row) => row.sk.startsWith('GROUP#group-99#'))).toBe(true);
      const stored = await store.getCatalogProjectionGroup('group-99');
      expect(stored?.group.groupId).toBe('group-99');
      await expect(store.getCatalogProjectionGroup('group-00')).resolves.toBeUndefined();
      vi.advanceTimersByTime(3 * 60_000);
      await store.putCatalogProjection([...withoutFirst, arrived], new Date().toISOString());
      expect(rows()).toHaveLength(26);
      expect(rows().some((row) => row.sk.startsWith('GROUP#group-00#'))).toBe(false);
    } finally {
      database.close();
    }
  });

  it('serves one complete manifest when a refresh stops before switching the pointer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    const groups = ['first', 'second'].map((id) => {
      const details = catalogGroupDetails(groupCatalogJobs([job(id, `Software Engineering Intern ${id}`)])[0]!);
      details.roles[0]!.releaseDay = '2026-09-18';
      return details;
    });
    const store = new D1InternshipStore(sqliteD1(database));
    const changed = structuredClone(groups);
    changed[0]!.group.titles = ['Renamed Intern'];
    const published = async (title: string) => {
      const page = await store.listCatalogProjection(undefined, 25);
      expect(page?.groups).toHaveLength(2);
      expect(page?.groups.find((entry) => entry.group.groupId === groups[0]!.group.groupId)?.group.titles).toEqual([title]);
      const filtered = await store.listCatalogProjectionFiltered(undefined, 25, { status: 'open' });
      expect(filtered?.groups).toHaveLength(2);
      expect(await store.listCatalogProjectionRoles({ status: 'open' }, {})).toHaveLength(2);
      expect((await store.getCatalogProjectionGroup(groups[0]!.group.groupId))?.group.titles).toEqual([title]);
    };
    try {
      await store.putCatalogProjection(groups, new Date().toISOString());
      let interrupt = true;
      const interrupted = new D1InternshipStore(sqliteD1(database, undefined, undefined, (query) => {
        if (interrupt && query.includes("'catalog-projection-pointer'") && query.includes('WHERE catalog_items.value IS ?')) {
          interrupt = false;
          throw new Error('pointer write interrupted');
        }
      }));
      await expect(interrupted.putCatalogProjection(changed, new Date().toISOString())).rejects.toThrow('pointer write interrupted');
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 3 });
      await published(groups[0]!.group.titles[0]!);
      await store.putCatalogProjection(changed, new Date().toISOString());
      await published('Renamed Intern');
    } finally {
      database.close();
    }
  });

  it('keeps the published card visible and retries an interrupted cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    const store = new D1InternshipStore(sqliteD1(database));
    const original = [catalogGroupDetails(groupCatalogJobs([job('first', 'Software Engineering Intern')])[0]!)];
    const changed = structuredClone(original);
    changed[0]!.group.titles = ['Renamed Intern'];
    try {
      await store.putCatalogProjection(original, new Date().toISOString());
      await store.putCatalogProjection(changed, new Date().toISOString());
      vi.advanceTimersByTime(3 * 60_000);
      let interrupt = true;
      const interrupted = new D1InternshipStore(sqliteD1(database, undefined, undefined, (query) => {
        if (interrupt && query.includes('AND EXISTS (SELECT 1 FROM catalog_items AS candidate')) {
          interrupt = false;
          throw new Error('cleanup interrupted');
        }
      }));
      const cleanupLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(interrupted.putCatalogProjection(changed, new Date().toISOString())).resolves.toBeUndefined();
        expect(cleanupLog).toHaveBeenCalledWith(expect.stringContaining('catalog_projection_cleanup_failed'));
      } finally {
        cleanupLog.mockRestore();
      }
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 2 });
      expect((await store.listCatalogProjection())?.groups.map((entry) => entry.group.titles)).toEqual([['Renamed Intern']]);
      expect((await store.getCatalogProjectionGroup(original[0]!.group.groupId))?.group.titles).toEqual(['Renamed Intern']);
      await store.putCatalogProjection(changed, new Date().toISOString());
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('refuses a stale pointer switch when another refresh publishes first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    const store = new D1InternshipStore(sqliteD1(database));
    const original = [catalogGroupDetails(groupCatalogJobs([job('first', 'Software Engineering Intern')])[0]!)];
    const first = structuredClone(original);
    first[0]!.group.titles = ['First publisher'];
    const second = structuredClone(original);
    second[0]!.group.titles = ['Second publisher'];
    try {
      await store.putCatalogProjection(original, new Date().toISOString());
      let overlap = true;
      const stale = new D1InternshipStore(sqliteD1(database, undefined, undefined, async (query) => {
        if (overlap && query.includes("'catalog-projection-pointer'") && query.includes('WHERE catalog_items.value IS ?')) {
          overlap = false;
          await store.putCatalogProjection(second, new Date().toISOString());
        }
      }));
      await expect(stale.putCatalogProjection(first, new Date().toISOString()))
        .rejects.toThrow('Catalog projection pointer changed during refresh');
      expect((await store.listCatalogProjection())?.groups.map((entry) => entry.group.titles)).toEqual([['Second publisher']]);
      expect((await store.getCatalogProjectionGroup(original[0]!.group.groupId))?.group.titles).toEqual(['Second publisher']);
    } finally {
      database.close();
    }
  });

  it('raises an error if the published manifest is missing', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    const store = new D1InternshipStore(sqliteD1(database));
    try {
      await store.putCatalogProjection([catalogGroupDetails(groupCatalogJobs([job('first', 'Software Engineering Intern')])[0]!)], new Date().toISOString());
      database.prepare("DELETE FROM catalog_items WHERE pk = 'CATALOG_PROJECTION#MANIFESTS'").run();
      await expect(store.listCatalogProjection()).rejects.toThrow('Published catalog projection manifest is missing');
    } finally {
      database.close();
    }
  });

  it('migrates a version-5 pointer without serving its unscoped rows', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    const details = catalogGroupDetails(groupCatalogJobs([job('first', 'Software Engineering Intern')])[0]!);
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, ?, ?, ?)');
    insert.run('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer',
      JSON.stringify({ version: 'version-five', generatedAt: new Date().toISOString(), schemaVersion: 5 }), null);
    insert.run('CATALOG_PROJECTION#GROUPS', 'GROUP#old#00000000000000000000', 'catalog-projection', JSON.stringify(details), details.group.updatedAt);
    const store = new D1InternshipStore(sqliteD1(database));
    try {
      await expect(store.listCatalogProjection()).resolves.toBeUndefined();
      await store.putCatalogProjection([details], new Date().toISOString());
      expect((await store.listCatalogProjection())?.groups.map((entry) => entry.group.groupId)).toEqual([details.group.groupId]);
      expect(JSON.parse((database.prepare("SELECT value FROM catalog_items WHERE pk = 'CATALOG_PROJECTION' AND sk = 'CURRENT'").get() as { value: string }).value).schemaVersion).toBe(6);
    } finally {
      database.close();
    }
  });

  it('keeps version-4 rows through the reader grace period during migration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE catalog_items (pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, catalog_sort_key TEXT, PRIMARY KEY (pk, sk))');
    const old = catalogGroupDetails(groupCatalogJobs([job('first', 'Software Engineering Intern')])[0]!);
    const changed = structuredClone(old);
    changed.group.titles = ['Renamed Intern'];
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, ?, ?, ?)');
    insert.run('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer',
      JSON.stringify({ version: 'version-four', generatedAt: new Date().toISOString(), schemaVersion: 4 }), null);
    insert.run('CATALOG_PROJECTION#version-four', `GROUP#${old.group.groupId}`, 'catalog-projection', JSON.stringify(old), '00000000');
    const store = new D1InternshipStore(sqliteD1(database));
    try {
      await store.putCatalogProjection([changed], new Date().toISOString());
      expect((await store.getCatalogProjectionGroup(old.group.groupId))?.group.titles).toEqual(['Renamed Intern']);
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE pk = 'CATALOG_PROJECTION#version-four'").get()).toEqual({ count: 1 });
      vi.advanceTimersByTime(3 * 60_000);
      await store.putCatalogProjection([changed], new Date().toISOString());
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE pk = 'CATALOG_PROJECTION#version-four'").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('reports a changed refresh against a full publish at production card size', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T00:00:00.000Z'));
    const template = catalogGroupDetails(groupCatalogJobs([job('template', `Software Engineering Intern ${'x'.repeat(9_000)}`)])[0]!);
    const groups = Array.from({ length: 300 }, (_, index) => ({
      ...template,
      group: { ...template.group, groupId: `group-${String(index).padStart(4, '0')}` },
      roles: template.roles.map((role) => ({ ...role, jobId: `job-${index}` })),
    }));
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL, sk TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        catalog_sort_key TEXT, PRIMARY KEY (pk, sk)
      )
    `);
    const batchBytes: number[] = []; const batchSizes: number[] = [];
    try {
      const store = new D1InternshipStore(sqliteD1(database, undefined, { maxBatchBytes: 32 * 1024 * 1024, batchBytes, batchSizes }));
      const generatedAt = new Date().toISOString();
      await store.putCatalogProjection(groups, generatedAt);
      const publishBatches = batchSizes.length;
      const publishStatements = batchSizes.reduce((total, size) => total + size, 0);
      const publishBytes = batchBytes.reduce((total, bytes) => total + bytes, 0);
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 300 });

      // One card changes in a projection of a production card size. The deployed
      // projection carried 2,608 cards and 80.6 MiB on 2026-09-17, and the version
      // this replaced rewrote and deleted all of them on every changed tick.
      const changed = structuredClone(groups);
      changed[7]!.group.titles = ['Renamed Intern'];
      await store.putCatalogProjection(changed, generatedAt);
      const refreshStatements = batchSizes.slice(publishBatches).reduce((total, size) => total + size, 0);
      const refreshBytes = batchBytes.reduce((total, bytes) => total + bytes, 0) - publishBytes;
      console.log(`catalog projection writes: full publish=${publishStatements} statements/${publishBytes} bytes, `
        + `one changed card=${refreshStatements} statements/${refreshBytes} bytes`);
      // The old card is retained for in-flight readers, then collected on a
      // later tick. Only the changed card is written in the refresh batch.
      expect(refreshStatements).toBe(1);
      expect(refreshBytes * 50).toBeLessThan(publishBytes);
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 301 });
      vi.advanceTimersByTime(3 * 60_000);
      await store.putCatalogProjection(changed, new Date().toISOString());
      expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'catalog-projection'").get()).toEqual({ count: 300 });
    } finally {
      database.close();
    }
  }, 30_000);

  it('matches normalized role locations when the raw label is generic', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        catalog_sort_key TEXT,
        PRIMARY KEY (pk, sk)
      )
    `);
    const details = catalogGroupDetails(groupCatalogJobs([job('location', 'Software Engineering Intern')])[0]!);
    details.roles[0]!.location = 'Multiple Locations';
    details.roles[0]!.locations = ['Ithaca, NY'];
    const generatedAt = new Date().toISOString();
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, ?, ?, ?)');
    insert.run('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', JSON.stringify({ version: 'version-a', generatedAt, schemaVersion: 4 }), null);
    insert.run('CATALOG_PROJECTION#version-a', `GROUP#${details.group.groupId}`, 'catalog-projection', JSON.stringify(details), '00000000');

    try {
      const page = await new D1InternshipStore(sqliteD1(database)).listCatalogProjectionFiltered(undefined, 25, {
        status: 'open', locations: ['Ithaca'],
      });
      expect(page?.groups).toMatchObject([{ roles: [{ jobId: 'location', locations: ['Ithaca, NY'] }] }]);
    } finally {
      database.close();
    }
  });

  it('keeps only pay-listed roles when the pay filter is set', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        catalog_sort_key TEXT,
        PRIMARY KEY (pk, sk)
      )
    `);
    const details = catalogGroupDetails(groupCatalogJobs([job('paid', 'Software Engineering Intern'), job('unpaid', 'Software Engineering Intern')])[0]!);
    details.roles.find((role) => role.jobId === 'paid')!.compensation = { raw: '$54/hour' };
    const generatedAt = new Date().toISOString();
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, ?, ?, ?)');
    insert.run('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', JSON.stringify({ version: 'version-a', generatedAt, schemaVersion: 4 }), null);
    insert.run('CATALOG_PROJECTION#version-a', `GROUP#${details.group.groupId}`, 'catalog-projection', JSON.stringify(details), '00000000');

    try {
      const page = await new D1InternshipStore(sqliteD1(database)).listCatalogProjectionFiltered(undefined, 25, {
        status: 'open', hasCompensation: true,
      });
      expect(page?.groups).toMatchObject([{ roles: [{ jobId: 'paid' }] }]);
      expect(page?.groups[0]?.roles).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('matches discipline aliases when the discipline filter is set', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        catalog_sort_key TEXT,
        PRIMARY KEY (pk, sk)
      )
    `);
    const provenance = [{ source: 'deterministic-inference' as const, sourceId: 'test', evidenceCode: 'test' }];
    const tagged = (title: string, discipline: 'software' | 'ai-ml'): InternshipIdentity => ({
      company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance } },
      programType: { value: 'internship', provenance },
      season: { term: 'summer', year: 2027, evidenceStatus: 'explicit', provenance },
      education: { levels: ['undergraduate'], evidenceStatus: 'explicit', provenance },
      title: {
        official: { value: title, provenance },
        display: { value: title, provenance },
        search: { value: title.toLowerCase(), provenance },
      },
      disciplines: [{ value: discipline, provenance }],
      locations: [],
    });
    const details = catalogGroupDetails(groupCatalogJobs([
      { ...job('swe', 'Software Engineering Intern'), internshipIdentity: tagged('Software Engineering Intern', 'software') },
      { ...job('ml', 'Machine Learning Intern'), internshipIdentity: tagged('Machine Learning Intern', 'ai-ml') },
    ])[0]!);
    const generatedAt = new Date().toISOString();
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, ?, ?, ?)');
    insert.run('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', JSON.stringify({ version: 'version-a', generatedAt, schemaVersion: 4 }), null);
    insert.run('CATALOG_PROJECTION#version-a', `GROUP#${details.group.groupId}`, 'catalog-projection', JSON.stringify(details), '00000000');

    try {
      const page = await new D1InternshipStore(sqliteD1(database)).listCatalogProjectionFiltered(undefined, 25, {
        status: 'open', disciplines: ['SWE'],
      });
      expect(page?.groups).toMatchObject([{ roles: [{ jobId: 'swe' }] }]);
      expect(page?.groups[0]?.roles).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('filters roles in one projection query and returns a matched-page cursor', async () => {
    const details = groupCatalogJobs([
      job('software', 'Software Engineering Intern'),
      job('machine', 'Machine Learning Intern'),
    ]).map(catalogGroupDetails).find((group) => group.roles.some((role) => role.jobId === 'machine'))!;
    const prepared: Array<{ query: string; values: unknown[] }> = [];
    const database = {
      prepare(query: string) {
        const call = { query, values: [] as unknown[] };
        prepared.push(call);
        const statement: D1PreparedStatement = {
          bind(...values: unknown[]) { call.values = values; return statement; },
          async first<T>() {
            return { value: JSON.stringify({ version: 'version-a', generatedAt: new Date().toISOString(), schemaVersion: 4 }) } as T;
          },
          async all<T>() { return { results: [{ value: JSON.stringify(details) } as T, { value: JSON.stringify(details) } as T] }; },
          async run() { return { meta: { changes: 0 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    } satisfies D1Database;

    const page = await new D1InternshipStore(database).listCatalogProjectionFiltered(undefined, 1, {
      status: 'open',
      query: 'machine',
      employerCategories: ['normal'],
      hideUsCitizenshipRequired: true,
      educationLevel: 'undergraduate',
    });

    expect(page).toMatchObject({
      cursor: '1',
      groups: [{ group: { roleCount: 1, titles: ['Machine Learning Intern'] }, roles: [{ jobId: 'machine' }] }],
    });
    expect(prepared).toHaveLength(2);
    expect(prepared[1]!.query).toContain("json_each(projection.value, '$.roles')");
    expect(prepared[1]!.query).toContain("json_extract(role.value, '$.employerCategory') IN (?)");
    expect(prepared[1]!.query).toContain("json_extract(role.value, '$.education.levels')");
    expect(prepared[1]!.values).toEqual(expect.arrayContaining(['%machine%', 'normal', 2, 0, 'undergraduate']));
  });

  it('hides roles whose stated audience omits the reader level and keeps unstated ones', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (
        pk TEXT NOT NULL,
        sk TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        catalog_sort_key TEXT,
        PRIMARY KEY (pk, sk)
      )
    `);
    const provenance = [{ source: 'official-ats' as const, sourceId: 'test', evidenceCode: 'education-requirement' }];
    const identity = (title: string, levels: EducationLevel[], evidenceStatus: 'explicit' | 'unspecified'): InternshipIdentity => ({
      company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance } },
      programType: { value: 'internship', provenance },
      season: { term: 'summer', year: 2027, evidenceStatus: 'explicit', provenance },
      education: { levels, evidenceStatus, provenance },
      title: {
        official: { value: title, provenance },
        display: { value: title, provenance },
        search: { value: title.toLowerCase(), provenance },
      },
      disciplines: [{ value: 'software', provenance }],
      locations: [],
    });
    const groups = groupCatalogJobs([
      { ...job('undergrad', 'Software Engineering Intern'), internshipIdentity: identity('Software Engineering Intern', ['undergraduate'], 'explicit') },
      { ...job('masters-only', 'Machine Learning Intern'), internshipIdentity: identity('Machine Learning Intern', ['masters'], 'explicit') },
      { ...job('doctoral-only', 'Research Intern'), internshipIdentity: identity('Research Intern', ['doctoral'], 'explicit') },
      { ...job('graduate', 'Systems Intern'), internshipIdentity: identity('Systems Intern', ['doctoral', 'masters'], 'explicit') },
      { ...job('unstated', 'Platform Intern'), internshipIdentity: identity('Platform Intern', [], 'unspecified') },
      { ...job('badge', 'Firmware Intern'), requirements: { requiresUsCitizenship: false, advancedDegreeRequired: true } },
    ]).map(catalogGroupDetails);
    const generatedAt = new Date().toISOString();
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES (?, ?, ?, ?, ?)');
    insert.run('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', JSON.stringify({ version: 'version-a', generatedAt, schemaVersion: 4 }), null);
    groups.forEach((details, index) => {
      insert.run('CATALOG_PROJECTION#version-a', `GROUP#${details.group.groupId}`, 'catalog-projection', JSON.stringify(details), String(index).padStart(8, '0'));
    });

    const store = new D1InternshipStore(sqliteD1(database));
    const visibleTo = async (educationLevel: 'undergraduate' | 'masters') => {
      const page = await store.listCatalogProjectionFiltered(undefined, 50, { status: 'open', educationLevel });
      return page!.groups.flatMap((entry) => entry.roles.map((role) => role.jobId)).sort();
    };
    try {
      expect(await visibleTo('undergraduate')).toEqual(['undergrad', 'unstated']);
      // The badge states a graduate requirement without naming the degree, so it
      // only ever turns an undergraduate away.
      expect(await visibleTo('masters')).toEqual(['badge', 'graduate', 'masters-only', 'unstated']);
    } finally {
      database.close();
    }
  });
});
