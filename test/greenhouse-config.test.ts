import { describe, expect, it } from 'vitest';
import {
  admitGreenhouseSource,
  assertReviewedGreenhouseRegistry,
  boardIdentityUrl,
  findReviewedGreenhouseSource,
  hostMatchesAllowlist,
  matchesExpectedBoardName,
  normalizeEmployerLookup,
  reviewedGreenhouseSources,
  reviewedSourceConfigError,
  validateBoardToken,
  type ReviewedGreenhouseSource,
} from '../src/sources/greenhouse-config.js';

const acme: ReviewedGreenhouseSource = {
  id: 'greenhouse-acmerobotics',
  employerId: 'acme-robotics',
  displayName: 'Acme Robotics, Inc.',
  aliases: ['Acme', 'ACME Robotics'],
  boardToken: 'acmerobotics',
  careersUrl: 'https://careers.acme.test',
  expectedBoardNames: ['Acme Robotics'],
  admittedBoardName: 'Acme Robotics',
  admittedAt: '2026-07-24T18:00:00Z',
  allowedInitialHosts: ['boards.greenhouse.io', 'careers.acme.test'],
  allowedFinalHosts: ['job-boards.greenhouse.io', 'careers.acme.test'],
  status: 'shadow',
  hostExceptionReason: 'Acme hosts its official apply flow on careers.acme.test.',
};
const globex: ReviewedGreenhouseSource = {
  id: 'greenhouse-globex',
  employerId: 'globex',
  displayName: 'Globex Corporation',
  aliases: ['Globex'],
  boardToken: 'globex',
  careersUrl: 'https://boards.greenhouse.io/globex',
  expectedBoardNames: ['Globex Corporation'],
  admittedBoardName: 'Globex Corporation',
  admittedAt: '2026-07-24T18:00:00Z',
  allowedInitialHosts: ['boards.greenhouse.io'],
  allowedFinalHosts: ['job-boards.greenhouse.io'],
  status: 'shadow',
};
const registry = [acme, globex];

function jsonResponse(body: unknown, url: string, status = 200): Response {
  const response = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('reviewed Greenhouse registry', () => {
  it('keeps the published inventory plus reviewed shadow additions', () => {
    expect(reviewedGreenhouseSources).toHaveLength(182);
    expect(reviewedGreenhouseSources.slice(0, 3).map((source) => source.id)).toEqual(['greenhouse-figma', 'greenhouse-datadog', 'greenhouse-cloudflare']);
    expect(reviewedGreenhouseSources.filter((source) => source.status === 'published')).toHaveLength(163);
    expect(reviewedGreenhouseSources.filter((source) => source.status === 'shadow')).toHaveLength(19);
    expect(reviewedGreenhouseSources.filter((source) => source.evidenceStatus === 'reviewed')).toHaveLength(22);
    expect(reviewedGreenhouseSources.filter((source) => source.evidenceStatus === 'api-probed')).toHaveLength(160);
  });

  it('keeps every future reviewed entry within the admission contract', () => {
    const seenIds = new Set<string>();
    const seenTokens = new Set<string>();
    for (const source of reviewedGreenhouseSources) {
      expect(source.id).toBe(`greenhouse-${source.boardToken}`);
      expect(source.employerId.trim()).not.toBe('');
      expect(source.displayName.trim()).not.toBe('');
      expect(source.aliases).not.toHaveLength(0);
      expect(validateBoardToken(source.boardToken)).toBe(true);
      expect(new URL(source.careersUrl).protocol).toBe('https:');
      expect(source.expectedBoardNames.every((name) => name.trim() !== '')).toBe(true);
      expect(matchesExpectedBoardName(source.admittedBoardName, source.expectedBoardNames)).toBe(true);
      expect(Number.isNaN(Date.parse(source.admittedAt))).toBe(false);
      expect(source.allowedInitialHosts).not.toHaveLength(0);
      expect(source.allowedFinalHosts).not.toHaveLength(0);
      const applicationHosts = [...source.allowedInitialHosts, ...source.allowedFinalHosts];
      for (const host of applicationHosts) {
        expect(new URL(`https://${host}`).hostname).toBe(host.toLowerCase());
      }
      if (applicationHosts.some((host) => !hostMatchesAllowlist(host, ['greenhouse.io']))) {
        expect(source.hostExceptionReason?.trim()).not.toBe('');
      }
      expect(source.status === 'shadow' || source.status === 'published').toBe(true);
      expect(source.evidenceStatus === 'reviewed' || source.evidenceStatus === 'api-probed').toBe(true);
      expect(seenIds.has(source.id)).toBe(false);
      expect(seenTokens.has(source.boardToken)).toBe(false);
      seenIds.add(source.id);
      seenTokens.add(source.boardToken);
    }
  });
});

describe('validateBoardToken', () => {
  it.each([
    ['acmerobotics', true],
    ['acme-robotics', true],
    ['acme_robotics', true],
    ['a1', true],
    ['', false],
    ['Acme', false],
    ['acme/robotics', false],
    ['https://boards-api.greenhouse.io/v1/boards/acme', false],
    ['acme?content=true', false],
    ['acme#frag', false],
    ['acme robotics', false],
    ['-acme', false],
  ])('validates %s as %s', (value, expected) => {
    expect(validateBoardToken(value)).toBe(expected);
  });
});

describe('normalizeEmployerLookup', () => {
  it.each([
    ['Acme Robotics', 'acme robotics'],
    ['  ACME   Robotics  ', 'acme robotics'],
    ['Açmé Rôbötics', 'acme robotics'],
    ['Acme Robotics, Inc.', 'acme robotics'],
    ['Globex Corporation', 'globex'],
    ['Datadog, Inc.', 'datadog'],
    ['LLC', 'llc'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(normalizeEmployerLookup(value)).toBe(expected);
  });
});

describe('matchesExpectedBoardName', () => {
  it('compares folded names exactly against the reviewed allowlist', () => {
    expect(matchesExpectedBoardName('Acme Robotics', ['Acme Robotics'])).toBe(true);
    expect(matchesExpectedBoardName('  acme   robotics ', ['Acme Robotics'])).toBe(true);
    expect(matchesExpectedBoardName('Açmé Robotics', ['Acme Robotics'])).toBe(true);
    expect(matchesExpectedBoardName('Acme Robotics, Inc.', ['Acme Robotics'])).toBe(false);
    expect(matchesExpectedBoardName('Acme', ['Acme Robotics'])).toBe(false);
    expect(matchesExpectedBoardName('', ['Acme Robotics'])).toBe(false);
  });
});

describe('findReviewedGreenhouseSource', () => {
  it('resolves an exact source ID', () => {
    expect(findReviewedGreenhouseSource('greenhouse-acmerobotics', registry)).toEqual({ status: 'found', source: acme });
  });
  it('resolves an explicit alias, display name, and employer ID', () => {
    expect(findReviewedGreenhouseSource('acme', registry)).toEqual({ status: 'found', source: acme });
    expect(findReviewedGreenhouseSource('Acme Robotics, Inc.', registry)).toEqual({ status: 'found', source: acme });
    expect(findReviewedGreenhouseSource('acme-robotics', registry)).toEqual({ status: 'found', source: acme });
  });
  it('returns unknown for unmatched input and empty input', () => {
    expect(findReviewedGreenhouseSource('initech', registry)).toEqual({ status: 'unknown' });
    expect(findReviewedGreenhouseSource('   ', registry)).toEqual({ status: 'unknown' });
  });
  it('returns ambiguous when an alias maps to multiple sources', () => {
    const shared: ReviewedGreenhouseSource = { ...globex, id: 'greenhouse-globex2', boardToken: 'globex2', aliases: ['Acme'] };
    const result = findReviewedGreenhouseSource('acme', [acme, shared]);
    expect(result).toEqual({ status: 'ambiguous', candidates: [acme, shared] });
  });
});

describe('hostMatchesAllowlist', () => {
  it('accepts exact hosts and dot-boundary subdomains', () => {
    expect(hostMatchesAllowlist('greenhouse.io', ['greenhouse.io'])).toBe(true);
    expect(hostMatchesAllowlist('job-boards.greenhouse.io', ['greenhouse.io'])).toBe(true);
    expect(hostMatchesAllowlist('CAREERS.ACME.TEST', ['careers.acme.test'])).toBe(true);
  });
  it('rejects suffix-boundary spoofing', () => {
    expect(hostMatchesAllowlist('greenhouse.io.evil.test', ['greenhouse.io'])).toBe(false);
    expect(hostMatchesAllowlist('notgreenhouse.io', ['greenhouse.io'])).toBe(false);
    expect(hostMatchesAllowlist('evilgreenhouse.io', ['greenhouse.io'])).toBe(false);
  });
});

describe('admitGreenhouseSource', () => {
  const url = boardIdentityUrl(acme.boardToken);
  it('calls only the fixed, encoded Greenhouse identity endpoint', async () => {
    let requestedUrl: string | undefined;
    let request: RequestInit | undefined;
    await admitGreenhouseSource(acme, async (input, init) => {
      requestedUrl = String(input);
      request = init;
      return jsonResponse({ name: 'Acme Robotics' }, url);
    });
    expect(requestedUrl).toBe('https://boards-api.greenhouse.io/v1/boards/acmerobotics');
    expect(request).toMatchObject({ headers: { Accept: 'application/json' } });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });
  it('admits a board whose returned name matches', async () => {
    const result = await admitGreenhouseSource(acme, async () => jsonResponse({ name: 'Acme Robotics', jobs: [] }, url));
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toMatchObject({ sourceId: acme.id, returnedName: 'Acme Robotics', matchedName: true });
  });
  it('rejects a board-name mismatch', async () => {
    const result = await admitGreenhouseSource(acme, async () => jsonResponse({ name: 'Initech' }, url));
    expect(result).toMatchObject({ ok: false, reason: 'name-mismatch' });
  });
  it('rejects a 404 token', async () => {
    const result = await admitGreenhouseSource(acme, async () => jsonResponse({}, url, 404));
    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
  });
  it.each([400, 401, 429, 500])('rejects an unexpected HTTP %i response', async (status) => {
    const result = await admitGreenhouseSource(acme, async () => jsonResponse({}, url, status));
    expect(result).toMatchObject({ ok: false, reason: 'http-error', diagnostics: { status } });
  });
  it('rejects malformed JSON', async () => {
    const result = await admitGreenhouseSource(acme, async () => {
      const response = new Response('{', { status: 200 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    });
    expect(result).toMatchObject({ ok: false, reason: 'malformed-json' });
  });
  it('rejects an unapproved response host', async () => {
    const result = await admitGreenhouseSource(acme, async () => jsonResponse({ name: 'Acme Robotics' }, 'https://boards-api.greenhouse.io.evil.test/v1/boards/acmerobotics'));
    expect(result).toMatchObject({ ok: false, reason: 'unapproved-response-host' });
  });
  it('uses the reviewed endpoint as the response-host fallback', async () => {
    const response = new Response(JSON.stringify({ name: 'Acme Robotics' }), { status: 200 });
    const result = await admitGreenhouseSource(acme, async () => response);
    expect(result).toMatchObject({ ok: true, diagnostics: { resolvedHost: 'boards-api.greenhouse.io' } });
  });
  it('rejects an invalid configured token without a request', async () => {
    let called = false;
    const result = await admitGreenhouseSource({ ...acme, boardToken: 'Acme/Robotics' }, async () => { called = true; return jsonResponse({ name: 'Acme Robotics' }, url); });
    expect(result).toMatchObject({ ok: false, reason: 'invalid-token' });
    expect(called).toBe(false);
  });
  it('rejects a cast-bypassed malformed config without a request', async () => {
    let called = false;
    const result = await admitGreenhouseSource({ ...acme, allowedFinalHosts: [] }, async () => { called = true; return jsonResponse({ name: 'Acme Robotics' }, url); });
    expect(result).toMatchObject({ ok: false, reason: 'invalid-config' });
    expect(result.diagnostics.configError).toContain('allowedFinalHosts');
    expect(called).toBe(false);
  });
  it('returns an inconclusive transport error rather than throwing', async () => {
    const result = await admitGreenhouseSource(acme, async () => { throw new DOMException('timed out', 'TimeoutError'); });
    expect(result).toMatchObject({ ok: false, reason: 'transport-error', inconclusive: true });
    expect(result.diagnostics.transportError).toBe('TimeoutError');
  });
});

describe('reviewedSourceConfigError', () => {
  it('accepts a well-formed source', () => {
    expect(reviewedSourceConfigError(acme)).toBeUndefined();
  });
  it.each([
    [{ ...acme, id: 'greenhouse-wrong' }, 'id must equal'],
    [{ ...acme, employerId: ' ' }, 'employerId is empty'],
    [{ ...acme, aliases: [] }, 'aliases must not be empty'],
    [{ ...acme, careersUrl: 'http://careers.acme.test' }, 'careersUrl must be https'],
    [{ ...acme, expectedBoardNames: [] }, 'expectedBoardNames'],
    [{ ...acme, admittedBoardName: 'Other' }, 'admittedBoardName'],
    [{ ...acme, admittedAt: '2026-07-24' }, 'admittedAt'],
    [{ ...acme, allowedInitialHosts: [] }, 'allowedInitialHosts'],
    [{ ...acme, allowedInitialHosts: ['careers.example.test'], hostExceptionReason: undefined }, 'hostExceptionReason'],
  ] satisfies [ReviewedGreenhouseSource, string][])('rejects %o', (source, fragment) => {
    expect(reviewedSourceConfigError(source)).toContain(fragment);
  });
});

describe('assertReviewedGreenhouseRegistry', () => {
  it('accepts the empty checked-in registry', () => {
    expect(assertReviewedGreenhouseRegistry()).toBe(reviewedGreenhouseSources);
  });
  it('throws on a malformed entry', () => {
    expect(() => assertReviewedGreenhouseRegistry([{ ...acme, expectedBoardNames: [''] }])).toThrow(/expectedBoardNames/);
  });
  it('throws on a duplicate board token', () => {
    expect(() => assertReviewedGreenhouseRegistry([acme, { ...acme, id: 'greenhouse-acmerobotics' }])).toThrow(/Duplicate/);
  });
});
