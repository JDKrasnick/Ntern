import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ingestionWorker from '../cloudflare/ingestion-worker.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement, R2Bucket } from '../cloudflare/types.js';
import type { Environment } from '../cloudflare/worker.js';
import type { Internship, SourceOccurrenceState } from '../src/types.js';
import { normalizeExactPostingDescription } from '../src/shadow-extraction.js';

vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: vi.fn() } }));

const observedAt = '2026-10-20T00:01:00Z';
const description = 'Software Engineering Intern. Pay: USD 50 - 60 per hour. Work remotely.';
const databases: DatabaseSync[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const database of databases.splice(0)) database.close(); });

function setup() {
  const database = new DatabaseSync(':memory:'); databases.push(database);
  for (const file of readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).filter(file => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
  }
  let beforeWrite: (() => Promise<void>) | undefined;
  const queries = new WeakMap<D1PreparedStatement, string>();
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
      async first<T>() { return (database.prepare(query).get(...values) as T | undefined) ?? null; },
      async all<T>() { return { results: database.prepare(query).all(...values) as T[] }; },
      async run() {
        // Match D1's count, which includes metadata revision trigger writes.
        const before = Number(database.prepare('SELECT total_changes() AS count').get()!.count);
        database.prepare(query).run(...values);
        return { meta: { changes: Number(database.prepare('SELECT total_changes() AS count').get()!.count) - before } };
      },
    };
    queries.set(statement, query); return statement;
  };
  const db: D1Database = { prepare: prepared, async batch(statements) {
    if (beforeWrite && statements.some(statement => queries.get(statement)?.startsWith('UPDATE catalog_items SET kind'))) {
      const update = beforeWrite; beforeWrite = undefined; await update();
    }
    database.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  const jobs = new D1InternshipStore(db);
  const reference = {
    sourceId: 'greenhouse-acme', externalId: '7654321', provenance: 'official-ats' as const,
    document: '7654321', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1,
    company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    compensation: { raw: '' },
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321', state: 'open' as const,
    shadowMetadataHash: 'a'.repeat(64),
  };
  const job: Internship = {
    jobId: 'metadata-notification-race', company: reference.company, title: reference.title,
    location: reference.location, season: reference.season, applyUrl: reference.applyUrl, normalizedUrl: reference.applyUrl,
    fingerprint: 'metadata-notification-race', compensation: { raw: '' }, sourceReferences: [reference],
    technical: true, open: true, firstSeenAt: observedAt, lastSeenAt: observedAt,
    notification: { smsPending: true, digestPending: true },
  };
  const occurrence: SourceOccurrenceState = { sourceId: reference.sourceId, externalId: reference.externalId,
    jobId: job.jobId, occurrence: reference, changedAt: observedAt, present: true,
    consecutiveOmissions: 0, changedSnapshotHash: 'initial' };
  const message = { version: 1, jobId: job.jobId, sourceId: reference.sourceId, externalId: reference.externalId,
    providerIdentity: { provider: 'greenhouse', tenant: 'acme', postingId: reference.externalId,
      sourceId: reference.sourceId, sourceUrl: reference.sourceUrl },
    candidateUrl: reference.applyUrl, reason: 'content-change', queuedAt: observedAt,
    shadowOrigin: 'provider-poll', shadowContentHash: normalizeExactPostingDescription(reference.title, description).contentHash,
    shadowMetadataHash: reference.shadowMetadataHash, idempotencyKey: 'metadata-notification-race' };
  const send = vi.fn();
  const artifacts = { put: vi.fn() } as unknown as R2Bucket;
  const env: Partial<Environment> = { DB: db, DESTINATION_VERIFICATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
    SHADOW_EXTRACTION_QUEUE: { send, sendBatch: vi.fn() }, SHADOW_EXTRACTION_ARTIFACTS: artifacts };
  async function deliver(attempts = 1) {
    const queued = { id: 'metadata-race-delivery', body: message, attempts, timestamp: new Date(observedAt), ack: vi.fn(), retry: vi.fn() };
    await ingestionWorker.queue({ queue: 'intern-notifs-destination-verification', messages: [queued] }, env as Environment);
    return queued;
  }
  const payload = () => Response.json({ id: Number(reference.externalId), title: reference.title, content: description, location: { name: 'Austin, TX' } });
  return { database, db, jobs, job, occurrence, message, deliver, send, payload,
    beforeWrite(update: () => Promise<void>) { beforeWrite = update; } };
}

describe('provider metadata and concurrent notification delivery integration', () => {
  it('fences the raw stored snapshot even when read-time defaults enrich a legacy job', async () => {
    const s = setup();
    await s.db.prepare("INSERT INTO catalog_items(pk,sk,kind,value) VALUES (?, 'META', 'internship', ?)")
      .bind(`JOB#${s.job.jobId}`, JSON.stringify(s.job)).run();
    vi.stubGlobal('fetch', vi.fn(s.payload));
    const queued = await s.deliver();
    expect(queued.ack).toHaveBeenCalledOnce(); expect(queued.retry).not.toHaveBeenCalled();
    const stored = (await s.jobs.getJob(s.job.jobId))!;
    expect(stored.notification).toEqual(s.job.notification);
    expect(stored.compensation.raw).toContain('50'); expect(s.send).toHaveBeenCalledOnce();
  });

  it.each(['sms', 'digest'] as const)('preserves %s completion during acquisition, including legacy stored jobs', async (channel) => {
    const s = setup();
    // Raw legacy rows omit the category/recency defaults added by getJob.
    await s.db.prepare("INSERT INTO catalog_items(pk,sk,kind,value) VALUES (?, 'META', 'internship', ?)")
      .bind(`JOB#${s.job.jobId}`, JSON.stringify(s.job)).run();
    await s.jobs.putSourceOccurrence(s.occurrence);
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (channel === 'sms') await s.jobs.markSmsSent(s.job.jobId, observedAt);
      else await s.jobs.markDigested([s.job.jobId], observedAt);
      return s.payload();
    }));
    const queued = await s.deliver();
    expect(queued.ack).toHaveBeenCalledOnce(); expect(queued.retry).not.toHaveBeenCalled();
    const stored = (await s.jobs.getJob(s.job.jobId))!;
    expect(stored.notification).toMatchObject(channel === 'sms'
      ? { smsPending: false, smsSentAt: observedAt, digestPending: true }
      : { digestPending: false, digestedAt: observedAt, smsPending: true });
    expect(stored.compensation.raw).toContain('50'); expect(s.send).toHaveBeenCalledOnce();
    expect(stored.open).toBe(true);
    expect((await s.jobs.getSourceOccurrence(s.message.sourceId, s.message.externalId))!.occurrence.metadataExtraction).toBeDefined();
    const indexes = s.database.prepare("SELECT sms_pending,digest_pending FROM catalog_items WHERE pk = ? AND sk = 'META'").get(`JOB#${s.job.jobId}`);
    expect(indexes).toEqual(channel === 'sms' ? { sms_pending: 0, digest_pending: 1 } : { sms_pending: 1, digest_pending: 0 });
  });

  it.each(['sms', 'digest'] as const)('retries a %s completion at commit time without a partial occurrence write or premature handoff', async (channel) => {
    const s = setup(); await s.jobs.putInternship(s.job); await s.jobs.putSourceOccurrence(s.occurrence);
    vi.stubGlobal('fetch', vi.fn(s.payload));
    s.beforeWrite(async () => {
      if (channel === 'sms') await s.jobs.markSmsSent(s.job.jobId, observedAt);
      else await s.jobs.markDigested([s.job.jobId], observedAt);
    });
    const first = await s.deliver();
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 300 }); expect(first.ack).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect((await s.jobs.getSourceOccurrence(s.message.sourceId, s.message.externalId))!.occurrence.metadataExtraction).toBeUndefined();
    expect(s.database.prepare('SELECT COUNT(*) AS count FROM role_metadata_evidence').get()).toEqual({ count: 0 });
    expect(s.database.prepare('SELECT COUNT(*) AS count FROM destination_verification_completions').get()).toEqual({ count: 0 });
    const second = await s.deliver(2);
    expect(second.ack).toHaveBeenCalledOnce(); expect(second.retry).not.toHaveBeenCalled();
    const stored = (await s.jobs.getJob(s.job.jobId))!;
    expect(stored.notification).toMatchObject(channel === 'sms'
      ? { smsPending: false, smsSentAt: observedAt } : { digestPending: false, digestedAt: observedAt });
    expect(stored.compensation.raw).toContain('50'); expect(s.send).toHaveBeenCalledOnce();
    expect((await s.jobs.getSourceOccurrence(s.message.sourceId, s.message.externalId))!.occurrence.metadataExtraction).toBeDefined();
    const duplicate = await s.deliver(3);
    expect(duplicate.ack).toHaveBeenCalledOnce(); expect(s.send).toHaveBeenCalledOnce();
    expect(s.database.prepare('SELECT COUNT(*) AS count FROM queue_failure_events WHERE resolved_at IS NULL').get()).toEqual({ count: 0 });
  });

  it('settles a source revision superseded during acquisition without persisting stale metadata', async () => {
    const s = setup(); await s.jobs.putInternship(s.job);
    vi.stubGlobal('fetch', vi.fn(async () => {
      const current = (await s.jobs.getJob(s.job.jobId))!;
      current.sourceReferences[0]!.shadowMetadataHash = 'b'.repeat(64);
      await s.jobs.putInternship(current); return s.payload();
    }));
    const queued = await s.deliver();
    expect(queued.ack).toHaveBeenCalledOnce(); expect(queued.retry).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    expect((await s.jobs.getJob(s.job.jobId))!.sourceReferences[0]!.metadataExtraction).toBeUndefined();
  });
});
