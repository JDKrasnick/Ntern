import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { runPostingIdentityAudit } from '../src/posting-identity-audit.js';
import type { Internship } from '../src/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;

function sqliteD1(database: DatabaseSync, readLimits: number[]): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query); const bound = values as SqliteValue[];
    const recordLimit = () => {
      if (query.includes('FROM catalog_items') && query.includes('LIMIT ?')) readLimits.push(Number(bound.at(-1)));
    };
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { recordLimit(); return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return { prepare(query) { return prepared(query); }, async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } };
}

function job(jobId: string): Internship {
  return {
    jobId, company: 'Paged Employer', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl: `https://careers.example.test/jobs/${jobId}`, normalizedUrl: `https://careers.example.test/jobs/${jobId}`,
    fingerprint: `fingerprint-${jobId}`, compensation: { raw: '' }, sourceReferences: [], open: true, technical: true,
    firstSeenAt: '2026-08-01T00:00:00.000Z', catalogVisibleAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-02T00:00:00.000Z', notification: { smsPending: false, digestPending: false },
  };
}

describe('posting identity audit D1 integration', () => {
  it('keyset-pages a catalog larger than the read limit without an unbounded catalog query', async () => {
    const database = new DatabaseSync(':memory:');
    for (const name of ['0001_initial.sql', '0002_cost_guards.sql', '0003_billing_shutdown.sql', '0004_auth_rate_limits.sql',
      '0005_auth_consent.sql', '0006_employer_channel.sql', '0007_catalog_admission.sql', '0010_posting_identity.sql',
      '0013_posting_presentation_reviews.sql', '0035_posting_source_corrections.sql', '0036_posting_withdrawal_reviews.sql']) {
      database.exec(readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const insert = database.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < 501; index += 1) {
      const value = job(String(index).padStart(4, '0'));
      insert.run(`JOB#${value.jobId}`, 'META', 'internship', JSON.stringify(value));
    }

    const readLimits: number[] = [];
    const report = await runPostingIdentityAudit(sqliteD1(database, readLimits), { jobBatch: 500 });

    expect(report).toMatchObject({ pages: 2, jobsScanned: 501, gate: { passed: true } });
    expect(readLimits).toContain(500);
    expect(readLimits.every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 500)).toBe(true);
  });

  it('caps an oversized requested job batch at the Worker safety ceiling', async () => {
    const database = new DatabaseSync(':memory:');
    for (const name of ['0001_initial.sql', '0002_cost_guards.sql', '0003_billing_shutdown.sql', '0004_auth_rate_limits.sql',
      '0005_auth_consent.sql', '0006_employer_channel.sql', '0007_catalog_admission.sql', '0010_posting_identity.sql',
      '0013_posting_presentation_reviews.sql', '0035_posting_source_corrections.sql', '0036_posting_withdrawal_reviews.sql']) {
      database.exec(readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8'));
    }

    const readLimits: number[] = [];
    const report = await runPostingIdentityAudit(sqliteD1(database, readLimits), { jobBatch: 50_000 });

    expect(report).toMatchObject({ pages: 1, jobsScanned: 0, gate: { passed: true } });
    expect(readLimits).toContain(2_000);
  });
});
