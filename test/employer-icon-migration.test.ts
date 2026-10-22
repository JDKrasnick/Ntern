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
const migrationV2 = readFileSync(new URL(
  '../cloudflare/migrations/0038_employer_icon_resolution_v2.sql',
  import.meta.url,
), 'utf8');
const tieBreakRearm = readFileSync(new URL(
  '../cloudflare/migrations/0044_rearm_icon_tie_break_changed_evidence.sql',
  import.meta.url,
), 'utf8');
const reviewedSourceRepair = readFileSync(new URL(
  '../cloudflare/migrations/0061_reviewed_source_icon_identity.sql', import.meta.url,
), 'utf8');

function migrated(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(admission);
  database.exec(migration);
  database.exec(migrationV2);
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
  it('parks existing exhausted retries without changing holds, live claims, or remaining attempts', () => {
    const database = migrated();
    const cases = [
      ['unresolved', 'unresolved', 4, 10, null], ['transient', 'retryable', 5, 0, null],
      ['remaining', 'retryable', 3, 0, null], ['held', 'unresolved', 4, 50, null],
      ['claimed', 'retryable', 4, 0, '2999-01-01'], ['settled', 'resolved', 8, 0, null],
      ['invalidated', 'invalidated', 5, 100, null],
    ] as const;
    for (const [id, status, attempts, priority, lease] of cases) {
      insertTask(database, id, id, status);
      database.prepare(`UPDATE employer_icon_resolutions SET attempts=?,review_priority=?,lease_until=?,next_retry_at='2999-02-01' WHERE id=?`)
        .run(attempts, priority, lease, id);
    }
    const stop = readFileSync(new URL('../cloudflare/migrations/0066_stop_exhausted_icon_retries.sql', import.meta.url), 'utf8');
    database.exec(stop);
    database.exec(stop);
    for (const [id, status, attempts, priority, lease] of cases) {
      expect(database.prepare('SELECT status,attempts,review_priority,lease_until,next_retry_at FROM employer_icon_resolutions WHERE id=?').get(id))
        .toMatchObject({status,attempts,review_priority:priority,lease_until:lease,
          next_retry_at:['unresolved','transient'].includes(id) ? null : '2999-02-01'});
    }
  });
  it.each(['canonical', 'independent'].flatMap(kind => ['0064_discover_workday_board_logos.sql',
    '0065_recognize_mislabeled_board_logos.sql'].map(file => [kind,file])))('preserves %s review boundaries in %s', (kind,file) => {
    const database = migrated();
    for (const file of ['0001_initial.sql', '0013_canonical_employer_icons.sql', '0062_independent_company_icons.sql']) {
      database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const states = ['missing', 'inactive', 'other-ats', 'unreviewed', 'stored', 'resolved', 'invalidated',
      'reviewed-domain', 'corporate', 'inflight', 'blocked-sibling'];
    const table = kind === 'canonical' ? 'canonical_employers' : 'company_icon_identities';
    for (const state of states) {
      const id = kind === 'canonical' ? state : `icon-v1-${state}`;
      if (kind === 'canonical') database.prepare(`INSERT INTO canonical_employers
        (id,display_name,reviewed_at,reviewed_by,created_at,updated_at) VALUES (?,?,'old','review','old','old')`).run(id, state);
      else database.prepare(`INSERT INTO company_icon_identities
        (id,display_name,scope,name_key,seed_json,created_at,updated_at) VALUES (?,?,'scope',?,'{}','old','old')`).run(id, state, state);
      database.prepare(`UPDATE ${table} SET icon_resolution_status=?,icon_key=?,website_domain_source=? WHERE id=?`)
        .run(['resolved', 'invalidated'].includes(state) ? state : 'unresolved', state === 'stored' ? 'key' : null,
          state === 'reviewed-domain' ? 'reviewed' : 'automatic', id);
      for (const suffix of ['a', 'b']) database.prepare(`INSERT INTO employer_icon_resolutions
        (id,canonical_employer_id,evidence_fingerprint,status,evidence_json,attempts,next_retry_at,review_priority,lease_until,created_at,updated_at)
        VALUES (?,?,?,'unresolved','{}',1,'2099-01-01',?,?,'old','old')`)
        .run(`${id}-${suffix}`,id,suffix,state === 'corporate' ? 50 : 0,state === 'inflight' ? '2100-01-01' : null);
      if (state === 'blocked-sibling') database.prepare(`UPDATE employer_icon_resolutions SET status='invalidated' WHERE id=?`).run(`${id}-b`);
      database.prepare(`INSERT INTO catalog_items(pk,sk,kind,value) VALUES ('CATALOG_PROJECTION#GROUPS',?,'catalog-projection',?)`)
        .run(state,JSON.stringify({group:{featuredRole:{[kind === 'canonical' ? 'canonicalEmployerId' : 'companyIconId']:id,
          officialApplyUrl:state === 'other-ats' ? 'https://jobs.lever.co/brand/123' : 'https://tenant.wd3.myworkdayjobs.com/careers/job/Intern_P123',
          sourceReferences:[{provenance:state === 'unreviewed' ? 'unknown' : 'reviewed-community'}]}}}));
    }
    database.prepare(`INSERT INTO catalog_items(pk,sk,kind,value) VALUES
      ('CATALOG_PROJECTION','CURRENT','catalog-projection','{"version":"current"}'),
      ('CATALOG_PROJECTION#MANIFESTS','current','catalog-projection',?)`)
      .run(JSON.stringify({keys:states.filter(x=>x!=='inactive')}));
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url),'utf8'));
    expect(database.prepare("SELECT id FROM employer_icon_resolutions WHERE next_retry_at='1970-01-01T00:00:00.000Z'").all())
      .toEqual([{id:kind === 'canonical' ? 'missing-a' : 'icon-v1-missing-a'}]);
    database.close();
  });
  it.each(['missing', 'known', 'inactive', 'resolved', 'invalidated', 'corporate', 'reviewed-domain', 'stored-icon', 'inflight', 'blocked-sibling'])(
    'restores current catalog evidence while preserving %s decisions', (state) => {
      const database = migrated();
      database.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
      database.exec(readFileSync(new URL('../cloudflare/migrations/0013_canonical_employer_icons.sql', import.meta.url), 'utf8'));
      database.prepare(`UPDATE canonical_employers SET icon_tie_break_at='old', icon_tie_break_fingerprint='fp',
        icon_resolution_status=?, icon_key=?, website_domain_source=? WHERE id='acme'`)
        .run(['resolved', 'invalidated'].includes(state) ? state : 'unresolved',
          state === 'stored-icon' ? 'company-icons/acme/reviewed.png' : null, state === 'reviewed-domain' ? 'reviewed' : 'automatic');
      database.prepare(`INSERT INTO employer_icon_resolutions
        (id,canonical_employer_id,evidence_fingerprint,status,evidence_json,next_retry_at,lease_until,review_priority,created_at,updated_at)
        VALUES ('repair','acme','fp','unresolved',?,'2099-01-01',?,?,'old','old')`)
        .run(state === 'known' ? '{"provenance":"reviewed-community"}' : '{}',
          state === 'inflight' ? '2100-01-01' : null, state === 'corporate' ? 50 : 10);
      if (state === 'blocked-sibling') insertTask(database, 'blocked', 'blocked', 'invalidated');
      database.prepare(`INSERT INTO catalog_items(pk,sk,kind,value) VALUES
        ('CATALOG_PROJECTION','CURRENT','catalog-projection','{"version":"current"}'),
        ('CATALOG_PROJECTION#MANIFESTS','current','catalog-projection',?)`)
        .run(JSON.stringify({ keys: state === 'inactive' ? [] : ['active'] }));
      database.prepare(`INSERT INTO catalog_items(pk,sk,kind,value) VALUES
        ('CATALOG_PROJECTION#GROUPS','active','catalog-projection',?)`)
        .run(JSON.stringify({ group: { featuredRole: { canonicalEmployerId: 'acme',
          sourceReferences: [{ provenance: 'reviewed-community' }] } } }));
      const beforeRoles = database.prepare('SELECT * FROM catalog_items ORDER BY pk,sk').all();
      database.exec(readFileSync(new URL('../cloudflare/migrations/0063_restore_catalog_icon_provenance.sql', import.meta.url), 'utf8'));
      expect(database.prepare("SELECT icon_tie_break_at FROM canonical_employers WHERE id='acme'").get())
        .toMatchObject({ icon_tie_break_at: state === 'missing' ? null : 'old' });
      expect(database.prepare("SELECT next_retry_at FROM employer_icon_resolutions WHERE id='repair'").get())
        .toMatchObject({ next_retry_at: state === 'missing' ? '1970-01-01T00:00:00.000Z' : '2099-01-01' });
      expect(database.prepare('SELECT * FROM catalog_items ORDER BY pk,sk').all()).toEqual(beforeRoles);
      database.close();
    },
  );

  it('registers missing reviewed source IDs without replacing existing reviewer choices', () => {
    const database = migrated();
    database.exec(readFileSync(new URL('../cloudflare/migrations/0013_canonical_employer_icons.sql', import.meta.url), 'utf8'));
    database.exec(`INSERT INTO canonical_employers (id, display_name, reviewed_at, reviewed_by, created_at, updated_at, icon_key)
      VALUES ('waymo', 'Operator Waymo', 'old', 'operator', 'old', 'old', 'reviewed.png')`);
    database.exec(reviewedSourceRepair);
    expect(database.prepare("SELECT display_name, reviewed_by, icon_key FROM canonical_employers WHERE id = 'waymo'").get())
      .toMatchObject({ display_name: 'Operator Waymo', reviewed_by: 'operator', icon_key: 'reviewed.png' });
    expect(database.prepare("SELECT display_name, reviewed_by FROM canonical_employers WHERE id = 'flyzipline'").get())
      .toMatchObject({ display_name: 'Zipline', reviewed_by: 'reviewed-source-registry' });
    expect(database.prepare('SELECT COUNT(*) AS n FROM canonical_employers').get()).toMatchObject({ n: 20 });
    database.close();
  });

  it.each(['unresolved', 'resolved', 'invalidated', 'corporate-review', 'reviewed-domain', 'stored-icon'])(
    're-arms unresolved work while preserving %s decisions', (state) => {
      const database = migrated();
      database.exec(readFileSync(new URL('../cloudflare/migrations/0013_canonical_employer_icons.sql', import.meta.url), 'utf8'));
      database.prepare(`UPDATE canonical_employers SET icon_resolution_status = ?, icon_key = ?, website_domain_source = ?,
        icon_tie_break_at = '2026-10-20', icon_tie_break_fingerprint = 'fp' WHERE id = 'acme'`)
        .run(['resolved', 'invalidated'].includes(state) ? state : 'unresolved', state === 'stored-icon' ? 'stored.png' : null,
          state === 'reviewed-domain' ? 'reviewed' : 'automatic');
      database.prepare(`INSERT INTO employer_icon_resolutions
        (id, canonical_employer_id, evidence_fingerprint, status, evidence_json, attempts, next_retry_at, created_at, updated_at)
        VALUES ('task', 'acme', 'fp', ?, json_object('reasonCode', ?), 5, '2026-11-01', 'old', 'old')`)
        .run(['resolved', 'invalidated'].includes(state) ? state : 'unresolved',
          state === 'corporate-review' ? 'corporate-redirect-review' : 'tie-break-budget-exhausted');
      database.exec(reviewedSourceRepair);
      expect(database.prepare('SELECT next_retry_at, attempts FROM employer_icon_resolutions WHERE id = ?').get('task'))
        .toMatchObject({ next_retry_at: state === 'unresolved' ? '1970-01-01T00:00:00.000Z' : '2026-11-01',
          attempts: state === 'unresolved' ? 0 : 5 });
      expect(database.prepare("SELECT icon_tie_break_at FROM canonical_employers WHERE id = 'acme'").get())
        .toMatchObject({ icon_tie_break_at: state === 'unresolved' ? null : '2026-10-20' });
      database.close();
    },
  );
  it('adds the resolver bookkeeping columns to canonical_employers and round-trips them', () => {
    const database = migrated();
    const columns = (database.prepare(`SELECT name FROM pragma_table_info('canonical_employers')`).all() as { name: string }[])
      .map((row) => row.name);
    for (const column of [
      'website_domain', 'icon_source', 'icon_resolution_status', 'icon_resolved_at',
      'icon_tie_break_at', 'icon_tie_break_fingerprint', 'icon_tie_break_input_tokens', 'icon_tie_break_output_tokens',
      'website_domain_source', 'website_domain_reviewed_at', 'website_domain_reviewed_by',
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

describe('changed-evidence tie-break re-arm migration', () => {
  function insertResolution(
    database: DatabaseSync,
    id: string,
    fingerprint: string,
    status: string,
    reasonCode: string,
  ): void {
    database.prepare(`INSERT INTO employer_icon_resolutions
      (id, canonical_employer_id, evidence_fingerprint, status, evidence_json, attempts, next_retry_at, created_at, updated_at)
      VALUES (?, 'acme', ?, ?, json_object('reasonCode', ?), 2, '2026-10-29T00:00:00.000Z',
        '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`)
      .run(id, fingerprint, status, reasonCode);
  }

  it('re-arms only the parked rows whose evidence differs from the last tie-breaker', () => {
    const database = migrated();
    database.prepare(`UPDATE canonical_employers SET icon_tie_break_at = '2026-09-29T00:00:00.000Z',
      icon_tie_break_fingerprint = 'fp-old' WHERE id = 'acme'`).run();
    insertResolution(database, 'changed', 'fp-new-a', 'unresolved', 'tie-break-budget-exhausted');
    insertResolution(database, 'same', 'fp-old', 'unresolved', 'tie-break-budget-exhausted');
    insertResolution(database, 'other-reason', 'fp-new-b', 'unresolved', 'no-reliable-domain');
    insertResolution(database, 'retryable', 'fp-new-c', 'retryable', 'tie-break-budget-exhausted');

    database.exec(tieBreakRearm);

    const rows = database.prepare(`SELECT id, next_retry_at FROM employer_icon_resolutions`)
      .all() as { id: string; next_retry_at: string }[];
    const nextRetry = Object.fromEntries(rows.map((row) => [row.id, row.next_retry_at]));
    expect(nextRetry.changed).toBe('1970-01-01T00:00:00.000Z');
    expect(nextRetry.same).toBe('2026-10-29T00:00:00.000Z');
    expect(nextRetry['other-reason']).toBe('2026-10-29T00:00:00.000Z');
    expect(nextRetry.retryable).toBe('2026-10-29T00:00:00.000Z');
    database.close();
  });
});
