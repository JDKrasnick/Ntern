import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1EmployerIconStore } from '../cloudflare/employer-icon-store.js';
import {
  diagnoseEmployerIcon, enqueueEmployerIconResolution, runEmployerIconResolutionPass,
} from '../cloudflare/employer-icon-resolver.js';
import { brandfetchSearchUrl, logoDevImageUrl, logoDevSearchUrl } from '../src/employer-icon-discovery.js';
import type { EmployerIconSeed } from '../src/employer-icon-resolution.js';
import type { HostResolver } from '../src/employer/safe-network.js';
import type { OpenAIJsonRequest, OpenAIJsonResult } from '../cloudflare/openai-shadow-inference.js';
import type { CanonicalEmployer } from '../src/types.js';
import type { D1Database, D1PreparedStatement, R2Bucket } from '../cloudflare/types.js';

type QueryBudget = { used: number; maximum: number; queries?: string[] };

function sqliteD1(database: DatabaseSync, budget?: QueryBudget): D1Database {
  const count = (query: string) => {
    if (!budget) return;
    budget.queries?.push(query);
    budget.used += 1;
    if (budget.used > budget.maximum) throw new Error(`D1 query budget exceeded: ${budget.used}/${budget.maximum}`);
  };
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { count(query); return database.prepare(query).get(...values) as T | null; },
    async all<T>() { count(query); return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { count(query); const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      database.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

const MIGRATIONS = [
  '0001_initial.sql', '0003_billing_shutdown.sql', '0007_catalog_admission.sql',
  '0013_canonical_employer_icons.sql', '0034_employer_icon_resolution.sql',
];

function subject() {
  const database = new DatabaseSync(':memory:');
  for (const migration of MIGRATIONS) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database);
  return { database, db, admission: new D1CatalogAdmissionStore(db), icons: new D1EmployerIconStore(db) };
}

const NOW = new Date('2026-09-24T12:00:00.000Z');
const PUBLIC_RESOLVER: HostResolver = { async resolve() { return ['93.184.216.34']; } };
/** Every host resolves inside a private range, so the SSRF guard rejects the link. */
const BLOCKED_RESOLVER: HostResolver = { async resolve() { return ['10.0.0.1']; } };
const LOGO_TOKEN = 'logo-dev-token';
const BRANDFETCH_CLIENT = 'brandfetch-client';
const IMAGE_URL = logoDevImageUrl('acme.com', LOGO_TOKEN);

type FetchRoutes = Record<string, () => Response | Promise<Response>>;

function scriptedFetch(routes: FetchRoutes, log: string[] = []): typeof fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    log.push(href);
    const route = routes[href];
    if (!route) throw new Error(`unexpected fetch: ${href}`);
    return route();
  };
  return impl as unknown as typeof fetch;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers });
const webp = (bytes = 4) => new Response(new Uint8Array(bytes).fill(7), { headers: { 'content-type': 'image/webp' } });

const linkPage = (organization: { name: string; url: string }, head = '') =>
  `<!doctype html><html><head><title>Open roles</title>${head}<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', ...organization })}</script></head></html>`;

const employerSeed = (applicationUrl: string): EmployerIconSeed => ({
  canonicalEmployerId: 'acme', displayName: 'Acme', roleTitle: 'Software Engineering Intern',
  applicationUrl, provider: 'greenhouse', tenant: 'acme', sourceId: 'greenhouse:acme',
});

const employerRow = (id: string, displayName: string, iconKey?: string): CanonicalEmployer => ({
  id, displayName, reviewedAt: '2026-09-01T00:00:00.000Z', reviewedBy: 'reviewer',
  ...(iconKey ? { iconKey } : {}),
});

function r2Stub() {
  const puts: Array<{ key: string; contentType?: string; byteLength: number }> = [];
  const objects = new Map<string, { body: ReadableStream; size: number; httpMetadata: { contentType: string } }>();
  const bucket = {
    async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
      const byteLength = value instanceof ArrayBuffer ? value.byteLength : value instanceof Uint8Array ? value.byteLength : 0;
      puts.push({ key, byteLength, ...(options?.httpMetadata?.contentType ? { contentType: options.httpMetadata.contentType } : {}) });
      objects.set(key, { body: new Blob([new Uint8Array(byteLength)]).stream(), size: byteLength, httpMetadata: { contentType: options?.httpMetadata?.contentType ?? '' } });
    },
    async get(key: string) { return objects.get(key) ?? null; },
    async delete(key: string) { objects.delete(key); },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

const environment = (
  db: D1Database,
  documents: R2Bucket,
  secrets: { LOGO_DEV_TOKEN?: string; BRANDFETCH_CLIENT_ID?: string; OPENAI_KEY?: string } = {},
) => ({ DB: db, DOCUMENTS: documents, ...secrets });

const DEPENDENCIES = (fetchImpl: typeof fetch, resolver: HostResolver = PUBLIC_RESOLVER) => ({ resolver, fetchImpl });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('employer icon diagnosis', () => {
  it('rejects the ATS transport host and selects the employer domain the page names', async () => {
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/4001': () => html(linkPage(
        { name: 'Acme', url: 'https://acme.com' }, '<meta property="og:site_name" content="Acme">',
      )),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'),
      credentials: {}, deps: DEPENDENCIES(fetchImpl),
    });

    const transport = diagnostic.decision.scores.find((candidate) => candidate.domain === 'greenhouse.io');
    expect(transport?.rejected).toBe(true);
    expect(transport?.rejectionReason).toContain('ATS');
    expect(transport?.score).toBe(0);

    expect(diagnostic.pageOrganizations).toEqual(['acme.com']);
    expect(diagnostic.decision.selectedDomain).toBe('acme.com');
    expect(diagnostic.decision.selectedScore).toBeCloseTo(0.5, 10);
    const winner = diagnostic.decision.scores.find((candidate) => candidate.domain === 'acme.com');
    expect(winner?.signals).toEqual(expect.arrayContaining(['jsonld-url', 'jsonld-name', 'opengraph']));
  });

  it('reports the redirect chain and scores the employer domain from the final URL', async () => {
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/go/123': () => status(302, { location: 'https://acme.com/careers/role' }),
      'https://acme.com/careers/role': () => html('<!doctype html><html><head><title>Apply now</title></head></html>'),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/go/123'),
      credentials: {}, deps: DEPENDENCIES(fetchImpl),
    });

    expect(diagnostic.redirectHosts).toEqual(['job-boards.greenhouse.io', 'acme.com']);
    expect(diagnostic.finalUrl).toBe('https://acme.com/careers/role');
    expect(diagnostic.pageOrganizations).toEqual([]);
    const winner = diagnostic.decision.scores.find((candidate) => candidate.domain === 'acme.com');
    expect(winner?.score).toBeCloseTo(0.45, 10);
    expect(winner?.signals).toContain('final-url');
    expect(diagnostic.decision.selectedDomain).toBe('acme.com');
    expect(diagnostic.decision.outcome).toBe('unresolved');
  });

  it('records a blocked page, uses no page signals, and falls back to a monogram', async () => {
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'),
      credentials: {}, deps: { resolver: BLOCKED_RESOLVER, fetchImpl: scriptedFetch({}) },
    });

    expect(diagnostic.pageFailure).toBe('blocked');
    expect(diagnostic.pageOrganizations).toEqual([]);
    expect(diagnostic.decision.outcome).toBe('unresolved');
    expect(diagnostic.decision.reason).toBe('No eligible employer domain candidate');
    expect(diagnostic.decision.scores.some((candidate) => candidate.domain === 'acme.com')).toBe(false);
  });

  it('resolves from provider consensus alone when the page is blocked', async () => {
    const fetchImpl = scriptedFetch({
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [brandfetchSearchUrl('Acme', BRANDFETCH_CLIENT)]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => status(404),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'),
      credentials: { logoDevToken: LOGO_TOKEN, brandfetchClientId: BRANDFETCH_CLIENT },
      deps: { resolver: BLOCKED_RESOLVER, fetchImpl },
    });

    expect(diagnostic.pageFailure).toBe('blocked');
    expect(diagnostic.decision.outcome).toBe('resolved');
    expect(diagnostic.decision.selectedDomain).toBe('acme.com');
    // 0.30 + 0.30 + 0.25 agreement is exactly the automatic threshold.
    expect(diagnostic.decision.selectedScore).toBeCloseTo(0.85, 10);
  });

  it('ignores a JSON-LD organization that names a different company', async () => {
    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Globex', url: 'https://globex.com' })),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://acme.com/careers/role'),
      credentials: {}, deps: DEPENDENCIES(fetchImpl),
    });

    expect(diagnostic.pageOrganizations).toEqual(['globex.com']);
    expect(diagnostic.decision.scores.some((candidate) => candidate.domain === 'globex.com')).toBe(false);
    const own = diagnostic.decision.scores.find((candidate) => candidate.domain === 'acme.com');
    expect(own?.score).toBeCloseTo(0.45, 10);
    expect(own?.signals).toEqual(['final-url']);
  });
});

describe('employer icon provider plumbing', () => {
  it('accepts a provider domain only when the provider reports the employer name', async () => {
    const fetchImpl = scriptedFetch({
      [logoDevSearchUrl('Acme')]: () => ok([
        { name: 'Acme', domain: 'acme.com' },
        { name: 'Globex', domain: 'globex.com' },
      ]),
      [IMAGE_URL]: () => status(404),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed(''), credentials: { logoDevToken: LOGO_TOKEN }, deps: DEPENDENCIES(fetchImpl),
    });

    expect(diagnostic.logoDevDomains).toEqual(['acme.com']);
    expect(diagnostic.decision.scores.map((candidate) => candidate.domain)).toEqual(['acme.com']);
    expect(diagnostic.decision.scores[0]!.signals).toContain('logo-dev');
    expect(diagnostic.providerFailures['logo-dev']).toBeUndefined();
  });

  it('treats a provider 404 as a miss rather than a failure', async () => {
    const { database, db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'), NOW);

    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/4001': () => html(linkPage({ name: 'Globex', url: 'https://globex.com' })),
      [logoDevSearchUrl('Acme')]: () => status(404),
    });
    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );

    expect(result.unresolved).toBe(1);
    expect(result.retryable).toBe(0);
    expect((await icons.context('acme'))?.resolutionStatus).toBe('unresolved');
    expect(database.prepare('SELECT status FROM employer_icon_resolutions WHERE canonical_employer_id = ?').get('acme'))
      .toMatchObject({ status: 'unresolved' });
  });

  it('schedules a retry at least as long as the provider Retry-After demands', async () => {
    const { database, db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'), NOW);

    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/4001': () => html('<!doctype html><html><head><title>Open roles</title></head></html>'),
      [logoDevSearchUrl('Acme')]: () => status(429, { 'retry-after': '120' }),
    });
    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );

    expect(result.retryable).toBe(1);
    expect(result.reasonCodes).toEqual(['transient-provider-failure']);
    const row = database.prepare('SELECT status, next_retry_at, evidence_json FROM employer_icon_resolutions WHERE canonical_employer_id = ?')
      .get('acme') as { status: string; next_retry_at: string; evidence_json: string };
    expect(row.status).toBe('retryable');
    expect(Date.parse(row.next_retry_at) - NOW.getTime()).toBeGreaterThanOrEqual(120_000);
    expect(JSON.parse(row.evidence_json).providerFailures['logo-dev']).toBe('http-429');
  });
});

describe('employer icon image gating', () => {
  const resolvedAcme = async (imageResponse: () => Response) => {
    const { database, db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW);
    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: imageResponse,
    });
    const result = await runEmployerIconResolutionPass(
      environment(db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );
    return { database, icons, r2, result };
  };

  it('leaves a monogram when Logo.dev has no real image for the selected domain', async () => {
    const { database, icons, r2, result } = await resolvedAcme(() => status(404));

    expect(result.resolved).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.reasonCodes).toEqual(['image-unavailable']);
    const context = await icons.context('acme');
    expect(context?.resolutionStatus).toBe('unresolved');
    expect(context?.iconKey).toBeUndefined();
    expect(context?.websiteDomain).toBeUndefined();
    expect(database.prepare('SELECT icon_key FROM canonical_employers WHERE id = ?').get('acme')).toMatchObject({ icon_key: null });
    expect(r2.puts).toHaveLength(0);
  });

  it('resolves when the provider serves a real WebP', async () => {
    const { icons, r2, result } = await resolvedAcme(() => webp());

    expect(result.resolved).toBe(1);
    const context = await icons.context('acme');
    expect(context?.resolutionStatus).toBe('resolved');
    expect(context?.websiteDomain).toBe('acme.com');
    // Rendering from the provider CDN needs no licensed copy.
    expect(context?.iconKey).toBeUndefined();
    expect(r2.puts).toHaveLength(0);
  });
});

describe('employer icon retention', () => {
  const licensed = { mode: 'observe' as const, maxPerSweep: 5, logoDevRetentionLicensedAt: '2026-09-01T00:00:00.000Z' };

  it('stores exactly one content-addressed WebP once retention is licensed', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings(licensed, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW);

    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => webp(),
    });
    const result = await runEmployerIconResolutionPass(
      environment(db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );

    expect(result.resolved).toBe(1);
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]!.key).toMatch(/^company-icons\/acme\/logo-[0-9a-f]{16}\.webp$/u);
    expect(r2.puts[0]!.contentType).toBe('image/webp');
    const context = await icons.context('acme');
    expect(context?.iconKey).toBe(r2.puts[0]!.key);
    expect(context?.iconSource).toBe('logo-dev');
  });

  it('never fetches or stores a Brandfetch-hosted logo', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const calls: string[] = [];
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings(licensed, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW);

    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [brandfetchSearchUrl('Acme', BRANDFETCH_CLIENT)]: () => ok([{
        name: 'Acme', domain: 'acme.com',
        logo: 'https://asset.brandfetch.io/acme/id/logo.webp', icon: 'https://asset.brandfetch.io/acme/id/icon.png',
      }]),
      [IMAGE_URL]: () => webp(),
    }, calls);
    const result = await runEmployerIconResolutionPass(
      environment(db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, BRANDFETCH_CLIENT_ID: BRANDFETCH_CLIENT }), NOW,
      DEPENDENCIES(fetchImpl),
    );

    expect(result.resolved).toBe(1);
    expect(calls.filter((url) => url.includes('asset.brandfetch.io'))).toEqual([]);
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]!.key).not.toContain('brandfetch');
    expect((await icons.context('acme'))?.iconSource).toBe('logo-dev');
  });
});

describe('employer icon observe mode', () => {
  it('records the decision without publishing an icon', async () => {
    const { database, db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW);

    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => webp(),
    });
    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );

    expect(result.mode).toBe('observe');
    expect(result.resolved).toBe(1);
    const context = await icons.context('acme');
    expect(context?.websiteDomain).toBe('acme.com');
    expect(context?.resolutionStatus).toBe('resolved');
    expect(context?.iconKey).toBeUndefined();
    // The recalled decision is what makes a later switch to resolve mode instant.
    expect(await icons.automaticDomain('acme')).toBe('acme.com');
    expect(database.prepare('SELECT icon_key FROM canonical_employers WHERE id = ?').get('acme')).toMatchObject({ icon_key: null });
  });
});

describe('employer icon wrong-match reports', () => {
  const licensed = { mode: 'observe' as const, maxPerSweep: 5, logoDevRetentionLicensedAt: '2026-09-01T00:00:00.000Z' };

  async function resolveAcme() {
    const parts = subject();
    const r2 = r2Stub();
    await parts.admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await parts.icons.putSettings(licensed, NOW.toISOString());
    await enqueueEmployerIconResolution(parts.icons, employerSeed('https://acme.com/careers/role'), NOW);
    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => webp(),
    });
    const result = await runEmployerIconResolutionPass(
      environment(parts.db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );
    return { ...parts, r2, fetchImpl, result };
  }

  it('withdraws an automatic decision and sorts the employer to the head of the review queue', async () => {
    const { db, icons } = await resolveAcme();
    expect((await icons.context('acme'))?.iconKey).toBeDefined();

    const invalidatedAt = new Date(NOW.getTime() + 60_000);
    await icons.invalidate('acme', invalidatedAt.toISOString(), 'wrong-icon-report');

    const context = await icons.context('acme');
    expect(context?.iconKey).toBeUndefined();
    expect(context?.iconSource).toBeUndefined();
    expect(context?.websiteDomain).toBeUndefined();
    expect(context?.resolutionStatus).toBe('invalidated');

    const queue = await icons.reviewQueue(10);
    expect(queue[0]).toMatchObject({ canonicalEmployerId: 'acme', status: 'invalidated', reviewPriority: 100 });

    const sweep = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), invalidatedAt,
      DEPENDENCIES(scriptedFetch({})),
    );
    expect(sweep.claimed).toBe(0);
    expect(sweep.resolved).toBe(0);
    expect((await icons.context('acme'))?.iconKey).toBeUndefined();
  });

  it('reopens a reviewed exception so the next sweep resolves it again', async () => {
    const { db, database, icons } = await resolveAcme();
    const invalidatedAt = new Date(NOW.getTime() + 60_000);
    await icons.invalidate('acme', invalidatedAt.toISOString(), 'wrong-icon-report');

    const reopenedAt = new Date(NOW.getTime() + 120_000);
    expect(await icons.reopen('acme', reopenedAt.toISOString())).toBe(1);
    const reopened = database.prepare('SELECT status, next_retry_at, review_priority, invalidated_at FROM employer_icon_resolutions WHERE canonical_employer_id = ?')
      .get('acme') as { status: string; next_retry_at: string; review_priority: number; invalidated_at: string | null };
    expect(reopened).toMatchObject({ status: 'unresolved', review_priority: 0, invalidated_at: null });
    expect(reopened.next_retry_at).toBe(reopenedAt.toISOString());

    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => webp(),
    });
    const sweep = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), reopenedAt, DEPENDENCIES(fetchImpl),
    );

    expect(sweep.claimed).toBe(1);
    expect(sweep.resolved).toBe(1);
    expect((await icons.context('acme'))?.resolutionStatus).toBe('resolved');
    expect((await icons.context('acme'))?.websiteDomain).toBe('acme.com');
  });

  it('preserves a reviewer-uploaded icon on a wrong-icon report', async () => {
    const { admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('globex', 'Globex', 'company-icons/globex/reviewed.webp'), NOW.toISOString());

    await icons.invalidate('globex', NOW.toISOString(), 'wrong-icon-report');

    const context = await icons.context('globex');
    expect(context?.iconKey).toBe('company-icons/globex/reviewed.webp');
    expect(context?.iconSource).toBe('reviewed');
  });
});

describe('employer icon idempotency', () => {
  it('enqueues one row per employer and evidence fingerprint', async () => {
    const { database, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());

    expect(await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW)).toBe(true);
    expect(await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW)).toBe(false);
    expect(database.prepare('SELECT COUNT(*) AS count FROM employer_icon_resolutions WHERE canonical_employer_id = ?').get('acme'))
      .toMatchObject({ count: 1 });
  });

  it('does not re-claim an employer that already resolved', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW);

    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => webp(),
    });
    const env = environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN });
    expect((await runEmployerIconResolutionPass(env, NOW, DEPENDENCIES(fetchImpl))).resolved).toBe(1);

    const second = await runEmployerIconResolutionPass(env, NOW, DEPENDENCIES(fetchImpl));
    expect(second.claimed).toBe(0);
    expect(second.resolved).toBe(0);
  });

  it('skips a task another sweep already holds under lease', async () => {
    const { database, db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('beta', 'Beta'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      canonicalEmployerId: 'beta', displayName: 'Beta', roleTitle: 'Intern',
      applicationUrl: 'https://beta.example/careers/role', provider: 'greenhouse', sourceId: 'greenhouse:beta',
    }, NOW);

    const held = await icons.claimDue(NOW.toISOString(), 5, 300_000);
    expect(held).toHaveLength(1);

    const sweep = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, {}), NOW, DEPENDENCIES(scriptedFetch({
        'https://beta.example/careers/role': () => html('<!doctype html><html><head><title>Open roles</title></head></html>'),
      })),
    );
    expect(sweep.claimed).toBe(0);
    const row = database.prepare('SELECT lease_token FROM employer_icon_resolutions WHERE canonical_employer_id = ?').get('beta') as { lease_token: string | null };
    expect(row.lease_token).not.toBeNull();
  });
});

describe('employer icon tie-breaker budget', () => {
  it('calls the model once per evidence fingerprint and records token usage', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW);

    const requests: OpenAIJsonRequest[] = [];
    const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => {
      requests.push(request);
      return {
        response: { decision: 'uncertain', officialDomain: null, confidence: 0.4, evidenceIds: [], reason: 'ambiguous evidence' },
        inputTokens: 120, outputTokens: 30, actualCostCents: 1,
      };
    };
    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
    });
    const env = environment(db, r2Stub().bucket, { OPENAI_KEY: 'sk-test' });

    const first = await runEmployerIconResolutionPass(env, NOW, { ...DEPENDENCIES(fetchImpl), infer });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.schemaName).toBe('company_icon_domain_resolution');
    expect(first.unresolved).toBe(1);
    expect(first.reasonCodes).toEqual(['tie-break-rejected']);
    const context = await icons.context('acme');
    expect(context?.tieBreakInputTokens).toBe(120);
    expect(context?.tieBreakOutputTokens).toBe(30);
    expect(context?.tieBreakFingerprint).toBeDefined();

    // The same evidence returns to the tie-breaker window, not to the model.
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1_000);
    const second = await runEmployerIconResolutionPass(env, later, { ...DEPENDENCIES(fetchImpl), infer });
    expect(requests).toHaveLength(1);
    expect(second.claimed).toBe(1);
    expect(second.reasonCodes).toEqual(['tie-break-budget-exhausted']);
  });
});

describe('employers needing resolution', () => {
  it('lists only employers without an icon or an outstanding task, within the limit', async () => {
    const { admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('aardvark', 'Aardvark'), NOW.toISOString());
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await admission.putCanonicalEmployer(employerRow('beta', 'Beta'), NOW.toISOString());
    await admission.putCanonicalEmployer(employerRow('globex', 'Globex', 'company-icons/globex/reviewed.webp'), NOW.toISOString());
    await admission.putCanonicalEmployer(employerRow('omega', 'Omega'), NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      canonicalEmployerId: 'beta', displayName: 'Beta', roleTitle: 'Intern',
      applicationUrl: 'https://beta.example/careers/role', provider: 'greenhouse', sourceId: 'greenhouse:beta',
    }, NOW);
    await enqueueEmployerIconResolution(icons, {
      canonicalEmployerId: 'omega', displayName: 'Omega', roleTitle: 'Intern',
      applicationUrl: 'https://omega.example/careers/role', provider: 'greenhouse', sourceId: 'greenhouse:omega',
    }, NOW);
    const claimed = await icons.claimDue(NOW.toISOString(), 10, 60_000);
    await icons.markResolved({
      taskId: claimed.find((task) => task.canonicalEmployerId === 'omega')!.id,
      canonicalEmployerId: 'omega', selectedDomain: 'omega.example', selectedSource: 'logo-dev', confidence: 1,
      evidenceJson: '{}', revalidateAt: new Date(NOW.getTime() + 86_400_000).toISOString(), now: NOW.toISOString(),
    });

    expect((await icons.employersNeedingResolution(10)).map((employer) => employer.id)).toEqual(['aardvark', 'acme']);
    expect(await icons.employersNeedingResolution(1)).toEqual([{ id: 'aardvark', displayName: 'Aardvark' }]);
  });
});
