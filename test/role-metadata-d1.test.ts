import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { ATOMIC_REPAIR_BYTE_LIMIT, METADATA_REPAIR_RECORD_LIMIT, D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement, R2Bucket } from '../cloudflare/types.js';
import { extractPostingMetadataEvidence, projectRoleMetadata, reconcileRoleMetadata } from '../src/role-metadata.js';
import { persistDestinationAdmission, processDestinationVerificationBatch } from '../cloudflare/destination-verification.js';
import { parseMetadataApiResponse } from '../src/metadata-acquisition.js';
import { mergeSourceOccurrence } from '../src/identity/source-occurrence.js';
import type { Internship } from '../src/types.js';
import { combineRenderedFrameEvidence } from '../src/rendered-destination-evidence.js';

const browserMocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@cloudflare/puppeteer', () => ({ default: { launch: browserMocks.launch } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); browserMocks.launch.mockReset(); });

function sqliteD1(database: DatabaseSync, inspectRows?: (query: string, rows: unknown[]) => void,
  queryExecuted?: (query: string) => void): D1Database {
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { queryExecuted?.(query); return database.prepare(query).get(...values) as T | null; },
    async all<T>() {
      queryExecuted?.(query);
      const results = database.prepare(query).all(...values) as T[];
      inspectRows?.(query, results);
      return { results };
    },
    async run() { queryExecuted?.(query); const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare: (query) => prepared(query),
    async batch(statements) {
      database.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
}

function subject() {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql', '0015_role_metadata_enrichment.sql', '0016_role_metadata_repair_plans.sql', '0017_metadata_acquisition.sql', '0018_metadata_review.sql', '0019_metadata_job_review_revision.sql',
    '0020_shadow_extraction.sql', '0021_shadow_extraction_fencing.sql', '0022_shadow_extraction_cache_expiry.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database);
  return { database, db, operations: new D1CatalogAdmissionStore(db), jobs: new D1InternshipStore(db) };
}

function job(): Internship {
  return {
    jobId: 'job-1', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'],
    season: 'summer-2027', applyUrl: 'https://careers.acme.test/jobs/123', normalizedUrl: 'https://careers.acme.test/jobs/123',
    fingerprint: 'fingerprint', compensation: { raw: '' }, sourceReferences: [{ sourceId: 'community-acme', externalId: 'row-1',
      document: 'README.md', sourceUrl: 'https://github.test/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'Remote', locations: ['Remote'], season: 'summer-2027', applyUrl: 'https://careers.acme.test/jobs/123',
      compensation: { raw: '' }, state: 'open' }], technical: true, open: true, firstSeenAt: '2026-08-01T00:00:00.000Z',
    catalogVisibleAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-09-04T00:00:00.000Z',
    notification: { smsPending: false, digestPending: false, smsSentAt: '2026-08-01T00:01:00.000Z' },
  };
}

function jobWithVerifiedDestination(): Internship {
  const current = job();
  const destination = {
    classification: 'posting-detail' as const,
    candidateUrl: current.applyUrl,
    finalUrl: current.applyUrl,
    provider: 'github' as const,
    inspectedAt: '2026-09-01T00:00:00.000Z',
    browserVisible: true,
  };
  const admission = {
    employerResolution: 'resolved' as const,
    postingAttribution: 'attributed' as const,
    destination,
    metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
    catalogEligible: true,
    alertEligible: true,
    reasonCodes: [],
    evaluatedAt: '2026-09-01T00:00:00.000Z',
    evidenceObservedAt: '2026-09-01T00:00:00.000Z',
  };
  return { ...current, admission, sourceReferences: [{ ...current.sourceReferences[0]!, admission }] };
}

async function disputedPay(current: ReturnType<typeof subject>, jobId = 'job-1', changed = false) {
  const original = { ...jobWithVerifiedDestination(), jobId };
  if (!await current.jobs.getJob(jobId)) await current.jobs.putInternship(original);
  const observedAt = '2026-09-06T12:00:00.000Z';
  const evidence = extractPostingMetadataEvidence({ artifact: { title: original.title,
    text: `${changed ? 'Revised employer wording. ' : ''}USD $8500 monthly salary.\nUSD $2500 monthly housing stipend.`,
    compensationText: 'USD $11000 monthly salary.' }, sourceClass: 'official-api', sourceId: 'community-acme',
    sourceUrl: original.applyUrl, observedAt, exactPosting: true });
  await current.operations.recordRoleMetadataEvidence(jobId, evidence, reconcileRoleMetadata(evidence).conflicts, observedAt);
  await current.operations.recordRoleMetadataExtraction({ jobId, sourceId: 'community-acme', sourceUrl: original.applyUrl,
    artifactHash: evidence[0]!.artifactHash, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, outcome: 'extracted', observedAt });
  return { original, evidence, observedAt };
}

describe('staged browser-to-API collection', () => {
  it('keeps a complete non-posting browser result pending for exact-role collection', async () => {
    const current = subject();
    const original = jobWithVerifiedDestination();
    await current.jobs.putInternship(original);
    const inspectedAt = '2026-09-06T19:00:00.000Z';

    await persistDestinationAdmission({
      jobs: current.jobs,
      operations: current.operations,
      job: original,
      reference: original.sourceReferences[0]!,
      message: {
        version: 1,
        jobId: original.jobId,
        sourceId: 'community-acme',
        externalId: 'row-1',
        providerIdentity: { provider: 'github', sourceId: 'community-acme', sourceUrl: original.applyUrl },
        candidateUrl: original.applyUrl,
        queuedAt: inspectedAt,
        reason: 'historical-backfill',
        metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
        metadataBackfillToken: 'non-posting-collection',
      },
      reachability: 'live',
      inspectedAt,
      browserVisible: true,
      evidence: {
        url: original.applyUrl,
        title: 'Acme careers',
        contentExcerpt: 'Browse current openings. '.repeat(30),
        jobPostingCount: 0,
        distinctJobLinkCount: 12,
        confidence: { score: 20, level: 'low', recommendation: 'review', signals: ['job listing page'] },
      },
    });

    const audit = await current.operations.roleMetadataAudit(new Date(inspectedAt));
    expect(audit.acquisitionReports[0]?.report).toMatchObject({ complete: false, destination: 'aggregate-board' });
    expect(audit.collectionCoverage).toMatchObject({
      eligible: 1,
      current: 0,
      pendingOrUnobserved: 1,
      complete: false,
    });
    const plan = await current.operations.stageRoleMetadataRepair(inspectedAt);
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, 0, inspectedAt))
      .rejects.toThrow('collection was incomplete during the dry-run');
  });

  it('keeps production-sized metadata preflight and atomic writes within the D1 query budget', async () => {
    const current = subject(); const observedAt = '2026-09-06T19:00:00.000Z';
    const original = job();
    const evidence = extractPostingMetadataEvidence({ artifact: { title: original.title, text: 'USD $45/hour salary.' },
      sourceClass: 'official-page', sourceId: 'community-acme', sourceUrl: original.applyUrl, observedAt, exactPosting: true })[0]!;
    current.database.prepare(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 7044)
      INSERT INTO catalog_items(pk, sk, kind, value)
      SELECT 'JOB#budget-' || printf('%05d', n), 'META', 'internship',
        json_set(?, '$.jobId', 'budget-' || printf('%05d', n)) FROM sequence`).run(JSON.stringify(original));
    current.database.prepare(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 11086)
      INSERT INTO role_metadata_evidence(job_id, source_class, source_id, source_url, artifact_hash, extraction_version, evidence, observed_at, is_current)
      SELECT CASE WHEN n < 7045 THEN 'budget-' ELSE 'orphan-' END || printf('%05d', n),
        'official-page', 'community-acme', ?, ?, ?, ?, ?, 1 FROM sequence`)
      .run(original.applyUrl, evidence.artifactHash, ROLE_METADATA_EXTRACTION_VERSION, JSON.stringify(evidence), observedAt);
    current.database.prepare(`INSERT INTO role_metadata_acquisition(job_id, source_id, report)
      SELECT json_extract(value, '$.jobId'), 'community-acme', ? FROM catalog_items WHERE kind = 'internship' ORDER BY pk LIMIT 4923`)
      .run(JSON.stringify({ method: 'browser', complete: true, fields: { compensation: 'extracted' } }));
    let queries = 0;
    const bounded = new D1CatalogAdmissionStore(sqliteD1(current.database, (query, rows) => {
      if (/SELECT[\s\S]*\bvalue\b[\s\S]*FROM catalog_items/iu.test(query)) expect(rows.length).toBeLessThanOrEqual(100);
    }, () => { queries += 1; expect(queries).toBeLessThanOrEqual(1000); }));
    const plan = await bounded.stageRoleMetadataRepair(observedAt);
    expect(plan.expectedJobs).toBe(METADATA_REPAIR_RECORD_LIMIT);
    expect(plan.remainingJobs).toBe(7045 - METADATA_REPAIR_RECORD_LIMIT);
    queries = 0;
    await bounded.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, 0, observedAt);
    // Leave a measured reserve for the route's grouped projection refresh.
    // Full post-apply verification deliberately uses a new GET invocation.
    expect(queries).toBeLessThan(800);
  }, 15000);

  it.each([null, false, 0, ''])('does not count falsy stored optional fields as an extraction: %s', async value => {
    const current = subject(); const observedAt = '2026-09-06T19:00:00.000Z';
    const original = jobWithVerifiedDestination();
    await current.jobs.putInternship(original);
    const evidence = extractPostingMetadataEvidence({ artifact: { title: '' }, sourceClass: 'official-page',
      sourceId: 'community-acme', sourceUrl: original.applyUrl, observedAt, exactPosting: true });
    await current.operations.recordRoleMetadataEvidence(original.jobId, evidence, [], observedAt);
    const stored = { ...evidence[0], compensationRanges: [], housing: [], locations: [],
      education: value, workMode: value, applicationDeadline: value, employerPublishedAt: value, employerUpdatedAt: value };
    // Legacy JSON can explicitly store null/falsy optional fields even though
    // current typed evidence omits them. SQL aggregation must match Boolean().
    current.database.prepare('UPDATE role_metadata_evidence SET evidence = ?').run(JSON.stringify(stored));
    expect((await current.operations.roleMetadataAudit(new Date(observedAt))).collectionCoverage)
      .toMatchObject({ current: 1, outcomes: { 'no-explicit-metadata': 1 } });
  });

  it('audits across bounded catalog pages without dropping late records or orphan evidence', async () => {
    const current = subject(); const observedAt = '2026-09-06T19:00:00.000Z';
    const evidence = extractPostingMetadataEvidence({ artifact: { title: 'Software Engineering Intern',
      text: 'EUR 50/hour salary. EUR 900 monthly housing stipend.' }, sourceClass: 'official-page',
      sourceId: 'community-acme', sourceUrl: job().applyUrl, observedAt, exactPosting: true });
    for (let index = 0; index < 257; index++) {
      const original = { ...jobWithVerifiedDestination(), jobId: `bounded-${String(index).padStart(3, '0')}`, open: index !== 256 };
      await current.jobs.putInternship(original);
      await current.operations.recordRoleMetadataEvidence(original.jobId, evidence, [], observedAt);
      await current.operations.recordMetadataAcquisition(original.jobId, 'community-acme', observedAt,
        { method: 'browser', complete: true, fields: { compensation: 'extracted', housing: 'extracted' } }, observedAt);
    }
    // Evidence not currently attached to a stored job still belongs in global
    // evidence statistics, but cannot increase collection eligibility.
    await current.operations.recordRoleMetadataEvidence('orphan-evidence', evidence, [], observedAt);
    const pageSizes: number[] = [];
    const bounded = new D1CatalogAdmissionStore(sqliteD1(current.database, (query, rows) => {
      if (/SELECT[\s\S]*\bvalue\b[\s\S]*FROM catalog_items/iu.test(query)) {
        pageSizes.push(rows.length);
        expect(rows.length, 'do not materialize the entire catalog in a Worker').toBeLessThanOrEqual(100);
      }
    }));
    const audit = await bounded.roleMetadataAudit(new Date(observedAt));
    expect(pageSizes.filter(size => size > 0).length).toBeGreaterThan(2);
    expect(audit.scanned).toBe(257);
    expect(audit.enriched).toBe(0);
    expect(audit.projectionOnlyOmissions).toHaveLength(257);
    expect(audit.projectionOnlyOmissions.at(-1)?.jobId).toBe('bounded-256');
    expect(audit.currentEvidenceBySourceClass['official-page']).toBe(258);
    expect(audit.unsupportedCurrencies.EUR).toBe(258);
    expect(audit.collectionCoverage).toMatchObject({ eligible: 256, current: 256, pendingOrUnobserved: 0, stale: 0, complete: true });
    expect(audit.fieldOutcomeDenominator.count).toBe(257);
    expect(audit.fieldOutcomes['github/browser/compensation']).toEqual({ 'projection-missing': 257 });
    expect(audit.acquisitionReports).toHaveLength(257);
    expect(audit.deferredProjections).toEqual([]);
    expect(audit.disclosureRecall).toBeNull();
    expect((await current.jobs.getJob('bounded-256'))?.compensation.raw).toBe('');
    current.database.prepare(`INSERT INTO catalog_items(pk, sk, kind, value)
      SELECT pk, 'SECOND', kind, value FROM catalog_items WHERE pk = 'JOB#bounded-099' AND sk = 'META'`).run();
    // A composite primary-key boundary must not silently skip a row sharing
    // the final pk of a page, even if a legacy row uses another sk.
    const withSharedPk = await bounded.roleMetadataAudit(new Date(observedAt));
    expect(withSharedPk.scanned).toBe(258);
    expect(withSharedPk.fieldOutcomeDenominator.count).toBe(258);
    expect(withSharedPk.projectionOnlyOmissions).toHaveLength(258);
  });

  it('reports and blocks deferred projections even when destination collection is complete', async () => {
    const current = subject(); const original = job(); const observedAt = '2026-09-06T19:00:00.000Z';
    const community = extractPostingMetadataEvidence({ artifact: { title: original.title, compensationText: 'USD $60/hour' },
      sourceClass: 'reviewed-community', sourceId: 'community-acme', sourceUrl: original.sourceReferences[0]!.sourceUrl,
      observedAt, exactPosting: true });
    const accepted = projectRoleMetadata(original, community).job;
    const stale = community.map(item => ({ ...item, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 }));
    const stored = { ...accepted, sourceReferences: [{ ...original.sourceReferences[0]!, metadataEvidence: stale }] };
    await current.jobs.putInternship(stored);
    const before = await current.jobs.getJob(original.jobId);
    const official = extractPostingMetadataEvidence({ artifact: { title: original.title, compensationText: 'USD $55/hour' },
      sourceClass: 'official-api', sourceId: 'community-acme', sourceUrl: original.applyUrl, observedAt, exactPosting: true });
    await current.operations.recordRoleMetadataEvidence(original.jobId, official, [], observedAt);
    const audit = await current.operations.roleMetadataAudit(new Date(observedAt));
    expect(audit.collectionCoverage.complete).toBe(true);
    expect(audit.deferredProjections).toEqual([{ jobId: original.jobId, evidenceHashes: [community[0]!.artifactHash] }]);
    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, 0, observedAt))
      .rejects.toThrow('awaiting source re-extraction');
    expect(await current.jobs.getJob(original.jobId)).toEqual(before);
    await current.operations.recordRoleMetadataEvidence(original.jobId, community, [], observedAt);
    expect((await current.operations.roleMetadataAudit(new Date(observedAt))).deferredProjections).toEqual([]);
    const refreshed = await current.operations.stageRoleMetadataRepair(observedAt);
    await current.operations.applyRoleMetadataRepair(refreshed.repairToken, refreshed.expectedJobs, 0, observedAt);
    expect((await current.jobs.getJob(original.jobId))?.compensation.maxHourlyUSD).toBe(55);
  });

  it.each([
    ['exact embed', '8044334', '8044334', false, 1, true],
    ['wrong embed ID', '9999999', '8044334', false, 0, false],
    ['wrong API ID', '8044334', '9999999', false, 1, false],
    ['colliding rendered evidence', '8044334', '8044334', true, 0, false],
  ] as const)('%s keeps publication staging-only', async (_name, embeddedId, returnedId, collision, requests, acquired) => {
    const current = subject();
    const original = job();
    const candidateUrl = 'https://tower-research.com/open-positions/?gh_jid=8044334';
    const embed = `https://job-boards.greenhouse.io/embed/job_app?for=towerresearchcapital&token=${embeddedId}`;
    const snapshot = { url: embed, title: original.title,
      visibleText: `${original.title} 8044334`, jobPostingCount: 0, distinctJobLinkCount: 0,
      applicationFormPresent: true, loadingShell: true };
    const renderedHash = combineRenderedFrameEvidence({ role: original.title, expectedPostingId: '8044334', frames: [snapshot] })!.renderedEvidenceHash;
    original.applyUrl = candidateUrl;
    original.sourceReferences[0]!.applyUrl = candidateUrl;
    await current.jobs.putInternship(original);
    const other = { ...jobWithVerifiedDestination(), jobId: 'other-job' };
    other.sourceReferences[0]!.admission!.destination = { ...other.sourceReferences[0]!.admission!.destination,
      expectedPostingId: '9999999', renderedEvidenceHash: renderedHash };
    await current.jobs.putInternship(other);
    const before = await current.jobs.getJob(original.jobId);
    const otherBefore = await current.jobs.getJob(other.jobId);
    const collisions = vi.spyOn(D1CatalogAdmissionStore.prototype, 'renderedEvidenceCollisionJobIds')
      .mockResolvedValue(collision ? [other.jobId] : []);
    const frame = {
      waitForFunction: vi.fn().mockResolvedValue({ dispose: vi.fn() }),
      parentFrame: () => null,
      evaluate: vi.fn().mockResolvedValue(snapshot),
    };
    const page = { goto: vi.fn().mockResolvedValue({ status: () => 200 }), url: () => candidateUrl,
      frames: () => [frame], evaluate: vi.fn().mockResolvedValue([]), close: vi.fn() };
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() };
    browserMocks.launch.mockResolvedValue(browser);
    const apiFetch = vi.fn().mockResolvedValue(Response.json({ id: returnedId, title: original.title,
      content: '<p>Salary: USD $3500 to $5700 per week.</p><p>USD $900 monthly housing stipend.</p>' }));
    vi.stubGlobal('fetch', apiFetch);
    const ack = vi.fn(); const retry = vi.fn();
    const inspectedAt = '2026-09-06T19:00:00.000Z';
    await processDestinationVerificationBatch({ queue: 'test', messages: [{ id: 'message-1', body: {
      version: 1, jobId: original.jobId, sourceId: 'community-acme', externalId: 'row-1', candidateUrl,
      providerIdentity: { provider: 'greenhouse', postingId: '8044334', sourceId: 'community-acme', sourceUrl: original.sourceReferences[0]!.sourceUrl },
      reason: 'historical-backfill', queuedAt: inspectedAt, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      metadataBackfillToken: 'staged-embed',
    }, ack, retry }] }, {
      DB: current.db, DESTINATION_BROWSER: { fetch: vi.fn() }, DESTINATION_VERIFICATION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
      SHADOW_EXTRACTION_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
      SHADOW_EXTRACTION_ARTIFACTS: { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket,
    }, () => new Date(inspectedAt));
    expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(requests);
    if (requests) expect(apiFetch).toHaveBeenCalledWith(
      'https://boards-api.greenhouse.io/v1/boards/towerresearchcapital/jobs/8044334?pay_transparency=true&pay_input_ranges=true',
      expect.objectContaining({ redirect: 'manual' }));
    expect(page.close).toHaveBeenCalledOnce(); expect(browser.close).toHaveBeenCalledOnce();
    expect(collisions).toHaveBeenCalledOnce();
    expect(await current.jobs.getJob(original.jobId)).toEqual(before);
    expect(await current.jobs.getJob(other.jobId)).toEqual(otherBefore);
    const audit = await current.operations.roleMetadataAudit(new Date(inspectedAt));
    expect(audit.acquisitionReports).toHaveLength(1);
    expect(audit.acquisitionReports[0]?.report).toMatchObject({ complete: acquired, apiRouteAttempts: requests,
      method: acquired ? 'greenhouse-api' : 'browser' });
    if (acquired) {
      const plan = await current.operations.stageRoleMetadataRepair(inspectedAt);
      expect(plan.fillsByField.compensation).toBe(1);
      expect(plan.fillsByField.housing).toBe(1);
    }
    expect(current.database.prepare('SELECT count(*) AS count FROM admission_incidents').get()).toMatchObject({ count: 0 });
  });
});

describe('auditable compensation omissions', () => {
  it('keeps a posting review valid across unrelated collection updates', async () => {
    const current = subject(); const { observedAt } = await disputedPay(current);
    const review = await current.operations.stageRoleMetadataOmission('job-1', observedAt);
    await disputedPay(current, 'other-job');
    await expect(current.operations.approveRoleMetadataOmission(review.reviewToken, 1, observedAt))
      .resolves.toMatchObject({ approvedDecisions: 1, publicJobsChanged: 0 });
  });

  it('rejects a same-posting evidence race at the atomic approval guard', async () => {
    const current = subject(); const { observedAt } = await disputedPay(current);
    const review = await current.operations.stageRoleMetadataOmission('job-1', observedAt);
    const batch = current.db.batch.bind(current.db);
    current.db.batch = async statements => {
      current.database.prepare("DELETE FROM role_metadata_evidence WHERE job_id = 'job-1'").run();
      return batch(statements);
    };
    await expect(current.operations.approveRoleMetadataOmission(review.reviewToken, 1, observedAt)).rejects.toThrow();
    expect(current.database.prepare('SELECT count(*) AS count FROM role_metadata_review_decisions').get()).toMatchObject({ count: 0 });
    expect(current.database.prepare('SELECT count(*) AS count FROM role_metadata_review_guards').get()).toMatchObject({ count: 0 });
  });

  it('rolls back a repair when its approved review changes between preflight and the atomic guard', async () => {
    const current = subject(); const { observedAt } = await disputedPay(current);
    const review = await current.operations.stageRoleMetadataOmission('job-1', observedAt);
    await current.operations.approveRoleMetadataOmission(review.reviewToken, 1, observedAt);
    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    const batch = current.db.batch.bind(current.db);
    current.db.batch = async statements => {
      current.database.prepare('DELETE FROM role_metadata_review_decisions').run();
      return batch(statements);
    };
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, 1, 0, observedAt)).rejects.toThrow();
    expect((await current.jobs.getJob('job-1'))?.housing).toBeUndefined();
    expect(current.database.prepare('SELECT count(*) AS count FROM role_metadata_repair_guards').get()).toMatchObject({ count: 0 });
  });
  it('requires separate exact approvals, keeps disputed pay blank, and repairs only verified metadata', async () => {
    const current = subject(); const { original, evidence, observedAt } = await disputedPay(current);
    const before = await current.jobs.getJob(original.jobId);
    const blocked = await current.operations.stageRoleMetadataRepair(observedAt);
    expect(blocked.conflicts).toMatchObject([{ field: 'compensation' }]);
    const review = await current.operations.stageRoleMetadataOmission(original.jobId, observedAt);
    expect(review).toMatchObject({ expectedDecisions: 1, publicJobsChanged: 0, requiresSeparateRepairApproval: true });
    await expect(current.operations.approveRoleMetadataOmission(review.reviewToken, 2, observedAt)).rejects.toThrow('exactly');
    await expect(current.operations.approveRoleMetadataOmission('wrong', 1, observedAt)).rejects.toThrow('missing');
    expect(await current.jobs.getJob(original.jobId)).toEqual(before);
    await current.operations.approveRoleMetadataOmission(review.reviewToken, 1, observedAt);
    expect(await current.jobs.getJob(original.jobId)).toEqual(before);
    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    expect(plan.conflicts).toEqual([]);
    expect(plan.reviewedOmissions).toEqual([{ jobId: original.jobId, reviewToken: review.reviewToken }]);
    expect(plan.fillsByField.housing).toBe(1);
    await current.operations.applyRoleMetadataRepair(plan.repairToken, 1, 0, observedAt);
    const repaired = (await current.jobs.getJob(original.jobId))!;
    expect(repaired.compensation).toEqual({ raw: '' });
    expect(repaired.housing?.[0]?.minAmount).toBe(2500);
    expect(repaired.notification).toEqual(original.notification);
    expect(repaired.admission).toEqual(original.admission);
    expect(repaired.open).toBe(original.open);
    expect(repaired.sourceReferences[0]?.admission).toEqual(original.sourceReferences[0]?.admission);
    expect(projectRoleMetadata(repaired).job.compensation).toEqual({ raw: '' });
    expect(projectRoleMetadata(repaired, evidence.map(item => ({ ...item, observedAt: '2026-09-07T12:00:00Z' }))).conflicts).toEqual([]);
    const changed = await disputedPay(current, original.jobId, true);
    expect(projectRoleMetadata(repaired, changed.evidence).conflicts).toMatchObject([{ field: 'compensation' }]);
    expect((await current.operations.stageRoleMetadataRepair(observedAt)).conflicts).toMatchObject([{ field: 'compensation' }]);
    expect(current.database.prepare('SELECT count(*) AS count FROM role_metadata_review_guards').get()).toMatchObject({ count: 1 });
    expect(current.database.prepare('SELECT approved_at FROM role_metadata_review_plans WHERE token = ?').get(review.reviewToken)).toMatchObject({ approved_at: observedAt });
  });

  it('rejects stale review evidence atomically without recording an approval', async () => {
    const current = subject(); const { observedAt } = await disputedPay(current);
    const review = await current.operations.stageRoleMetadataOmission('job-1', observedAt);
    await disputedPay(current, 'job-1', true);
    await expect(current.operations.approveRoleMetadataOmission(review.reviewToken, 1, observedAt)).rejects.toThrow();
    expect(current.database.prepare('SELECT count(*) AS count FROM role_metadata_review_decisions').get()).toMatchObject({ count: 0 });
    expect(current.database.prepare('SELECT count(*) AS count FROM role_metadata_review_guards').get()).toMatchObject({ count: 0 });
  });

  it('does not excuse a different job or a different field, and never applies an incomplete collection', async () => {
    const current = subject(); const { observedAt } = await disputedPay(current);
    await disputedPay(current, 'other-job');
    const review = await current.operations.stageRoleMetadataOmission('job-1', observedAt);
    await current.operations.approveRoleMetadataOmission(review.reviewToken, 1, observedAt);
    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, 0, observedAt)).rejects.toThrow('conflicts');
    current.database.prepare("DELETE FROM role_metadata_extraction_attempts WHERE job_id = 'job-1'").run();
    current.database.prepare("DELETE FROM role_metadata_evidence WHERE job_id = 'job-1'").run();
    const incomplete = await current.operations.stageRoleMetadataRepair(observedAt);
    await expect(current.operations.applyRoleMetadataRepair(incomplete.repairToken, incomplete.expectedJobs, 0, observedAt)).rejects.toThrow();
  });

  it('rejects a review change after staging a repair, before any public update', async () => {
    const current = subject(); const { observedAt } = await disputedPay(current);
    const review = await current.operations.stageRoleMetadataOmission('job-1', observedAt);
    await current.operations.approveRoleMetadataOmission(review.reviewToken, 1, observedAt);
    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    current.database.prepare('DELETE FROM role_metadata_review_decisions').run();
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, 0, observedAt)).rejects.toThrow('reviews changed');
    expect((await current.jobs.getJob('job-1'))?.housing).toBeUndefined();
    expect(current.database.prepare('SELECT count(*) AS count FROM role_metadata_repair_guards').get()).toMatchObject({ count: 0 });
  });
});

describe('D1 role metadata evidence and guarded repair', () => {
  it('replaces flattened salary conflicts with labeled browser evidence before guarded repair', async () => {
    const current = subject(); const original = jobWithVerifiedDestination();
    await current.jobs.putInternship(original);
    const rows = ['Region One\n$120K – $150K', 'Region Two\n$95K – $120K', 'Canada\nCA$140K – CA$175K'];
    for (const labeled of [false, true]) {
      const inspectedAt = labeled ? '2026-09-06T07:00:00.000Z' : '2026-09-06T06:00:00.000Z';
      const evidence = combineRenderedFrameEvidence({ role: original.title, frames: [{ url: original.applyUrl,
        title: original.title, visibleText: `${original.title}. Compensation ${rows.join(' ')}`,
        ...(labeled ? { compensationRows: rows } : {}), jobPostingCount: 1, distinctJobLinkCount: 0, applicationFormPresent: true }] })!;
      await persistDestinationAdmission({ jobs: current.jobs, operations: current.operations, job: original,
        reference: original.sourceReferences[0]!, reachability: 'live', inspectedAt, evidence, browserVisible: true,
        message: { version: 1, jobId: original.jobId, sourceId: 'community-acme', externalId: 'row-1',
          providerIdentity: { provider: 'github', sourceId: 'community-acme', sourceUrl: original.applyUrl },
          candidateUrl: original.applyUrl, queuedAt: inspectedAt, reason: 'historical-backfill',
          metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION, metadataBackfillToken: 'label-repair' } });
      const plan = await current.operations.stageRoleMetadataRepair(inspectedAt);
      if (!labeled) { expect(plan.conflicts.length).toBeGreaterThan(0); continue; }
      expect(plan.conflicts).toEqual([]);
      expect((await current.jobs.getJob(original.jobId))?.compensation.raw).toBe('');
      await current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, 0, inspectedAt);
    }
    expect((await current.jobs.getJob(original.jobId))?.compensation.ranges).toHaveLength(3);
    expect((await current.jobs.getJob(original.jobId))?.notification).toEqual(original.notification);
  });

  it.each(['greenhouse', 'lever', 'ashby'] as const)('stages %s API evidence on a GitHub discovery and publishes it only through exact repair guards', async (provider) => {
    const current = subject(); const original = jobWithVerifiedDestination();
    await current.jobs.putInternship(original);
    const before = await current.jobs.getJob(original.jobId);
    const postingId = provider === 'greenhouse' ? '123' : 'ef725594-42dd-4f0d-ba8e-df8179dbc6cb';
    const identity = { provider, tenant: 'acme', postingId, sourceId: 'community-acme', sourceUrl: original.applyUrl };
    const method = `${provider}-api` as const;
    const payload = provider === 'greenhouse' ? { id: 123, title: original.title,
      content: 'The salary for this role is USD 4500 - 5800 per week.\nUSD $2500 monthly housing stipend.', location: { name: 'New York, NY' } }
      : provider === 'lever' ? { id: postingId, text: original.title, hostedUrl: `https://jobs.lever.co/acme/${postingId}`,
        descriptionPlain: 'Build software.\nUSD $2500 monthly housing stipend.', salaryRange: { currency: 'USD', min: 4500, max: 5800, interval: 'per-week-salary' },
        lists: [{ text: 'Requirements', content: 'Must hold a bachelors degree.' }] }
        : { jobs: [{ id: postingId, title: original.title, jobUrl: `https://jobs.ashbyhq.com/acme/${postingId}`,
          descriptionPlain: 'Build software.\nUSD $2500 monthly housing stipend.', compensation: { scrapeableCompensationSalarySummary: 'Salary USD 4500 - 5800 per week' } }] };
    const artifact = parseMetadataApiResponse(identity, method, payload);
    const observedAt = '2026-09-05T12:00:00.000Z';
    await persistDestinationAdmission({ jobs: current.jobs, operations: current.operations, job: original, reference: original.sourceReferences[0]!,
      message: { version: 1, jobId: original.jobId, sourceId: 'community-acme', externalId: 'row-1', providerIdentity: identity,
        candidateUrl: original.applyUrl, queuedAt: observedAt, reason: 'historical-backfill', metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION, metadataBackfillToken: 'collection-api' },
      reachability: 'live', inspectedAt: observedAt,
      apiAcquisition: { method, sourceUrl: original.applyUrl, outcome: 'acquired', artifact } });
    expect(await current.jobs.getJob(original.jobId)).toEqual(before);
    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    expect(plan.expectedJobs).toBe(1);
    expect(plan.fillsByField.housing).toBe(1);
    await current.operations.applyRoleMetadataRepair(plan.repairToken, 1, 0, observedAt);
    const repaired = await current.jobs.getJob(original.jobId);
    expect(repaired?.compensation.ranges).toMatchObject([{ minAmount: 4500, maxAmount: 5800, period: 'weekly', currency: 'USD' }]);
    expect(repaired?.housing).toMatchObject([{ kind: 'stipend', minAmount: 2500, maxAmount: 2500, currency: 'USD', period: 'monthly' }]);
    expect(repaired?.notification).toEqual(original.notification);
    expect(repaired?.sourceReferences[0]?.admission).toEqual(original.sourceReferences[0]?.admission);
    expect(repaired?.applyUrl).toBe(original.applyUrl);
    expect(repaired?.compensation.minAnnualUSD).toBeUndefined();
    const laterList = extractPostingMetadataEvidence({ artifact: { title: original.title, text: 'No salary field in the board list.' },
      sourceClass: 'official-ats', sourceId: 'community-acme', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs',
      observedAt: '2026-09-05T12:05:00.000Z', exactPosting: true });
    const merged = mergeSourceOccurrence(repaired!.sourceReferences[0], { ...original.sourceReferences[0]!, metadataEvidence: laterList });
    expect(projectRoleMetadata({ ...repaired!, sourceReferences: [merged] }).job.compensation.ranges)
      .toMatchObject([{ minAmount: 4500, maxAmount: 5800, period: 'weekly' }]);
  });
  it('reserves disjoint resumable batches, revisits old versions and expires abandoned leases', async () => {
    const current = subject();
    for (const id of ['a', 'b', 'c']) await current.jobs.putInternship({ ...jobWithVerifiedDestination(), jobId: id });
    await current.operations.recordRoleMetadataExtraction({ jobId: 'a', sourceId: 'community-acme', sourceUrl: job().applyUrl,
      artifactHash: 'old', extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, outcome: 'no-explicit-metadata', observedAt: '2026-09-05T00:00:00.000Z' });
    const options = { observedBefore: '2026-09-01T00:00:00.000Z', reserveAt: '2026-09-05T01:00:00.000Z', after: '' };
    const first = await current.operations.metadataVerificationCandidates(1, options);
    expect(first.map((row) => row.jobId)).toEqual(['a']);
    expect((await current.operations.metadataVerificationCandidates(1, options)).map((row) => row.jobId)).toEqual(['b']);
    expect((await current.operations.metadataVerificationCandidates(1, { ...options, after: 'b\0community-acme' })).map((row) => row.jobId)).toEqual(['c']);
    expect(await current.operations.metadataVerificationCandidates(1, options)).toEqual([]);
    expect((await current.operations.metadataVerificationCandidates(1, { ...options, reserveAt: '2026-09-05T01:31:00.000Z' })).map((row) => row.jobId)).toEqual(['a']);
  });

  it('collects withheld open roles and ignores only superseded-version retry backoff', async () => {
    const current = subject(); const original = jobWithVerifiedDestination();
    const withheld = { ...original, admission: { ...original.admission!, catalogEligible: false, alertEligible: false } };
    await current.jobs.putInternship(withheld);
    await current.jobs.putInternship({ ...original, jobId: 'closed', open: false });
    await current.operations.recordMetadataAcquisition(original.jobId, 'community-acme', '2026-09-05T00:00:00.000Z',
      { extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1, complete: true }, '2026-10-05T00:00:00.000Z');
    expect((await current.operations.roleMetadataAudit()).collectionCoverage.eligible).toBe(1);
    expect((await current.operations.metadataVerificationCandidates(10, { reserveAt: '2026-09-06T00:00:00.000Z' })).map(row => row.jobId)).toEqual([original.jobId]);
    expect(await current.operations.metadataVerificationCandidates(10, { reserveAt: '2026-09-06T00:01:00.000Z' })).toEqual([]);
    expect((await current.jobs.getJob(original.jobId))?.admission?.catalogEligible).toBe(false);
  });

  it('collects a confirmed legacy Workday occurrence without inventing admission', async () => {
    const current = subject(); const original = job();
    original.applyUrl = 'https://acme.wd1.myworkdayjobs.com/External/job/New-York/Intern_R123';
    original.sourceReferences[0] = { ...original.sourceReferences[0]!, applyUrl: original.applyUrl,
      postingIdentityDecision: { status: 'confirmed', exactKey: 'provider:workday:acme:r123', provider: 'workday', tenant: 'acme',
        evidenceKind: 'immutable-provider-id', contractId: 'posting-provider-workday', contractVersion: 1,
        approvalReference: 'registry:workday:v1', evidenceHash: 'confirmed-hash', observedAt: '2026-09-05T00:00:00.000Z' } };
    await current.jobs.putInternship(original);
    expect((await current.operations.roleMetadataAudit()).collectionCoverage.eligible).toBe(1);
    expect(await current.operations.metadataVerificationCandidates(10)).toMatchObject([
      { jobId: original.jobId, providerIdentity: { provider: 'workday', tenant: 'acme', postingId: 'r123' } },
    ]);
    expect((await current.jobs.getJob(original.jobId))?.admission).toBeUndefined();
    original.sourceReferences[0] = { ...original.sourceReferences[0]!, applyUrl: original.applyUrl.replace('R123', 'R999') };
    await current.jobs.putInternship(original);
    expect(await current.operations.metadataVerificationCandidates(10)).toEqual([]);
    expect((await current.operations.roleMetadataAudit()).collectionCoverage.eligible).toBe(0);
  });

  it('backs off failed acquisitions without calling them complete or starving other jobs', async () => {
    const current = subject();
    for (const id of ['a', 'b']) await current.jobs.putInternship({ ...jobWithVerifiedDestination(), jobId: id });
    await current.operations.recordMetadataAcquisition('a', 'community-acme', '2026-09-05T00:00:00.000Z',
      { fields: { compensation: 'acquisition-failed' }, complete: false, method: 'browser' }, '2026-09-06T00:00:00.000Z');
    expect((await current.operations.metadataVerificationCandidates(5, { reserveAt: '2026-09-05T01:00:00.000Z' })).map((row) => row.jobId)).toEqual(['b']);
    const audit = await current.operations.roleMetadataAudit(new Date('2026-09-05T01:00:00.000Z'));
    expect(audit.collectionCoverage.complete).toBe(false);
    expect(audit.disclosureRecall).toBeNull();
    expect(audit.fieldOutcomes['github/browser/compensation']).toEqual({ 'acquisition-failed': 1 });
  });
  it('reports and blocks incomplete exact-destination collection', async () => {
    const current = subject();
    const original = jobWithVerifiedDestination();
    await current.jobs.putInternship(original);
    const firstAudit = await current.operations.roleMetadataAudit(new Date('2026-09-04T12:00:00.000Z'));
    expect(firstAudit.collectionCoverage).toMatchObject({
      extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, eligible: 1, current: 0, pendingOrUnobserved: 1, stale: 0, complete: false,
    });
    const incompletePlan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:00:00.000Z');
    await expect(current.operations.applyRoleMetadataRepair(
      incompletePlan.repairToken,
      incompletePlan.expectedJobs,
      incompletePlan.expectedOccurrences,
      '2026-09-04T12:01:00.000Z',
    )).rejects.toThrow('collection was incomplete during the dry-run');

    await current.operations.recordRoleMetadataExtraction({
      jobId: original.jobId,
      sourceId: original.sourceReferences[0]!.sourceId,
      sourceUrl: original.applyUrl,
      artifactHash: 'no-explicit-metadata',
      extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      outcome: 'no-explicit-metadata',
      observedAt: '2026-07-01T12:02:00.000Z',
      backfillToken: 'collection-1',
    });
    const staleAudit = await current.operations.roleMetadataAudit(new Date('2026-09-04T12:03:00.000Z'));
    expect(staleAudit.collectionCoverage).toMatchObject({
      eligible: 1, current: 0, pendingOrUnobserved: 0, stale: 1, complete: false,
    });
    const stalePlan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:03:00.000Z');
    await expect(current.operations.applyRoleMetadataRepair(
      stalePlan.repairToken,
      stalePlan.expectedJobs,
      stalePlan.expectedOccurrences,
      '2026-09-04T12:04:00.000Z',
    )).rejects.toThrow('collection was incomplete during the dry-run');

    await current.operations.recordRoleMetadataExtraction({
      jobId: original.jobId,
      sourceId: original.sourceReferences[0]!.sourceId,
      sourceUrl: original.applyUrl,
      artifactHash: 'no-explicit-metadata',
      extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      outcome: 'no-explicit-metadata',
      observedAt: '2026-09-04T12:05:00.000Z',
      backfillToken: 'collection-1',
    });
    const completeAudit = await current.operations.roleMetadataAudit(new Date('2026-09-04T12:06:00.000Z'));
    expect(completeAudit.collectionCoverage).toMatchObject({
      eligible: 1, current: 1, pendingOrUnobserved: 0, stale: 0, complete: true,
      outcomes: { 'no-explicit-metadata': 1 }, backfillTokens: { 'collection-1': 1 },
    });
    const completePlan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:06:00.000Z');
    await expect(current.operations.applyRoleMetadataRepair(
      completePlan.repairToken,
      completePlan.expectedJobs,
      completePlan.expectedOccurrences,
      '2026-09-04T12:07:00.000Z',
    )).resolves.toMatchObject({ changed: 0, occurrencesChanged: 0, projectionRefreshRequired: false });
  });

  it('retains artifact history and silently applies an exact staged projection', async () => {
    const current = subject();
    const original = job();
    await current.jobs.putInternship(original);
    current.database.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('OUTBOX#old', 'EVENT', 'notification-event', '{}')").run();
    const superseded = extractPostingMetadataEvidence({
      artifact: { title: original.title, compensationText: 'USD $40/hour', locations: ['New York, NY'] },
      sourceClass: 'official-page', sourceId: 'community-acme', sourceUrl: original.applyUrl,
      observedAt: '2026-09-03T12:00:00.000Z', exactPosting: true,
    });
    const evidence = extractPostingMetadataEvidence({
      artifact: { title: original.title, text: 'Location: New York, NY. Pay is USD $45-$55/hour. This role is hybrid.',
        compensationText: 'USD $45-$55/hour', locations: ['New York, NY'], workMode: 'Hybrid' },
      sourceClass: 'official-page', sourceId: 'community-acme', sourceUrl: original.applyUrl,
      observedAt: '2026-09-04T12:00:00.000Z', exactPosting: true,
    });
    const projected = projectRoleMetadata({ ...original, sourceReferences: [{ ...original.sourceReferences[0]!, metadataEvidence: evidence }] });
    await current.operations.recordRoleMetadataEvidence(original.jobId, superseded, [], '2026-09-03T12:00:00.000Z');
    await current.operations.recordRoleMetadataEvidence(original.jobId, evidence, projected.conflicts, '2026-09-04T12:00:00.000Z');
    expect(current.database.prepare('SELECT count(*) AS total, sum(is_current) AS current FROM role_metadata_evidence').get())
      .toEqual({ total: 2, current: 1 });
    const plan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:01:00.000Z');
    expect(plan).toMatchObject({ expectedJobs: 1, expectedOccurrences: 0, conflicts: [], fillsByField: { compensation: 1, workMode: 1 } });
    const result = await current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, plan.expectedOccurrences, '2026-09-04T12:02:00.000Z');
    expect(result).toEqual({ changed: 1, occurrencesChanged: 0, projectionRefreshRequired: true });
    expect(await current.jobs.getJob(original.jobId)).toMatchObject({
      jobId: original.jobId, compensation: { minHourlyUSD: 45, maxHourlyUSD: 55 }, workMode: 'hybrid',
      notification: original.notification, firstSeenAt: original.firstSeenAt,
    });
    expect(current.database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 1 });
    expect((await current.operations.roleMetadataAudit()).projectionOnlyOmissions).toEqual([]);
  });

  it.each([false, true])('keeps large repair batches atomic with an outside-batch conflict: %s', async (hasConflict) => {
    const current = subject();
    const observedAt = '2026-09-04T12:00:00.000Z';
    const original = job();
    const evidence = extractPostingMetadataEvidence({
      artifact: { title: original.title, compensationText: 'USD $45/hour' }, sourceClass: 'official-page', sourceId: 'community-acme',
      sourceUrl: original.applyUrl, observedAt, exactPosting: true,
    });
    for (let index = 0; index <= METADATA_REPAIR_RECORD_LIMIT; index += 1) {
      const jobId = `batch-${String(index).padStart(4, '0')}`;
      await current.jobs.putInternship({ ...original, jobId });
      await current.operations.recordRoleMetadataEvidence(jobId, evidence, [], observedAt);
    }
    if (hasConflict) {
      const conflictId = 'z-conflict';
      await current.jobs.putInternship({ ...original, jobId: conflictId, sourceReferences: [
        original.sourceReferences[0]!, { ...original.sourceReferences[0]!, sourceId: 'second-source' },
      ] });
      await current.operations.recordRoleMetadataEvidence(conflictId, evidence, [], observedAt);
      await current.operations.recordRoleMetadataEvidence(conflictId, extractPostingMetadataEvidence({
        artifact: { title: original.title, compensationText: 'USD $60/hour' }, sourceClass: 'official-page', sourceId: 'second-source',
        sourceUrl: 'https://second.example.test/jobs/123', observedAt, exactPosting: true,
      }), [], observedAt);
    }
    const first = await current.operations.stageRoleMetadataRepair(observedAt);
    expect(first).toMatchObject({ expectedJobs: METADATA_REPAIR_RECORD_LIMIT, remainingJobs: 1,
      expectedOccurrences: 0, fillsByField: { compensation: METADATA_REPAIR_RECORD_LIMIT } });
    if (hasConflict) {
      expect(first.conflicts).toMatchObject([{ field: 'compensation' }]);
      await expect(current.operations.applyRoleMetadataRepair(first.repairToken, first.expectedJobs, 0, observedAt))
        .rejects.toThrow('conflicts must be resolved');
      expect((await current.jobs.getJob('batch-0000'))?.compensation.raw).toBe('');
      return;
    }
    await expect(current.operations.applyRoleMetadataRepair(first.repairToken, METADATA_REPAIR_RECORD_LIMIT + 1, 0, observedAt))
      .rejects.toThrow('plan changed');
    await current.operations.applyRoleMetadataRepair(first.repairToken, first.expectedJobs, 0, observedAt);
    expect((await current.jobs.getJob('batch-0250'))?.compensation.raw).toBe('');
    const second = await current.operations.stageRoleMetadataRepair(observedAt);
    expect(second).toMatchObject({ expectedJobs: 1, remainingJobs: 0, fillsByField: { compensation: 1 } });
    expect(second.repairToken).not.toBe(first.repairToken);
    await current.operations.applyRoleMetadataRepair(second.repairToken, second.expectedJobs, 0, observedAt);
    expect((await current.operations.stageRoleMetadataRepair(observedAt)).expectedJobs).toBe(0);
    expect((await current.jobs.getJob('batch-0250'))?.notification).toEqual(original.notification);
  });

  it('rejects a stale original JSON guard', async () => {
    const current = subject();
    await current.jobs.putInternship(job());
    const evidence = extractPostingMetadataEvidence({
      artifact: { title: job().title, compensationText: 'USD $45/hour' }, sourceClass: 'official-page', sourceId: 'community-acme',
      sourceUrl: job().applyUrl, observedAt: '2026-09-04T12:00:00.000Z', exactPosting: true,
    });
    await current.operations.recordRoleMetadataEvidence('job-1', evidence, [], '2026-09-04T12:00:00.000Z');
    const plan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:01:00.000Z');
    await current.jobs.putInternship({ ...job(), lastSeenAt: '2026-09-04T12:01:30.000Z' });
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, 1, 0, '2026-09-04T12:02:00.000Z')).rejects.toThrow();
    expect((await current.jobs.getJob('job-1'))?.compensation.raw).toBe('');
  });

  it('binds combined historical conflicts to the dry-run token', async () => {
    const current = subject();
    const conflictJob = { ...job(), sourceReferences: [
      { ...job().sourceReferences[0]!, sourceId: 'source-one', externalId: 'one' },
      { ...job().sourceReferences[0]!, sourceId: 'source-two', externalId: 'two' },
    ] };
    const safeJob = { ...job(), jobId: 'job-2', normalizedUrl: 'https://careers.acme.test/jobs/456',
      applyUrl: 'https://careers.acme.test/jobs/456', fingerprint: 'fingerprint-2', sourceReferences: [
        { ...job().sourceReferences[0]!, sourceId: 'source-safe', externalId: 'safe' },
      ] };
    await current.jobs.putInternship(conflictJob);
    await current.jobs.putInternship(safeJob);
    const pay = (sourceId: string, amount: number) => extractPostingMetadataEvidence({
      artifact: { title: job().title, compensationText: `USD $${amount}/hour` }, sourceClass: 'official-page', sourceId,
      sourceUrl: `https://${sourceId}.example.test/jobs/123`, observedAt: '2026-09-04T12:00:00.000Z', exactPosting: true,
    });
    await current.operations.recordRoleMetadataEvidence('job-1', pay('source-one', 40), [], '2026-09-04T12:00:00.000Z');
    await current.operations.recordRoleMetadataEvidence('job-1', pay('source-two', 50), [], '2026-09-04T12:00:00.000Z');
    await current.operations.recordRoleMetadataEvidence('job-2', pay('source-safe', 60), [], '2026-09-04T12:00:00.000Z');
    const plan = await current.operations.stageRoleMetadataRepair('2026-09-04T12:01:00.000Z');
    expect(plan).toMatchObject({ expectedJobs: 1, conflicts: [{ field: 'compensation' }] });
    expect(current.database.prepare("SELECT count(*) AS count FROM role_metadata_conflicts WHERE state = 'open'").get()).toEqual({ count: 0 });
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, plan.expectedOccurrences,
      '2026-09-04T12:02:00.000Z')).rejects.toThrow('conflicts must be resolved');
    expect((await current.jobs.getJob('job-2'))?.compensation.raw).toBe('');
  });

  it('requeues projected exact-page evidence after the revalidation cutoff', async () => {
    const current = subject();
    const evidence = extractPostingMetadataEvidence({
      artifact: { title: job().title, compensationText: 'USD $45/hour' }, sourceClass: 'official-page',
      sourceId: 'community-acme', sourceUrl: job().applyUrl, observedAt: '2026-07-01T12:00:00.000Z', exactPosting: true,
    });
    const destination = {
      classification: 'posting-detail' as const, candidateUrl: job().applyUrl, finalUrl: job().applyUrl,
      provider: 'github' as const, inspectedAt: '2026-07-01T12:00:00.000Z', browserVisible: true,
    };
    const admission = {
      employerResolution: 'resolved' as const, postingAttribution: 'attributed' as const, destination,
      metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
      catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt: '2026-07-01T12:00:00.000Z',
      evidenceObservedAt: '2026-07-01T12:00:00.000Z',
    };
    const currentJob = job();
    currentJob.sourceReferences = [{ ...currentJob.sourceReferences[0]!, metadataEvidence: evidence, admission }];
    currentJob.admission = admission;
    await current.jobs.putInternship(currentJob);
    await current.operations.recordRoleMetadataEvidence(currentJob.jobId, evidence, [], '2026-07-01T12:00:00.000Z');
    await expect(current.operations.metadataVerificationCandidates(10, {
      observedBefore: '2026-08-01T00:00:00.000Z', includeUnobserved: false, requireProjectedEvidence: true,
    })).resolves.toMatchObject([{ jobId: 'job-1', sourceId: 'community-acme', metadataArtifactHash: evidence[0]!.artifactHash }]);
    await expect(current.operations.metadataVerificationCandidates(10, {
      observedBefore: '2026-06-01T00:00:00.000Z', includeUnobserved: false, requireProjectedEvidence: true,
    })).resolves.toEqual([]);
  });

  it('bounds staged repair bytes while retaining conflicts beyond the byte-limited prefix', async () => {
    const current = subject();
    const observedAt = '2026-09-04T12:00:00.000Z';
    const padding = 'x'.repeat(2_200_000);
    const evidence = extractPostingMetadataEvidence({
      artifact: { title: job().title, compensationText: 'USD $45/hour' }, sourceClass: 'official-page', sourceId: 'community-acme',
      sourceUrl: job().applyUrl, observedAt, exactPosting: true,
    });
    for (const jobId of ['a-large', 'b-large']) {
      await current.jobs.putInternship({ ...job(), jobId, location: padding });
      await current.operations.recordRoleMetadataEvidence(jobId, evidence, [], observedAt);
    }
    const conflicting = { ...job(), jobId: 'z-conflict', sourceReferences: [
      job().sourceReferences[0]!, { ...job().sourceReferences[0]!, sourceId: 'second-source' },
    ] };
    await current.jobs.putInternship(conflicting);
    await current.operations.recordRoleMetadataEvidence(conflicting.jobId, evidence, [], observedAt);
    await current.operations.recordRoleMetadataEvidence(conflicting.jobId, extractPostingMetadataEvidence({
      artifact: { title: conflicting.title, compensationText: 'USD $60/hour' }, sourceClass: 'official-page', sourceId: 'second-source',
      sourceUrl: 'https://second.example.test/jobs/123', observedAt, exactPosting: true,
    }), [], observedAt);

    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    expect(plan).toMatchObject({ expectedJobs: 1, remainingJobs: 1, conflicts: [{ field: 'compensation' }] });
    const staged = current.database.prepare(`SELECT count(*) AS count,
      sum(length(CAST(original_value AS BLOB)) + length(CAST(proposed_value AS BLOB))) AS bytes
      FROM role_metadata_repair_stage WHERE token = ?`).get(plan.repairToken) as { count: number; bytes: number };
    expect(staged.count).toBe(1);
    expect(staged.bytes).toBeLessThanOrEqual(ATOMIC_REPAIR_BYTE_LIMIT);
    await expect(current.operations.applyRoleMetadataRepair(plan.repairToken, 1, 0, observedAt)).rejects.toThrow('conflicts must be resolved');
  });

  it('preserves the legacy sorted job-and-evidence hash snapshot', async () => {
    const current = subject();
    const observedAt = '2026-09-04T12:00:00.000Z';
    for (const jobId of ['b-job', 'a-job']) {
      await current.jobs.putInternship({ ...job(), jobId });
      await current.operations.recordRoleMetadataEvidence(jobId, extractPostingMetadataEvidence({
        artifact: { title: job().title, compensationText: `USD $${jobId === 'a-job' ? 45 : 55}/hour` },
        sourceClass: 'official-page', sourceId: 'community-acme', sourceUrl: job().applyUrl, observedAt, exactPosting: true,
      }), [], observedAt);
    }
    const plan = await current.operations.stageRoleMetadataRepair(observedAt);
    const rows = current.database.prepare(`SELECT job_id, evidence FROM role_metadata_evidence
      WHERE is_current = 1 ORDER BY job_id, source_class`).all() as Array<{ job_id: string; evidence: string }>;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const legacySnapshot = hash(rows.map(row => `${row.job_id}\0${hash(row.evidence)}`).sort().join('\n'));
    expect(current.database.prepare('SELECT evidence_snapshot FROM role_metadata_repair_plans WHERE token = ?')
      .get(plan.repairToken)).toEqual({ evidence_snapshot: legacySnapshot });
  });
});
