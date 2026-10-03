import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MAX_LIVE_DELTA_ROLES } from '../src/catalog-live.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { Internship, InternshipIdentity } from '../src/types.js';

/**
 * A role is alerts-eligible the moment its source occurrence is published, and
 * the grouped catalog used to wait up to a full projection tick to show it. These
 * tests pin the read-time overlay that closes that window: a published card is
 * only replaced by live cards that account for every role it holds.
 */
function job(id: string, day: string, seconds: number, title: string, company = 'Acme'): Internship {
  const observed = `${day}T15:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    jobId: id, company, title, location: 'Remote', season: 'summer-2027', applyUrl: `https://careers.example.test/${id}`,
    normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id, compensation: { raw: '' }, sourceReferences: [], technical: true,
    open: true, firstSeenAt: observed, catalogVisibleAt: observed, lastSeenAt: observed, notification: { smsPending: false, digestPending: false },
  };
}

/** Explicit program identity, which is what lets roles group across days. */
function programIdentity(title: string): InternshipIdentity {
  const provenance = [{ source: 'deterministic-inference' as const, sourceId: 'test', evidenceCode: 'test' }];
  return {
    company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance } },
    programType: { value: 'internship', provenance },
    season: { term: 'summer', year: 2027, evidenceStatus: 'explicit', provenance },
    education: { levels: ['undergraduate'], evidenceStatus: 'explicit', provenance },
    title: { official: { value: title, provenance }, display: { value: title, provenance }, search: { value: title.toLowerCase(), provenance } },
    disciplines: [{ value: 'software', provenance }], locations: [],
  };
}

async function publish(jobs: MemoryInternshipStore, at: string) {
  await jobs.putCatalogProjection(groupCatalogJobs(await jobs.listCatalog(), { includeClosed: true }).map(catalogGroupDetails), at);
}

const event = (method: string, path: string, queryStringParameters?: Record<string, string>) => ({
  rawPath: path, queryStringParameters, requestContext: { http: { method } },
});
const body = <T>(response: { body: string }) => JSON.parse(response.body) as T;
const handlerFor = (jobs: MemoryInternshipStore) => createApiHandler({ jobs, users: new MemoryUserStore() });

describe('live catalog overlay', () => {
  it('shows a role published after the last tick, regrouped with its employer day', async () => {
    const jobs = new MemoryInternshipStore();
    for (const [index, id] of ['a', 'b', 'c'].entries()) await jobs.putInternship(job(id, '2026-10-02', index, `Software Intern ${id}`));
    await publish(jobs, '2026-10-02T15:41:56.000Z');
    const handler = handlerFor(jobs);
    const before = body<{ groups: Array<{ kind: string }> }>(await handler(event('GET', '/catalog')));
    expect(before.groups.map(({ kind }) => kind)).toEqual(['individual', 'individual', 'individual']);

    // The fourth role of the day turns three separate cards into one release card.
    await jobs.putInternship(job('d', '2026-10-02', 3, 'Software Intern d'));
    const after = body<{ groups: Array<{ groupId: string; kind: string; roleCount: number; titles: string[] }> }>(
      await handler(event('GET', '/catalog')),
    );
    expect(after.groups).toMatchObject([{ kind: 'employer-release', roleCount: 4 }]);
    expect(after.groups).toHaveLength(1);

    const detail = await handler(event('GET', `/catalog/groups/${after.groups[0]!.groupId}`));
    expect(detail.statusCode).toBe(200);
    expect(body<{ roles: unknown[] }>(detail).roles).toHaveLength(4);

    const searched = body<{ groups: Array<{ roleCount: number; titles: string[] }> }>(await handler(event('GET', '/catalog', { q: 'intern d' })));
    expect(searched.groups).toMatchObject([{ roleCount: 1, titles: ['Software Intern d'] }]);
  });

  it('retires the live prefix once the next publish contains the role', async () => {
    const jobs = new MemoryInternshipStore();
    for (const [index, id] of ['a', 'b', 'c'].entries()) await jobs.putInternship(job(id, '2026-10-02', index, `Software Intern ${id}`));
    await publish(jobs, '2026-10-02T15:41:56.000Z');
    await jobs.putInternship(job('d', '2026-10-02', 3, 'Software Intern d'));

    let live: unknown;
    const readPage = jobs.listCatalogProjection.bind(jobs);
    jobs.listCatalogProjection = async (...args: Parameters<typeof readPage>) => {
      const page = await readPage(...args);
      live = page?.live;
      return page;
    };
    expect(body<{ groups: unknown[] }>(await handlerFor(jobs)(event('GET', '/catalog'))).groups).toHaveLength(1);
    expect(live).toBeDefined();

    await publish(jobs, '2026-10-02T15:51:56.000Z');
    const settled = body<{ groups: Array<{ kind: string; roleCount: number }> }>(await handlerFor(jobs)(event('GET', '/catalog')));
    expect(settled.groups).toMatchObject([{ kind: 'employer-release', roleCount: 4 }]);
    expect(live).toBeUndefined();
  });

  it('reloads a program card that reaches past the publisher day', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('a', '2026-10-01', 0, 'Software Intern a'), internshipIdentity: programIdentity('Software Intern a') });
    await publish(jobs, '2026-10-01T23:00:00.000Z');
    await jobs.putInternship({ ...job('b', '2026-10-02', 0, 'Software Intern b'), internshipIdentity: programIdentity('Software Intern b') });

    const groups = body<{ groups: Array<{ kind: string; roleCount: number }> }>(await handlerFor(jobs)(event('GET', '/catalog'))).groups;
    expect(groups).toMatchObject([{ kind: 'program-group', roleCount: 2 }]);
  });

  it('reloads a release card\u2019s closed sibling when the day grows', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('a', '2026-10-02', 0, 'Software Intern a'));
    await jobs.putInternship(job('b', '2026-10-02', 1, 'Software Intern b'));
    await jobs.putInternship(job('c', '2026-10-02', 2, 'Software Intern c'));
    await jobs.putInternship({ ...job('gone', '2026-10-02', 3, 'Software Intern gone'), open: false });
    await publish(jobs, '2026-10-02T12:00:00.000Z');
    await jobs.putInternship(job('d', '2026-10-02', 4, 'Software Intern d'));

    const handler = handlerFor(jobs);
    const groups = body<{ groups: Array<{ groupId: string; roleCount: number; titles: string[] }> }>(await handler(event('GET', '/catalog'))).groups;
    // One card, not the published four-role card beside the live five-role one:
    // the closed sibling is what the overlap test would otherwise split on.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ roleCount: 4, titles: ['Software Intern d', 'Software Intern c', 'Software Intern b'] });
    const closed = await handler(event('GET', `/catalog/groups/${groups[0]!.groupId}`, { status: 'closed' }));
    expect(closed.statusCode).toBe(200);
    expect(body<{ roles: Array<{ jobId: string }> }>(closed).roles.map(({ jobId }) => jobId)).toEqual(['gone']);
  });

  it('leaves another employer\u2019s cards on the same day published', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('a1', '2026-10-02', 0, 'Software Intern a1'));
    await jobs.putInternship(job('b1', '2026-10-02', 0, 'Software Intern b1', 'Globex'));
    await publish(jobs, '2026-10-02T12:00:00.000Z');
    await jobs.putInternship(job('a2', '2026-10-02', 1, 'Software Intern a2'));

    const groups = body<{ groups: Array<{ groupId: string; titles: string[] }> }>(await handlerFor(jobs)(event('GET', '/catalog'))).groups;
    expect(groups.map(({ titles }) => titles[0]).sort()).toEqual(['Software Intern a1', 'Software Intern a2', 'Software Intern b1']);
  });

  it('falls back to the snapshot when the delta is too large to group on a read', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('base', '2026-10-01', 0, 'Software Intern base'));
    await publish(jobs, '2026-10-01T12:00:00.000Z');
    // A projection that has fallen far behind is an incident, not a burst; the
    // snapshot keeps serving rather than grouping the backlog inside a read.
    for (let index = 0; index <= MAX_LIVE_DELTA_ROLES; index += 1) {
      await jobs.putInternship(job(`burst-${index}`, '2026-10-02', index % 60, `Software Intern burst ${index}`, `Employer ${index}`));
    }

    const groups = body<{ groups: Array<{ titles: string[] }> }>(await handlerFor(jobs)(event('GET', '/catalog'))).groups;
    expect(groups).toMatchObject([{ titles: ['Software Intern base'] }]);
  });

  it('caps a live prefix that fills the page and resumes the published stream behind it', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('base', '2026-10-01', 0, 'Software Intern base'));
    await publish(jobs, '2026-10-01T12:00:00.000Z');
    for (const [index, id] of ['n1', 'n2', 'n3'].entries()) {
      await jobs.putInternship(job(id, '2026-10-02', index, `Software Intern ${id}`, `Employer ${id}`));
    }

    const handler = handlerFor(jobs);
    const page = body<{ groups: Array<{ titles: string[] }>; cursor?: string }>(
      await handler(event('GET', '/catalog', { limit: '2' })),
    );
    expect(page.groups).toHaveLength(2);
    // The prefix filled this page, so the cursor points at the start of the
    // published stream rather than dropping the card behind the prefix.
    expect(page.cursor).toBe('0');
    const rest = body<{ groups: Array<{ titles: string[] }>; cursor?: string }>(
      await handler(event('GET', '/catalog', { limit: '2', cursor: '0' })),
    );
    expect(rest.groups.map(({ titles }) => titles[0])).toEqual(['Software Intern base']);
    expect(rest.cursor).toBeUndefined();
  });

  it('pages past the live prefix without repeating or dropping a card', async () => {
    const jobs = new MemoryInternshipStore();
    for (const [index, id] of ['p1', 'p2', 'p3', 'p4', 'p5'].entries()) {
      await jobs.putInternship(job(id, '2026-10-01', index, `Software Intern ${id}`, `Employer ${id}`));
    }
    await publish(jobs, '2026-10-01T12:00:00.000Z');
    await jobs.putInternship(job('live', '2026-10-02', 0, 'Software Intern live', 'Live Co'));

    const handler = handlerFor(jobs);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const query: Record<string, string> = { limit: '2', ...(cursor ? { cursor } : {}) };
      const response = body<{ groups: Array<{ groupId: string }>; cursor?: string }>(await handler(event('GET', '/catalog', query)));
      seen.push(...response.groups.map(({ groupId }) => groupId));
      cursor = response.cursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('pages past a superseding live prefix without repeating a card', async () => {
    const jobs = new MemoryInternshipStore();
    for (const [index, id] of ['a', 'b', 'c'].entries()) await jobs.putInternship(job(id, '2026-10-02', index, `Software Intern ${id}`));
    await jobs.putInternship(job('o2', '2026-10-01', 1, 'Software Intern o2', 'Globex'));
    await jobs.putInternship(job('o1', '2026-10-01', 0, 'Software Intern o1', 'Initech'));
    await publish(jobs, '2026-10-02T15:41:56.000Z');
    // The fourth Acme role turns the day into a release card that replaces the
    // three published individual cards, so the first page drops cards from the
    // raw stream. The cursor must still resume from the raw offset.
    await jobs.putInternship(job('d', '2026-10-02', 3, 'Software Intern d'));

    const handler = handlerFor(jobs);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const query: Record<string, string> = { limit: '2', ...(cursor ? { cursor } : {}) };
      const response = body<{ groups: Array<{ groupId: string }>; cursor?: string }>(await handler(event('GET', '/catalog', query)));
      seen.push(...response.groups.map(({ groupId }) => groupId));
      cursor = response.cursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('does not repeat a card at the default page size when a published card is superseded', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job('a', '2026-10-01', 0, 'Software Intern a'), internshipIdentity: programIdentity('Software Intern a') });
    for (let index = 0; index < 30; index += 1) {
      await jobs.putInternship(job(`o${index}`, '2026-09-30', index % 60, `Software Intern o${index}`, `Employer ${index}`));
    }
    await publish(jobs, '2026-10-01T23:00:00.000Z');
    // A program card grows and supersedes the published single-role card, one
    // dropped card inside the default 25-card first page.
    await jobs.putInternship({ ...job('b', '2026-10-02', 0, 'Software Intern b'), internshipIdentity: programIdentity('Software Intern b') });

    const handler = handlerFor(jobs);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const query: Record<string, string> = { ...(cursor ? { cursor } : {}) };
      const response = body<{ groups: Array<{ groupId: string }>; cursor?: string }>(await handler(event('GET', '/catalog', query)));
      seen.push(...response.groups.map(({ groupId }) => groupId));
      cursor = response.cursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(31);
    expect(new Set(seen).size).toBe(31);
  });

  it('caps a filtered search page at the requested limit', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('base', '2026-10-01', 0, 'Base Intern'));
    await publish(jobs, '2026-10-01T12:00:00.000Z');
    for (let index = 0; index < 5; index += 1) {
      await jobs.putInternship(job(`alpha-${index}`, '2026-10-02', index, `Alpha Intern ${index}`, `Employer ${index}`));
    }

    const page = body<{ groups: Array<{ titles: string[] }>; cursor?: string }>(
      await handlerFor(jobs)(event('GET', '/catalog', { limit: '2', q: 'alpha' })),
    );
    expect(page.groups).toHaveLength(2);
  });

  it('counts an unprojected release day in the day index', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship(job('a', '2026-10-01', 0, 'Software Intern a'));
    await publish(jobs, '2026-10-01T12:00:00.000Z');
    await jobs.putInternship(job('b', '2026-10-02', 0, 'Software Intern b'));

    const days = body<{ days: Array<{ day: string; roles: number; employers: number }> }>(await handlerFor(jobs)(event('GET', '/catalog/days'))).days;
    expect(days).toContainEqual({ day: '2026-10-02', roles: 1, employers: 1 });
    expect(days).toContainEqual({ day: '2026-10-01', roles: 1, employers: 1 });
  });
});
