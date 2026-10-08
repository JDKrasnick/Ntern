import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { reviewedIdentityApplicationUrl } from '../cloudflare/posting-source-corrections.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { RuleBasedAdmissionV2Evaluator } from '../src/ingestion-v2/admission/evaluator.js';
import { ReconcilerAdmissionV2CatalogSink } from '../src/ingestion-v2/admission/catalog-sink.js';
import { reviewedUrlCorrection, postingUrlCorrectionEvidenceHash, type PostingUrlCorrectionRow } from '../src/identity/source-corrections.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { AdmissionRowContext } from '../src/ingestion-v2/admission/types.js';

function setup() {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const prepared = (sql: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(sql, next as SQLInputValue[]); },
    async first<T>() { return (database.prepare(sql).get(...values) as T | undefined) ?? null; },
    async all<T>() { return { results: database.prepare(sql).all(...values) as T[] }; },
    async run() { return { meta: { changes: Number(database.prepare(sql).run(...values).changes) } }; },
  });
  const db: D1Database = { prepare: sql => prepared(sql), async batch(statements) {
    database.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  return { database, db };
}
const now = '2026-10-08T00:00:00.000Z';
function context(applyUrl: string): AdmissionRowContext {
  const externalId = `README.md:${applyUrl}`, sourceId = 'canadian-tech-2027';
  return { sourceId, externalId, snapshotHash: 'a'.repeat(64), admissionVersion: 'v1', baseline: true,
    posting: { sourceId, externalId, sourceUrl: 'https://github.com/example/jobs', document: 'README.md', row: 1,
      provenance: 'reviewed-community', fetchedAt: now, employer: { id: 'general-dynamics', name: 'General Dynamics', authority: 'reviewed-registry' },
      title: 'Software Engineering Co-op', locations: ['Ottawa, ON'], content: [], applyUrl,
      sourceState: 'open', lifecycleAuthority: 'source' },
    row: { sourceId, externalId, snapshotHash: 'a'.repeat(64), materialHash: 'b'.repeat(64), admissionVersion: 'v1',
      state: 'queued', attemptCount: 0, consecutiveOmissions: 0, notificationBaseline: true,
      firstObservedAt: now, lastObservedAt: now, updatedAt: now } };
}

describe('reviewed V2 posting corrections', () => {
  it.each(['744000146822449', '744000146985399', '744000147019949', '744000147563929', '744000147583700'])('retains the repaired catalog identity and source provenance for %s, with silent duplicate commits', async id => {
      const { database, db } = setup();
      try {
        const applyUrl = `https://jobs.smartrecruiters.com/GDMSI/${id}`;
        const correction = await reviewedIdentityApplicationUrl(db, applyUrl);
        expect(correction).toBeTruthy();
        const store = new D1InternshipStore(db), sink = new ReconcilerAdmissionV2CatalogSink(store, () => new Date(now));
        const probes: string[] = [];
        const evaluator = new RuleBasedAdmissionV2Evaluator({ now: () => new Date(now), sink,
          trustedCommunityCatalogEnabled: true, trustedCommunityAlertsEnabledForSource: () => true,
          resolveIdentityApplicationUrl: url => reviewedIdentityApplicationUrl(db, url),
          prober: { async probe(input) { probes.push(input.applyUrl); return { reachability: 'live' }; } } });
        const input = context(applyUrl), first = await evaluator.evaluate(input);
        expect(first.decision.kind).toBe('admitted');
        await first.commitEffect!();
        const prior = (await store.getSourceOccurrence(input.sourceId, input.externalId))!;
        const job = (await store.getJob(prior.jobId))!, historicalId = `historical-${id}`;
        // Reproduce the production repair retaining a pre-V2 catalog job ID.
        database.prepare("UPDATE catalog_items SET pk = ?, value = ? WHERE pk = ? AND sk = 'META'")
          .run(`JOB#${historicalId}`, JSON.stringify({ ...job, jobId: historicalId }), `JOB#${job.jobId}`);
        database.prepare("UPDATE catalog_items SET value = json_set(value, '$.canonicalJobId', ?) WHERE kind = 'posting-alias'").run(historicalId);
        database.prepare("UPDATE catalog_items SET value = json_set(value, '$.jobId', ?) WHERE kind = 'source-occurrence'").run(historicalId);
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = await evaluator.evaluate(input);
          expect(await result.commitEffect!()).toEqual({ jobId: historicalId });
        }
        const occurrence = (await store.getSourceOccurrence(input.sourceId, input.externalId))!;
        expect(occurrence.jobId).toBe(historicalId);
        expect(occurrence.occurrence.applyUrl).toBe(applyUrl);
        expect(occurrence.occurrence.postingIdentityDecision).toMatchObject({ status: 'confirmed', exactKey: job.postingIdentity!.aliases[0]!.value });
        expect(probes).toEqual([applyUrl, applyUrl, applyUrl]);
        expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'internship'").get()).toMatchObject({ count: 1 });
        expect(database.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toMatchObject({ count: 0 });
      } finally { database.close(); }
    });
  it('uses exact provider scope and leaves unrelated URLs unchanged', async () => {
    const { database, db } = setup();
    try {
      for (const url of ['https://jobs.smartrecruiters.com/other/744000146822449', 'https://jobs.smartrecruiters.com/GDMSI/999', 'https://example.com/744000146822449'])
        expect(await reviewedIdentityApplicationUrl(db, url)).toBeUndefined();
      const row = database.prepare('SELECT * FROM posting_url_corrections LIMIT 1').get() as PostingUrlCorrectionRow;
      expect(() => reviewedUrlCorrection({ ...row, evidence_hash: '0'.repeat(64) })).toThrow('evidence hash');
      const otherTenant = { ...row, canonical_url: row.canonical_url.replace('GDMSI', 'other') };
      expect(() => reviewedUrlCorrection({ ...otherTenant, evidence_hash: postingUrlCorrectionEvidenceHash(otherTenant) })).toThrow('same provider tenant');
    } finally { database.close(); }
  });
});
