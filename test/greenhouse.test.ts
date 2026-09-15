import { describe, expect, it } from 'vitest';
import { GREENHOUSE_RESPONSE_MAX_BYTES, GreenhouseBoardAdapter, greenhouseJobsUrl, isGreenhouseJobShape, mapGreenhouseJob } from '../src/sources/greenhouse.js';
import { reconcileRoleMetadata } from '../src/role-metadata.js';
import { enabledGreenhouseQualityPolicies, greenhouseQualityPolicy, verifySourceQuality } from '../src/sources/quality.js';
import { defaultSources } from '../src/sources/index.js';
import { validateApplicationUrl, ApplicationUrlValidationError } from '../src/core/application-url.js';
import {
  acmeJobsResponse,
  acmeSource,
  globexSource,
  nontechnicalInternship,
  prospectPost,
  technicalFullTime,
  technicalInternship,
} from './fixtures/greenhouse.js';

function jsonResponse(body: unknown, init: { status?: number; url?: string; etag?: string } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.etag) headers.etag = init.etag;
  const response = new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
}

describe('mapGreenhouseJob', () => {
  it('maps a technical internship with canonical company and decoded content', () => {
    const mapped = mapGreenhouseJob(technicalInternship, acmeSource, '2026-07-25T00:00:00.000Z', 3);
    expect(mapped).toMatchObject({
      sourceId: 'greenhouse-acmerobotics',
      document: '5001',
      sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs?content=true',
      row: 3,
      company: 'Acme Robotics',
      title: 'Software Engineering Intern, Summer 2027',
      location: 'New York, NY (Hybrid)',
      season: 'summer-2027',
      applyUrl: 'https://job-boards.greenhouse.io/acmerobotics/jobs/5001',
      postedAt: '2026-07-20T12:00:00.000Z',
      providerTimestamp: { value: '2026-07-20T12:00:00.000Z', semantics: 'updated' },
      workMode: 'hybrid',
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false },
    });
    expect(mapped?.compensation.maxHourlyUSD).toBe(45);
  });
  it('excludes prospect posts, nontechnical internships, and description-only lifecycle bait', () => {
    expect(mapGreenhouseJob(prospectPost, acmeSource)).toBeUndefined();
    expect(mapGreenhouseJob(nontechnicalInternship, acmeSource)).toBeUndefined();
    expect(mapGreenhouseJob(technicalFullTime, acmeSource)).toBeUndefined();
  });
  it('falls back to Unspecified when no location is present', () => {
    const mapped = mapGreenhouseJob({ ...technicalInternship, location: null }, acmeSource);
    expect(mapped?.location).toBe('Unspecified');
  });
  it('promotes a role using department context but never company from the response', () => {
    const mapped = mapGreenhouseJob(
      { ...technicalInternship, title: 'Platform Intern', content: '&lt;p&gt;Great team.&lt;/p&gt;', departments: [{ name: 'Software Engineering' }] },
      { ...acmeSource, displayName: 'Acme Robotics' },
    );
    expect(mapped?.company).toBe('Acme Robotics');
    expect(mapped?.title).toBe('Platform Intern');
  });
});

describe('GreenhouseBoardAdapter', () => {
  it.each([
    ['Product Management Intern (Summer 2027)', 6883068002, '$54 — $56 USD', '$51.50 — $53.50 USD', 56, 53.5],
    ['Software Engineering Intern (2027 Start) - Winter', 8732364002, '$54 — $60 USD', '$51.50 — $60 USD', 60, 60],
  ])('preserves Databricks regional pay rows from the board path for %s', async (title, id, sfPay, bellevuePay, sfMax, bellevueMax) => {
    const source = { ...acmeSource, id: 'greenhouse-databricks', boardToken: 'databricks', displayName: 'Databricks' };
    const content = `&lt;p&gt;Pay Range Transparency&lt;/p&gt;
      &lt;p&gt;SF Bay Area Hourly Rate&lt;/p&gt;&lt;p&gt;${sfPay}&lt;/p&gt;
      &lt;p&gt;Pay Range Transparency&lt;/p&gt;
      &lt;p&gt;Bellevue, Washington Hourly Rate&lt;/p&gt;&lt;p&gt;${bellevuePay}&lt;/p&gt;`;
    const adapter = new GreenhouseBoardAdapter({ source, fetchImpl: async () => jsonResponse({ jobs: [{
      id, internal_job_id: 1, title, content,
      absolute_url: `https://job-boards.greenhouse.io/databricks/jobs/${id}`,
      location: { name: 'Bellevue, Washington; Mountain View, California; San Francisco, California' },
    }] }) });

    const result = await adapter.fetch();
    const reconciliation = reconcileRoleMetadata(result.listings[0]!.metadataEvidence ?? []);
    expect(reconciliation.conflicts).toEqual([]);
    expect(reconciliation.compensation?.ranges).toHaveLength(2);
    expect(reconciliation.compensation?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 54, maxAmount: sfMax, currency: 'USD', period: 'hourly', applicabilityLabel: 'SF Bay Area Hourly Rate' }),
      expect.objectContaining({ minAmount: 51.5, maxAmount: bellevueMax, currency: 'USD', period: 'hourly', applicabilityLabel: 'Bellevue, Washington Hourly Rate' }),
    ]));
  });

  it('does not infer a currency for a labeled Greenhouse board range containing only bare dollar signs', async () => {
    const content = '&lt;p&gt;Seattle Hourly Rate&lt;/p&gt;&lt;p&gt;$30 — $40&lt;/p&gt;';
    const adapter = new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => jsonResponse({ jobs: [{
      ...technicalInternship, content,
    }] }) });
    const result = await adapter.fetch();
    expect(reconcileRoleMetadata(result.listings[0]!.metadataEvidence ?? []).compensation?.ranges).toMatchObject([
      { minAmount: 30, maxAmount: 40, currency: 'XXX', period: 'hourly', applicabilityLabel: 'Seattle Hourly Rate' },
    ]);
  });

  it('does not turn an amount following a non-pay label into a structured salary band', async () => {
    const adapter = new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => jsonResponse({ jobs: [{
      ...technicalInternship, content: '&lt;p&gt;Benefits allowance&lt;/p&gt;&lt;p&gt;$30 — $40 USD&lt;/p&gt;',
    }] }) });
    const result = await adapter.fetch();
    expect(reconcileRoleMetadata(result.listings[0]!.metadataEvidence ?? []).compensation).toBeUndefined();
  });

  it('maps a full board, excludes ineligible rows, and records an ETag', async () => {
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => jsonResponse(acmeJobsResponse, { etag: 'W/"acme-1"', url: greenhouseJobsUrl(acmeSource.boardToken) }),
      now: () => new Date('2026-07-25T00:00:00.000Z'),
    });
    const result = await adapter.fetch();
    expect(result.notModified).toBe(false);
    expect(result.rawRowCount).toBe(4);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({ document: '5001', row: 1 });
    expect(result.checkpoint).toMatchObject({ sourceId: 'greenhouse-acmerobotics', etag: 'W/"acme-1"', successfulFetches: 1, lastRowCount: 1 });
  });
  it('honors 304 without parsing and preserves the prior checkpoint', async () => {
    const calls: RequestInit[] = [];
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async (_url, init) => { calls.push(init ?? {}); return new Response(null, { status: 304 }); },
      now: () => new Date('2026-07-25T00:00:00.000Z'),
    });
    const result = await adapter.fetch({ sourceId: acmeSource.id, etag: 'W/"acme-1"', successfulFetches: 4, lastRowCount: 1 });
    expect(result.notModified).toBe(true);
    expect(result.unchangedReason).toBe('not_modified');
    expect(result.conditionalRequest).toEqual({ attempted: true, notModified: true, validatorChanged: false });
    expect(result.listings).toEqual([]);
    expect(result.checkpoint).toMatchObject({ successfulFetches: 4 });
    expect((calls[0]?.headers as Record<string, string>)['If-None-Match']).toBe('W/"acme-1"');
  });
  it('reports sanitized validator changes without exposing validator values', async () => {
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => jsonResponse(acmeJobsResponse, { etag: 'W/"acme-2"' }),
    });
    const result = await adapter.fetch({ sourceId: acmeSource.id, etag: 'W/"acme-1"', successfulFetches: 1 });
    expect(result.conditionalRequest).toEqual({ attempted: true, notModified: false, validatorChanged: true });
  });
  it('produces a stable content hash regardless of job order', async () => {
    const forward = await new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => jsonResponse(acmeJobsResponse) }).fetch();
    const reversed = await new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => jsonResponse({ ...acmeJobsResponse, jobs: [...(acmeJobsResponse.jobs ?? [])].reverse() }),
    }).fetch();
    expect(forward.checkpoint.contentHash).toBe(reversed.checkpoint.contentHash);
  });
  it('reports an aggregator apply URL as a rejected link instead of publishing it', async () => {
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => jsonResponse({ jobs: [{ ...technicalInternship, absolute_url: 'https://www.linkedin.com/jobs/5001' }] }),
    });
    const result = await adapter.fetch();
    expect(result.listings).toHaveLength(0);
    expect(result.rejectedApplicationUrls?.[0]).toMatchObject({ row: 1, reason: expect.stringContaining('aggregator') });
  });
  it('withholds an off-allowlist apply host at the row level', async () => {
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => jsonResponse({ jobs: [{ ...technicalInternship, absolute_url: 'https://apply.evil.test/5001' }] }),
    });
    const result = await adapter.fetch();
    expect(result.listings).toHaveLength(0);
    expect(result.rejectedApplicationUrls?.[0]).toMatchObject({ row: 1, reason: expect.stringContaining('not a reviewed Greenhouse destination') });
  });
  it('rejects bad status, malformed JSON, and invalid response shape', async () => {
    await expect(new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => new Response('nope', { status: 502 }) }).fetch()).rejects.toThrow('fetch failed (502)');
    await expect(new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => new Response('{', { status: 200 }) }).fetch()).rejects.toThrow('malformed JSON');
    await expect(new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => jsonResponse({ jobs: 'nope' }) }).fetch()).rejects.toThrow('shape was invalid');
  });
  it('rejects an oversized declared Greenhouse response before reading it', async () => {
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => new Response('{"jobs":[]}', {
        headers: { 'content-length': String(GREENHOUSE_RESPONSE_MAX_BYTES + 1) },
      }),
    });
    await expect(adapter.fetch()).rejects.toThrow('response body exceeds');
  });
  it('keeps a board transfer that fails mid-body retryable instead of quarantining it as schema drift', async () => {
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jobs":['));
          controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        },
      })),
    });
    await expect(adapter.fetch()).rejects.toMatchObject({
      category: 'transport',
      retryable: true,
      message: expect.stringContaining('The operation was aborted due to timeout'),
    });
  });
  it('keeps a board body that ends short of its declared length retryable', async () => {
    const body = '{"jobs":[]}';
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => new Response(body.slice(0, 5), { headers: { 'content-length': String(body.length) } }),
    });
    await expect(adapter.fetch()).rejects.toMatchObject({
      category: 'transport',
      retryable: true,
      message: `greenhouse-acmerobotics: Greenhouse response body ended after 5 of ${body.length} declared bytes`,
    });
  });
  it('still quarantines a complete board body the provider sent as invalid JSON', async () => {
    const body = '{"jobs":[';
    const adapter = new GreenhouseBoardAdapter({
      source: acmeSource,
      fetchImpl: async () => new Response(body, { headers: { 'content-length': String(body.length) } }),
    });
    await expect(adapter.fetch()).rejects.toMatchObject({
      category: 'json',
      retryable: false,
      message: 'greenhouse-acmerobotics: Greenhouse returned malformed JSON',
    });
  });
  it('rejects a wrongly-typed job row as an invalid response shape', async () => {
    const cases = [
      { ...technicalInternship, departments: 'engineering' },
      { ...technicalInternship, updated_at: 'not-a-date' },
      { ...technicalInternship, title: 42 },
      { ...technicalInternship, location: 'New York' },
      null,
    ];
    for (const bad of cases) {
      await expect(
        new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => jsonResponse({ jobs: [bad] }) }).fetch(),
      ).rejects.toThrow('shape was invalid');
    }
  });
  it('changes the content hash when any published field other than title changes', async () => {
    const base = await new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => jsonResponse(acmeJobsResponse) }).fetch();
    const mutations: Array<(job: typeof technicalInternship) => typeof technicalInternship> = [
      (job) => ({ ...job, content: '&lt;p&gt;An entirely different description.&lt;/p&gt;' }),
      (job) => ({ ...job, location: { name: 'Austin, TX' } }),
      (job) => ({ ...job, departments: [{ name: 'Robotics' }] }),
      (job) => ({ ...job, offices: [{ name: 'Austin' }] }),
      (job) => ({ ...job, internal_job_id: null }),
    ];
    for (const mutate of mutations) {
      const jobs = [mutate(technicalInternship), nontechnicalInternship, technicalFullTime, prospectPost];
      const mutated = await new GreenhouseBoardAdapter({ source: acmeSource, fetchImpl: async () => jsonResponse({ ...acmeJobsResponse, jobs }) }).fetch();
      expect(mutated.checkpoint.contentHash).not.toBe(base.checkpoint.contentHash);
    }
  });
});

describe('isGreenhouseJobShape', () => {
  it('accepts documented shapes and rejects wrongly-typed fields', () => {
    expect(isGreenhouseJobShape(technicalInternship)).toBe(true);
    expect(isGreenhouseJobShape(prospectPost)).toBe(true);
    expect(isGreenhouseJobShape({ ...technicalInternship, offices: undefined })).toBe(true);
    expect(isGreenhouseJobShape({ ...technicalInternship, updated_at: 'not-a-date' })).toBe(false);
    expect(isGreenhouseJobShape({ ...technicalInternship, location: 42 })).toBe(false);
    expect(isGreenhouseJobShape({ ...technicalInternship, departments: [{ name: 5 }] })).toBe(false);
    expect(isGreenhouseJobShape(null)).toBe(false);
    expect(isGreenhouseJobShape([])).toBe(false);
  });
});

describe('greenhouse source quality policy', () => {
  const policy = greenhouseQualityPolicy(acmeSource);
  it('withholds an off-allowlist destination per role without failing the source', () => {
    const good = mapGreenhouseJob(technicalInternship, acmeSource, '2026-07-25T00:00:00.000Z', 1)!;
    const bad = { ...good, row: 2, applyUrl: 'https://apply.evil.test/5001' };
    const report = verifySourceQuality([{ policy, result: { sourceId: acmeSource.id, listings: [good, bad], notModified: false } }]);
    expect(report.failures).toEqual([]);
    expect(report.sources[0]?.rejectedUrls).toEqual([
      expect.objectContaining({ row: 2, url: 'https://apply.evil.test/5001', reason: expect.stringContaining('not a reviewed Greenhouse destination') }),
    ]);
  });
  it('registers a quality policy only for enabled (published) boards', () => {
    const policies = enabledGreenhouseQualityPolicies([
      { ...acmeSource, status: 'shadow' },
      { ...globexSource, status: 'published' },
    ]);
    expect(policies.map((entry) => entry.id)).toEqual(['greenhouse-globex']);
  });
});

describe('validateApplicationUrl with a source policy', () => {
  const policy = { allowedInitialHosts: acmeSource.allowedInitialHosts, allowedFinalHosts: acmeSource.allowedFinalHosts };
  it('accepts a legacy boards.greenhouse.io URL that redirects to job-boards.greenhouse.io', async () => {
    const fetcher = async () => { const r = new Response(null, { status: 200 }); Object.defineProperty(r, 'url', { value: 'https://job-boards.greenhouse.io/acmerobotics/jobs/5001' }); return r; };
    await expect(validateApplicationUrl('https://boards.greenhouse.io/acmerobotics/jobs/5001', fetcher, policy)).resolves.toBe('https://job-boards.greenhouse.io/acmerobotics/jobs/5001');
  });
  it('rejects a resolved host outside the final allowlist', async () => {
    const fetcher = async () => { const r = new Response(null, { status: 200 }); Object.defineProperty(r, 'url', { value: 'https://apply.evil.test/5001' }); return r; };
    await expect(validateApplicationUrl('https://boards.greenhouse.io/acmerobotics/jobs/5001', fetcher, policy)).rejects.toBeInstanceOf(ApplicationUrlValidationError);
  });
  it('rejects an initial host outside the source allowlist before any request', async () => {
    let called = false;
    const fetcher = async () => { called = true; return new Response(null, { status: 200 }); };
    await expect(validateApplicationUrl('https://random.test/5001', fetcher, policy)).rejects.toThrow('not an approved source host');
    expect(called).toBe(false);
  });
  it('rejects an aggregator host under policy before any request', async () => {
    let called = false;
    const fetcher = async () => { called = true; return new Response(null, { status: 200 }); };
    await expect(validateApplicationUrl('https://www.linkedin.com/jobs/5001', fetcher, policy)).rejects.toThrow('aggregator');
    expect(called).toBe(false);
  });
  it('accepts a documented custom careers host', async () => {
    const fetcher = async () => { const r = new Response(null, { status: 200 }); Object.defineProperty(r, 'url', { value: 'https://careers.globex.test/jobs/1' }); return r; };
    await expect(validateApplicationUrl('https://careers.globex.test/jobs/1', fetcher, { allowedInitialHosts: globexSource.allowedInitialHosts, allowedFinalHosts: globexSource.allowedFinalHosts })).resolves.toBe('https://careers.globex.test/jobs/1');
  });
  it('stays backward compatible without a policy (no host enforcement)', async () => {
    const fetcher = async () => { const r = new Response(null, { status: 200 }); Object.defineProperty(r, 'url', { value: 'https://anything.test/x' }); return r; };
    await expect(validateApplicationUrl('https://anything.test/x', fetcher)).resolves.toBe('https://anything.test/x');
  });
});

describe('greenhouse adapter registration', () => {
  it('keeps queued Greenhouse boards out of the general poll Lambda', () => {
    const greenhouse = defaultSources.filter((source) => source.id.startsWith('greenhouse-'));
    expect(greenhouse).toEqual([]);
  });
});
