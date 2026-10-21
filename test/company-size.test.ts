import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { companySizeKey, companySizeScore, companyWebsiteDomain, lookupCompanySize } from '../src/company-size.js';
import { D1CompanySizeStore } from '../cloudflare/company-size-store.js';
import { scoreOpportunity } from '../src/opportunity-score.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

const now = new Date('2026-10-21T00:00:00.000Z');
const input = { company: 'Acme', title: 'Software Engineer Intern', compensation: { raw: '' } };
const response = (extra: Record<string, unknown> = {}) => Response.json({ status: 200, id: 'company-id', name: 'Acme',
  website: 'acme.test', likelihood: 8, matched: ['name', 'website'], employee_count: 1200, ...extra });
const fetcher = (fn: (url: URL, init?: RequestInit) => Response | Promise<Response>) => vi.fn<typeof fetch>((url, init) => Promise.resolve(fn(new URL(String(url)), init)));

function databaseFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE catalog_items(pk TEXT PRIMARY KEY,kind TEXT,catalog_state TEXT,value TEXT);
    CREATE TABLE canonical_employers(id TEXT PRIMARY KEY,website_domain TEXT);
    CREATE TABLE system_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);`);
  database.exec(readFileSync(new URL('../cloudflare/migrations/0058_company_size_cache.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...next) => prepare(sql, next),
    async first<T>() { return (database.prepare(sql).get(...values as string[]) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(sql).all(...values as string[]) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(sql).run(...values as string[]).changes) } }; },
  });
  const db: D1Database = { prepare, batch: statements => Promise.all(statements.map(statement => statement.run())) };
  const store = new D1CompanySizeStore(db);
  const add = (id: string, company: string, open = true, employer?: string) => database.prepare('INSERT INTO catalog_items VALUES (?,?,?,?)')
    .run(id, 'internship', open ? 'OPEN' : 'CLOSED', JSON.stringify({ company, description: 'DO-NOT-HYDRATE'.repeat(5),
      ...(employer ? { admission: { canonicalEmployer: { id: employer } } } : {}) }));
  return { database, store, add };
}

afterEach(() => vi.useRealTimers());
describe('company size lookup', () => {
  it('retains size metadata bands without using headcount or legacy presets for catalog ranking', () => {
    expect([0, 49, 50, 199, 200, 999, 1000, 9999, 10000].map(companySizeScore)).toEqual([50, 50, 55, 55, 65, 65, 75, 75, 85]);
    for (const invalid of [-1, NaN, Infinity, .5, Number.MAX_VALUE]) expect(companySizeScore(invalid)).toBeUndefined();
    expect(scoreOpportunity(input, new Map([['acme', 75]]))).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    expect(scoreOpportunity({ ...input, company: 'Microsoft' }, new Map([['microsoft', 50]]))).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    expect(scoreOpportunity({ ...input, company: 'Microsoft Corporation LLC' })).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    expect(scoreOpportunity({ ...input, company: '🔥 Hudson River Trading, LLC' }, new Map([['hudson river trading', 55]])))
      .toMatchObject({ company: 50, companyEvidence: 'unrated' });
    expect(scoreOpportunity({ ...input, company: 'Hudson River Trading Partners' })).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    expect(scoreOpportunity(input, new Map([['acme', NaN]]))).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    expect(companySizeKey('🔥 Acme Corporation LLC')).toBe('acme');
  });

  it('uses one authenticated request with a known employer domain and minimal fields', async () => {
    const network = fetcher((url, init) => {
      expect(url.origin).toBe('https://api.peopledatalabs.com');
      expect(url.searchParams.get('website')).toBe('acme.test');
      expect(url.searchParams.get('include_if_matched')).toBe('true');
      expect(url.searchParams.get('min_likelihood')).toBe('6');
      expect(url.toString()).not.toContain('secret');
      expect(new Headers(init?.headers).get('X-Api-Key')).toBe('secret');
      return response({ name: 'Different legal name' });
    });
    expect(await lookupCompanySize({ company: 'Acme', domain: 'www.acme.test', roles: 4 }, 'secret', network))
      .toEqual({ status: 'matched', employeeCount: 1200, providerId: 'company-id' });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('allows exact name matches but rejects substrings, weak matches, ATS domains and malformed counts', async () => {
    expect(companyWebsiteDomain('tenant.wd5.myworkdayjobs.com')).toBeUndefined();
    expect(companyWebsiteDomain('https://user:pass@acme.test')).toBeUndefined();
    expect(companyWebsiteDomain('127.0.0.1')).toBeUndefined();
    expect(await lookupCompanySize({ company: '🔥 Acme, Inc.', roles: 1 }, 'secret', fetcher(url => {
      expect(url.searchParams.has('website')).toBe(false);
      expect(url.searchParams.get('min_likelihood')).toBe('5');
      return response({ likelihood: 5, matched: ['name'] });
    }))).toMatchObject({ status: 'matched' });
    for (const extra of [{ name: 'Acme Partners' }, { likelihood: 4 }, { employee_count: -1 }, { employee_count: '1200' },
      { employee_count: null }, { employee_count: 1.5 }, { matched: [] }, { id: '' }, { data: { employee_count: 9000 }, employee_count: undefined }]) {
      expect(await lookupCompanySize({ company: 'Acme', roles: 1 }, 'secret', fetcher(() => response(extra)))).toEqual({ status: 'unmatched' });
    }
  });

  it('bounds response sizes, timeouts and errors without retries or throwing', async () => {
    for (const status of [401, 402, 403, 404, 429, 500, 503]) {
      const network = fetcher(() => new Response('', { status }));
      expect((await lookupCompanySize({ company: 'Acme', roles: 1 }, 'secret', network)).status).toBe(status === 404 ? 'unmatched' : 'error');
      expect(network).toHaveBeenCalledTimes(1);
    }
    for (const body of ['{', 'x'.repeat(20_000)]) expect((await lookupCompanySize({ company: 'Acme', roles: 1 }, 'secret', fetcher(() => new Response(body)))).status).toBe('error');
    vi.useFakeTimers();
    const pending = lookupCompanySize({ company: 'Acme', roles: 1 }, 'secret', fetcher((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toMatchObject({ status: 'error' });
  });
});

describe('durable catalog-wide company cache', () => {
  it('covers 3,300 roles across 1,100 employers with bounded batches, deduplication and zero repeat calls', async () => {
    const { database, store, add } = databaseFixture();
    try {
      for (let i = 0; i < 1100; i++) for (let j = 0; j < 3; j++) add(`${i}-${j}`, j === 1 ? `Employer ${i} Inc.` : `Employer ${i}`);
      add('reviewed', 'Microsoft'); add('reviewed-alias', 'Microsoft Corporation'); add('closed', 'Closed Co', false);
      let calls = 0;
      const network = fetcher(url => { calls++; return response({ name: url.searchParams.get('name'), matched: ['name'], likelihood: 5, employee_count: 1000 }); });
      for (let i = 0; i < 44; i++) expect(await store.refresh('secret', { now, limit: 25, fetcher: network })).toMatchObject({ attempted: 25, matched: 25 });
      expect(calls).toBe(1100);
      const inventory = await store.inventory(now);
      expect(inventory.reduce((sum, company) => sum + company.roles, 0)).toBe(3302);
      expect(inventory.filter(company => company.evidence === 'size')).toHaveLength(1100);
      expect(inventory.filter(company => company.evidence === 'reviewed').every(company => !company.due)).toBe(true);
      expect(inventory.every(company => Number.isFinite(company.score))).toBe(true);
      expect((await store.scores(now)).size).toBe(1100);
      expect(await store.refresh('secret', { now, fetcher: network })).toMatchObject({ attempted: 0 });
      expect(calls).toBe(1100);
      expect(await new D1CompanySizeStore({ prepare: () => { throw new Error('unused'); }, batch: async () => [] }).refresh(undefined))
        .toMatchObject({ skipped: 'missing-key', attempted: 0 });
    } finally { database.close(); }
  }, 30_000);

  it('persists no-match results, expires stale scores and excludes concurrent refreshes', async () => {
    const { database, store, add } = databaseFixture();
    try {
      add('acme', 'Acme');
      const noMatch = fetcher(() => new Response('', { status: 404 }));
      const passes = await Promise.all([store.refresh('secret', { now, fetcher: noMatch }), store.refresh('secret', { now, fetcher: noMatch })]);
      expect(passes.reduce((sum, pass) => sum + pass.attempted, 0)).toBe(1);
      expect(await store.refresh('secret', { now, fetcher: noMatch })).toMatchObject({ attempted: 0 });
      const later = new Date(now.getTime() + 8 * 86_400_000);
      expect(await store.refresh('secret', { now: later, fetcher: fetcher(() => response({ likelihood: 5, matched: ['name'] })) })).toMatchObject({ matched: 1 });
      expect((await store.scores(later)).get('acme')).toBe(75);
      expect((await store.scores(new Date(later.getTime() + 31 * 86_400_000))).size).toBe(0);
    } finally { database.close(); }
  });

  it('uses existing employer domains, pauses on quota errors and leaves scores neutral', async () => {
    const { database, store, add } = databaseFixture();
    try {
      database.prepare('INSERT INTO canonical_employers VALUES (?,?)').run('acme', 'acme.test');
      add('a', 'Acme', true, 'acme'); add('b', 'Other');
      expect((await store.inventory(now)).find(company => company.company === 'Acme')?.domain).toBe('acme.test');
      const network = fetcher(() => new Response('', { status: 429 }));
      expect(await store.refresh('secret', { now, fetcher: network })).toMatchObject({ attempted: 1, errors: 1, skipped: 'quota' });
      expect(await store.refresh('secret', { now, fetcher: network })).toMatchObject({ attempted: 0, skipped: 'busy-or-backoff' });
      expect((await store.scores(now)).size).toBe(0);
      expect(network).toHaveBeenCalledTimes(1);
    } finally { database.close(); }
  });
});
