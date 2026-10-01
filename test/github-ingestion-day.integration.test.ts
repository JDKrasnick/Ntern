import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { Poller } from '../src/poll.js';
import type { SourceAdapter, SourceCheckpoint, SourceFetchResult, SourceOccurrenceState, SourceSnapshot, SourcedPosting } from '../src/types.js';

const migrations = [
  '0001_initial.sql', '0007_catalog_admission.sql', '0008_catalog_admission_occurrence_repair.sql',
  '0010_posting_identity.sql', '0012_destination_verification_schedule.sql', '0015_role_metadata_enrichment.sql',
  '0016_role_metadata_repair_plans.sql', '0017_metadata_acquisition.sql', '0018_metadata_review.sql',
  '0019_metadata_job_review_revision.sql', '0036_posting_withdrawal_reviews.sql',
];

function sqliteD1(database: DatabaseSync): D1Database {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => T): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const executors = new WeakMap<object, () => { meta: { changes: number } }>();
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => {
    const run = () => ({ meta: { changes: Number(database.prepare(query).run(...values).changes) } });
    const statement: D1PreparedStatement = {
      bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
      async first<T>() { return exclusive(() => (database.prepare(query).get(...values) as T | undefined) ?? null); },
      async all<T>() { return exclusive(() => ({ results: database.prepare(query).all(...values) as T[] })); },
      async run() { return exclusive(run); },
    };
    executors.set(statement, run);
    return statement;
  };
  return {
    prepare: (query) => prepared(query),
    batch: (statements) => exclusive(() => {
      database.exec('BEGIN');
      try {
        const results = statements.map((statement) => {
          const execute = executors.get(statement);
          if (!execute) throw new Error('batch received a foreign statement');
          return execute();
        });
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }),
  };
}

function catalog() {
  const database = new DatabaseSync(':memory:');
  for (const migration of migrations) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { database, store: new D1InternshipStore(sqliteD1(database)) };
}

const sourceId = 'vanshb03-summer-2027';
const posting = (ordinal: number): SourcedPosting => ({
  sourceId, provenance: 'official-ats', externalId: `role-${ordinal}`, document: 'README.md', row: ordinal + 3,
  sourceUrl: 'https://github.com/example/internships', fetchedAt: '2026-09-28T12:00:00.000Z',
  employer: { id: `employer-${ordinal}`, name: `Employer ${ordinal}`, authority: 'reviewed-registry' },
  title: `Software Engineering Intern ${ordinal}`,
  content: [{ kind: 'description', format: 'plain', value: 'Build production software with a mentor.' }],
  locations: ['Remote'], applyUrl: `https://careers.example.test/roles/${ordinal}`,
  sourceState: 'open', lifecycleAuthority: 'title',
});
const hash = (rows: SourcedPosting[]) => createHash('sha256').update(rows.map((row) => row.externalId).join('|')).digest('hex');

class Board implements SourceAdapter {
  constructor(readonly id: string, private rows: SourcedPosting[]) {}
  setRows(rows: SourcedPosting[]) { this.rows = rows; }
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult & SourceSnapshot> {
    const contentHash = hash(this.rows);
    const unchanged = previous?.contentHash === contentHash;
    return {
      sourceId: this.id, outcome: unchanged ? 'unchanged' : 'changed', complete: true,
      rawCount: this.rows.length, rawRowCount: this.rows.length, contentHash,
      postings: this.rows, listings: [], notModified: unchanged,
      ...(unchanged ? { unchangedReason: 'content_hash' as const } : {}),
      checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + (unchanged ? 0 : 1),
        lastRowCount: this.rows.length, contentHash, activeExternalIds: this.rows.map((row) => row.externalId) },
    };
  }
}

const successfulProbe = async (url: string) => ({ url, evidence: { url, confidence: {
  score: 100, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: ['integration fixture'],
} } });

describe('GitHub ingestion day integration', () => {
  it('drains a regular day, records an omission, and admits a newly published role', async () => {
    const { store } = catalog();
    const morning = Array.from({ length: 61 }, (_, index) => posting(index));
    const board = new Board(sourceId, morning);
    const run = () => new Poller([board], store, undefined, undefined, successfulProbe, false)
      .poll({ maxListingsPerSourceRun: 25 });

    const pending = [];
    for (let delivery = 0; delivery < 3; delivery += 1) {
      const report = await run();
      expect(report.failures).toEqual([]);
      pending.push(report.pendingResolution[sourceId] ?? 0);
    }
    expect(pending).toEqual([36, 11, 0]);
    expect((await store.getSourceOccurrences(sourceId)).filter((row) => row.present)).toHaveLength(61);

    board.setRows([...morning.slice(0, -1), posting(61)]);
    const afternoon = await run();
    expect(afternoon.failures).toEqual([]);
    await run();
    await run();
    expect(await store.getSourceOccurrence(sourceId, 'role-60')).toMatchObject({ present: false, consecutiveOmissions: 1 });
    expect(await store.getSourceOccurrence(sourceId, 'role-61')).toMatchObject({ present: true });
    expect((await store.getCheckpoint(sourceId))?.pendingResolutionRows).toBeUndefined();
  });

  it('converges after a hard day with a retryable prefix larger than one slice', async () => {
    const { store } = catalog();
    const rows = Array.from({ length: 70 }, (_, index) => posting(index));
    const board = new Board(sourceId, rows);
    const failing = new Set(rows.slice(0, 30).map((row) => row.applyUrl));
    const run = () => new Poller([board], store, undefined, undefined, async (url) => {
      if (failing.has(url)) throw new Error('Application link timed out');
      return successfulProbe(url);
    }, false).poll({ maxListingsPerSourceRun: 25 });

    for (let delivery = 0; delivery < 4; delivery += 1) await run();
    const degraded = (await store.getCheckpoint(sourceId))?.pendingResolutionRows ?? [];
    expect(degraded).toHaveLength(30);
    expect((await store.getSourceOccurrences(sourceId)).filter((row) => row.present)).toHaveLength(40);

    failing.clear();
    for (let delivery = 0; delivery < 2; delivery += 1) await run();
    expect((await store.getCheckpoint(sourceId))?.pendingResolutionRows).toBeUndefined();
    expect((await store.getSourceOccurrences(sourceId)).filter((row) => row.present)).toHaveLength(70);
  });

  it('bounds hydration when a large source has a pending admission migration', async () => {
    const { database, store: seedStore } = catalog();
    const board = new Board(sourceId, Array.from({ length: 60 }, (_, index) => posting(index)));
    await new Poller([board], seedStore, undefined, undefined, successfulProbe, false)
      .poll({ maxListingsPerSourceRun: 25 });
    const checkpoint = await seedStore.getCheckpoint(sourceId);
    expect(checkpoint).toBeDefined();
    await seedStore.putCheckpoint({ ...checkpoint!, pendingAdmissionConfigurationVersion: 'stale' });

    // The production regression: a pending admission migration used to load every
    // retained occurrence body to choose its slice, which exceeded the isolate and
    // left the migration unable to complete, so it re-loaded the full set forever.
    // Selection now reads the compact projection and hydrates only the slice.
    let fullReads = 0;
    let selectionReads = 0;
    class BoundedStore extends D1InternshipStore {
      override async getSourceOccurrences(): Promise<SourceOccurrenceState[]> {
        fullReads += 1;
        throw new Error('a pending admission migration hydrated the complete retained history');
      }
      override async listSourceOccurrenceSelectionMetadata(source: string) {
        selectionReads += 1;
        return super.listSourceOccurrenceSelectionMetadata(source);
      }
    }
    const bounded = new BoundedStore(sqliteD1(database));
    const report = await new Poller([board], bounded, undefined, undefined, successfulProbe, false)
      .poll({ maxListingsPerSourceRun: 25, maxAdmissionMigrationListingsPerSourceRun: 25 });

    expect(report.failures).toEqual([]);
    expect(fullReads).toBe(0);
    expect(selectionReads).toBeGreaterThan(0);
  });
});
