import { describe, expect, it, vi } from 'vitest';
import { createMetadataAcquirer, metadataApiRoute, parseMetadataApiResponse } from '../src/metadata-acquisition.js';
import { educationAudienceLevels } from '../src/identity/enrichment.js';
import { extractPostingMetadataEvidence, compensationFromRanges, reconcileRoleMetadata } from '../src/role-metadata.js';
import { exactPostingRecoveryUrl, renderedDescriptionReady } from '../src/rendered-destination-evidence.js';
import { compareMetadataCohort, decodeMetadataCursor, encodeMetadataCursor, metadataFieldOutcomes } from '../src/metadata-audit.js';
import type { ProviderIdentity } from '../src/types.js';
import tenstorrentProbe from './fixtures/trusted-catalog/tenstorrent-5221670007.json' with { type: 'json' };
import boozAllenProbe from './fixtures/trusted-catalog/booz-allen-r0248143.json' with { type: 'json' };
import fab2Probe from './fixtures/trusted-catalog/fab2-0c4dc4f4-01c9-4138-a666-e7234cda7e95.json' with { type: 'json' };

const uuid = 'ef725594-42dd-4f0d-ba8e-df8179dbc6cb';
const identity = (provider: ProviderIdentity['provider'], postingId = uuid): ProviderIdentity => ({ provider, postingId, tenant: 'acme', sourceId: 'github-discovery', sourceUrl: 'https://github.test/jobs' });
const extract = (artifact: Parameters<typeof extractPostingMetadataEvidence>[0]['artifact']) => extractPostingMetadataEvidence({ artifact, sourceClass: 'official-ats', sourceId: 'test', sourceUrl: 'https://api.example.test/job', observedAt: '2026-09-05T00:00:00Z', exactPosting: true });

const ashbyBoard = (rows: Array<{ id: string; title: string; descriptionPlain?: string; descriptionHtml?: string }>) =>
  JSON.stringify({ jobs: rows.map((row) => ({ ...row, jobUrl: `https://jobs.ashbyhq.com/acme/${row.id}` })) });
function streamed(body: string, chunkSize: number): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
      controller.close();
    },
  }), { headers: { 'content-type': 'application/json' } });
}

describe('identity-bound public metadata APIs', () => {
  it('preserves degree-specific nested HTML pay rows through acquisition and reconciliation', () => {
    const artifact = parseMetadataApiResponse(identity('greenhouse', '123'), 'greenhouse-api', { id: 123, title: 'Engineering Intern',
      content: '<h3>Compensation and Benefits</h3><ul><li>The compensation for this role:<ul><li>Engineering Intern/Undergraduate: $30/hour</li><li>Engineering Intern/Masters: $32.50/hour</li><li>Engineering Intern/PhD: $35/hour</li></ul></li></ul>' });
    const result = reconcileRoleMetadata(extract(artifact!));
    expect(result.conflicts).toEqual([]);
    expect(result.compensation?.ranges).toHaveLength(3);
    expect(result.compensation?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 30, applicableEducationLevels: ['undergraduate'] }),
      expect.objectContaining({ minAmount: 32.5, applicableEducationLevels: ['masters'] }),
      expect.objectContaining({ minAmount: 35, applicableEducationLevels: ['doctoral'] }),
    ]));
    expect(result.compensation?.minHourlyUSD).toBeUndefined();
  });
  it('uses explicitly labeled structured units without duplicate global body bands', () => {
    const artifact = parseMetadataApiResponse(identity('greenhouse', '123'), 'greenhouse-api', { id: 123, title: 'Engineering Intern',
      content: '<p>SF Bay Area Hourly Rate</p><p>$54 — $60 USD</p><p>Bellevue, Washington Hourly Rate</p><p>$51.50 — $60 USD</p>',
      pay_input_ranges: [
        { min_cents: 5400, max_cents: 6000, currency_type: 'USD', title: 'SF Bay Area Hourly Rate' },
        { min_cents: 5150, max_cents: 6000, currency_type: 'USD', title: 'Bellevue, Washington Hourly Rate' },
      ],
    });
    const result = reconcileRoleMetadata(extract(artifact!));
    expect(result.conflicts).toEqual([]);
    expect(result.compensation?.ranges).toHaveLength(2);
    expect(result.compensation?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 54, maxAmount: 60, currency: 'USD', period: 'hourly', applicabilityLabel: 'SF Bay Area Hourly Rate' }),
      expect.objectContaining({ minAmount: 51.5, maxAmount: 60, currency: 'USD', period: 'hourly', applicabilityLabel: 'Bellevue, Washington Hourly Rate' }),
    ]));
    expect(result.compensation?.minHourlyUSD).toBeUndefined();
  });
  it('retains encoded ranges and publisher level labels without inventing periods', () => {
    for (const [content, expected] of [
      ['<h3>US Salary Range</h3><p>$90,000 &amp;mdash; $110,000 USD</p>', [{ minAmount: 90000, maxAmount: 110000, currency: 'USD' }]],
      ['<h3>Compensation and Benefits:</h3><p>Level 1: $140,000 - $175,000</p><p>Level 2: $160,000 - $210,000</p>', [{ minAmount: 140000, maxAmount: 175000, applicabilityLabel: 'Level 1' }, { minAmount: 160000, maxAmount: 210000, applicabilityLabel: 'Level 2' }]],
      ['<p>Compensation Range(s):</p><p>Level I - Minimum $18.00 - Maximum $20.00</p><p>Levell II - Minimum $21.00 - Maximum $23.00</p>', [{ minAmount: 18, maxAmount: 20, applicabilityLabel: 'Level I' }, { minAmount: 21, maxAmount: 23, applicabilityLabel: 'Levell II' }]],
    ] as const) {
      const artifact = parseMetadataApiResponse(identity('greenhouse', '123'), 'greenhouse-api', { id: 123, title: 'Engineering Intern', content });
      const result = reconcileRoleMetadata(extract(artifact!));
      expect(result.conflicts).toEqual([]);
      expect(result.compensation?.ranges).toHaveLength(expected.length);
      expect(result.compensation?.ranges).toEqual(expect.arrayContaining(expected.map(range => expect.objectContaining({ ...range, period: 'unknown' }))));
    }
  });
  it('uses the observed Workday site and requisition, never a start-date publication guess', () => {
    const id = { ...identity('workday', 'r0248143'), tenant: 'bah' };
    expect(metadataApiRoute(id, 'https://bah.wd1.myworkdayjobs.com/en-US/BAH_Jobs/job/Rome-NY/Intern_R0248143')?.url)
      .toBe('https://bah.wd1.myworkdayjobs.com/wday/cxs/bah/BAH_Jobs/job/Rome-NY/Intern_R0248143');
    expect(metadataApiRoute(id, 'https://evil.test/BAH_Jobs/job/Rome-NY/Intern_R0248143')).toBeUndefined();
    expect(metadataApiRoute(id, 'https://bah.wd1.myworkdayjobs.com/BAH_Jobs/job/Rome-NY/Intern_R999')).toBeUndefined();
    const artifact = parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: { jobReqId: 'R0248143', title: 'Software Intern', jobDescription: 'Salary USD 30 per hour', startDate: '2026-09-04', endDate: '2026-12-02' } });
    expect(artifact).toMatchObject({ deadline: '2026-12-02' }); expect(artifact?.publishedAt).toBeUndefined();
    expect(parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: { jobReqId: 'R999', title: 'Software Intern', jobDescription: 'Salary USD 30 per hour' } })).toBeUndefined();
  });
  it('keeps Tenstorrent’s first publication distinct from its latest update', () => {
    const id = { ...identity('greenhouse', '5221670007'), tenant: 'tenstorrentuniversity' };
    const artifact = parseMetadataApiResponse(id, 'greenhouse-api', tenstorrentProbe);
    expect(artifact).toMatchObject({
      title: 'Software Engineering Intern (Oct 2026 start)', locations: ['Belgrade, Serbia'],
      publishedAt: '2026-08-26T14:58:59-04:00', updatedAt: '2026-09-02T17:54:05-04:00',
    });
    expect(artifact?.publishedAt).not.toBe(artifact?.updatedAt);
    const result = reconcileRoleMetadata(extract(artifact!));
    expect(result.metadata?.employerPublishedAt?.value).toBe('2026-08-26T18:58:59.000Z');
    expect(result.metadata?.employerUpdatedAt?.value).toBe('2026-09-02T21:54:05.000Z');
    expect(result.compensation).toBeUndefined();
    expect(result.metadata?.housing).toBeUndefined();
    expect(result.metadata?.workMode?.value).toBe('onsite');
  });
  it('preserves the complete Booz Allen 2027 role without treating generic work-model copy as role mode', () => {
    const id = { ...identity('workday', 'R0248143'), tenant: 'bah' };
    const url = 'https://bah.wd1.myworkdayjobs.com/wday/cxs/bah/BAH_Jobs/job/Rome-NY/University--2027-Summer-Games-Data-Scientist-Intern_R0248143';
    const artifact = parseMetadataApiResponse(id, 'workday-api', boozAllenProbe, url);
    expect(artifact).toMatchObject({
      title: 'University, 2027 Summer Games Data Scientist Intern - Rome, NY', locations: ['Rome, NY'],
    });
    expect(artifact?.title).toContain('2027 Summer Games Data Scientist Intern');
    const result = reconcileRoleMetadata(extract(artifact!));
    expect(result.compensation?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 61900, maxAmount: 141000, currency: 'USD', period: 'annual' }),
    ]));
    expect(result.metadata?.education).toMatchObject({ levels: ['undergraduate'] });
    // The degree date qualifies the student; the role's 2027 season remains
    // part of its exact employer title and must not be replaced by that date.
    expect(artifact?.title).toContain('2027 Summer Games');
    expect(artifact?.title).not.toContain('2028');
    expect(result.metadata?.workMode).toBeUndefined();
  });
  it('retains Fab2’s exact Ashby role, structured locations, onsite mode, annualized pay, housing, and education alternative', () => {
    const id = { ...identity('ashby', '0c4dc4f4-01c9-4138-a666-e7234cda7e95'), tenant: 'fab2' };
    const artifact = parseMetadataApiResponse(id, 'ashby-api', fab2Probe);
    expect(artifact).toMatchObject({
      title: 'Fab Software Engineering Intern - Winter', locations: ['Austin', 'San Francisco Office'], workMode: 'OnSite',
    });
    const result = reconcileRoleMetadata(extract(artifact!));
    expect(result.compensation?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 114000, maxAmount: 131000, currency: 'USD', period: 'annual' }),
    ]));
    expect(result.compensation?.minHourlyUSD).toBeUndefined();
    expect(result.metadata?.locations?.map(item => item.name)).toEqual(['Austin', 'San Francisco Office']);
    expect(result.metadata?.workMode?.value).toBe('onsite');
    expect(result.metadata?.housing).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'stipend' }),
    ]));
    expect('amount' in (result.metadata?.housing?.[0] ?? {})).toBe(false);
    expect(result.metadata?.education).toMatchObject({ levels: ['undergraduate'] });
    expect(result.metadata?.education?.minimumDegree).toBeUndefined();
  });
  it('preserves Magna education-labeled pay scale rows from Workday API text', () => {
    const id = { ...identity('workday', 'R00247602'), tenant: 'magna' };
    const artifact = parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: {
      jobReqId: 'R00247602', title: 'Intern - Infrared Imaging & Algorithms',
      jobDescription: '<p><b>Pay Scale:</b></p><p>Freshman $17.00</p><p>Sophomore$20.00</p><p>Junior$22.00</p><p>Senior$24.00</p><p>Masters$26.00</p><p>PHD$38.00</p>', location: 'Goleta, California, US',
    } });
    const result = reconcileRoleMetadata(extract(artifact!));
    expect(result.conflicts).toEqual([]);
    expect(result.compensation?.ranges).toHaveLength(6);
    expect(result.compensation?.ranges?.map(({ minAmount, maxAmount, currency, period, applicabilityLabel }) =>
      ({ minAmount, maxAmount, currency, period, applicabilityLabel }))).toEqual(expect.arrayContaining(
      [['Freshman', 17], ['Sophomore', 20], ['Junior', 22], ['Senior', 24], ['Masters', 26], ['PHD', 38]].map(([applicabilityLabel, amount]) =>
        ({ minAmount: amount, maxAmount: amount, currency: 'XXX', period: 'unknown', applicabilityLabel })),
    ));
    expect(result.compensation?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 17, applicabilityLabel: 'Freshman' }),
      expect.objectContaining({ minAmount: 26, applicableEducationLevels: ['masters'], applicabilityLabel: 'Masters' }),
      expect.objectContaining({ minAmount: 38, applicableEducationLevels: ['doctoral'], applicabilityLabel: 'PHD' }),
    ]));
  });
  it('preserves all explicitly labeled PayPal location bands from Workday API text', () => {
    const id = { ...identity('workday', 'R0137285'), tenant: 'paypal' };
    const artifact = parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: {
      jobReqId: 'R0137285', title: 'Software Engineer Intern', location: 'San Jose, California, United States of America',
      jobDescription: '<p>The expected range of pay for this role by location is:</p><p><b>Primary Location | Pay Range:</b></p><p>San Jose, California | ($32 - $55 Hourly)</p><p><b>Additional Location(s) | Pay Range:</b></p><p>Austin, Texas | ($28- $49 Hourly)</p><p>Chicago, Illinois | ($28- $49 Hourly)</p>',
    } });
    const result = reconcileRoleMetadata(extract(artifact!));
    expect(result.conflicts).toEqual([]);
    expect(result.compensation?.ranges).toHaveLength(3);
    expect(result.compensation?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 32, maxAmount: 55, currency: 'XXX', period: 'hourly', applicableLocations: ['San Jose, California'] }),
      expect.objectContaining({ minAmount: 28, maxAmount: 49, currency: 'XXX', period: 'hourly', applicableLocations: ['Austin, Texas'] }),
      expect.objectContaining({ minAmount: 28, maxAmount: 49, currency: 'XXX', period: 'hourly', applicableLocations: ['Chicago, Illinois'] }),
    ]));
  });
  it('matches the entire Workday presentation suffix instead of merging requisitions', () => {
    const id = { ...identity('workday', 'jr340771-1'), tenant: 'salesforce' };
    const url = 'https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/job/California/Intern_JR340771-1';
    const job = { jobReqId: 'JR340771', jobPostingId: 'Intern_JR340771-1', title: 'Software Intern', jobDescription: 'Salary USD 40 per hour' };
    expect(parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: job }, url)).toBeDefined();
    expect(parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: { ...job, jobPostingId: 'Intern_JR340771-2' } }, url)).toBeUndefined();
  });
  it('validates the SmartRecruiters company and excludes company-wide descriptions', () => {
    const route = metadataApiRoute(identity('unknown'), 'https://jobs.smartrecruiters.com/ALTEN/744000145558439-stage-data');
    expect(route?.url).toBe('https://api.smartrecruiters.com/v1/companies/ALTEN/postings/744000145558439');
    const payload = { id: '744000145558439', company: { identifier: 'ALTEN' }, name: 'Software Intern', jobAd: { sections: {
      companyDescription: { text: 'Our company pays USD 900000 per year' }, jobDescription: { text: 'Salary EUR 2000 per month' },
    } } };
    const artifact = parseMetadataApiResponse(route!.identity!, 'smartrecruiters-api', payload);
    expect(artifact?.text).not.toContain('900000');
    expect(parseMetadataApiResponse(route!.identity!, 'smartrecruiters-api', { ...payload, company: { identifier: 'different' } })).toBeUndefined();
  });
  it('requests Greenhouse transparency without application questions or a guessed period', () => {
    const id = identity('greenhouse', '123');
    expect(metadataApiRoute(id)?.url).toContain('pay_transparency=true');
    const artifact = parseMetadataApiResponse(id, 'greenhouse-api', { id: 123, title: 'Software Intern', content: 'Build things.',
      pay_input_ranges: [{ min_cents: 12350000, max_cents: 17000000, currency_type: 'USD', title: 'Salary Range' }] });
    expect(artifact).toBeDefined();
    const pay = compensationFromRanges(extract(artifact!)[0]!.compensationRanges ?? []);
    expect(pay.ranges).toMatchObject([{ minAmount: 123500, maxAmount: 170000, period: 'unknown', currency: 'USD' }]);
    expect(pay.minAnnualUSD).toBeUndefined();
    expect(parseMetadataApiResponse(id, 'greenhouse-api', { id: 999, title: 'Software Intern', content: 'Salary USD 100/hour' })).toBeUndefined();
  });
  it('retains Lever descriptions, lists, native bands and provider dates', () => {
    const artifact = parseMetadataApiResponse(identity('lever'), 'lever-api', { id: uuid, text: 'Software Intern', hostedUrl: `https://jobs.lever.co/acme/${uuid}`,
      descriptionPlain: 'Build things.', lists: [{ text: 'Requirements', content: 'Must hold a bachelors degree.' }],
      salaryRange: { currency: 'JPY', min: 2000, max: 4000, interval: 'per-hour-wage' }, createdAt: 1788566400000 });
    expect(artifact?.text).toContain('bachelors');
    expect(extract(artifact!)[0]?.compensationRanges).toMatchObject([{ minAmount: 2000, maxAmount: 4000, currency: 'JPY', period: 'hourly' }]);
    expect(parseMetadataApiResponse(identity('lever'), 'lever-api', { id: uuid, text: 'Software Intern', hostedUrl: `https://jobs.lever.co/another/${uuid}`, descriptionPlain: 'Build things' })).toBeUndefined();
  });
  it('selects exactly one Ashby posting without directory salary contamination', () => {
    const artifact = parseMetadataApiResponse(identity('ashby'), 'ashby-api', { jobs: [
      { id: 'other', title: 'Other role', compensation: { scrapeableCompensationSalarySummary: 'USD 900000/year' } },
      { id: uuid, title: 'Software Intern', descriptionPlain: 'Duplicated plain text', descriptionHtml: '<p>Build things</p>',
        jobUrl: `https://jobs.ashbyhq.com/acme/${uuid}`,
        compensation: { scrapeableCompensationSalarySummary: 'Salary EUR 2000 - 3000 per month' } },
    ] });
    expect(artifact?.text).toBe('Build things');
    expect(extract(artifact!)[0]?.compensationRanges).toMatchObject([{ currency: 'EUR', minAmount: 2000, maxAmount: 3000, period: 'monthly' }]);
  });
  it('rejects unreviewed tenants and unsupported API families', () => {
    expect(metadataApiRoute({ ...identity('lever'), tenant: '../another' })).toBeUndefined();
    expect(metadataApiRoute(identity('workday'))).toBeUndefined();
    expect(metadataApiRoute({ ...identity('greenhouse', '123'), tenant: undefined })).toBeUndefined();
  });
  it('accepts dotted Ashby board names without allowing path traversal', () => {
    expect(metadataApiRoute({ ...identity('ashby'), tenant: 'persona.ai' })?.url)
      .toBe('https://api.ashbyhq.com/posting-api/job-board/persona.ai?includeCompensation=true');
    for (const tenant of ['..', '.', '../acme', 'acme/other', 'acme%2fother', 'acme..other', 'acme?foo=bar']) {
      expect(metadataApiRoute({ ...identity('ashby'), tenant })).toBeUndefined();
    }
    expect(metadataApiRoute({ ...identity('greenhouse', '123'), tenant: 'persona.ai' })).toBeUndefined();
  });
  it('streams a board past the acquisition ceiling and keeps only the requested posting', async () => {
    const filler = 'x'.repeat(20_000);
    const rows = Array.from({ length: 150 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Role ${index}`, descriptionPlain: filler }));
    const board = ashbyBoard([...rows, { id: uuid, title: 'Target Intern', descriptionPlain: 'Build streaming acquisition.' }]);
    expect(board.length).toBeGreaterThan(2_000_000);

    const result = await createMetadataAcquirer(async () => streamed(board, 8_192))(identity('ashby'));

    expect(result?.outcome).toBe('acquired');
    expect(result?.artifact?.text).toContain('Build streaming acquisition.');
    expect(result?.bytes).toBeGreaterThan(2_000_000);
  });
  it('keeps the matching posting across small chunk boundaries, strings, and escapes', async () => {
    const board = ashbyBoard([
      { id: '00000000-0000-4000-8000-000000000000', title: 'Other', descriptionPlain: 'y'.repeat(4_000) },
      { id: uuid, title: 'Target "Intern" \\ Role', descriptionPlain: 'Line with "quotes" and a backslash \\ inside.' },
    ]);

    for (const chunkSize of [5, 17, 128, 4_093]) {
      const result = await createMetadataAcquirer(async () => streamed(board, chunkSize))(identity('ashby'));
      expect(result?.artifact?.text, `chunk ${chunkSize}`).toContain('backslash');
    }
  });
  it('preserves the exact Ashby element ceiling and recovers after an oversized match', async () => {
    const make = (length: number) => {
      const job = { id: uuid, title: 'Boundary Intern', descriptionPlain: '', jobUrl: `https://jobs.ashbyhq.com/acme/${uuid}` };
      job.descriptionPlain = 'x'.repeat(length - JSON.stringify(job).length);
      expect(JSON.stringify(job).length).toBe(length);
      return job;
    };
    const ceiling = 512 * 1024 + 1; // Existing ceiling excludes the closing brace.
    const accepted = await createMetadataAcquirer(async () => streamed(ashbyBoard([make(ceiling)]), 8_192))(identity('ashby'));
    expect(accepted?.outcome).toBe('acquired');
    const recovered = await createMetadataAcquirer(async () => streamed(ashbyBoard([
      make(ceiling + 1), { id: uuid, title: 'Real Intern', descriptionPlain: 'The later exact posting.' },
    ]), 8_192))(identity('ashby'));
    expect(recovered?.artifact?.text).toBe('The later exact posting.');
  });
  it('reuses a streamed board for backward and concurrent exact-posting lookups', async () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const board = ashbyBoard([
      { id: first, title: 'First Intern', descriptionPlain: 'First posting with é and "quotes".' },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `filler-${index}`, title: 'Other', descriptionPlain: 'x'.repeat(40_000) })),
      { id: uuid, title: 'Last Intern', descriptionPlain: 'Last posting.' },
    ]);
    const fetcher = vi.fn(async () => streamed(board, 4_093));
    const acquire = createMetadataAcquirer(fetcher);
    const results = await Promise.all([acquire(identity('ashby')), acquire(identity('ashby', first))]);
    expect(results[0]?.artifact?.text).toBe('Last posting.');
    expect(results[1]?.artifact?.text).toContain('First posting with é');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps only declared batch artifacts while streaming a large board out of order', async () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const filler = ashbyBoard([{ id: 'filler', title: 'Other', descriptionPlain: 'x'.repeat(100_000) }]).slice(9, -2);
    const early = ashbyBoard([{ id: first, title: 'First Intern', descriptionPlain: 'First exact posting.' }]).slice(9, -2);
    const late = ashbyBoard([{ id: uuid, title: 'Last Intern', descriptionPlain: 'Last exact posting.' }]).slice(9, -2);
    let index = 0;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (index === 0) controller.enqueue(encoder.encode('{"jobs":[' + early + ','));
      else if (index <= 360) controller.enqueue(encoder.encode(filler + ','));
      else if (index === 361) controller.enqueue(encoder.encode(late + ']}'));
      else controller.close();
      index += 1;
    } });
    const fetcher = vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
    const acquire = createMetadataAcquirer(fetcher, { ashbyBatch: [
      { identity: identity('ashby', first) }, { identity: identity('ashby') },
    ] });
    const last = await acquire(identity('ashby'));
    expect(last?.artifact?.text).toBe('Last exact posting.');
    expect(last?.bytes).toBeGreaterThan(36_000_000);
    expect((await acquire(identity('ashby', first)))?.artifact?.text).toBe('First exact posting.');
    expect((await acquire(identity('ashby')))?.artifact?.text).toBe('Last exact posting.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await acquire.close();
    expect(body.locked).toBe(false);
  });

  it('cancels an unread board tail and releases its lock when the batch closes', async () => {
    const cancel = vi.fn();
    const prefix = ashbyBoard([{ id: uuid, title: 'Target Intern', descriptionPlain: 'Exact posting.' }]).slice(0, -2) + ',';
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(prefix)); },
      cancel,
    });
    const acquire = createMetadataAcquirer(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
    expect((await acquire(identity('ashby')))?.artifact?.text).toBe('Exact posting.');
    expect(body.locked).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    await Promise.all([acquire.close(), acquire.close()]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    await expect(acquire(identity('ashby'))).rejects.toThrow('batch is closed');
  });
  it('releases every retained board even when one stream rejects cancellation', async () => {
    const bodies = ['acme', 'other'].map((tenant) => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jobs: [{ id: uuid,
        title: 'Intern', descriptionPlain: 'Exact posting.', jobUrl: `https://jobs.ashbyhq.com/${tenant}/${uuid}` }] }).slice(0, -2) + ',')); },
      cancel() { if (tenant === 'acme') throw new Error('upstream already aborted'); },
    }));
    const acquire = createMetadataAcquirer(async (url) => new Response(bodies[String(url).includes('/acme?') ? 0 : 1], { headers: { 'content-type': 'application/json' } }));
    expect((await acquire(identity('ashby')))?.outcome).toBe('acquired');
    expect((await acquire({ ...identity('ashby'), tenant: 'other' }))?.outcome).toBe('acquired');
    await acquire.close();
    expect(bodies.map((body) => body.locked)).toEqual([false, false]);
  });
  it('preserves a literal BOM inside a posting at the start of a streamed chunk', async () => {
    const row = { id: uuid, title: 'BOM Intern', descriptionPlain: 'Before\uFEFFafter.' };
    const board = ashbyBoard([row]);
    const chunkSize = new TextEncoder().encode(board.slice(0, board.indexOf('\uFEFF'))).byteLength;
    const result = await createMetadataAcquirer(async () => streamed(board, chunkSize))(identity('ashby'));
    const direct = parseMetadataApiResponse(identity('ashby'), 'ashby-api', JSON.parse(board));
    expect(result?.artifact).toEqual(direct);
  });
  it('reports identity-mismatch when the board does not publish the posting', async () => {
    const board = ashbyBoard([{ id: '00000000-0000-4000-8000-000000000000', title: 'Other', descriptionPlain: 'zzz' }]);
    const result = await createMetadataAcquirer(async () => streamed(board, 32))(identity('ashby'));
    expect(result?.outcome).toBe('identity-mismatch');
    expect(result?.artifact).toBeUndefined();
  });
  it('keeps the real posting when a stray top-level array publishes a look-alike id first', async () => {
    // A candidate that carries the requested id but fails identity validation is
    // not the posting; the walk must resume rather than settle a false miss.
    const board = JSON.stringify({
      related: [{ id: uuid, title: 'Decoy', jobUrl: `https://evil.example/acme/${uuid}`, descriptionPlain: 'decoy' }],
      jobs: [{ id: uuid, title: 'Real Intern', jobUrl: `https://jobs.ashbyhq.com/acme/${uuid}`, descriptionPlain: 'the real body' }],
    });
    const result = await createMetadataAcquirer(async () => streamed(board, 16))(identity('ashby'));
    expect(result?.outcome).toBe('acquired');
    expect(result?.artifact?.text).toContain('the real body');
  });
  it('reads an iCIMS posting from its frame route, the only response carrying the description', async () => {
    const icims = { ...identity('icims', '12891'), tenant: 'careers-springswindowfashions' };
    expect(metadataApiRoute(icims)).toEqual({ method: 'icims-page',
      url: 'https://careers-springswindowfashions.icims.com/jobs/12891/job?in_iframe=1&mobile=false' });
    // iCIMS postings are numeric, and the tenant is still a host label.
    expect(metadataApiRoute({ ...identity('icims'), tenant: 'careers-sig' })).toBeUndefined();
    for (const tenant of ['../acme', 'acme/other', 'acme.example']) {
      expect(metadataApiRoute({ ...icims, tenant })).toBeUndefined();
    }

    const page = '<html><head><title>Software Engineering Internship in LONG ISLAND CITY | Careers</title></head><body>'
      + '<h1>Software Engineering Internship</h1>'
      + '<div class="iCIMS_JobContent"><p>Pursuing a 4-year degree with current standing of Sophomore or Junior.</p></div>'
      + '<footer><a href="/jobs/12891/job">Apply</a></footer></body></html>';
    const result = await createMetadataAcquirer(async () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }))(icims);
    expect(result).toMatchObject({ method: 'icims-page', outcome: 'acquired' });
    // The clean heading wins over the title tag's location suffix, and the
    // container marker never reaches the artifact text.
    expect(result?.artifact?.title).toBe('Software Engineering Internship');
    expect(result?.artifact?.text).toContain('Pursuing a 4-year degree');
    expect(result?.artifact?.text).not.toContain('iCIMS_JobContent');
    expect(educationAudienceLevels(`${result!.artifact!.title}\n${result!.artifact!.text}`)).toEqual(['undergraduate']);
  });
  it('recovers the reviewed Garmin vanity URL as its exact official iCIMS frame', () => {
    const github = identity('github', 'README.md:https://careers.garmin.com/jobs/19643?icims=1');
    expect(metadataApiRoute(github, 'https://careers.garmin.com/jobs/19643?icims=1&utm_source=Simplify&ref=Simplify')).toEqual({
      method: 'icims-page',
      url: 'https://careers-garmin.icims.com/jobs/19643/job?in_iframe=1&mobile=false',
      identity: { ...github, provider: 'icims', tenant: 'careers-garmin', postingId: '19643' },
    });
    for (const candidate of [
      'https://careers.garmin.com/jobs/19643',
      'https://careers.garmin.com/jobs/19643?icims=0',
      'https://careers.garmin.com/jobs/19643?icims=1&icims=1',
      'https://careers.garmin.com/jobs/19643/another?icims=1',
      'https://careers.garmin.example/jobs/19643?icims=1',
      'https://careers.amd.com/jobs/19643?icims=1',
    ]) expect(metadataApiRoute(github, candidate)).toBeUndefined();
  });
  it('routes the AMD tenant through its live student frame host', async () => {
    // AMD retired `amd.icims.com` (302 to the tenant root), and careers.amd.com
    // links its student postings to `campus-amd`. The stored tenant stays `amd`;
    // only the acquisition host is translated.
    const amd = { ...identity('icims', '92354'), tenant: 'amd' };
    expect(metadataApiRoute(amd)).toEqual({ method: 'icims-page',
      url: 'https://campus-amd.icims.com/jobs/92354/job?in_iframe=1&mobile=false' });
    const page = '<html><head><title>2027 PhD AI Systems Intern | Careers</title></head><body>'
      + '<h1>2027 PhD AI Systems &amp; GPU Performance Engineering Intern/Co-op</h1>'
      + '<div class="iCIMS_JobContent"><p>Currently pursuing a PhD in Computer Science.</p></div>'
      + '<footer><a href="/jobs/92354/job">Apply</a></footer></body></html>';
    const result = await createMetadataAcquirer(async () => new Response(page, { headers: { 'content-type': 'text/html' } }))(amd);
    expect(result).toMatchObject({ method: 'icims-page', outcome: 'acquired' });
    expect(educationAudienceLevels(`${result!.artifact!.title}\n${result!.artifact!.text}`)).toEqual(['doctoral']);
  });
  it('falls back to the employer page JSON-LD when a frame host no longer serves the posting', async () => {
    const amd = { ...identity('icims', '92354'), tenant: 'campus-amd' };
    const candidate = 'https://careers.amd.com/jobs/92354?icims=1&utm_source=Simplify&ref=Simplify';
    const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting',
      url: 'https://careers.amd.com/careers-home/jobs/92354?icims=1',
      title: '2027 PhD AI Systems & GPU Performance Engineering Intern/Co-op',
      description: '<p>Currently pursuing a PhD in Computer Science.</p>' });
    const page = `<html><head><title>2027 PhD AI Systems Intern</title><script type="application/ld+json">${jsonLd}</script></head>`
      + '<body><main>Careers</main></body></html>';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('campus-amd.icims.com')) return new Response(null, { status: 302, headers: { location: 'https://campus-amd.icims.com/' } });
      if (url === candidate) return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not found', { status: 404 });
    });
    const result = await createMetadataAcquirer(fetchImpl)(amd, candidate);
    expect(result).toMatchObject({ method: 'json-ld-page', outcome: 'acquired', sourceUrl: candidate });
    expect(result?.artifact?.title).toBe('2027 PhD AI Systems & GPU Performance Engineering Intern/Co-op');
    expect(educationAudienceLevels(`${result!.artifact!.title}\n${result!.artifact!.text}`)).toEqual(['doctoral']);
  });
  it('rejects an employer-page fallback that redirects off the requested host', async () => {
    const amd = { ...identity('icims', '92354'), tenant: 'campus-amd' };
    const candidate = 'https://careers.amd.com/jobs/92354?icims=1';
    const crossHost = new Response('<html><body>no posting</body></html>', { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(crossHost, 'url', { value: 'https://evil.example/careers-home/jobs/92354' });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes('campus-amd.icims.com')
      ? new Response(null, { status: 302, headers: { location: 'https://campus-amd.icims.com/' } })
      : crossHost);
    expect(await createMetadataAcquirer(fetchImpl)(amd, candidate))
      .toMatchObject({ method: 'icims-page', outcome: 'failed', status: 302 });
  });
  it('keeps a transient frame failure on the provider route instead of a page fallback', async () => {
    const amd = { ...identity('icims', '92354'), tenant: 'campus-amd' };
    const candidate = 'https://careers.amd.com/jobs/92354?icims=1';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('campus-amd.icims.com')) return new Response('busy', { status: 503 });
      throw new Error('the fallback page must not be fetched for a retryable failure');
    });
    expect(await createMetadataAcquirer(fetchImpl)(amd, candidate))
      .toMatchObject({ method: 'icims-page', outcome: 'failed', status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('refuses an iCIMS response that is not the requested posting', async () => {
    const icims = { ...identity('icims', '12891'), tenant: 'careers-springswindowfashions' };
    const header = { headers: { 'content-type': 'text/html' } };
    // The posting id is the identity: another role's page, or none at all, is not ours.
    expect(await createMetadataAcquirer(async () => new Response('<h1>Another role</h1><div class="iCIMS_JobContent">Pursuing a degree.</div>', header))(icims))
      .toMatchObject({ outcome: 'identity-mismatch' });
    expect(await createMetadataAcquirer(async () => new Response('<h1>Intern</h1><p>No container</p>', header))(icims))
      .toMatchObject({ outcome: 'identity-mismatch' });
    // JSON is not the frame document, so the iCIMS route keeps its own type gate.
    expect(await createMetadataAcquirer(async () => Response.json({ ok: true }))(icims))
      .toMatchObject({ outcome: 'failed' });
  });
  it('recovers only an exact observed Greenhouse embed identity', () => {
    const id = { ...identity('greenhouse', '8044334'), tenant: undefined };
    const url = 'https://job-boards.greenhouse.io/embed/job_app?for=towerresearchcapital&token=8044334&validityToken=transient';
    expect(metadataApiRoute(id, url)).toMatchObject({ method: 'greenhouse-api', identity: { tenant: 'towerresearchcapital', postingId: '8044334' } });
    expect(metadataApiRoute(id, url)?.url).not.toContain('transient');
    for (const candidate of [url.replace('8044334', '999'), url.replace('job-boards.greenhouse.io', 'evil.test'),
      `${url}&for=another`, `${url}&token=999`, url.replace('towerresearchcapital', '..%2Facme')]) {
      expect(metadataApiRoute(id, candidate)).toBeUndefined();
    }
    expect(metadataApiRoute({ ...id, tenant: 'another' }, url)?.identity).toBeUndefined();
  });
  it('coalesces duplicate batch requests, but validates each posting separately', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ jobs: [{ id: uuid, title: 'Intern', descriptionPlain: 'Build', jobUrl: `https://jobs.ashbyhq.com/acme/${uuid}` }] }));
    const acquire = createMetadataAcquirer(fetchImpl);
    const [first, second] = await Promise.all([acquire(identity('ashby')), acquire(identity('ashby', '12345678-1234-1234-1234-123456789012'))]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first?.outcome).toBe('acquired'); expect(second?.outcome).toBe('identity-mismatch');
    expect(fetchImpl.mock.calls[0]).toBeDefined();
  });
  it('rejects HTML, rate limits, invalid JSON and oversized responses', async () => {
    for (const response of [new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), new Response('', { status: 429 }),
      new Response('{', { headers: { 'content-type': 'application/json' } }), new Response(' '.repeat(2_000_001), { headers: { 'content-type': 'application/json' } })]) {
      const result = await createMetadataAcquirer(async () => response)(identity('greenhouse', '123'));
      expect(['failed', 'incomplete']).toContain(result?.outcome); expect(result?.artifact).toBeUndefined();
    }
  });
  it('uses the Worker-supported manual redirect mode and rejects redirect responses', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://unrelated.test/job' } });
    });
    expect(await createMetadataAcquirer(fetchImpl)(identity('greenhouse', '123')))
      .toMatchObject({ outcome: 'failed', status: 302 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('coverage accounting and moved postings', () => {
  it('uses shell-safe round-trippable collection cursors', () => {
    const cursor = encodeMetadataCursor('job-1', 'github-source');
    expect(cursor).not.toContain('\0');
    expect(decodeMetadataCursor(cursor)).toBe('job-1\0github-source');
    expect(() => decodeMetadataCursor('garbage')).toThrow('Invalid metadata cursor');
  });
  it('waits through shells and recognizes loaded descriptions or terminal states', () => {
    expect(renderedDescriptionReady('Software Engineering Intern', 'Loading…')).toBe(false);
    expect(renderedDescriptionReady('Software Engineering Intern', 'Careers '.repeat(100))).toBe(false);
    expect(renderedDescriptionReady('Software Engineering Intern', 'Software Engineering Intern. Build and test software. '.repeat(20))).toBe(true);
    for (const state of ['This job has expired', 'Under maintenance', 'Sign in to continue']) expect(renderedDescriptionReady('Software Engineering Intern', state)).toBe(true);
  });
  it('recovers only one observed same-origin exact-ID path', () => {
    const url = 'https://www.zipline.com/open-roles?gh_jid=7978843003';
    expect(exactPostingRecoveryUrl(url, '7978843003', ['/open-roles/7978843003', '/open-roles/999'])).toBe('https://www.zipline.com/open-roles/7978843003');
    expect(exactPostingRecoveryUrl(url, '7978843003', ['https://other.test/jobs/7978843003'])).toBeUndefined();
    expect(exactPostingRecoveryUrl(url, '7978843003', ['/jobs/7978843003', '/open-roles/7978843003'])).toBeUndefined();
    expect(exactPostingRecoveryUrl(url, '7978843003', ['/open-roles?gh_jid=7978843003'])).toBeUndefined();
  });
  it('does not claim non-disclosure from parser absence or a failed acquisition', () => {
    expect(metadataFieldOutcomes({ evidence: [], acquired: true, complete: true }).compensation).toBe('inspection-pending');
    expect(metadataFieldOutcomes({ evidence: [], acquired: true, complete: false }).compensation).toBe('incomplete-artifact');
    expect(metadataFieldOutcomes({ evidence: [], acquired: false, complete: false }).compensation).toBe('acquisition-failed');
    expect(metadataFieldOutcomes({ evidence: [], acquired: true, complete: true, reviewedAbsent: ['compensation'] }).compensation).toBe('no-disclosure-found');
  });
  it('retains closed or removed cohort members in the denominator', () => {
    expect(compareMetadataCohort([{ jobId: '1' }, { jobId: '2' }], [{ jobId: '1', compensation: { raw: 'USD 40/hour' } }])).toMatchObject({
      denominator: 2, counts: { 'gained-pay': 1, 'removed-or-closed': 1 },
    });
  });
});
