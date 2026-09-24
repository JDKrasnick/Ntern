import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const admission = readFileSync(new URL(
  '../cloudflare/migrations/0007_catalog_admission.sql',
  import.meta.url,
), 'utf8');
const migration = readFileSync(new URL(
  '../cloudflare/migrations/0034_employer_icon_resolution.sql',
  import.meta.url,
), 'utf8');

function migrated(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(admission);
  database.exec(migration);
  database.prepare(`INSERT INTO canonical_employers
    (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
    VALUES ('acme', 'Acme', '2026-09-01T00:00:00Z', 'review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`).run();
  return database;
}

function insertTask(database: DatabaseSync, id: string, fingerprint: string, status = 'retryable'): void {
  database.prepare(`INSERT INTO employer_icon_resolutions
    (id, canonical_employer_id, evidence_fingerprint, status, evidence_json, created_at, updated_at)
    VALUES (?, 'acme', ?, ?, '{}', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`)
    .run(id, fingerprint, status);
}

function indexColumns(database: DatabaseSync, index: string): string[] {
  return (database.prepare(`SELECT name FROM pragma_index_info(?)`).all(index) as { name: string }[])
    .map((row) => row.name);
}

describe('employer icon resolution migration', () => {
  it('adds the resolver bookkeeping columns to canonical_employers and round-trips them', () => {
    const database = migrated();
    const columns = (database.prepare(`SELECT name FROM pragma_table_info('canonical_employers')`).all() as { name: string }[])
      .map((row) => row.name);
    for (const column of [
      'website_domain', 'icon_source', 'icon_resolution_status', 'icon_resolved_at',
      'icon_tie_break_at', 'icon_tie_break_fingerprint', 'icon_tie_break_input_tokens', 'icon_tie_break_output_tokens',
    ]) {
      expect(columns).toContain(column);
    }

    database.prepare(`UPDATE canonical_employers SET
      website_domain = 'acme.com', icon_source = 'logo-dev', icon_resolution_status = 'resolved',
      icon_resolved_at = '2026-09-24T00:00:00.000Z', icon_tie_break_at = '2026-09-24T00:00:00.000Z',
      icon_tie_break_fingerprint = 'fingerprint', icon_tie_break_input_tokens = 1200, icon_tie_break_output_tokens = 80
      WHERE id = 'acme'`).run();
    expect(database.prepare(`SELECT website_domain, icon_source, icon_resolution_status, icon_tie_break_input_tokens,
      icon_tie_break_output_tokens FROM canonical_employers WHERE id = 'acme'`).get()).toEqual({
      website_domain: 'acme.com', icon_source: 'logo-dev', icon_resolution_status: 'resolved',
      icon_tie_break_input_tokens: 1200, icon_tie_break_output_tokens: 80,
    });
    database.close();
  });

  it('scans due work through the (next_retry_at, lease_until) index', () => {
    const database = migrated();
    expect(indexColumns(database, 'employer_icon_resolutions_due')).toEqual(['next_retry_at', 'lease_until']);

    const plan = database.prepare(`EXPLAIN QUERY PLAN
      SELECT task.id FROM employer_icon_resolutions AS task
      WHERE task.next_retry_at IS NOT NULL AND task.next_retry_at <= '2026-09-24T00:00:00.000Z'
        AND (task.lease_until IS NULL OR task.lease_until <= '2026-09-24T00:00:00.000Z')
        AND task.status IN ('retryable', 'unresolved')
        AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions AS blocked
          WHERE blocked.canonical_employer_id = task.canonical_employer_id AND blocked.status = 'invalidated')
      ORDER BY task.next_retry_at, task.created_at LIMIT 10`).all() as { detail: string }[];
    expect(plan.some((row) => row.detail.includes('employer_icon_resolutions_due'))).toBe(true);
    database.close();
  });

  it('indexes the employer exception queue by employer, status, and review priority', () => {
    const database = migrated();
    expect(indexColumns(database, 'employer_icon_resolutions_employer'))
      .toEqual(['canonical_employer_id', 'status', 'review_priority']);
    database.close();
  });

  it('rejects a duplicate (employer, evidence fingerprint) pair', () => {
    const database = migrated();
    insertTask(database, 'task-1', 'fingerprint-a');
    expect(() => insertTask(database, 'task-2', 'fingerprint-a')).toThrow(/UNIQUE/u);

    insertTask(database, 'task-2', 'fingerprint-b');
    expect(database.prepare(`SELECT COUNT(*) AS total FROM employer_icon_resolutions`).get()).toEqual({ total: 2 });
    database.close();
  });

  it('rejects an unknown resolution status', () => {
    const database = migrated();
    for (const status of ['resolved', 'unresolved', 'retryable', 'invalidated']) {
      insertTask(database, `task-${status}`, `fingerprint-${status}`, status);
    }
    expect(() => insertTask(database, 'task-unknown', 'fingerprint-unknown', 'pending')).toThrow(/CHECK/u);
    database.close();
  });
});
