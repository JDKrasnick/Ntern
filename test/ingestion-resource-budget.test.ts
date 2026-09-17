import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { D1TrafficController } from '../cloudflare/d1-traffic-controller.js';
import { observeCatalogDelivery } from '../cloudflare/d1-traffic-observation.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { parseInternshipMarkdown } from '../src/core/markdown.js';
import { GITHUB_RESOLUTION_ROWS_PER_DELIVERY, IngestionRunner } from '../src/poll.js';
import { GitHubMarkdownAdapter } from '../src/sources/github.js';
import { SourceFetchError } from '../src/sources/source-error.js';
import type { SourceOccurrenceState } from '../src/types.js';
import {
  PRODUCTION_GITHUB_DOCUMENT,
  PRODUCTION_GITHUB_OCCURRENCES,
  PRODUCTION_GITHUB_SOURCE_ROWS,
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
  '0016_role_metadata_repair_plans.sql', '0017_metadata_acquisition.sql', '0018_metadata_review.sql', '0019_metadata_job_review_revision.sql'];

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

function observationController() {
  const values = new Map<string, unknown>();
  const controller = new D1TrafficController({ storage: {
    get: async <T>(key: string) => values.has(key) ? structuredClone(values.get(key)) as T : undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
  } });
  return {
    controller,
    namespace: {
      idFromName: () => 'catalog-ingestion',
      get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => controller.fetch(input instanceof Request ? input : new Request(input, init)) }),
    },
  };
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
function productionDocuments(): Record<string, string> {
  return {
    'README.md': syntheticMarkdownTable({ rows: 1_785, bytesPerRow: 605, format: 'gfm' }),
    'README-Off-Season.md': syntheticMarkdownTable({ rows: PRODUCTION_GITHUB_SOURCE_ROWS - 1_785, bytesPerRow: 1_320, format: 'html' }),
  };
}

function productionAdapter(documents: Record<string, string>) {
  return new GitHubMarkdownAdapter({
    id: sourceId, owner: 'acme', repo: 'internships',
    documents: [{ path: 'README.md', branch: 'dev', season: 'summer-2027' }, { path: 'README-Off-Season.md', branch: 'dev', season: 'offseason-2027' }],
    fetchImpl: (async (input: string | URL | Request) => {
      const path = String(input).split('/').pop()!;
      const body = documents[path];
      if (!body) throw new SourceFetchError(`${sourceId}: unexpected path ${path}`, 'transport');
      return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch,
  });
}

describe('ingestion resource budgets', () => {
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

  it('resolves a production-sized GitHub source inside the per-message CPU, heap, and slice budgets', async () => {
    const { store } = catalog();
    const documents = productionDocuments();
    // The measured source serves 2.73 MB across its two documents.
    const sourceBytes = Object.values(documents).reduce((total, document) => total + document.length, 0);
    expect(sourceBytes).toBeGreaterThan(PRODUCTION_GITHUB_DOCUMENT.bytes);
    await seedLargestSource(store);

    const runner = new IngestionRunner([productionAdapter(documents)], store, () => new Date('2026-09-16T00:00:00.000Z'), undefined, undefined, false);
    const expectedSlices: number[] = [];
    for (let remaining = PRODUCTION_GITHUB_SOURCE_ROWS; remaining > 0; remaining -= GITHUB_RESOLUTION_ROWS_PER_DELIVERY) {
      expectedSlices.push(Math.min(GITHUB_RESOLUTION_ROWS_PER_DELIVERY, remaining));
    }
    exposeGc?.();
    const baselineMb = process.memoryUsage().heapUsed / (1024 * 1024);
    const deliveries: Array<{ cpuMs: number; heapMb: number; peakMb: number; resolved: number }> = [];
    for (let delivery = 0; delivery < expectedSlices.length; delivery += 1) {
      const before = (await store.getCheckpoint(sourceId))?.pendingResolutionRows?.length ?? 0;
      const started = process.cpuUsage();
      const report = await runner.run({ maxListingsPerSourceRun: GITHUB_RESOLUTION_ROWS_PER_DELIVERY });
      const cpuMs = cpuMsSince(started);
      exposeGc?.();
      const peakMb = process.memoryUsage().heapUsed / (1024 * 1024);
      const after = (await store.getCheckpoint(sourceId))?.pendingResolutionRows?.length ?? 0;

      expect(report.failures).toEqual([]);
      // A pass slice never exceeds the configured rows per delivery, always
      // drains, and reports its own continuation while rows remain.
      expect((before || PRODUCTION_GITHUB_SOURCE_ROWS) - after).toBeLessThanOrEqual(GITHUB_RESOLUTION_ROWS_PER_DELIVERY);
      expect(after).toBeLessThan(before || PRODUCTION_GITHUB_SOURCE_ROWS);
      expect(report.pendingResolution[sourceId] ?? 0).toBe(after);
      if (after > 0) expect(report.continuationSources).toContain(sourceId);
      deliveries.push({ cpuMs, heapMb: peakMb - baselineMb, peakMb, resolved: (before || PRODUCTION_GITHUB_SOURCE_ROWS) - after });
    }

    // Every delivery resolves exactly the configured slice, and the tail that
    // also reconciles omissions and closures is the last one.
    expect(deliveries.map(({ resolved }) => resolved)).toEqual(expectedSlices);
    expect(expectedSlices.length).toBe(Math.ceil(PRODUCTION_GITHUB_SOURCE_ROWS / GITHUB_RESOLUTION_ROWS_PER_DELIVERY));
    for (const delivery of deliveries) {
      expect(delivery.cpuMs).toBeLessThan(MESSAGE_CPU_BUDGET_MS);
      if (exposeGc) {
        expect(delivery.heapMb).toBeLessThan(MESSAGE_HEAP_BUDGET_MB);
        expect(delivery.peakMb).toBeLessThan(MESSAGE_HEAP_CEILING_MB);
      }
    }
  }, 300_000);

  it('keeps regular, heavy, and super-heavy production-shaped job input resumable while observing every delivery', async () => {
    const { store } = catalog();
    const documents = productionDocuments();
    await seedLargestSource(store);
    const runner = new IngestionRunner([productionAdapter(documents)], store, () => new Date('2026-09-16T00:00:00.000Z'), undefined, undefined, false);
    const { controller, namespace } = observationController();
    const checkpoints = new Map([[1, 'regular'], [10, 'heavy'], [Math.ceil(PRODUCTION_GITHUB_SOURCE_ROWS / GITHUB_RESOLUTION_ROWS_PER_DELIVERY), 'super-heavy']]);
    const summaries: Array<{ scenario: string; deliveries: number; resolved: number; maxCpuMs: number; controller: unknown }> = [];
    let resolved = 0;
    let maxCpuMs = 0;
    const log = console.log;
    console.log = () => undefined;
    try {
      for (let delivery = 1; delivery <= Math.ceil(PRODUCTION_GITHUB_SOURCE_ROWS / GITHUB_RESOLUTION_ROWS_PER_DELIVERY); delivery += 1) {
        const observation = await observeCatalogDelivery({ controller: namespace, provider: 'github', queue: 'intern-notifs-github', messageId: `stress-${delivery}` });
        const before = (await store.getCheckpoint(sourceId))?.pendingResolutionRows?.length ?? PRODUCTION_GITHUB_SOURCE_ROWS;
        const started = process.cpuUsage();
        const report = await runner.run({ maxListingsPerSourceRun: GITHUB_RESOLUTION_ROWS_PER_DELIVERY });
        const cpuMs = cpuMsSince(started);
        const after = (await store.getCheckpoint(sourceId))?.pendingResolutionRows?.length ?? 0;
        await observation?.complete('success');
        expect(report.failures).toEqual([]);
        expect(before - after).toBeLessThanOrEqual(GITHUB_RESOLUTION_ROWS_PER_DELIVERY);
        expect(before - after).toBeGreaterThan(0);
        expect(cpuMs).toBeLessThan(MESSAGE_CPU_BUDGET_MS);
        resolved += before - after;
        maxCpuMs = Math.max(maxCpuMs, cpuMs);
        const scenario = checkpoints.get(delivery);
        if (scenario) summaries.push({ scenario, deliveries: delivery, resolved, maxCpuMs, controller: await controller.status() });
      }
    } finally {
      console.log = log;
    }
    expect(summaries).toEqual([
      expect.objectContaining({ scenario: 'regular', deliveries: 1, resolved: 100, controller: expect.objectContaining({ mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 } }) }),
      expect.objectContaining({ scenario: 'heavy', deliveries: 10, resolved: 1_000, controller: expect.objectContaining({ mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 } }) }),
      expect.objectContaining({ scenario: 'super-heavy', deliveries: 31, resolved: PRODUCTION_GITHUB_SOURCE_ROWS, controller: expect.objectContaining({ mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 } }) }),
    ]);
    console.log(JSON.stringify({ event: 'd1_traffic_ingestion_stress_summary', scenarios: summaries }));
  }, 300_000);

  it('keeps a super-heavy mixed input idempotent when malformed rows and repeated jobs arrive', async () => {
    const { store } = catalog();
    await seedLargestSource(store);
    const documents = productionDocuments();
    const repeated = '| Acme 0 | Software Engineering Intern | Remote | [Apply](https://careers-a.example.test/board/role-0) | repeated |';
    documents['README.md'] = `${documents['README.md'].trimEnd()}\n${[
      repeated,
      repeated,
      '| Missing link | Software Engineering Intern | Remote | Apply later |',
      'this is deliberately not a table row',
    ].join('\n')}\n`;
    documents['README-Off-Season.md'] += '\n| Company | Role | Location | Apply |\n| --- | --- | --- | --- |\n'
      + '| Aggregator | Software Engineering Intern | Remote | [Apply](https://www.indeed.com/viewjob?jk=stress) |\n';
    const adapter = productionAdapter(documents);
    const runner = new IngestionRunner([adapter], store, () => new Date('2026-09-16T00:00:00.000Z'), undefined, undefined, false);
    const { controller, namespace } = observationController();
    const log = console.log;
    const cpuSamples: number[] = [];
    console.log = () => undefined;
    try {
      for (let delivery = 1; delivery <= Math.ceil(PRODUCTION_GITHUB_SOURCE_ROWS / GITHUB_RESOLUTION_ROWS_PER_DELIVERY); delivery += 1) {
        const observation = await observeCatalogDelivery({ controller: namespace, provider: 'github', queue: 'intern-notifs-github', messageId: `mixed-${delivery}` });
        const started = process.cpuUsage();
        const report = await runner.run({ maxListingsPerSourceRun: GITHUB_RESOLUTION_ROWS_PER_DELIVERY });
        cpuSamples.push(cpuMsSince(started));
        await observation?.complete(report.failures.length ? 'failure' : 'success');
        expect(report.failures).toEqual([]);
      }
      const replayObservation = await observeCatalogDelivery({ controller: namespace, provider: 'github', queue: 'intern-notifs-github', messageId: 'mixed-replay' });
      const replay = await runner.run({ maxListingsPerSourceRun: GITHUB_RESOLUTION_ROWS_PER_DELIVERY });
      await replayObservation?.complete(replay.failures.length ? 'failure' : 'success');
      expect(replay.failures).toEqual([]);
      expect(replay.newJobs).toEqual([]);
    } finally {
      console.log = log;
    }
    const fetched = await adapter.fetch(await store.getCheckpoint(sourceId));
    expect(fetched.rawRowCount).toBe(PRODUCTION_GITHUB_SOURCE_ROWS + 3);
    expect(fetched.listings).toHaveLength(PRODUCTION_GITHUB_SOURCE_ROWS);
    expect(fetched.trustedCommunityDiagnostics).toEqual(expect.objectContaining({ duplicateOccurrenceIds: 2, rejectedAggregatorRows: 1 }));
    expect(Math.max(...cpuSamples)).toBeLessThan(MESSAGE_CPU_BUDGET_MS);
    expect(await controller.status()).toEqual(expect.objectContaining({ permitsInUse: { P0: 0, P1: 0, P2: 0 } }));
    console.log(JSON.stringify({ event: 'd1_traffic_ingestion_edge_stress_summary', deliveries: cpuSamples.length,
      maxCpuMs: Math.max(...cpuSamples), malformedRowsDropped: 1, duplicateRowsDropped: 2, aggregatorRowsRejected: 1 }));
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
