import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { alertRequest, collectWatchdog, markerSignals, sendAlerts, validateCatalogPages } from '../scripts/ingestion-watchdog.js';

const now = new Date('2026-10-06T18:38:00Z');
const generatedAt = '2026-10-06T18:31:00Z';
const groups = Array.from({ length: 101 }, (_, index) => ({ group: { groupId: `group-${index}` }, roles: [{ open: true }] }));
const digest = createHash('sha256');
for (const group of groups) digest.update(JSON.stringify(group)).update('\0');
const pointer = { schemaVersion: 1, version: digest.digest('hex').slice(0, 20), generatedAt, count: groups.length,
  groupPages: Object.fromEntries(groups.map((group, index) => [group.group.groupId, Math.floor(index / 100)])) };
const pages = [groups.slice(0, 100), groups.slice(100)];
const manifest = groups.map(group => `GROUP#${group.group.groupId}#${createHash('sha256').update(JSON.stringify(group)).digest('hex').slice(0, 20)}`);
const phases = ['maintenance_phase:maintenance:maintenance_complete', 'maintenance_phase:catalog_projection:catalog_projection_complete',
  'maintenance_phase:catalog_projection_r2:catalog_projection_r2_complete', 'maintenance_phase:admission_v2:dispatch'];
const markers = phases.map(key => ({ key, value: JSON.stringify({ status: 'complete', observedAt: generatedAt }), updated_at: generatedAt }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(['missing', 'failed', 'malformed', 'old', 'future'])('detects a silently %s completion heartbeat without using error logs', fault => {
  const altered = structuredClone(markers);
  if (fault === 'missing') altered.pop();
  if (fault === 'failed') altered[0]!.value = JSON.stringify({ status: 'failed', observedAt: generatedAt });
  if (fault === 'malformed') altered[0]!.value = '{';
  if (fault === 'old') altered[0]!.value = JSON.stringify({ status: 'complete', observedAt: '2026-10-06T17:00:00Z' });
  if (fault === 'future') altered[0]!.value = JSON.stringify({ status: 'complete', observedAt: '2026-10-07T17:00:00Z' });
  expect(markerSignals(altered, phases, now)).toHaveLength(1);
  expect(markerSignals(markers, phases, now)).toEqual([]);
});

it.each(['missing-page', 'truncated-page', 'changed-role', 'duplicate-group', 'wrong-index', 'wrong-manifest', 'wrong-hash'])('detects silent catalog corruption: %s', fault => {
  const p = structuredClone(pointer), values: unknown[] = structuredClone(pages), keys = [...manifest];
  if (fault === 'missing-page') values[1] = undefined;
  if (fault === 'truncated-page') values[1] = [];
  if (fault === 'changed-role') (values[1] as typeof groups)[0]!.roles[0]!.open = false;
  if (fault === 'duplicate-group') (values[1] as typeof groups)[0]!.group.groupId = 'group-0';
  if (fault === 'wrong-index') p.groupPages['group-100'] = 0;
  if (fault === 'wrong-manifest') keys[100] = 'GROUP#wrong#digest';
  if (fault === 'wrong-hash') p.version = 'a'.repeat(20);
  expect(validateCatalogPages(p, values, keys)[0]?.id).toBe('catalog-projection-unhealthy');
  expect(validateCatalogPages(pointer, pages, [...manifest].reverse())).toEqual([]);
});

function mockCloudflare(fault = 'healthy') {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
  const vars = { INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'true', INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true',
    INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: 'source', INGESTION_V2_ADMISSION_ENABLED: 'true', INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: 'source',
    INGESTION_V2_CATALOG_WRITER_ENABLED: 'true', INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: 'source', INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: 'source' };
  if (fault === 'large-cohort') {
    const owners = Array.from({ length: 230 }, (_, index) => `source-${index}`).join(',');
    vars.INGESTION_V2_SHADOW_SOURCE_ALLOWLIST = vars.INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST = vars.INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST = vars.INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST = owners;
  }
  const queryHistory: Array<{ sql: string; params: unknown[] }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const result = (value: unknown) => Response.json({ success: true, result: value });
    if (fault === 'access-denied') return new Response('', { status: 403 });
    if (url.endsWith('/settings')) return result({ bindings: [{ name: 'DB', database_id: 'database' }, ...Object.entries(vars).map(([name, text]) => ({ name, text }))] });
    if (url.endsWith('/query')) {
      const query = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] }; queryHistory.push(query);
      let rows: unknown[] = [];
      if (query.sql.includes('system_state')) rows = markers;
      else if (query.sql.includes('queue_failure_events')) rows = fault === 'queue-failure' ? [{ queue_name: 'destination', n: 1 }] : [];
      else if (query.sql.includes("sk='CURRENT'")) rows = [{ value: JSON.stringify({ ...pointer, schemaVersion: 6,
        generatedAt: fault === 'future-generation' ? '2026-10-07T18:31:00Z' : fault === 'publication-grace' ? '2026-10-06T18:37:00Z' : generatedAt }) }];
      else if (query.sql.includes('MANIFESTS')) rows = fault === 'missing-manifest' ? [] : [{ value: JSON.stringify({ keys: manifest }) }];
      else if (query.sql.includes("sk='HEALTH'")) rows = query.params.map(pk => ({ pk, value: JSON.stringify({ sourceStatus: fault === 'paused' ? 'paused' : 'active', lastAttemptAt: generatedAt,
        lastSuccessAt: fault === 'stale-source' ? 'invalid' : generatedAt }) }));
      else if (query.sql.includes('ingestion_rows') || query.sql.includes('ingestion_admission_handoffs')) rows = [{ source_id: 'source', n: fault === 'stuck-admission' ? 1 : 0 }];
      return result([{ results: rows }]);
    }
    if (url.includes('/catalog?')) return fault === 'invalid-public-response' ? Response.json({ message: 'not a catalog' }) : Response.json({ groups: [groups[0]] });
    if (url.includes('/objects/')) {
      if (url.endsWith('/current')) return ['missing-pointer', 'publication-grace', 'future-generation'].includes(fault) ? new Response('', { status: 404 })
        : Response.json(fault === 'streamed-pointer' ? { ...pointer, pageVersion: 'a'.repeat(20) } : pointer);
      if (fault === 'streamed-pointer') expect(url).toContain(`/objects/public-catalog/v1/${'a'.repeat(20)}/`);
      return Response.json(pages[Number(url.split('/').pop())]);
    }
    if (url.endsWith('/deployments')) return result({ deployments: [{ versions: [{ version_id: 'active-version', percentage: 100 }] }] });
    if (url.endsWith('/graphql')) {
      const request = JSON.parse(String(init?.body));
      expect(request.variables.versions).toEqual(['active-version', 'active-version', 'active-version']);
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ dimensions: { status: fault === 'oom' ? 'exceededMemory' : fault.startsWith('client-disconnect') ? 'clientDisconnected' : fault === 'canceled' ? 'canceled' : 'success' },
        sum: { errors: ['oom', 'client-disconnect-error'].includes(fault) ? 1 : 0 }, quantiles: { memoryUsageBytesP99: (fault === 'headroom' ? 121 : 80) * 1024 * 1024 } }] }] } } });
    }
    throw new Error(`Unexpected monitor request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return queryHistory;
}

it.each([
  ['healthy', undefined], ['streamed-pointer', undefined], ['queue-failure', 'queue-failures-unresolved'], ['invalid-public-response', 'public-catalog-unavailable'],
  ['missing-pointer', 'catalog-projection-unhealthy'], ['stale-source', 'source-polling-stalled'], ['stuck-admission', 'admission-progress-stalled'],
  ['oom', 'worker-errors'], ['headroom', 'worker-memory-headroom'],
  ['client-disconnect', undefined], ['client-disconnect-error', 'worker-errors'], ['canceled', 'worker-errors'],
  ['large-cohort', undefined],
  ['publication-grace', undefined], ['future-generation', 'catalog-projection-unhealthy'],
])('checks the full independent read path: %s', async (fault, expected) => {
  const queries = mockCloudflare(fault);
  const signals = await collectWatchdog('dev', now);
  expect(signals.map(signal => signal.id)).toEqual(expected ? [expected] : []);
  expect(queries.every(query => !/^\s*(INSERT|UPDATE|DELETE)/i.test(query.sql))).toBe(true);
  if (fault === 'large-cohort') {
    const healthReads = queries.filter(query => query.sql.includes("sk='HEALTH'"));
    expect(healthReads).toHaveLength(10);
    expect(healthReads.every(query => query.params.length <= 25)).toBe(true);
    expect(healthReads.flatMap(query => query.params)).toHaveLength(230);
  }
});

it.each(['../current', 'A'.repeat(20)])('rejects an invalid private page namespace: %s', pageVersion => {
  expect(validateCatalogPages({ ...pointer, pageVersion }, pages, manifest)[0]?.id).toBe('catalog-projection-unhealthy');
  expect(validateCatalogPages({ ...pointer, pageVersion: 'a'.repeat(20) }, pages, manifest)).toEqual([]);
});

it('reports lost API access instead of treating missing data as healthy', async () => {
  mockCloudflare('access-denied');
  await expect(collectWatchdog('production', now)).rejects.toThrow('Cloudflare read unavailable');
});

it('fails closed on a missing durable manifest', async () => {
  mockCloudflare('missing-manifest');
  await expect(collectWatchdog('production', now)).rejects.toThrow('D1 catalog manifest missing');
});

it('does not mistake an intentionally paused owner or provider cooldown for an active stall', async () => {
  const queries = mockCloudflare('paused');
  expect(await collectWatchdog('dev', now)).toEqual([]);
  expect(queries.some(query => query.sql.includes('ingestion_rows'))).toBe(false);
});

it('uses stable payloads for retries and separates environment, condition and reminder window', () => {
  const request = alertRequest('production', 'worker-errors', now, 'sender@example.test', 'operator@example.test');
  expect(alertRequest('production', 'worker-errors', new Date(now.getTime() + 60_000), 'sender@example.test', 'operator@example.test')).toEqual(request);
  expect(alertRequest('dev', 'worker-errors', now, 'sender@example.test', 'operator@example.test').key).not.toBe(request.key);
  expect(alertRequest('production', 'worker-memory-headroom', now, 'sender@example.test', 'operator@example.test').key).not.toBe(request.key);
  expect(alertRequest('production', 'worker-errors', new Date(now.getTime() + 6 * 60 * 60_000), 'sender@example.test', 'operator@example.test').key).not.toBe(request.key);
});

it('sends no healthy email, deduplicates signals, and propagates delivery failure', async () => {
  const fetcher = vi.fn(async () => Response.json({ id: 'email' }));
  const config = { from: 'sender@example.test', to: 'operator@example.test', key: 'email-test-key' };
  expect(await sendAlerts([], 'dev', now, config, fetcher)).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await sendAlerts([{ id: 'worker-errors', detail: 'first' }, { id: 'worker-errors', detail: 'second' }], 'dev', now, config, fetcher)).toBe(1);
  expect(fetcher).toHaveBeenCalledOnce();
  await expect(sendAlerts([{ id: 'worker-errors', detail: 'failure' }], 'dev', now, config,
    vi.fn(async () => new Response('', { status: 429 })))).rejects.toThrow('HTTP 429');
});
