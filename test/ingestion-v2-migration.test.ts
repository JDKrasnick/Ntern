import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../cloudflare/migrations/', import.meta.url);

function migrationsUpTo(prefixInclusive: string): string[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name.localeCompare(prefixInclusive) <= 0)
    .sort((left, right) => left.localeCompare(right));
}

function freshDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const migration of migrationsUpTo('9999')) {
    database.exec(readFileSync(new URL(migration, migrationsDirectory), 'utf8'));
  }
  return database;
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).map((row) => row.name);
}

function indexNames(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(table) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function indexColumns(database: DatabaseSync, index: string): string[] {
  return (database.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index) as Array<{ name: string }>).map((row) => row.name);
}

function queryPlan(database: DatabaseSync, sql: string, ...params: Array<string | number>): string {
  const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((row) => row.detail).join('\n');
}

describe('ingestion v2 migration', () => {
  it('creates both ledger tables with the required columns', () => {
    const database = freshDatabase();
    expect(columnNames(database, 'ingestion_snapshots')).toEqual(expect.arrayContaining([
      'source_id', 'snapshot_hash', 'object_key', 'admission_version', 'document_count', 'row_count',
      'state', 'is_complete', 'baseline', 'created_at', 'activated_at', 'terminal_at', 'expires_at',
    ]));
    expect(columnNames(database, 'ingestion_rows')).toEqual(expect.arrayContaining([
      'source_id', 'external_id', 'snapshot_hash', 'material_hash', 'admission_version', 'notification_baseline', 'effect_claimed_at', 'state', 'decision',
      'attempt_count', 'retry_at', 'lease_owner', 'lease_expires_at', 'consecutive_omissions', 'job_id',
      'failure_class', 'failure_detail', 'first_observed_at', 'last_observed_at', 'updated_at', 'settled_at',
    ]));
    expect(columnNames(database, 'ingestion_v2_dispatch_state')).toEqual(expect.arrayContaining([
      'singleton', 'source_cursor', 'updated_at',
    ]));
    expect(columnNames(database, 'ingestion_v2_admission_decisions')).toEqual(expect.arrayContaining([
      'source_id', 'external_id', 'admission_version', 'job_id', 'notify',
      'catalog_eligible', 'alert_eligible', 'reason_codes', 'recorded_at',
    ]));
    database.close();
  });

  it('creates every planned hot-path index on the indexed columns', () => {
    const database = freshDatabase();
    const snapshotIndexes = [...indexNames(database, 'ingestion_snapshots')];
    expect(snapshotIndexes).toEqual(expect.arrayContaining(['ingestion_snapshots_hash', 'ingestion_snapshots_expiry', 'ingestion_snapshots_source_created']));
    const rowIndexes = [...indexNames(database, 'ingestion_rows')];
    expect(rowIndexes).toEqual(expect.arrayContaining([
      'ingestion_rows_work', 'ingestion_rows_policy', 'ingestion_rows_lease', 'ingestion_rows_snapshot', 'ingestion_rows_observed',
    ]));
    expect(indexColumns(database, 'ingestion_rows_work')).toEqual(['source_id', 'state', 'retry_at']);
    expect(indexColumns(database, 'ingestion_rows_policy')).toEqual(['source_id', 'admission_version', 'state']);
    expect(indexColumns(database, 'ingestion_rows_lease')).toEqual(['state', 'lease_expires_at']);
    expect(indexColumns(database, 'ingestion_rows_snapshot')).toEqual(['snapshot_hash']);
    expect(indexColumns(database, 'ingestion_rows_observed')).toEqual(['source_id', 'last_observed_at']);
    database.close();
  });

  it('enforces the documented state and decision domains', () => {
    const database = freshDatabase();
    let ordinal = 0;
    const insert = (state: string, decision: string | null) => () => database.prepare(`
      INSERT INTO ingestion_rows (source_id, external_id, snapshot_hash, material_hash, admission_version, state, decision,
        attempt_count, consecutive_omissions, first_observed_at, last_observed_at, updated_at)
      VALUES ('s', ?, 'h', 'm', 'v', ?, ?, 0, 0, 't', 't', 't')
    `).run(`e-${ordinal++}`, state, decision);
    expect(insert('pending', null)).not.toThrow();
    expect(insert('settled', 'admitted')).not.toThrow();
    expect(insert('bogus', null)).toThrow();
    expect(insert('settled', 'bogus')).toThrow();
    database.prepare(`
      INSERT INTO ingestion_snapshots (source_id, snapshot_hash, object_key, admission_version, document_count, row_count, state, is_complete, baseline, created_at)
      VALUES ('s', 'h', 'k', 'v', 0, 0, 'staged', 1, 0, 't')
    `).run();
    expect(() => database.prepare(`
      INSERT INTO ingestion_snapshots (source_id, snapshot_hash, object_key, admission_version, document_count, row_count, state, is_complete, baseline, created_at)
      VALUES ('s2', 'h2', 'k', 'v', 0, 0, 'bogus', 1, 0, 't')
    `).run()).toThrow();
    database.close();
  });

  it('selects due work and expired leases with the indexed predicates', () => {
    const database = freshDatabase();
    expect(queryPlan(database, "SELECT source_id FROM ingestion_rows WHERE source_id = ? AND state = 'pending' AND retry_at <= ? ORDER BY retry_at", 's', 't'))
      .toContain('ingestion_rows_work');
    expect(queryPlan(database, "SELECT source_id FROM ingestion_rows WHERE state = 'processing' AND lease_expires_at <= ?", 't'))
      .toContain('ingestion_rows_lease');
    expect(queryPlan(database, 'SELECT source_id FROM ingestion_rows WHERE snapshot_hash = ?', 'h'))
      .toContain('ingestion_rows_snapshot');
    database.close();
  });

  it('is idempotent and leaves an existing schema fixture untouched', () => {
    const database = new DatabaseSync(':memory:');
    for (const migration of migrationsUpTo('0044')) {
      database.exec(readFileSync(new URL(migration, migrationsDirectory), 'utf8'));
    }
    database.prepare(`INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('job#legacy', 'meta', 'job', '{"jobId":"legacy"}')`).run();
    const legacyBefore = database.prepare(`SELECT value FROM catalog_items WHERE pk = 'job#legacy'`).get() as { value: string };

    const migration = readFileSync(new URL('0045_ingestion_v2.sql', migrationsDirectory), 'utf8');
    database.exec(migration);
    database.exec(migration);

    const legacyAfter = database.prepare(`SELECT value FROM catalog_items WHERE pk = 'job#legacy'`).get() as { value: string };
    expect(legacyAfter).toEqual(legacyBefore);
    expect(columnNames(database, 'ingestion_rows')).toContain('external_id');
    database.close();
  });

  it('upgrades a database that already recorded the original 0045 through 0047', () => {
    const database = new DatabaseSync(':memory:');
    for (const migration of migrationsUpTo('0047_ingestion_v2_dispatch_cursor.sql')) {
      database.exec(readFileSync(new URL(migration, migrationsDirectory), 'utf8'));
    }
    expect(columnNames(database, 'ingestion_rows')).not.toContain('notification_baseline');
    database.prepare(`
      INSERT INTO ingestion_rows (source_id, external_id, snapshot_hash, material_hash, admission_version, state,
        attempt_count, consecutive_omissions, first_observed_at, last_observed_at, updated_at)
      VALUES ('source', 'row', 'snapshot', 'material', 'v1', 'settled', 0, 0, 't', 't', 't')
    `).run();

    database.exec(readFileSync(new URL('0048_ingestion_v2_effect_claim.sql', migrationsDirectory), 'utf8'));

    expect(columnNames(database, 'ingestion_rows')).toEqual(expect.arrayContaining([
      'notification_baseline', 'effect_claimed_at',
    ]));
    expect(database.prepare(`
      SELECT notification_baseline, effect_claimed_at FROM ingestion_rows WHERE source_id = 'source' AND external_id = 'row'
    `).get()).toEqual({ notification_baseline: 0, effect_claimed_at: null });
    database.close();
  });
});
