import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { collectWatchdog } from '../scripts/ingestion-watchdog.js';

const now = new Date('2026-10-06T19:38:00.000Z');
const recent = '2026-10-06T19:31:00.000Z';
const old = '2026-10-04T19:00:00.000Z';
let sqlite: DatabaseSync;
afterEach(() => { sqlite?.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function setup() {
  const queries: Array<{ sql: string; params: SQLInputValue[] }> = [];
  sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../cloudflare/migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const phases = ['maintenance:maintenance_complete', 'catalog_projection:catalog_projection_complete',
    'catalog_projection_r2:catalog_projection_r2_complete', 'admission_v2:dispatch'];
  for (const phase of phases) sqlite.prepare('INSERT INTO system_state(key,value,updated_at) VALUES(?,?,?)')
    .run(`maintenance_phase:${phase}`, JSON.stringify({ status: 'complete', observedAt: recent }), recent);
  sqlite.prepare('INSERT INTO catalog_items(pk,sk,kind,value) VALUES(?,?,?,?)')
    .run('SOURCE#source', 'HEALTH', 'source-health', JSON.stringify({ sourceStatus: 'active', lastAttemptAt: recent, lastSuccessAt: recent }));
  const version = createHash('sha256').digest('hex').slice(0, 20);
  const pointer = { schemaVersion: 1, version, generatedAt: recent, count: 0, groupPages: {} };
  sqlite.prepare('INSERT INTO catalog_items(pk,sk,kind,value) VALUES(?,?,?,?)')
    .run('CATALOG_PROJECTION', 'CURRENT', 'projection', JSON.stringify({ ...pointer, schemaVersion: 6 }));
  sqlite.prepare('INSERT INTO catalog_items(pk,sk,kind,value) VALUES(?,?,?,?)')
    .run('CATALOG_PROJECTION#MANIFESTS', version, 'manifest', JSON.stringify({ keys: [] }));
  const vars = { INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'true', INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true',
    INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: 'source', INGESTION_V2_ADMISSION_ENABLED: 'true', INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: 'source',
    INGESTION_V2_CATALOG_WRITER_ENABLED: 'true', INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: 'source',
    INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: 'source' };
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token'); vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const result = (value: unknown) => Response.json({ success: true, result: value });
    if (url.endsWith('/settings')) return result({ bindings: [{ name: 'DB', database_id: 'test-db' },
      ...Object.entries(vars).map(([name, text]) => ({ name, text }))] });
    if (url.endsWith('/query')) {
      const { sql, params } = JSON.parse(String(init?.body)) as { sql: string; params: SQLInputValue[] };
      queries.push({ sql, params });
      expect(sql).toMatch(/^SELECT/);
      return result([{ success: true, results: sqlite.prepare(sql).all(...params) }]);
    }
    if (url.includes('/catalog?')) return Response.json({ groups: [] });
    if (url.includes('/objects/')) return Response.json(pointer);
    if (url.endsWith('/deployments')) return result({ deployments: [{ versions: [{ version_id: 'current', percentage: 100 }] }] });
    if (url.endsWith('/graphql')) return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
      { dimensions: { status: 'success' }, sum: { errors: 0 }, quantiles: { memoryUsageBytesP99: 60 * 1024 * 1024 } },
    ] }] } } });
    throw new Error(`Unexpected request: ${url}`);
  }));
  return queries;
}

it('baselines only reconciled failures from before watchdog activation', () => {
  sqlite = new DatabaseSync(':memory:');
  const migrations = new URL('../cloudflare/migrations/', import.meta.url);
  const names = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
  for (const name of names.filter(name => name < '0053_watchdog_failure_baseline.sql')) {
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  const insert = sqlite.prepare(`INSERT INTO queue_failure_events(id,queue_name,message_id,delivery_attempt,payload_hash,
    category,diagnostic,first_failed_at,last_failed_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  insert.run('historical', 'admission-v2', 'old-message', 3, 'old-hash', 'snapshot-missing', 'reconciled', old, '2026-10-01T12:00:00.000Z');
  insert.run('current', 'admission-v2', 'new-message', 3, 'new-hash', 'snapshot-missing', 'active', old, '2026-10-07T00:00:00.000Z');
  sqlite.exec(readFileSync(new URL('0053_watchdog_failure_baseline.sql', migrations), 'utf8'));
  expect(sqlite.prepare('SELECT id,resolved_at FROM queue_failure_events ORDER BY id').all()).toEqual([
    { id: 'current', resolved_at: null },
    { id: 'historical', resolved_at: '2026-10-07T23:10:00.000Z' },
  ]);
});

function quarantinedRow() {
  sqlite.prepare(`INSERT INTO ingestion_rows(source_id,external_id,snapshot_hash,material_hash,admission_version,state,
    attempt_count,failure_class,failure_detail,first_observed_at,last_observed_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('source', 'lost-role', 'snapshot', 'material', 'policy', 'quarantined', 3, 'upstream-server-error',
      'provider failed three times', old, recent, old);
}

it.each(['2026-10-06T18:00:00.000Z', old])('keeps unresolved exhausted delivery alert until recovery (last retry %s)', async lastFailedAt => {
  setup();
  sqlite.prepare(`INSERT INTO queue_failure_events(id,queue_name,message_id,source_id,delivery_attempt,payload_hash,category,
    diagnostic,first_failed_at,last_failed_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('old-failure', 'intern-notifs-admission-v2', 'dead-message', 'source', 3, 'hash', 'snapshot-missing', 'missing R2 object', old, lastFailedAt);
  expect((await collectWatchdog('dev', now)).map(signal => signal.id)).toContain('queue-failures-unresolved');
  sqlite.prepare('UPDATE queue_failure_events SET resolved_at=? WHERE id=?').run(recent, 'old-failure');
  expect(await collectWatchdog('dev', now)).toEqual([]);
});

it('alerts when acknowledged deliveries leave a permanently quarantined row behind healthy polling', async () => {
  setup();
  quarantinedRow();
  expect((await collectWatchdog('dev', now)).map(signal => signal.id)).toContain('admission-progress-stalled');
  sqlite.prepare("UPDATE ingestion_rows SET state='settled',decision='blocked',failure_class=NULL,failure_detail=NULL WHERE source_id='source'").run();
  expect(await collectWatchdog('dev', now)).toEqual([]);
});

it.each(['paused', 'disabled', 'omitted', 'provider-cooldown'])('respects intentional exclusion or deferral: %s', async state => {
  setup(); quarantinedRow();
  if (state === 'paused' || state === 'disabled') sqlite.prepare("UPDATE catalog_items SET value=json_set(value,'$.sourceStatus',?) WHERE pk='SOURCE#source'").run(state);
  if (state === 'omitted') sqlite.prepare('UPDATE ingestion_rows SET consecutive_omissions=2').run();
  if (state === 'provider-cooldown') sqlite.prepare("UPDATE ingestion_rows SET state='queued',retry_at=?,updated_at=?").run('2026-10-07T19:00:00.000Z', old);
  expect(await collectWatchdog('dev', now)).toEqual([]);
});

it('bounds old unresolved sampling, excludes resolved history, and clears only after recovery', async () => {
  const queries = setup();
  const insert = sqlite.prepare(`INSERT INTO queue_failure_events(id,queue_name,message_id,delivery_attempt,payload_hash,
    category,diagnostic,first_failed_at,last_failed_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  sqlite.exec('BEGIN');
  for (let index = 0; index < 1250; index++) insert.run(`failure-${index}`, 'admission-v2', `message-${index}`, 3,
    'hash', 'snapshot-missing', 'missing immutable snapshot', old, old, index < 1000 ? recent : null);
  sqlite.exec('COMMIT');
  const signals = await collectWatchdog('dev', now);
  expect(signals).toEqual([{ id: 'queue-failures-unresolved', detail: expect.stringContaining('"n":200') }]);
  const query = queries.find(query => query.sql.includes('queue_failure_events'))!;
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params);
  expect(plan.some(row => String(row.detail).includes('queue_failure_unresolved_age'))).toBe(true);
  sqlite.prepare('UPDATE queue_failure_events SET resolved_at=? WHERE resolved_at IS NULL').run(recent);
  expect(await collectWatchdog('dev', now)).toEqual([]);
});

it('does not alert for an empty drained cohort with fresh durable publication and polling', async () => {
  setup();
  expect(await collectWatchdog('dev', now)).toEqual([]);
});
