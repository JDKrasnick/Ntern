import { describe, expect, it } from 'vitest';
import {
  applicationMetadataArtifactsFromJsonDocuments,
  compensationFromRanges,
  extractCompensationRanges,
  extractHousingDetails,
  extractPostingMetadataEvidence,
  extractRoleMetadataEvidence,
  extractVerifiedPageMetadataEvidence,
  projectRoleMetadata,
  reconcileRoleMetadata,
  ROLE_METADATA_EXTRACTION_VERSION,
} from '../src/role-metadata.js';
import type { EducationLevel, FieldProvenance, Internship, RoleMetadataEvidence } from '../src/types.js';

const observedAt = '2026-09-04T12:00:00.000Z';
const field: FieldProvenance = {
  source: 'official-page', sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs/123',
  evidenceCode: 'compensation-range', contentHash: 'artifact', observedAt,
};

function evidence(overrides: Partial<RoleMetadataEvidence>): RoleMetadataEvidence {
  return {
    schemaVersion: 1, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, artifactHash: 'artifact', sourceClass: 'official-page',
    sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs/123', observedAt, exactPosting: true,
    ...overrides,
  };
}

function job(overrides: Partial<Internship> = {}): Internship {
  return {
    jobId: 'job-1', company: 'Acme', title: 'PhD Machine Learning Intern — Remote', location: 'Location not specified',
    season: 'summer-2027', applyUrl: 'https://careers.acme.test/jobs/123', normalizedUrl: 'https://careers.acme.test/jobs/123',
    fingerprint: 'fingerprint', compensation: { raw: '' }, sourceReferences: [], open: true,
    firstSeenAt: observedAt, lastSeenAt: observedAt, notification: { smsPending: false, digestPending: false }, ...overrides,
  };
}

describe('provider-neutral role metadata', () => {
  it('retains explicit housing cadence without inventing an amount or borrowing salary cadence', () => {
    expect(extractHousingDetails('Monthly housing stipend', { provenance: field })).toEqual([
      { kind: 'stipend', period: 'monthly', sourceText: 'Monthly housing stipend', provenance: [field] },
    ]);
    expect(extractHousingDetails('Weekly allowance for accommodation', { provenance: field })[0])
      .toMatchObject({ kind: 'stipend', period: 'weekly' });
    for (const text of ['Monthly salary and housing stipend', 'Housing stipend with monthly meals',
      'Monthly housing stipend or weekly housing allowance']) {
      expect(extractHousingDetails(text, { provenance: field })[0]?.period).toBeUndefined();
    }
    expect(extractHousingDetails('No monthly housing stipend', { provenance: field })).toEqual([]);
  });

  it('treats a starting-rate qualifier as an amount qualifier, not a distinct audience', () => {
    const official = evidence({ compensationRanges: extractCompensationRanges(
      'The minimum annualized base salary starts at $145,000.', { provenance: field },
    ) });
    const community = evidence({ sourceClass: 'reviewed-community', artifactHash: 'community', sourceId: 'community',
      compensationRanges: extractCompensationRanges('USD $75/hour', { provenance: { ...field, source: 'reviewed-community' } }) });
    expect(official.compensationRanges).toMatchObject([{ minAmount: 145000, period: 'annual', applicabilityLabel: 'Starting rate (lower bound)' }]);
    expect(reconcileRoleMetadata([community, official]).compensation?.ranges).toMatchObject([
      { minAmount: 145000, period: 'annual' },
    ]);
    expect(reconcileRoleMetadata([community, official]).compensation?.ranges).toHaveLength(1);

    const regional = { ...official.compensationRanges![0]!, applicabilityLabel: 'New York candidates' };
    const degree = { ...official.compensationRanges![0]!, applicabilityLabel: undefined, applicableEducationLevels: ['doctoral'] as EducationLevel[] };
    expect(reconcileRoleMetadata([community, evidence({ compensationRanges: [regional] })]).compensation?.ranges).toHaveLength(2);
    expect(reconcileRoleMetadata([community, evidence({ compensationRanges: [degree] })]).compensation?.ranges).toHaveLength(2);
  });

  it('extracts explicit matching ISO currencies between labeled range endpoints', () => {
    expect(extractCompensationRanges('The hourly rate for our interns is 38 USD - 94 USD.', { provenance: field }))
      .toMatchObject([{ minAmount: 38, maxAmount: 94, currency: 'USD', period: 'hourly' }]);
    expect(extractCompensationRanges('Hourly rate: 38 USD - 94 CAD.', { provenance: field })).toEqual([]);
    expect(extractCompensationRanges('Hourly rate for New York interns is 38 USD - 94 USD.', {
      provenance: field, knownLocations: ['New York'],
    })).toMatchObject([{ minAmount: 38, maxAmount: 94, currency: 'USD', period: 'hourly', applicableLocations: ['New York'] }]);
    expect(extractCompensationRanges('Hourly rate: 38 USD. Housing stipend: 94 USD.', { provenance: field }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 38, maxAmount: 94 })]));
    const tiers = extractCompensationRanges(
      'Undergraduate hourly rate: 38 USD - 44 USD; PhD hourly rate: 70 USD - 94 USD.',
      { provenance: field },
    );
    expect(tiers).toHaveLength(2);
    expect(tiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 38, maxAmount: 44, currency: 'USD', period: 'hourly', applicableEducationLevels: ['undergraduate'] }),
      expect.objectContaining({ minAmount: 70, maxAmount: 94, currency: 'USD', period: 'hourly', applicableEducationLevels: ['doctoral'] }),
    ]));
  });

  it('retains the overseas eligibility condition without inventing accommodation costs', () => {
    const sentence = 'Flight and accommodation will be provided to all successful overseas applicants.';
    expect(extractHousingDetails(sentence, { provenance: field })).toEqual([
      { kind: 'available', conditional: true, sourceText: sentence, provenance: [field] },
    ]);
  });

  it('does not restore superseded community pay when official sources conflict', () => {
    const community = evidence({ sourceClass: 'reviewed-community', artifactHash: 'community', sourceId: 'community',
      compensationRanges: extractCompensationRanges('USD $60/hour', { provenance: { ...field, source: 'reviewed-community' } }) });
    const accepted = projectRoleMetadata(job(), [community]).job;
    const official = [40, 50].map(amount => evidence({ artifactHash: `official-${amount}`, sourceId: `official-${amount}`,
      compensationRanges: extractCompensationRanges(`USD $${amount}/hour`, { provenance: field }) }));
    for (const items of [[community, ...official], [...official].reverse(), [...official, community]]) {
      const reconciled = reconcileRoleMetadata(items, accepted);
      expect(reconciled.compensation).toBeUndefined();
      expect(reconciled.conflicts).toHaveLength(1);
      expect(reconciled.conflicts[0]?.field).toBe('compensation');
      const projected = projectRoleMetadata(accepted, items);
      expect(projected.job.compensation).toEqual({ raw: '' });
      expect(projected.job.roleMetadata?.compensationRanges).toBeUndefined();
      expect(projected.conflicts).toEqual(reconciled.conflicts);
    }
    // Community-only conflicts still retain their accepted fallback.
    const otherCommunity = evidence({ ...community, artifactHash: 'other-community', sourceId: 'other-community',
      compensationRanges: extractCompensationRanges('USD $70/hour', { provenance: { ...field, source: 'reviewed-community' } }) });
    expect(projectRoleMetadata(accepted, [community, otherCommunity]).job.compensation).toEqual(accepted.compensation);
  });

  it('retains housing eligibility for interns who are not fully remote without ignoring benefit denials', () => {
    const sentence = 'Interns who are not working 100% remote may also be eligible for housing allowance.';
    expect(extractHousingDetails(sentence, { provenance: field })).toEqual([
      { kind: 'stipend', conditional: true, sourceText: sentence, provenance: [field] },
    ]);
    expect(extractHousingDetails('Interns who are not working 100% remote are not eligible for housing allowance.', { provenance: field })).toEqual([]);
    expect(extractHousingDetails('No housing allowance is provided.', { provenance: field })).toEqual([]);
  });

  it.each([
    ['The hourly rate range for this position in the selected city is $42.75- $42.75.', 42.75, 42.75, 'hourly'],
    ['The hourly rate range for this position in the selected city is $45- $60.', 45, 60, 'hourly'],
    ['The estimated base salary for this role is $250,000 per year.', 250000, 250000, 'annual'],
  ] as const)('uses official pay rather than a community amount in different units: %s', (text, minAmount, maxAmount, period) => {
    const official = evidence({ compensationRanges: extractCompensationRanges(text, { provenance: field }) });
    const community = evidence({ sourceClass: 'reviewed-community', sourceId: 'community-list', artifactHash: 'community',
      compensationRanges: extractCompensationRanges('USD $60/hour', { provenance: { ...field, source: 'reviewed-community' } }) });
    for (const items of [[official, community], [community, official]]) {
      const result = reconcileRoleMetadata(items);
      expect(result.conflicts).toEqual([]);
      expect(result.compensation?.ranges).toMatchObject([{ minAmount, maxAmount, period, currency: 'XXX' }]);
      expect(result.compensation?.ranges).toHaveLength(1);
      expect(result.compensation?.minHourlyUSD).toBeUndefined();
    }
    expect(community.compensationRanges).toHaveLength(1); // Preserve source evidence.
  });

  it('preserves distinct community audiences and all employer periods', () => {
    const official = evidence({ compensationRanges: extractCompensationRanges('USD $40/hour; USD $90000/year', { provenance: field }) });
    const communityRange = extractCompensationRanges('USD $60/hour', { provenance: { ...field, source: 'reviewed-community' } })[0]!;
    const community = evidence({ sourceClass: 'reviewed-community', compensationRanges: [
      { ...communityRange, applicableLocations: ['New York, NY'] },
      { ...communityRange, applicableEducationLevels: ['doctoral'] },
      { ...communityRange, applicabilityLabel: 'Returning interns' },
    ] });
    const result = reconcileRoleMetadata([official, community]);
    expect(result.conflicts).toEqual([]);
    expect(result.compensation?.ranges).toHaveLength(5);
    expect(result.compensation?.ranges?.filter(range => range.minAmount === 60)).toHaveLength(3);
  });

  it('does not use an unknown official period or outdated evidence to displace community pay', () => {
    const official = evidence({ compensationRanges: extractCompensationRanges('Base salary USD $90000', { provenance: field }) });
    const community = evidence({ sourceClass: 'reviewed-community', compensationRanges: extractCompensationRanges('USD $60/hour', {
      provenance: { ...field, source: 'reviewed-community' },
    }) });
    expect(reconcileRoleMetadata([official, community]).compensation?.ranges).toHaveLength(2);
    const stale = { ...official, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 };
    expect(reconcileRoleMetadata([stale, community]).compensation?.ranges).toMatchObject([{ minAmount: 60, currency: 'USD' }]);
  });

  it('retains accepted metadata while a contributing source awaits re-extraction', () => {
    const pay = evidence({ compensationRanges: extractCompensationRanges('USD $60/hour', { provenance: field }),
      housing: extractHousingDetails('USD $900 monthly housing stipend.', { provenance: field }),
      workMode: { value: 'remote', provenance: [field] } });
    const accepted = projectRoleMetadata(job(), [pay]).job;
    const stale = { ...pay, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1 };
    const prior = { ...accepted, roleMetadata: { ...accepted.roleMetadata!, extractionVersion: stale.extractionVersion } };
    const otherSource = evidence({ sourceId: 'other-source', artifactHash: 'other',
      workMode: { value: 'hybrid', provenance: [{ ...field, sourceId: 'other-source', contentHash: 'other' }] } });
    expect(projectRoleMetadata(prior, [stale, otherSource]).job).toEqual(prior);
    // A successful empty refresh of the pay source really can withdraw pay.
    const withdrawn = projectRoleMetadata(prior, [evidence({}), otherSource]).job;
    expect(withdrawn.compensation).toEqual({ raw: '' });
    expect(withdrawn.housing).toBeUndefined();
    expect(withdrawn.workMode).toBe('hybrid');
    expect(withdrawn.roleMetadata?.extractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
    expect(withdrawn.notification).toEqual(prior.notification);
    expect(projectRoleMetadata(prior, [otherSource]).job.compensation).toEqual({ raw: '' });
  });

  it('does not promote unaccepted stale evidence or let it block a current projection', () => {
    const stale = evidence({ extractionVersion: ROLE_METADATA_EXTRACTION_VERSION - 1,
      compensationRanges: extractCompensationRanges('USD $60/hour', { provenance: field }) });
    const current = evidence({ artifactHash: 'current', sourceId: 'current', workMode: { value: 'remote', provenance: [field] } });
    const projected = projectRoleMetadata(job(), [stale, current]).job;
    expect(projected.compensation).toEqual({ raw: '' });
    expect(projected.workMode).toBe('remote');
    expect(projected.roleMetadata?.evidenceHashes).toEqual(['current']);
    expect(projectRoleMetadata(projected, [stale, current]).job).toEqual(projected);
  });

  it('keeps a full-time salary reference separate from the internship offer', () => {
    const ranges = extractCompensationRanges('Salary=$75,000\nPrimary Location Full Time Salary Range:\n$60,000.00 - $110,000.00', { provenance: field });
    expect(ranges).toHaveLength(2);
    expect(ranges.find(item => item.minAmount === 60000)).toMatchObject({ applicabilityLabel: 'Primary Location Full Time Salary Range', period: 'unknown' });
    expect(reconcileRoleMetadata([evidence({ compensationRanges: ranges })]).conflicts).toEqual([]);
  });
  it.each([
    ['Minimum Pay: $30\nMaximum Pay : $35', 30, 35, 'XXX'],
    ['Pay Range - Start:\n$16.50\nPay Range - End:\n$30.00', 16.5, 30, 'XXX'],
    ['The salary range for this role is $39,108 through $111,111.', 39108, 111111, 'XXX'],
    ['The salary range is expected to be between $ 52,650 US D to $70,200 US D .', 52650, 70200, 'USD'],
  ])('preserves Workday template endpoints without assuming annual units: %s', (text, minAmount, maxAmount, currency) => {
    const ranges = extractCompensationRanges(text, { provenance: field });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ minAmount, maxAmount, currency, period: 'unknown' });
  });
  it('keeps explicit starting rates and regional pay labels out of global bounds', () => {
    const ranges = extractCompensationRanges('Our intern compensation starts at $23/hr.\nHourly Rate: $20-28', { provenance: field });
    expect(ranges[0]?.applicabilityLabel).toBe('Starting rate (lower bound)');
    expect(reconcileRoleMetadata([evidence({ compensationRanges: ranges })]).conflicts).toEqual([]);
    const regional = extractCompensationRanges('The approximate pay range for Washington is $71,233.98 - $106,850.97.', { provenance: field });
    expect(regional[0]?.applicabilityLabel).toBe('Washington');
  });
  it('combines only adjacent matching minimum/maximum salary fields without inferring annual pay', () => {
    const ranges = extractCompensationRanges('Salary / Rate Minimum: $105,000\nSalary / Rate Maximum: $110,000', { provenance: field });
    expect(ranges).toMatchObject([{ minAmount: 105000, maxAmount: 110000, currency: 'XXX', period: 'unknown' }]);
    expect(ranges).toHaveLength(1);
    expect(extractCompensationRanges('Salary / Rate Minimum: USD $105,000\nSalary / Rate Maximum: CAD $110,000', { provenance: field }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 105000, maxAmount: 110000 })]));
  });
  it.each([
    ['USD $2,500 per month housing stipend.', 'stipend', 2500, 'USD', 'monthly'],
    ['Housing costs EUR €400–600 per month.', 'employee-cost', 400, 'EUR', 'monthly'],
    ['Interns pay rent: $200 per week.', 'employee-cost', 200, 'XXX', 'weekly'],
    ['Free housing is provided.', 'employer-paid', undefined, undefined, undefined],
    ['Housing is provided at no cost.', 'employer-paid', undefined, undefined, undefined],
    ['Housing is available.', 'available', undefined, undefined, undefined],
    ['Housing costs are fully covered by the company.', 'employer-paid', undefined, undefined, undefined],
  ])('extracts only explicitly disclosed housing: %s', (text, kind, minAmount, currency, period) => {
    const details = extractHousingDetails(text, { provenance: field });
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ kind, sourceText: text, provenance: [field] });
    expect(details[0]?.minAmount).toBe(minAmount);
    expect(details[0]?.currency).toBe(currency);
    expect(details[0]?.period).toBe(period);
  });

  it.each(['No housing stipend is provided.', 'Housing is not provided.', 'We cannot offer housing.',
    'Reasonable accommodation is available for interviews.', 'Our software helps tenants pay rent.',
    'Relocation assistance covers housing costs.', 'Free meals and housing are available.',
    'We offer housing and relocation support.', 'Housing: Financial support and help securing housing is available.'])('does not invent a housing benefit or employee cost: %s', text => {
    expect(extractHousingDetails(text, { provenance: field })).toEqual([]);
  });

  it('keeps housing, salary and meal amounts separate and preserves uncertain benefit wording', () => {
    const [extracted] = extractPostingMetadataEvidence({ artifact: { title: 'Software Engineering Intern', text:
      'USD $8,500 monthly salary\nUSD $2,500 monthly stipend for housing\nUSD $70 per diem for meals' },
      sourceClass: 'official-page', sourceId: field.sourceId, sourceUrl: field.sourceUrl!, observedAt, exactPosting: true });
    expect(extracted?.compensationRanges?.map(range => range.minAmount)).toEqual([8500]);
    expect(extracted?.housing).toMatchObject([{ kind: 'stipend', minAmount: 2500, period: 'monthly' }]);
    const [conditional] = extractHousingDetails('Eligible interns may receive up to USD $2,500 for a housing stipend, depending on location.', { provenance: field });
    expect(conditional).toMatchObject({ kind: 'stipend', conditional: true });
    expect(conditional?.minAmount).toBeUndefined();
    expect(conditional?.sourceText).toContain('up to USD $2,500');
    expect(extractHousingDetails('USD $1,000 for a housing and relocation allowance.', { provenance: field })[0]?.minAmount).toBeUndefined();
  });

  it('does not attribute adjacent Ashby pay bands to housing eligibility', () => {
    const details = extractHousingDetails('$47 – $51 • Eligible for housing stipend\n$40 – $45 • Eligible for housing stipend', { provenance: field });
    expect(details).toEqual([{ kind: 'stipend', conditional: true, sourceText: 'Eligible for housing stipend', provenance: [field] }]);
    expect(extractHousingDetails('$47–$51 | Eligible for housing stipend', { provenance: field })[0]?.minAmount).toBeUndefined();
    expect(extractHousingDetails('Hourly wages of $47–$51 and eligible for housing stipend', { provenance: field })[0]?.minAmount).toBeUndefined();
    expect(extractHousingDetails('$47/hour plus a housing stipend', { provenance: field })[0]?.minAmount).toBeUndefined();
    expect(extractHousingDetails('USD $2500 housing and travel stipend', { provenance: field })[0]?.minAmount).toBeUndefined();
    expect(extractHousingDetails('Housing stipend for interns relocating to the area', { provenance: field })[0]?.conditional).toBe(true);
    expect(extractHousingDetails('All co-ops that qualify for housing assistance receive a one-time stipend.', { provenance: field })[0]?.conditional).toBe(true);
  });

  it('reconciles housing conflicts and withdrawals without changing lifecycle or notifications', () => {
    const original = job();
    const first = evidence({ housing: extractHousingDetails('USD $500 monthly housing stipend.', { provenance: field }) });
    const second = evidence({ artifactHash: 'other', housing: extractHousingDetails('USD $900 monthly housing stipend.', { provenance: field }) });
    const accepted = projectRoleMetadata(original, [first]).job;
    expect(accepted.housing?.[0]?.minAmount).toBe(500);
    const conflicted = projectRoleMetadata(accepted, [first, second]);
    expect(conflicted.conflicts).toMatchObject([{ field: 'housing', applicabilityKey: 'stipend' }]);
    expect(conflicted.job.housing).toEqual(accepted.housing);
    expect(projectRoleMetadata(conflicted.job, [second]).job.housing?.[0]?.minAmount).toBe(900);
    const withdrawn = projectRoleMetadata(accepted, []).job;
    expect(withdrawn.housing).toBeUndefined();
    expect(withdrawn.open).toBe(original.open);
    expect(withdrawn.notification).toEqual(original.notification);
  });
  it.each([
    ['999', false], ['123', true], [undefined, true],
  ])('checks singleton JSON-LD identifier %s before projecting pay', (identifier, accepted) => {
    const original = job({ title: 'Software Engineering Intern' });
    const extracted = extractVerifiedPageMetadataEvidence({
      expectedTitle: original.title, expectedPostingId: '123', page: { title: original.title },
      jsonLdArtifacts: [{ title: original.title, identifier, compensationText: 'USD $99/hour' }],
      sourceId: 'community-acme', sourceUrl: original.applyUrl, observedAt, exactPosting: true,
    });
    expect(projectRoleMetadata(original, extracted).job.compensation.maxHourlyUSD).toBe(accepted ? 99 : undefined);
  });

  it.each([
    ['New York, NY'], ['Toronto, ON'],
  ])('does not use the explicit page location %s to infer dollar currency', (location) => {
    const original = job({ title: 'Software Engineering Intern' });
    const extracted = extractVerifiedPageMetadataEvidence({
      expectedTitle: original.title, page: { title: original.title,
        text: `Location: ${location}. The pay range is $40-$50/hour.` },
      sourceId: 'community-acme', sourceUrl: original.applyUrl, observedAt, exactPosting: true,
    });
    expect(extracted[0]?.compensationRanges?.[0]?.currency).toBe('XXX');
    const projected = projectRoleMetadata(original, extracted).job;
    expect(projected.locations).toEqual([location]);
    expect(projected.compensation.maxHourlyUSD).toBeUndefined();
  });

  it('preserves accepted scalars through conflict, resolution, and withdrawal', () => {
    const original = job({ title: 'Software Engineering Intern' });
    const facts = (sourceId: string, changed: boolean) => extractPostingMetadataEvidence({
      artifact: { title: original.title, workMode: changed ? 'hybrid' : 'remote',
        deadline: changed ? '2026-11-01' : '2026-10-01',
        publishedAt: changed ? '2026-08-02' : '2026-08-01',
        updatedAt: changed ? '2026-09-02' : '2026-09-01' },
      sourceClass: 'official-page', sourceId, sourceUrl: original.applyUrl, observedAt, exactPosting: true,
    });
    const first = facts('one', false); const second = facts('two', true);
    const accepted = projectRoleMetadata(original, first).job;
    const conflicted = projectRoleMetadata(accepted, [...first, ...second]);
    expect(conflicted.conflicts).toHaveLength(4);
    for (const key of ['workMode', 'applicationDeadline', 'employerPublishedAt', 'employerUpdatedAt'] as const) {
      expect(conflicted.job[key]).toEqual(accepted[key]);
      expect(conflicted.job.roleMetadata?.[key]).toEqual(accepted.roleMetadata?.[key]);
    }
    expect(projectRoleMetadata(conflicted.job, [...second, ...first]).job).toEqual(conflicted.job);
    const resolved = projectRoleMetadata(conflicted.job, second);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.job).toMatchObject({ workMode: 'hybrid', applicationDeadline: { date: '2026-11-01' },
      employerPublishedAt: '2026-08-02T00:00:00.000Z', employerUpdatedAt: '2026-09-02T00:00:00.000Z' });
    for (const prior of [conflicted.job, resolved.job]) {
      const withdrawn = projectRoleMetadata(prior, []).job;
      for (const key of ['workMode', 'applicationDeadline', 'employerPublishedAt', 'employerUpdatedAt', 'roleMetadata'] as const) {
        expect(withdrawn[key]).toBeUndefined();
      }
      expect(withdrawn.notification).toEqual(original.notification);
    }
  });

  it('keeps differently applicable USD ranges separate without global extrema', () => {
    const ranges = extractCompensationRanges(
      'San Francisco, CA: $45-$55/hour; New York, NY: $50-$60/hour',
      { provenance: field, knownLocations: ['San Francisco, CA', 'New York, NY'] },
    );
    expect(ranges).toHaveLength(2);
    expect(ranges.map((range) => range.applicableLocations)).toEqual([['New York, NY'], ['San Francisco, CA']]);
    const compensation = compensationFromRanges(ranges);
    expect(compensation.ranges).toHaveLength(2);
    expect(compensation.minHourlyUSD).toBeUndefined();
    expect(compensation.maxHourlyUSD).toBeUndefined();
  });

  it('projects legacy bounds only from one unambiguous global USD range', () => {
    const ranges = extractCompensationRanges('The base pay range is USD $90,000-$120,000 per year.', { provenance: field });
    expect(compensationFromRanges(ranges)).toMatchObject({ minAnnualUSD: 90_000, maxAnnualUSD: 120_000 });
  });

  it('does not mistake compensation headings for location applicability', () => {
    const hourly = extractCompensationRanges('The pay range is: USD $40-$50/hour.', {
      provenance: field, knownLocations: ['New York, NY'],
    });
    const annual = extractCompensationRanges('Base salary: USD $100,000-$120,000/year.', {
      provenance: field, knownLocations: ['New York, NY'],
    });
    const locationSpecific = extractCompensationRanges('New York, NY: $45-$55/hour.', {
      provenance: field, knownLocations: ['New York, NY'],
    });
    expect(compensationFromRanges(hourly)).toMatchObject({ minHourlyUSD: 40, maxHourlyUSD: 50 });
    expect(compensationFromRanges(annual)).toMatchObject({ minAnnualUSD: 100_000, maxAnnualUSD: 120_000 });
    expect(locationSpecific).toMatchObject([{ applicableLocations: ['New York, NY'] }]);
    expect(compensationFromRanges(locationSpecific).minHourlyUSD).toBeUndefined();
  });

  it('keeps a repeated-period pay expression as one range', () => {
    expect(extractCompensationRanges('The market range is USD $40/hour - $85/hour.', { provenance: field }))
      .toMatchObject([{ minAmount: 40, maxAmount: 85, currency: 'USD', period: 'hourly' }]);
  });

  it('excludes Varda cell-phone reimbursement while retaining the adjacent hourly rate', () => {
    const ranges = extractCompensationRanges(
      'Hourly Rate: USD $33.00/hour $20/pay period cell phone reimbursement',
      { provenance: field, requirePayContext: true, knownLocations: ['United States'] },
    );
    expect(ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 33, maxAmount: 33, currency: 'USD', period: 'hourly' }),
    ]));
    expect(ranges).not.toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 20, maxAmount: 20 })]));
  });

  it.each([
    'Hourly Rate: $33/hour; $20/pay period cell phone reimbursement',
    'Hourly Rate: $33/hour. Cell phone reimbursement: $20 per pay period.',
    'Hourly Rate: $33/hour $20 reimbursement for mobile phone expenses',
    'Cell phone reimbursement: $20 per pay period and salary: $33/hour',
    'Salary: $33/hour and cell phone reimbursement: $20 per pay period',
    'Salary: $33/hour plus reimbursement for phone expenses',
    'Hourly Rate: $33.00\n$20/pay period cell phone reimbursement',
  ])('keeps genuine adjacent wages for nearby reimbursement wording: %s', text => {
    const ranges = extractCompensationRanges(text, { provenance: field, requirePayContext: true, knownLocations: ['United States'] });
    expect(ranges).toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 33, period: 'hourly' })]));
    expect(ranges).not.toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 20 })]));
  });

  it.each([
    'USD $20/pay period cell phone reimbursement and salary: $33/hour',
    'Salary: $33/hour plus USD $20/pay period cell phone reimbursement and salary: $40/hour for graduates',
  ])('does not let a reimbursement tail hide a later salary clause: %s', text => {
    const ranges = extractCompensationRanges(text, { provenance: field, requirePayContext: true, knownLocations: ['United States'] });
    expect(ranges.filter(range => range.minAmount === 20)).toEqual([]);
    expect(ranges).toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 33, period: 'hourly' })]));
    if (text.includes('$40/hour')) expect(ranges).toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 40, period: 'hourly' })]));
  });

  it('does not exclude a genuine pay-period wage merely because the period is named', () => {
    expect(extractCompensationRanges('Pay: $20 per pay period.', { provenance: field, requirePayContext: true }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 20, period: 'unknown' })]));
  });

  it('deduplicates repeated between endpoints and preserves explicit trailing currencies', () => {
    expect(extractCompensationRanges('The expected pay range is between $23.50 per hour and $52.50 per hour.', { provenance: field, requirePayContext: true }))
      .toMatchObject([{ minAmount: 23.5, maxAmount: 52.5, period: 'hourly' }]);
    expect(extractCompensationRanges('The salary range is $52,650 CAD to $70,200 CAD.', { provenance: field, requirePayContext: true }))
      .toMatchObject([{ minAmount: 52650, maxAmount: 70200, currency: 'CAD', period: 'unknown' }]);
  });

  it('binds inline degree tiers individually without inferring an unstated period', () => {
    const ranges = extractCompensationRanges('Compensation Range: The annual base salary range is $41/hr for Undergrad, $53/hr for Graduate students, and $58 for PhD students*.', {
      provenance: field, requirePayContext: true, knownLocations: ['United States'],
    });
    expect(ranges).toHaveLength(3);
    expect(ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 41, maxAmount: 41, period: 'hourly', applicableEducationLevels: ['undergraduate'] }),
      expect.objectContaining({ minAmount: 53, maxAmount: 53, period: 'hourly', applicabilityLabel: 'Graduate students' }),
      expect.objectContaining({ minAmount: 58, maxAmount: 58, period: 'unknown', applicabilityLabel: 'PhD students', applicableEducationLevels: ['doctoral'] }),
    ]));
    expect(compensationFromRanges(ranges).minHourlyUSD).toBeUndefined();
    expect(extractCompensationRanges('Salary: $47/hr for Undergrad and $53/hr for Graduate students', { provenance: field, requirePayContext: true })).toHaveLength(2);
  });

  it('does not leak a pay heading through unrelated paragraphs or into benefits', () => {
    for (const text of [
      'Compensation\nAbout us\nOur products cost $40/hour',
      'Compensation\nLunch allowance: $20 per day',
      'Compensation\nRelocation stipend: $5000',
      'Compensation\nSalary expectations: $50/hour',
    ]) expect(extractCompensationRanges(text, { provenance: field, requirePayContext: true })).toEqual([]);
  });

  it('limits new pay-table scopes to explicit amount rows', () => {
    const input = { provenance: field, requirePayContext: true, knownLocations: ['New York City, New York'] };
    const senior = extractCompensationRanges('Senior Software Engineer salary: $50/hour', input);
    expect(senior).toHaveLength(1);
    expect(senior[0]?.applicabilityLabel).not.toBe('Senior');
    const regional = extractCompensationRanges('Pay Range\nYork, Pennsylvania | ($30 - $40 Hourly)', input);
    expect(regional).toHaveLength(1);
    expect(regional[0]?.applicableLocations).toEqual(['York, Pennsylvania']);
    for (const text of [
      'Pay Scale\nFreshman tuition reimbursement: $1000',
      'Pay Scale\nSenior relocation stipend: $5000',
      'About the office\nAustin, Texas | ($28 - $49 Hourly)',
    ]) expect(extractCompensationRanges(text, input)).toEqual([]);
  });

  it.each([' ', '\n'])('joins explicit min/max salary fields and their table-scoped hourly unit (%j)', (separator) => {
    const text = `Minimum Salary${separator}$28.25\nMaximum Salary${separator}$31.50\nLine of Business Health and Wellness\nBanner Name King Soopers\nEducation Level Bachelor’s degree\nRequired License and Certification Pharmacy Board License\nHourly or Salaried${separator}Hourly\nApply Now`;
    expect(extractCompensationRanges(text, { provenance: field, requirePayContext: true }))
      .toMatchObject([{ minAmount: 28.25, maxAmount: 31.5, currency: 'XXX', period: 'hourly' }]);
  });

  it('joins a table whose Min/Max labels sit above their values, in either word order', () => {
    // Cooper Health publishes its iCIMS fact table as a label line above the
    // value, so segmentation on newlines made the two ends of one range look
    // like two competing point values.
    const icims = 'Salary Min ($)\nUSD $25.00\nSalary Max ($)\nUSD $42.50';
    expect(extractCompensationRanges(icims, { provenance: field, requirePayContext: true }))
      .toMatchObject([{ minAmount: 25, maxAmount: 42.5, currency: 'USD', period: 'unknown' }]);
    // The same table without a parseable currency code on both ends stays apart.
    const mixed = extractCompensationRanges('Salary Min ($)\nUSD $25.00\nSalary Max ($)\nCAD $42.50', { provenance: field, requirePayContext: true });
    expect(mixed).not.toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 25, maxAmount: 42.5 })]));
    // A numeric-only pair still joins and keeps its unknown period.
    expect(extractCompensationRanges('Pay Minimum\n$19.73\nPay Maximum\n$33.05', { provenance: field, requirePayContext: true }))
      .toMatchObject([{ minAmount: 19.73, maxAmount: 33.05, currency: 'XXX', period: 'unknown' }]);
    // An explicit currency code on both ends joins too. The alternation was
    // grouped so `\s*` applied to every code, not only the last one, which had
    // silently split these pairs into two competing point values.
    expect(extractCompensationRanges('Minimum Salary USD $28.25\nMaximum Salary USD $31.50', { provenance: field, requirePayContext: true }))
      .toMatchObject([{ minAmount: 28.25, maxAmount: 31.5, currency: 'USD', period: 'unknown' }]);
    expect(extractCompensationRanges('Salary / Rate Minimum: USD $105,000\nSalary / Rate Maximum: USD $110,000', { provenance: field }))
      .toMatchObject([{ minAmount: 105000, maxAmount: 110000, currency: 'USD', period: 'unknown' }]);
    // Differing codes still stay apart: both ends must state the same notation.
    expect(extractCompensationRanges('Minimum Salary USD $28.25\nMaximum Salary CAD $31.50', { provenance: field, requirePayContext: true }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ minAmount: 28.25, maxAmount: 31.5 })]));
  });
  it('does not borrow cadence or merge incompatible salary endpoints', () => {
    const input = { provenance: field, requirePayContext: true };
    for (const tail of [
      '', '\nHourly or Salaried Salaried',
      '\nOther jobs\nHourly or Salaried Hourly',
      '\nEducation Level tuition costs $500\nHourly or Salaried Hourly',
      '\nThis role may be hourly\nHourly or Salaried Hourly',
    ]) {
      expect(extractCompensationRanges(`Minimum Salary $28.25\nMaximum Salary $31.50${tail}`, input))
        .toMatchObject([{ minAmount: 28.25, maxAmount: 31.5, currency: 'XXX', period: 'unknown' }]);
    }
    const differentCurrencies = extractCompensationRanges('Minimum Salary USD $28.25\nMaximum Salary CAD $31.50\nHourly or Salaried Hourly', input);
    expect(differentCurrencies.some(range => range.minAmount !== range.maxAmount)).toBe(false);
    expect(extractCompensationRanges('Minimum Salary $28.25\nRelocation stipend $2000\nMaximum Salary $31.50', input)
      .some(range => range.minAmount === 28.25 && range.maxAmount === 31.5)).toBe(false);
  });

  it('keeps malformed thousands separators and between amounts as full ranges', () => {
    expect(extractCompensationRanges('The estimated salary range is $ 95 ,000-$120 ,000, dependent on academic level (Bachelors, Masters, or PhD).', { provenance: field, requirePayContext: true }))
      .toMatchObject([{ minAmount: 95000, maxAmount: 120000, period: 'unknown' }]);
    expect(extractCompensationRanges('The base salary is anticipated to be between $150,000 and $200,000.', { provenance: field, requirePayContext: true }))
      .toMatchObject([{ minAmount: 150000, maxAmount: 200000, period: 'unknown' }]);
  });

  it('retains regional exceptions and publisher MIN/MAX notation', () => {
    const ranges = extractCompensationRanges('The salary range for this role in California, Massachusetts, New Jersey, Washington, and the Greater D.C. area, Denver, or NYC areas is [$29.00 MIN -$53.50 MAX]. The salary range for this role in Colorado state, Hawaii, Illinois, Maryland, Minnesota, New York state, Cleveland Ohio, Vermont and Virginia is [$24.50 MIN -$46.50 MAX].', {
      provenance: field, requirePayContext: true, knownLocations: ['United States'],
    });
    expect(ranges).toHaveLength(2);
    expect(ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 29, maxAmount: 53.5, period: 'unknown', applicabilityLabel: expect.stringContaining('California') }),
      expect.objectContaining({ minAmount: 24.5, maxAmount: 46.5, period: 'unknown', applicabilityLabel: expect.stringContaining('Colorado state') }),
    ]));
    expect(ranges.every(r=>!r.applicableLocations?.length)).toBe(true);
    const microsoft = extractCompensationRanges('The base pay range for this internship is USD $5,690.00 - $11,210.00 per month. There is a different range applicable to specific work locations, within the San Francisco Bay area and New York City metropolitan area, and the base pay range for this role in those locations is USD $7,410.00 - $12,250.00 per month.', {
      provenance: field, requirePayContext: true,
    });
    expect(microsoft).toHaveLength(2);
    expect(microsoft).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 5690, maxAmount: 11210, period: 'monthly' }),
      expect.objectContaining({ minAmount: 7410, maxAmount: 12250, period: 'monthly', applicabilityLabel: 'the San Francisco Bay area and New York City metropolitan area' }),
    ]));
  });

  it('binds graduation dates to the graduation clause and does not treat pursuing a degree as a completed minimum', () => {
    const [item] = extractPostingMetadataEvidence({
      artifact: { title: 'Engineering Intern', text: 'Applications close 11 Nov 2026. Required Qualifications: Working toward a bachelor’s or master’s degree with an anticipated graduation date of Winter 2027, Spring 2028, Winter 2028, or Spring 2029.' },
      sourceClass: 'official-page', sourceId: 'workday-acme', sourceUrl: 'https://example.test/jobs/123', observedAt, exactPosting: true,
    });
    expect(item?.education).toMatchObject({ graduationDateWindow: { start: '2027-01', end: '2029-05' } });
    expect(item?.education?.minimumDegree).toBeUndefined();
    expect(item?.applicationDeadline?.value).toEqual({ kind: 'date', date: '2026-11-11' });
  });

  it('does not turn audience, deadline or internship dates into graduation requirements', () => {
    const extract = (text: string) => extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', text },
      sourceClass: 'official-api', sourceId: 'test', sourceUrl: 'https://example.test/123', observedAt, exactPosting: true })[0];
    expect(extract('Graduate students welcome. Applications close October 15, 2026.')?.education?.graduationDateWindow).toBeUndefined();
    expect(extract('Expected graduation May 2027. Applications close October 15, 2026. The internship begins June 2026.')?.education?.graduationDateWindow)
      .toEqual({ start: '2027-05', end: '2027-05' });
    expect(extract('You will graduate in Fall 2027 or Spring 2028.')?.education?.graduationDateWindow)
      .toEqual({ start: '2027-12', end: '2028-05' });
  });

  it('preserves degree alternatives and rejects explicitly waived requirements', () => {
    const extract = (text: string) => extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', text },
      sourceClass: 'official-api', sourceId: 'test', sourceUrl: 'https://example.test/123', observedAt, exactPosting: true })[0]?.education;
    expect(extract("A Bachelor's or Master's degree is required.")?.minimumDegree).toBe('bachelors');
    expect(extract("A Master's or PhD degree is required.")?.minimumDegree).toBe('masters');
    expect(extract("No Master's degree is required.")?.minimumDegree).toBeUndefined();
    expect(extract("A Master's degree is not required. A Bachelor's degree is required.")?.minimumDegree).toBe('bachelors');
    expect(extract("A Bachelor's or Master's degree is preferred, but a PhD degree is required.")?.minimumDegree).toBe('doctoral');
  });

  it('rejects impossible deadline dates and preserves named timezones', () => {
    const extract = (date: string, timezone?: string) => extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', deadline: date, deadlineTimezone: timezone },
      sourceClass: 'official-api', sourceId: 'test', sourceUrl: 'https://example.test/123', observedAt, exactPosting: true })[0]?.applicationDeadline?.value;
    expect(extract('2026-02-30')).toBeUndefined();
    expect(extract('February 29, 2026')).toBeUndefined();
    expect(extract('2028-02-29', 'America/New_York')).toEqual({ kind: 'date', date: '2028-02-29', timezone: 'America/New_York' });
    expect(extract('2026-10-01T23:59:00-04:00')).toEqual({ kind: 'date', date: '2026-10-01', timezone: 'UTC-04:00' });
    expect(extract('2026-10-01', 'not-a-timezone')).toEqual({ kind: 'date', date: '2026-10-01' });
  });

  it('extracts only application-scoped rolling language', () => {
    const extract = (text: string) => extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', text },
      sourceClass: 'official-page', sourceId: 'official', sourceUrl: 'https://example.test/job', observedAt, exactPosting: true })[0]?.applicationDeadline?.value;
    expect(extract('Applications are reviewed on a rolling basis, so we encourage you to apply early.')).toEqual({ kind: 'rolling' });
    expect(extract('Applications are accepted on a rolling basis.')).toEqual({ kind: 'rolling' });
    expect(extract('Use the rolling equipment cart during the internship.')).toBeUndefined();
    expect(extract('No applications are reviewed on a rolling basis.')).toBeUndefined();
    expect(extract('Applications are reviewed on a rolling basis only if headcount is approved.')).toBeUndefined();
  });

  it('extracts slash deadlines only when their calendar ordering is unambiguous', () => {
    const extract = (text: string) => extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', text },
      sourceClass: 'official-page', sourceId: 'official', sourceUrl: 'https://example.test/job', observedAt, exactPosting: true })[0]?.applicationDeadline?.value;
    expect(extract('Application submitted by 9/20/2026')).toEqual({ kind: 'date', date: '2026-09-20' });
    expect(extract('Applications submitted by 9/20/2026')).toEqual({ kind: 'date', date: '2026-09-20' });
    expect(extract('Applications must be submitted by 9/20/2026')).toEqual({ kind: 'date', date: '2026-09-20' });
    expect(extract('Expenses submitted by 9/20/2026')).toBeUndefined();
    expect(extract('Apply by 20/9/2026')).toEqual({ kind: 'date', date: '2026-09-20' });
    expect(extract('Apply by 9/10/2026')).toBeUndefined();
    expect(extract('Apply by 20/20/2026')).toBeUndefined();
    expect(extract('Apply by 2/30/2026')).toBeUndefined();
  });

  it.each([
    ['This role is based on-site 5 days per week in San Mateo, CA.', 'onsite'],
    ['This internship is a full-time position, in-person at our office.', 'onsite'],
    ['This role is a hybrid position in Hartford, CT.', 'hybrid'],
  ])('extracts narrow role-scoped work mode: %s', (text, expected) => {
    const [item] = extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', text }, sourceClass: 'official-page',
      sourceId: 'official', sourceUrl: 'https://example.test/job', observedAt, exactPosting: true });
    expect(item?.workMode?.value).toBe(expected);
  });

  it.each([
    'Our infrastructure team is hybrid and distributed.',
    'This role is not remote.',
    'This role may be remote.',
    'This internship could be a hybrid position.',
    'This role is a hybrid position only if approved.',
    'This role is remote subject to manager approval.',
    'This role is onsite unless an accommodation is approved.',
  ])('does not infer conditional, negated, or unrelated work mode: %s', (text) => {
    const [item] = extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', text }, sourceClass: 'official-page',
      sourceId: 'official', sourceUrl: 'https://example.test/job', observedAt, exactPosting: true });
    expect(item?.workMode).toBeUndefined();
  });

  it('projects native-currency ranges without inventing USD scalar bounds', () => {
    const [item] = extractPostingMetadataEvidence({
      artifact: { title: 'Software Intern', compensationText: 'CAD $30-$40/hour' }, sourceClass: 'official-ats',
      sourceId: 'lever-acme', sourceUrl: 'https://api.lever.test/acme', observedAt, exactPosting: true,
    });
    expect(item?.compensationRanges?.[0]?.currency).toBe('CAD');
    expect(reconcileRoleMetadata(item ? [item] : []).compensation).toMatchObject({ raw: 'CAD 30–40/hour', ranges: [{ currency: 'CAD', period: 'hourly' }] });
  });

  it('does not assume an ambiguous dollar symbol is USD without a US location', () => {
    const ranges = extractCompensationRanges('The pay range is $30-$40/hour.', { provenance: field, knownLocations: ['Toronto, ON'] });
    expect(ranges[0]?.currency).toBe('XXX');
    expect(compensationFromRanges(ranges)).toMatchObject({ raw: '$30–40/hour', ranges: [{ currency: 'XXX', period: 'hourly' }] });
  });

  it.each([
    ['Indiana', ['IN']], ['California', ['CA']], ['remote Canada', ['Remote in Canada']],
    ['mixed US and Canada', ['Seattle, WA', 'Toronto, ON']],
  ])('keeps bare dollars currency-unknown for %s locations', (_name, knownLocations) => {
    expect(extractCompensationRanges('The pay range is $30-$40/hour.', { provenance: field, knownLocations }))
      .toMatchObject([{ minAmount: 30, maxAmount: 40, currency: 'XXX', period: 'hourly' }]);
  });

  it.each([
    ['US$30-US$40/hour', 'USD'], ['USD $30-$40/hour', 'USD'], ['CAD $30-$40/hour', 'CAD'],
  ])('preserves explicit currency notation in %s', (text, currency) => {
    expect(extractCompensationRanges(`The pay range is ${text}.`, { provenance: field, knownLocations: ['Toronto, ON'] }))
      .toMatchObject([{ minAmount: 30, maxAmount: 40, currency, period: 'hourly' }]);
  });

  it('keeps a bare-dollar housing amount currency-unknown even for a US location', () => {
    expect(extractHousingDetails('$2,500 monthly housing stipend.', { provenance: field, knownLocations: ['San Jose, CA'] }))
      .toMatchObject([{ kind: 'stipend', minAmount: 2500, maxAmount: 2500, currency: 'XXX', period: 'monthly' }]);
  });

  it('projects nonstandard pay periods without using them as legacy scalar bounds', () => {
    const [item] = extractPostingMetadataEvidence({
      artifact: { title: 'Software Intern', compensationText: 'USD $500-$700/week' }, sourceClass: 'official-ats',
      sourceId: 'lever-acme', sourceUrl: 'https://api.lever.test/acme', observedAt, exactPosting: true,
    });
    expect(item?.compensationRanges?.[0]?.period).toBe('weekly');
    expect(reconcileRoleMetadata(item ? [item] : []).compensation).toMatchObject({ raw: 'USD 500–700/week', ranges: [{ currency: 'USD', period: 'weekly' }] });
  });

  it('accepts explicit degree and work-mode title evidence but never an inexact artifact', () => {
    const inferred = extractRoleMetadataEvidence({
      artifact: { title: 'PhD Research Intern — Remote' }, sourceClass: 'deterministic-inference',
      sourceId: 'community-acme', sourceUrl: 'https://example.test/source', observedAt, exactPosting: true, titleOnly: true,
    });
    expect(inferred).toMatchObject({ education: { levels: ['doctoral'], evidenceStatus: 'explicit' }, workMode: { value: 'remote' } });
    expect(extractRoleMetadataEvidence({
      artifact: { title: 'PhD Research Intern — Remote', text: 'Join our research team.' }, sourceClass: 'official-page',
      sourceId: 'community-acme', sourceUrl: 'https://example.test/jobs/123', observedAt, exactPosting: true,
    })).toBeUndefined();
    expect(extractRoleMetadataEvidence({
      artifact: { title: 'PhD Research Intern — Remote' }, sourceClass: 'official-page',
      sourceId: 'community-acme', sourceUrl: 'https://example.test/aggregate', observedAt, exactPosting: false,
    })).toBeUndefined();
  });

  it('does not mistake technical title topics for remote or hybrid work', () => {
    for (const title of ['Remote Sensing Intern', 'Hybrid Systems Intern', 'Remote Procedure Call Engineering Intern']) {
      expect(extractRoleMetadataEvidence({ artifact: { title }, sourceClass: 'deterministic-inference', sourceId: 'test',
        sourceUrl: 'https://example.test/123', observedAt, exactPosting: true, titleOnly: true })?.workMode).toBeUndefined();
    }
    expect(extractRoleMetadataEvidence({ artifact: { title: 'Remote Sensing Intern — Remote' }, sourceClass: 'deterministic-inference', sourceId: 'test',
      sourceUrl: 'https://example.test/123', observedAt, exactPosting: true, titleOnly: true })?.workMode?.value).toBe('remote');
  });

  it('reads rendered field/value lines without inventing impossible employer dates', () => {
    const [item] = extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', text: 'Location\nHouston, TX\nLocation Type\nOn-site', publishedAt: '2026-02-30', updatedAt: '2026-02-31T10:00:00Z' },
      sourceClass: 'official-page', sourceId: 'test', sourceUrl: 'https://example.test/123', observedAt, exactPosting: true });
    expect(item?.workMode?.value).toBe('onsite');
    expect(item?.locations).toMatchObject([{ name: 'Houston, TX' }]);
    expect(item?.employerPublishedAt).toBeUndefined();
    expect(item?.employerUpdatedAt).toBeUndefined();
  });

  it('requires publisher timestamps to state an explicit four-digit year', () => {
    const extract = (publishedAt: string) => extractPostingMetadataEvidence({ artifact: { title: 'Engineering Intern', publishedAt },
      sourceClass: 'reviewed-community', sourceId: 'community', sourceUrl: 'https://example.test/job', observedAt, exactPosting: true })[0]?.employerPublishedAt?.value;
    expect(extract('May 22')).toBeUndefined();
    expect(extract('7/7')).toBeUndefined();
    expect(extract('2026-05-22T14:30:00Z')).toBe('2026-05-22T14:30:00.000Z');
    expect(extract('May 22, 2026')).toBe('2026-05-22T00:00:00.000Z');
    expect(extract('22 May 2026')).toBe('2026-05-22T00:00:00.000Z');
    expect(extract('February 30, 2026')).toBeUndefined();
  });

  it('matches role-specific JSON-LD by immutable posting ID and rejects an aggregate mismatch', () => {
    const artifacts = applicationMetadataArtifactsFromJsonDocuments([JSON.stringify({ '@graph': [
      { '@type': 'JobPosting', identifier: { value: '123' }, title: 'Software Engineering Intern',
        description: 'Candidates pursuing a Bachelor degree. Pay is $40-$50/hour.', validThrough: '2026-10-01T23:59:00-04:00',
        jobLocationType: 'TELECOMMUTE', baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { minValue: 40, maxValue: 50, unitText: 'HOUR' } } },
      { '@type': 'JobPosting', identifier: { value: '456' }, title: 'Data Intern', description: 'Another role' },
    ] })]);
    const selected = extractVerifiedPageMetadataEvidence({
      expectedTitle: 'Software Engineering Intern', expectedPostingId: '123', page: { title: 'Software Engineering Intern' },
      jsonLdArtifacts: artifacts, sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs/123', observedAt, exactPosting: true,
    });
    expect(selected.some((item) => item.sourceClass === 'official-json-ld' && item.compensationRanges?.[0]?.minAmount === 40)).toBe(true);
    expect(selected.find((item) => item.sourceClass === 'official-json-ld')?.applicationDeadline?.value)
      .toEqual({ kind: 'date', date: '2026-10-01', timezone: 'UTC-04:00' });
    expect(extractVerifiedPageMetadataEvidence({
      expectedTitle: 'Software Engineering Intern', expectedPostingId: '123', page: { title: 'Acme Careers' },
      jsonLdArtifacts: artifacts, sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs/123', observedAt, exactPosting: true,
    }).some((item) => item.sourceClass === 'official-json-ld')).toBe(true);
    expect(extractVerifiedPageMetadataEvidence({
      expectedTitle: 'Software Engineering Intern', expectedPostingId: '999', page: { title: 'Careers at Acme' },
      jsonLdArtifacts: artifacts, sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs', observedAt, exactPosting: false,
    })).toEqual([]);

    const prefixCollision = applicationMetadataArtifactsFromJsonDocuments([JSON.stringify({ '@graph': [
      { '@type': 'JobPosting', identifier: { value: '1234' }, title: 'Software Engineering Intern',
        baseSalary: { currency: 'USD', value: { value: 99, unitText: 'HOUR' } } },
      { '@type': 'JobPosting', identifier: { value: '456' }, title: 'Software Engineering Intern' },
    ] })]);
    expect(extractVerifiedPageMetadataEvidence({
      expectedTitle: 'Software Engineering Intern', expectedPostingId: '123', page: { title: 'Careers at Acme' },
      jsonLdArtifacts: prefixCollision, sourceId: 'community-acme', sourceUrl: 'https://careers.acme.test/jobs', observedAt, exactPosting: true,
    })).toEqual([]);
  });

  it('is deterministic across write order and preserves an existing scalar on an equal-authority conflict', () => {
    const first = evidence({ artifactHash: 'one', workMode: { value: 'remote', provenance: [{ ...field, contentHash: 'one' }] } });
    const second = evidence({ artifactHash: 'two', workMode: { value: 'hybrid', provenance: [{ ...field, contentHash: 'two' }] } });
    const left = reconcileRoleMetadata([first, second], job({ workMode: 'onsite' }));
    const right = reconcileRoleMetadata([second, first], job({ workMode: 'onsite' }));
    expect(left).toEqual(right);
    expect(left.metadata?.workMode).toBeUndefined();
    expect(left.conflicts).toMatchObject([{ field: 'work-mode', evidenceHashes: ['one', 'two'] }]);
  });

  it('projects structured identity program type and normalized metadata without changing durable state', () => {
    const metadata = extractPostingMetadataEvidence({
      artifact: { title: 'BS/MS Software Co-op — Hybrid', text: 'Graduating between May 2027 and June 2028.', locations: ['Boston, MA'], workMode: 'Hybrid' },
      sourceClass: 'official-ats', sourceId: 'lever-acme', sourceUrl: 'https://api.lever.test/acme', observedAt, exactPosting: true,
    });
    const original = job({
      notification: { smsPending: true, digestPending: false, smsSentAt: observedAt },
      sourceReferences: [{ sourceId: 'lever-acme', document: '123', sourceUrl: 'https://api.lever.test/acme', row: 1,
        company: 'Acme', title: 'BS/MS Software Co-op — Hybrid', location: 'Boston, MA', season: 'summer-2027',
        applyUrl: 'https://careers.acme.test/jobs/123', compensation: { raw: '' }, state: 'open', metadataEvidence: metadata }],
      internshipIdentity: {
        company: { canonicalId: 'acme', displayName: { value: 'Acme', provenance: [field] } },
        programType: { value: 'co-op', provenance: [field] }, season: { term: 'summer', year: 2027, evidenceStatus: 'explicit', provenance: [field] },
        education: { levels: [], evidenceStatus: 'unspecified', provenance: [] },
        title: { official: { value: 'BS/MS Software Co-op — Hybrid', provenance: [field] }, display: { value: 'BS/MS Software Co-op — Hybrid', provenance: [field] }, search: { value: 'bs ms software co op hybrid', provenance: [field] } },
        disciplines: [], locations: [],
      },
    });
    const projected = projectRoleMetadata(original).job;
    expect(projected).toMatchObject({ programType: 'co-op', workMode: 'hybrid', locations: ['Boston, MA'], graduationWindow: { start: '2027-05', end: '2028-06' } });
    expect(projected.jobId).toBe(original.jobId);
    expect(projected.notification).toEqual(original.notification);
    expect(projected.firstSeenAt).toBe(original.firstSeenAt);
  });
});
