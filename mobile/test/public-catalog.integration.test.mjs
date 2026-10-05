import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { D1InternshipStore } from '../../cloudflare/d1-store.ts';
import { createApiHandler } from '../../src/api.ts';
import { MemoryUserStore } from '../../src/store.ts';
import { createPublicWorker } from '../web/public-worker.mjs';

afterEach(() => vi.unstubAllGlobals());

it('continues an empty topic window through the renderer, real API, and indexed D1 store to an official handoff', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE catalog_items (pk TEXT, sk TEXT, value TEXT, catalog_state TEXT, catalog_sort_key TEXT);
    CREATE INDEX catalog_items_state_sort ON catalog_items(catalog_state, catalog_sort_key DESC);`);
  const insert = database.prepare('INSERT INTO catalog_items VALUES (?, ?, ?, ?, ?)');
  for (let index = 0; index < 150; index += 1) {
    const job = { jobId: `role-${index}`, company: 'Acme',
      title: index === 125 ? 'Machine Learning Intern & Research' : 'Software Intern',
      location: 'Remote', season: 'summer-2027', open: true, technical: true, programType: 'internship',
      sourceReferences: [], applyUrl: `https://careers.example.test/role-${index}`,
      normalizedUrl: `https://careers.example.test/role-${index}`, fingerprint: `role-${index}`,
      compensation: { raw: '' }, firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z',
      notification: { smsPending: false, digestPending: false } };
    insert.run(`JOB#${job.jobId}`, 'META', JSON.stringify(job), 'OPEN', String(1000 - index).padStart(6, '0'));
  }
  let hydrated = 0;
  const prepared = (query, values = []) => ({
    bind: (...next) => prepared(query, next),
    first: async () => database.prepare(query).get(...values) ?? null,
    all: async () => {
      const results = database.prepare(query).all(...values); hydrated += results.length;
      expect(query).not.toContain('LIKE');
      return { results };
    },
  });
  const handler = createApiHandler({ jobs: new D1InternshipStore({ prepare: prepared }), users: new MemoryUserStore() });
  const api = vi.fn(async (input) => {
    const url = new URL(input);
    const result = await handler({ rawPath: url.pathname, queryStringParameters: Object.fromEntries(url.searchParams),
      requestContext: { http: { method: 'GET' } } });
    return new Response(result.body, { status: result.statusCode, headers: result.headers });
  });
  vi.stubGlobal('fetch', api);
  const worker = createPublicWorker('https://intern-notifs.jdkrasnick.workers.dev');
  try {
    const first = await worker.fetch(new Request('https://ntern.app/jobs?topic=ml'), {});
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('href="/jobs?topic=ml&amp;cursor=100"');
    expect(hydrated).toBe(100);
    expect(api).toHaveBeenCalledTimes(1);

    hydrated = 0;
    const next = await worker.fetch(new Request('https://ntern.app/jobs?topic=ml&cursor=100'), {});
    const html = await next.text();
    expect(next.status).toBe(200);
    expect(html).toContain('href="/jobs/role-125"');
    expect(html).toContain('Machine Learning Intern &amp; Research');
    expect(html).not.toContain('href="/jobs/role-124"');
    expect(hydrated).toBeLessThanOrEqual(100);
    expect(api).toHaveBeenCalledTimes(2);

    const detail = await worker.fetch(new Request('https://ntern.app/jobs/role-125'), {});
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain('href="https://careers.example.test/role-125"');
    expect(api).toHaveBeenCalledTimes(3);
  } finally { database.close(); }
});
