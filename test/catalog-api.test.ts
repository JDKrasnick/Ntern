import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryReleaseStore, MemoryUserStore } from '../src/store.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import type { CatalogAdmission, Internship, InternshipIdentity } from '../src/types.js';

function job(id: string, seconds: number, title = `Software Intern ${id}`): Internship {
  const observed = `2026-08-23T12:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    jobId: id, company: 'Acme', title, location: 'Remote', season: 'summer-2027', applyUrl: `https://careers.example.test/${id}`,
    normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id, compensation: { raw: '' }, sourceReferences: [], technical: true,
    open: true, firstSeenAt: observed, catalogVisibleAt: observed, lastSeenAt: observed, notification: { smsPending: false, digestPending: false },
  };
}

function identity(title: string, discipline: 'software' | 'ai-ml'): InternshipIdentity {
  const provenance = [{ source: 'deterministic-inference' as const, sourceId: 'test', evidenceCode: 'test' }];
  return {
    company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance } },
    programType: { value: 'internship', provenance },
    season: { term: 'summer', year: 2027, evidenceStatus: 'explicit', provenance },
    education: { levels: ['undergraduate'], evidenceStatus: 'explicit', provenance },
    title: {
      official: { value: title, provenance }, display: { value: title, provenance },
      search: { value: title.toLowerCase(), provenance },
    },
    disciplines: [{ value: discipline, provenance }], locations: [],
  };
}

const event = (method: string, path: string, queryStringParameters?: Record<string, string>, userId?: string) => ({
  rawPath: path, queryStringParameters,
  requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) },
});
const body = <T>(response: { body: string }) => JSON.parse(response.body) as T;

describe('grouped catalog API', () => {
  it('rejects unsupported availability states for catalog rows and details', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('one', 0));
    const details = groupCatalogJobs(await jobs.listCatalog()).map(catalogGroupDetails);
    await jobs.putCatalogProjection(details, new Date().toISOString());
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const invalidList = await handler(event('GET', '/catalog', { status: 'invalid' }));
    const invalidDetail = await handler(event('GET', `/catalog/groups/${details[0]!.group.groupId}`, { status: 'invalid' }));
    expect(invalidList.statusCode).toBe(400);
    expect(invalidDetail.statusCode).toBe(400);
  });

  it('filters projection pages in the API so dynamic admission remains authoritative', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('software', 0), internshipIdentity: identity('Software Intern', 'software') });
    await jobs.putInternship({ ...job('ml', 10, 'Machine Learning Intern'), internshipIdentity: identity('Machine Learning Intern', 'ai-ml') });
    await jobs.putCatalogProjection(groupCatalogJobs(await jobs.listCatalog()).map(catalogGroupDetails), new Date().toISOString());
    let projectionReads = 0;
    // A searched page reads the matching groups in SQL and then re-checks each
    // role's admission, so a projection written by an older deploy stays
    // advisory rather than authoritative.
    const projected = jobs.listCatalogProjectionFiltered.bind(jobs);
    jobs.listCatalogProjectionFiltered = async (...args) => { projectionReads += 1; return projected(...args); };
    const response = await createApiHandler({ jobs, users: new MemoryUserStore() })(event('GET', '/catalog', { q: 'machine' }));
    expect(response.statusCode).toBe(200);
    expect(body<{ groups: Array<{ titles: string[] }> }>(response).groups).toMatchObject([{ titles: ['Machine Learning Intern'] }]);
    expect(projectionReads).toBe(1);
  });

  it('keeps an admitted role with old evidence visible in default, filtered, and detail projection paths', async () => {
    const jobs = new MemoryInternshipStore();
    const admission: CatalogAdmission = {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved', postingAttribution: 'attributed',
      destination: { classification: 'posting-detail', candidateUrl: 'https://careers.example.test/stale', provider: 'unknown',
        inspectedAt: '2020-01-01T00:00:00Z' },
      metadata: { complete: true, title: 'complete', location: 'complete' }, catalogEligible: true, alertEligible: true,
      reasonCodes: [], evaluatedAt: '2020-01-01T00:00:00Z', evidenceObservedAt: '2020-01-01T00:00:00Z',
    };
    const stale = job('stale', 0);
    stale.admission = admission;
    stale.sourceReferences = [{ sourceId: 'community', provenance: 'reviewed-community', externalId: 'stale', document: 'README.md',
      sourceUrl: 'https://github.com/example/jobs', row: 1, company: stale.company, title: stale.title,
      location: stale.location, season: stale.season, applyUrl: stale.applyUrl, compensation: stale.compensation,
      state: 'open', admission }];
    const [details] = groupCatalogJobs([stale]).map(catalogGroupDetails);
    await jobs.putCatalogProjection([details!], new Date().toISOString());
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    // Owner decision, 2026-09-17: admission is durable, so a stale evidence
    // timestamp no longer hides a role the catalog admitted.
    expect(body<{ groups: unknown[] }>(await handler(event('GET', '/catalog'))).groups).toHaveLength(1);
    expect(body<{ groups: unknown[] }>(await handler(event('GET', '/catalog', { q: 'software' }))).groups).toHaveLength(1);
    expect((await handler(event('GET', `/catalog/groups/${details!.group.groupId}`))).statusCode).toBe(200);
  });

  it('lists public rows, recomputes filtered summaries, and opens complete group details', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('swe', 0), internshipIdentity: identity('Software Intern swe', 'software') });
    await jobs.putInternship({ ...job('ml', 10, 'Machine Learning Intern'), internshipIdentity: identity('Machine Learning Intern', 'ai-ml') });
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const listing = await handler(event('GET', '/catalog', { discipline: 'AI/ML' }));
    const groups = body<{ groups: Array<{ groupId: string; roleCount: number; titles: string[] }> }>(listing).groups;
    expect(groups).toMatchObject([{ roleCount: 1, titles: ['Machine Learning Intern'] }]);

    const unfiltered = body<{ groups: Array<{ groupId: string }> }>(await handler(event('GET', '/catalog'))).groups;
    const details = await handler(event('GET', `/catalog/groups/${unfiltered[0]!.groupId}`));
    expect(body<{ roles: unknown[] }>(details).roles).toHaveLength(2);
  });

  it('returns only the signed-in user release and handles an unavailable store as not found', async () => {
    const jobs = new MemoryInternshipStore(); await jobs.putInternship({ ...job('one', 0), open: false });
    const releases = new MemoryReleaseStore();
    await releases.putRelease({ releaseId: 'release-1', userId: 'student-a', jobIds: ['one'], newJobIds: ['one'], createdAt: '2026-08-23T12:00:08.000Z' });
    const handler = createApiHandler({ jobs, users: new MemoryUserStore(), releases });
    expect((await handler(event('GET', '/me/releases/release-1'))).statusCode).toBe(401);
    expect((await handler(event('GET', '/me/releases/release-1', undefined, 'student-b'))).statusCode).toBe(404);
    const response = await handler(event('GET', '/me/releases/release-1', undefined, 'student-a'));
    expect(body<{ deepLink: string; groups: Array<{ roles: unknown[] }> }>(response)).toMatchObject({ deepLink: 'internnotifs://releases/release-1', groups: [{ roles: [expect.any(Object)] }] });
    expect((await createApiHandler({ jobs, users: new MemoryUserStore() })(event('GET', '/me/releases/release-1', undefined, 'student-a'))).statusCode).toBe(404);
  });

  it('serves a materialized page without rebuilding the complete catalog', async () => {
    const jobs = new MemoryInternshipStore();
    const role = job('one', 0);
    await jobs.putInternship(role);
    await jobs.putCatalogProjection(groupCatalogJobs([role]).map(catalogGroupDetails), '2026-08-24T00:00:00.000Z');
    jobs.listCatalog = async () => { throw new Error('projection should avoid a catalog rebuild'); };
    const response = await createApiHandler({ jobs, users: new MemoryUserStore() })(event('GET', '/catalog', { limit: '1' }));
    expect(response.statusCode).toBe(200);
    expect(body<{ groups: Array<{ roleCount: number }> }>(response)).toMatchObject({ groups: [{ roleCount: 1 }] });
  });

  it('fills sparse filtered pages with bounded projection reads and preserves the source cursor', async () => {
    const jobs = new MemoryInternshipStore();
    const roles = Array.from({ length: 230 }, (_, index) => ({
      ...job(`role-${index}`, index % 60),
      company: `Company ${index}`,
      ...(index === 120 || index === 205 ? { open: false } : {}),
    }));
    await jobs.putCatalogProjection(groupCatalogJobs(roles, { includeClosed: true }).map(catalogGroupDetails), new Date().toISOString());
    const reads: Array<{ cursor?: string; limit?: number }> = [];
    const readProjection = jobs.listCatalogProjectionFiltered.bind(jobs);
    jobs.listCatalogProjectionFiltered = async (cursor, limit, filter) => { reads.push({ cursor, limit }); return readProjection(cursor, limit, filter); };
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const first = body<{ groups: Array<{ roleIds: string[] }>; cursor?: string }>(await handler(event('GET', '/catalog', { status: 'closed', limit: '1' })));
    const second = body<{ groups: Array<{ roleIds: string[] }>; cursor?: string }>(await handler(event('GET', '/catalog', { status: 'closed', limit: '1', cursor: first.cursor! })));
    expect(first.groups).toHaveLength(1);
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]!.roleIds).not.toEqual(first.groups[0]!.roleIds);
    expect(reads.every((read) => read.limit === 1)).toBe(true);
    expect(reads.length).toBeLessThanOrEqual(4);
  });

  it('preserves availability, employer, and explicit-requirement browse filters', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('open', 0), employerCategory: 'normal' });
    await jobs.putInternship({
      ...job('restricted', 10), employerCategory: 'startup',
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: true },
    });
    await jobs.putInternship({ ...job('closed', 20), open: false, employerCategory: 'startup' });
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const filtered = body<{ groups: Array<{ roleIds: string[] }> }>(await handler(event('GET', '/catalog', {
      employerCategory: 'startup', hideUsCitizenshipRequired: 'true', educationLevel: 'undergraduate',
    }))).groups;
    expect(filtered).toEqual([]);
    const closed = body<{ groups: Array<{ roleIds: string[] }> }>(await handler(event('GET', '/catalog', {
      status: 'closed', employerCategory: 'startup',
    }))).groups;
    expect(closed).toMatchObject([{ roleIds: ['closed'] }]);

    await jobs.putCatalogProjection(
      groupCatalogJobs(await jobs.listCatalog(), { includeClosed: true }).map(catalogGroupDetails),
      new Date().toISOString(),
    );
    jobs.listCatalog = async () => { throw new Error('closed filtering should use the projection'); };
    const projectedClosed = body<{ groups: Array<{ roleIds: string[] }> }>(await handler(event('GET', '/catalog', {
      status: 'closed', employerCategory: 'startup',
    }))).groups;
    expect(projectedClosed).toMatchObject([{ roleIds: ['closed'] }]);
  });

  it('applies the active filters when a grouped row is opened', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('open', 0), internshipIdentity: identity('Software Intern', 'software') });
    await jobs.putInternship({ ...job('closed', 10), open: false, internshipIdentity: identity('Software Intern', 'software') });
    await jobs.putCatalogProjection(
      groupCatalogJobs(await jobs.listCatalog(), { includeClosed: true }).map(catalogGroupDetails),
      new Date().toISOString(),
    );
    const handler = createApiHandler({ jobs, users: new MemoryUserStore() });
    const row = body<{ groups: Array<{ groupId: string; roleIds: string[] }> }>(await handler(event('GET', '/catalog', { status: 'closed' }))).groups[0]!;
    expect(row.roleIds).toEqual(['closed']);
    const details = body<{ group: { roleCount: number }; roles: Array<{ jobId: string; open: boolean }> }>(
      await handler(event('GET', `/catalog/groups/${row.groupId}`, { status: 'closed' })),
    );
    expect(details).toMatchObject({ group: { roleCount: 1 }, roles: [{ jobId: 'closed', open: false }] });
  });
});
