import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1InternshipStore } from '../cloudflare/d1-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { buildPostingIdentity } from '../src/identity/posting.js';
import { runBoundedPostingIdentityRepair } from '../src/posting-identity-bounded-repair.js';
import { postingIdentityRepairQueryCount, runPostingIdentityRepair } from '../src/posting-identity-repair.js';
import type { Internship, ProviderPostingEvidence, SourceOccurrence } from '../src/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;
type QueryMetrics = { statements: number; calls: number; maxBoundParameters: number; maxBatchStatements: number; inBatch: boolean };
function sqliteD1(database: DatabaseSync, metrics?: QueryMetrics): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query); const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) {
        if (metrics) metrics.maxBoundParameters = Math.max(metrics.maxBoundParameters, next.length);
        return prepared(query, next);
      },
      async first<T>() {
        if (metrics && !metrics.inBatch) { metrics.statements += 1; metrics.calls += 1; }
        return (statement.get(...bound) as T | undefined) ?? null;
      },
      async all<T>() {
        if (metrics && !metrics.inBatch) { metrics.statements += 1; metrics.calls += 1; }
        return { results: statement.all(...bound) as T[] };
      },
      async run() {
        if (metrics && !metrics.inBatch) { metrics.statements += 1; metrics.calls += 1; }
        return { meta: { changes: Number(statement.run(...bound).changes) } };
      },
    };
  };
  return {
    prepare(query) { return prepared(query); },
    async batch(statements) {
      if (metrics) {
        metrics.statements += statements.length; metrics.calls += 1; metrics.inBatch = true;
        metrics.maxBatchStatements = Math.max(metrics.maxBatchStatements, statements.length);
      }
      database.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
      finally { if (metrics) metrics.inBatch = false; }
    },
  };
}

function database() {
  const value = new DatabaseSync(':memory:');
  for (const name of ['0001_initial.sql', '0002_cost_guards.sql', '0003_billing_shutdown.sql', '0004_auth_rate_limits.sql', '0005_auth_consent.sql', '0006_employer_channel.sql', '0007_catalog_admission.sql', '0013_posting_presentation_reviews.sql']) {
    value.exec(readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8'));
  }
  return value;
}

function occurrence(sourceId: string, externalId: string, applyUrl: string, providerEvidence?: ProviderPostingEvidence): SourceOccurrence {
  return {
    sourceId, externalId, document: externalId, sourceUrl: 'https://example.test/source', row: 1,
    company: 'Historical Employer', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl, compensation: { raw: '' }, state: 'open', ...(providerEvidence ? { providerEvidence } : {}),
  };
}

function job(jobId: string, applyUrl: string, firstSeenAt: string, sourceReferences: SourceOccurrence[], extra: Record<string, unknown> = {}): Internship {
  return {
    jobId, company: 'Historical Employer', title: 'Software Engineering Intern', location: 'New York', season: 'summer-2027',
    applyUrl, normalizedUrl: applyUrl, fingerprint: 'same-soft-fingerprint', compensation: { raw: '' }, sourceReferences,
    open: true, technical: true, firstSeenAt, catalogVisibleAt: firstSeenAt, lastSeenAt: '2026-08-02T00:00:00.000Z',
    notification: { smsPending: false, digestPending: false }, ...extra,
  };
}

const plusId = 'b4f750e7-0148-41f0-b2b1-ff054450a320';
const plusEvidence: ProviderPostingEvidence = {
  provider: 'lever', tenant: 'plus-2', postingId: plusId, sourceId: 'lever-plusai',
  urls: [`https://jobs.lever.co/plus-2/${plusId}`, `https://jobs.lever.co/plus-2/${plusId}/apply`],
};

async function historicalDatabase(options: { presentationAgrees?: boolean; authoritativePresentation?: boolean } = {}) {
  const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
  await store.putCheckpoint({ sourceId: 'lever-plusai', successfulFetches: 10, activeExternalIds: [plusId] });
  await store.putCheckpoint({ sourceId: 'greenhouse-drweng', successfulFetches: 10, activeExternalIds: ['3413670'] });
  await store.putCheckpoint({ sourceId: 'greenhouse-spacex', successfulFetches: 10, activeExternalIds: ['900001', '900002'] });

  const plusOld = job('plus-old', `https://jobs.lever.co/plus-2/${plusId}`, '2026-07-28T03:12:13.556Z', [
    occurrence('community-list', 'community-plus', `https://jobs.lever.co/plus-2/${plusId}?utm_source=simplify`),
  ], { notification: { smsPending: false, digestPending: false, smsSentAt: '2026-07-28T03:13:00.000Z', digestedAt: '2026-07-28T12:00:00.000Z' } });
  const plusDuplicate = job('plus-duplicate', options.presentationAgrees
    ? `https://jobs.lever.co/plus-2/${plusId}`
    : `https://jobs.lever.co/plus-2/${plusId}/apply`, '2026-08-01T13:44:06.281Z', [
    { ...occurrence('lever-plusai', plusId, `https://jobs.lever.co/plus-2/${plusId}/apply`, plusEvidence),
      ...(options.authoritativePresentation ? { provenance: 'official-ats' as const } : {}) },
  ], { notification: { smsPending: true, digestPending: true } });
  const drwEvidence: ProviderPostingEvidence = { provider: 'greenhouse', tenant: 'drweng', postingId: '3413670', sourceId: 'greenhouse-drweng', urls: ['https://job-boards.greenhouse.io/drweng/jobs/3413670'] };
  const drwOld = job('drw-old', 'https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670', '2026-07-20T00:00:00.000Z', [
    occurrence('community-list', 'drw-community', 'https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670?ref=feed'),
  ]);
  const drwDuplicate = job('drw-duplicate', options.presentationAgrees
    ? 'https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670'
    : 'https://job-boards.greenhouse.io/drweng/jobs/3413670', '2026-07-21T00:00:00.000Z', [
    { ...occurrence('greenhouse-drweng', '3413670', 'https://job-boards.greenhouse.io/drweng/jobs/3413670', drwEvidence),
      ...(options.authoritativePresentation ? { provenance: 'official-ats' as const } : {}) },
  ]);
  // Same internal ID is deliberately not identity: these represent the SpaceX/Roblox failure mode.
  const spacexA = job('spacex-a', 'https://job-boards.greenhouse.io/spacex/jobs/900001', '2026-08-03T00:00:00.000Z', [
    occurrence('greenhouse-spacex', '900001', 'https://job-boards.greenhouse.io/spacex/jobs/900001'),
  ], { internalJobId: 'shared-internal-id' });
  const spacexB = job('spacex-b', 'https://job-boards.greenhouse.io/spacex/jobs/900002', '2026-08-03T00:00:00.000Z', [
    occurrence('greenhouse-spacex', '900002', 'https://job-boards.greenhouse.io/spacex/jobs/900002'),
  ], { internalJobId: 'shared-internal-id' });
  const regularA = job('regular-a', 'https://careers.example.test/jobs/backend', '2026-08-04T00:00:00.000Z', [occurrence('community-list', 'regular-a', 'https://careers.example.test/jobs/backend')]);
  const regularB = job('regular-b', 'https://careers.example.test/jobs/frontend', '2026-08-04T00:00:00.000Z', [occurrence('community-list', 'regular-b', 'https://careers.example.test/jobs/frontend')]);
  for (const value of [plusOld, plusDuplicate, drwOld, drwDuplicate, spacexA, spacexB, regularA, regularB]) await store.putInternship(value);
  await store.claimPostingIdentity(buildPostingIdentity({ applicationUrl: `https://jobs.lever.co/plus-2/${plusId}/apply` }), 'plus-duplicate');
  // Historical occurrence rows predate providerEvidence. The repair must infer
  // and merge it into the canonical job during the same pass that remaps this
  // row, even when its occurrence key replaces a richer in-record reference.
  await store.putSourceOccurrence({
    sourceId: 'lever-plusai', externalId: plusId, jobId: 'plus-duplicate',
    occurrence: occurrence('lever-plusai', plusId, `https://jobs.lever.co/plus-2/${plusId}/apply`),
    present: true, consecutiveOmissions: 0, changedSnapshotHash: 'a', changedAt: '2026-08-01T13:44:06.281Z',
  });

  const insertUser = sqlite.prepare('INSERT INTO user_items (user_id, item_key, kind, value) VALUES (?, ?, ?, ?)');
  insertUser.run('user-1', 'APPLICATION#saved', 'application', JSON.stringify({ applicationId: 'saved', jobId: 'plus-old', status: 'saved', queuedAt: '2026-08-01T00:00:00Z', notes: 'latest note', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z' }));
  insertUser.run('user-1', 'APPLICATION#interview', 'application', JSON.stringify({ applicationId: 'interview', jobId: 'plus-duplicate', status: 'interview', appliedAt: '2026-08-02T12:00:00Z', detection: { source: 'gmail', detectedAt: '2026-08-02T12:00:00Z' }, applyMode: 'official-form', notes: 'interview note', createdAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z' }));
  insertUser.run('user-1', 'APPLICATION_SESSION#session', 'application-session', JSON.stringify({ sessionId: 'session', userId: 'user-1', applicationId: 'saved', jobId: 'plus-old', status: 'created', version: 1, fields: [], fieldPlanDigest: 'x', runnerLifecycle: 'not-started', expiresAt: '2026-09-01T00:00:00Z', metadataExpiresAt: '2026-09-01T00:00:00Z', eventIds: [], createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }));
  insertUser.run('user-1', 'RECEIPT#old-a#token', 'receipt', JSON.stringify({ userId: 'user-1', jobId: 'plus-old', token: 'token', status: 'error', deliveryState: 'definitive-failure', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' }));
  insertUser.run('user-1', 'RECEIPT#old-b#token', 'receipt', JSON.stringify({ userId: 'user-1', jobId: 'plus-duplicate', token: 'token', status: 'ok', deliveryState: 'delivered', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z' }));
  insertUser.run('user-1', 'RELEASE#release', 'catalog-release', JSON.stringify({ releaseId: 'release', userId: 'user-1', jobIds: ['plus-old', 'plus-duplicate', 'regular-a'], newJobIds: ['plus-duplicate'], createdAt: '2026-08-02T00:00:00Z' }));
  sqlite.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('OUTBOX#existing', 'EVENT', 'notification-event', ?)").run(JSON.stringify({
    eventId: 'existing', jobId: 'drw-duplicate', kind: 'new-job', createdAt: '2026-08-02T00:00:00.000Z',
  }));
  sqlite.prepare("INSERT INTO employer_organizations (id, name, domain, state, created_at, updated_at) VALUES ('org', 'Org', 'org.test', 'active', '2026-01-01', '2026-01-01')").run();
  sqlite.prepare("INSERT INTO employer_field_proposals (id, organization_id, job_id, field, proposed_value, evidence_at, state, created_by, created_at) VALUES ('proposal', 'org', 'plus-duplicate', 'title', 'Title', '2026-01-01', 'pending-review', 'reviewer', '2026-01-01')").run();
  return { sqlite, db, store };
}

describe('D1 posting identity repair', () => {
  it('repairs duplicate durable source occurrences caused by document row movement', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const url = 'https://acme.wd1.myworkdayjobs.com/External/job/Remote/Software-Intern_REQ-1';
    const original = {
      ...occurrence('community-list', 'stable-role', url), document: 'README.md', row: 10,
      firstAttachedAt: '2026-08-01T00:00:00.000Z', firstAttachedAtPrecision: 'exact' as const,
    };
    const moved = {
      ...original, row: 18, firstAttachedAt: '2026-08-20T00:00:00.000Z', firstAttachedAtPrecision: 'unknown' as const,
    };
    await store.putInternship(job('row-moved', url, '2026-08-01T00:00:00.000Z', [original, moved]));
    await store.putSourceOccurrence({
      sourceId: moved.sourceId, externalId: moved.externalId!, jobId: 'row-moved', occurrence: moved,
      present: true, consecutiveOmissions: 0, changedSnapshotHash: 'moved', changedAt: '2026-08-20T00:00:00.000Z',
      firstObservedAt: '2026-08-01T00:00:00.000Z', firstObservedAtPrecision: 'exact',
    });

    const dry = await runPostingIdentityRepair(db, { scope: 'occurrences' });
    expect(dry).toMatchObject({ gate: { passed: false, duplicateOccurrenceReferences: 1 } });
    await runPostingIdentityRepair(db, {
      apply: true, scope: 'occurrences', repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges, expectedDuplicateJobs: dry.duplicateJobs,
    });

    expect(await store.getJob('row-moved')).toMatchObject({
      sourceReferences: [{
        sourceId: 'community-list', externalId: 'stable-role', document: 'README.md', row: 18,
        firstAttachedAt: '2026-08-01T00:00:00.000Z', firstAttachedAtPrecision: 'exact',
      }],
    });
    expect(await runPostingIdentityRepair(db, { scope: 'occurrences' })).toMatchObject({
      expectedChanges: 0, gate: { duplicateOccurrenceReferences: 0 },
    });
    sqlite.close();
  });

  it('uses a unique active reviewed checkpoint to scope legacy Greenhouse embed tokens', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const postingId = '8732364002';
    const officialUrl = `https://databricks.com/company/careers/open-positions/job?gh_jid=${postingId}`;
    const embedUrl = `https://boards.greenhouse.io/embed/job_app?token=${postingId}&utm_source=Simplify`;
    const evidence: ProviderPostingEvidence = {
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks', urls: [officialUrl],
    };
    await store.putCheckpoint({ sourceId: 'greenhouse-databricks', successfulFetches: 10, activeExternalIds: [postingId] });
    await store.putInternship(job('community-databricks', embedUrl, '2026-08-01T00:00:00.000Z', [
      { ...occurrence('community-list', 'community-databricks', embedUrl), company: 'Databricks', title: 'Software Engineering Intern' },
    ], { company: 'Databricks', title: 'Software Engineering Intern' }));
    await store.putInternship(job('official-databricks', officialUrl, '2026-08-02T00:00:00.000Z', [
      { ...occurrence('greenhouse-databricks', postingId, officialUrl, evidence), company: 'Databricks', title: 'Software Engineering Intern', provenance: 'official-ats' },
    ], { company: 'Databricks', title: 'Software Engineering Intern' }));

    const dry = await runPostingIdentityRepair(db, { scope: 'identity' });
    expect(dry).toMatchObject({
      duplicateGroups: 1, duplicateJobs: 1, eligibleDuplicateGroups: 1,
      unresolvedDuplicateGroups: 0, conflicts: [], presentationDisagreements: [],
    });
    expect(dry.samples).toEqual([expect.objectContaining({
      canonicalJobId: 'community-databricks', duplicateJobIds: ['official-databricks'],
      providerIdentity: `greenhouse:databricks:${postingId}`,
    })]);
    sqlite.close();
  });

  it('does not scope a Greenhouse embed token shared by multiple reviewed checkpoints', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const postingId = '8732364002';
    const officialUrl = `https://databricks.com/company/careers/open-positions/job?gh_jid=${postingId}`;
    const embedUrl = `https://boards.greenhouse.io/embed/job_app?token=${postingId}`;
    const evidence: ProviderPostingEvidence = {
      provider: 'greenhouse', tenant: 'databricks', postingId, sourceId: 'greenhouse-databricks', urls: [officialUrl],
    };
    await store.putCheckpoint({ sourceId: 'greenhouse-databricks', successfulFetches: 10, activeExternalIds: [postingId] });
    await store.putCheckpoint({ sourceId: 'greenhouse-figma', successfulFetches: 10, activeExternalIds: [postingId] });
    await store.putInternship(job('community-databricks', embedUrl, '2026-08-01T00:00:00.000Z', [
      occurrence('community-list', 'community-databricks', embedUrl),
    ]));
    await store.putInternship(job('official-databricks', officialUrl, '2026-08-02T00:00:00.000Z', [
      { ...occurrence('greenhouse-databricks', postingId, officialUrl, evidence), provenance: 'official-ats' },
    ]));

    expect(await runPostingIdentityRepair(db, { scope: 'identity' })).toMatchObject({
      duplicateGroups: 0, duplicateJobs: 0, conflicts: [],
    });
    sqlite.close();
  });

  it('merges SmartRecruiters presentation variants through the scoped provider identity', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const bareUrl = 'https://jobs.smartrecruiters.com/Acme/744000139649345';
    const sluggedUrl = `${bareUrl}-software-engineer-intern`;
    await store.putInternship(job('smartrecruiters-old', bareUrl, '2026-08-01T00:00:00.000Z', [
      occurrence('community-list', 'smartrecruiters-old', bareUrl),
    ]));
    await store.putInternship(job('smartrecruiters-new', sluggedUrl, '2026-08-02T00:00:00.000Z', [
      occurrence('community-list', 'smartrecruiters-new', sluggedUrl),
    ]));

    const dry = await runPostingIdentityRepair(db, { scope: 'identity' });
    expect(dry).toMatchObject({
      duplicateGroups: 1, duplicateJobs: 1, eligibleDuplicateGroups: 1,
      unresolvedDuplicateGroups: 0, conflicts: [], presentationDisagreements: [],
    });
    expect(dry.samples).toEqual([expect.objectContaining({
      canonicalJobId: 'smartrecruiters-old', duplicateJobIds: ['smartrecruiters-new'],
      providerIdentity: 'smartrecruiters:acme:744000139649345',
    })]);

    const applied = await runPostingIdentityRepair(db, {
      apply: true, scope: 'identity', repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges, expectedDuplicateJobs: dry.duplicateJobs,
    });
    expect(applied).toMatchObject({ duplicateJobs: 1 });
    expect(await store.getJob('smartrecruiters-old')).toMatchObject({
      jobId: 'smartrecruiters-old',
      postingIdentity: {
        provider: 'smartrecruiters', tenant: 'acme', providerPostingId: '744000139649345',
      },
      sourceReferences: expect.arrayContaining([
        expect.objectContaining({ externalId: 'smartrecruiters-old' }),
        expect.objectContaining({ externalId: 'smartrecruiters-new' }),
      ]),
    });
    expect(await store.getJob('smartrecruiters-new')).toMatchObject({ jobId: 'smartrecruiters-old' });
    expect(await runPostingIdentityRepair(db, { scope: 'identity' })).toMatchObject({
      expectedChanges: 0, duplicateGroups: 0, duplicateJobs: 0, conflicts: [],
    });
    sqlite.close();
  });

  it('confirms real expanded-family roles while keeping malformed roles unconfirmed', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const cases = [
      ['eu-greenhouse', 'https://job-boards.eu.greenhouse.io/imc/jobs/4667854101', 'https://job-boards.eu.greenhouse.io/imc/jobs/software-engineer'],
      ['smartrecruiters', 'https://jobs.smartrecruiters.com/ALTEN/744000142128541-ingenieur-developpeur-frontend-h-f-', 'https://jobs.smartrecruiters.com/ALTEN/software-engineer-intern'],
      ['successfactors', 'https://career4.successfactors.com/careers?career_ns=job_listing&company=colgate&career_job_req_id=169295', 'https://career4.successfactors.com/careers?career_ns=job_listing&career_job_req_id=169295'],
      ['workable', 'https://apply.workable.com/activate-interactive-pte-ltd/j/1AD6CF565A/', 'https://apply.workable.com/activate-interactive-pte-ltd/'],
      ['workable-apply', 'https://apply.workable.com/connectprep/j/D1C67258C0/apply', 'https://apply.workable.com/connectprep/j/software-engineer/apply'],
      ['microsoft', 'https://apply.careers.microsoft.com/careers/job/1970393556862170', 'https://apply.careers.microsoft.com/careers/job/software-engineer'],
      ['rippling', 'https://ats.rippling.com/4ag/jobs/71d97d10-87f2-4f53-88b7-97f27f392d24', 'https://ats.rippling.com/4ag/jobs/--------'],
      ['rippling-locale', 'https://ats.rippling.com/en-GB/greengas/jobs/b2938290-cc66-4f54-9888-bbe286c1d9b6', 'https://ats.rippling.com/en-GB/greengas/jobs/software-engineer'],
      ['eightfold', 'https://bostonscientific.eightfold.ai/careers/job/563602813483103', 'https://bostonscientific.eightfold.ai/careers'],
      ['paylocity', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4341435', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/software-engineer'],
      ['jobvite', 'https://jobs.jobvite.com/aarete/job/oBXLAfwD', 'https://jobs.jobvite.com/aarete/job/'],
      ['amazon', 'https://amazon.jobs/en/jobs/10394156/2026-fall-applied-science-internship', 'https://amazon.jobs/en/jobs/10394156software-engineer'],
      ['amazon-apply', 'https://www.amazon.jobs/jobs/10418355/apply', 'https://www.amazon.jobs/jobs/10418355software-engineer/apply'],
      ['google', 'https://www.google.com/about/careers/applications/jobs/results/100028133205254854', 'https://www.google.com/about/careers/applications/jobs/results/software-engineer'],
      ['custom-icims', 'https://careers.amd.com/jobs/90743?icims=1', 'https://careers.amd.com/jobs/software-engineer'],
      ['custom-successfactors', 'https://jobs.l3harris.com/job/Bristol/Software-Engineering-Intern-PA-19007/1428452600/?ats=successfactors', 'https://jobs.l3harris.com/job/Bristol/software-engineer'],
      ['myworkdaysite', 'https://wd1.myworkdaysite.com/recruiting/imeg/Imeg_Careers/job/Chicago-IL/Electrical-Engineering-Intern_R-16476', 'https://wd1.myworkdaysite.com/Imeg_Careers/openings/Electrical-Engineering-Intern_R-16476'],
      ['taleo', 'https://textron.taleo.net/careersection/textron/jobdetail.ftl?job=342550', 'https://textron.taleo.net/careersection/textron/moresearch.ftl?job=342550'],
      ['united', 'https://careers.united.com/us/en/job/WHQ00026618', 'https://careers.united.com/us/en/search-results?job=WHQ00026618'],
      ['sig', 'https://careers.sig.com/intern-co-op-technology/jobs/10837', 'https://careers.sig.com/intern-co-op-technology/jobs/software-engineer'],
      ['intuit', 'https://jobs.intuit.com/job/mountain-view/software-engineer-intern/27595/100620927536', 'https://jobs.intuit.com/job/mountain-view/software-engineer-intern/27595'],
      ['eu-lever', 'https://jobs.eu.lever.co/quantinuum/46b3f32c-a2ad-4d4d-bff6-b1bbebf3e382/apply', 'https://jobs.eu.lever.co/quantinuum/software-engineer/apply'],
      ['apple', 'https://jobs.apple.com/en-us/details/200664323/software-phd-internships', 'https://jobs.apple.com/en-us/details/software-intern'],
      ['bamboohr', 'https://lunaroutpost.bamboohr.com/careers/390/', 'https://lunaroutpost.bamboohr.com/careers/'],
      ['adp', 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=2cc1abe5-fdf4-41ed-b82d-9b34c651ef79&jobId=574462', 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?jobId=574462'],
      ['avature', 'https://pomerleau.avature.net/en_US/Jobs/JobDetail/3476', 'https://pomerleau.avature.net/en_US/Jobs/JobDetail/software-engineer'],
      ['employer-route', 'https://career.mlp.com/careers/job/755957778821', 'https://career.mlp.com/careers/search?job=755957778821'],
      ['pinpoint', 'https://impulsespace.pinpointhq.com/en/postings/2b03cd5d-4a58-48a0-81f4-ea8c8c7bcd2a', 'https://impulsespace.pinpointhq.com/en/postings/software-engineer'],
      ['applytojob', 'https://neboagency.applytojob.com/apply/AFMqe9Jb7b/Web-Development-Intern', 'https://neboagency.applytojob.com/apply/'],
    ] as const;
    for (const [family, goodUrl, badUrl] of cases) {
      await store.putInternship(job(`${family}-good`, goodUrl, '2026-09-18T00:00:00.000Z', [
        occurrence('community-list', `${family}-good`, goodUrl),
      ]));
      await store.putInternship(job(`${family}-bad`, badUrl, '2026-09-18T00:00:00.000Z', [
        occurrence('community-list', `${family}-bad`, badUrl),
      ]));
    }

    const dry = await runPostingIdentityRepair(db, { scope: 'identity' });
    expect(dry).toMatchObject({ duplicateGroups: 0, duplicateJobs: 0, conflicts: [] });
    await runPostingIdentityRepair(db, {
      apply: true, scope: 'identity', repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges, expectedDuplicateJobs: dry.duplicateJobs,
    });
    const occurrenceDry = await runPostingIdentityRepair(db, { scope: 'occurrences' });
    expect(occurrenceDry.conflicts).toEqual([]);
    await runPostingIdentityRepair(db, {
      apply: true, scope: 'occurrences', repairToken: occurrenceDry.repairToken,
      expectedChanges: occurrenceDry.expectedChanges, expectedDuplicateJobs: occurrenceDry.duplicateJobs,
    });

    for (const [family] of cases) {
      expect(await store.getJob(`${family}-good`)).toMatchObject({
        postingIdentityStatus: 'confirmed',
        sourceReferences: [expect.objectContaining({
          postingIdentityDecision: expect.objectContaining({ status: 'confirmed', evidenceKind: 'immutable-provider-id' }),
        })],
      });
      expect(await store.getJob(`${family}-bad`)).toMatchObject({
        postingIdentityStatus: 'unconfirmed',
        sourceReferences: [expect.objectContaining({
          postingIdentityDecision: expect.objectContaining({ status: 'unconfirmed' }),
        })],
      });
    }
    expect(await runPostingIdentityRepair(db)).toMatchObject({ expectedChanges: 0, conflicts: [] });
    sqlite.close();
  });

  it('finds historical provider duplicates while keeping bad duplicate signals and regular postings separate', async () => {
    const { db } = await historicalDatabase();
    const first = await runPostingIdentityRepair(db); const second = await runPostingIdentityRepair(db);
    expect(first.repairToken).toBe(second.repairToken);
    expect(first).toMatchObject({
      duplicateGroups: 2,
      duplicateJobs: 2,
      eligibleDuplicateGroups: 2,
      unresolvedDuplicateGroups: 0,
      conflicts: [],
      outboxRows: 1,
      // Merging a duplicate now carries its user rows onto the canonical job,
      // which is the point of the merge: a student who saved the duplicate keeps
      // their application.
      applicationMerges: 1,
      proposalRemaps: 1,
    });
    // A destination-URL difference no longer blocks a merge: the canonical
    // member's URL wins and the admission is re-derived from the merged
    // references (owner decision, 2026-09-17).
    expect(first.presentationDisagreements).toEqual([]);
    expect(first.samples).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonicalJobId: 'plus-old', duplicateJobIds: ['plus-duplicate'] }),
      expect.objectContaining({ canonicalJobId: 'drw-old', duplicateJobIds: ['drw-duplicate'] }),
    ]));
    await expect(runPostingIdentityRepair(db, { scope: 'occurrences' })).resolves.toMatchObject({
      scope: 'occurrences',
      conflicts: [expect.stringContaining('identity scope')],
    });
  });

  it('builds and applies the exact identity repair in bounded provider-group batches', async () => {
    const { sqlite, db, store } = await historicalDatabase();
    const singlePass = await runPostingIdentityRepair(db, { scope: 'identity' });
    const bounded = await runBoundedPostingIdentityRepair(db, { jobBatch: 1 });

    expect(bounded).toMatchObject({
      scope: 'identity',
      duplicateGroups: singlePass.duplicateGroups,
      duplicateJobs: singlePass.duplicateJobs,
      eligibleDuplicateGroups: singlePass.eligibleDuplicateGroups,
      expectedChanges: singlePass.expectedChanges,
      jobUpdates: singlePass.jobUpdates,
      jobDeletes: singlePass.jobDeletes,
      aliasWrites: singlePass.aliasWrites,
      applicationRemaps: singlePass.applicationRemaps,
      applicationMerges: singlePass.applicationMerges,
      sessionRemaps: singlePass.sessionRemaps,
      releaseRemaps: singlePass.releaseRemaps,
      proposalRemaps: singlePass.proposalRemaps,
      conflicts: [],
    });
    const applied = await runBoundedPostingIdentityRepair(db, {
      apply: true,
      jobBatch: 1,
      repairToken: bounded.repairToken,
      expectedChanges: bounded.expectedChanges,
      expectedDuplicateJobs: bounded.duplicateJobs,
    });
    expect(applied).toMatchObject({ applied: true, projectionRefreshRequired: true });
    expect(await store.getJob('plus-duplicate')).toMatchObject({ jobId: 'plus-old' });
    expect(await runPostingIdentityRepair(db, { scope: 'identity' })).toMatchObject({
      expectedChanges: 0,
      duplicateJobs: 0,
    });
    sqlite.close();
  });

  it('does not load unrelated large catalog or user row classes into the repair snapshot', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite);
    const before = await runPostingIdentityRepair(db);
    sqlite.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, 'catalog-projection', ?)")
      .run('CATALOG_PROJECTION#test', 'PAGE#1', JSON.stringify({ jobs: ['x'.repeat(250_000)] }));
    sqlite.prepare("INSERT INTO user_items (user_id, item_key, kind, value) VALUES (?, ?, 'preferences', ?)")
      .run('user-test', 'PREFERENCES', JSON.stringify({ ignored: 'x'.repeat(250_000) }));

    const after = await runPostingIdentityRepair(db);
    expect(after.snapshotDigest).toBe(before.snapshotDigest);
    expect(after.repairToken).toBe(before.repairToken);
    sqlite.close();
  });

  it('uses an exact official connector occurrence to resolve duplicate presentation safely', async () => {
    const { db, store } = await historicalDatabase({ authoritativePresentation: true });
    const dry = await runPostingIdentityRepair(db);
    expect(dry).toMatchObject({
      duplicateGroups: 2,
      eligibleDuplicateGroups: 2,
      unresolvedDuplicateGroups: 0,
      presentationDisagreements: [],
    });
    await runPostingIdentityRepair(db, {
      apply: true,
      repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges,
      expectedDuplicateJobs: dry.duplicateJobs,
    });
    expect(await store.getJob('plus-old')).toMatchObject({
      applyUrl: `https://jobs.lever.co/plus-2/${plusId}/apply`,
      sourceReferences: expect.arrayContaining([expect.objectContaining({ sourceId: 'lever-plusai' })]),
    });
    expect(await store.getJob('drw-old')).toMatchObject({
      applyUrl: 'https://job-boards.greenhouse.io/drweng/jobs/3413670',
      sourceReferences: expect.arrayContaining([expect.objectContaining({ sourceId: 'greenhouse-drweng' })]),
    });
  });

  it('uses an immutable official-page review to resolve an exact provider collision', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const url = 'https://www.metacareers.com/jobs/1027438186737957';
    const older = job('meta-older', url, '2026-08-25T00:00:00.000Z', [
      { ...occurrence('speedyapply-2027-ai', 'meta-a', url), company: 'Meta',
        title: 'Research Scientist Intern - AI - Cyber Security', location: 'Menlo Park, CA' },
    ], { company: 'Meta', title: 'Research Scientist Intern - AI - Cyber Security', location: 'Menlo Park, CA' });
    const newer = job('meta-newer', `${url}?utm_source=Simplify`, '2026-09-03T00:00:00.000Z', [
      { ...occurrence('simplify-summer-2026', 'meta-b', `${url}?utm_source=Simplify`), company: '🔥 Meta',
        title: 'Research Scientist Intern - Multiple Teams', location: 'Menlo Park, CA' },
    ], { company: '🔥 Meta', title: 'Research Scientist Intern - Multiple Teams', location: 'Menlo Park, CA' });
    await store.putInternship(older);
    await store.putInternship(newer);

    const dry = await runPostingIdentityRepair(db, { scope: 'identity' });
    expect(dry).toMatchObject({
      duplicateGroups: 1,
      eligibleDuplicateGroups: 1,
      unresolvedDuplicateGroups: 0,
      presentationDisagreements: [],
      conflicts: [],
    });
    await runPostingIdentityRepair(db, {
      apply: true,
      repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges,
      expectedDuplicateJobs: dry.duplicateJobs,
      scope: 'identity',
    });
    expect(await store.getJob('meta-older')).toMatchObject({
      company: 'Meta',
      title: 'Research Scientist Intern, AI, Cyber Security, Safety — MSL Trust & Safety (PhD)',
      location: 'Menlo Park, CA',
      locations: ['Menlo Park, CA'],
      applyUrl: url,
      season: 'summer-2027',
      postingIdentity: { provider: 'meta', tenant: 'meta', providerPostingId: '1027438186737957' },
    });
    expect(await store.getJob('meta-newer')).toMatchObject({ jobId: 'meta-older' });
    sqlite.close();
  });

  it('uses a confirmed employer-owned provider mapping for reviewed community presentation', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    sqlite.prepare(`INSERT INTO canonical_employers
      (id, display_name, reviewed_at, reviewed_by, created_at, updated_at)
      VALUES ('goldman-sachs', 'Goldman Sachs', '2026-09-01', 'official-route-review', '2026-09-01', '2026-09-01')`).run();
    sqlite.prepare(`INSERT INTO employer_mappings
      (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
      VALUES ('goldman-provider', 'goldman-sachs', 'goldman-sachs', 'goldman-sachs',
        '2026-09-01', 'official-route-review', '2026-09-01')`).run();
    const url = 'https://higher.gs.com/roles/171567';
    const older = job('goldman-older', url, '2026-08-25T00:00:00.000Z', [
      { ...occurrence('canadian-tech-2027', 'goldman-a', url), provenance: 'reviewed-community',
        company: 'Goldman Sachs', title: 'Summer Analyst, Engineering', location: 'Toronto, ON' },
    ], {
      company: 'Goldman Sachs', title: 'Summer Analyst, Engineering', location: 'Toronto, ON',
      admission: { canonicalEmployer: { id: 'goldman-sachs', displayName: 'Goldman Sachs' } },
      internshipIdentity: { company: { canonicalId: 'goldman sachs' } },
    });
    const newer = job('goldman-newer', `${url}?type=students&utm_source=Simplify`, '2026-09-03T00:00:00.000Z', [
      { ...occurrence('simplify-summer-2026', 'goldman-b', `${url}?type=students&utm_source=Simplify`),
        provenance: 'reviewed-community', company: 'Goldman Sachs',
        title: 'Summer Analyst Intern - Americas - Engineering', location: 'Toronto, ON, Canada' },
    ], {
      company: 'Goldman Sachs', title: 'Summer Analyst Intern - Americas - Engineering',
      location: 'Toronto, ON, Canada', internshipIdentity: { company: { canonicalId: 'goldman sachs' } },
    });
    await store.putInternship(older);
    await store.putInternship(newer);

    const dry = await runPostingIdentityRepair(db, { scope: 'identity' });
    expect(dry).toMatchObject({
      duplicateGroups: 1,
      eligibleDuplicateGroups: 1,
      unresolvedDuplicateGroups: 0,
      presentationDisagreements: [],
      conflicts: [],
    });
    await runPostingIdentityRepair(db, {
      apply: true,
      repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges,
      expectedDuplicateJobs: dry.duplicateJobs,
      scope: 'identity',
    });
    expect(await store.getJob('goldman-older')).toMatchObject({
      company: 'Goldman Sachs',
      title: '2027 | Americas | Toronto | Engineering | Summer Analyst',
      location: 'Toronto, ON, Canada',
      locations: ['Toronto, ON, Canada'],
      applyUrl: url,
      postingIdentity: { provider: 'goldman-sachs', tenant: 'goldman-sachs', providerPostingId: '171567' },
    });
    expect(await store.getJob('goldman-newer')).toMatchObject({ jobId: 'goldman-older' });
    sqlite.close();
  });

  it('fails closed when an official-page review evidence hash is invalid', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite);
    sqlite.prepare(`INSERT INTO posting_identity_presentation_reviews
      (id, provider, tenant, posting_id, company, title, location, locations_json,
       apply_url, evidence_url, evidence_hash, reviewed_at, reviewed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'tampered-tesla', 'tesla', 'tesla', '275558', 'Tesla', 'Tampered title', 'Palo Alto, CA',
      '["Palo Alto, CA"]', 'https://www.tesla.com/careers/search/job/software-engineer-275558',
      'https://www.tesla.com/careers/search/job/software-engineer-275558', '0'.repeat(64),
      '2026-09-04T15:40:00Z', 'test-reviewer',
    );

    const dry = await runPostingIdentityRepair(db, { scope: 'identity' });
    expect(dry.conflicts).toEqual(['tampered-tesla: reviewed presentation evidence hash does not match']);
    await expect(runPostingIdentityRepair(db, {
      apply: true, repairToken: dry.repairToken, expectedChanges: dry.expectedChanges,
      expectedDuplicateJobs: dry.duplicateJobs, scope: 'identity',
    })).rejects.toThrow('posting identity conflicts remain');
    sqlite.close();
  });

  it('reconciles Aquatic, Jump, and Squarepoint spellings through the same reviewed employer decision', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const cases = [
      ['aquatic', '910001', 'aquaticcapitalmanagement', 'aquatic-capital-management', 'Aquatic Capital Management'],
      ['jumptrading', '910002', 'jumptrading', 'jump-trading', 'Jump Trading'],
      ['squarepointcapital', '910003', 'squarepointcapital', 'squarepoint-capital', 'Squarepoint Capital'],
    ] as const;
    for (const [legacyEmployerId, postingId, tenant, canonicalEmployerId, displayName] of cases) {
      const sourceId = `greenhouse-${tenant}`;
      const url = `https://job-boards.greenhouse.io/${tenant}/jobs/${postingId}`;
      const evidence: ProviderPostingEvidence = { provider: 'greenhouse', tenant, postingId, sourceId, urls: [url] };
      await store.putCheckpoint({ sourceId, successfulFetches: 10, activeExternalIds: [postingId] });
      const admission = { canonicalEmployer: { id: canonicalEmployerId, displayName } };
      await store.putInternship(job(`community-${postingId}`, url, '2026-08-01T00:00:00.000Z', [
        occurrence('community-list', `community-${postingId}`, url),
      ], { employerId: legacyEmployerId, admission }));
      await store.putInternship(job(`official-${postingId}`, url, '2026-08-02T00:00:00.000Z', [
        { ...occurrence(sourceId, postingId, url, evidence), provenance: 'official-ats' },
      ], { employerId: tenant, admission }));
    }

    expect(await runPostingIdentityRepair(db, { scope: 'identity' })).toMatchObject({
      duplicateGroups: 3,
      eligibleDuplicateGroups: 3,
      unresolvedDuplicateGroups: 0,
      presentationDisagreements: [],
    });
    sqlite.close();
  });

  it('uses reviewed employer mappings to consolidate the four production identities and preserve all eight job IDs', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const reviewedAt = '2026-08-30T00:00:00Z';
    const cases = [
      {
        legacyJobId: 'c8d3d73432eaca4efda52fadca9c6e89', officialJobId: '204c426162f787d321bb70d16d8c9869',
        postingId: '8489233002', tenant: 'aquaticcapitalmanagement', legacyCompany: 'Aquatic Capital',
        canonicalEmployerId: 'aquatic-capital-management', displayName: 'Aquatic Capital Management',
        communitySourceId: 'vanshb03-summer-2027', document: 'README.md',
      },
      {
        legacyJobId: 'a47889f285f1a75bc0e1c48c029039b1', officialJobId: '6350e03733cfa06af80a53e0f047f875',
        postingId: '7974391', tenant: 'jumptrading', legacyCompany: 'Jump Trading',
        canonicalEmployerId: 'jump-trading', displayName: 'Jump Trading',
        communitySourceId: 'simplify-summer-2026', document: 'README-Off-Season.md',
      },
      {
        legacyJobId: 'c6971cd99866453066fb82819cc71c04', officialJobId: '09aa30ca48a977db7d27cd240617f7ef',
        postingId: '7974837', tenant: 'jumptrading', legacyCompany: 'Jump Trading',
        canonicalEmployerId: 'jump-trading', displayName: 'Jump Trading',
        communitySourceId: 'simplify-summer-2026', document: 'README-Off-Season.md',
      },
      {
        legacyJobId: 'ae5b63865b09c95352429982e82a406b', officialJobId: '164db6d239c0e1145cc82d824ee5706d',
        postingId: '243853', tenant: 'squarepointcapital', legacyCompany: 'Squarepoint Capital',
        canonicalEmployerId: 'squarepoint-capital', displayName: 'Squarepoint Capital',
        communitySourceId: 'simplify-summer-2026', document: 'README-Off-Season.md',
      },
    ] as const;
    for (const value of new Map(cases.map((item) => [item.canonicalEmployerId, item])).values()) {
      sqlite.prepare(`INSERT INTO canonical_employers
        (id, display_name, reviewed_at, reviewed_by, created_at, updated_at) VALUES (?, ?, ?, 'issue-50-review', ?, ?)`)
        .run(value.canonicalEmployerId, value.displayName, reviewedAt, reviewedAt, reviewedAt);
    }
    const casesByTenant = new Map<string, typeof cases[number][]>();
    for (const value of cases) casesByTenant.set(value.tenant, [...(casesByTenant.get(value.tenant) ?? []), value]);
    for (const [tenant, values] of casesByTenant) {
      await store.putCheckpoint({
        sourceId: `greenhouse-${tenant}`, successfulFetches: 10,
        activeExternalIds: values.map((item) => item.postingId),
      });
    }
    for (const [index, value] of cases.entries()) {
      const sourceId = `greenhouse-${value.tenant}`;
      const officialUrl = `https://job-boards.greenhouse.io/${value.tenant}/jobs/${value.postingId}`;
      const communityUrl = value.tenant === 'aquaticcapitalmanagement'
        ? `https://job-boards.greenhouse.io/embed/job_app?for=${value.tenant}&jr_id=reviewed-role&token=${value.postingId}`
        : `https://boards.greenhouse.io/embed/job_app?token=${value.postingId}`;
      const evidence: ProviderPostingEvidence = {
        provider: 'greenhouse', tenant: value.tenant, postingId: value.postingId, sourceId, urls: [officialUrl],
      };
      const admission = {
        canonicalEmployer: { id: value.canonicalEmployerId, displayName: value.displayName },
        employerResolution: 'resolved' as const,
        postingAttribution: 'attributed' as const,
        destination: {
          candidateUrl: officialUrl, provider: 'greenhouse' as const, tenant: value.tenant,
          expectedPostingId: value.postingId, inspectedAt: reviewedAt, classification: 'posting-detail' as const,
        },
        metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
        catalogEligible: true, alertEligible: true, reasonCodes: [], evaluatedAt: reviewedAt, evidenceObservedAt: reviewedAt,
      };
      const scope = `employer:${value.legacyCompany.toLowerCase().replace(/\s+/gu, '-')}`;
      sqlite.prepare(`INSERT OR IGNORE INTO employer_mappings
        (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, created_at)
        VALUES (?, 'github', ?, ?, ?, 'issue-50-review', ?)`)
        .run(`mapping-${index}`, scope, value.canonicalEmployerId, reviewedAt, reviewedAt);
      const legacyReference = {
        ...occurrence(value.communitySourceId, `${value.document}:${communityUrl}`, communityUrl),
        provenance: 'reviewed-community' as const, document: value.document, company: value.legacyCompany,
      };
      const officialReference = {
        ...occurrence(sourceId, value.postingId, officialUrl, evidence),
        provenance: 'official-ats' as const, company: value.displayName, admission,
      };
      await store.putInternship(job(value.legacyJobId, communityUrl, '2026-08-01T00:00:00.000Z', [legacyReference], {
        company: value.legacyCompany,
      }));
      await store.putInternship(job(value.officialJobId, officialUrl, '2026-08-02T00:00:00.000Z', [officialReference], {
        company: value.displayName,
        admission,
      }));
      await store.putSourceOccurrence({
        sourceId: legacyReference.sourceId,
        externalId: legacyReference.externalId!,
        jobId: value.legacyJobId,
        occurrence: legacyReference,
        present: true,
        consecutiveOmissions: 0,
        changedSnapshotHash: 'reviewed-production-regression',
        changedAt: reviewedAt,
      });
      await store.putSourceOccurrence({
        sourceId: officialReference.sourceId,
        externalId: officialReference.externalId!,
        jobId: value.officialJobId,
        occurrence: officialReference,
        present: true,
        consecutiveOmissions: 0,
        changedSnapshotHash: 'reviewed-production-regression',
        changedAt: reviewedAt,
      });
      await store.claimPostingIdentity(buildPostingIdentity({ applicationUrl: officialUrl }), value.officialJobId);
    }

    const dry = await runPostingIdentityRepair(db, { scope: 'identity' });
    expect(dry).toMatchObject({
      duplicateGroups: 4, duplicateJobs: 4, eligibleDuplicateGroups: 4,
      unresolvedDuplicateGroups: 0, presentationDisagreements: [],
    });
    await runPostingIdentityRepair(db, {
      scope: 'identity', apply: true, repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges, expectedDuplicateJobs: dry.duplicateJobs,
    });
    expect(await runPostingIdentityRepair(db, { scope: 'identity' })).toMatchObject({
      duplicateGroups: 0, duplicateJobs: 0, expectedChanges: 0,
      gate: { passed: false, danglingOccurrenceReferences: 4 },
    });
    for (const value of cases) {
      const legacy = await store.getJob(value.legacyJobId);
      const official = await store.getJob(value.officialJobId);
      expect(legacy?.jobId).toBe(official?.jobId);
      expect(legacy).toMatchObject({ admission: { canonicalEmployer: { id: value.canonicalEmployerId } } });
    }
    const occurrenceDryRun = await runPostingIdentityRepair(db, { scope: 'occurrences' });
    expect(occurrenceDryRun).toMatchObject({
      occurrenceRemaps: 4,
      applicationRemaps: 0,
      receiptRemaps: 0,
      releaseRemaps: 0,
      proposalRemaps: 0,
      gate: { passed: false, danglingOccurrenceReferences: 4 },
    });
    await runPostingIdentityRepair(db, {
      scope: 'occurrences', apply: true, repairToken: occurrenceDryRun.repairToken,
      expectedChanges: occurrenceDryRun.expectedChanges, expectedDuplicateJobs: occurrenceDryRun.duplicateJobs,
    });
    expect(await runPostingIdentityRepair(db)).toMatchObject({
      expectedChanges: 0,
      conflicts: [],
      gate: { passed: true, danglingOccurrenceReferences: 0 },
    });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM catalog_items AS occurrence
      WHERE occurrence.kind = 'source-occurrence'
        AND NOT EXISTS (SELECT 1 FROM catalog_items AS job
          WHERE job.pk = 'JOB#' || json_extract(occurrence.value, '$.jobId')
            AND job.sk = 'META' AND job.kind = 'internship')`).get()).toEqual({ count: 0 });
    sqlite.close();
  });

  it('keeps genuinely different reviewed employer IDs as a presentation blocker', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const postingId = '910004'; const tenant = 'aquaticcapitalmanagement';
    const sourceId = `greenhouse-${tenant}`;
    const url = `https://job-boards.greenhouse.io/${tenant}/jobs/${postingId}`;
    const evidence: ProviderPostingEvidence = { provider: 'greenhouse', tenant, postingId, sourceId, urls: [url] };
    await store.putCheckpoint({ sourceId, successfulFetches: 10, activeExternalIds: [postingId] });
    await store.putInternship(job('community-reviewed-conflict', url, '2026-08-01T00:00:00.000Z', [
      occurrence('community-list', 'community-reviewed-conflict', url),
    ], { employerId: 'same-legacy-id', admission: { canonicalEmployer: { id: 'reviewed-one', displayName: 'Reviewed One' } } }));
    await store.putInternship(job('official-reviewed-conflict', url, '2026-08-02T00:00:00.000Z', [
      { ...occurrence(sourceId, postingId, url, evidence), provenance: 'official-ats' },
    ], { employerId: 'same-legacy-id', admission: { canonicalEmployer: { id: 'reviewed-two', displayName: 'Reviewed Two' } } }));

    expect(await runPostingIdentityRepair(db, { scope: 'identity' })).toMatchObject({
      eligibleDuplicateGroups: 0,
      unresolvedDuplicateGroups: 1,
      presentationDisagreements: [expect.objectContaining({ fields: ['employerIdentity'] })],
    });
    sqlite.close();
  });

  it('applies exact guarded remaps for presentation-agreeing groups, preserves workflow/notifications, resolves legacy IDs, and is idempotent', async () => {
    const { sqlite, db, store } = await historicalDatabase({ presentationAgrees: true });
    sqlite.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('TOMBSTONE#student', 'ROLE#plus-duplicate', 'notification-tombstone', ?)")
      .run(JSON.stringify({ jobId: 'plus-duplicate', deletedAt: '2026-08-03T00:00:00Z' }));
    const dry = await runPostingIdentityRepair(db);
    expect(dry).toMatchObject({ eligibleDuplicateGroups: 2, eligibleDuplicateJobs: 2, unresolvedDuplicateGroups: 0 });
    const applied = await runPostingIdentityRepair(db, { apply: true, repairToken: dry.repairToken, expectedChanges: dry.expectedChanges, expectedDuplicateJobs: dry.duplicateJobs });
    expect(applied).toMatchObject({ applied: true, projectionRefreshRequired: true });
    expect(await store.getJob('plus-duplicate')).toMatchObject({
      jobId: 'plus-old', open: true,
      notification: { smsPending: false, digestPending: false, smsSentAt: '2026-07-28T03:13:00.000Z', digestedAt: '2026-07-28T12:00:00.000Z' },
      sourceReferences: expect.arrayContaining([expect.objectContaining({
        sourceId: 'lever-plusai',
        providerEvidence: expect.objectContaining({ provider: 'lever', tenant: 'plus-2', postingId: plusId }),
      })]),
    });
    expect(await store.pendingSms()).not.toEqual(expect.arrayContaining([expect.objectContaining({ jobId: 'plus-old' })]));
    expect(await store.pendingDigest()).not.toEqual(expect.arrayContaining([expect.objectContaining({ jobId: 'plus-old' })]));
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'notification-event'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT sk, value FROM catalog_items WHERE kind = 'notification-tombstone'").get()).toEqual({
      sk: 'ROLE#plus-old', value: JSON.stringify({ jobId: 'plus-old', deletedAt: '2026-08-03T00:00:00Z' }),
    });
    expect(sqlite.prepare("SELECT job_id FROM employer_field_proposals WHERE id = 'proposal'").get()).toEqual({ job_id: 'plus-old' });
    const applications = sqlite.prepare("SELECT value FROM user_items WHERE kind = 'application'").all().map((row) => JSON.parse((row as { value: string }).value));
    expect(applications).toEqual([expect.objectContaining({
      applicationId: 'saved',
      jobId: 'plus-old',
      status: 'interview',
      appliedAt: '2026-08-02T12:00:00Z',
      detection: { source: 'gmail', detectedAt: '2026-08-02T12:00:00Z' },
      applyMode: 'official-form',
      notes: 'interview note\n\nlatest note',
    })]);
    expect(applications[0]).not.toHaveProperty('queuedAt');
    const release = JSON.parse((sqlite.prepare("SELECT value FROM user_items WHERE kind = 'catalog-release'").get() as { value: string }).value);
    expect(release).toMatchObject({ jobIds: ['plus-old', 'regular-a'], newJobIds: ['plus-old'] });
    const receipts = sqlite.prepare("SELECT value FROM user_items WHERE kind = 'receipt'").all().map((row) => JSON.parse((row as { value: string }).value));
    expect(receipts).toEqual([expect.objectContaining({ jobId: 'plus-old', status: 'ok', deliveryState: 'delivered' })]);
    const recovery = await store.recoverUndeliveredNotifications({
      since: '2026-08-01T00:00:00.000Z', limit: 10, apply: false,
    });
    expect(recovery).toEqual({ candidates: 1, candidateJobIds: ['drw-old'], requeued: 0 });
    await store.recoverUndeliveredNotifications({
      since: '2026-08-01T00:00:00.000Z', limit: 10, apply: true, expectedCandidateJobIds: ['drw-old'],
    });
    expect(await store.pendingSms()).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: 'drw-old' })]));
    const verification = await runPostingIdentityRepair(db);
    expect(verification).toMatchObject({ duplicateJobs: 0, expectedChanges: 0, conflicts: [] });
  });

  it('keeps repaired jobs out of browse and delivery indexes when admission is ineligible', async () => {
    const { sqlite, db, store } = await historicalDatabase({ presentationAgrees: true });
    const rejectedAdmission = {
      employerResolution: 'unresolved' as const,
      postingAttribution: 'attributed' as const,
      destination: {
        candidateUrl: `https://jobs.lever.co/plus-2/${plusId}`,
        provider: 'lever' as const,
        classification: 'aggregate-board' as const,
        inspectedAt: '2026-08-03T00:00:00.000Z',
      },
      metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
      catalogEligible: false,
      alertEligible: false,
      reasonCodes: ['employer-unresolved' as const, 'destination-aggregate-board' as const],
      evaluatedAt: '2026-08-03T00:00:00.000Z',
      evidenceObservedAt: '2026-08-03T00:00:00.000Z',
    };
    for (const jobId of ['plus-old', 'plus-duplicate']) {
      const current = await store.getJob(jobId);
      expect(current).toBeDefined();
      await store.putInternship({
        ...current!,
        admission: rejectedAdmission,
        notification: { ...current!.notification, smsPending: true, digestPending: true },
        sourceReferences: current!.sourceReferences.map((reference) => ({ ...reference, admission: rejectedAdmission })),
      });
    }

    const preview = await runPostingIdentityRepair(db, { scope: 'identity' });
    await runPostingIdentityRepair(db, {
      scope: 'identity', apply: true, repairToken: preview.repairToken,
      expectedChanges: preview.expectedChanges, expectedDuplicateJobs: preview.duplicateJobs,
    });

    expect(sqlite.prepare(`SELECT catalog_state, catalog_sort_key, search_text, source_classes, sms_pending, digest_pending
      FROM catalog_items WHERE pk = 'JOB#plus-old' AND sk = 'META'`).get()).toEqual({
      catalog_state: null,
      catalog_sort_key: null,
      search_text: null,
      source_classes: null,
      sms_pending: 0,
      digest_pending: 0,
    });
  });

  it('refuses stale guards and existing alias conflicts', async () => {
    const stale = await historicalDatabase({ presentationAgrees: true }); const dry = await runPostingIdentityRepair(stale.db);
    await expect(runPostingIdentityRepair(stale.db, { apply: true, repairToken: dry.repairToken, expectedChanges: dry.expectedChanges + 1, expectedDuplicateJobs: dry.duplicateJobs })).rejects.toThrow('Catalog changed after dry run');
    stale.sqlite.prepare("INSERT OR REPLACE INTO catalog_items (pk, sk, kind, value) VALUES (?, 'CLAIM', 'posting-alias', ?)")
      .run(`POSTING_ALIAS#provider:lever:plus-2:${plusId}`, JSON.stringify({ alias: `provider:lever:plus-2:${plusId}`, canonicalJobId: 'wrong-job' }));
    expect(await runPostingIdentityRepair(stale.db)).toMatchObject({ conflicts: [expect.stringContaining('already claimed')] });
  });

  it('classifies Ashby, ByteDance, and Workday history through the provider-neutral registry', async () => {
    const sqlite = database(); const db = sqliteD1(sqlite); const store = new D1InternshipStore(db);
    const historical = [
      ['ashby', 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
      ['bytedance', 'https://lifeattiktok.com/search/7672883129493948677'],
      ['workday', 'https://acme.wd1.myworkdayjobs.com/External/job/Remote/Software-Intern_JR1001'],
    ] as const;
    for (const [id, url] of historical) {
      const reference = occurrence(`community-${id}`, id, url);
      await store.putInternship(job(id, url, '2026-08-01T00:00:00.000Z', [reference]));
      await store.putSourceOccurrence({
        sourceId: reference.sourceId, externalId: id, jobId: id, occurrence: reference,
        present: true, consecutiveOmissions: 0, changedSnapshotHash: 'legacy', changedAt: '2026-08-01T00:00:00.000Z',
      });
    }
    for (const id of ['unknown-a', 'unknown-b']) {
      const reference = occurrence('community-unknown', id, `https://careers.example.test/jobs/${id}`);
      await store.putInternship(job(id, reference.applyUrl, '2026-08-01T00:00:00.000Z', [reference]));
      await store.putSourceOccurrence({
        sourceId: reference.sourceId, externalId: id, jobId: id, occurrence: reference,
        present: true, consecutiveOmissions: 0, changedSnapshotHash: 'legacy', changedAt: '2026-08-01T00:00:00.000Z',
      });
    }

    const identity = await runPostingIdentityRepair(db, { scope: 'identity' });
    expect(identity).toMatchObject({
      providerGroups: 3, expectedChanges: 6,
      occurrenceCounts: { confirmed: 0, unconfirmed: 0, legacy: 5 },
      gate: { passed: false, legacyOccurrences: 5, projectionMismatches: 0 },
      unknownUrlFamilyCandidates: [expect.objectContaining({ occurrences: 2 })],
    });
    await runPostingIdentityRepair(db, {
      apply: true, scope: 'identity', repairToken: identity.repairToken,
      expectedChanges: identity.expectedChanges, expectedDuplicateJobs: identity.duplicateJobs,
    });
    const occurrences = await runPostingIdentityRepair(db, { scope: 'occurrences' });
    expect(occurrences).toMatchObject({
      expectedChanges: 10, aliasWrites: 0, jobDeletes: 0,
      unknownUrlFamilyCandidates: [expect.objectContaining({ occurrences: 2 })],
    });
    await runPostingIdentityRepair(db, {
      apply: true, scope: 'occurrences', repairToken: occurrences.repairToken,
      expectedChanges: occurrences.expectedChanges, expectedDuplicateJobs: occurrences.duplicateJobs,
    });
    expect(await store.getJob('ashby')).toMatchObject({ postingIdentityStatus: 'confirmed' });
    expect(await store.getJob('unknown-a')).toMatchObject({ postingIdentityStatus: 'unconfirmed' });
    expect(await store.getJob('unknown-b')).toMatchObject({ postingIdentityStatus: 'unconfirmed' });
    expect(await runPostingIdentityRepair(db)).toMatchObject({
      expectedChanges: 0,
      occurrenceCounts: { confirmed: 3, unconfirmed: 2, legacy: 0 },
      gate: { passed: true, legacyOccurrences: 0, projectionMismatches: 0 },
      unknownUrlFamilyCandidates: [expect.objectContaining({ occurrences: 2 })],
    });
    sqlite.close();
  });

  it('keeps a production-sized guarded apply under the paid D1 query budget', async () => {
    const sqlite = database();
    const metrics: QueryMetrics = { statements: 0, calls: 0, maxBoundParameters: 0, maxBatchStatements: 0, inBatch: false };
    const db = sqliteD1(sqlite, metrics);
    const insert = sqlite.prepare('INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id) VALUES (?, ?, ?, ?, ?, ?)');
    // This executable fixture exceeds the old 900-statement ceiling; the
    // production-size assertion below covers the current 4,250-job shape. At
    // 2,200 rows it also spans several plan pages, so the keyset-paged reads run
    // here for real.
    const corpusSize = 1_100;
    sqlite.exec('BEGIN');
    try {
      for (let index = 0; index < corpusSize; index += 1) {
        const id = `historical-${index}`;
        const url = `https://acme.wd1.myworkdayjobs.com/External/job/Remote/Software-Intern_REQ-${index}`;
        const reference = occurrence('historical-workday', id, url);
        const value = job(id, url, '2026-08-01T00:00:00.000Z', [reference]);
        insert.run(`JOB#${id}`, 'META', 'internship', JSON.stringify(value), null, null);
        insert.run(`SOURCE#${reference.sourceId}`, `OCCURRENCE#${id}`, 'source-occurrence', JSON.stringify({
          sourceId: reference.sourceId, externalId: id, jobId: id, occurrence: reference,
          present: true, consecutiveOmissions: 0, changedSnapshotHash: 'legacy', changedAt: '2026-08-01T00:00:00.000Z',
        }), reference.sourceId, id);
      }
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
    metrics.statements = 0; metrics.calls = 0; metrics.maxBoundParameters = 0;
    const dry = await runBoundedPostingIdentityRepair(db, { jobBatch: 100 });
    expect(dry).toMatchObject({ expectedChanges: corpusSize * 2, conflicts: [], unresolvedDuplicateGroups: 0 });
    metrics.statements = 0; metrics.calls = 0; metrics.maxBoundParameters = 0;
    const applied = await runBoundedPostingIdentityRepair(db, {
      apply: true, jobBatch: 100, repairToken: dry.repairToken,
      expectedChanges: dry.expectedChanges, expectedDuplicateJobs: dry.duplicateJobs,
    });
    const verification = await runBoundedPostingIdentityRepair(db, { jobBatch: 100 });
    expect(applied).toMatchObject({ applied: true, projectionRefreshRequired: true });
    expect(verification).toMatchObject({ expectedChanges: 0, conflicts: [] });
    expect(postingIdentityRepairQueryCount(dry.expectedChanges)).toBe(124);
    expect(postingIdentityRepairQueryCount(4_250 * 2)).toBe(439);
    // The preview and verification walk the full production-shaped corpus, but
    // every broad read is keyset-paged and every full-value occurrence read is
    // limited to one identity-group batch.
    expect(metrics.statements).toBeLessThanOrEqual(900);
    expect(metrics.maxBoundParameters).toBeLessThanOrEqual(100);
    expect(metrics.maxBatchStatements).toBeLessThanOrEqual(25);
    const occurrences = await runPostingIdentityRepair(db, { scope: 'occurrences' });
    expect(occurrences).toMatchObject({ expectedChanges: corpusSize * 2, aliasWrites: 0, conflicts: [] });
    await runPostingIdentityRepair(db, {
      apply: true, repairToken: occurrences.repairToken,
      expectedChanges: occurrences.expectedChanges, expectedDuplicateJobs: occurrences.duplicateJobs, scope: 'occurrences',
    });
    expect(await runPostingIdentityRepair(db)).toMatchObject({ expectedChanges: 0, conflicts: [] });
    sqlite.close();
  }, 30_000);
});
