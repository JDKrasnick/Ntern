import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { GITHUB_RESOLUTION_ROWS_PER_DELIVERY, IngestionRunner } from '../src/poll.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import { SourceFetchError } from '../src/sources/source-error.js';
import type { SourceOccurrenceState } from '../src/types.js';
import {
  PRODUCTION_GITHUB_DOCUMENT,
  PRODUCTION_GITHUB_FEEDS,
  PRODUCTION_GITHUB_OCCURRENCES,
  syntheticMarkdownTable,
  syntheticOccurrences,
} from './fixtures/production-scale.js';

/**
 * Resource budgets for one ingestion queue message. `wrangler.ingestion.jsonc`
 * allows 30 s of CPU and the isolate holds 128 MB, so each budget keeps at
 * least 3× margin over the post-fix measurements recorded in
 * `docs/197-ingestion-resource-bounds.md` while still failing on a
 * reintroduced quadratic parse or whole-board retention.
 */
const PARSE_CPU_BUDGET_MS = 1_000;
const MESSAGE_CPU_BUDGET_MS = 9_000;
/**
 * Heap a delivery may retain, measured as growth over the run's own baseline:
 * the harness keeps the production-shaped catalog (25 MB of occurrences and the
 * source documents) live for the whole pass, while the platform gives each
 * invocation a fresh heap. `MESSAGE_HEAP_CEILING_MB` is the absolute guard: it
 * stays 16 MB below the 128 MB isolate.
 */
const MESSAGE_HEAP_BUDGET_MB = 96;
const MESSAGE_HEAP_CEILING_MB = 112;

/** `--expose-gc` is required for a stable heap sample; `npm run test:budget` sets it. */
const exposeGc = globalThis.gc;
const sourceId = 'simplify-summer-2026';
const migrations = ['0001_initial.sql', '0007_catalog_admission.sql', '0008_catalog_admission_occurrence_repair.sql',
  '0010_posting_identity.sql', '0012_destination_verification_schedule.sql', '0015_role_metadata_enrichment.sql',
  '0016_role_metadata_repair_plans.sql', '0017_metadata_acquisition.sql', '0018_metadata_review.sql', '0019_metadata_job_review_revision.sql',
  '0036_posting_withdrawal_reviews.sql'];

/**
 * One connection backs every call, so statements are serialized: a synchronous
 * driver cannot interleave the 24 concurrent workers a real D1 service handles,
 * and a nested `BEGIN` would abort the delivery under test.
 */
function sqliteD1(database: DatabaseSync): D1Database {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => T): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const executors = new WeakMap<object, () => { meta: { changes: number } }>();
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => {
    const run = () => {
      const result = database.prepare(query).run(...values);
      return { meta: { changes: Number(result.changes) } };
    };
    const statement: D1PreparedStatement = {
      bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
      async first<T>() { return exclusive(() => (database.prepare(query).get(...values) as T | undefined) ?? null); },
      async all<T>() {
        return exclusive(() => ({ results: database.prepare(query).all(...values) as T[] }));
      },
      async run() { return exclusive(run); },
    };
    executors.set(statement, run);
    return statement;
  };
  return {
    prepare: (query) => prepared(query),
    batch(statements) {
      return exclusive(() => {
        database.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) {
            const execute = executors.get(statement);
            if (!execute) throw new Error('batch received a statement this adapter did not create');
            results.push(execute());
          }
          database.exec('COMMIT');
          return results;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      });
    },
  };
}

function catalog(): { database: DatabaseSync; store: D1InternshipStore } {
  const database = new DatabaseSync(':memory:');
  for (const migration of migrations) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { database, store: new D1InternshipStore(sqliteD1(database)) };
}

/** The expression `htmlTables` used before the line index: the regression reference. */
function sliceRowNumbers(markdown: string): number[] {
  const rows: number[] = [];
  for (const table of markdown.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const tableRows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const headerAt = tableRows.findIndex((row) => /<th\b/i.test(row[1]));
    if (headerAt < 0) continue;
    const headers = [...tableRows[headerAt][1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
    for (const row of tableRows.slice(headerAt + 1)) {
      const cells = [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)];
      if (cells.length !== headers.length) continue;
      rows.push(markdown.slice(0, (table.index ?? 0) + (row.index ?? 0)).split('\n').length);
    }
  }
  return rows;
}

function cpuMsSince(start: NodeJS.CpuUsage): number {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1_000;
}

/** Seeds a catalog whose largest source is the production GitHub shape. */
async function seedLargestSource(store: D1InternshipStore) {
  const occurrences = syntheticOccurrences({
    rows: PRODUCTION_GITHUB_OCCURRENCES,
    bytesPerRow: Math.ceil(24_900_000 / PRODUCTION_GITHUB_OCCURRENCES),
    sourceId,
  });
  const occurrenceBytes = occurrences.reduce((total, row) => total + JSON.stringify(row).length, 0);
  expect(occurrenceBytes).toBeGreaterThan(20_000_000);
  for (const occurrence of occurrences) {
    await store.putInternship({
      jobId: occurrence.jobId, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: occurrence.occurrence.applyUrl, normalizedUrl: occurrence.occurrence.applyUrl, fingerprint: `fingerprint-${occurrence.externalId}`,
      compensation: { raw: '' }, sourceReferences: [occurrence.occurrence], technical: true, open: true,
      firstSeenAt: '2026-09-09T00:00:00.000Z', catalogVisibleAt: '2026-09-09T00:00:00.000Z', lastSeenAt: '2026-09-09T00:00:00.000Z',
      notification: { smsPending: false, digestPending: false },
    });
    await store.putSourceOccurrence(occurrence);
  }
  await store.putCheckpoint({ sourceId, successfulFetches: 4, lastSuccessAt: '2026-09-09T00:00:00.000Z' });
}

/** The measured source serves two documents (`README.md`, `README-Off-Season.md`). */
function productionDocuments(feed: (typeof PRODUCTION_GITHUB_FEEDS)[keyof typeof PRODUCTION_GITHUB_FEEDS]): Record<string, string> {
  const firstRows = Math.ceil(feed.rawRows / 2);
  const secondRows = feed.rawRows - firstRows;
  const firstEligibleRows = Math.min(feed.eligibleRows, firstRows);
  const bytesPerRow = Math.ceil(feed.bytes / feed.rawRows);
  return {
    'README.md': syntheticMarkdownTable({ rows: firstRows, bytesPerRow, format: 'gfm', technicalRows: firstEligibleRows }),
    'README-Off-Season.md': syntheticMarkdownTable({ rows: secondRows, bytesPerRow, format: 'html', technicalRows: feed.eligibleRows - firstEligibleRows }),
  };
}

function productionAdapter(id: string, documents: Record<string, string>) {
  return new GitHubMarkdownAdapter({
    id, owner: 'acme', repo: 'internships',
    documents: [{ path: 'README.md', branch: 'dev', season: 'summer-2027' }, { path: 'README-Off-Season.md', branch: 'dev', season: 'offseason-2027' }],
    fetchImpl: (async (input: string | URL | Request) => {
      const path = String(input).split('/').pop()!;
      const body = documents[path];
      if (!body) throw new SourceFetchError(`${id}: unexpected path ${path}`, 'transport');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch,
  });
}

describe('ingestion resource budgets', () => {
  it('fetches every current community feed and the growth case at its measured raw, eligible, and byte shape', async () => {
    for (const [name, feed] of Object.entries(PRODUCTION_GITHUB_FEEDS)) {
      const documents = productionDocuments(feed);
      const sourceBytes = Object.values(documents).reduce((total, document) => total + document.length, 0);
      const fetched = await productionAdapter(`production-${name}`, documents).fetch();

      expect(sourceBytes, name).toBeGreaterThan(feed.bytes * 0.9);
      expect(fetched.rawRowCount, name).toBe(feed.rawRows);
      expect(fetched.listings, name).toHaveLength(feed.eligibleRows);
    }
  }, 30_000);

  it('parses a production-sized HTML table document under the parse budget with unchanged row numbers', () => {
    const bytesPerRow = Math.floor(PRODUCTION_GITHUB_DOCUMENT.bytes / PRODUCTION_GITHUB_DOCUMENT.htmlRows);
    const document = syntheticMarkdownTable({ rows: PRODUCTION_GITHUB_DOCUMENT.htmlRows, bytesPerRow, format: 'html' });
    expect(document.length).toBeGreaterThan(PRODUCTION_GITHUB_DOCUMENT.bytes * 0.9);

    const started = process.cpuUsage();
    const listings = parseInternshipMarkdown(document, {
      sourceId, document: 'README-Off-Season.md',
      sourceUrl: 'https://raw.githubusercontent.com/acme/internships/dev/README-Off-Season.md', season: 'offseason-2027',
    });
    const parseCpuMs = cpuMsSince(started);

    expect(listings).toHaveLength(PRODUCTION_GITHUB_DOCUMENT.htmlRows);
    // Row numbers are observable diagnostics, so the linear index must map
    // every row exactly as the previous prefix-slice expression did.
    expect(listings.map((listing) => listing.row)).toEqual(sliceRowNumbers(document));
    expect(parseCpuMs).toBeLessThan(PARSE_CPU_BUDGET_MS);
  }, 120_000);

  it('resolves consecutive production-sized GitHub slices inside the per-message CPU, heap, and slice budgets', async () => {
    const { store } = catalog();
    const feed = PRODUCTION_GITHUB_FEEDS.simplify;
    const documents = productionDocuments(feed);
    const sourceBytes = Object.values(documents).reduce((total, document) => total + document.length, 0);
    expect(sourceBytes).toBeGreaterThan(feed.bytes * 0.9);
    await seedLargestSource(store);

    const runner = new IngestionRunner([productionAdapter(sourceId, documents)], store, () => new Date('2026-09-16T00:00:00.000Z'), undefined, undefined, false);
    exposeGc?.();
    const baselineMb = process.memoryUsage().heapUsed / (1024 * 1024);
    const deliveries: Array<{ cpuMs: number; heapMb: number; peakMb: number; resolved: number }> = [];
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const before = (await store.getCheckpoint(sourceId))?.pendingResolutionRows?.length ?? 0;
      const started = process.cpuUsage();
      const report = await runner.run({ maxListingsPerSourceRun: GITHUB_RESOLUTION_ROWS_PER_DELIVERY });
      const cpuMs = cpuMsSince(started);
      exposeGc?.();
      const peakMb = process.memoryUsage().heapUsed / (1024 * 1024);
      const after = (await store.getCheckpoint(sourceId))?.pendingResolutionRows?.length ?? 0;

      expect(report.failures).toEqual([]);
      const unresolvedBefore = before || feed.rawRows;
      expect(unresolvedBefore - after).toBe(GITHUB_RESOLUTION_ROWS_PER_DELIVERY);
      expect(after).toBeLessThan(unresolvedBefore);
      expect(report.pendingResolution[sourceId] ?? 0).toBe(after);
      expect(report.continuationSources).toContain(sourceId);
      deliveries.push({ cpuMs, heapMb: peakMb - baselineMb, peakMb, resolved: unresolvedBefore - after });
    }

    expect(deliveries.map(({ resolved }) => resolved)).toEqual([GITHUB_RESOLUTION_ROWS_PER_DELIVERY, GITHUB_RESOLUTION_ROWS_PER_DELIVERY]);
    for (const delivery of deliveries) {
      expect(delivery.cpuMs).toBeLessThan(MESSAGE_CPU_BUDGET_MS);
      if (exposeGc) {
        expect(delivery.heapMb).toBeLessThan(MESSAGE_HEAP_BUDGET_MB);
        expect(delivery.peakMb).toBeLessThan(MESSAGE_HEAP_CEILING_MB);
      }
    }
  }, 300_000);

  it('reads one occurrence of a production-sized source by key', async () => {
    const { database, store } = catalog();
    const occurrences = syntheticOccurrences({ rows: PRODUCTION_GITHUB_OCCURRENCES, bytesPerRow: 400, sourceId });
    for (const occurrence of occurrences) await store.putSourceOccurrence(occurrence);

    const paged = new D1InternshipStore(sqliteD1(database));
    const read = await paged.getSourceOccurrences(sourceId);
    const unpaged = database.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk LIKE 'OCCURRENCE#%'")
      .all(`SOURCE#${sourceId}`) as Array<{ value: string }>;
    expect(read).toEqual(unpaged.map((row) => JSON.parse(row.value) as SourceOccurrenceState));
    expect(read).toHaveLength(PRODUCTION_GITHUB_OCCURRENCES);

    // The targeted read replaces loading (and filtering) every occurrence of a
    // large source to answer for one row.
    const target = read[PRODUCTION_GITHUB_OCCURRENCES - 1]!;
    expect(await paged.getSourceOccurrence(sourceId, target.externalId)).toEqual(target);
    expect(await paged.getSourceOccurrence(sourceId, 'absent')).toBeUndefined();
  }, 120_000);
});
