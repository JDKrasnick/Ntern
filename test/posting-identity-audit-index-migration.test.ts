import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const initial = readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../cloudflare/migrations/0031_catalog_items_kind_pk_sk.sql', import.meta.url), 'utf8');

describe('posting identity audit index migration', () => {
  it('indexes the audit kind keyset scan by kind, pk, and sk', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(initial);
    database.exec(migration);

    const plan = database.prepare(`EXPLAIN QUERY PLAN
      SELECT pk, sk, kind, value FROM catalog_items
      WHERE kind = 'internship' AND (pk > ? OR (pk = ? AND sk > ?))
      ORDER BY pk, sk LIMIT ?`).all('', '', '', 500) as Array<{ detail: string }>;

    expect(plan.map((item) => item.detail).join(' ')).toContain('catalog_items_kind_pk_sk');
  });
});
