import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { SourceOccurrenceState } from '../src/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;

// D1 rejects a statement whose result set exceeds its per-query memory ceiling
// with "Memory limit exceeded before EOF." Model that by failing any read that
// materializes more than `maxRowsPerStatement` rows, so an unbounded per-source
// read cannot pass and a paged read can.
function boundedSqliteD1(database: DatabaseSync, maxRowsPerStatement: number): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query);
    const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() {
        const results = statement.all(...bound) as T[];
        if (results.length > maxRowsPerStatement) throw new Error('D1_ERROR: Memory limit exceeded before EOF.');
        return { results };
      },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return {
    prepare(query: string) { return prepared(query); },
    async batch(statements: D1PreparedStatement[]) { return Promise.all(statements.map((statement) => statement.run())); },
  };
}

function occurrence(externalId: string): SourceOccurrenceState {
  return {
    sourceId: 'github-large',
    externalId,
    jobId: `job-${externalId}`,
    present: true,
    changedAt: '2026-09-15T00:00:00.000Z',
    occurrence: {
      sourceId: 'github-large',
      document: 'README',
      sourceUrl: 'https://example.test/README',
      row: 1,
      externalId,
      company: 'Example',
      title: 'Software Engineer Intern',
      location: 'Remote',
      season: 'summer-2027',
      applyUrl: `https://example.test/apply/${externalId}`,
      technical: true,
      state: 'open',
    },
  } as SourceOccurrenceState;
}

describe('D1 source occurrence reads', () => {
  it('pages a per-source partition so no single statement exceeds D1 memory', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (pk TEXT, sk TEXT, kind TEXT, value TEXT, source_id TEXT, external_id TEXT, PRIMARY KEY (pk, sk));
    `);
    const total = 1_201;
    const insert = database.prepare("INSERT INTO catalog_items VALUES (?, ?, 'source-occurrence', ?, ?, ?)");
    for (let index = 0; index < total; index += 1) {
      const id = `posting-${String(index).padStart(4, '0')}`;
      insert.run('SOURCE#github-large', `OCCURRENCE#${id}`, JSON.stringify(occurrence(id)), 'github-large', id);
    }
    insert.run('SOURCE#github-large', 'CHECKPOINT', JSON.stringify({ sourceId: 'github-large' }), 'github-large', null);
    insert.run('SOURCE#github-large', 'HEALTH', JSON.stringify({ sourceId: 'github-large' }), 'github-large', null);

    const store = new D1InternshipStore(boundedSqliteD1(database, 500));
    const occurrences = await store.getSourceOccurrences('github-large');

    expect(occurrences).toHaveLength(total);
    expect(new Set(occurrences.map((item) => item.externalId)).size).toBe(total);
    // Non-occurrence rows under the same partition must stay excluded.
    expect(occurrences.some((item) => item.externalId === 'CHECKPOINT' || item.externalId === 'HEALTH')).toBe(false);
  });

  it('hydrates selected rows and returns only lifecycle-actionable IDs', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE catalog_items (pk TEXT, sk TEXT, kind TEXT, value TEXT, source_id TEXT, external_id TEXT, PRIMARY KEY (pk, sk));
    `);
    const active = occurrence('active');
    const oneOmission = { ...occurrence('one-omission'), present: false, consecutiveOmissions: 1 };
    const retainedClosed = { ...occurrence('retained-closed'), present: false, consecutiveOmissions: 2,
      occurrence: { ...occurrence('retained-closed').occurrence, state: 'closed' as const } };
    const splitClose = { ...occurrence('split-close'), present: false, consecutiveOmissions: 2,
      occurrence: { ...occurrence('split-close').occurrence, state: 'closed' as const } };
    const revoked = { ...occurrence('revoked'), occurrence: { ...occurrence('revoked').occurrence,
      trustedCommunityAlertQualification: { sourceMaterialHash: 'material-v1', candidateKey: 'candidate',
        consecutiveCompleteSnapshots: 1, status: 'pending' as const, baselineSuppressed: true },
      admission: { catalogEligible: true, alertEligible: false, reasonCodes: [],
        evaluatedAt: '2026-09-15T00:00:00.000Z', evidenceObservedAt: '2026-09-15T00:00:00.000Z',
        employerResolution: 'source-reported', postingAttribution: 'attributed', metadata: {
          complete: true, title: 'complete', location: 'complete',
        }, destination: {
          classification: 'posting-detail' as const, candidateUrl: 'https://example.test/apply/revoked',
          provider: 'github' as const, reachability: 'live' as const,
          inspectedAt: '2026-09-15T00:00:00.000Z', reasonCodes: [],
        }, evidenceCodes: ['trusted-community-source'] } } } as SourceOccurrenceState;
    const insert = database.prepare("INSERT INTO catalog_items VALUES (?, ?, 'source-occurrence', ?, ?, ?)");
    for (const value of [active, oneOmission, retainedClosed, splitClose, revoked]) {
      insert.run('SOURCE#github-large', `OCCURRENCE#${value.externalId}`, JSON.stringify(value), value.sourceId, value.externalId);
    }
    const splitJob = {
      jobId: splitClose.jobId,
      sourceReferences: [{ ...splitClose.occurrence, state: 'open' }],
    };
    insert.run(`JOB#${splitClose.jobId}`, 'META', JSON.stringify(splitJob), null, null);
    const store = new D1InternshipStore(boundedSqliteD1(database, 500));

    expect((await store.getSourceOccurrencesByExternalIds('github-large', ['revoked', 'missing', 'active']))
      .map((item) => item.externalId)).toEqual(['revoked', 'active']);
    expect(await store.listSourceOccurrenceIdsPendingReconciliation('github-large'))
      .toEqual(['active', 'one-omission', 'revoked', 'split-close']);
    expect(await store.listSourceOccurrenceTrustedCommunityMaterialHashes('github-large'))
      .toEqual([{ externalId: 'revoked', sourceMaterialHash: 'material-v1' }]);
    expect((await store.getSourceOccurrencesRequiringTrustedCommunityRevocation('github-large', 10))
      .map((item) => item.externalId)).toEqual(['revoked']);
  });
});
