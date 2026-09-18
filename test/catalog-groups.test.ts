import { describe, expect, it } from 'vitest';
import { catalogEducation, catalogGroupDetails, employerDropKey, filterCatalogGroupDetails, filterCatalogGroups, groupCatalogJobs } from '../src/catalog-groups.js';
import type { EducationEvidenceStatus, Internship, InternshipIdentity, InternshipProgramType, SeasonEvidenceStatus } from '../src/types.js';

type IdentityJob = Internship & { internshipIdentity?: Record<string, unknown> };

function job(id: string, seconds: number, overrides: Record<string, unknown> = {}): IdentityJob {
  const observed = `2026-08-23T12:00:${String(seconds).padStart(2, '0')}.000Z`;
  return {
    jobId: id, company: 'Acme', title: `Software Engineer Intern ${id}`, location: 'New York | Remote', season: 'summer-2027',
    applyUrl: `https://careers.example.test/${id}`, normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id,
    compensation: { raw: '' }, sourceReferences: [], technical: true, open: true, firstSeenAt: observed, catalogVisibleAt: observed,
    lastSeenAt: observed, notification: { smsPending: false, digestPending: false }, ...overrides,
  } as IdentityJob;
}

function identity(options: {
  educationEvidence?: EducationEvidenceStatus;
  programType?: InternshipProgramType;
  seasonEvidence?: SeasonEvidenceStatus;
} = {}): InternshipIdentity {
  const provenance = [{ source: 'deterministic-inference' as const, sourceId: 'test', evidenceCode: 'test' }];
  return {
    company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance } },
    programType: { value: options.programType ?? 'internship', provenance },
    season: { term: 'summer', year: 2027, evidenceStatus: options.seasonEvidence ?? 'explicit', provenance },
    education: { levels: ['undergraduate'], evidenceStatus: options.educationEvidence ?? 'explicit', provenance },
    title: {
      official: { value: 'Software Engineer Intern', provenance },
      display: { value: 'Software Engineer Intern', provenance },
      search: { value: 'software engineer intern', provenance },
    },
    disciplines: [], locations: [],
  };
}

describe('grouped catalog domain', () => {
  it('preserves housing separately from compensation in featured and detailed roles', () => {
    const housing = [{ kind: 'stipend', minAmount: 2500, maxAmount: 2500, currency: 'USD', period: 'monthly',
      sourceText: 'Monthly housing stipend.', provenance: [] }];
    const details = catalogGroupDetails(groupCatalogJobs([job('housing', 0, { housing, compensation: { raw: 'USD 8,500/month' } })])[0]!);
    expect(details.roles[0]?.housing).toEqual(housing);
    expect(details.group.featuredRole.housing).toEqual(housing);
    expect(details.group.compensations).toEqual(['USD 8,500/month']);
  });
  it('does not let the migration timestamp invent an employer day', () => {
    // 235 of one employer's open roles carry the DynamoDB import timestamp — that is
    // the import, not a posting day, so a reported posting date groups them and a row
    // without one stays its own card rather than swelling an import-day card.
    const migrated = (index: number, reported?: string) => job(`migrated-${index}`, 0, {
      company: 'TikTok',
      catalogRecency: 'baseline',
      catalogVisibleAt: '2026-08-25T02:47:09.000Z',
      firstSeenAt: '2026-08-25T02:47:09.000Z',
      sourceReferences: [{
        sourceId: 'community-list', document: 'README.md', sourceUrl: 'https://example.test', row: index,
        company: 'TikTok', title: `Role ${index}`, location: 'NYC', season: 'summer-2027',
        applyUrl: `https://apply.example.test/${index}`, compensation: { raw: '' }, state: 'open',
        ...(reported ? { postedAt: reported } : {}),
      }],
    });
    const unreported = groupCatalogJobs([migrated(1), migrated(2), migrated(3), migrated(4)]);
    expect(unreported.map(({ row }) => row.kind)).toEqual(['individual', 'individual', 'individual', 'individual']);

    const reported = groupCatalogJobs([migrated(5, '2026-04-24'), migrated(6, '2026-04-24'), migrated(7, '2026-04-24'), migrated(8, '2026-04-24')]);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.row).toMatchObject({ kind: 'employer-release', roleCount: 4 });

    // The day it reports is the day it groups under, not the import day.
    expect(employerDropKey(migrated(9, '2026-04-24'))).toContain('2026-04-24');
    expect(employerDropKey(migrated(10))).toBeUndefined();
  });

  it('splits drops on the calendar day, not on a rolling window', () => {
    const at = (iso: string) => ({ firstSeenAt: iso, catalogVisibleAt: iso, lastSeenAt: iso });
    // A rolling employer's last role of the day and first role of the next day are
    // separate instances, however close together they land.
    const acrossMidnight = groupCatalogJobs([
      job('late', 0, at('2026-08-23T23:59:30.000Z')), job('late-two', 0, at('2026-08-23T23:59:40.000Z')),
      job('late-three', 0, at('2026-08-23T23:59:50.000Z')), job('late-four', 0, at('2026-08-23T23:59:59.000Z')),
      job('early', 0, at('2026-08-24T00:00:05.000Z')),
    ]);
    expect(acrossMidnight.map(({ row }) => [row.kind, row.roleCount]).sort()).toEqual([['employer-release', 4], ['individual', 1]]);

    // Everything inside one calendar day is one card, even hours apart.
    const sameDay = groupCatalogJobs([
      job('morning', 0, at('2026-08-23T06:40:28.000Z')), job('noon', 0, at('2026-08-23T12:00:00.000Z')),
      job('afternoon', 0, at('2026-08-23T17:20:00.000Z')), job('night', 0, at('2026-08-23T22:05:00.000Z')),
    ]);
    expect(sameDay).toHaveLength(1);
    expect(sameDay[0]?.row).toMatchObject({ kind: 'employer-release', roleCount: 4 });
  });

  it('keeps a drop together, absorbing roles that arrive later and earlier in its window', () => {
    const at = (iso: string) => ({ firstSeenAt: iso, catalogVisibleAt: iso, lastSeenAt: iso });
    // Visa: a single role in the morning, the batch hours later, one more role
    // after that — one card, and the group id stays anchored to the first role.
    const drop = groupCatalogJobs([
      job('morning', 0, at('2026-08-23T06:40:28.000Z')),
      job('batch-one', 0, at('2026-08-23T14:37:52.000Z')),
      job('batch-two', 0, at('2026-08-23T14:37:53.000Z')),
      job('batch-three', 0, at('2026-08-23T14:49:44.000Z')),
      job('batch-four', 0, at('2026-08-23T14:52:34.000Z')),
      job('added-later', 0, { ...at('2026-08-23T15:07:50.000Z'), season: 'fall-2027' }),
    ]);
    expect(drop).toHaveLength(1);
    expect(drop[0]?.row).toMatchObject({ kind: 'employer-release', roleCount: 6, seasons: ['fall-2027', 'summer-2027'] });
    expect(drop[0]?.jobs.map((item) => item.jobId)).toEqual(['morning', 'batch-one', 'batch-two', 'batch-three', 'batch-four', 'added-later']);

    // The id depends only on the employer and the day, so a card keeps its
    // identity as roles arrive — the alert and the feed card stay the same object.
    const withoutMorning = groupCatalogJobs(drop[0]!.jobs.slice(1));
    expect(withoutMorning[0]?.row.groupId).toBe(drop[0]?.row.groupId);

    // A role past the drop window opens the employer's next drop.
    const beyondDrop = groupCatalogJobs([
      job('one', 0), job('two', 2), job('three', 4), job('four', 8),
      job('next-drop', 0, at('2026-08-24T13:00:00.000Z')),
    ]);
    expect(beyondDrop.map(({ row }) => [row.kind, row.roleCount]).sort()).toEqual([['employer-release', 4], ['individual', 1]]);
  });

  it('needs four roles in one drop before it claims a card', () => {
    const groups = groupCatalogJobs([job('one', 0), job('two', 2), job('three', 4)]);
    expect(groups.map(({ row }) => row.kind)).toEqual(['individual', 'individual', 'individual']);
  });

  it('treats source decoration and corporate suffixes as the same employer without changing the display name', () => {
    const groups = groupCatalogJobs([
      job('one', 0, { company: 'TikTok' }),
      job('two', 2, { company: '🔥 TikTok' }),
      job('three', 4, { company: 'TikTok, Inc.' }),
      job('four', 8, { company: 'TIKTOK' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.row).toMatchObject({ kind: 'employer-release', company: 'TikTok', roleCount: 4 });
  });

  it('groups only compatible program dimensions and leaves conflicting education individual', () => {
    const undergraduate = identity();
    const groups = groupCatalogJobs([
      job('one', 0, { internshipIdentity: undergraduate }),
      job('two', 10, { internshipIdentity: undergraduate }),
      job('conflict', 20, { internshipIdentity: identity({ educationEvidence: 'conflicting' }) }),
    ]);
    expect(groups.map(({ row }) => [row.kind, row.roleCount])).toEqual([['individual', 1], ['program-group', 2]]);
    expect(catalogEducation(groups[0]!.jobs[0]!)).toMatchObject({ evidence: 'conflicting' });
  });

  it('matches unspecified education and recomputes every visible summary from filtered roles', () => {
    const groups = groupCatalogJobs([
      job('ml', 0, { title: 'Machine Learning Intern', location: 'Boston' }),
      job('product', 10, { title: 'Product Manager Intern', location: 'Austin' }),
    ]);
    expect(groups.map(({ row }) => row.kind)).toEqual(['individual', 'individual']);
    const filtered = filterCatalogGroups(groups, { disciplines: ['AI/ML'], educationLevels: ['Doctoral'] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.row).toMatchObject({ roleCount: 1, titles: ['Machine Learning Intern'], locations: ['Boston'] });
    expect(filtered[0]!.row.disciplines).toContain('AI/ML');
  });

  it('recomputes materialized timestamps, newness, and normalized locations after filtering', () => {
    const jobs = [
      job('ml', 0, { title: 'Machine Learning Intern', location: 'Boston | Remote' }),
      job('two', 2), job('three', 4), job('four', 8),
    ];
    const details = catalogGroupDetails(groupCatalogJobs(jobs)[0]!);
    const filtered = filterCatalogGroupDetails([details], { disciplines: ['AI/ML'] });
    expect(filtered[0]?.group).toMatchObject({
      roleCount: 1,
      featuredRole: { jobId: 'ml' },
      locations: ['Boston', 'Remote'],
      createdAt: '2026-08-23T12:00:00.000Z',
      updatedAt: '2026-08-23T12:00:00.000Z',
      hasNewRoles: false,
    });
  });

  it('counts only explicitly unconfirmed roles and preserves legacy compatibility', () => {
    const details = catalogGroupDetails(groupCatalogJobs([
      job('confirmed', 0, { postingIdentityStatus: 'confirmed' }),
      job('unconfirmed', 2, { postingIdentityStatus: 'unconfirmed' }),
      job('legacy', 4),
      job('unconfirmed-two', 8, { postingIdentityStatus: 'unconfirmed' }),
    ])[0]!);
    expect(details.group).toMatchObject({ roleCount: 4, unconfirmedRoleCount: 2 });
    expect(details.roles.map((role) => role.postingIdentityStatus)).toEqual(['unconfirmed', undefined, 'unconfirmed', 'confirmed']);
  });

  it('keeps structured-location filtering identical before and after materialization', () => {
    const structured = identity();
    structured.locations = [{ name: 'Boston', workMode: 'onsite', provenance: [] }];
    const groups = groupCatalogJobs([job('boston', 0, { location: 'Multiple locations', internshipIdentity: structured })]);
    expect(filterCatalogGroups(groups, { locations: ['Boston'] })).toHaveLength(1);
    expect(filterCatalogGroupDetails(groups.map(catalogGroupDetails), { locations: ['Boston'] })).toHaveLength(1);
  });

  it('preserves full role titles and both detail and official application actions', () => {
    const programIdentity = identity();
    const group = groupCatalogJobs([
      job('one', 0, { internshipIdentity: programIdentity, compensation: { raw: '$42/hr' } }),
      job('two', 10, { internshipIdentity: programIdentity, compensation: { raw: '$48/hr' } }),
    ])[0]!;
    const details = catalogGroupDetails(group);
    expect(details.roles[0]).toMatchObject({ title: expect.stringContaining('Software Engineer Intern'), detailUrl: expect.stringContaining('/jobs/'), officialApplyUrl: expect.stringContaining('careers.example.test') });
    expect(details.group).toMatchObject({
      compensations: ['$48/hr', '$42/hr'],
      featuredRole: { jobId: 'two', compensation: { raw: '$48/hr' }, firstSeenAt: '2026-08-23T12:00:10.000Z' },
    });
  });

  it('keeps a program row identifier stable when a compatible role arrives later', () => {
    const programIdentity = identity();
    const first = groupCatalogJobs([job('one', 0, { internshipIdentity: programIdentity })])[0]!.row.groupId;
    const original = [job('one', 0, { internshipIdentity: programIdentity }), job('two', 10, { internshipIdentity: programIdentity })];
    expect(first).toBe(groupCatalogJobs(original)[0]!.row.groupId);
    expect(groupCatalogJobs(original)[0]!.row.groupId).toBe(groupCatalogJobs([...original, job('three', 20, { internshipIdentity: programIdentity })])[0]!.row.groupId);
  });

  it('keeps a structured employer release distinct from a program role outside its drop', () => {
    const programIdentity = identity();
    const groups = groupCatalogJobs([
      job('one', 0, { internshipIdentity: programIdentity }),
      job('two', 1, { internshipIdentity: programIdentity }),
      job('three', 2, { internshipIdentity: programIdentity }),
      job('four', 3, { internshipIdentity: programIdentity }),
      job('five', 4, { internshipIdentity: programIdentity }),
      job('six', 5, { internshipIdentity: programIdentity }),
      job('later', 0, { firstSeenAt: '2026-08-24T13:00:00.000Z', catalogVisibleAt: '2026-08-24T13:00:00.000Z', lastSeenAt: '2026-08-24T13:00:00.000Z', internshipIdentity: programIdentity }),
    ]);
    expect(groups.map(({ row }) => row.kind)).toEqual(['individual', 'employer-release']);
    expect(new Set(groups.map(({ row }) => row.groupId)).size).toBe(2);
  });

  it('keeps the release namespace when its drop absorbs a program role', () => {
    const programIdentity = identity();
    const release = [job('one', 0, { internshipIdentity: programIdentity }), job('two', 1, { internshipIdentity: programIdentity }),
      job('three', 2, { internshipIdentity: programIdentity }), job('four', 3, { internshipIdentity: programIdentity })];
    const withoutProgramRole = groupCatalogJobs(release)[0]!.row;
    const absorbed = groupCatalogJobs([...release, job('later', 20, { internshipIdentity: programIdentity })]);
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0]?.row).toMatchObject({ kind: 'employer-release', roleCount: 5 });
    expect(absorbed[0]?.row.groupId).toBe(withoutProgramRole.groupId);
  });

  it('never places one role inside a group and on its own card at the same time', () => {
    const at = (iso: string) => ({ firstSeenAt: iso, catalogVisibleAt: iso, lastSeenAt: iso });
    const jobs = [
      job('one', 0), job('two', 2), job('three', 4), job('four', 8),
      job('drop-tail', 0, at('2026-08-23T12:04:00.000Z')),
      job('next-drop', 0, at('2026-08-24T13:00:00.000Z')),
      job('other', 10, { company: 'Globex' }),
    ];
    const groups = groupCatalogJobs(jobs);
    const memberships = new Map<string, string[]>();
    for (const group of groups) for (const item of group.jobs) memberships.set(item.jobId, [...(memberships.get(item.jobId) ?? []), group.row.kind]);

    expect([...memberships.values()].every((kinds) => kinds.length === 1)).toBe(true);
    // Group beats individual: the whole drop sits in the release card, and only
    // the role outside the drop window stays its own card.
    expect(memberships.get('drop-tail')).toEqual(['employer-release']);
    expect(memberships.get('next-drop')).toEqual(['individual']);

    const filtered = filterCatalogGroups(groups, { status: 'open' });
    const filteredMemberships = new Map<string, number>();
    for (const group of filtered) for (const item of group.jobs) filteredMemberships.set(item.jobId, (filteredMemberships.get(item.jobId) ?? 0) + 1);
    expect([...filteredMemberships.values()].every((count) => count === 1)).toBe(true);
    expect(filteredMemberships.size).toBe(jobs.length);
  });

  it('does not combine different program types or evidence-poor seasons', () => {
    const groups = groupCatalogJobs([
      job('internship', 0, { internshipIdentity: identity() }),
      job('new-grad', 10, { internshipIdentity: identity({ programType: 'new-grad' }) }),
      job('inferred-season', 20, { internshipIdentity: identity({ seasonEvidence: 'inferred' }) }),
    ]);
    expect(groups.map(({ row }) => row.kind)).toEqual(['individual', 'individual', 'individual']);
  });

  it('keeps only roles with listed pay when the pay filter is set', () => {
    const groups = groupCatalogJobs([
      job('paid', 0, { compensation: { raw: '$54/hour' } }),
      job('unpaid', 10, { compensation: { raw: '' } }),
      job('blank', 20, { compensation: { raw: '   ' } }),
    ]);
    const filtered = filterCatalogGroups(groups, { hasCompensation: true });
    expect(filtered.flatMap((group) => group.jobs.map((item) => item.jobId))).toEqual(['paid']);
    const details = filterCatalogGroupDetails(groups.map(catalogGroupDetails), { hasCompensation: true });
    expect(details.flatMap((group) => group.roles.map((role) => role.jobId))).toEqual(['paid']);
  });
  it('filters groups and details by discipline alias, season, work mode, education, and pay', () => {
    const base = identity();
    const softwareIdentity = {
      ...base,
      disciplines: [{ value: 'software' as const, provenance: base.title.official.provenance }],
    };
    const mlIdentity = {
      ...base,
      season: { term: 'fall' as const, year: 2026, evidenceStatus: 'explicit' as const, provenance: base.season.provenance },
      disciplines: [{ value: 'ai-ml' as const, provenance: base.title.official.provenance }],
    };
    const groups = groupCatalogJobs([
      job('swe', 0, { location: 'Remote', compensation: { raw: '$50/hr' }, internshipIdentity: softwareIdentity }),
      job('ml', 10, { location: 'Onsite in New York, NY', internshipIdentity: mlIdentity }),
    ]);
    const jobsOf = (filtered: typeof groups) => filtered.flatMap((group) => group.jobs.map((item) => item.jobId));
    expect(jobsOf(filterCatalogGroups(groups, { disciplines: ['SWE'] }))).toEqual(['swe']);
    expect(jobsOf(filterCatalogGroups(groups, { seasons: ['fall-2026'] }))).toEqual(['ml']);
    expect(jobsOf(filterCatalogGroups(groups, { workModes: ['onsite'] }))).toEqual(['ml']);
    expect(jobsOf(filterCatalogGroups(groups, { educationLevels: ['undergraduate'] }))).toEqual(['ml', 'swe']);
    expect(jobsOf(filterCatalogGroups(groups, { educationLevels: ['masters'] }))).toEqual([]);
    expect(jobsOf(filterCatalogGroups(groups, { hasCompensation: true }))).toEqual(['swe']);
    const rolesOf = filterCatalogGroupDetails(groups.map(catalogGroupDetails), { disciplines: ['software'] })
      .flatMap((group) => group.roles.map((role) => role.jobId));
    expect(rolesOf).toEqual(['swe']);
  });
});
