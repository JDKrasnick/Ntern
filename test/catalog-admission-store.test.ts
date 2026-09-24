import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCatalogAdmissionOperations } from '../cloudflare/catalog-admission-api.js';
import { D1CatalogAdmissionStore, destinationVerificationMatchesReference, DESTINATION_VERIFICATION_LEASE_LIMIT } from '../cloudflare/catalog-admission-store.js';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import { persistDestinationAdmission, reachabilityFromHttpStatus, type DestinationVerificationMessage } from '../cloudflare/destination-verification.js';
import { collectRoleMetadataInBackground } from '../cloudflare/worker.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { evaluateCatalogAdmission } from '../src/catalog-admission.js';
import { classifyDestination, matchingBrowserDestination } from '../src/destination-verification.js';
import { processPosting } from '../src/ingestion/processor.js';
import { newJobNotificationEvent } from '../src/ingestion/catalog-reconciler.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import type { CatalogAdmission, Internship } from '../src/types.js';

type QueryBudget = { used: number; maximum: number; queries?: string[] };

function sqliteD1(database: DatabaseSync, budget?: QueryBudget): D1Database {
  const count = (query: string) => {
    if (!budget) return;
    budget.queries?.push(query);
    budget.used += 1;
    if (budget.used > budget.maximum) throw new Error(`D1 query budget exceeded: ${budget.used}/${budget.maximum}`);
  };
  const prepared = (query: string, values: SQLInputValue[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) { return prepared(query, next as SQLInputValue[]); },
    async first<T>() { count(query); return database.prepare(query).get(...values) as T | null; },
    async all<T>() { count(query); return { results: database.prepare(query).all(...values) as T[] }; },
    async run() { count(query); const result = database.prepare(query).run(...values); return { meta: { changes: Number(result.changes) } }; },
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

function admission(catalogEligible: boolean): CatalogAdmission {
  return {
    canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved', postingAttribution: 'attributed',
    destination: { classification: catalogEligible ? 'posting-detail' : 'aggregate-board', candidateUrl: 'https://careers.acme.test/role-1',
      provider: 'structured', inspectedAt: '2026-08-26T12:00:00Z' },
    metadata: { complete: true, title: 'complete', location: 'complete' }, catalogEligible, alertEligible: catalogEligible,
    reasonCodes: catalogEligible ? [] : ['destination-aggregate-board'], evaluatedAt: '2026-08-26T12:00:00Z', evidenceObservedAt: '2026-08-26T12:00:00Z',
  };
}

function job(): Internship {
  return {
    jobId: 'job-1', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
    applyUrl: 'https://careers.acme.test/role-1', normalizedUrl: 'https://careers.acme.test/role-1', fingerprint: 'fingerprint',
    compensation: { raw: '' }, sourceReferences: [], technical: true, open: true,
    firstSeenAt: '2026-08-01T00:00:00Z', catalogVisibleAt: '2026-08-01T00:00:00Z', catalogRecency: 'normal',
    lastSeenAt: '2026-08-26T00:00:00Z', notification: { smsPending: false, smsSentAt: '2026-08-02T00:00:00Z', digestPending: false },
    admission: admission(false),
  };
}

function subject(budget?: QueryBudget) {
  const database = new DatabaseSync(':memory:');
  for (const migration of ['0001_initial.sql', '0007_catalog_admission.sql', '0008_catalog_admission_occurrence_repair.sql',
    '0010_posting_identity.sql',
    '0012_destination_verification_schedule.sql',
    '0015_role_metadata_enrichment.sql', '0016_role_metadata_repair_plans.sql', '0017_metadata_acquisition.sql', '0018_metadata_review.sql', '0019_metadata_job_review_revision.sql',
    '0013_canonical_employer_icons.sql']) {
    database.exec(readFileSync(new URL(`../cloudflare/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const db = sqliteD1(database, budget);
  return { database, db, admission: new D1CatalogAdmissionStore(db), jobs: new D1InternshipStore(db) };
}

describe('D1 catalog admission operations', () => {
  afterEach(() => vi.useRealTimers());
  it('forwards verified-page replacement through the internship store adapter', async () => {
    const { database, jobs } = subject();
    const evidence = (sourceClass: 'official-json-ld' | 'official-page', artifactHash: string) => ({
      schemaVersion: 1 as const,
      extractionVersion: 1,
      artifactHash,
      sourceClass,
      sourceId: 'community-list',
      sourceUrl: 'https://careers.acme.test/role-1',
      observedAt: '2026-09-04T00:00:00Z',
      exactPosting: true as const,
    });
    await jobs.recordRoleMetadataEvidence('job-1', [evidence('official-json-ld', 'old-json-ld')], [], '2026-09-04T00:00:00Z');

    await jobs.recordRoleMetadataEvidence('job-1', [evidence('official-page', 'current-page')], [], '2026-09-05T00:00:00Z', {
      sourceId: 'community-list',
      sourceClasses: ['official-json-ld', 'official-page'],
    });

    expect(database.prepare('SELECT source_class, artifact_hash FROM role_metadata_evidence WHERE is_current = 1').all())
      .toEqual([{ source_class: 'official-page', artifact_hash: 'current-page' }]);
  });

  it.each([
    ['Tesla', 'tesla', 'tesla', 'https://www.tesla.com/careers/search/job/software-engineer-intern-275558'],
    ['Meta', 'meta', 'meta', 'https://www.metacareers.com/jobs/1027438186737957'],
    ['Jane Street', 'janestreet', 'jane-street', 'https://www.janestreet.com/join-jane-street/position/8599644002'],
    ['Goldman Sachs', 'goldman-sachs', 'goldman-sachs', 'https://higher.gs.com/roles/171567'],
    ['IMC', 'imc', 'imc', 'https://www.imc.com/us/careers/jobs/4823924101'],
  ] as const)('admits a new reviewed-community %s role through its official provider mapping', async (
    company, provider, canonicalEmployerId, applyUrl,
  ) => {
    const current = subject();
    const migration = readFileSync(new URL('../cloudflare/migrations/0012_official_career_provider_identity.sql', import.meta.url), 'utf8');
    current.database.exec(migration);
    current.database.exec(migration);
    const listing = processPosting({
      sourceId: 'community-list', provenance: 'reviewed-community', externalId: `${provider}-role`,
      sourceUrl: 'https://github.com/example/jobs', fetchedAt: '2026-09-01T12:00:00Z',
      employer: { name: company, authority: 'source-row' }, title: 'Software Engineering Intern',
      content: [{ kind: 'description', format: 'plain', value: 'Build production software.' }],
      locations: ['New York, NY'], applyUrl, sourceState: 'open', lifecycleAuthority: 'source',
    }).listing!;
    expect(listing.providerIdentity).toMatchObject({ provider, tenant: provider });
    const canonicalEmployer = await current.admission.resolveCanonicalEmployer(listing.providerIdentity!);
    expect(canonicalEmployer).toEqual({ id: canonicalEmployerId, displayName: company });
    const reviewed = {
      ...listing,
      employerEvidence: { authority: 'reviewed-registry' as const, canonicalEmployer: canonicalEmployer! },
    };
    const destination = classifyDestination({
      listing: reviewed, reachability: 'implied', inspectedAt: '2026-09-01T12:00:00Z',
    });
    expect(destination.classification).toBe('posting-detail');
    expect(evaluateCatalogAdmission({
      listing: reviewed, destination, postingAttributed: true, evaluatedAt: '2026-09-01T12:00:00Z',
    })).toMatchObject({ employerResolution: 'resolved', catalogEligible: true, alertEligible: true, reasonCodes: [] });
  });

  it('requires explicit mapping supersession', async () => {
    const { admission: store } = subject();
    await store.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' }, '2026-08-26T00:00:00Z');
    await store.putCanonicalEmployer({ id: 'new-acme', displayName: 'New Acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' }, '2026-08-26T00:00:00Z');
    await store.supersedeEmployerMapping({ id: 'first', provider: 'greenhouse', scope: 'axon', canonicalEmployerId: 'acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.supersedeEmployerMapping({ id: 'bad', provider: 'greenhouse', scope: 'axon', canonicalEmployerId: 'new-acme', reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer' })).rejects.toThrow('explicitly superseded');
    await store.supersedeEmployerMapping({ id: 'second', provider: 'greenhouse', scope: 'axon', canonicalEmployerId: 'new-acme', reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer', supersedesMappingId: 'first' });
    expect(await store.listEmployerMappings()).toMatchObject([
      { id: 'first', supersededAt: '2026-08-27T00:00:00Z' }, { id: 'second', supersedesMappingId: 'first' },
    ]);
    await expect(store.resolveCanonicalEmployer({ provider: 'greenhouse', sourceId: 'greenhouse-axon', tenant: 'axon', postingId: 'role-1', sourceUrl: 'https://example.test' }))
      .resolves.toEqual({ id: 'new-acme', displayName: 'New Acme' });
  });

  it('maps community rows by employer scope instead of the multi-employer source', async () => {
    const { admission: store } = subject();
    await store.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' }, '2026-08-26T00:00:00Z');
    await store.supersedeEmployerMapping({ id: 'unsafe-source', provider: 'github', scope: 'community-list', canonicalEmployerId: 'acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.resolveCanonicalEmployer({ provider: 'github', sourceId: 'community-list', employerScope: 'employer:other', sourceUrl: 'https://github.com/example/jobs' }))
      .resolves.toBeUndefined();
    await store.supersedeEmployerMapping({ id: 'acme-row', provider: 'github', scope: 'employer:acme', canonicalEmployerId: 'acme', reviewedAt: '2026-08-26T01:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.resolveCanonicalEmployer({ provider: 'github', sourceId: 'community-list', employerScope: 'employer:acme', sourceUrl: 'https://github.com/example/jobs' }))
      .resolves.toEqual({ id: 'acme', displayName: 'Acme' });
  });

  it('versions reviewed admission configuration deterministically', async () => {
    const { admission: store } = subject();
    const empty = await store.configurationVersion();
    expect(await store.configurationVersion()).toBe(empty);
    await store.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' }, '2026-08-26T00:00:00Z');
    const populated = await store.configurationVersion();
    expect(populated).not.toBe(empty);
    expect(await store.configurationVersion()).toBe(populated);
  });

  it('audits review records by source, destination, and prior notification history', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    current.sourceReferences = [{
      sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 1, company: current.company, title: current.title,
      location: current.location, locations: [current.location], season: current.season, applyUrl: current.applyUrl,
      compensation: current.compensation, state: 'open', admission: current.admission,
    }];
    await jobs.putInternship(current);

    await expect(store.audit()).resolves.toMatchObject({
      scanned: 1,
      review: 1,
      legacyUnclassified: 0,
      bySource: { 'community-list': 1 },
      byDestination: { 'aggregate-board': 1 },
      withNotificationHistory: 1,
      records: [{ jobId: current.jobId, sourceIds: ['community-list'], destinationClassification: 'aggregate-board', smsSent: true }],
    });
  });

  it('omits bounded detail queries for health-only audits', async () => {
    const budget: QueryBudget = { used: 0, maximum: 100, queries: [] };
    const { admission: store, jobs } = subject(budget);
    await jobs.putInternship(job());

    const audit = await store.audit({ includeRecords: false, includeUnresolvedEmployers: false });

    expect(audit).toMatchObject({ scanned: 1, review: 1, records: [], unresolvedEmployers: [] });
    expect(budget.queries?.some((query) => query.includes('SELECT pk, value'))).toBe(false);
    expect(budget.queries?.some((query) => query.includes('reference.value AS reference'))).toBe(false);
  });

  it('excludes roles at their publisher valid-through boundary', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    current.admission = admission(true);
    current.admission.destination.validThrough = '2026-09-01T12:00:00Z';
    await jobs.putInternship(current);

    await expect(store.audit({ now: new Date('2026-09-01T11:59:59Z') })).resolves.toMatchObject({ eligible: 1 });
    await expect(store.audit({ now: new Date('2026-09-01T12:00:00Z') })).resolves.toMatchObject({ eligible: 0 });
  });

  it('keeps production-scale admission audits and unresolved employer samples bounded in D1', async () => {
    const { database, admission: store } = subject();
    const insert = database.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, 'META', 'internship', ?)");
    const template = job();
    database.exec('BEGIN');
    for (let index = 0; index < 8_000; index += 1) {
      const value = { ...template, jobId: `scale-${index}`, admission: admission(false),
        sourceReferences: [{ sourceId: 'community-list', provenance: 'reviewed-community', externalId: `scale-${index}`,
          document: 'README.md', sourceUrl: 'https://github.com/example/jobs', row: index + 1, company: template.company,
          title: template.title, location: template.location, season: template.season,
          applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${1_000_000 + index}`,
          compensation: template.compensation, state: 'open' }],
        notification: { smsPending: false, digestPending: false } };
      insert.run(`JOB#scale-${index}`, JSON.stringify(value));
    }
    database.exec('COMMIT');

    const audit = await store.audit({ recordLimit: 25 });
    expect(audit.scanned).toBe(8_000);
    expect(audit.records).toHaveLength(25);
    expect(audit.recordsNextCursor).toBeDefined();
    expect(audit.unresolvedEmployerOccurrences).toBe(8_000);
    expect(audit.unresolvedEmployers).toMatchObject([{ provider: 'greenhouse', tenant: 'acme', labels: ['Acme'],
      occurrenceCount: 25, continuationConflicts: 0, withNotificationHistory: 0 }]);
    expect(audit.unresolvedEmployers[0]!.evidenceUrls).toHaveLength(25);
    expect(audit.unresolvedEmployersNextCursor).toBeDefined();
    await expect(store.audit({ recordLimit: 25, afterJobId: audit.recordsNextCursor })).resolves.toMatchObject({ scanned: 8_000 });
    const nextUrl = new URL('https://api.test/internal/admission/audit');
    nextUrl.searchParams.set('limit', '25');
    nextUrl.searchParams.set('afterUnresolvedEmployer', audit.unresolvedEmployersNextCursor!);
    const next = await handleCatalogAdmissionOperations(new Request(nextUrl), store, async () => undefined);
    await expect(next.json()).resolves.toMatchObject({ unresolvedEmployerOccurrences: 8_000,
      unresolvedEmployers: [{ provider: 'greenhouse', tenant: 'acme', occurrenceCount: 25 }] });
  });

  it('finds catalog candidates past the first page while walking the catalog in bounded pages', async () => {
    const queries: string[] = [];
    const budget: QueryBudget = { used: 0, maximum: 100_000, queries };
    const { admission: store, jobs } = subject(budget);
    const total = 250;
    for (let index = 0; index < total; index += 1) {
      const current = job();
      current.jobId = `job-${index}`;
      delete current.admission;
      current.sourceReferences = [{
        sourceId: 'community-list', provenance: 'reviewed-community', externalId: `row-${index}`, document: 'README.md',
        sourceUrl: 'https://github.com/example/jobs', row: index + 1, company: 'Acme', title: current.title,
        location: current.location, locations: [current.location], season: current.season,
        applyUrl: `https://careers-${index}.example.test/role-${index}`, compensation: current.compensation,
        state: 'open', employerLabelOrigin: 'explicit',
      }];
      await jobs.putInternship(current);
    }
    // The one occurrence carrying a reviewed destination sits on the last page.
    const reviewed = job();
    reviewed.jobId = 'job-last';
    const destination = admission(true);
    destination.destination = { ...destination.destination, candidateUrl: 'https://boards.acme.test/role-last',
      provider: 'greenhouse', tenant: 'acme' };
    reviewed.sourceReferences = [{
      ...job().sourceReferences[0]!, sourceId: 'community-list', externalId: 'row-last', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', applyUrl: 'https://boards.acme.test/role-last',
      locations: [reviewed.location], employerLabelOrigin: 'explicit', admission: destination,
    }];
    await jobs.putInternship(reviewed);

    queries.length = 0;
    await expect(store.reviewSampleCandidates({
      id: 'rule-boards-acme', host: 'boards.acme.test', provider: 'greenhouse', tenant: 'acme',
      decision: 'standard-provider-route', reviewedAt: '2026-09-01T00:00:00Z', reviewedBy: 'reviewer',
    }, 1)).resolves.toEqual([expect.objectContaining({ jobId: 'job-last', externalId: 'row-last' })]);
    // A second read that crosses a page boundary keeps the same bound.
    await expect(store.legacyVerificationCandidates(150)).resolves.toHaveLength(150);

    const catalogScans = queries.filter((query) => query.includes("kind = 'internship'"));
    expect(catalogScans.length).toBeGreaterThan(2);
    for (const query of catalogScans) expect(query).toMatch(/LIMIT \?/);
  });

  it('queues every unclassified occurrence with provider identity for historical verification', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    delete current.admission;
    current.sourceReferences = [{
      sourceId: 'community-list', provenance: 'reviewed-community', externalId: 'row-1', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, locations: [current.location], season: current.season,
      applyUrl: 'https://careers.acme.test/openings?gh_jid=7654321', compensation: current.compensation, state: 'open',
      employerLabelOrigin: 'explicit',
    }];
    await jobs.putInternship(current);

    await expect(store.legacyVerificationCandidates()).resolves.toEqual([{
      jobId: current.jobId, sourceId: 'community-list', externalId: 'row-1',
      candidateUrl: 'https://careers.acme.test/openings?gh_jid=7654321',
      providerIdentity: { provider: 'greenhouse', sourceId: 'community-list', sourceUrl: 'https://github.com/example/jobs',
        employerScope: 'employer:acme', postingId: '7654321' },
      occurrenceSnapshotHash: expect.any(String),
    }]);
  });

  it('never reconstructs an employer scope for cross-tenant inherited community rows', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    delete current.admission;
    const reference = {
      sourceId: 'community-list', provenance: 'reviewed-community' as const, externalId: 'row-2', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 2, company: 'Acme', title: current.title,
      location: current.location, season: current.season,
      applyUrl: 'https://other.wd1.myworkdayjobs.com/en-US/jobs/job/Security_R-102', compensation: current.compensation,
      state: 'open' as const, employerLabelOrigin: 'inherited' as const, employerInheritance: 'conflict' as const,
    };
    current.sourceReferences = [reference];
    await jobs.putInternship(current);
    const [candidate] = await store.legacyVerificationCandidates();
    expect(candidate?.providerIdentity).toMatchObject({ provider: 'workday', tenant: 'other', postingId: 'r-102' });
    expect(candidate?.providerIdentity).not.toHaveProperty('employerScope');

    const admitted = admission(true);
    admitted.destination = { ...admitted.destination, provider: 'workday', tenant: 'other', expectedPostingId: 'r-102',
      nextCheckAt: '2026-08-30T00:00:00Z' };
    await jobs.putInternship({ ...current, admission: admitted, sourceReferences: [{ ...reference, admission: admitted }] });
    await store.syncVerificationSchedule('2026-08-30T00:00:00Z');
    const [scheduled] = await store.leaseDueVerifications('2026-08-30T00:00:00Z');
    expect(scheduled?.providerIdentity).not.toHaveProperty('employerScope');
  });

  it('freezes resumable backfill generations and stores historical evidence without changing catalog JSON', async () => {
    const { database, admission: store, jobs } = subject();
    await store.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-30T00:00:00Z',
      reviewedBy: 'reviewer' }, '2026-08-30T00:00:00Z');
    await store.supersedeEmployerMapping({ id: 'greenhouse-acme', provider: 'greenhouse', scope: 'greenhouse-acme',
      canonicalEmployerId: 'acme', reviewedAt: '2026-08-30T00:00:00Z', reviewedBy: 'reviewer' });
    const current = job();
    delete current.admission;
    current.sourceReferences = [{ sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: '7654321', document: '7654321',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, locations: [current.location], season: current.season,
      applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321', compensation: current.compensation, state: 'open' }];
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: 'greenhouse-acme', externalId: '7654321', jobId: current.jobId,
      occurrence: current.sourceReferences[0]!, present: true, consecutiveOmissions: 0,
      changedSnapshotHash: 'snapshot', changedAt: '2026-08-29T00:00:00Z' });
    const before = await jobs.getJob(current.jobId);
    const generation = await store.previewBackfill('2026-08-30T00:00:00Z');
    expect(generation).toMatchObject({ state: 'previewed', total: 1, queued: 0, completed: 0 });
    const page = await store.backfillPage(generation.id, 0, 100);
    expect(page).toMatchObject([{ jobId: current.jobId, sourceId: 'greenhouse-acme', externalId: '7654321' }]);
    await store.markBackfillQueued(generation.id, [page[0]!.occurrenceKey], '2026-08-30T00:01:00Z');
    await store.recordBackfillEvidence({ generationId: generation.id, occurrenceKey: page[0]!.occurrenceKey,
      evidenceHash: 'candidate-hash', classification: 'posting-detail', value: {
        classification: 'posting-detail', candidateUrl: current.applyUrl, provider: 'greenhouse', tenant: 'acme',
        expectedPostingId: '7654321', inspectedAt: '2026-08-30T00:02:00Z', freshUntil: '2026-09-06T00:02:00Z',
      }, observedAt: '2026-08-30T00:02:00Z' });
    await store.recordBackfillEvidence({ generationId: generation.id, occurrenceKey: page[0]!.occurrenceKey,
      evidenceHash: 'redelivery-hash', classification: 'gone', value: { classification: 'gone' },
      observedAt: '2026-08-30T00:02:30Z' });
    expect(database.prepare(`SELECT evidence_hash, classification FROM admission_backfill_evidence
      WHERE generation_id = ? AND occurrence_key = ?`).get(generation.id, page[0]!.occurrenceKey))
      .toEqual({ evidence_hash: 'candidate-hash', classification: 'posting-detail' });
    expect(await store.backfillProgress(generation.id)).toMatchObject({ state: 'complete', queued: 1, completed: 1 });
    expect(await jobs.getJob(current.jobId)).toEqual(before);
    await jobs.putInternship({ ...current,
      sourceReferences: [{ ...current.sourceReferences[0]!, title: 'Completely Different Security Role' }] });
    await expect(store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme')).rejects.toThrow('drifted');
    await jobs.putInternship({ ...current, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/9999999',
      sourceReferences: [{ ...current.sourceReferences[0]!, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/9999999' }] });
    await expect(store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme')).rejects.toThrow('drifted');
    await jobs.putInternship(before!);
    const derived = await store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme');
    expect(derived).toMatchObject({ records: 2, changes: [{ jobId: current.jobId,
      admission: { catalogEligible: true, alertEligible: true } }] });
    const staged = await store.stageRepair(derived.changes, '2026-08-30T00:03:00Z');
    await store.applyRepair(staged.repairToken, staged.changed, '2026-08-30T00:04:00Z', staged.occurrencesChanged);
    expect(await jobs.getJob(current.jobId)).toMatchObject({ applicationUrlValidatedAt: '2026-08-30T00:02:00Z',
      admission: { catalogEligible: true },
      sourceReferences: [{ admission: { catalogEligible: true } }] });
    const zero = await store.stageRepair((await store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme')).changes,
      '2026-08-30T00:05:00Z');
    expect(zero).toMatchObject({ changed: 0, occurrencesChanged: 0 });
  });

  // This test's contract is the D1 query budget asserted below, not a wall clock:
  // it serializes 1,100 source references, so the default five-second timeout
  // fails on contention alone while the budget assertion still holds.
  it('freezes more than 1,000 legacy occurrences without exceeding the D1 invocation query budget', async () => {
    const { database, jobs } = subject();
    const current = job();
    delete current.admission;
    current.sourceReferences = Array.from({ length: 1_100 }, (_, index) => ({
      sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: `legacy-${index}`, document: `legacy-${index}`,
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: index + 1, company: current.company,
      title: current.title, location: current.location, season: current.season,
      applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${1_000_000 + index}`,
      compensation: current.compensation, state: 'open' as const,
    }));
    await jobs.putInternship(current);
    const budget = { used: 0, maximum: 1_000 };
    const store = new D1CatalogAdmissionStore(sqliteD1(database, budget));

    const generation = await store.previewBackfill('2026-08-30T00:00:00Z');

    expect(generation.total).toBe(1_100);
    expect(budget.used).toBeLessThan(10);
    await expect(store.deriveBackfillRepairBatch(generation.id, 'greenhouse-acme', 0, 121))
      .rejects.toThrow('between 1 and 120');
  }, 30_000);

  it('resumes schedule synchronization and prunes stale rows only after a complete bounded pass', async () => {
    const { database, jobs } = subject();
    const current = job();
    current.admission = admission(true);
    current.sourceReferences = Array.from({ length: 1_100 }, (_, index) => ({
      sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: `role-${index}`, document: `role-${index}`,
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: index + 1, company: current.company,
      title: current.title, location: current.location, season: current.season,
      applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${2_000_000 + index}`,
      compensation: current.compensation, state: 'open' as const, admission: current.admission,
    }));
    await jobs.putInternship(current);
    database.prepare(`INSERT INTO destination_verification_schedule
      (occurrence_key, job_id, source_id, external_id, candidate_url, provider_identity, next_check_at, updated_at)
      VALUES ('stale', 'removed-job', 'removed-source', 'removed-role', 'https://example.test/removed', '{}', ?, ?)`)
      .run('2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z');
    const budget = { used: 0, maximum: 1_000 };
    const store = new D1CatalogAdmissionStore(sqliteD1(database, budget));

    for (let invocation = 0; invocation < 5; invocation += 1) {
      budget.used = 0;
      await store.syncVerificationSchedule(`2026-08-30T00:0${invocation}:00Z`);
      expect(budget.used).toBeLessThan(1_000);
      if (invocation < 4) expect(database.prepare("SELECT count(*) AS count FROM destination_verification_schedule WHERE occurrence_key = 'stale'").get())
        .toEqual({ count: 1 });
    }
    expect(database.prepare('SELECT count(*) AS count FROM destination_verification_schedule').get()).toEqual({ count: 1_100 });
    expect(database.prepare('SELECT count(*) AS count FROM destination_verification_schedule_sync').get()).toEqual({ count: 0 });
    budget.used = 0;
    const leased = await store.leaseDueVerifications('2026-09-02T00:00:00Z', 1_000);
    expect(leased).toHaveLength(DESTINATION_VERIFICATION_LEASE_LIMIT);
    expect(new Set(leased.map((row) => row.leaseToken)).size).toBe(DESTINATION_VERIFICATION_LEASE_LIMIT);
    expect(budget.used).toBe(1);
    budget.used = 0;
    const next = await store.leaseDueVerifications('2026-09-02T00:00:00Z', 1_000);
    expect(next).toHaveLength(DESTINATION_VERIFICATION_LEASE_LIMIT);
    const claimedKeys = new Set(leased.map((row) => row.occurrenceKey));
    expect(next.some((row) => claimedKeys.has(row.occurrenceKey))).toBe(false);
    expect(budget.used).toBe(1);
  });

  it('leases due occurrence checks once and resumes after the lease expires', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    current.admission = admission(true);
    current.admission.destination.nextCheckAt = '2026-08-30T00:00:00Z';
    current.sourceReferences = [{ sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, season: current.season, applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321',
      compensation: current.compensation, state: 'open', admission: current.admission }];
    await jobs.putInternship(current);
    await store.syncVerificationSchedule('2026-08-30T00:00:00Z');
    const first = await store.leaseDueVerifications('2026-08-30T00:00:00Z');
    expect(first).toHaveLength(1);
    await expect(store.leaseDueVerifications('2026-08-30T00:01:00Z')).resolves.toEqual([]);
    const resumed = await store.leaseDueVerifications('2026-08-30T00:16:00Z');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.occurrenceKey).toBe(first[0]!.occurrenceKey);
  });

  it('does not immediately re-lease a completed validThrough closure', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    current.admission = admission(true);
    current.admission.destination.nextCheckAt = '2026-09-08T12:00:00Z';
    const reference = { sourceId: 'structured-acme', provenance: 'official-structured' as const, externalId: 'role-1',
      document: 'role-1', sourceUrl: 'https://careers.acme.test/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, season: current.season, applyUrl: current.applyUrl,
      compensation: current.compensation, state: 'open' as const, admission: current.admission };
    current.sourceReferences = [reference];
    await jobs.putInternship(current);
    await store.syncVerificationSchedule('2026-09-08T12:00:00Z');
    const [leased] = await store.leaseDueVerifications('2026-09-08T12:00:00Z');
    const destination = classifyDestination({
      listing: { ...reference, fetchedAt: '2026-09-08T12:00:00Z', providerIdentity: leased!.providerIdentity },
      reachability: 'live', browserVisible: true, inspectedAt: '2026-09-08T12:00:00Z',
      evidence: { url: reference.applyUrl, title: reference.title, postingIdPresent: true, jobPostingCount: 1,
        validThrough: '2026-09-07T12:00:00Z', confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: [] } },
    });
    expect(destination).toMatchObject({ classification: 'gone', nextCheckAt: '2026-09-14T12:00:00.000Z' });
    await store.completeScheduledVerification({ occurrenceKey: leased!.occurrenceKey, leaseToken: leased!.leaseToken,
      completedAt: '2026-09-08T12:00:00Z', classification: destination.classification,
      nextCheckAt: destination.nextCheckAt! });

    await expect(store.leaseDueVerifications('2026-09-08T12:30:00Z')).resolves.toEqual([]);
    await expect(store.leaseDueVerifications('2026-09-14T11:59:59Z')).resolves.toEqual([]);
    await expect(store.leaseDueVerifications('2026-09-14T12:00:00Z')).resolves.toHaveLength(1);
  });

  it('releases a stale lease immediately when the occurrence destination generation changes', async () => {
    const { admission: store, jobs } = subject();
    const current = job();
    const firstUrl = 'https://job-boards.greenhouse.io/acme/jobs/7654321';
    const secondUrl = 'https://job-boards.greenhouse.io/acme/jobs/8765432';
    current.admission = admission(true);
    current.admission.destination = { ...current.admission.destination, candidateUrl: firstUrl,
      provider: 'greenhouse', tenant: 'acme', expectedPostingId: '7654321', nextCheckAt: '2026-08-30T00:00:00Z' };
    const reference = { sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme', title: current.title,
      location: current.location, season: current.season, applyUrl: firstUrl,
      compensation: current.compensation, state: 'open' as const, admission: current.admission };
    current.sourceReferences = [reference];
    await jobs.putInternship(current);
    await store.syncVerificationSchedule('2026-08-30T00:00:00Z');
    expect(await store.leaseDueVerifications('2026-08-30T00:00:00Z')).toHaveLength(1);

    await jobs.putInternship({ ...current, applyUrl: secondUrl, normalizedUrl: secondUrl,
      sourceReferences: [{ ...reference, applyUrl: secondUrl }] });
    await store.syncVerificationSchedule('2026-08-30T00:01:00Z');
    const [replacement] = await store.leaseDueVerifications('2026-08-30T00:01:00Z');
    expect(replacement).toMatchObject({ candidateUrl: secondUrl,
      providerIdentity: { provider: 'greenhouse', tenant: 'acme', postingId: '8765432' } });
  });

  it('atomically rejects an admission write after its exact occurrence generation drifts', async () => {
    const { jobs, database } = subject();
    const current = job();
    const expectedReference = { sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: '7654321',
      document: '7654321', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1,
      company: 'Acme', title: current.title, location: current.location, season: current.season,
      applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/7654321', compensation: current.compensation, state: 'open' as const };
    const expected = { ...current, sourceReferences: [expectedReference] };
    await jobs.putInternship(expected);
    const changedReference = { ...expectedReference, title: 'Security Engineering Intern',
      applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/8765432' };
    await jobs.putInternship({ ...expected, title: changedReference.title, applyUrl: changedReference.applyUrl,
      normalizedUrl: changedReference.applyUrl, sourceReferences: [changedReference] });

    const proposedAdmission = admission(true);
    const persisted = await jobs.putAdmissionState({ ...expected, admission: proposedAdmission,
      sourceReferences: [{ ...expectedReference, admission: proposedAdmission }] }, expectedReference, undefined, undefined,
      newJobNotificationEvent(expectedReference.sourceId, expectedReference.externalId, expected, '2026-08-26T12:00:00Z'));
    expect(persisted).toBe(false);
    expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 0 });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ title: changedReference.title, applyUrl: changedReference.applyUrl,
      sourceReferences: [{ title: changedReference.title, applyUrl: changedReference.applyUrl }] });
  });

  it('commits a delayed notification with an exact admission write and deduplicates retries', async () => {
    const { jobs, database } = subject();
    const current = job();
    const reference = { sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: '7654321',
      document: '7654321', sourceUrl: current.applyUrl, row: 1, company: current.company,
      title: current.title, location: current.location, season: current.season,
      applyUrl: current.applyUrl, compensation: current.compensation, state: 'open' as const };
    const expected = { ...current, sourceReferences: [reference] };
    await jobs.putInternship(expected);
    const proposedAdmission = admission(true);
    const next = { ...expected, admission: proposedAdmission,
      sourceReferences: [{ ...reference, admission: proposedAdmission }] };
    const event = newJobNotificationEvent(reference.sourceId, reference.externalId, next, '2026-08-26T12:00:00Z');
    expect(await jobs.putAdmissionState(next, reference, undefined, undefined, event)).toBe(true);
    expect(await jobs.putAdmissionState(next, reference, undefined, undefined, event)).toBe(false);
    expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 1 });
  });

  it('resolves tenant-specific review rules ahead of host-wide rules', async () => {
    const { admission: store } = subject();
    await store.putReviewRule({ id: 'host', host: 'careers.acme.test', provider: 'greenhouse', decision: 'browser-required',
      reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer' });
    await store.putReviewRule({ id: 'tenant', host: 'careers.acme.test', provider: 'greenhouse', tenant: 'acme', decision: 'blocked-accepted',
      reviewedAt: '2026-08-27T00:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.resolveReviewRule({ provider: 'greenhouse', sourceId: 'greenhouse-acme', tenant: 'acme', postingId: 'role-1', sourceUrl: 'https://example.test' },
      'https://careers.acme.test/role-1')).resolves.toMatchObject({ id: 'tenant', decision: 'blocked-accepted' });
    await expect(store.resolveReviewRule({ provider: 'greenhouse', sourceId: 'greenhouse-other', tenant: 'other', postingId: 'role-1', sourceUrl: 'https://example.test' },
      'https://careers.acme.test/role-1')).resolves.toMatchObject({ id: 'host', decision: 'browser-required' });
    await store.putReviewRule({ id: 'host-replacement', host: 'careers.acme.test', provider: 'greenhouse', decision: 'aggregate-board',
      reviewedAt: '2026-08-28T00:00:00Z', reviewedBy: 'reviewer' });
    await expect(store.resolveReviewRule({ provider: 'greenhouse', sourceId: 'greenhouse-other', tenant: 'other', postingId: 'role-1', sourceUrl: 'https://example.test' },
      'https://careers.acme.test/role-1')).resolves.toMatchObject({ id: 'host-replacement', decision: 'aggregate-board' });
    expect((await store.listReviewRules()).filter((rule) => !rule.tenant)).toHaveLength(1);
  });

  it('resolves stale incidents while retaining the current reason', async () => {
    const { admission: store } = subject();
    const base = { jobId: 'job-1', sourceId: 'greenhouse-acme', host: 'careers.acme.test', state: 'open' as const,
      openedAt: '2026-08-26T00:00:00Z', updatedAt: '2026-08-26T00:00:00Z' };
    await store.upsertIncident({ ...base, id: 'old', reasonCode: 'destination-unresolved' });
    await store.upsertIncident({ ...base, id: 'current', reasonCode: 'destination-grace' });
    await store.upsertIncident({ ...base, id: 'quarantine', reasonCode: 'destination-gone', state: 'quarantined' });
    await store.resolveIncidents('job-1', 'greenhouse-acme', '2026-08-27T00:00:00Z', 'destination-grace');
    expect(await store.listActiveIncidents()).toMatchObject([{ id: 'current', reasonCode: 'destination-grace' }]);
    await store.resolveIncidents('job-1', 'greenhouse-acme', '2026-08-27T01:00:00Z');
    expect(await store.listActiveIncidents()).toEqual([]);
  });

  it('expires grace after a failed browser retry and clears the incident after recovery', async () => {
    const { admission: operations, jobs } = subject();
    const previous = admission(true);
    previous.destination = { ...previous.destination, classification: 'unresolved', finalUrl: 'https://careers.acme.test/role-1',
      lastKnownGoodAt: '2026-08-20T00:00:00Z' };
    previous.alertEligible = false;
    previous.reasonCodes = ['destination-grace'];
    previous.graceDeadline = '2026-08-27T00:00:00Z';
    const reference = {
      sourceId: 'structured-acme', provenance: 'official-structured' as const, externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://careers.acme.test/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'Remote', locations: ['Remote'], season: 'summer-2027', applyUrl: 'https://careers.acme.test/role-1',
      compensation: { raw: '' }, state: 'open' as const, admission: previous,
    };
    const current = { ...job(), sourceReferences: [reference], admission: previous };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot-1', changedAt: '2026-08-20T00:00:00Z',
      firstObservedAt: '2026-08-20T00:00:00Z', firstObservedAtPrecision: 'exact' });
    const message: DestinationVerificationMessage = { version: 1, jobId: current.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId, providerIdentity: { provider: 'structured', sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl, tenant: 'careers.acme.test', postingId: reference.externalId },
      candidateUrl: reference.applyUrl, reason: 'daily-retry', queuedAt: '2026-08-28T00:00:00Z' };

    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'unreachable', inspectedAt: '2026-08-28T00:00:00Z' });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ admission: { catalogEligible: false, alertEligible: false,
      reasonCodes: ['destination-unresolved'] } });
    expect(await operations.listActiveIncidents()).toMatchObject([{ reasonCode: 'destination-unresolved', state: 'open' }]);

    const expired = (await jobs.getJob(current.jobId))!;
    const expiredReference = expired.sourceReferences[0]!;
    await persistDestinationAdmission({ jobs, operations, message, job: expired, reference: expiredReference, reachability: 'live',
      inspectedAt: '2026-08-28T01:00:00Z', browserVisible: true,
      evidence: { url: reference.applyUrl, title: reference.title, postingIdPresent: true, jobPostingCount: 1,
        confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] } } });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ admission: { catalogEligible: true, alertEligible: true, reasonCodes: [] } });
    expect(await operations.listActiveIncidents()).toEqual([]);
  });

  it('turns authoritative destination closure into a reversible canonical close without closing the occurrence', async () => {
    const { admission: operations, jobs } = subject();
    const good = admission(true);
    const reference = { sourceId: 'structured-acme', provenance: 'official-structured' as const, externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://careers.acme.test/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote',
      season: 'summer-2027', applyUrl: 'https://careers.acme.test/role-1', compensation: { raw: '' }, state: 'open' as const, admission: good };
    const current = { ...job(), open: true, admission: good, applicationUrlValidatedAt: '2026-08-29T00:00:00Z',
      notification: { smsPending: true, digestPending: true }, sourceReferences: [reference] };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot', changedAt: '2026-08-29T00:00:00Z' });
    const message: DestinationVerificationMessage = { version: 1, jobId: current.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId, providerIdentity: { provider: 'structured', sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl, tenant: 'careers.acme.test', postingId: reference.externalId },
      candidateUrl: reference.applyUrl, reason: 'daily-retry', queuedAt: '2026-08-30T00:00:00Z' };
    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'gone',
      inspectedAt: '2026-08-30T00:00:00Z' });
    const closed = (await jobs.getJob(current.jobId))!;
    expect(closed).toMatchObject({ open: false, invalidApplicationUrl: reference.applyUrl,
      notification: { smsPending: false, digestPending: false }, admission: { reasonCodes: ['destination-gone'] },
      sourceReferences: [{ state: 'open' }] });
    expect(closed).not.toHaveProperty('applicationUrlValidatedAt');

    const alternateUrl = 'https://careers.acme.test/role-1-reopened';
    const alternateReference = { ...closed.sourceReferences[0]!, applyUrl: alternateUrl };
    const alternateJob = { ...closed, applyUrl: alternateUrl, normalizedUrl: alternateUrl,
      sourceReferences: [alternateReference] };
    await jobs.putInternship(alternateJob);
    const [alternateOccurrence] = await jobs.getSourceOccurrences(reference.sourceId);
    await jobs.putSourceOccurrence({ ...alternateOccurrence!, occurrence: {
      ...alternateOccurrence!.occurrence, applyUrl: alternateUrl, admission: alternateReference.admission,
    }, changedAt: '2026-08-30T00:30:00Z' });
    const alternateMessage = { ...message, candidateUrl: alternateUrl };
    await persistDestinationAdmission({ jobs, operations, message: alternateMessage, job: alternateJob, reference: alternateReference,
      reachability: 'live', inspectedAt: '2026-08-30T01:00:00Z', browserVisible: true,
      evidence: { url: alternateUrl, title: reference.title, postingIdPresent: true, jobPostingCount: 1,
        confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] } } });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ open: true, applyUrl: alternateUrl,
      applicationUrlValidatedAt: '2026-08-30T01:00:00Z',
      admission: { catalogEligible: true, alertEligible: true } });
    expect(await jobs.getJob(current.jobId)).not.toHaveProperty('invalidApplicationUrl');
  });

  it('maps browser response statuses before inspecting stale page content', () => {
    expect(reachabilityFromHttpStatus(404)).toBe('gone');
    expect(reachabilityFromHttpStatus(410)).toBe('gone');
    expect(reachabilityFromHttpStatus(403)).toBe('blocked');
    expect(reachabilityFromHttpStatus(503)).toBe('unreachable');
    expect(reachabilityFromHttpStatus(200)).toBe('live');
  });

  it('recognizes queued verification work already covered by browser evidence', () => {
    const current = job();
    const verified = admission(true);
    verified.destination = { ...verified.destination, browserVisible: true, provider: 'greenhouse', tenant: 'acme',
      expectedPostingId: 'role-1', inspectedAt: '2026-08-28T00:05:00Z' };
    current.sourceReferences = [{ sourceId: 'community-list', externalId: 'row-1', provenance: 'reviewed-community',
      document: 'README.md', sourceUrl: 'https://github.com/example/jobs', row: 1, company: current.company, title: current.title,
      location: current.location, season: current.season, applyUrl: current.applyUrl, compensation: current.compensation,
      state: 'open', admission: verified }];
    const request = { sourceId: 'community-list', externalId: 'row-1', candidateUrl: current.applyUrl,
      providerIdentity: { provider: 'greenhouse' as const, sourceId: 'community-list', sourceUrl: 'https://github.com/example/jobs',
        tenant: 'acme', postingId: 'role-1' } };
    expect(matchingBrowserDestination(current, request, '2026-08-28T00:00:00Z')).toEqual(verified.destination);
    expect(matchingBrowserDestination(current, request, '2026-08-28T00:10:00Z')).toBeUndefined();
    expect(matchingBrowserDestination(current, { ...request, candidateUrl: `${current.applyUrl}?changed=1` })).toBeUndefined();
  });

  it('lets rendered posting proof attribute a reviewed community occurrence', async () => {
    const { admission: operations, jobs } = subject();
    await operations.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-28T00:00:00Z',
      reviewedBy: 'reviewer' }, '2026-08-28T00:00:00Z');
    await operations.supersedeEmployerMapping({ id: 'community-acme', provider: 'greenhouse', scope: 'employer:acme',
      canonicalEmployerId: 'acme', reviewedAt: '2026-08-28T00:00:00Z', reviewedBy: 'reviewer' });
    const reference = {
      sourceId: 'community-list', provenance: 'reviewed-community' as const, externalId: 'row-1', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'Remote', locations: ['Remote'], season: 'summer-2027',
      applyUrl: 'https://careers.acme.test/openings?gh_jid=1234567', compensation: { raw: '' }, state: 'open' as const,
    };
    const current = { ...job(), sourceReferences: [reference] };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot',
      changedAt: '2026-08-28T00:00:00Z', firstObservedAt: '2026-08-28T00:00:00Z', firstObservedAtPrecision: 'exact' });
    const message: DestinationVerificationMessage = { version: 1, jobId: current.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId, providerIdentity: { provider: 'greenhouse', sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl, employerScope: 'employer:acme', postingId: '1234567' },
      candidateUrl: reference.applyUrl, reason: 'first-sight', queuedAt: '2026-08-28T00:00:00Z' };
    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'live',
      inspectedAt: '2026-08-28T00:01:00Z', browserVisible: true, evidence: {
        url: reference.applyUrl, title: reference.title, contentExcerpt: `${reference.title} ${'Role details. '.repeat(30)}`,
        postingIdPresent: true, applicationFormPresent: true,
        confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] },
      } });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ admission: { postingAttribution: 'attributed',
      catalogEligible: true, alertEligible: true }, sourceReferences: [{ admission: { postingAttribution: 'attributed' } }] });
    expect(await jobs.getJob(current.jobId)).toMatchObject({ catalogVisibleAt: current.catalogVisibleAt,
      notification: { smsPending: false, digestPending: false } });
  });

  it('re-asks an unread provider API instead of parking the role for a month', async () => {
    const { admission: operations, jobs, database } = subject();
    const workdayUrl = 'https://acme.wd1.myworkdayjobs.com/Acme_Careers/job/Remote/Software-Intern_R12345';
    const reference = {
      sourceId: 'workday-acme', provenance: 'official-ats' as const, externalId: 'R12345', document: 'R12345',
      sourceUrl: 'https://acme.wd1.myworkdayjobs.com/Acme_Careers', row: 1, company: 'Acme',
      title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
      applyUrl: workdayUrl, compensation: { raw: '' }, state: 'open' as const,
    };
    const current = { ...job(), sourceReferences: [reference] };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot',
      changedAt: '2026-08-28T00:00:00Z', firstObservedAt: '2026-08-28T00:00:00Z', firstObservedAtPrecision: 'exact' });
    const message: DestinationVerificationMessage = { version: 1, jobId: current.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId, providerIdentity: { provider: 'workday', sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl, tenant: 'acme', postingId: 'R12345' },
      candidateUrl: workdayUrl, reason: 'daily-retry', queuedAt: '2026-08-28T00:00:00Z' };
    const pageEvidence = {
      url: workdayUrl, title: reference.title, contentExcerpt: `${reference.title} ${'Role details. '.repeat(30)}`,
      postingIdPresent: true, applicationFormPresent: true,
      confidence: { score: 100, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: ['browser-visible evidence'] },
    };
    const retryAfterFor = () => (database.prepare('SELECT retry_after FROM role_metadata_acquisition WHERE job_id = ? AND source_id = ?')
      .get(current.jobId, reference.sourceId) as { retry_after: string }).retry_after;

    // The page carries no fields, so the employer's own API is still owed a read.
    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'live',
      inspectedAt: '2026-08-28T00:00:00Z', browserVisible: true, evidence: pageEvidence });
    expect(retryAfterFor()).toBe('2026-08-29T00:00:00.000Z');

    // A page that did answer settles the role for the full revalidation window.
    const answered = (await jobs.getJob(current.jobId))!;
    await persistDestinationAdmission({ jobs, operations, message: { ...message, queuedAt: '2026-08-29T00:00:00Z' },
      job: answered, reference: answered.sourceReferences[0]!, reachability: 'live',
      inspectedAt: '2026-08-29T00:00:00Z', browserVisible: true,
      evidence: { ...pageEvidence, contentExcerpt: `${reference.title}. The hourly rate is $40 - $50 per hour.` } });
    expect(retryAfterFor()).toBe('2026-09-28T00:00:00.000Z');
    expect(await jobs.getJob(current.jobId)).toMatchObject({ compensation: { raw: '$40–50/hour' } });
  });

  it('stages scheduled metadata collection so an unread provider API cannot be forgotten', async () => {
    const { db, jobs } = subject();
    const workdayUrl = 'https://acme.wd1.myworkdayjobs.com/Acme_Careers/job/Remote/Software-Intern_R12345';
    // `metadataCollectionTarget` reads the provider identity from the verified
    // destination, so an unresolved destination has no API route to collect.
    const verified = admission(true);
    verified.destination = { ...verified.destination, classification: 'posting-detail', provider: 'workday',
      tenant: 'acme', expectedPostingId: 'R12345', candidateUrl: workdayUrl };
    const reference = {
      sourceId: 'workday-acme', provenance: 'official-ats' as const, externalId: 'R12345', document: 'R12345',
      sourceUrl: 'https://acme.wd1.myworkdayjobs.com/Acme_Careers', row: 1, company: 'Acme',
      title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
      applyUrl: workdayUrl, compensation: { raw: '' }, state: 'open' as const, admission: verified,
    };
    await jobs.putInternship({ ...job(), sourceReferences: [reference] });
    const sent: Array<Record<string, unknown>> = [];
    const env = { DB: db, METADATA_SCHEDULED_COLLECTION_LIMIT: '5',
      DESTINATION_VERIFICATION_QUEUE: { async sendBatch(messages: Array<{ body: unknown }>) {
        for (const message of messages) sent.push(message.body as Record<string, unknown>);
      } } };

    await expect(collectRoleMetadataInBackground(env as never, new Date('2026-09-01T00:00:00Z'))).resolves.toEqual({ queued: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ reason: 'historical-backfill', jobId: 'job-1', sourceId: 'workday-acme',
      candidateUrl: workdayUrl, metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      providerIdentity: { provider: 'workday', tenant: 'acme', postingId: 'R12345' } });
    // The token is what keeps a scheduled pass staging-only.
    expect(String(sent[0]!.metadataBackfillToken)).toMatch(/^scheduled-/);

    // Reserving leases the candidate, so the next pass takes the next slice.
    const second = await collectRoleMetadataInBackground({ ...env, METADATA_SCHEDULED_COLLECTION_LIMIT: '5' } as never,
      new Date('2026-09-01T00:05:00Z'));
    expect(second).toEqual({ queued: 0 });

    const disabled = await collectRoleMetadataInBackground({ ...env, METADATA_SCHEDULED_COLLECTION_LIMIT: '0' } as never,
      new Date('2026-09-02T00:05:00Z'));
    expect(disabled).toEqual({ queued: 0 });
  });

  it('re-claims a role parked by a month-long deferral when its provider API was never read', async () => {
    const { database, db, jobs } = subject();
    const workdayUrl = 'https://acme.wd1.myworkdayjobs.com/Acme_Careers/job/Remote/Software-Intern_R12345';
    const verified = admission(true);
    verified.destination = { ...verified.destination, classification: 'posting-detail', provider: 'workday',
      tenant: 'acme', expectedPostingId: 'R12345', candidateUrl: workdayUrl };
    // A page that answered nothing, which is what every role in the unstated
    // cohort holds, plus the month-long deferral the old rule granted it.
    const pageEvidence = { schemaVersion: 1 as const, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, artifactHash: 'hash-1',
      sourceClass: 'official-page' as const, sourceId: 'workday-acme', sourceUrl: workdayUrl,
      observedAt: '2026-08-28T00:00:00Z', exactPosting: true as const };
    const reference = {
      sourceId: 'workday-acme', provenance: 'official-ats' as const, externalId: 'R12345', document: 'R12345',
      sourceUrl: 'https://acme.wd1.myworkdayjobs.com/Acme_Careers', row: 1, company: 'Acme',
      title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
      applyUrl: workdayUrl, compensation: { raw: '' }, state: 'open' as const, admission: verified,
      metadataEvidence: [pageEvidence],
    };
    await jobs.putInternship({ ...job(), sourceReferences: [reference] });
    database.prepare(`INSERT INTO role_metadata_evidence
      (job_id, source_class, source_id, source_url, artifact_hash, extraction_version, evidence, observed_at, is_current)
      VALUES ('job-1', 'official-page', 'workday-acme', ?, 'hash-1', ?, ?, '2026-08-28T00:00:00Z', 1)`)
      .run(workdayUrl, ROLE_METADATA_EXTRACTION_VERSION, JSON.stringify(pageEvidence));
    database.prepare(`INSERT INTO role_metadata_acquisition (job_id, source_id, lease_until, retry_after, observed_at, report)
      VALUES ('job-1', 'workday-acme', '', '2026-10-20T00:00:00Z', '2026-08-28T00:00:00Z', ?)`)
      .run(JSON.stringify({ extractionVersion: ROLE_METADATA_EXTRACTION_VERSION }));
    const sent: Array<Record<string, unknown>> = [];
    const env = { DB: db, METADATA_SCHEDULED_COLLECTION_LIMIT: '5',
      DESTINATION_VERIFICATION_QUEUE: { async sendBatch(messages: Array<{ body: unknown }>) {
        for (const message of messages) sent.push(message.body as Record<string, unknown>);
      } } };

    await expect(collectRoleMetadataInBackground(env as never, new Date('2026-09-01T00:00:00Z'))).resolves.toEqual({ queued: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ jobId: 'job-1', sourceId: 'workday-acme' });
    // Its lease now holds the next pass off rather than the stale deferral.
    await expect(collectRoleMetadataInBackground(env as never, new Date('2026-09-01T00:01:00Z'))).resolves.toEqual({ queued: 0 });
  });

  it('matches collection work sent for the destination the occurrence itself verified', () => {
    const canonical = 'https://acme.wd1.myworkdayjobs.com/Acme_Careers/job/Remote/Software-Intern_R12345';
    const redirect = 'https://acme.wd1.myworkdayjobs.com/en-US/Acme_Careers/job/Remote/Software-Intern_R12345';
    const verified = admission(true);
    verified.destination = { ...verified.destination, classification: 'posting-detail', provider: 'workday',
      tenant: 'acme', expectedPostingId: 'R12345', candidateUrl: redirect, finalUrl: redirect };
    const reference = {
      sourceId: 'workday-acme', provenance: 'official-ats' as const, externalId: 'R12345', document: 'R12345',
      sourceUrl: 'https://acme.wd1.myworkdayjobs.com/Acme_Careers', row: 1, company: 'Acme',
      title: 'Software Engineering Intern', location: 'Remote', seasons: undefined, season: 'summer-2027',
      applyUrl: canonical, compensation: { raw: '' }, state: 'open' as const, admission: verified,
    } as unknown as Parameters<typeof destinationVerificationMatchesReference>[0];
    const providerIdentity = { provider: 'workday' as const, sourceId: 'workday-acme',
      sourceUrl: 'https://acme.wd1.myworkdayjobs.com/Acme_Careers', tenant: 'acme', postingId: 'R12345' };

    // Collection targets the verified destination, which is the apply URL here
    // in everything but the locale segment its own admission recorded.
    expect(destinationVerificationMatchesReference(reference, { candidateUrl: redirect, providerIdentity })).toBe(true);
    expect(destinationVerificationMatchesReference(reference, { candidateUrl: canonical, providerIdentity })).toBe(true);
    // An unrelated URL, or one from another posting, still cannot mutate it.
    expect(destinationVerificationMatchesReference(reference, { candidateUrl: `${canonical}-other`, providerIdentity })).toBe(false);
    expect(destinationVerificationMatchesReference(reference, { candidateUrl: redirect, providerIdentity: { ...providerIdentity, postingId: 'R99999' } })).toBe(false);
  });

  it('retires JSON-LD metadata that disappears from a refreshed exact page', async () => {
    const { admission: operations, jobs, database } = subject();
    await operations.putCanonicalEmployer({ id: 'acme', displayName: 'Acme', reviewedAt: '2026-08-28T00:00:00Z',
      reviewedBy: 'reviewer' }, '2026-08-28T00:00:00Z');
    await operations.supersedeEmployerMapping({ id: 'community-acme', provider: 'greenhouse', scope: 'employer:acme',
      canonicalEmployerId: 'acme', reviewedAt: '2026-08-28T00:00:00Z', reviewedBy: 'reviewer' });
    const reference = {
      sourceId: 'community-list', provenance: 'reviewed-community' as const, externalId: 'row-1', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 1, company: 'Acme', title: 'Software Engineering Intern',
      location: 'Remote', locations: ['Remote'], season: 'summer-2027',
      applyUrl: 'https://careers.acme.test/openings?gh_jid=1234567', compensation: { raw: '' }, state: 'open' as const,
    };
    const current = { ...job(), sourceReferences: [reference] };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'snapshot',
      changedAt: '2026-08-28T00:00:00Z', firstObservedAt: '2026-08-28T00:00:00Z', firstObservedAtPrecision: 'exact' });
    const message: DestinationVerificationMessage = { version: 1, jobId: current.jobId, sourceId: reference.sourceId,
      externalId: reference.externalId, providerIdentity: { provider: 'greenhouse', sourceId: reference.sourceId,
        sourceUrl: reference.sourceUrl, employerScope: 'employer:acme', postingId: '1234567' },
      candidateUrl: reference.applyUrl, reason: 'first-sight', queuedAt: '2026-08-28T00:00:00Z', metadataExtractionVersion: 1 };
    const pageEvidence = {
      url: reference.applyUrl, title: reference.title, contentExcerpt: `${reference.title} ${'Role details. '.repeat(30)}`,
      postingIdPresent: true, applicationFormPresent: true,
      confidence: { score: 100, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: ['browser-visible evidence'] },
    };
    await persistDestinationAdmission({ jobs, operations, message, job: current, reference, reachability: 'live',
      inspectedAt: '2026-08-28T00:00:30Z', browserVisible: true, evidence: { ...pageEvidence,
        contentSource: 'json-ld', contentExcerpt: `${reference.title}. Salary is USD $99/hour.`,
        metadataArtifacts: [{ title: reference.title, identifier: '9999999', compensationText: 'USD $99/hour' }] } });
    expect((await jobs.getJob(current.jobId))?.compensation).toEqual({ raw: '' });
    expect(database.prepare('SELECT count(*) AS count FROM role_metadata_evidence WHERE evidence LIKE ?')
      .get('%compensationRanges%')).toEqual({ count: 0 });
    const beforeEnrichment = (await jobs.getJob(current.jobId))!;
    await persistDestinationAdmission({ jobs, operations, message, job: beforeEnrichment, reference: beforeEnrichment.sourceReferences[0]!, reachability: 'live',
      inspectedAt: '2026-08-28T00:01:00Z', browserVisible: true, evidence: { ...pageEvidence,
        metadataArtifacts: [{ title: reference.title, identifier: '1234567', compensationText: 'USD $40-$50/hour' }] } });
    const enriched = (await jobs.getJob(current.jobId))!;
    expect(enriched.compensation).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 50 });

    const enrichedReference = enriched.sourceReferences[0]!;
    await persistDestinationAdmission({ jobs, operations, message: { ...message, metadataBackfillToken: 'partial-collection' },
      job: enriched, reference: enrichedReference, reachability: 'live',
      inspectedAt: '2026-08-28T12:00:00Z', browserVisible: true,
      evidence: { ...pageEvidence, inspectionTruncated: true } });
    expect(database.prepare("SELECT count(*) AS count FROM role_metadata_evidence WHERE source_class = 'official-json-ld' AND is_current = 1").get())
      .toEqual({ count: 1 });
    expect((await operations.stageRoleMetadataRepair('2026-08-28T12:01:00Z')).expectedJobs).toBe(0);
    await persistDestinationAdmission({ jobs, operations, message: { ...message, metadataBackfillToken: 'collection-1' },
      job: enriched, reference: enrichedReference, reachability: 'live',
      inspectedAt: '2026-08-29T00:01:00Z', browserVisible: true, evidence: pageEvidence });

    expect((await jobs.getJob(current.jobId))?.compensation).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 50 });
    expect(database.prepare("SELECT count(*) AS count FROM role_metadata_evidence WHERE source_class = 'official-json-ld' AND is_current = 1").get())
      .toEqual({ count: 0 });
    const plan = await operations.stageRoleMetadataRepair('2026-08-29T00:02:00Z');
    expect(plan.expectedJobs).toBe(1);
    await operations.applyRoleMetadataRepair(plan.repairToken, plan.expectedJobs, plan.expectedOccurrences, '2026-08-29T00:03:00Z');
    const refreshed = (await jobs.getJob(current.jobId))!;
    expect(refreshed.compensation).toEqual({ raw: '' });
    expect(refreshed.sourceReferences[0]?.metadataEvidence?.some((item) => item.sourceClass === 'official-json-ld')).toBe(false);
    expect((await operations.roleMetadataAudit()).projectionOnlyOmissions).toEqual([]);
  });

  it('detects identical rendered artifacts observed for different posting IDs', async () => {
    const { admission: store } = subject();
    await store.recordVerificationAttempt({ id: 'attempt-1', jobId: 'job-1', sourceId: 'greenhouse-acme',
      candidateUrl: 'https://careers.acme.test/openings?gh_jid=1111111', state: 'succeeded',
      classification: 'unresolved', attemptedAt: '2026-08-28T00:00:00Z', completedAt: '2026-08-28T00:00:01Z' }, {
      hash: 'artifact-record-1', classification: 'unresolved', observedAt: '2026-08-28T00:00:01Z',
      value: { renderedEvidenceHash: 'same-shell', expectedPostingId: '1111111' },
    });
    await expect(store.hasRenderedEvidenceCollision('job-2', 'same-shell', '2222222')).resolves.toBe(true);
    await expect(store.hasRenderedEvidenceCollision('job-2', 'same-shell', '1111111')).resolves.toBe(false);
    await expect(store.hasRenderedEvidenceCollision('job-1', 'same-shell', '2222222')).resolves.toBe(false);
  });

  it('finds recent verification attempts only for the same job, source, and URL', async () => {
    const { admission: store } = subject();
    await store.recordVerificationAttempt({ id: 'attempt-1', jobId: 'job-1', sourceId: 'community-list',
      candidateUrl: 'https://careers.acme.test/role-1', state: 'failed', classification: 'unresolved',
      error: 'Navigation timeout', attemptedAt: '2026-08-28T00:00:00Z', completedAt: '2026-08-28T00:00:20Z' });
    await expect(store.hasVerificationAttemptSince('job-1', 'community-list', 'https://careers.acme.test/role-1',
      '2026-08-27T00:00:00Z')).resolves.toBe(true);
    await expect(store.hasVerificationAttemptSince('job-1', 'community-list', 'https://careers.acme.test/role-1',
      '2026-08-28T00:00:21Z')).resolves.toBe(false);
    await expect(store.hasVerificationAttemptSince('job-1', 'other-source', 'https://careers.acme.test/role-1',
      '2026-08-27T00:00:00Z')).resolves.toBe(false);
    await expect(store.hasVerificationAttemptSince('job-1', 'community-list', 'https://careers.acme.test/role-2',
      '2026-08-27T00:00:00Z')).resolves.toBe(false);
  });

  it('applies an exact staged repair silently and rolls back on a changed source row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T12:00:00Z'));
    const { database, admission: store, jobs } = subject();
    await jobs.putInternship(job());
    const preview = await store.stageRepair([{ jobId: 'job-1', admission: admission(true), company: 'Acme, Inc.' }], '2026-08-26T12:00:00Z');
    const before = await jobs.getJob('job-1');
    const result = await store.applyRepair(preview.repairToken, preview.changed, '2026-08-26T12:05:00Z');
    const after = await jobs.getJob('job-1');
    expect(result).toEqual({ changed: 1, occurrencesChanged: 0, projectionRefreshRequired: true, verificationMismatches: 0 });
    expect(after).toMatchObject({ jobId: before?.jobId, company: 'Acme, Inc.', firstSeenAt: before?.firstSeenAt,
      catalogVisibleAt: before?.catalogVisibleAt, notification: before?.notification, admission: { catalogEligible: true } });
    expect((await jobs.listOpen()).jobs).toHaveLength(1);
    expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 0 });

    const stale = await store.stageRepair([{ jobId: 'job-1', admission: admission(false) }], '2026-08-26T13:00:00Z');
    await jobs.putInternship({ ...after!, title: 'Source changed this row' });
    await expect(store.applyRepair(stale.repairToken, stale.changed, '2026-08-26T13:05:00Z')).rejects.toThrow();
    expect((await jobs.getJob('job-1'))?.title).toBe('Source changed this row');
    expect((await jobs.getJob('job-1'))?.admission?.catalogEligible).toBe(true);
  });

  it('repairs occurrence admission and metadata without changing linked durable state', async () => {
    const { database, admission: store, jobs } = subject();
    const reference = {
      sourceId: 'greenhouse-acme', provenance: 'official-ats' as const, externalId: 'role-1', document: 'role-1',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme',
      title: 'Software Intern…', location: 'Westerville, OH, Unite...', locations: ['Westerville, OH, Unite...'],
      season: 'summer-2027', applyUrl: 'https://careers.acme.test/role-1', compensation: { raw: '' },
      state: 'open' as const, admission: admission(false),
    };
    const current = { ...job(), sourceReferences: [reference] };
    await jobs.putInternship(current);
    await jobs.putSourceOccurrence({ sourceId: reference.sourceId, externalId: reference.externalId, jobId: current.jobId,
      occurrence: reference, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'original-snapshot',
      changedAt: '2026-08-20T00:00:00Z', firstObservedAt: '2026-08-01T00:00:00Z', firstObservedAtPrecision: 'exact' });
    database.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('POSTING_ALIAS#greenhouse:acme:role-1', 'CLAIM', 'posting-alias', ?)")
      .run(JSON.stringify({ alias: 'greenhouse:acme:role-1', canonicalJobId: current.jobId }));
    database.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('TOMBSTONE#user-1', 'ROLE#job-1', 'notification-tombstone', ?)")
      .run(JSON.stringify({ jobId: current.jobId, deletedAt: '2026-08-21T00:00:00Z' }));
    database.prepare("INSERT INTO user_items (user_id, item_key, kind, value) VALUES ('user-1', 'APPLICATION#job-1', 'application', ?)")
      .run(JSON.stringify({ jobId: current.jobId, status: 'applied' }));
    database.prepare("INSERT INTO user_items (user_id, item_key, kind, value) VALUES ('user-1', 'RECEIPT#one', 'receipt', ?)")
      .run(JSON.stringify({ jobId: current.jobId, updatedAt: '2026-08-22T00:00:00Z' }));
    const durableBefore = database.prepare("SELECT pk, sk, kind, value FROM catalog_items WHERE kind IN ('posting-alias','notification-tombstone') ORDER BY pk").all();
    const usersBefore = database.prepare('SELECT user_id, item_key, kind, value FROM user_items ORDER BY item_key').all();
    const repairedReference = { ...reference, title: 'Software Engineering Intern', location: 'Westerville, OH, United States',
      locations: ['Westerville, OH, United States'], admission: admission(true) };
    const preview = await store.stageRepair([{ jobId: current.jobId, admission: admission(true),
      title: repairedReference.title, location: repairedReference.location, locations: repairedReference.locations,
      sourceReferences: [repairedReference] }], '2026-08-28T00:00:00Z');
    expect(preview).toMatchObject({ changed: 1, candidates: ['job-1'], occurrencesChanged: 1,
      occurrenceCandidates: ['greenhouse-acme:role-1'] });
    await store.applyRepair(preview.repairToken, preview.changed, '2026-08-28T00:05:00Z', preview.occurrencesChanged);
    expect(await jobs.getJob(current.jobId)).toMatchObject({ jobId: current.jobId, title: repairedReference.title,
      location: repairedReference.location, admission: { catalogEligible: true },
      sourceReferences: [{ title: repairedReference.title, admission: { catalogEligible: true } }],
      notification: current.notification });
    expect(await jobs.getSourceOccurrences(reference.sourceId)).toMatchObject([{ jobId: current.jobId,
      firstObservedAt: '2026-08-01T00:00:00Z', changedSnapshotHash: 'original-snapshot',
      occurrence: { title: repairedReference.title, admission: { catalogEligible: true } } }]);
    expect(database.prepare("SELECT pk, sk, kind, value FROM catalog_items WHERE kind IN ('posting-alias','notification-tombstone') ORDER BY pk").all())
      .toEqual(durableBefore);
    expect(database.prepare('SELECT user_id, item_key, kind, value FROM user_items ORDER BY item_key').all()).toEqual(usersBefore);
    expect(database.prepare("SELECT count(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 0 });
  });
});
