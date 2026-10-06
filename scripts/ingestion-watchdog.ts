/** Independent operator alerts: never depend on the ingestion cron to report its own death. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admissionV2OwnsCatalogWrites } from '../src/ingestion-v2/admission/types.js';
import { SOURCE_CADENCE_SLIP_MS } from '../src/source-poll-cadence.js';

export type Signal = { id: string; detail: string };
type Marker = { key: string; value: string; updated_at: string };
type Pointer = { schemaVersion: number; generatedAt: string; version: string; count: number; groupPages: Record<string, number> };
const minute = 60_000;
const reportUrl = 'https://github.com/JDKrasnick/Ntern/actions/workflows/ingestion-v2-cost-gate.yml';
const descriptions: Record<string, string> = {
  'monitor-unavailable': 'The independent monitor could not complete a Cloudflare/D1 read. Inspect its latest report and credentials; do not assume the service is healthy.',
  'public-catalog-unavailable': 'The public catalog did not return a valid HTTP 200 catalog response.',
  'scheduled-work-stalled': 'A required durable cron completion marker is missing, malformed, failed, or older than 30 minutes. Inspect scheduled dispatch and Worker termination.',
  'catalog-projection-unhealthy': 'The R2 catalog is missing, stale, incomplete, corrupt, or differs from the durable D1 manifest. Inspect both publisher phases and D1 fallback.',
  'worker-errors': 'Cloudflare reports a failed execution or runtime error on the active ingestion stack.',
  'worker-memory-headroom': 'An active ingestion isolate has memory p99 above 120 MiB. Inspect resource trends before it silently terminates.',
  'queue-failures-unresolved': 'An unresolved queue failure has survived at least 30 minutes. Inspect the failure ledger, retries and DLQ; do not purge messages.',
  'admission-progress-stalled': 'An active V2 source has due rows older than one hour, handoffs older than 15 minutes, or processing leases expired for 15 minutes.',
  'source-polling-stalled': 'A configured active V2 owner has missed two published polling cadences or has not succeeded for two hours.',
  'test-email': 'This is the requested operator-alert delivery test. No ingestion, catalog, rollout flags or customer notifications were changed.',
};

export function markerSignals(markers: Marker[], required: string[], now: Date): Signal[] {
  return required.flatMap(key => {
    const row = markers.find(marker => marker.key === key);
    let value: { status?: string; observedAt?: string } = {};
    try { value = JSON.parse(row?.value ?? '{}'); } catch { /* Report malformed state. */ }
    const age = now.getTime() - Date.parse(value.observedAt ?? row?.updated_at ?? '');
    return value.status === 'complete' && Number.isFinite(age) && age >= -minute && age <= 30 * minute
      ? [] : [{ id: 'scheduled-work-stalled', detail: `${key}: status=${value.status ?? 'missing'}, ageMinutes=${Number.isFinite(age) ? Math.round(age / minute) : 'invalid'}` }];
  });
}

export function validateCatalogPages(pointer: Pointer, pages: unknown[], manifest?: string[]): Signal[] {
  const invalid = (detail: string) => [{ id: 'catalog-projection-unhealthy', detail }];
  if (pointer.schemaVersion !== 1 || !Number.isSafeInteger(pointer.count) || pointer.count < 0 || pointer.count > 10_000
    || !/^[a-f0-9]{20}$/.test(pointer.version) || !pointer.groupPages || typeof pointer.groupPages !== 'object'
    || Object.keys(pointer.groupPages).length !== pointer.count || pages.length !== Math.ceil(pointer.count / 100)) return invalid('invalid R2 pointer or page count');
  const hash = createHash('sha256');
  const seen = new Set<string>();
  const keys = new Set(manifest);
  for (const [index, page] of pages.entries()) {
    if (!Array.isArray(page) || page.length !== Math.min(100, pointer.count - index * 100)) return invalid(`page ${index} missing or incomplete`);
    for (const group of page) {
      const id = group?.group?.groupId;
      if (typeof id !== 'string' || seen.has(id) || pointer.groupPages[id] !== index) return invalid(`page ${index} identity/index mismatch`);
      seen.add(id);
      const serialized = JSON.stringify(group);
      hash.update(serialized).update('\0');
      if (manifest && !keys.delete(`GROUP#${id}#${createHash('sha256').update(serialized).digest('hex').slice(0, 20)}`)) return invalid(`page ${index} differs from D1 manifest`);
    }
  }
  if (hash.digest('hex').slice(0, 20) !== pointer.version || (manifest && keys.size)) return invalid('R2 aggregate hash or D1 membership mismatch');
  return [];
}

export function alertRequest(environment: string, signal: string, now: Date, from: string, to: string) {
  if (!descriptions[signal]) throw new Error('Unknown watchdog signal');
  const window = Math.floor(now.getTime() / (6 * 60 * minute));
  // Identical key MUST have identical payload. Live counts/timestamps remain in
  // the report, so provider retries cannot fail with a payload-conflict 409.
  return {
    key: createHash('sha256').update(`ingestion-watchdog:${environment}:${signal}:${window}`).digest('hex'),
    body: { from, to: [to], subject: `[Ntern ${environment}] ${signal}`,
      text: `${descriptions[signal]}\n\nLatest evidence and counts: ${reportUrl}\nAlert window: ${new Date(window * 6 * 60 * minute).toISOString()}\n\nRepeated notices for this condition are limited to one per six-hour window. Monitor failure is an alert, not a healthy result.` },
  };
}

export async function sendAlerts(signals: Signal[], environment: string, now: Date,
  config: { from: string; to: string; key: string }, fetcher: typeof fetch = fetch): Promise<number> {
  let accepted = 0;
  for (const signal of new Set(signals.map(signal => signal.id))) {
    const request = alertRequest(environment, signal, now, config.from, config.to);
    const response = await fetcher('https://api.resend.com/emails', { method: 'POST',
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': request.key },
      body: JSON.stringify(request.body), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Operator email rejected: HTTP ${response.status}`);
    accepted++;
  }
  return accepted;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function collectWatchdog(environment: 'production' | 'dev', now: Date, deadline = AbortSignal.timeout(4 * minute)): Promise<Signal[]> {
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const account = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const worker = environment === 'production' ? 'intern-notifs-ingestion' : 'intern-notifs-dev-ingestion';
  const api = environment === 'production' ? 'https://api.ntern.app' : 'https://intern-notifs-dev.jdkrasnick.workers.dev';
  const bucket = environment === 'production' ? 'intern-notifs-documents' : 'intern-notifs-dev-documents';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const requestSignal = () => AbortSignal.any([deadline, AbortSignal.timeout(20_000)]);
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(base + path, { headers, signal: requestSignal() });
    if (!response.ok) throw new Error(`Cloudflare read unavailable: HTTP ${response.status}`);
    const body = await response.json() as { success: boolean; result: T };
    if (!response.ok || !body.success) throw new Error(`Cloudflare read unavailable: HTTP ${response.status}`);
    return body.result;
  };
  const settings = await read<{ bindings: Array<{ name: string; text?: string; database_id?: string }> }>(`/workers/scripts/${worker}/settings`);
  const vars = Object.fromEntries(settings.bindings.filter(binding => binding.text !== undefined).map(binding => [binding.name, binding.text! ]));
  const database = settings.bindings.find(binding => binding.name === 'DB')?.database_id;
  if (!database) throw new Error('Worker D1 binding missing');
  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const response = await fetch(`${base}/d1/database/${database}/query`, { method: 'POST', headers,
      body: JSON.stringify({ sql, params }), signal: requestSignal() });
    if (!response.ok) throw new Error(`D1 read unavailable: HTTP ${response.status}`);
    const body = await response.json() as { success: boolean; result: Array<{ results: T[] }> };
    if (!response.ok || !body.success) throw new Error(`D1 read unavailable: HTTP ${response.status}`);
    return body.result[0]?.results ?? [];
  };
  const signals: Signal[] = [];
  const phases = ['maintenance_phase:maintenance:maintenance_complete',
    'maintenance_phase:catalog_projection:catalog_projection_complete',
    'maintenance_phase:catalog_projection_r2:catalog_projection_r2_complete'];
  const isolated = vars.INGESTION_V2_ISOLATED_WORKERS_ENABLED === 'true';
  if (isolated) phases.push('maintenance_phase:admission_v2:dispatch');
  const markers = await query<Marker>(`SELECT key,value,updated_at FROM system_state WHERE key IN (${phases.map(() => '?').join(',')})`, phases);
  signals.push(...markerSignals(markers, phases, now));
  const failures = await query<{ queue_name: string; n: number }>(`SELECT queue_name, COUNT(*) AS n FROM queue_failure_events
    WHERE resolved_at IS NULL AND last_failed_at >= ? AND first_failed_at <= ? GROUP BY queue_name LIMIT 20`,
  [new Date(now.getTime() - 24 * 60 * minute).toISOString(), new Date(now.getTime() - 30 * minute).toISOString()]);
  if (failures.length) signals.push({ id: 'queue-failures-unresolved', detail: JSON.stringify(failures) });
  const publicResponse = await fetch(`${api}/catalog?limit=1`, { signal: requestSignal() });
  let catalog: { groups?: unknown[] } | undefined;
  try { catalog = await publicResponse.json(); } catch { /* Invalid HTTP 200 also alerts. */ }
  if (publicResponse.status !== 200 || !Array.isArray(catalog?.groups)) signals.push({ id: 'public-catalog-unavailable', detail: `HTTP ${publicResponse.status}, validCatalog=${Array.isArray(catalog?.groups)}` });

  const pointerRows = () => query<{ value: string }>("SELECT value FROM catalog_items WHERE pk='CATALOG_PROJECTION' AND sk='CURRENT'");
  const before = (await pointerRows())[0]?.value;
  const d1 = before ? JSON.parse(before) as { schemaVersion: number; version: string; generatedAt: string } : undefined;
  const object = async (key: string): Promise<unknown> => {
    const response = await fetch(`${base}/r2/buckets/${bucket}/objects/${key}`, { headers, signal: requestSignal() });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`R2 read unavailable: HTTP ${response.status}`);
    try { return await response.json(); } catch { return undefined; }
  };
  const pointer = await object('public-catalog/v1/current') as Pointer | undefined;
  // D1 commits at :01 and R2 follows at :04. Allow that bounded handoff, not an
  // indefinitely fresh D1 heartbeat masking a dead publisher.
  const d1Age = d1 ? now.getTime() - Date.parse(d1.generatedAt) : NaN;
  const handoff = Number.isFinite(d1Age) && d1Age >= -minute && d1Age < 5 * minute;
  if (!pointer || pointer.schemaVersion !== 1) {
    if (!handoff) signals.push({ id: 'catalog-projection-unhealthy', detail: 'R2 pointer missing or retired outside the publication grace period' });
  } else if (!Number.isFinite(Date.parse(pointer.generatedAt)) || now.getTime() - Date.parse(pointer.generatedAt) > 30 * minute || now.getTime() - Date.parse(pointer.generatedAt) < -minute) {
    signals.push({ id: 'catalog-projection-unhealthy', detail: 'R2 generation is stale or invalid' });
  } else if (!Number.isSafeInteger(pointer.count) || pointer.count < 0 || pointer.count > 10_000 || !/^[a-f0-9]{20}$/.test(pointer.version)) {
    signals.push({ id: 'catalog-projection-unhealthy', detail: 'R2 pointer exceeds validation bounds' });
  } else {
    const pages: unknown[] = [];
    for (let index = 0; index * 100 < pointer.count; index++) pages.push(await object(`public-catalog/v1/${pointer.version}/${index}`));
    let manifest: string[] | undefined;
    if (d1?.schemaVersion === 6 && d1.generatedAt === pointer.generatedAt) {
      const rows = await query<{ value: string }>("SELECT value FROM catalog_items WHERE pk='CATALOG_PROJECTION#MANIFESTS' AND sk=?", [d1.version]);
      if (!rows[0]) throw new Error('D1 catalog manifest missing');
      manifest = (JSON.parse(rows[0].value) as { keys: string[] }).keys;
      if (!Array.isArray(manifest) || manifest.some(key => typeof key !== 'string')) throw new Error('D1 catalog manifest invalid');
    }
    // An overlapping D1 publication changes the authority during inspection;
    // validate R2's own immutable contents and defer manifest comparison.
    const after = (await pointerRows())[0]?.value;
    signals.push(...validateCatalogPages(pointer, pages, before === after ? manifest : undefined));
    if (before === after && !handoff && (!d1 || d1.generatedAt !== pointer.generatedAt)) signals.push({ id: 'catalog-projection-unhealthy', detail: 'R2 generation does not match the stable D1 generation' });
  }

  const names = isolated ? [worker, worker.replace(/-ingestion$/, '-admission'), worker.replace(/-ingestion$/, '-catalog-publisher')] : [worker];
  const versions = await Promise.all(names.map(async name => {
    const result = await read<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(`/workers/scripts/${name}/deployments`);
    const active = result.deployments[0]?.versions;
    if (!active?.length) throw new Error('Active Worker deployment missing');
    return active.filter(version => version.percentage > 0).map(version => version.version_id);
  }));
  const analytics = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers,
    body: JSON.stringify({ query: `query($account:String!,$since:Time!,$workers:[String!]!,$versions:[String!]!){viewer{accounts(filter:{accountTag:$account}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$since,scriptName_in:$workers,scriptVersion_in:$versions}){dimensions{status scriptVersion}sum{requests errors}quantiles{memoryUsageBytesP99}}}}}`,
      variables: { account, since: new Date(now.getTime() - 60 * minute).toISOString(), workers: names, versions: versions.flat() } }), signal: requestSignal() });
  const runtime = await analytics.json() as { errors?: unknown; data?: { viewer: { accounts: Array<{ workersInvocationsAdaptive: Array<{ dimensions: { status: string }; sum: { errors: number }; quantiles: { memoryUsageBytesP99: number } }> }> } } };
  if (!analytics.ok || runtime.errors || !runtime.data?.viewer.accounts[0]) throw new Error('Worker analytics unavailable');
  for (const row of runtime.data.viewer.accounts[0].workersInvocationsAdaptive) {
    if (row.dimensions.status !== 'success' || row.sum.errors) signals.push({ id: 'worker-errors', detail: `${row.dimensions.status}: ${row.sum.errors} errors` });
    if (row.quantiles.memoryUsageBytesP99 > 120 * 1024 * 1024) signals.push({ id: 'worker-memory-headroom', detail: `${(row.quantiles.memoryUsageBytesP99 / 1024 / 1024).toFixed(1)} MiB p99` });
  }
  const owners = [...new Set((vars.INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST ?? vars.INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST ?? '').split(',').map(id => id.trim()).filter(Boolean))]
    .filter(id => admissionV2OwnsCatalogWrites(vars, id));
  if (owners.length > 50) throw new Error('Owner monitoring exceeds bounded source budget');
  for (const id of owners) {
    const health = await query<{ value: string }>("SELECT value FROM catalog_items WHERE pk=? AND sk='HEALTH'", [`SOURCE#${id}`]);
    const source = health[0] ? JSON.parse(health[0].value) as { sourceStatus?: string; lastAttemptAt?: string; lastSuccessAt?: string } : undefined;
    if (source?.sourceStatus === 'paused' || source?.sourceStatus === 'disabled') continue;
    if (!source || !Number.isFinite(Date.parse(source.lastAttemptAt ?? '')) || now.getTime() - Date.parse(source.lastAttemptAt!) > SOURCE_CADENCE_SLIP_MS
      || !Number.isFinite(Date.parse(source.lastSuccessAt ?? '')) || now.getTime() - Date.parse(source.lastSuccessAt!) > 120 * minute) signals.push({ id: 'source-polling-stalled', detail: id });
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ingestion_rows WHERE source_id=? AND
      ((state='queued' AND (retry_at IS NULL OR retry_at<=?) AND updated_at<?)
      OR (state='processing' AND lease_expires_at<?))`,
    [id, now.toISOString(), new Date(now.getTime() - 60 * minute).toISOString(), new Date(now.getTime() - 15 * minute).toISOString()]);
    const handoffs = await query<{ n: number }>('SELECT COUNT(*) AS n FROM ingestion_admission_handoffs WHERE source_id=? AND acknowledged_at IS NULL AND dispatched_at<?', [id, new Date(now.getTime() - 15 * minute).toISOString()]);
    if (rows[0]?.n || handoffs[0]?.n) signals.push({ id: 'admission-progress-stalled', detail: `${id}: ${rows[0]?.n ?? 0} stalled rows, ${handoffs[0]?.n ?? 0} stale handoffs` });
  }
  return signals;
}

async function main(): Promise<number> {
  const environment = process.env.WATCHDOG_ENVIRONMENT ?? 'production';
  if (environment !== 'production' && environment !== 'dev') throw new Error('Invalid watchdog environment');
  const now = new Date();
  const dryRun = process.argv.includes('--dry-run');
  let signals: Signal[];
  try { signals = process.argv.includes('--test-email') ? [{ id: 'test-email', detail: 'operator delivery test' }] : await collectWatchdog(environment, now); }
  catch (error) { signals = [{ id: 'monitor-unavailable', detail: error instanceof Error ? error.message.slice(0, 200) : 'Independent probe unavailable' }]; }
  const output = process.env.WATCHDOG_REPORT ?? `.context/verification/watchdog/${environment}.json`;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ environment, capturedAt: now.toISOString(), signals }, null, 2) + '\n');
  console.log(JSON.stringify({ environment, signalCount: signals.length, signals, dryRun }));
  if (!dryRun && signals.length) {
    const accepted = await sendAlerts(signals, environment, now, {
      from: requireEnv('AUTH_FROM_EMAIL'), to: requireEnv('ADMISSION_SUPPORT_RECIPIENT'), key: requireEnv('MONITOR_RESEND_API_KEY'),
    });
    console.log(JSON.stringify({ environment, operatorAlertsAccepted: accepted }));
  }
  return signals.length && !process.argv.includes('--test-email') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('Independent watchdog or operator email delivery failed; inspect the retained report and secret configuration.');
    process.exitCode = 1;
  });
}
