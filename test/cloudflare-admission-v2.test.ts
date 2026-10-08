import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudflareAdmissionProber, processAdmissionV2Batch, stage2AdmissionEvaluator } from '../cloudflare/admission-v2.js';
import { D1RecordingAdmissionV2CatalogSink } from '../cloudflare/admission-v2-recording-sink.js';
import type { D1Database, D1PreparedStatement, MessageBatch, R2Bucket } from '../cloudflare/types.js';
import type { IngestionRowRecord } from '../src/ingestion-v2/types.js';
import { buildAdmissionV2Messages } from '../src/ingestion-v2/admission/message.js';
import { ingestionV2AdmissionVersion } from '../src/ingestion-v2/admission/version.js';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import { normalizeSourceSnapshot } from '../src/ingestion-v2/normalize.js';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';

afterEach(() => vi.unstubAllGlobals());
const observedAt = '2026-10-03T00:00:00.000Z';

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(query).run(...values).changes) } }; },
  });
  return { prepare: (query) => prepared(query), async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); } };
}

function row(): IngestionRowRecord {
  return {
    sourceId: 'source', externalId: 'role', snapshotHash: 'a'.repeat(64), materialHash: 'material',
    admissionVersion: 'standard-v1', notificationBaseline: false, state: 'processing', attemptCount: 0,
    consecutiveOmissions: 0, firstObservedAt: '2026-10-03T00:00:00.000Z',
    lastObservedAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
  };
}

describe('Cloudflare admission v2 boundary', () => {
  it('passes the committed catalog identity through the default live sink router to D1 settlement', async () => {
    const database = new DatabaseSync(':memory:');
    for (const file of readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
      database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const db = sqliteD1(database);
    const repository = new D1IngestionV2Repository(db);
    const envelope = normalizeSourceSnapshot({ sourceId: 'source', admissionVersion: 'standard-v1', observedAt,
      postings: [{ sourceId: 'source', externalId: 'role', sourceUrl: 'https://careers.example.com/opportunities',
        fetchedAt: observedAt, employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' },
        title: 'Software Engineering Intern', content: [{ kind: 'description', format: 'plain', value: 'Build distributed systems.' }],
        locations: ['Remote'], applyUrl: 'https://careers.example.com/opportunities/software-intern', sourceState: 'open', lifecycleAuthority: 'title' }],
    });
    await repository.putSnapshot({ sourceId: 'source', snapshotHash: envelope.snapshotHash, objectKey: 'snapshot',
      admissionVersion: 'standard-v1', documentCount: 1, rowCount: 1, state: 'active', isComplete: true,
      baseline: true, createdAt: observedAt, activatedAt: observedAt });
    await repository.putRows([{ ...row(), state: 'queued', snapshotHash: envelope.snapshotHash,
      materialHash: envelope.rows[0]!.materialHash, notificationBaseline: true }]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<title>Software Engineering Intern</title><main>Build distributed systems.</main><form><input type="file" name="resume"></form>',
      { headers: { 'Content-Type': 'text/html' } })));
    const committed = vi.spyOn(ReconcilerAdmissionV2CatalogSink.prototype, 'commit').mockResolvedValue({ jobId: 'retained-catalog-job' });
    try {
      const [body] = buildAdmissionV2Messages({ sourceId: 'source', snapshotHash: envelope.snapshotHash, snapshotKey: 'snapshot',
        admissionVersion: 'standard-v1', baseline: true, externalIds: ['role'] });
      let acknowledged = 0;
      await processAdmissionV2Batch({ queue: 'intern-notifs-admission-v2', messages: [{ id: 'canonical-receipt', body,
        attempts: 1, timestamp: new Date(observedAt), ack() { acknowledged++; }, retry() {} }] }, {
        DB: db, DOCUMENTS: { async get() { return { body: new Response(JSON.stringify(envelope)).body }; } } as unknown as R2Bucket,
        INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: 'source',
        INGESTION_V2_ADMISSION_ENABLED: 'true', INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: 'source',
        INGESTION_V2_CATALOG_WRITER_ENABLED: 'true', INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: 'source',
        INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: 'source',
      }, { resolver: { async resolve() { return ['93.184.216.34']; } }, now: () => new Date(observedAt) });
      expect(acknowledged).toBe(1);
      expect(committed).toHaveBeenCalledOnce();
      expect(database.prepare('SELECT state,job_id,notification_baseline FROM ingestion_rows').get())
        .toMatchObject({ state: 'settled', job_id: 'retained-catalog-job', notification_baseline: 1 });
    } finally { committed.mockRestore(); database.close(); }
  });
  it('retains a provider Retry-After minimum without interpreting a 429 as a closed job', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Throttled', { status: 429, headers: { 'Retry-After': '7200' } })));
    const prober = cloudflareAdmissionProber({ async resolve() { return ['93.184.216.34']; } });
    await expect(prober.probe({ sourceId: 'source', externalId: 'role', applyUrl: 'https://jobs.example.com/role', observedAt }))
      .rejects.toMatchObject({ classification: 'destination-rate-limited', retryAfterMs: 7_200_000,
        message: 'HTTP 429 from jobs.example.com' });
  });
  it.each(['http://jobs.example.com/role', 'https://127.0.0.1/admin', 'https://jobs.example.com:8443/role'])('blocks a refused redirect without retrying it: %s', async (location) => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal('fetch', fetcher);
    const prober = cloudflareAdmissionProber({ async resolve() { return ['93.184.216.34']; } });
    await expect(prober.probe({ sourceId: 'source', externalId: 'role', applyUrl: 'https://jobs.example.com/role', observedAt }))
      .resolves.toEqual({ reachability: 'blocked' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps unresolved DNS retryable rather than treating it as a policy refusal', async () => {
    const prober = cloudflareAdmissionProber({ async resolve() { return []; } });
    await expect(prober.probe({ sourceId: 'source', externalId: 'role', applyUrl: 'https://jobs.example.com/role', observedAt }))
      .rejects.toMatchObject({ classification: 'destination-timeout', message: 'URL host did not resolve' });
  });

  it('versions evaluator semantics independently from the legacy admission version', () => {
    expect(ingestionV2AdmissionVersion('legacy-v1')).toHaveLength(64);
    expect(ingestionV2AdmissionVersion('legacy-v1')).toBe(ingestionV2AdmissionVersion('legacy-v1'));
    expect(ingestionV2AdmissionVersion('legacy-v1')).not.toBe(ingestionV2AdmissionVersion('legacy-v2'));
  });

  it('persists idempotent non-publishing canary receipts in D1', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(readFileSync(new URL('../cloudflare/migrations/0047_ingestion_v2_dispatch_cursor.sql', import.meta.url), 'utf8'));
    const sink = new D1RecordingAdmissionV2CatalogSink(sqliteD1(database), () => new Date('2026-10-03T00:00:00.000Z'));
    const input = {
      sourceId: 'source', externalId: 'role', baseline: false, admissionVersion: 'standard-v1',
      listing: {} as never, admission: {
        catalogEligible: true, alertEligible: true, reasonCodes: [],
      } as never,
      jobId: 'JOB#1', notify: true,
    };
    await sink.commit(input);
    await sink.commit(input);
    expect(database.prepare('SELECT COUNT(*) AS count, SUM(notify) AS notifications FROM ingestion_v2_admission_decisions').get())
      .toEqual({ count: 1, notifications: 1 });
  });

  it('settles a deterministic invalid application URL before probing the network', async () => {
    const evaluator = stage2AdmissionEvaluator({ async resolve() { throw new Error('must not resolve'); } });
    await expect(evaluator.evaluate({
      sourceId: 'source', externalId: 'role', snapshotHash: row().snapshotHash,
      admissionVersion: 'standard-v1', baseline: false, row: row(), firstObservationEligible: true,
      posting: {
        sourceId: 'source', externalId: 'role', sourceUrl: 'https://example.test/board',
        fetchedAt: '2026-10-03T00:00:00.000Z', employer: { name: 'Employer', authority: 'reviewed-registry' },
        title: 'Software Engineering Intern', content: [], locations: ['Remote'],
        applyUrl: 'http://127.0.0.1/private', sourceState: 'open', lifecycleAuthority: 'title',
      },
    })).resolves.toMatchObject({ decision: { kind: 'blocked', reason: 'invalid-application-url' } });
  });

  it('treats a large healthy application page as live with bounded evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(300 * 1024), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })));
    const prober = cloudflareAdmissionProber({ async resolve() { return ['93.184.216.34']; } });
    await expect(prober.probe({
      sourceId: 'source', externalId: 'role', applyUrl: 'https://jobs.example.com/role', observedAt: '2026-10-03T00:00:00.000Z',
    })).resolves.toMatchObject({
      reachability: 'live',
      evidence: { url: 'https://jobs.example.com/role', inspectionTruncated: true, inspectedBytes: 128 * 1024 },
    });
  });

  it('passes nonstandard official-form evidence through the deployed prober boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <html><head><title>Software Engineering Intern</title></head>
      <body><main>${'Build distributed systems and collaborate with engineers. '.repeat(10)}</main>
      <form action="/applications"><input type="file" name="resume"></form></body></html>
    `, { status: 200, headers: { 'Content-Type': 'text/html' } })));
    const prober = cloudflareAdmissionProber({ async resolve() { return ['93.184.216.34']; } });
    await expect(prober.probe({
      sourceId: 'source', externalId: 'role', applyUrl: 'https://careers.example.com/opportunities/software-intern', observedAt,
    })).resolves.toMatchObject({
      reachability: 'live',
      evidence: {
        title: 'Software Engineering Intern',
        applicationFormPresent: true,
        closureState: 'open',
        contentExcerpt: expect.stringContaining('Build distributed systems'),
      },
    });
  });

  it('admits a nonstandard official form through the Cloudflare prober and existing rules', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <html><head><title>Software Engineering Intern</title></head>
      <body><main>${'Build distributed systems and collaborate with engineers. '.repeat(10)}</main>
      <form action="/applications"><input type="file" name="resume"></form></body></html>
    `, { status: 200, headers: { 'Content-Type': 'text/html' } })));
    const commits: unknown[] = [];
    const evaluator = stage2AdmissionEvaluator(
      { async resolve() { return ['93.184.216.34']; } },
      { async commit(input) { commits.push(input); } },
    );
    const evaluation = await evaluator.evaluate({
      sourceId: 'source', externalId: 'official-form', snapshotHash: row().snapshotHash,
      admissionVersion: 'standard-v1', baseline: false, row: row(), firstObservationEligible: true,
      posting: {
        sourceId: 'source', externalId: 'official-form', sourceUrl: 'https://careers.example.com/opportunities',
        fetchedAt: observedAt, employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' },
        title: 'Software Engineering Intern', content: [{ kind: 'description', format: 'plain', value: 'Build distributed systems.' }],
        locations: ['Remote'], applyUrl: 'https://careers.example.com/opportunities/software-intern',
        sourceState: 'open', lifecycleAuthority: 'title',
      },
    });
    expect(evaluation).toMatchObject({ decision: { kind: 'admitted' }, commitEffect: expect.any(Function) });
    expect(commits).toHaveLength(0);
    await evaluation.commitEffect?.();
    expect(commits).toHaveLength(1);
  });

  it('applies the live trusted-community policy when grading a Stage 2 canary row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <html><head><title>Quantitative Research Intern</title></head>
      <body><main>${'Research markets and build quantitative models. '.repeat(10)}</main>
      <form action="/applications"><input type="file" name="resume"></form></body></html>
    `, { status: 200, headers: { 'Content-Type': 'text/html' } })));
    const commits: Array<{ admission: { employerResolution: string; catalogEligible: boolean; alertEligible: boolean }; notify: boolean }> = [];
    const evaluator = stage2AdmissionEvaluator(
      { async resolve() { return ['93.184.216.34']; } },
      { async commit(input) { commits.push(input); } },
      undefined,
      { trustedCommunityCatalogEnabled: true },
    );
    const evaluation = await evaluator.evaluate({
      sourceId: 'northwestern-fintech-2027-quant', externalId: 'README.md:https://jobs.example.test/quant',
      snapshotHash: row().snapshotHash, admissionVersion: 'trusted-v1', baseline: true,
      row: { ...row(), sourceId: 'northwestern-fintech-2027-quant', notificationBaseline: true },
      firstObservationEligible: false,
      posting: {
        sourceId: 'northwestern-fintech-2027-quant', provenance: 'reviewed-community',
        externalId: 'README.md:https://jobs.example.test/quant', sourceUrl: 'https://example.test/board',
        fetchedAt: observedAt, employer: { name: 'Source Reported Employer', authority: 'source-row' },
        title: 'Quantitative Research Intern', content: [], locations: ['New York, NY'],
        applyUrl: 'https://jobs.example.test/quant', sourceState: 'open', lifecycleAuthority: 'source',
        seasonHint: 'summer-2027', seasonHintAuthority: 'source-default',
      },
    });
    expect(evaluation).toMatchObject({ decision: { kind: 'admitted' }, commitEffect: expect.any(Function) });
    await evaluation.commitEffect?.();
    expect(commits).toEqual([expect.objectContaining({
      notify: false,
      admission: expect.objectContaining({
        employerResolution: 'source-reported', catalogEligible: true, alertEligible: false,
      }),
    })]);
  });

  it('ledgers malformed work and retries it toward the DLQ instead of dropping it', async () => {
    const database = new DatabaseSync(':memory:');
    for (const file of ['0001_initial.sql', '0015_dlq_recovery.sql', '0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql', '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql', '0049_ingestion_v2_cost_windows.sql', '0050_ingestion_v2_omission_closure.sql', '0051_ingestion_v2_qualification_cadence.sql']) {
      database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
    }
    let acked = 0;
    let retried = 0;
    const batch: MessageBatch<unknown> = {
      queue: 'intern-notifs-admission-v2',
      messages: [{
        id: 'malformed-1', body: { version: 99 }, attempts: 1, timestamp: new Date('2026-10-03T00:00:00.000Z'),
        ack() { acked += 1; }, retry() { retried += 1; },
      }],
    };
    await processAdmissionV2Batch(batch, {
      DB: sqliteD1(database), DOCUMENTS: {} as R2Bucket, INGESTION_V2_ADMISSION_ENABLED: 'true',
    }, { resolver: { async resolve() { return ['93.184.216.34']; } } });
    expect({ acked, retried }).toEqual({ acked: 0, retried: 1 });
    expect(database.prepare('SELECT queue_name, message_id, delivery_attempt, resolved_at FROM queue_failure_events').get())
      .toMatchObject({ queue_name: 'intern-notifs-admission-v2', message_id: 'malformed-1', delivery_attempt: 1, resolved_at: null });
  });

  it('ledgers systemic delivery failure without consuming a row attempt', async () => {
    const database = new DatabaseSync(':memory:');
    for (const file of ['0001_initial.sql', '0015_dlq_recovery.sql', '0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql', '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql', '0049_ingestion_v2_cost_windows.sql', '0050_ingestion_v2_omission_closure.sql', '0051_ingestion_v2_qualification_cadence.sql']) {
      database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const [body] = buildAdmissionV2Messages({
      sourceId: 'source', snapshotHash: 'a'.repeat(64), snapshotKey: 'missing', admissionVersion: 'standard-v1',
      baseline: false, externalIds: ['role'],
    });
    let retried = 0;
    await processAdmissionV2Batch({
      queue: 'intern-notifs-admission-v2',
      messages: [{ id: 'systemic-1', body, attempts: 2, timestamp: new Date(observedAt), ack() {}, retry() { retried += 1; } }],
    }, {
      DB: sqliteD1(database), DOCUMENTS: {} as R2Bucket, INGESTION_V2_ADMISSION_ENABLED: 'true',
    }, { resolver: { async resolve() { return ['93.184.216.34']; } } });
    expect(retried).toBe(1);
    expect(database.prepare('SELECT source_id, delivery_attempt, resolved_at FROM queue_failure_events WHERE message_id = ?').get('systemic-1'))
      .toMatchObject({ source_id: 'source', delivery_attempt: 2, resolved_at: null });
    expect(database.prepare('SELECT COUNT(*) AS count FROM ingestion_rows').get()).toEqual({ count: 0 });
  });

  it('resolves a prior failure-ledger row when a disabled canary drains safely', async () => {
    const database = new DatabaseSync(':memory:');
    for (const file of ['0001_initial.sql', '0015_dlq_recovery.sql', '0045_ingestion_v2.sql', '0046_ingestion_v2_admission.sql', '0047_ingestion_v2_dispatch_cursor.sql', '0048_ingestion_v2_effect_claim.sql', '0049_ingestion_v2_cost_windows.sql', '0050_ingestion_v2_omission_closure.sql', '0051_ingestion_v2_qualification_cadence.sql']) {
      database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const [body] = buildAdmissionV2Messages({
      sourceId: 'source', snapshotHash: 'a'.repeat(64), snapshotKey: 'missing', admissionVersion: 'standard-v1',
      baseline: false, externalIds: ['role'],
    });
    database.prepare(`INSERT INTO queue_failure_events
      (id, queue_name, message_id, delivery_attempt, payload_hash, category, diagnostic, first_failed_at, last_failed_at)
      VALUES ('failure', 'intern-notifs-admission-v2', 'recovered-1', 1, 'hash', 'storage', 'missing', ?, ?)`)
      .run(observedAt, observedAt);
    let acked = 0;
    await processAdmissionV2Batch({
      queue: 'intern-notifs-admission-v2',
      messages: [{ id: 'recovered-1', body, attempts: 2, timestamp: new Date(observedAt), ack() { acked += 1; }, retry() {} }],
    }, {
      DB: sqliteD1(database), DOCUMENTS: {} as R2Bucket, INGESTION_V2_ADMISSION_ENABLED: 'false',
    }, { resolver: { async resolve() { return ['93.184.216.34']; } }, now: () => new Date(observedAt) });
    expect(acked).toBe(1);
    expect(database.prepare('SELECT resolved_at FROM queue_failure_events WHERE message_id = ?').get('recovered-1'))
      .toEqual({ resolved_at: observedAt });
  });
});
