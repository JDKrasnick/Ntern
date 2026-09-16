import { describe, expect, it, vi } from 'vitest';
import { inferLeverSeason, LEVER_BOARD_MAX_BYTES, LEVER_REQUEST_TIMEOUT_MS, LeverPostingsAdapter, leverRequirements, mapLeverPosting, mapLeverSourcedPosting } from '../src/sources/lever.js';
import { extractPostingMetadataEvidence } from '../src/role-metadata.js';
import { syntheticLeverPages } from './fixtures/production-scale.js';

const postingId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const posting = {
  id: postingId(1),
  text: 'Software Engineering Intern, Summer 2027',
  applyUrl: `https://jobs.lever.co/acme/${postingId(1)}/apply`,
  hostedUrl: `https://jobs.lever.co/acme/${postingId(1)}`,
  descriptionPlain: 'Applicants must be a U.S. citizen. A master\'s degree is required.',
  createdAt: 1_783_072_000_000,
  categories: { location: 'New York, NY', commitment: 'Internship' },
  workplaceType: 'hybrid'
};
const options = { id: 'lever-acme', company: 'Acme', site: 'acme' };

describe('LeverPostingsAdapter', () => {
  it.each([['per-hour-wage', 30, 45, 'hourly'], ['per-year-salary', 100000, 140000, 'annual']] as const)(
    'preserves structured %s pay through metadata extraction', (interval, min, max, period) => {
      const mapped = mapLeverSourcedPosting({ ...posting, salaryRange: { currency: 'USD', interval, min, max },
        lists: [{ text: 'Requirements', content: '<li>Must be pursuing a bachelor degree.</li>' }],
        categories: { location: 'New York, NY', allLocations: ['New York, NY', 'Boston, MA'] },
      }, options);
      expect(mapped.locations).toEqual(['New York, NY', 'Boston, MA']);
      expect(mapped.content.some(item => item.value.includes('bachelor degree'))).toBe(true);
      const evidence = extractPostingMetadataEvidence({ exactPosting: true, sourceClass: 'official-ats', sourceId: mapped.sourceId,
        sourceUrl: mapped.sourceUrl, observedAt: mapped.fetchedAt,
        artifact: { title: mapped.title, compensationText: mapped.compensationText, locations: mapped.locations } });
      expect(evidence[0]?.compensationRanges).toHaveLength(1);
      expect(evidence[0]?.compensationRanges?.[0]).toMatchObject({ minAmount: min, maxAmount: max, currency: 'USD', period });
    });
  it.each([
    { currency: 'USD', interval: 'one-time', min: 10000, max: 12000 },
    { currency: 'USD', min: 30, max: 40 },
    { currency: 'USD', interval: 'per-hour-wage', min: 40, max: 30 },
    { currency: 'USD', interval: 'per-hour-wage', max: 30 },
  ])('does not infer missing or unsupported structured pay: %j', salaryRange => {
    expect(mapLeverSourcedPosting({ ...posting, salaryRange }, options).compensationText).toBeUndefined();
  });
  it('retains a separate disclosed salary description', () => {
    expect(mapLeverSourcedPosting({ ...posting, salaryDescriptionPlain: 'Salary: CAD 30 - 40 per hour' }, options)
      .compensationText).toBe('Salary: CAD 30 - 40 per hour');
  });
  it('maps direct application URLs, Lever metadata, requirements, and a named season', () => {
    const mapped = mapLeverPosting(posting, options, '2026-07-20T00:00:00.000Z', 3);
    expect(mapped).toMatchObject({
      sourceId: 'lever-acme', document: postingId(1), sourceUrl: 'https://api.lever.co/v0/postings/acme?mode=json',
      row: 3, company: 'Acme', title: 'Software Engineering Intern, Summer 2027', location: 'New York, NY', season: 'summer-2027',
      applyUrl: `https://jobs.lever.co/acme/${postingId(1)}/apply`, postedAt: '2026-07-03T09:46:40.000Z', workMode: 'hybrid',
      providerTimestamp: { value: '2026-07-03T09:46:40.000Z', semantics: 'published' },
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: true }
    });
  });
  it('uses the shared technical early-career title policy', () => {
    expect(mapLeverPosting({ ...posting, text: 'Finance Intern' }, options)).toBeUndefined();
    expect(mapLeverPosting({ ...posting, text: 'Software Engineer' }, options)).toBeUndefined();
    expect(mapLeverPosting({ ...posting, text: 'Software Engineering Co-op' }, options)).toMatchObject({ title: 'Software Engineering Co-op' });
    expect(mapLeverPosting({ ...posting, text: 'Security Engineering Apprenticeship' }, options)).toMatchObject({ title: 'Security Engineering Apprenticeship' });
    expect(mapLeverPosting({ ...posting, text: 'Software Engineer, New Grad' }, options)).toMatchObject({ title: 'Software Engineer, New Grad' });
    expect(mapLeverPosting({ ...posting, text: 'Entry-Level Data Engineer' }, options)).toMatchObject({ title: 'Entry-Level Data Engineer' });
    expect(mapLeverPosting({ ...posting, text: 'Junior Software Engineer' }, options)).toBeUndefined();
  });
  it('infers named seasons and falls back to ongoing', () => {
    expect(inferLeverSeason('Machine Learning Intern', '2028 graduate internship')).toBe('2028');
    expect(inferLeverSeason('Software Engineering Intern', 'Join our early-career program.')).toBe('ongoing');
  });
  it('detects only source-declared citizenship and degree requirements', () => {
    expect(leverRequirements('Applicants must be U.S. citizens. A Ph.D. is required.')).toEqual({ requiresUsCitizenship: true, advancedDegreeRequired: true });
    expect(leverRequirements('We welcome all citizenships; our founders have master\'s degrees.')).toEqual({ requiresUsCitizenship: false, advancedDegreeRequired: false });
  });
  it('bounds every Lever page fetch with the request timeout signal', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const timeouts: Array<number | undefined> = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds: number) => {
      timeouts.push(milliseconds);
      return new AbortController().signal;
    });
    try {
      const adapter = new LeverPostingsAdapter({
        ...options,
        fetchImpl: async (_url, init) => {
          signals.push(init?.signal ?? undefined);
          return new Response(JSON.stringify([posting]), { status: 200 });
        },
      });

      await expect(adapter.fetch()).resolves.toMatchObject({ notModified: false });
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(timeouts).toEqual([LEVER_REQUEST_TIMEOUT_MS]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('ignores stored ETags and uses the content hash for unchanged boards', async () => {
    const calls: RequestInit[] = [];
    const first = await new LeverPostingsAdapter({ ...options, fetchImpl: async () => new Response(JSON.stringify([posting]), { status: 200 }) }).fetch();
    const adapter = new LeverPostingsAdapter({ ...options, fetchImpl: async (_url, init) => { calls.push(init ?? {}); return new Response(JSON.stringify([posting]), { status: 200, headers: { ETag: 'W/"lever-etag"' } }); } });
    const result = await adapter.fetch({ ...first.checkpoint, etag: 'W/"lever-etag"' });
    expect(result.notModified).toBe(true);
    expect(result.unchangedReason).toBe('content_hash');
    expect(result.conditionalRequest).toEqual({ attempted: false, notModified: false });
    expect(result.checkpoint.etag).toBeUndefined();
    expect(calls[0]?.headers).toEqual({ Accept: 'application/json' });
  });
  it('refetches every page of a multi-page board because one ETag cannot prove the rest unchanged', async () => {
    const calls: RequestInit[] = [];
    const page = Array.from({ length: 100 }, (_, index) => ({
      ...posting,
      id: postingId(index),
      hostedUrl: `https://jobs.lever.co/acme/${postingId(index)}`,
      applyUrl: `https://jobs.lever.co/acme/${postingId(index)}/apply`,
    }));
    const adapter = new LeverPostingsAdapter({
      ...options,
      fetchImpl: async (_url, init) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify(calls.length === 1 ? page : []), { status: 200 });
      },
    });
    const result = await adapter.fetch({ sourceId: options.id, etag: '"lever-etag"', successfulFetches: 2, lastRowCount: 4, lastRawCount: 120 });
    expect(calls.map((call) => call.headers)).toEqual([{ Accept: 'application/json' }, { Accept: 'application/json' }]);
    expect(result.postings).toHaveLength(100);
  });
  it('reads every bounded page and rejects duplicate posting IDs', async () => {
    const urls: string[] = [];
    const page = Array.from({ length: 100 }, (_, index) => ({
      ...posting,
      id: postingId(index),
      hostedUrl: `https://jobs.lever.co/acme/${postingId(index)}`,
      applyUrl: `https://jobs.lever.co/acme/${postingId(index)}/apply`,
    }));
    const adapter = new LeverPostingsAdapter({
      ...options,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify(urls.length === 1 ? page : [{
          ...posting,
          id: postingId(100),
          hostedUrl: `https://jobs.lever.co/acme/${postingId(100)}`,
          applyUrl: `https://jobs.lever.co/acme/${postingId(100)}/apply`,
        }]), { status: 200 });
      },
    });
    const result = await adapter.fetch();
    expect(urls).toEqual([
      'https://api.lever.co/v0/postings/acme?mode=json&skip=0&limit=100',
      'https://api.lever.co/v0/postings/acme?mode=json&skip=100&limit=100',
    ]);
    expect(result.rawCount).toBe(101);
    expect(result.postings).toHaveLength(101);

    const duplicate = new LeverPostingsAdapter({
      ...options,
      fetchImpl: async () => new Response(JSON.stringify([posting, posting]), { status: 200 }),
    });
    await expect(duplicate.fetch()).rejects.toThrow('duplicate posting IDs');
  });
  it('rejects malformed and error responses', async () => {
    const malformed = new LeverPostingsAdapter({ ...options, fetchImpl: async () => new Response('{', { status: 200 }) });
    await expect(malformed.fetch()).rejects.toThrow('malformed JSON');
    const error = new LeverPostingsAdapter({ ...options, fetchImpl: async () => new Response('nope', { status: 502 }) });
    await expect(error.fetch()).rejects.toThrow('Lever fetch failed (502)');
  });
  it('rejects a page that crosses the page ceiling without requesting the next page', async () => {
    const [oversized] = syntheticLeverPages({ pages: 1, postingsPerPage: 100, bytesPerPosting: 43_000 });
    const urls: string[] = [];
    const adapter = new LeverPostingsAdapter({
      ...options,
      fetchImpl: async (url) => { urls.push(String(url)); return new Response(JSON.stringify(oversized), { status: 200 }); },
    });
    await expect(adapter.fetch()).rejects.toMatchObject({
      category: 'capacity',
      message: expect.stringContaining('response body exceeds'),
    });
    expect(urls).toHaveLength(1);
  });
  it('fails a board that crosses the board ceiling only after reading the pages that fit', async () => {
    // Five 3.8 MB pages: every page stays under the page ceiling, so only the
    // accumulated board size can reject this board.
    const pages = syntheticLeverPages({ pages: 5, postingsPerPage: 100, bytesPerPosting: 38_000 });
    let calls = 0;
    const adapter = new LeverPostingsAdapter({
      ...options,
      fetchImpl: async () => new Response(JSON.stringify(pages[calls++] ?? []), { status: 200 }),
    });
    const failure = await adapter.fetch().then(() => undefined, (error: Error) => error);
    expect(failure).toMatchObject({ category: 'capacity' });
    expect(failure?.message).toContain('Lever board exceeds');
    expect(failure?.message).toContain(String(LEVER_BOARD_MAX_BYTES));
    // The fifth page is the one that crossed the ceiling; no sixth page is
    // requested and the delivery fails on capacity rather than pagination.
    expect(calls).toBe(5);
    expect(failure?.message).not.toContain('pagination exceeded');
  });
});
