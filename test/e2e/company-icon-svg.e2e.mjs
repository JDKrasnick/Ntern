/**
 * The uploaded board logo, end to end.
 *
 * Two things about this feature can only be true here, and nowhere else in the test
 * suite, so the suite proves both against the **compiled bundle** — the artifact the
 * OpenTofu upload sends:
 *
 *   1. it loads in the Worker runtime with its `resvg.wasm` module part resolved by
 *      name, so an import and a part name that disagree fail in CI rather than at
 *      deploy;
 *   2. the dedicated icon cron rasterizes the employer's SVG board logo and
 *      stores the PNG, in the real D1 and R2 bindings, driven through the real
 *      scheduled handler.
 *
 * The outbound internet is served by the test — the sweep's DNS-over-HTTPS lookups,
 * the Ashby posting page, and the board logo host all answer from fixtures — so the
 * run needs no network and cannot drift with a live board. Miniflare 5 has no
 * outbound interceptor, so the cron is dispatched from Node, where `fetch` is
 * replaced; the artifact itself is the built bundle in both parts.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { register } from 'node:module';
import { after, before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

register('./wasm-module-loader.mjs', import.meta.url);

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const workerName = 'intern-notifs-e2e-icon-svg';
const bundleDirectory = join(repositoryRoot, 'cloudflare/dist/ingestion');
// Keep this at the newest date supported by the workerd version in package-lock.json.
const localCompatibilityDate = '2026-08-27';

const employerId = 'acme';
const applicationUrl = 'https://jobs.ashbyhq.com/acme/1cea9d45-0000-4000-8000-000000000000';
const logoUrl = 'https://app.ashbyhq.com/api/images/org-theme-logo/1cea/9d45.png';
const postingHtml = '<!doctype html><html><head><title>Software Engineering Intern at Acme</title>'
  + `<script>{"logoSquareImageUrl":"${logoUrl}"}</script></head><body>Open role</body></html>`;
/**
 * Ashby answers an SVG from a `.png` path, which is the case that reaches the
 * rasterizer: a square mark, published as a document the API may never serve.
 */
const logoDocument = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<rect width="64" height="64" fill="#123456"/><path d="M12 12h40v40H12z" fill="#0af"/></svg>';
const instant = '2026-09-01T00:00:00.000Z';
const cron = '6-56/10 * * * *';
const seenOutbound = [];
const realFetch = globalThis.fetch;

let worker;
let database;
let documents;

/**
 * The internet, as this suite needs it: DoH answers for the host the sweep validates,
 * the posting page, and the board logo. Anything else is a bug in the test rather
 * than a live request.
 */
function internet(request) {
  // The Worker's fetch client passes a URL for a validated link and a string for a
  // provider or asset request, so the fixture reads both.
  const requested = request instanceof URL ? request.href
    : typeof request === 'string' ? request
      : request.url;
  const url = new URL(requested);
  seenOutbound.push(url.href);
  // Provider lookups are always asked — Brandfetch's search needs no credential — and
  // this employer's board publishes its mark directly, so both providers miss cleanly.
  if (url.hostname === 'api.logo.dev' || url.hostname === 'api.brandfetch.io') {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  if (url.hostname === 'cloudflare-dns.com' && url.pathname === '/dns-query') {
    const name = url.searchParams.get('name') ?? '';
    const type = url.searchParams.get('type') ?? 'A';
    return Promise.resolve(Response.json(type === 'A'
      ? { Status: 0, Answer: [{ name, type: 1, TTL: 60, data: '93.184.216.34' }] }
      : { Status: 0, Answer: [] }));
  }
  if (url.href === applicationUrl) return Promise.resolve(new Response(postingHtml, { headers: { 'content-type': 'text/html' } }));
  if (url.href === logoUrl) return Promise.resolve(new Response(logoDocument, { headers: { 'content-type': 'image/svg+xml' } }));
  return Promise.resolve(new Response('unexpected outbound request', { status: 502 }));
}

function queueStub() {
  return { async send() {}, async sendBatch() {}, async metrics() { return { backlogCount: 0, backlogBytes: 0 }; } };
}

/** The bindings the icon cron touches, so no step fails for a missing one. */
function cronEnvironment() {
  return {
    DB: database,
    DOCUMENTS: documents,
    SHADOW_EXTRACTION_ARTIFACTS: documents,
    DEPLOYMENT_ROLE: 'ingestion',
    PUBLIC_API_URL: 'https://api.example.test',
    IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED: 'false',
    TRUSTED_COMMUNITY_CATALOG_ENABLED: 'false',
    ...Object.fromEntries([
      'GREENHOUSE_QUEUE', 'LEVER_QUEUE', 'ASHBY_QUEUE', 'GITHUB_QUEUE', 'GMAIL_QUEUE',
      'DESTINATION_VERIFICATION_QUEUE', 'DESTINATION_VERIFICATION_DLQ', 'SHADOW_EXTRACTION_QUEUE',
      'SHADOW_EXTRACTION_DLQ', 'RESUME_JOB_IMPORT_QUEUE', 'GREENHOUSE_DLQ', 'LEVER_DLQ',
      'ASHBY_DLQ', 'GITHUB_DLQ', 'GMAIL_DLQ',
    ].map((name) => [name, queueStub()])),
  };
}

async function applyMigrations(d1) {
  const migrationsDirectory = join(repositoryRoot, 'cloudflare/migrations');
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDirectory, migration), 'utf8');
    await d1.batch(splitSqlQuery(sql).map((statement) => d1.prepare(statement)));
  }
}

before(async () => {
  worker = new Miniflare({
    workers: [{
      config: {
        name: workerName,
        type: 'worker',
        compatibilityDate: localCompatibilityDate,
        compatibilityFlags: ['nodejs_compat'],
        manifest: {
          mainModule: 'ingestion-worker.js',
          modulesRoot: bundleDirectory,
          modules: {
            'ingestion-worker.js': { type: 'esm', contents: await readFile(join(bundleDirectory, 'ingestion-worker.js'), 'utf8') },
            // The module part the Worker imports as `./resvg.wasm`.
            'resvg.wasm': { type: 'wasm', contents: await readFile(join(bundleDirectory, 'resvg.wasm')) },
          },
        },
        env: {
          INTERNAL_SERVICE_SECRET: { type: 'text', value: 'e2e-internal-service-secret' },
          OPERATIONS_SHARED_SECRET: { type: 'text', value: 'e2e-operations-secret' },
          DEPLOYMENT_ROLE: { type: 'text', value: 'ingestion' },
          DB: { type: 'd1', id: 'intern-notifs-e2e-icon-svg' },
          DOCUMENTS: { type: 'r2', name: 'intern-notifs-e2e-icon-svg-documents' },
        },
      },
    }],
  });
  await worker.ready;
  database = await worker.getD1Database('DB', workerName);
  documents = await worker.getR2Bucket('DOCUMENTS', workerName);
  await applyMigrations(database);
  // One employer due for an icon, through the same task row admission would record.
  await database.batch([
    database.prepare(`INSERT INTO canonical_employers (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES (?, 'Acme', ?, 'e2e', ?, ?)`).bind(employerId, instant, instant, instant),
    database.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES ('company_icon_resolution', ?, ?)`)
      .bind(JSON.stringify({ mode: 'resolve', maxPerSweep: 5 }), instant),
    database.prepare(`INSERT INTO employer_icon_resolutions
      (id, canonical_employer_id, evidence_fingerprint, status, evidence_json, attempts, next_retry_at, created_at, updated_at)
      VALUES ('e2e-icon-task', ?, 'e2e-fingerprint', 'retryable', ?, 0, ?, ?, ?)`).bind(
      employerId,
      JSON.stringify({
        displayName: 'Acme', roleTitle: 'Software Engineering Intern', applicationUrl,
        provider: 'ashby', tenant: 'acme', sourceId: 'e2e', provenance: 'official-ats',
      }), instant, instant, instant),
  ]);
});

after(async () => {
  await worker?.dispose();
});

const dump = async (sql) => (await database.prepare(sql).all()).results;

test('loads the compiled bundle and its wasm module part in the Worker runtime', async () => {
  const fetcher = await worker.getWorker(workerName);
  const response = await fetcher.fetch('https://ingestion.example.test/internal/deployment/ingestion', {
    headers: { 'X-InternNotifs-Service-Key': 'e2e-internal-service-secret' },
  });
  // A module graph whose wasm import and part name disagree fails to load at all, so
  // serving this route is the proof that the uploaded artifact is coherent.
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { role: 'ingestion', version: null });
});

test('renders the employer’s SVG board logo from the dedicated icon cron and stores the PNG', async () => {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  globalThis.fetch = internet;
  try {
    await builtWorker.scheduled(
      { cron, scheduledTime: Date.now(), noRetry() {} },
      cronEnvironment(),
      { waitUntil() {}, passThroughOnException() {} },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  const [employer] = await dump("SELECT icon_key, icon_source FROM canonical_employers WHERE id = 'acme'");
  assert.equal(employer.icon_source, 'platform');
  assert.match(employer.icon_key, /^company-icons\/acme\/platform-[0-9a-f]{16}\.png$/u);

  // The stored bytes are a PNG the rasterizer produced at the icon width, not the
  // publisher's SVG — which is the whole point of shipping the module.
  const object = await documents.get(employer.icon_key);
  assert.ok(object, 'the rendered icon must exist in R2');
  assert.equal(object.httpMetadata?.contentType, 'image/png');
  const bytes = new Uint8Array(await object.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(view.getUint32(16), 256);
  assert.equal(view.getUint32(20), 256);
  assert.ok(!new TextDecoder().decode(bytes).includes('<svg'), 'the document must never be stored');

  // The sweep read the posting page and its board logo, and — beyond the provider
  // lookups every employer gets, including the backfilled ones — nothing else on the web.
  assert.ok(seenOutbound.includes(applicationUrl), 'the sweep must read the posting');
  assert.ok(seenOutbound.includes(logoUrl), 'the sweep must read the board logo');
  assert.deepEqual(
    seenOutbound.filter((url) => !url.startsWith('https://cloudflare-dns.com/')
      && !url.startsWith('https://api.logo.dev/') && !url.startsWith('https://api.brandfetch.io/')),
    [applicationUrl, logoUrl],
  );

  const [resolution] = await dump("SELECT status, selected_domain FROM employer_icon_resolutions WHERE canonical_employer_id = 'acme'");
  // The board logo and the employer's domain are separate facts: with no provider
  // configured the domain stays undecided and the employer renders a monogram for it,
  // while the icon the employer published is already stored and served.
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected_domain, null);
});

test('resolves a reviewed Workday tenant from a provider logo despite an empty ATS shell', async () => {
  const id = 'nxp-reviewed';
  const url = 'https://nxp.wd3.myworkdayjobs.com/careers/job/Intern_R-123';
  const [acme] = await dump("SELECT icon_key FROM canonical_employers WHERE id = 'acme'");
  const png = new Uint8Array(await (await documents.get(acme.icon_key)).arrayBuffer());
  await database.batch([
    database.prepare(`INSERT INTO canonical_employers (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES (?, 'NXP Semiconductors', ?, 'reviewed-source-registry', ?, ?)`).bind(id, instant, instant, instant),
    database.prepare("UPDATE system_state SET value = ? WHERE key = 'company_icon_resolution'")
      .bind(JSON.stringify({ mode: 'resolve', maxPerSweep: 1, logoDevRetentionLicensedAt: instant })),
    database.prepare(`INSERT INTO employer_icon_resolutions
      (id, canonical_employer_id, evidence_fingerprint, status, evidence_json, attempts, next_retry_at, created_at, updated_at)
      VALUES ('nxp-task', ?, 'nxp-fingerprint', 'retryable', ?, 0, ?, ?, ?)`).bind(id,
      JSON.stringify({ displayName: 'NXP Semiconductors', roleTitle: 'Software Intern', applicationUrl: url,
        provider: 'workday', tenant: 'nxp', sourceId: 'reviewed-source', provenance: 'official-ats' }),
      '1970-01-01T00:00:00.000Z', instant, instant),
  ]);
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  const calls = [];
  globalThis.fetch = async (request) => {
    const href = request instanceof URL ? request.href : typeof request === 'string' ? request : request.url;
    const parsed = new URL(href);
    calls.push(href);
    if (href === url) return new Response('<html><title>Workday</title></html>', { headers: { 'content-type': 'text/html' } });
    if (parsed.hostname === 'api.logo.dev') return Response.json([{ name: 'NXP Semiconductors', domain: 'nxp.com' }]);
    if (parsed.hostname === 'img.logo.dev') return new Response(png, { headers: { 'content-type': 'image/png' } });
    if (parsed.hostname === 'nxp.com') return new Response(null, { status: 403 });
    return internet(request);
  };
  try {
    await builtWorker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} }, {
      ...cronEnvironment(), LOGO_DEV_TOKEN: 'fixture-search-token', LOGO_DEV_IMAGE_TOKEN: 'fixture-image-token',
    }, { waitUntil() {}, passThroughOnException() {} });
  } finally { globalThis.fetch = realFetch; }
  const [employer] = await dump("SELECT icon_key, icon_source, website_domain FROM canonical_employers WHERE id = 'nxp-reviewed'");
  assert.equal(employer.website_domain, 'nxp.com');
  assert.equal(employer.icon_source, 'logo-dev');
  assert.ok(await documents.get(employer.icon_key), 'the provider image must be retained in real R2');
  const [task] = await dump("SELECT status, evidence_json FROM employer_icon_resolutions WHERE id = 'nxp-task'");
  assert.equal(task.status, 'resolved');
  assert.equal(JSON.parse(task.evidence_json).provenance, 'official-ats');
  assert.ok(calls.includes(url));
  assert.ok(!calls.some((href) => href.includes('api.openai.com')), 'reviewed ATS identity must resolve without a model');
});

test('backfills and serves a reviewed community role with no canonical employer', async () => {
  const url = 'https://zillow.wd5.myworkdayjobs.com/en-US/Zillow_Group_External/job/Intern_R123';
  const [acme] = await dump("SELECT icon_key FROM canonical_employers WHERE id = 'acme'");
  const png = new Uint8Array(await (await documents.get(acme.icon_key)).arrayBuffer());
  await database.batch([
    database.prepare(`INSERT INTO catalog_items (pk, sk, kind, value) VALUES
      ('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection', '{"version":"independent-icons"}'),
      ('CATALOG_PROJECTION#MANIFESTS', 'independent-icons', 'catalog-projection', '{"keys":["zillow"]}')`),
    database.prepare(`INSERT INTO catalog_items (pk, sk, kind, value) VALUES
      ('CATALOG_PROJECTION#GROUPS', 'zillow', 'catalog-projection', ?)`)
      .bind(JSON.stringify({ group: { roleCount: 1, featuredRole: {
        company: 'Zillow', title: 'Applied Scientist Intern', officialApplyUrl: url,
        sourceReferences: [{ sourceId: 'reviewed-community', provenance: 'reviewed-community' }],
      } } })),
  ]);
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  globalThis.fetch = async (request) => {
    const href = request instanceof URL ? request.href : typeof request === 'string' ? request : request.url;
    const parsed = new URL(href);
    if (href === url) return new Response('<html><title>Workday</title></html>', { headers: { 'content-type': 'text/html' } });
    if (parsed.hostname === 'api.logo.dev') return Response.json([{ name: 'Zillow', domain: 'zillow.com' }]);
    if (parsed.hostname === 'img.logo.dev') return new Response(png, { headers: { 'content-type': 'image/png' } });
    if (parsed.hostname === 'zillow.com') return new Response(null, { status: 403 });
    return internet(request);
  };
  try {
    await builtWorker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} }, {
      ...cronEnvironment(), LOGO_DEV_TOKEN: 'fixture-search-token', LOGO_DEV_IMAGE_TOKEN: 'fixture-image-token',
    }, { waitUntil() {}, passThroughOnException() {} });
    const [icon] = await dump("SELECT id, icon_key, website_domain FROM company_icon_identities WHERE display_name = 'Zillow'");
    assert.match(icon.id, /^icon-v1-[a-f0-9]{32}$/u);
    assert.equal(icon.website_domain, 'zillow.com');
    assert.ok(await documents.get(icon.icon_key));
    assert.deepEqual(await dump("SELECT id FROM canonical_employers WHERE display_name = 'Zillow'"), []);
    globalThis.fetch = realFetch;
    const fetcher = await worker.getWorker(workerName);
    const response = await fetcher.fetch(`https://api.example.test/company-icons/${icon.id}`, {
      headers: { 'X-InternNotifs-Service-Key': 'e2e-internal-service-secret' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally { globalThis.fetch = realFetch; }
});

test('discovers a new Workday company and serves its declared JPEG logo without a domain', async () => {
  const { default: sharp } = await import('sharp');
  const jpeg = await sharp({create:{width:96,height:96,channels:3,background:'#164e63'}}).jpeg().toBuffer();
  const url = 'https://generictenant.wd5.myworkdayjobs.com/en-US/robotics/job/City/Intern_P123';
  const logo = 'https://generictenant.wd5.myworkdayjobs.com/robotics/assets/logo';
  await database.batch([
    database.prepare(`UPDATE catalog_items SET value='{"version":"new-workday"}' WHERE pk='CATALOG_PROJECTION' AND sk='CURRENT'`),
    database.prepare(`INSERT INTO catalog_items(pk,sk,kind,value) VALUES
      ('CATALOG_PROJECTION#MANIFESTS','new-workday','catalog-projection','{"keys":["zz-new-workday"]}')`),
    database.prepare(`INSERT INTO catalog_items(pk,sk,kind,value) VALUES ('CATALOG_PROJECTION#GROUPS','zz-new-workday','catalog-projection',?)`)
      .bind(JSON.stringify({group:{roleCount:1,featuredRole:{company:'Northstar Robotics',title:'Software Intern',officialApplyUrl:url,
        sourceReferences:[{sourceId:'new-reviewed-source',provenance:'reviewed-community'}]}}})),
  ]);
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  globalThis.fetch = async request => {
    const href = request instanceof URL ? request.href : typeof request === 'string' ? request : request.url;
    if(href===url) return new Response(`<meta property="og:image" content="${logo}">`,{headers:{'content-type':'text/html'}});
    if(href===logo) return new Response(jpeg,{headers:{'content-type':'image/jpeg'}});
    return internet(request);
  };
  try {
    await builtWorker.scheduled({cron,scheduledTime:Date.now(),noRetry(){}},cronEnvironment(),{waitUntil(){},passThroughOnException(){}});
    const [icon] = await dump("SELECT id,icon_key,website_domain FROM company_icon_identities WHERE display_name='Northstar Robotics'");
    assert.ok(icon.icon_key?.endsWith('.jpg'));
    assert.equal(icon.website_domain,null);
    assert.deepEqual(await dump("SELECT id FROM canonical_employers WHERE display_name='Northstar Robotics'"),[]);
    globalThis.fetch=realFetch;
    const fetcher=await worker.getWorker(workerName);
    const response=await fetcher.fetch(`https://api.example.test/company-icons/${icon.id}`,{headers:{'X-InternNotifs-Service-Key':'e2e-internal-service-secret'}});
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'image/jpeg');
    assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width,96);
  } finally {globalThis.fetch=realFetch;}
});

test('authenticated catch-up clamps batches, respects the sweep lease and overload gate, and serves its results', async () => {
  const { default: builtWorker } = await import(new URL('../../cloudflare/dist/ingestion/ingestion-worker.js', import.meta.url));
  const env = { ...cronEnvironment(), INTERNAL_SERVICE_SECRET: 'internal', OPERATIONS_SHARED_SECRET: 'operations' };
  const request = (authorized = true) => new globalThis.Request('https://api.example.test/internal/admission/employer-icons/sweep', {
    method: 'POST', headers: { 'X-InternNotifs-Service-Key': 'internal',
      ...(authorized ? { 'X-Operations-Key': 'operations' } : {}) }, body: JSON.stringify({ maxTasks: 1_000 }),
  });
  await database.prepare("UPDATE system_state SET value = ? WHERE key = 'company_icon_resolution'")
    .bind(JSON.stringify({ mode: 'resolve', maxPerSweep: 20, logoDevRetentionLicensedAt: instant })).run();
  assert.equal((await builtWorker.fetch(request(false), env)).status, 404);
  await database.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES ('company_icon_sweep_lease', ?, ?)`)
    .bind(JSON.stringify({ token: 'another-sweep', until: new Date(Date.now() + 60_000).toISOString() }), instant).run();
  const busy = await builtWorker.fetch(request(), env);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).deferredReason, 'sweep-busy');
  await database.prepare("DELETE FROM system_state WHERE key = 'company_icon_sweep_lease'").run();
  const timestamp = new Date().toISOString();
  await database.prepare(`INSERT INTO queue_failure_events
    (id, queue_name, message_id, delivery_attempt, payload_hash, category, diagnostic, first_failed_at, last_failed_at)
    VALUES ('icon-overload', 'fixture', 'fixture', 1, 'hash', 'database', 'D1 DB is overloaded', ?, ?)`)
    .bind(timestamp, timestamp).run();
  assert.equal((await builtWorker.fetch(request(), env)).status, 503);
  await database.prepare("DELETE FROM queue_failure_events WHERE id = 'icon-overload'").run();
  for (let n = 0; n < 6; n += 1) {
    const id = `catchup-${n}`;
    await database.batch([
      database.prepare(`INSERT INTO canonical_employers (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
        VALUES (?, 'Acme', ?, 'e2e', ?, ?)`).bind(id, instant, instant, instant),
      database.prepare(`INSERT INTO employer_icon_resolutions
        (id, canonical_employer_id, evidence_fingerprint, status, evidence_json, next_retry_at, created_at, updated_at)
        VALUES (?, ?, ?, 'retryable', ?, ?, ?, ?)`).bind(id, id, id,
        JSON.stringify({ canonicalEmployerId: id, displayName: 'Acme', applicationUrl, roleTitle: 'Intern', provider: 'ashby' }),
        instant, instant, instant),
    ]);
  }
  globalThis.fetch = internet;
  try {
    const response = await builtWorker.fetch(request(), env);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.claimed, 5);
    // Board assets can serve while the employer-domain decision stays unresolved.
    assert.equal(result.reasonCodes.length, 5);
    assert.equal(result.deferredTasks, 0);
    assert.equal((await dump("SELECT id FROM employer_icon_resolutions WHERE id LIKE 'catchup-%' AND attempts = 0")).length, 1);
    assert.deepEqual(await dump("SELECT key FROM system_state WHERE key = 'company_icon_sweep_lease'"), []);
    globalThis.fetch = realFetch;
    const fetcher = await worker.getWorker(workerName);
    const served = await fetcher.fetch('https://api.example.test/company-icons/catchup-0', {
      headers: { 'X-InternNotifs-Service-Key': 'e2e-internal-service-secret' },
    });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
  } finally { globalThis.fetch = realFetch; }
});
