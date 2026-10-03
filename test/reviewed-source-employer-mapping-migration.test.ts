import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';

const migrations = new URL('../cloudflare/migrations/', import.meta.url);
const through0030 = readdirSync(migrations)
  .filter((name) => name.endsWith('.sql') && name.localeCompare('0031') < 0)
  .sort();
const migration = readFileSync(new URL('0031_reviewed_source_employer_mappings.sql', migrations), 'utf8');

function databaseThrough0030(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  for (const name of through0030) database.exec(readFileSync(new URL(name, migrations), 'utf8'));
  return database;
}

const reviewedScopes = [
  ...reviewedGreenhouseSources.map((source) => ({
    provider: 'greenhouse', scope: source.id, displayName: source.displayName,
  })),
  ...reviewedAshbySources.map((source) => ({
    provider: 'ashby', scope: source.id, displayName: source.company,
  })),
] as const;

describe('reviewed source employer mapping migration', () => {
  it('maps every reviewed Greenhouse and Ashby source and is idempotent', () => {
    const database = databaseThrough0030();
    database.exec(migration);
    database.exec(migration);

    for (const source of reviewedScopes) {
      const mapping = database.prepare(`SELECT employer.id, employer.display_name, mapping.reviewed_by
        FROM employer_mappings AS mapping
        JOIN canonical_employers AS employer ON employer.id = mapping.canonical_employer_id
        WHERE mapping.provider = ? AND mapping.scope = ? AND mapping.superseded_at IS NULL`)
        .get(source.provider, source.scope) as { id: string; display_name: string; reviewed_by: string } | undefined;
      expect(mapping, `${source.provider}:${source.scope}`).toBeTruthy();
      if (mapping?.reviewed_by === 'reviewed-source-registry-sync-2026-09-20') {
        expect(mapping.display_name, `${source.provider}:${source.scope}`).toBe(source.displayName);
      }
    }
    expect(database.prepare(`SELECT COUNT(*) AS count FROM employer_mappings
      WHERE reviewed_by = 'reviewed-source-registry-sync-2026-09-20' AND superseded_at IS NULL`).get())
      .toEqual({ count: 257 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'migration_0031_reviewed_source_employer_assertion'").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it('fails instead of retaining a conflicting canonical employer display name', () => {
    const database = databaseThrough0030();
    database.exec(`
      INSERT INTO canonical_employers
        (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES ('42dot', 'Wrong 42dot', '2026-09-20T00:00:00Z', 'test',
        '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z');
    `);

    expect(() => database.exec(migration)).toThrow('reviewed_source_employer_rows_must_match');
    expect(database.prepare(`SELECT COUNT(*) AS count FROM employer_mappings
      WHERE reviewed_by = 'reviewed-source-registry-sync-2026-09-20'`).get()).toEqual({ count: 0 });
    database.close();
  });

  it('fails instead of retaining a conflicting active source mapping', () => {
    const database = databaseThrough0030();
    database.exec(`
      INSERT INTO canonical_employers
        (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES ('wrong-figma', 'Wrong Figma', '2026-09-20T00:00:00Z', 'test',
        '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z');
      INSERT INTO employer_mappings
        (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
      VALUES ('wrong-greenhouse-figma', 'greenhouse', 'greenhouse-figma', 'wrong-figma',
        '2026-09-20T00:00:00Z', 'test', '2026-09-20T00:00:00Z');
    `);

    expect(() => database.exec(migration)).toThrow('reviewed_source_employer_rows_must_match');
    expect(database.prepare(`SELECT COUNT(*) AS count FROM employer_mappings
      WHERE reviewed_by = 'reviewed-source-registry-sync-2026-09-20'`).get()).toEqual({ count: 0 });
    database.close();
  });
});
