import { describe, expect, it } from 'vitest';
import { IngestionRunner } from '../src/poll.js';
import { ASHBY_BOARD_MAX_POSTINGS, ASHBY_RESPONSE_MAX_BYTES, AshbyPostingsAdapter, type AshbyPosting } from '../src/sources/ashby.js';
import { SourceFetchError } from '../src/sources/source-error.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { ReviewedSourceRecord } from '../src/sources/reviewed-source.js';
import { syntheticAshbyBoard } from './fixtures/production-scale.js';

const source: ReviewedSourceRecord = {
  id: 'ashby-acme', company: 'Acme', identity: { provider: 'ashby', boardKey: 'Acme', apiRegion: 'global' },
  careersUrl: 'https://acme.test/careers', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
  allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow',
};
const ids = [
  '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666',
];

function row(id = ids[0]!, overrides: Partial<AshbyPosting> = {}): AshbyPosting {
  return {
    id, title: 'Software Engineer Intern', location: 'New York', secondaryLocations: [], isListed: true,
    isRemote: false, workplaceType: 'Hybrid', descriptionHtml: '<p>Build systems.</p>',
    descriptionPlain: 'Plain fallback.', publishedAt: '2026-08-09T12:00:00.000+00:00', employmentType: 'Intern',
    jobUrl: `https://jobs.ashbyhq.com/Acme/${id}`,
    applyUrl: `https://jobs.ashbyhq.com/Acme/${id}/application`,
    ...overrides,
  };
}

const response = (jobs: unknown, init: ResponseInit = {}) => new Response(JSON.stringify({ apiVersion: '1', jobs }), { status: 200, ...init });
const adapter = (jobs: unknown, sourceOverride: ReviewedSourceRecord = source) => new AshbyPostingsAdapter({
  source: sourceOverride, now: () => new Date('2026-08-09T13:00:00.000Z'),
  fetchImpl: (async () => response(jobs)) as typeof fetch,
});

/**
 * Serves `payload` in 64 KiB chunks and reports the bytes the adapter read, so
 * an over-ceiling response is exercised without a second copy of the body being
 * buffered by the test. `highWaterMark: 0` keeps the stream from running ahead
 * of the reader, which makes the byte count exact.
 */
function chunkedResponse(payload: string, chunkBytes = 65_536): { response: Response; pulled: () => number } {
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) { controller.close(); return; }
      const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength));
      offset += chunk.byteLength;
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  return { response: new Response(body), pulled: () => pulled };
}

describe('Ashby public posting adapter', () => {
  it('normalizes structured fields and trusts only explicit Intern employment type', async () => {
    const result = await adapter([
      row(ids[0], {
        title: 'Software Engineer', location: 'New York',
        secondaryLocations: [{ location: 'Toronto' }, { location: 'New York' }, { location: 'Paris' }, { location: 'Toronto' }],
        department: 'Engineering', team: 'Platform', compensation: {
          scrapeableCompensationSalarySummary: '$40 - $50 per hour', compensationTierSummary: '$80K - $100K plus equity',
        },
      }),
      row(ids[1], { title: 'Data Engineer, New Grad', employmentType: 'FullTime', descriptionHtml: null, workplaceType: null, isRemote: true }),
      row(ids[2], { title: 'Backend Engineer', employmentType: 'FullTime' }),
    ]).fetch();

    expect(result.postings[0]).toMatchObject({
      externalId: ids[0], employer: { name: 'Acme', authority: 'reviewed-registry' },
      lifecycleAuthority: 'posting', locations: ['New York', 'Toronto', 'Paris'], declaredWorkMode: 'Hybrid',
      classificationTags: ['Engineering', 'Platform', 'Intern'], compensationText: '$40 - $50 per hour',
      publishedAt: '2026-08-09T12:00:00.000+00:00',
      content: [{ kind: 'description', format: 'html', value: '<p>Build systems.</p>' }],
    });
    expect(result.postings[1]).toMatchObject({ declaredWorkMode: 'Remote', content: [{ format: 'plain', value: 'Plain fallback.' }] });
    expect(result.processed.decisions.map(({ externalId, outcome, reason }) => [externalId, outcome, reason])).toEqual([
      [ids[0], 'included', 'source-policy'], [ids[1], 'included', 'source-policy'], [ids[2], 'filtered', 'not-early-career'],
    ]);
    expect(result.listings.map(({ externalId }) => externalId)).toEqual([ids[0], ids[1]]);
    expect(result.listings[0]?.compensation.maxHourlyUSD).toBe(50);
  });

  it('supports co-op, apprenticeship, explicit entry-level, and new-grad titles but excludes generic and junior titles', async () => {
    const result = await adapter([
      row(ids[0], { title: 'Software Engineering Co-op', employmentType: 'Temporary' }),
      row(ids[1], { title: 'Security Engineering Apprenticeship', employmentType: 'FullTime' }),
      row(ids[2], { title: 'Entry-Level Data Engineer', employmentType: 'FullTime' }),
      row(ids[3], { title: 'Software Engineer, New Grad', employmentType: 'FullTime' }),
      row(ids[4], { title: 'Software Engineer', employmentType: 'FullTime' }),
      row(ids[5], { title: 'Junior Software Engineer', employmentType: 'FullTime' }),
    ]).fetch();
    expect(result.listings.map(({ title }) => title)).toEqual([
      'Software Engineering Co-op', 'Security Engineering Apprenticeship', 'Entry-Level Data Engineer', 'Software Engineer, New Grad',
    ]);
  });

  it('drops unlisted rows before hashing and processing and accepts a listed-empty snapshot', async () => {
    const hidden = row(ids[0], { title: 'Secret Software Intern', isListed: false });
    const empty = await adapter([hidden]).fetch();
    expect(empty).toMatchObject({ rawCount: 0, rawRowCount: 0, postings: [], listings: [] });
    expect(empty.checkpoint.activeExternalIds).toEqual([]);
    expect(JSON.stringify(empty)).not.toContain('Secret Software Intern');
    const directEmpty = await adapter([]).fetch();
    expect(directEmpty.contentHash).toBe(empty.contentHash);
  });

  it('creates a stable listed-only hash and active ID set when API rows are reordered', async () => {
    const rows = [row(ids[0]), row(ids[1], { title: 'Data Engineer Intern' }), row(ids[2], { isListed: false })];
    const first = await adapter(rows).fetch();
    const second = await adapter([rows[2], rows[1], rows[0]]).fetch(first.checkpoint);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second).toMatchObject({ outcome: 'unchanged', notModified: true, unchangedReason: 'content_hash' });
    expect(new Set(second.checkpoint.activeExternalIds)).toEqual(new Set([ids[0], ids[1]]));
  });

  it('withholds one off-allowlist application URL while accepting a reviewed external host', async () => {
    const externalSource = { ...source, allowedApplicationHosts: [
      { host: 'jobs.ashbyhq.com' }, { host: 'careers.acme.test', justification: 'Reviewed form', reviewedAt: '2026-08-09T00:00:00Z' },
    ] };
    const result = await adapter([
      row(ids[0], { applyUrl: 'https://evil.test/apply' }),
      row(ids[1], { applyUrl: 'https://careers.acme.test/apply/role' }),
    ], externalSource).fetch();
    expect(result.rejectedApplicationUrls).toEqual([{ row: 1, url: 'https://evil.test/apply', reason: 'application host evil.test is not a reviewed Ashby destination' }]);
    expect(result.postings.map(({ externalId }) => externalId)).toEqual([ids[1]]);
    expect(result.processed.counts).toMatchObject({ raw: 2, valid: 1, eligible: 1, withheld: 1 });
    expect(result.checkpoint.activeExternalIds).toEqual([ids[0], ids[1]]);
  });

  it.each([
    ['malformed root', null, 'response root was malformed'],
    ['malformed jobs', { apiVersion: '1', jobs: {} }, 'jobs collection was malformed'],
    ['malformed row', { apiVersion: '1', jobs: [{}] }, 'posting row was malformed'],
    ['API version drift', { apiVersion: '2', jobs: [] }, 'API version drifted'],
    ['workplace enum drift', { apiVersion: '1', jobs: [row(ids[0], { workplaceType: 'Flexible' })] }, 'posting row was malformed'],
    ['employment enum drift', { apiVersion: '1', jobs: [row(ids[0], { employmentType: 'Apprentice' })] }, 'posting row was malformed'],
  ])('rejects %s', async (_name, payload, message) => {
    const subject = new AshbyPostingsAdapter({ source, fetchImpl: (async () => new Response(JSON.stringify(payload))) as typeof fetch });
    await expect(subject.fetch()).rejects.toThrow(message);
  });

  it.each([
    [[row(ids[0]), row(ids[0])], 'duplicate posting IDs'],
    [[row(ids[0], { id: 'not-a-uuid' })], 'posting ID was not a UUID'],
    [[row(ids[0], { jobUrl: `https://jobs.ashbyhq.com/acme/${ids[0]}` })], 'job URL did not match'],
    [[row(ids[0], { applyUrl: `https://jobs.ashbyhq.com/Other/${ids[0]}/application` })], 'application URL did not match'],
    [[row(ids[0], { publishedAt: 'not-a-date' })], 'publication date was invalid'],
    [[row(ids[0], { publishedAt: '2026-02-30T12:00:00Z' })], 'publication date was invalid'],
  ])('rejects snapshot identity/schema violations %#', async (rows, message) => {
    await expect(adapter(rows).fetch()).rejects.toThrow(message);
  });

  it('rejects redirects and exposes typed bounded Retry-After information', async () => {
    const redirect = new AshbyPostingsAdapter({ source, fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'https://example.test' } })) as typeof fetch });
    await expect(redirect.fetch()).rejects.toMatchObject({ category: 'identity', retryable: false });
    const limited = new AshbyPostingsAdapter({
      source, now: () => new Date('2026-08-09T00:00:00Z'),
      fetchImpl: (async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })) as typeof fetch,
    });
    await expect(limited.fetch()).rejects.toMatchObject({ category: 'http', status: 429, retryAfterMs: 2000, retryable: true });
    const unavailable = new AshbyPostingsAdapter({
      source, now: () => new Date('2026-08-09T00:00:00Z'),
      fetchImpl: (async () => new Response('maintenance', { status: 503, headers: { 'retry-after': '3' } })) as typeof fetch,
    });
    await expect(unavailable.fetch()).rejects.toMatchObject({ category: 'http', status: 503, retryAfterMs: 3000, retryable: true });
  });

  it.each([
    ['transport', (attempt: number) => { if (attempt < 3) throw new TypeError('offline'); return response([]); }],
    ['429', (attempt: number) => attempt < 3 ? new Response('limited', { status: 429 }) : response([])],
    ['5xx', (attempt: number) => attempt < 3 ? new Response('unavailable', { status: 503 }) : response([])],
  ])('the existing caller makes exactly three attempts for %s failures', async (_name, reply) => {
    let attempts = 0;
    const subject = new AshbyPostingsAdapter({ source, fetchImpl: (async () => reply(++attempts)) as typeof fetch });
    const report = await new IngestionRunner([subject], new MemoryInternshipStore()).run();
    expect(attempts).toBe(3);
    expect(report.failures).toEqual([]);
  });

  it.each([
    ['other 4xx', () => new Response('bad', { status: 400 })],
    ['schema failure', () => new Response(JSON.stringify({ apiVersion: '1', jobs: [{}] }))],
    ['identity failure', () => new Response(JSON.stringify({ apiVersion: '2', jobs: [] }))],
    ['link-contract failure', () => response([row(ids[0], { jobUrl: `https://jobs.ashbyhq.com/Other/${ids[0]}` })])],
  ])('the existing caller makes one attempt for %s', async (_name, reply) => {
    let attempts = 0;
    const subject = new AshbyPostingsAdapter({ source, fetchImpl: (async () => { attempts += 1; return reply(); }) as typeof fetch });
    const report = await new IngestionRunner([subject], new MemoryInternshipStore()).run();
    expect(attempts).toBe(1);
    expect(report.failures).toHaveLength(1);
  });

  it('uses a 15-second abort signal and the exact compensation endpoint', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const subject = new AshbyPostingsAdapter({ source, fetchImpl: (async (url, init) => { request = { url: String(url), init }; return response([]); }) as typeof fetch });
    await subject.fetch();
    expect(request?.url).toBe('https://api.ashbyhq.com/posting-api/job-board/Acme?includeCompensation=true');
    expect(request?.init).toMatchObject({ redirect: 'manual', headers: { Accept: 'application/json' } });
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses SourceFetchError for malformed JSON', async () => {
    const subject = new AshbyPostingsAdapter({ source, fetchImpl: (async () => new Response('{')) as typeof fetch });
    await expect(subject.fetch()).rejects.toBeInstanceOf(SourceFetchError);
  });

  it('stops reading a board response as soon as the streamed body crosses the response ceiling', async () => {
    const { response: body, pulled } = chunkedResponse(JSON.stringify(syntheticAshbyBoard({ postings: 600, bytesPerPosting: 30_000 })));
    const subject = new AshbyPostingsAdapter({ source, fetchImpl: (async () => body) as typeof fetch });
    await expect(subject.fetch()).rejects.toMatchObject({
      category: 'capacity',
      message: expect.stringContaining('response body exceeds'),
    });
    // No Content-Length is declared, so the guard is what stops this body: it
    // gives up within one chunk of the ceiling instead of parsing it.
    expect(pulled()).toBeLessThan(ASHBY_RESPONSE_MAX_BYTES + 2 * 65_536);
  });

  it('admits a board at the posting ceiling and rejects the board one posting above it', async () => {
    const atCap = await adapter(syntheticAshbyBoard({ postings: ASHBY_BOARD_MAX_POSTINGS, bytesPerPosting: 200 }).jobs).fetch();
    expect(atCap.rawCount).toBe(ASHBY_BOARD_MAX_POSTINGS);
    expect(atCap.postings).toHaveLength(ASHBY_BOARD_MAX_POSTINGS);

    await expect(adapter(syntheticAshbyBoard({ postings: ASHBY_BOARD_MAX_POSTINGS + 1, bytesPerPosting: 200 }).jobs).fetch())
      .rejects.toMatchObject({ category: 'capacity', message: expect.stringContaining('postings') });
  });
});
