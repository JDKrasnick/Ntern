import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const initial = readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../cloudflare/migrations/0027_provider_shadow_outbox_index.sql', import.meta.url), 'utf8');

describe('provider shadow outbox migration', () => {
  it('uses the partial pending-handoff index instead of scanning catalog_items', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(initial);
    database.exec(migration);
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT value FROM catalog_items WHERE kind = 'provider-shadow-verification' AND sk = 'PENDING' LIMIT 100").all() as Array<{ detail: string }>;
    expect(plan.map((item) => item.detail).join(' ')).toContain('catalog_items_pending_provider_shadow_handoffs');
  });
});
