import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { companyIconResponse } from '../cloudflare/company-icon.js';
import { handleEmployerIconOperations } from '../cloudflare/employer-icon-api.js';
import { D1EmployerIconStore } from '../cloudflare/employer-icon-store.js';
import {
  diagnoseEmployerIcon, enqueueEmployerIconResolution, runEmployerIconResolutionPass,
} from '../cloudflare/employer-icon-resolver.js';
import { brandfetchSearchUrl, logoDevImageUrl, logoDevSearchUrl, rasterDimensions } from '../src/employer-icon-discovery.js';
import { createIconSvgRasterizer } from '../cloudflare/svg-raster.js';
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
const LOGO_TOKEN = 'logo-dev-secret-key';
/** Logo.dev's image endpoint takes the publishable token, never the secret key. */
const LOGO_IMAGE_TOKEN = 'logo-dev-publishable-token';
const BRANDFETCH_CLIENT = 'brandfetch-client';
const IMAGE_URL = logoDevImageUrl('acme.com', LOGO_IMAGE_TOKEN);

type FetchRoutes = Record<string, () => Response | Promise<Response>>;

/**
 * A fetch double over exact URLs.
 *
 * An unrouted URL throws, which keeps a test honest about what it stubbed. Provider
 * searches are the exception: every employer asks each configured provider, and a test
 * is about one thing at a time, so a search it did not route is answered as a clean miss
 * — the provider simply has nothing under that name. That way adding a provider to the
 * resolver (as Brandfetch was) does not quietly break dozens of unrelated fixtures.
 */
function scriptedFetch(routes: FetchRoutes, log: string[] = []): typeof fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    log.push(href);
    const route = routes[href];
    if (route) return route();
    if (href.startsWith('https://api.logo.dev/search') || href.startsWith('https://api.brandfetch.io/v2/search')) {
      return status(404);
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return impl as unknown as typeof fetch;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers });
const webp = (bytes = 4) => new Response(new Uint8Array(bytes).fill(7), { headers: { 'content-type': 'image/webp' } });

/** A PNG with a real IHDR, which is all the banner shape check reads. */
function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(24));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

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
  const puts: Array<{ key: string; contentType?: string; byteLength: number; bytes?: Uint8Array }> = [];
  const objects = new Map<string, { body: ReadableStream; size: number; httpMetadata: { contentType: string } }>();
  const bucket = {
    async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
      const byteLength = value instanceof ArrayBuffer ? value.byteLength : value instanceof Uint8Array ? value.byteLength : 0;
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : undefined;
      puts.push({ key, byteLength, ...(bytes ? { bytes } : {}), ...(options?.httpMetadata?.contentType ? { contentType: options.httpMetadata.contentType } : {}) });
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
  secrets: {
    LOGO_DEV_TOKEN?: string; LOGO_DEV_IMAGE_TOKEN?: string;
    LOGO_SECRET_KEY?: string; LOGO_PUBLISHABLE_KEY?: string;
    LOGO_DEV_PUBLISHABLE_KEY?: string; LOGO_DEV_PUBLISHABLE_TOKEN?: string;
    BRANDFETCH_CLIENT_ID?: string; OPENAI_KEY?: string;
  } = {},
) => ({ DB: db, DOCUMENTS: documents, ...secrets });

const DEPENDENCIES = (fetchImpl: typeof fetch, resolver: HostResolver = PUBLIC_RESOLVER) => ({ resolver, fetchImpl });

/**
 * The real resvg renderer the ingestion Worker ships, so the SVG path is exercised
 * through the module that runs in production rather than a stand-in for it.
 */
const RASTERIZE = createIconSvgRasterizer(
  readFileSync(new URL('../node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url)),
);

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
    // A non-ATS final URL plus the reviewed board slug naming the employer.
    expect(winner?.score).toBeCloseTo(0.6, 10);
    expect(winner?.signals).toEqual(expect.arrayContaining(['final-url', 'ats-tenant']));
    expect(diagnostic.decision.selectedDomain).toBe('acme.com');
    expect(diagnostic.decision.outcome).toBe('llm-review');
  });

  it('corroborates with Brandfetch and publishes on consensus, with no model call', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    // A board slug that names nobody: the two providers agreeing is the whole case.
    await enqueueEmployerIconResolution(icons, { ...employerSeed('https://jobs.lever.co/acme/1'), provider: 'lever', tenant: 'job-1', sourceId: 'lever:job-1' }, NOW);
    let modelCalls = 0;
    const infer = async (): Promise<OpenAIJsonResult> => {
      modelCalls += 1;
      throw new Error('two providers agreeing must not need the model');
    };
    const fetchImpl = scriptedFetch({
      'https://jobs.lever.co/acme/1': () => html('<!doctype html><html><head><title>Open roles</title></head></html>'),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      // No client id is configured, and the search still answers.
      [brandfetchSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => webp(),
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW,
      { ...DEPENDENCIES(fetchImpl), infer },
    );

    expect(result.resolved).toBe(1);
    expect(modelCalls).toBe(0);
    // Consensus clears the automatic threshold, so neither the model nor a
    // confirmation fetch was needed.
    expect(result.confirmationProbes).toBe(0);
    expect((await icons.context('acme'))?.websiteDomain).toBe('acme.com');
  });

  it('ranks an exhausted employer for review and says why', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, { ...employerSeed('https://jobs.lever.co/acme/1'), provider: 'lever', tenant: 'job-1', sourceId: 'lever:job-1' }, NOW);
    // Three attempts of clean misses: nothing left for the resolver to try. Each pass
    // runs past the previous one's backoff, since that backoff is what spaces them.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const when = new Date(NOW.getTime() + attempt * 2 * 24 * 60 * 60 * 1000);
      await runEmployerIconResolutionPass(
        environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), when,
        DEPENDENCIES(scriptedFetch({
          'https://jobs.lever.co/acme/1': () => html('<!doctype html><html><head><title>Open roles</title></head></html>'),
          [logoDevSearchUrl('Acme')]: () => status(404),
        })),
      );
    }

    const queue = await icons.reviewQueue(10);
    expect(queue[0]).toMatchObject({ canonicalEmployerId: 'acme', status: 'unresolved', reasonCode: 'no-reliable-domain' });
    expect(queue[0]?.attempts).toBeGreaterThanOrEqual(3);
    // A wrong-icon report outranks an exhausted miss, so the queue stays triage-ordered.
    expect(queue[0]?.reviewPriority).toBeGreaterThan(0);
    expect(queue[0]?.reviewPriority).toBeLessThan(100);
  });

  it('accepts a single corroborated candidate by proving it, without spending the model call', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    // The board slug names the employer too, so the candidate carries the provider
    // nomination and that corroboration, and scores inside the middle band.
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/acme/jobs/1'), NOW);
    let modelCalls = 0;
    const infer = async (): Promise<OpenAIJsonResult> => {
      modelCalls += 1;
      throw new Error('the model must not be consulted for a corroborated candidate');
    };
    // A provider nomination plus the page naming the employer is two independent
    // signals on one candidate, and the domain proves the rest.
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/1': () => html(
        '<!doctype html><html><head><title>Software Engineering Intern at Acme</title></head></html>',
      ),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      'https://acme.com/': () => html('<!doctype html><html><head><title>Acme — industrial supplies</title></head></html>'),
      [IMAGE_URL]: () => webp(),
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2.bucket, {
        LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test',
      }), NOW, { ...DEPENDENCIES(fetchImpl), infer },
    );

    expect(result.resolved).toBe(1);
    expect(modelCalls).toBe(0);
    expect((await icons.context('acme'))?.websiteDomain).toBe('acme.com');
    const events = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'company_icon_resolution_domain_confirmed'))
      .toMatchObject({ domain: 'acme.com' });
  });

  it('accepts a lone provider nomination once the domain names itself, and leaves a real tie to the model', async () => {
    // A platform-hosted posting with one provider nomination and no second signal: the
    // domain decides, because the domain naming itself is the same proof a proposal needs.
    const single = async () => {
      const { db, admission, icons } = subject();
      const r2 = r2Stub();
      await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
      await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
      // A board slug that does not name the employer, so only the provider speaks.
      await enqueueEmployerIconResolution(icons, { ...employerSeed('https://jobs.lever.co/acme/1'), provider: 'lever', tenant: 'job-1', sourceId: 'lever:job-1' }, NOW);
      return { db, r2, icons };
    };

    const confirmed = await single();
    const confirmedPass = await runEmployerIconResolutionPass(
      environment(confirmed.db, confirmed.r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW,
      DEPENDENCIES(scriptedFetch({
        'https://jobs.lever.co/acme/1': () => html('<!doctype html><html><head><title>Open roles</title></head></html>'),
        [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
        'https://acme.com/': () => html('<!doctype html><html><head><title>Acme — industrial supplies</title></head></html>'),
        [IMAGE_URL]: () => webp(),
      })),
    );
    expect(confirmedPass.resolved).toBe(1);
    expect((await confirmed.icons.context('acme'))?.websiteDomain).toBe('acme.com');

    // Two nominations that both name themselves are a genuine tie: the model decides,
    // and with no model configured the employer keeps its monogram.
    const tied = await single();
    const tiedPass = await runEmployerIconResolutionPass(
      environment(tied.db, tied.r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW,
      DEPENDENCIES(scriptedFetch({
        'https://jobs.lever.co/acme/1': () => html('<!doctype html><html><head><title>Open roles</title></head></html>'),
        [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }, { name: 'Acme', domain: 'acme-group.com' }]),
        'https://acme.com/': () => html('<!doctype html><html><head><title>Acme — industrial supplies</title></head></html>'),
        'https://acme-group.com/': () => html('<!doctype html><html><head><title>Acme Group — holding company</title></head></html>'),
        [IMAGE_URL]: () => webp(),
      })),
    );
    expect(tiedPass.resolved).toBe(0);
    expect((await tied.icons.context('acme'))?.websiteDomain).toBeUndefined();
  });

  it('publishes a below-floor tie-break only when the domain itself names the employer', async () => {
    // The real model answers correctly at 0.8 far more often than it answers at all
    // above 0.90, so a below-floor selection is verified against the domain instead of
    // trusted — and a domain that does not name the employer is still refused.
    const run = async (homepage: () => Response) => {
      const { db, admission, icons } = subject();
      const r2 = r2Stub();
      await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
      await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
      await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
      const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => {
        const input = JSON.parse(request.prompt.user) as { candidates: Array<{ domain: string; evidenceIds: string[] }> };
        const chosen = input.candidates.find((candidate) => candidate.domain === 'acme.com')!;
        return {
          response: { decision: 'accept', officialDomain: 'acme.com', confidence: 0.75,
            evidenceIds: chosen.evidenceIds, reason: 'the provider and the page agree' },
          inputTokens: 10, outputTokens: 5, actualCostCents: 1,
        };
      };
      const fetchImpl = scriptedFetch({
        'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
          '<!doctype html><html><head><title>Software Engineering Intern at Acme</title></head></html>',
        ),
        [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
        [brandfetchSearchUrl('Acme', BRANDFETCH_CLIENT)]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
        'https://acme.com/': homepage,
        [IMAGE_URL]: () => webp(),
      });
      const result = await runEmployerIconResolutionPass(
        environment(db, r2.bucket, {
          LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, BRANDFETCH_CLIENT_ID: BRANDFETCH_CLIENT, OPENAI_KEY: 'sk-test',
        }), NOW, { ...DEPENDENCIES(fetchImpl), infer },
      );
      return { result, icons };
    };

    // The domain's own homepage names the employer, so the answer is evidence-backed.
    const confirmed = await run(() => html('<!doctype html><html><head><title>Acme — industrial supplies</title></head></html>'));
    expect(confirmed.result.resolved).toBe(1);
    expect((await confirmed.icons.context('acme'))?.websiteDomain).toBe('acme.com');

    // A homepage that does not name the employer stays a monogram: the model's word
    // alone is never enough below the floor.
    const unconfirmed = await run(() => html('<!doctype html><html><head><title>Domain for sale</title></head></html>'));
    expect(unconfirmed.result.resolved).toBe(0);
    expect((await unconfirmed.icons.context('acme'))?.websiteDomain).toBeUndefined();
  });

  it('reads the employer’s own site when its board published nothing and the provider has no logo', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const seed = { ...employerSeed('https://acme.com/careers/1'), provider: 'structured', provenance: 'official-ats' as const };
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, seed, NOW);
    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/1': () => html('<!doctype html><html><head><title>Careers</title></head></html>'),
      // The provider has nothing for this domain.
      [IMAGE_URL]: () => status(404),
      // The employer's own homepage declares a square touch icon.
      'https://acme.com/': () => html(
        '<!doctype html><html><head><title>Acme</title>'
        + '<link rel="apple-touch-icon" sizes="180x180" href="/touch-180.png"></head></html>',
      ),
      'https://acme.com/touch-180.png': () => new Response(pngBytes(180, 180), { headers: { 'content-type': 'image/png' } }),
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2.bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );

    expect(result.resolved).toBe(1);
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.key).toMatch(/^company-icons\/acme\/site-[0-9a-f]{16}\.png$/u);
    expect((await admission.getCanonicalEmployer('acme'))?.iconSource).toBe('domain-asset');
    const events = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'company_icon_domain_asset_stored'))
      .toMatchObject({ source: 'declared', format: 'image/png' });
  });

  it('reads the mark the posting page itself declares, with no extra request', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    // The employer's postings live on its own domain, so the page already fetched for
    // evidence is the page that declares its mark.
    const seed = { ...employerSeed('https://acme.com/careers/1'), provider: 'structured', provenance: 'official-ats' as const };
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, seed, NOW);
    const requested: string[] = [];
    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/1': () => html(
        '<!doctype html><html><head><title>Careers</title>'
        + '<link rel="apple-touch-icon" sizes="180x180" href="/touch-180.png"></head></html>',
      ),
      [IMAGE_URL]: () => status(404),
      'https://acme.com/touch-180.png': () => new Response(pngBytes(180, 180), { headers: { 'content-type': 'image/png' } }),
      'https://acme.com/': () => { requested.push('homepage'); return status(500); },
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2.bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );

    expect(result.resolved).toBe(1);
    expect(r2.puts[0]?.key).toMatch(/^company-icons\/acme\/site-[0-9a-f]{16}\.png$/u);
    // The mark came from the page already in hand, so the homepage was never requested.
    expect(requested).toEqual([]);
    const events = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'company_icon_domain_asset_stored'))
      .toMatchObject({ source: 'declared', url: 'https://acme.com/touch-180.png' });
  });

  it('lets the model name an asset on the verified domain, and drops one outside it', async () => {
    const run = async (assetUrl: string) => {
      const { db, admission, icons } = subject();
      const r2 = r2Stub();
      const seed = { ...employerSeed('https://acme.com/careers/1'), provider: 'structured', provenance: 'official-ats' as const };
      await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
      await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
      await enqueueEmployerIconResolution(icons, seed, NOW);
      const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => ({
        response: request.schemaName === 'company_icon_asset_pick'
          ? { assetUrl, confidence: 0.8, reason: 'the mark on their brand page' }
          : { decision: 'reject', officialDomain: null, confidence: 0, evidenceIds: [], reason: 'nothing to choose' },
        inputTokens: 12, outputTokens: 6, actualCostCents: 1,
      });
      const fetchImpl = scriptedFetch({
        'https://acme.com/careers/1': () => html('<!doctype html><html><head><title>Careers</title></head></html>'),
        [IMAGE_URL]: () => status(404),
        // The homepage declares nothing usable, so the model is the only way left.
        'https://acme.com/': () => html('<!doctype html><html><head><title>Acme</title><img src="/irrelevant.png"></head></html>'),
        'https://acme.com/brand/mark.png': () => new Response(pngBytes(512, 512), { headers: { 'content-type': 'image/png' } }),
      });
      const result = await runEmployerIconResolutionPass(
        environment(db, r2.bucket, {
          LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test',
        }), NOW, { ...DEPENDENCIES(fetchImpl), infer },
      );
      return { result, r2, admission };
    };

    // A URL the model named on the employer's own domain is fetched and gated.
    const named = await run('https://acme.com/brand/mark.png');
    expect(named.result.resolved).toBe(1);
    expect(named.r2.puts[0]?.key).toMatch(/^company-icons\/acme\/site-[0-9a-f]{16}\.png$/u);
    expect((await named.admission.getCanonicalEmployer('acme'))?.iconSource).toBe('domain-asset');

    // The same answer pointing somewhere else is dropped before any request.
    const elsewhere = await run('https://cdn.evil.test/mark.png');
    expect(elsewhere.result.resolved).toBe(0);
    expect(elsewhere.r2.puts).toHaveLength(0);
    expect((await elsewhere.admission.getCanonicalEmployer('acme'))?.iconKey).toBeUndefined();
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

  it('treats a challenge page from the board as a retry rather than an answer', async () => {
    const { database, db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/acme/jobs/1'), NOW);
    // Greenhouse's edge answers a client it has rate-limited with 406 and an nginx
    // body. That page names no employer and carries no board art, so it must not be
    // read as the employer's posting.
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/1': () => new Response(
        '<html><head><title>406 Not Acceptable</title></head></html>',
        { status: 406, headers: { 'content-type': 'text/html' } },
      ),
    });

    const result = await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));

    expect(result.retryable).toBe(1);
    expect(result.unresolved).toBe(0);
    const row = database.prepare('SELECT evidence_json FROM employer_icon_resolutions WHERE canonical_employer_id = ?')
      .get('acme') as { evidence_json: string };
    const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
    expect(evidence).toMatchObject({ pageFailure: 'transport', pageStatus: 406, reasonCode: 'transient-provider-failure' });
    // The platform host itself is recorded, rejected: the error page named nothing.
    expect((evidence.candidates as Array<{ rejected?: boolean }>).every((candidate) => candidate.rejected === true)).toBe(true);
  });

  it('records a withdrawn posting with the long backoff', async () => {
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/acme/jobs/1'),
      credentials: {},
      deps: {
        resolver: PUBLIC_RESOLVER,
        fetchImpl: scriptedFetch({ 'https://job-boards.greenhouse.io/acme/jobs/1': () => new Response(null, { status: 404 }) }),
      },
    });

    expect(diagnostic.pageStatus).toBe(404);
    expect(diagnostic.pageFailure).toBe('blocked');
    expect(diagnostic.decision.outcome).toBe('unresolved');
  });

  it('presents an identifying client when it reads a posting', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return html('<html><head><title>Open roles</title></head></html>');
    }) as typeof fetch;

    await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/acme/jobs/1'),
      credentials: {}, deps: { resolver: PUBLIC_RESOLVER, fetchImpl },
    });

    const headers = seen[0]?.headers ?? {};
    // The page request names the client and asks for HTML, because a request that
    // presents nothing at all is answered with 406.
    expect(headers['user-agent']).toContain('NternCompanyIcons');
    expect(headers.accept).toContain('text/html');
  });

  it('refuses to publish a domain when the image credential is missing, and publishes with it', async () => {
    // The same evidence, twice: an officially-admitted role on the employer's own
    // domain, which scores 0.85 with no provider and no page metadata at all. What
    // differs is only whether the image endpoint can be called.
    const seed = {
      ...employerSeed('https://acme.com/careers/1'),
      provider: 'structured', provenance: 'official-ats' as const,
    };
    const page = () => html('<!doctype html><html><head><title>Careers</title></head></html>');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Only the secret key is provisioned. It authorizes the name search and is
    // answered with 401 by the image endpoint, so no image can be verified — and
    // nothing may be published on the strength of the key alone.
    const first = subject();
    const firstR2 = r2Stub();
    await first.admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await first.icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(first.icons, seed, NOW);
    const secretKeyOnly = await runEmployerIconResolutionPass(
      environment(first.db, firstR2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN }), NOW,
      DEPENDENCIES(scriptedFetch({ 'https://acme.com/careers/1': page })),
    );

    expect(secretKeyOnly.resolved).toBe(0);
    expect(secretKeyOnly.reasonCodes).toContain('image-token-missing');
    expect(firstR2.puts).toHaveLength(0);
    expect((await first.icons.context('acme'))?.websiteDomain).toBeUndefined();
    const warning = warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((event) => event.event === 'company_icon_resolution_image_token_missing');
    expect(warning).toMatchObject({ canonicalEmployerId: 'acme', domain: 'acme.com' });

    // The publishable token is what the image endpoint accepts, and with it the same
    // evidence resolves.
    const second = subject();
    await second.admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await second.icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(second.icons, seed, NOW);
    const published = await runEmployerIconResolutionPass(
      environment(second.db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW,
      DEPENDENCIES(scriptedFetch({
        'https://acme.com/careers/1': page,
        [IMAGE_URL]: () => webp(),
      })),
    );
    expect(published.resolved).toBe(1);
    expect((await second.icons.context('acme'))?.websiteDomain).toBe('acme.com');
  });

  it('resolves from provider consensus alone when the page is blocked', async () => {
    const fetchImpl = scriptedFetch({
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [brandfetchSearchUrl('Acme', BRANDFETCH_CLIENT)]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => status(404),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'),
      credentials: { logoDevToken: LOGO_TOKEN, logoDevImageToken: LOGO_IMAGE_TOKEN, brandfetchClientId: BRANDFETCH_CLIENT },
      deps: { resolver: BLOCKED_RESOLVER, fetchImpl },
    });

    expect(diagnostic.pageFailure).toBe('blocked');
    expect(diagnostic.decision.outcome).toBe('resolved');
    expect(diagnostic.decision.selectedDomain).toBe('acme.com');
    // 0.30 + 0.30 + 0.25 agreement + 0.15 for the board slug naming the employer,
    // capped at 1.0.
    expect(diagnostic.decision.selectedScore).toBeCloseTo(1, 10);
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
    expect(own?.score).toBeCloseTo(0.6, 10);
    expect(own?.signals).toEqual(['final-url', 'ats-tenant']);
  });

  it('corroborates a provider nomination with an ATS page that names the employer', async () => {
    // The dominant shape in this catalog: the posting is hosted on a transport
    // host, so the page proves *who* is hiring but names no domain of its own.
    // Without attaching that proof to the provider's nomination the employer
    // could never leave a monogram, because a lone provider signal is 0.30.
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/4001': () => html(
        '<!doctype html><html><head><title>Job Application for Software Engineering Intern at Acme</title></head></html>',
      ),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'),
      credentials: { logoDevToken: LOGO_TOKEN, logoDevImageToken: LOGO_IMAGE_TOKEN }, deps: DEPENDENCIES(fetchImpl),
    });

    const winner = diagnostic.decision.scores.find((candidate) => candidate.domain === 'acme.com');
    expect(winner?.signals).toEqual(expect.arrayContaining(['logo-dev', 'page-title', 'platform-name', 'ats-tenant']));
    expect(winner?.evidenceIds).toHaveLength(4);
    expect(diagnostic.decision.outcome).toBe('llm-review');
    // The transport host itself is still never selectable.
    expect(diagnostic.decision.scores.find((candidate) => candidate.domain === 'greenhouse.io')?.rejected).toBe(true);
  });

  it('adds no page evidence when the page names a different employer, and stays a monogram without a corroborating board', async () => {
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/4001': () => html(
        '<!doctype html><html><head><title>Job Application for Data Scientist Intern at Globex</title></head></html>',
      ),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
    });
    const diagnostic = await diagnoseEmployerIcon({
      // A board slug that does not name this employer, so no identity signal fires.
      seed: { ...employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'), tenant: 'board-1' },
      credentials: { logoDevToken: LOGO_TOKEN, logoDevImageToken: LOGO_IMAGE_TOKEN }, deps: DEPENDENCIES(fetchImpl),
    });

    const winner = diagnostic.decision.scores.find((candidate) => candidate.domain === 'acme.com');
    expect(winner?.signals).toEqual(['logo-dev']);
    expect(winner?.evidenceIds).toHaveLength(1);
    expect(diagnostic.decision.outcome).toBe('unresolved');
  });

  it('corroborates a provider nomination from the reviewed board slug alone', async () => {
    // A challenge-gated page yields no metadata at all, so the only identity
    // evidence is our own reviewed binding of this employer to its board.
    const diagnostic = await diagnoseEmployerIcon({
      seed: employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'),
      credentials: { logoDevToken: LOGO_TOKEN, logoDevImageToken: LOGO_IMAGE_TOKEN },
      deps: { resolver: PUBLIC_RESOLVER, fetchImpl: scriptedFetch({
        'https://job-boards.greenhouse.io/acme/jobs/4001': () => status(403),
        [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      }) },
    });

    // A 403 challenge is the platform refusing the client, not a page that happens
    // to say nothing, and it is recorded as such so the employer is re-read soon.
    expect(diagnostic.pageFailure).toBe('transport');
    expect(diagnostic.pageStatus).toBe(403);
    expect(diagnostic.pageOrganizations).toEqual([]);
    const winner = diagnostic.decision.scores.find((candidate) => candidate.domain === 'acme.com');
    expect(winner?.signals).toEqual(['ats-tenant', 'logo-dev']);
    expect(diagnostic.decision.outcome).toBe('llm-review');
  });

  it('reads an organization domain from sameAs and uses it as a candidate', async () => {
    // The shape real publishers emit: schema.org puts the site in `sameAs`.
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/4001': () => html(
        '<!doctype html><html><head><title>Job Application for Software Engineering Intern</title>'
        + `<script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting', title: 'Software Engineering Intern',
          hiringOrganization: { '@type': 'Organization', name: 'Acme', sameAs: 'https://acme.com' },
        })}</script></head></html>`,
      ),
    });
    const diagnostic = await diagnoseEmployerIcon({
      // No board corroboration and no provider, so only the structured data can decide.
      seed: { ...employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'), tenant: 'board-1' },
      credentials: {}, deps: DEPENDENCIES(fetchImpl),
    });

    expect(diagnostic.pageOrganizations).toEqual(['acme.com']);
    const winner = diagnostic.decision.scores.find((candidate) => candidate.domain === 'acme.com');
    expect(winner?.signals).toEqual(expect.arrayContaining(['jsonld-url', 'jsonld-name']));
    // 0.35 for the structured organization. It is its own identity evidence, but it
    // is the same signal group, so it cannot also add the metadata weight.
    expect(winner?.score).toBeCloseTo(0.35, 10);
  });

  it('corroborates a provider nomination with a structured organization that publishes no site', async () => {
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/4001': () => html(
        '<!doctype html><html><head><title>Open role</title>'
        + `<script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Acme' })}</script></head></html>`,
      ),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: { ...employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'), tenant: 'board-1' },
      credentials: { logoDevToken: LOGO_TOKEN, logoDevImageToken: LOGO_IMAGE_TOKEN }, deps: DEPENDENCIES(fetchImpl),
    });

    expect(diagnostic.pageOrganizations).toEqual([]);
    const winner = diagnostic.decision.scores.find((candidate) => candidate.domain === 'acme.com');
    expect(winner?.signals).toEqual(['jsonld-name', 'logo-dev']);
    expect(diagnostic.decision.outcome).toBe('llm-review');
  });

  it('lets an employer own a platform domain without opening it to anyone else', async () => {
    const fetchImpl = scriptedFetch({
      'https://www.google.com/about/careers/applications/': () => html(
        '<!doctype html><html><head><title>Build for everyone | Google Careers</title>'
        + '<meta property="og:site_name" content="Google"></head></html>',
      ),
    });
    const diagnostic = await diagnoseEmployerIcon({
      seed: {
        canonicalEmployerId: 'google', displayName: 'Google', roleTitle: '',
        applicationUrl: 'https://www.google.com/about/careers/applications/', provider: 'employer-career', sourceId: 'bench:google',
      },
      credentials: {}, deps: DEPENDENCIES(fetchImpl),
    });

    const winner = diagnostic.decision.scores.find((candidate) => candidate.domain === 'google.com');
    expect(winner?.rejected).toBe(false);
    expect(winner?.signals).toEqual(expect.arrayContaining(['final-url', 'page-title']));
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
      seed: employerSeed(''), credentials: { logoDevToken: LOGO_TOKEN, logoDevImageToken: LOGO_IMAGE_TOKEN }, deps: DEPENDENCIES(fetchImpl),
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
      // The page declares another name, so the provider is asked about that too:
      // a clean miss on every query is what makes this an unresolved employer rather
      // than a retry.
      [logoDevSearchUrl('Globex')]: () => status(404),
    });
    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
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
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
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
      environment(db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
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

  it('never publishes a domain the tie-breaker chose when it has no real image', async () => {
    const { database, db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/acme/jobs/4001'), NOW);
    // An ATS page that names the employer and a lone provider nomination: two
    // independent evidence ids, so this is a candidate the model may choose.
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/4001': () => html(
        '<!doctype html><html><head><title>Job Application for Software Engineering Intern at Acme</title></head></html>',
      ),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => status(404),
    });
    const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => {
      const input = JSON.parse(request.prompt.user) as { candidates: Array<{ domain: string; evidenceIds: string[] }> };
      const chosen = input.candidates.find((candidate) => candidate.domain === 'acme.com')!;
      return {
        response: {
          decision: 'accept', officialDomain: 'acme.com', confidence: 0.95,
          evidenceIds: chosen.evidenceIds, reason: 'provider nomination corroborated by the posting page',
        },
        inputTokens: 200, outputTokens: 40, actualCostCents: 1,
      };
    };

    const result = await runEmployerIconResolutionPass(
      environment(db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test' }), NOW,
      { ...DEPENDENCIES(fetchImpl), infer },
    );

    // The verified-image gate applies to a model's choice exactly as it does to a
    // deterministic one, so a plausible answer still cannot publish a broken icon.
    expect(result.resolved).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.reasonCodes).toEqual(['image-unavailable']);
    const context = await icons.context('acme');
    expect(context?.resolutionStatus).toBe('unresolved');
    expect(context?.websiteDomain).toBeUndefined();
    expect(r2.puts).toHaveLength(0);

    // What the model cited is recorded, so an exception reviewer can see the basis
    // for a middle-band decision without replaying the request.
    const row = database.prepare('SELECT evidence_json FROM employer_icon_resolutions WHERE canonical_employer_id = ?')
      .get('acme') as { evidence_json: string };
    const evidence = JSON.parse(row.evidence_json) as { tieBreak?: { citedEvidenceIds?: string[]; inputTokens?: number } };
    expect([...(evidence.tieBreak?.citedEvidenceIds ?? [])].sort())
      .toEqual(['ats-tenant:acme.com', 'logo-dev:acme.com', 'page-title:acme.com', 'platform-name:acme.com']);
    expect(evidence.tieBreak?.inputTokens).toBe(200);
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
      environment(db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
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
      environment(db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, BRANDFETCH_CLIENT_ID: BRANDFETCH_CLIENT }), NOW,
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
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
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
      environment(parts.db, r2.bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
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
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), invalidatedAt,
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
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), reopenedAt, DEPENDENCIES(fetchImpl),
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
    const env = environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN });
    expect((await runEmployerIconResolutionPass(env, NOW, DEPENDENCIES(fetchImpl))).resolved).toBe(1);

    const second = await runEmployerIconResolutionPass(env, NOW, DEPENDENCIES(fetchImpl));
    expect(second.claimed).toBe(0);
    expect(second.resolved).toBe(0);
  });

  it('re-seeds an automatically resolved employer after the revalidation window', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role'), NOW);

    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      'https://acme.com/careers/role-2': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => webp(),
    });
    // No retention license, so the decision is recorded without an R2 icon key:
    // exactly the production state while self-hosting rights are unconfirmed.
    const env = environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN });
    expect((await runEmployerIconResolutionPass(env, NOW, DEPENDENCIES(fetchImpl))).resolved).toBe(1);
    expect((await icons.context('acme'))?.iconKey).toBeUndefined();

    // The resolved task is still live, so nothing is re-seeded inside the window.
    expect(await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role-2'),
      new Date(NOW.getTime() + 24 * 60 * 60 * 1_000))).toBe(false);

    // Once the revalidation deadline passes a fresh admission seeds a new task and the
    // sweep decides again, rather than freezing the automatic answer forever.
    const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1_000);
    expect(await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/role-2'), later)).toBe(true);
    const sweep = await runEmployerIconResolutionPass(env, later, DEPENDENCIES(fetchImpl));
    expect(sweep.claimed).toBe(1);
    expect(sweep.resolved).toBe(1);
  });

  it('does not re-decide a claimable task left under a domain a person confirmed', async () => {
    const { database, db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('freeform', 'Freeform'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      canonicalEmployerId: 'freeform', displayName: 'Freeform', roleTitle: 'Intern',
      applicationUrl: 'https://job-boards.greenhouse.io/freeformfuturecorp/jobs/1',
      provider: 'greenhouse', tenant: 'freeformfuturecorp', sourceId: 'greenhouse:freeformfuturecorp',
    }, NOW);
    await icons.markConfirmed({
      canonicalEmployerId: 'freeform', domain: 'freeformfuture.com', evidenceJson: '{"kind":"confirmed"}',
      revalidateAt: new Date(NOW.getTime() + 86_400_000).toISOString(), now: NOW.toISOString(),
    });
    // An older deploy leaves the seeded task claimable after the confirm. The page would
    // otherwise resolve to a namesake, so the settled decision has to outrank the task.
    database.prepare(`UPDATE employer_icon_resolutions SET status = 'retryable', selected_domain = NULL,
      selected_source = NULL, next_retry_at = ? WHERE canonical_employer_id = 'freeform'`).run(NOW.toISOString());

    const sweep = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW,
      DEPENDENCIES(scriptedFetch({
        'https://job-boards.greenhouse.io/freeformfuturecorp/jobs/1': () => html(
          linkPage({ name: 'Freeform', url: 'https://freeformspaces.com' }),
        ),
        [logoDevImageUrl('freeformspaces.com', LOGO_IMAGE_TOKEN)]: () => webp(),
      })),
    );
    expect(sweep.resolved).toBe(0);
    expect((await icons.context('freeform'))?.websiteDomain).toBe('freeformfuture.com');
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

describe('employer icon official application host', () => {
  it('publishes an official role’s own application host with no provider and no page evidence', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('coinbase', 'Coinbase'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      ...employerSeed('https://www.coinbase.com/careers/positions/1'),
      canonicalEmployerId: 'coinbase', displayName: 'Coinbase', provider: 'structured', tenant: 'board-1',
      provenance: 'official-structured',
    }, NOW);
    // A client-rendered page: it fetches cleanly and names nothing at all.
    const fetchImpl = scriptedFetch({
      'https://www.coinbase.com/careers/positions/1': () => html('<!doctype html><html><head><title>Careers</title></head></html>'),
      [logoDevImageUrl('coinbase.com', LOGO_IMAGE_TOKEN)]: () => webp(),
    });

    const result = await runEmployerIconResolutionPass(environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl));

    expect(result.resolved).toBe(1);
    const context = await icons.context('coinbase');
    expect(context?.websiteDomain).toBe('coinbase.com');
    expect(context?.resolutionStatus).toBe('resolved');
  });

  it('does not promote a community listing’s link to the employer’s own site', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      ...employerSeed('https://some-list.example/roles/1'),
      provenance: 'reviewed-community',
    }, NOW);
    const fetchImpl = scriptedFetch({
      'https://some-list.example/roles/1': () => html('<!doctype html><html><head><title>Open roles</title></head></html>'),
    });

    const result = await runEmployerIconResolutionPass(environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl));

    // A community link may point anywhere, so it stays a monogram rather than
    // publishing a domain the employer may not own.
    expect(result.resolved).toBe(0);
    expect((await icons.context('acme'))?.websiteDomain).toBeUndefined();
  });

  it('retries a provider search on the employer brand when the catalog name finds nothing', async () => {
    const diagnostic = await diagnoseEmployerIcon({
      seed: {
        ...employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'),
        canonicalEmployerId: 'flagship', displayName: 'Flagship Pioneering Co-Op Program', tenant: 'board-1',
      },
      credentials: { logoDevToken: LOGO_TOKEN, logoDevImageToken: LOGO_IMAGE_TOKEN },
      deps: DEPENDENCIES(scriptedFetch({
        'https://job-boards.greenhouse.io/board-1/jobs/1': () => html('<!doctype html><html><head><title>Open roles</title></head></html>'),
        [logoDevSearchUrl('Flagship Pioneering Co-Op Program')]: () => ok([]),
        [logoDevSearchUrl('flagship pioneering')]: () => ok([{ name: 'Flagship Pioneering', domain: 'flagshippioneering.com' }]),
      })),
    });

    // The second query still uses the exact-name rule, so it can only recover a
    // nomination the shorter brand name legitimately matches.
    expect(diagnostic.logoDevDomains).toEqual(['flagshippioneering.com']);
    expect(diagnostic.decision.scores.find((entry) => entry.domain === 'flagshippioneering.com')?.rejected).toBe(false);
  });
});

describe('employer icon platform declarations and proposals', () => {
  const ashbyPage = (website: string, employer: string) => html(
    `<!doctype html><html><head><title>${employer} Jobs</title></head><body>`
    + `<script>window.__appData={"organization":{"publicWebsite":"${website}"}}</script></body></html>`,
  );

  it('resolves an Ashby posting from the site its own board declares, with no provider', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('retell-ai', 'Retell AI'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      ...employerSeed('https://jobs.ashbyhq.com/retell-ai/abc'),
      canonicalEmployerId: 'retell-ai', displayName: 'Retell AI', provider: 'ashby', tenant: 'board-1',
      provenance: 'official-ats',
    }, NOW);
    const fetchImpl = scriptedFetch({
      'https://jobs.ashbyhq.com/retell-ai/abc': () => ashbyPage('https://www.retellai.com/', 'Retell AI'),
      [logoDevImageUrl('retellai.com', LOGO_IMAGE_TOKEN)]: () => webp(),
    });
    const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => {
      const input = JSON.parse(request.prompt.user) as { candidates: Array<{ domain: string; evidenceIds: string[] }> };
      const chosen = input.candidates.find((candidate) => candidate.domain === 'retellai.com')!;
      return {
        response: { decision: 'accept', officialDomain: 'retellai.com', confidence: 0.95,
          evidenceIds: chosen.evidenceIds, reason: 'the board declares this site' },
        inputTokens: 10, outputTokens: 5, actualCostCents: 1,
      };
    };

    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test' }), NOW, { ...DEPENDENCIES(fetchImpl), infer },
    );

    expect(result.resolved).toBe(1);
    expect((await icons.context('retell-ai'))?.websiteDomain).toBe('retellai.com');
  });

  it('publishes a proposed domain only after the domain names the employer itself', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      ...employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'),
      provenance: 'official-ats',
    }, NOW);
    const fetchImpl = scriptedFetch({
      // The posting names nothing and the board does not corroborate the employer.
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html('<!doctype html><html><head><title>Open role</title></head></html>'),
      // The proposed domain answers for itself.
      'https://acme.com/': () => html('<!doctype html><html><head><title>Acme — building things</title></head></html>'),
      [logoDevImageUrl('acme.com', LOGO_IMAGE_TOKEN)]: () => webp(),
    });
    const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => ({
      response: request.schemaName === 'company_icon_domain_proposal'
        ? { domain: 'https://www.acme.com/careers', confidence: 0.95, reason: 'the employer is Acme' }
        : { decision: 'reject', officialDomain: null, confidence: 0, evidenceIds: [], reason: 'nothing to choose' },
      inputTokens: 20, outputTokens: 8, actualCostCents: 1,
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test' }), NOW, { ...DEPENDENCIES(fetchImpl), infer },
    );

    expect(result.resolved).toBe(1);
    const context = await icons.context('acme');
    expect(context?.websiteDomain).toBe('acme.com');
    const row = (subject().database, await icons.reviewQueue(5));
    expect(row).toEqual([]);
  });

  it('discards a proposal the proposed domain itself does not confirm', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      ...employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'),
      provenance: 'official-ats',
    }, NOW);
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html('<!doctype html><html><head><title>Open role</title></head></html>'),
      // A plausible domain that turns out to belong to somebody else entirely.
      'https://acme.com/': () => html('<!doctype html><html><head><title>Industrial Fastener Supply</title></head></html>'),
    });
    const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => ({
      response: request.schemaName === 'company_icon_domain_proposal'
        ? { domain: 'acme.com', confidence: 0.99, reason: 'the obvious domain' }
        : { decision: 'reject', officialDomain: null, confidence: 0, evidenceIds: [], reason: 'nothing to choose' },
      inputTokens: 20, outputTokens: 8, actualCostCents: 1,
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test' }), NOW, { ...DEPENDENCIES(fetchImpl), infer },
    );

    expect(result.resolved).toBe(0);
    const context = await icons.context('acme');
    expect(context?.websiteDomain).toBeUndefined();
    expect(context?.resolutionStatus).toBe('unresolved');
  });

  it('refuses a proposed transport host outright', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      ...employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'),
      provenance: 'official-ats',
    }, NOW);
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html('<!doctype html><html><head><title>Open role</title></head></html>'),
    });
    const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => ({
      response: request.schemaName === 'company_icon_domain_proposal'
        ? { domain: 'greenhouse.io', confidence: 0.99, reason: 'the host in the url' }
        : { decision: 'reject', officialDomain: null, confidence: 0, evidenceIds: [], reason: 'nothing to choose' },
      inputTokens: 20, outputTokens: 8, actualCostCents: 1,
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test' }), NOW, { ...DEPENDENCIES(fetchImpl), infer },
    );

    expect(result.resolved).toBe(0);
    expect((await icons.context('acme'))?.websiteDomain).toBeUndefined();
  });

  it('searches the provider with the name the employer’s board declares', async () => {
    const diagnostic = await diagnoseEmployerIcon({
      seed: {
        ...employerSeed('https://jobs.ashbyhq.com/rivianvw.tech/abc'),
        canonicalEmployerId: 'rivianvw-tech', displayName: 'RV Tech', provider: 'ashby', tenant: 'board-1',
      },
      credentials: { logoDevToken: LOGO_TOKEN, logoDevImageToken: LOGO_IMAGE_TOKEN },
      deps: DEPENDENCIES(scriptedFetch({
        'https://jobs.ashbyhq.com/rivianvw.tech/abc': () => ashbyPage('https://rivianvw.tech/', 'Rivian and Volkswagen Group Technologies'),
        [logoDevSearchUrl('RV Tech')]: () => ok([]),
        [logoDevSearchUrl('Rivian and Volkswagen Group Technologies')]: () =>
          ok([{ name: 'Rivian and Volkswagen Group Technologies', domain: 'rivianvw.tech' }]),
      })),
    });

    // The catalog calls it `RV Tech`; the board knows the company's real name, and
    // that is the query which finds the domain.
    expect(diagnostic.logoDevDomains).toEqual(['rivianvw.tech']);
  });
});

describe('employer icon uploaded board logo', () => {
  const boardLogo = 'https://s101-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/204/510/original/Logo-IMC-Blue.png';

  it('stores an employer’s uploaded logo even when no domain resolves', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    const fetchImpl = scriptedFetch({
      // A posting that names nobody and a board slug that corroborates nobody, so
      // the domain stays undecided — the uploaded logo is the only thing to use.
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
        `<!doctype html><html><head><title>Open role</title><meta property="og:image" content="${boardLogo}"></head></html>`,
      ),
      [boardLogo]: () => new Response(new Uint8Array(64).fill(9), { headers: { 'content-type': 'image/png' } }),
    });

    const result = await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));

    // The icon is stored, and the domain decision is honestly left undecided.
    expect(result.unresolved).toBe(1);
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.contentType).toBe('image/png');
    expect(r2.puts[0]?.key).toMatch(/^company-icons\/acme\/platform-[0-9a-f]{16}\.png$/u);
    const employer = await admission.getCanonicalEmployer('acme');
    expect(employer?.iconKey).toBe(r2.puts[0]?.key);
    expect(employer?.iconSource).toBe('platform');
    expect(employer?.iconKey).toBeDefined();
  });

  it('stores a Lever logo the bucket serves as an opaque byte stream', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const leverLogo = 'https://lever-client-logos.s3-us-west-2.amazonaws.com/b8300af6-1586196845320.png';
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://jobs.lever.co/board-1/abc'), NOW);
    const fetchImpl = scriptedFetch({
      'https://jobs.lever.co/board-1/abc': () => html(
        `<!doctype html><html><head><title>Open role</title><meta property="og:image" content="${leverLogo}"></head></html>`,
      ),
      // No usable content type, but the bytes are a PNG.
      [leverLogo]: () => new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), {
        headers: { 'content-type': 'binary/octet-stream' },
      }),
    });

    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));

    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.contentType).toBe('image/png');
    expect(r2.puts[0]?.key).toMatch(/^company-icons\/acme\/platform-[0-9a-f]{16}\.png$/u);
  });

  it('falls through an Ashby SVG square logo to the raster beside it', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const square = 'https://app.ashbyhq.com/api/images/org-theme-logo/1cea/square.svg';
    const social = 'https://app.ashbyhq.com/api/images/org-theme-social/1cea/social.png';
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://jobs.ashbyhq.com/board-1/abc'), NOW);
    const fetchImpl = scriptedFetch({
      'https://jobs.ashbyhq.com/board-1/abc': () => html(
        `<!doctype html><html><head><title>Open role</title><meta property="og:image" content="${social}"></head><body>`
        + `<script>{"logoSquareImageUrl":"${square}"}</script></body></html>`,
      ),
      [square]: () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } }),
      [social]: () => new Response(new Uint8Array(48).fill(3), { headers: { 'content-type': 'image/png' } }),
    });

    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));

    // The SVG is refused and the raster behind it is used, rather than ending the
    // attempt at the first unusable asset.
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.contentType).toBe('image/png');
  });

  it('withholds a machine-stored icon until the operator leaves observe mode, then serves it', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'observe', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
        `<!doctype html><html><head><title>Open role</title><meta property="og:image" content="${boardLogo}"></head></html>`,
      ),
      [boardLogo]: () => new Response(new Uint8Array(64).fill(9), { headers: { 'content-type': 'image/png' } }),
    });
    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));

    const employers = {
      async getCanonicalEmployer(id: string) { return admission.getCanonicalEmployer(id); },
    };

    // Observe mode withholds the machine icon rather than letting a stored key route
    // around the switch.
    const observed = await companyIconResponse('acme', employers, r2.bucket, {
      automaticDisplay: async () => (await icons.settings()).mode === 'resolve',
    });
    expect(observed.status).toBe(404);

    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    const resolved = await companyIconResponse('acme', employers, r2.bucket, {
      automaticDisplay: async () => (await icons.settings()).mode === 'resolve',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.headers.get('content-type')).toBe('image/png');
  });

  it('stores a Greenhouse board logo the renderer publishes only in its board payload', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const logo = 'https://s4-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/400/377/100/original/Figma-icon-sm.png';
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/acme/jobs/1'), NOW);
    const fetchImpl = scriptedFetch({
      // The current renderer emits an og:image with no value and serializes the
      // board payload escaped inside a script.
      'https://job-boards.greenhouse.io/acme/jobs/1': () => html(
        '<!doctype html><html><head><title>Open role</title><meta property="og:image"/></head><body>'
        + `<script>window.x={"boardConfiguration":{\\"logo\\":{\\"href\\":null,\\"url\\":\\"${logo}\\"}}}</script></body></html>`,
      ),
      [logo]: () => new Response(pngBytes(400, 400), { headers: { 'content-type': 'image/png' } }),
    });

    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));

    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.key).toMatch(/^company-icons\/acme\/platform-[0-9a-f]{16}\.png$/u);
  });

  it('stores a Greenhouse banner only when its own shape is square, and says why', async () => {
    const banner = 'https://s9-recruiting.cdn.greenhouse.io/job_board_renderer/job_board_configurations/banners/400/032/800/original/CareerPageBanner.png';
    const run = async (bytes: Uint8Array<ArrayBuffer>) => {
      const { db, admission, icons } = subject();
      const r2 = r2Stub();
      await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
      await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
      await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/acme/jobs/1'), NOW);
      const fetchImpl = scriptedFetch({
        'https://job-boards.greenhouse.io/acme/jobs/1': () => html(
          `<!doctype html><html><head><title>Open role</title><script>{"banner_url":"${banner}"}</script></head></html>`,
        ),
        [banner]: () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
      });
      await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));
      return { r2 };
    };

    // A 1400×300 careers banner cropped into a square tile is worse than the
    // monogram, so it is refused and the reason is recorded.
    const strip = await run(pngBytes(1400, 300));
    expect(strip.r2.puts).toHaveLength(0);
    const events = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'company_icon_platform_logo_rejected'))
      .toMatchObject({ kind: 'banner', reason: 'banner-not-square' });

    // A banner that is the employer's own mark is stored.
    const square = await run(pngBytes(1200, 900));
    expect(square.r2.puts).toHaveLength(1);
    expect(square.r2.puts[0]?.key).toMatch(/^company-icons\/acme\/platform-[0-9a-f]{16}\.png$/u);
  });

  it('rasterizes a board logo published only as SVG and stores the PNG', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const square = 'https://app.ashbyhq.com/api/images/org-theme-logo/9fde/square.png';
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://jobs.ashbyhq.com/acme/abc'), NOW);
    const fetchImpl = scriptedFetch({
      'https://jobs.ashbyhq.com/acme/abc': () => html(
        `<!doctype html><html><head><title>Open role</title><script>{"logoSquareImageUrl":"${square}"}</script></head></html>`,
      ),
      // Ashby serves an SVG from a `.png` path, and this board publishes nothing else.
      [square]: () => new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#123456"/></svg>',
        { headers: { 'content-type': 'image/svg+xml' } },
      ),
    });

    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, { ...DEPENDENCIES(fetchImpl), rasterizeSvg: RASTERIZE });

    // What is stored is the rendered PNG, never the publisher's document.
    expect(r2.puts).toHaveLength(1);
    expect(r2.puts[0]?.contentType).toBe('image/png');
    expect(r2.puts[0]?.key).toMatch(/^company-icons\/acme\/platform-[0-9a-f]{16}\.png$/u);
    expect(rasterDimensions(r2.puts[0]!.bytes!)).toEqual({ width: 256, height: 256 });
    expect((await admission.getCanonicalEmployer('acme'))?.iconSource).toBe('platform');
    const events = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'company_icon_platform_logo_stored'))
      .toMatchObject({ format: 'image/png', rasterized: true });
  });

  it('refuses an SVG that could fetch or execute, even with a rasterizer', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const square = 'https://app.ashbyhq.com/api/images/org-theme-logo/9fde/square.png';
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://jobs.ashbyhq.com/acme/abc'), NOW);
    const fetchImpl = scriptedFetch({
      'https://jobs.ashbyhq.com/acme/abc': () => html(
        `<!doctype html><html><head><title>Open role</title><script>{"logoSquareImageUrl":"${square}"}</script></head></html>`,
      ),
      [square]: () => new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>fetch("https://evil.test")</script><rect width="64" height="64"/></svg>',
        { headers: { 'content-type': 'image/svg+xml' } },
      ),
    });

    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, { ...DEPENDENCIES(fetchImpl), rasterizeSvg: RASTERIZE });

    expect(r2.puts).toHaveLength(0);
    const events = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'company_icon_platform_logo_rejected'))
      .toMatchObject({ reason: 'svg-unsafe' });
  });

  it('shape-checks a banner after rasterizing it, not by its container', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const banner = 'https://s9-recruiting.cdn.greenhouse.io/job_board_renderer/job_board_configurations/banners/400/032/800/original/CareerPageBanner.svg';
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/acme/jobs/1'), NOW);
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/acme/jobs/1': () => html(
        `<!doctype html><html><head><title>Open role</title><script>{"banner_url":"${banner}"}</script></head></html>`,
      ),
      // The employer's own art, uploaded as SVG, and shaped like a careers strip.
      [banner]: () => new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 300"><rect width="1400" height="300" fill="#eee"/></svg>',
        { headers: { 'content-type': 'image/svg+xml' } },
      ),
    });

    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, { ...DEPENDENCIES(fetchImpl), rasterizeSvg: RASTERIZE });

    expect(r2.puts).toHaveLength(0);
    const events = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'company_icon_platform_logo_rejected'))
      .toMatchObject({ kind: 'banner', reason: 'banner-not-square' });
  });

  it('records an SVG board as its own class when no rasterizer is available', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    const square = 'https://app.ashbyhq.com/api/images/org-theme-logo/9fde/square.png';
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://jobs.ashbyhq.com/acme/abc'), NOW);
    const fetchImpl = scriptedFetch({
      'https://jobs.ashbyhq.com/acme/abc': () => html(
        `<!doctype html><html><head><title>Open role</title><script>{"logoSquareImageUrl":"${square}"}</script></head></html>`,
      ),
      // Ashby answers an SVG from a `.png` path.
      [square]: () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } }),
    });

    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));

    expect(r2.puts).toHaveLength(0);
    const events = vi.mocked(console.log).mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events.find((event) => event.event === 'company_icon_platform_logo_rejected'))
      .toMatchObject({ reason: 'svg-not-servable' });
    expect((await admission.getCanonicalEmployer('acme'))?.iconKey).toBeUndefined();
  });

  it('leaves a reviewer’s icon alone, while a machine icon still lets the domain resolve', async () => {
    const run = async (iconSource: string, iconArrivesAfterQueueing: boolean) => {
      const { database, db, admission, icons } = subject();
      await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
      const setIcon = () => database.prepare("UPDATE canonical_employers SET icon_key = ?, icon_source = ? WHERE id = 'acme'")
        .run('company-icons/acme/existing.webp', iconSource);
      if (!iconArrivesAfterQueueing) await setIcon();
      await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
      await enqueueEmployerIconResolution(icons, { ...employerSeed('https://acme.com/careers/1'), provider: 'structured', provenance: 'official-ats' as const }, NOW);
      if (iconArrivesAfterQueueing) await setIcon();
      return runEmployerIconResolutionPass(
        environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW,
        DEPENDENCIES(scriptedFetch({
          'https://acme.com/careers/1': () => html('<!doctype html><html><head><title>Careers</title></head></html>'),
          [IMAGE_URL]: () => webp(),
        })),
      );
    };

    // A reviewed icon that arrives before the queue exists produces no task at all.
    const reviewedEarly = await run('reviewed', false);
    expect(reviewedEarly.claimed).toBe(0);

    // One that arrives after the task was queued ends it, with nothing overwritten.
    const reviewedLate = await run('reviewed', true);
    expect(reviewedLate.reasonCodes).toEqual(['reviewed-icon-present']);

    // A board logo or a site asset is this resolver's own work, so a re-armed task
    // still decides the employer's domain — which is what `POST …/resolve` needs to be
    // able to do for an employer that already shows its own uploaded mark.
    const platform = await run('platform', true);
    expect(platform.resolved).toBe(1);
    expect(platform.reasonCodes).toEqual(['domain-accepted']);
  });

  it('never overwrites a reviewer’s icon and drops an unusable upload', async () => {
    const { db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme', 'company-icons/acme/reviewed.png'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
        `<!doctype html><html><head><title>Open role</title><meta property="og:image" content="${boardLogo}"></head></html>`,
      ),
    });
    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));

    // A reviewed icon is authoritative, so the upload is not even fetched.
    expect(r2.puts).toHaveLength(0);
    expect((await admission.getCanonicalEmployer('acme'))?.iconKey).toBe('company-icons/acme/reviewed.png');

    // And an upload that is not a usable raster is rejected rather than stored.
    const second = subject();
    await second.admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await second.icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(second.icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    const badR2 = r2Stub();
    const badFetch = scriptedFetch({
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
        `<!doctype html><html><head><title>Open role</title><meta property="og:image" content="${boardLogo}"></head></html>`,
      ),
      [boardLogo]: () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    });
    await runEmployerIconResolutionPass(environment(second.db, badR2.bucket, {}), NOW, DEPENDENCIES(badFetch));
    expect(badR2.puts).toHaveLength(0);
    expect((await second.admission.getCanonicalEmployer('acme'))?.iconKey).toBeUndefined();
  });

  it('withdraws a platform icon when a wrong-icon report arrives', async () => {
    const { database, db, admission, icons } = subject();
    const r2 = r2Stub();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
        `<!doctype html><html><head><title>Open role</title><meta property="og:image" content="${boardLogo}"></head></html>`,
      ),
      [boardLogo]: () => new Response(new Uint8Array(64).fill(9), { headers: { 'content-type': 'image/png' } }),
    });
    await runEmployerIconResolutionPass(environment(db, r2.bucket, {}), NOW, DEPENDENCIES(fetchImpl));
    expect((await admission.getCanonicalEmployer('acme'))?.iconKey).toBeDefined();

    await icons.invalidate('acme', NOW.toISOString(), 'wrong logo');
    const employer = await admission.getCanonicalEmployer('acme');
    expect(employer?.iconKey).toBeUndefined();
    expect(employer?.iconSource).toBeUndefined();
    expect(database.prepare('SELECT icon_resolution_status FROM canonical_employers WHERE id = ?').get('acme'))
      .toMatchObject({ icon_resolution_status: 'invalidated' });
  });
});

describe('employer icon confirm route', () => {
  const confirmRequest = (body: unknown) => new Request('https://api.test/internal/admission/employer-icons/confirm', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const message = async (response: Response) => (await response.json() as { message?: string }).message;

  it('records a verified domain and refuses a transport host or an unverified one', async () => {
    const { admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    const verify = vi.fn(async (domain: string) => domain === 'acme.com');
    const confirm = (body: unknown) => handleEmployerIconOperations(
      confirmRequest(body), icons, () => ({ logoDev: true, brandfetch: true, tieBreaker: true }), () => NOW, verify,
    );

    const transport = await confirm({ canonicalEmployerId: 'acme', domain: 'job-boards.greenhouse.io' });
    expect(transport.status).toBe(409);
    expect(await message(transport)).toContain('ATS');

    const url = await confirm({ canonicalEmployerId: 'acme', domain: 'https://acme.com/careers' });
    expect(url.status).toBe(409);
    expect(await message(url)).toContain('bare hostname');

    // A person may name a domain but never vouch for an icon that does not exist.
    const missing = await confirm({ canonicalEmployerId: 'acme', domain: 'no-logo.test' });
    expect(missing.status).toBe(409);
    expect(await message(missing)).toContain('No real logo');
    expect((await icons.context('acme'))?.websiteDomain).toBeUndefined();

    // A subdomain is confirmed and served as its registrable domain, so the verify
    // call and the later read path agree on exactly one domain.
    const confirmed = await confirm({ canonicalEmployerId: 'acme', domain: 'careers.acme.com' });
    expect(confirmed.status).toBe(200);
    expect(verify).toHaveBeenLastCalledWith('acme.com');
    const context = await icons.context('acme');
    expect(context?.resolutionStatus).toBe('resolved');
    expect(context?.websiteDomain).toBe('acme.com');
  });

  it('forces a fresh decision for an employer a person confirmed', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await icons.markConfirmed({
      canonicalEmployerId: 'acme', domain: 'acme.com', evidenceJson: '{"kind":"confirmed"}',
      revalidateAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString(), now: NOW.toISOString(),
    });
    expect((await icons.context('acme'))?.resolutionStatus).toBe('resolved');

    // The confirmed domain is stale. `POST …/resolve` clears the settled status so the
    // next sweep decides again instead of the confirm being permanent.
    const resolveRequest = new Request('https://api.test/internal/admission/employer-icons/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canonicalEmployerId: 'acme', applicationUrl: 'https://acme.com/careers/role' }),
    });
    const response = await handleEmployerIconOperations(
      resolveRequest, icons, () => ({ logoDev: true, brandfetch: true, tieBreaker: true }), () => NOW,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ enqueued: true });
    expect((await icons.context('acme'))?.resolutionStatus).toBeUndefined();

    const fetchImpl = scriptedFetch({
      'https://acme.com/careers/role': () => html(linkPage({ name: 'Acme', url: 'https://acme.com' })),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      [IMAGE_URL]: () => webp(),
    });
    const sweep = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW,
      DEPENDENCIES(fetchImpl),
    );
    expect(sweep.claimed).toBe(1);
    expect(sweep.resolved).toBe(1);
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
      // The employer's own careers page naming the employer, with no JSON-LD
      // organization: 0.45 + 0.15 stays inside the tie-breaker's band.
      'https://acme.com/careers/role': () => html(
        '<!doctype html><html><head><title>Careers at Acme</title></head></html>',
      ),
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

  it('never re-seeds an employer a person settled before it was ever swept', async () => {
    const { admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('freeform', 'Freeform'), NOW.toISOString());
    await admission.putCanonicalEmployer(employerRow('kirin', 'Kirin'), NOW.toISOString());
    // An operator settles both before any sweep reaches them: `confirm` records the
    // domain, `report-wrong` the withdrawal. Neither writes an employer_icon_resolutions
    // row, so a decision read only from the task list would look undecided and its next
    // sweep could overwrite the confirmed domain — or revive the reported one.
    await icons.markConfirmed({
      canonicalEmployerId: 'freeform', domain: 'freeformfuture.com', evidenceJson: '{"kind":"confirmed"}',
      revalidateAt: new Date(NOW.getTime() + 86_400_000).toISOString(), now: NOW.toISOString(),
    });
    await icons.invalidate('kirin', NOW.toISOString(), 'wrong-icon-report');

    expect(await icons.employersNeedingResolution(10)).toEqual([]);
    // A fresh admission for either employer is not a reason to re-decide them.
    expect(await enqueueEmployerIconResolution(icons, {
      canonicalEmployerId: 'freeform', displayName: 'Freeform', roleTitle: 'Intern',
      applicationUrl: 'https://job-boards.greenhouse.io/freeformfuturecorp/jobs/1',
      provider: 'greenhouse', tenant: 'freeformfuturecorp', sourceId: 'greenhouse:freeformfuturecorp',
    }, NOW)).toBe(false);
    expect(await enqueueEmployerIconResolution(icons, {
      canonicalEmployerId: 'kirin', displayName: 'Kirin', roleTitle: 'Intern',
      applicationUrl: 'https://jobs.ashbyhq.com/kirin/1', provider: 'ashby', sourceId: 'ashby:kirin',
    }, NOW)).toBe(false);
    expect((await icons.context('freeform'))?.websiteDomain).toBe('freeformfuture.com');
  });
});

describe('employer icon resolver correctness fixes', () => {
  it('accepts the publishable token under any documented alias', async () => {
    const run = async (secrets: Record<string, string>) => {
      const { db, admission, icons } = subject();
      const r2 = r2Stub();
      await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
      await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
      await enqueueEmployerIconResolution(icons, {
        ...employerSeed('https://acme.com/careers/1'), provider: 'structured', provenance: 'official-ats',
      }, NOW);
      const result = await runEmployerIconResolutionPass(
        environment(db, r2.bucket, secrets), NOW,
        DEPENDENCIES(scriptedFetch({
          'https://acme.com/careers/1': () => html('<!doctype html><html><head><title>Careers at Acme</title></head></html>'),
          [IMAGE_URL]: () => webp(),
        })),
      );
      return { result, icons };
    };
    // `LOGO_DEV_IMAGE_TOKEN` is the canonical name; the rest are the aliases an operator
    // may already have provisioned, and the image endpoint must accept every one.
    for (const alias of ['LOGO_DEV_IMAGE_TOKEN', 'LOGO_DEV_PUBLISHABLE_KEY', 'LOGO_DEV_PUBLISHABLE_TOKEN', 'LOGO_PUBLISHABLE_KEY']) {
      const { result, icons } = await run({ [alias]: LOGO_IMAGE_TOKEN });
      expect(result.resolved, alias).toBe(1);
      expect((await icons.context('acme'))?.websiteDomain, alias).toBe('acme.com');
    }
  });

  it('makes at most one model call per task even when the accepted domain has no provider image', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    let calls = 0;
    const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => {
      calls += 1;
      const input = JSON.parse(request.prompt.user) as { candidates: Array<{ domain: string; evidenceIds: string[] }> };
      if (request.schemaName === 'company_icon_domain_resolution') {
        const chosen = input.candidates.find((candidate) => candidate.domain === 'acme.com')!;
        return {
          response: { decision: 'accept', officialDomain: 'acme.com', confidence: 0.95,
            evidenceIds: chosen.evidenceIds, reason: 'the provider and the page agree' },
          inputTokens: 10, outputTokens: 5, actualCostCents: 1,
        };
      }
      return {
        response: { assetUrl: 'https://acme.com/logo.png', confidence: 0.9, reason: 'the mark' },
        inputTokens: 12, outputTokens: 6, actualCostCents: 1,
      };
    };
    await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test' }), NOW,
      {
        ...DEPENDENCIES(scriptedFetch({
          'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
            '<!doctype html><html><head><title>Software Engineering Intern at Acme</title></head></html>',
          ),
          [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
          // The domain does not name the employer, so confirmation cannot decide and the
          // tie-break is the task's one call. It has no provider image either.
          'https://acme.com/': () => html('<!doctype html><html><head><title>Domain for sale</title></head></html>'),
          [IMAGE_URL]: () => status(404),
        })),
        infer,
      },
    );
    expect(calls).toBe(1);
  });

  it('records a model-chosen domain as a tie-break decision, not a provider decision', async () => {
    const { database, db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    const infer = async (request: OpenAIJsonRequest): Promise<OpenAIJsonResult> => {
      const input = JSON.parse(request.prompt.user) as { candidates: Array<{ domain: string; evidenceIds: string[] }> };
      const chosen = input.candidates.find((candidate) => candidate.domain === 'acme.com')!;
      return {
        response: { decision: 'accept', officialDomain: 'acme.com', confidence: 0.95,
          evidenceIds: chosen.evidenceIds, reason: 'the provider and the page agree' },
        inputTokens: 10, outputTokens: 5, actualCostCents: 1,
      };
    };
    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test' }), NOW,
      {
        ...DEPENDENCIES(scriptedFetch({
          'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
            '<!doctype html><html><head><title>Software Engineering Intern at Acme</title></head></html>',
          ),
          [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
          'https://acme.com/': () => html('<!doctype html><html><head><title>Domain for sale</title></head></html>'),
          [IMAGE_URL]: () => webp(),
        })),
        infer,
      },
    );
    expect(result.resolved).toBe(1);
    const row = database.prepare(
      "SELECT selected_source, selected_domain FROM employer_icon_resolutions WHERE canonical_employer_id = 'acme'",
    ).get() as { selected_source: string; selected_domain: string };
    expect(row).toEqual({ selected_source: 'tie-break', selected_domain: 'acme.com' });
  });

  it('bills the employer for an asset call the model answered but the asset fetch failed', async () => {
    const { database, db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    let calls = 0;
    const infer = async (): Promise<OpenAIJsonResult> => {
      calls += 1;
      return {
        response: { assetUrl: 'https://acme.com/logo.png', confidence: 0.9, reason: 'the mark' },
        inputTokens: 12, outputTokens: 6, actualCostCents: 1,
      };
    };
    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, {
        LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN,
        BRANDFETCH_CLIENT_ID: BRANDFETCH_CLIENT, OPENAI_KEY: 'sk-test',
      }), NOW,
      {
        ...DEPENDENCIES(scriptedFetch({
          'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
            '<!doctype html><html><head><title>Software Engineering Intern at Acme</title></head></html>',
          ),
          // Consensus resolves the domain with no model call; the provider has no image,
          // so the asset pick is the one call, and the asset it names 404s.
          [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
          [brandfetchSearchUrl('Acme', BRANDFETCH_CLIENT)]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
          'https://acme.com/': () => html('<!doctype html><html><head><title>Acme</title></head></html>'),
          [IMAGE_URL]: () => status(404),
          'https://acme.com/logo.png': () => status(404),
        })),
        infer,
      },
    );
    expect(calls).toBe(1);
    expect(result.resolved).toBe(0);
    const tokens = database.prepare(
      "SELECT icon_tie_break_input_tokens AS input FROM canonical_employers WHERE id = 'acme'",
    ).get() as { input: number };
    expect(tokens.input).toBe(12);
  });

  it('backs off instead of retrying at once when a model call fails', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://job-boards.greenhouse.io/board-1/jobs/1'), NOW);
    const infer = async (): Promise<OpenAIJsonResult> => { throw new Error('openai unavailable'); };
    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/board-1/jobs/1': () => html(
        '<!doctype html><html><head><title>Software Engineering Intern at Acme</title></head></html>',
      ),
      [logoDevSearchUrl('Acme')]: () => ok([{ name: 'Acme', domain: 'acme.com' }]),
      'https://acme.com/': () => html('<!doctype html><html><head><title>Domain for sale</title></head></html>'),
      [IMAGE_URL]: () => webp(),
    });
    const env = environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, OPENAI_KEY: 'sk-test' });

    const first = await runEmployerIconResolutionPass(env, NOW, { ...DEPENDENCIES(fetchImpl), infer });
    expect(first.reasonCodes).toContain('model-call-failed');
    // The failure schedules a retry in the future, so the same instant cannot claim it again.
    const second = await runEmployerIconResolutionPass(env, NOW, { ...DEPENDENCIES(fetchImpl), infer });
    expect(second.claimed).toBe(0);
  });

  it('keeps a task dropped for an existing reviewer icon out of the exception queue', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('acme', 'Acme'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, employerSeed('https://acme.com/careers/1'), NOW);
    // A reviewer uploads an icon after the task was already queued.
    await admission.putCanonicalEmployer(
      employerRow('acme', 'Acme', 'company-icons/acme/reviewed.webp'), NOW.toISOString(),
    );

    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, {}), NOW, DEPENDENCIES(scriptedFetch({})),
    );
    expect(result.reasonCodes).toContain('reviewed-icon-present');
    // A terminal drop is not an exception waiting for a person.
    expect(await icons.reviewQueue(10)).toEqual([]);
  });
});

describe('employer declared-site precedence', () => {
  it('publishes the site the employer’s Greenhouse board links over a provider namesake', async () => {
    const { db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('figureai', 'Figure'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    await enqueueEmployerIconResolution(icons, {
      ...employerSeed('https://job-boards.greenhouse.io/figureai/jobs/1'),
      canonicalEmployerId: 'figureai', displayName: 'Figure', provider: 'greenhouse',
      tenant: 'figureai', sourceId: 'greenhouse:figureai',
    }, NOW);
    const fetchImpl = scriptedFetch({
      // The board links the employer's real site beside a null CDN image, as Greenhouse
      // serializes it escaped inside the board payload.
      'https://job-boards.greenhouse.io/figureai/jobs/1': () => html(
        '<!doctype html><html><head><title>Electrical Engineering Intern at Figure</title><script>'
        + '\\"logo\\":{\\"href\\":\\"https://www.figure.ai\\",\\"url\\":null}'
        + '</script></head></html>',
      ),
      // Both providers agree, wrongly, on the unrelated lending company.
      [logoDevSearchUrl('Figure')]: () => ok([{ name: 'Figure', domain: 'figure.com' }]),
      [brandfetchSearchUrl('Figure', BRANDFETCH_CLIENT)]: () => ok([{ name: 'Figure', domain: 'figure.com' }]),
      [logoDevImageUrl('figure.ai', LOGO_IMAGE_TOKEN)]: () => webp(),
      [IMAGE_URL]: () => status(404),
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, {
        LOGO_DEV_TOKEN: LOGO_TOKEN, LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN, BRANDFETCH_CLIENT_ID: BRANDFETCH_CLIENT,
      }), NOW,
      DEPENDENCIES(fetchImpl),
    );

    expect(result.resolved).toBe(1);
    expect((await icons.context('figureai'))?.websiteDomain).toBe('figure.ai');
  });
});

describe('employer icon backfill', () => {
  it('carries the employer’s own posting link so a backfilled employer resolves from its board', async () => {
    const { database, db, admission, icons } = subject();
    await admission.putCanonicalEmployer(employerRow('aevex', 'AEVEX'), NOW.toISOString());
    await icons.putSettings({ mode: 'resolve', maxPerSweep: 5 }, NOW.toISOString());
    // No task row: the employer existed before the resolver. Its live posting does.
    database.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, 'internship', ?)")
      .run('aevex-posting', 'posting', JSON.stringify({
        normalizedUrl: 'https://job-boards.greenhouse.io/aevexaerospace/jobs/5415815008',
        title: 'Robotics Engineering Co-op',
        admission: { destination: { provider: 'greenhouse' } },
        sourceReferences: [{ sourceId: 'greenhouse-aevexaerospace', provenance: 'official-ats' }],
        internshipIdentity: { company: { canonicalId: 'aevex' } },
      }));

    const fetchImpl = scriptedFetch({
      'https://job-boards.greenhouse.io/aevexaerospace/jobs/5415815008': () => html(
        '<!doctype html><html><head><title>Robotics Engineering Co-op at AEVEX</title><script>'
        + '\\"logo\\":{\\"href\\":\\"https://aevex.com\\",\\"url\\":null}'
        + '</script></head></html>',
      ),
      [logoDevImageUrl('aevex.com', LOGO_IMAGE_TOKEN)]: () => webp(),
      [IMAGE_URL]: () => status(404),
    });

    const result = await runEmployerIconResolutionPass(
      environment(db, r2Stub().bucket, { LOGO_DEV_IMAGE_TOKEN: LOGO_IMAGE_TOKEN }), NOW, DEPENDENCIES(fetchImpl),
    );

    // The backfill seeded it with the real link and the same pass resolved it.
    expect(result.backfilled).toBe(1);
    expect(result.resolved).toBe(1);
    expect((await icons.context('aevex'))?.websiteDomain).toBe('aevex.com');
  });
});
