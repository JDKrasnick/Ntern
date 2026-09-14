import { describe, expect, it } from 'vitest';
import { buildLeverCandidateLedger, leverSiteFromApplicationUrl, validateLeverSite } from '../src/sources/lever-ledger.js';
import { probeLeverCandidate } from '../src/sources/lever-probe.js';
import {
  admissibleLeverEvidence,
  evidenceViolations,
  excerptProvesSite,
  LEVER_ADMISSIBLE_OWNERSHIP_STATES,
  LEVER_OWNERSHIP_STATES,
  reviewedSourceFromEvidence,
  type LeverOwnershipEvidence,
} from '../src/sources/lever-evidence.js';
import { collectLeverManifestViolations, summariseLeverManifest, type LeverManifestFs } from '../src/sources/lever-manifest.js';
import { recheckLeverEvidence } from '../src/sources/lever-reverify.js';
import { reviewedLeverSources } from '../src/sources/lever-config.js';
import { sourceQualityPolicies, type SourceQualityPolicy } from '../src/sources/quality.js';

const evidence = (overrides: Partial<LeverOwnershipEvidence> = {}): LeverOwnershipEvidence => ({
  site: 'cirrus',
  displayName: 'Cirrus Logic',
  careersUrl: 'https://www.cirrus.com/careers/',
  firstPartyEvidenceUrl: 'https://www.cirrus.com/careers/',
  evidenceExcerpt: '<a href="https://jobs.lever.co/cirrus">View openings</a>',
  observedJobUrl: 'https://jobs.lever.co/cirrus/2f1cabcd/apply',
  initialHosts: ['jobs.lever.co'],
  region: 'global',
  state: 'ownership-verified',
  verifiedAt: '2026-07-29T00:00:00Z',
  ...overrides,
});

function fakeFs(files: Record<string, unknown>): LeverManifestFs {
  return {
    listSiteDirs: (root) => [...new Set(
      Object.keys(files)
        .filter((path) => path.startsWith(`${root}/`))
        .map((path) => path.slice(root.length + 1).split('/')[0]),
    )],
    fileExists: (path) => path in files,
    readJson: (path) => {
      if (!(path in files)) throw new Error(`missing ${path}`);
      const value = files[path];
      if (value === 'INVALID_JSON') throw new SyntaxError('bad json');
      return value;
    },
  };
}

const policiesFor = (ids: string[]): SourceQualityPolicy[] =>
  ids.map((id) => ({ id, sourceClass: 'lever', leverSite: id.replace(/^lever-/, '') }));

describe('lever candidate ledger', () => {
  it('reads the site out of an observed posting URL', () => {
    expect(leverSiteFromApplicationUrl('https://jobs.lever.co/geocomply-2/abc/apply')).toBe('geocomply-2');
    expect(leverSiteFromApplicationUrl('https://jobs.lever.co/tomtom/abc')).toBe('tomtom');
    expect(leverSiteFromApplicationUrl('https://jobs.lever.co/cirrus')).toBe('cirrus');
  });

  it('refuses URLs that are not Lever application URLs', () => {
    expect(leverSiteFromApplicationUrl('http://jobs.lever.co/cirrus/abc/apply')).toBeUndefined();
    expect(leverSiteFromApplicationUrl('https://jobs.eu.lever.co/cirrus/abc/apply')).toBeUndefined();
    expect(leverSiteFromApplicationUrl('https://boards.greenhouse.io/cirrus')).toBeUndefined();
    expect(leverSiteFromApplicationUrl('not a url')).toBeUndefined();
    expect(validateLeverSite('Cirrus Logic')).toBe(false);
  });

  it('groups sightings by site, counts listings, and keeps every observed name', () => {
    const ledger = buildLeverCandidateLedger([
      { sourceId: 'speedyapply-2027-swe', company: 'Cirrus Logic', applyUrl: 'https://jobs.lever.co/cirrus/a/apply' },
      { sourceId: 'vanshb03-summer-2027', company: 'Cirrus Logic', applyUrl: 'https://jobs.lever.co/cirrus/b/apply' },
      { sourceId: 'vanshb03-summer-2027', company: 'Cirrus Logic Inc', applyUrl: 'https://jobs.lever.co/cirrus/c/apply' },
      { sourceId: 'zapply-2027', company: 'GeoComply', applyUrl: 'https://jobs.lever.co/geocomply-2/d/apply' },
    ], { firstSeenAt: '2026-07-29T10:00:00Z' });

    expect(ledger).toEqual([
      {
        site: 'cirrus',
        observedCompany: 'Cirrus Logic',
        observedCompanyVariants: ['Cirrus Logic', 'Cirrus Logic Inc'],
        referencingSources: ['speedyapply-2027-swe', 'vanshb03-summer-2027'],
        eligibleListings: 3,
        sampleJobUrl: 'https://jobs.lever.co/cirrus/a/apply',
        firstSeenAt: '2026-07-29',
      },
      {
        site: 'geocomply-2',
        observedCompany: 'GeoComply',
        observedCompanyVariants: ['GeoComply'],
        referencingSources: ['zapply-2027'],
        eligibleListings: 1,
        sampleJobUrl: 'https://jobs.lever.co/geocomply-2/d/apply',
        firstSeenAt: '2026-07-29',
      },
    ]);
  });

  it('never derives a site from a company name', () => {
    // `geocomply-2` is not a slug of "GeoComply", so a name-derived ledger would
    // have produced `geocomply` — a different board, possibly somebody else's.
    const ledger = buildLeverCandidateLedger([
      { sourceId: 'zapply-2027', company: 'GeoComply', applyUrl: 'https://jobs.lever.co/geocomply-2/d/apply' },
    ]);
    expect(ledger.map((candidate) => candidate.site)).toEqual(['geocomply-2']);
  });

  it('drops sites that are already in the reviewed registry', () => {
    const ledger = buildLeverCandidateLedger([
      { sourceId: 'zapply-2027', company: 'Palantir Technologies', applyUrl: 'https://jobs.lever.co/palantir/a/apply' },
      { sourceId: 'zapply-2027', company: 'TomTom', applyUrl: 'https://jobs.lever.co/tomtom/a/apply' },
    ], { registeredSites: reviewedLeverSources.map((source) => source.site) });
    expect(ledger.map((candidate) => candidate.site)).toEqual(['tomtom']);
  });
});

describe('probeLeverCandidate', () => {
  const posting = (label: string, title: string, overrides: Record<string, unknown> = {}) => {
    const id = `00000000-0000-4000-8000-${label.padStart(12, '0')}`;
    return {
    id,
    text: title,
    hostedUrl: `https://jobs.lever.co/acme/${id}`,
    applyUrl: `https://jobs.lever.co/acme/${id}/apply`,
    categories: { location: 'Austin, TX', commitment: 'Intern' },
    descriptionPlain: 'Currently pursuing a Bachelor of Science in Computer Science.',
    createdAt: Date.parse('2026-07-01T00:00:00Z'),
    ...overrides,
    };
  };

  const respond = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', etag: '"abc"' }, ...init });

  it('measures a board without attributing it', async () => {
    const fetchImpl = (async () => respond([
      posting('1', 'Software Engineer Intern'),
      posting('2', 'Director of Engineering'),
    ])) as unknown as typeof fetch;
    const result = await probeLeverCandidate('acme', fetchImpl, '2026-07-29T00:00:00Z');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result.attribution).toBe('unattributed');
    expect(result.rawPostings).toBe(2);
    expect(result.eligibleEarlyCareerRoles).toBe(1);
    expect(result.malformedRows).toBe(0);
    expect(result.urlContractViolations).toBe(0);
    expect(result.applicationHostSummary).toEqual({ 'jobs.lever.co': 2 });
    expect(result.etagPresent).toBe(true);
    expect(result.region).toBe('global');
    // Nothing in the result can be read as an owner.
    expect(JSON.stringify(result)).not.toContain('Acme');
  });

  it('counts URL-contract violations instead of throwing', async () => {
    const fetchImpl = (async () => respond([
      posting('1', 'Software Engineer Intern'),
      posting('2', 'Software Engineer Intern', { applyUrl: 'https://careers.acme.com/2/apply' }),
      posting('3', 'Software Engineer Intern', { hostedUrl: 'https://jobs.lever.co/other/3' }),
      { id: '4' },
    ])) as unknown as typeof fetch;
    const result = await probeLeverCandidate('acme', fetchImpl, '2026-07-29T00:00:00Z');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result.rawPostings).toBe(4);
    expect(result.malformedRows).toBe(1);
    expect(result.urlContractViolations).toBe(2);
    expect(result.applicationHostSummary).toEqual({ 'jobs.lever.co': 2, 'careers.acme.com': 1 });
  });

  it('reads every page of a large board', async () => {
    const pages = [Array.from({ length: 100 }, (_, index) => posting(`a${index}`, 'Software Engineer Intern')), [posting('b0', 'Software Engineer Intern')]];
    let call = 0;
    const fetchImpl = (async () => respond(pages[call++] ?? [])) as unknown as typeof fetch;
    const result = await probeLeverCandidate('acme', fetchImpl, '2026-07-29T00:00:00Z');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result.pagesRead).toBe(2);
    expect(result.rawPostings).toBe(101);
  });

  it('classifies failures without publishing anything', async () => {
    const cases: Array<[string, typeof fetch, string]> = [
      ['site-not-found', (async () => new Response('', { status: 404 })) as unknown as typeof fetch, 'site-not-found'],
      ['http-error', (async () => new Response('', { status: 500 })) as unknown as typeof fetch, 'http-error'],
      ['json-error', (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch, 'json-error'],
      ['transport-error', (async () => { throw new Error('offline'); }) as unknown as typeof fetch, 'transport-error'],
    ];
    for (const [, fetchImpl, expected] of cases) {
      expect((await probeLeverCandidate('acme', fetchImpl, '2026-07-29T00:00:00Z')).state).toBe(expected);
    }
    expect((await probeLeverCandidate('Acme Corp', undefined, '2026-07-29T00:00:00Z')).state).toBe('invalid-site');
  });

  it('rejects a response that came from another host', async () => {
    const fetchImpl = (async () => {
      const response = respond([]);
      Object.defineProperty(response, 'url', { value: 'https://evil.example.com/v0/postings/acme' });
      return response;
    }) as unknown as typeof fetch;
    expect((await probeLeverCandidate('acme', fetchImpl, '2026-07-29T00:00:00Z')).state).toBe('response-host-error');
  });
});

describe('lever ownership evidence', () => {
  it('admits a record whose excerpt proves the site from a first-party page', () => {
    expect(evidenceViolations(evidence())).toEqual([]);
    expect(admissibleLeverEvidence(evidence())).toBe(true);
  });

  it('never admits api-live-unattributed, however healthy the board', () => {
    expect(LEVER_ADMISSIBLE_OWNERSHIP_STATES).toEqual(['ownership-verified']);
    for (const state of LEVER_OWNERSHIP_STATES.filter((candidate) => candidate !== 'ownership-verified')) {
      expect(admissibleLeverEvidence(evidence({ state }))).toBe(false);
    }
    // The record is otherwise flawless: only the state keeps it out.
    expect(evidenceViolations(evidence({ state: 'api-live-unattributed' }))).toEqual([]);
    expect(() => reviewedSourceFromEvidence(evidence({ state: 'api-live-unattributed' })))
      .toThrow(/never admissible/);
  });

  it('lets a refusal omit the excerpt, but not the reason', () => {
    const refusal = { state: 'api-live-unattributed' as const, evidenceExcerpt: '' };
    expect(evidenceViolations(evidence(refusal)))
      .toEqual(['state api-live-unattributed carries neither an evidenceExcerpt nor notes explaining it']);
    expect(evidenceViolations(evidence({ ...refusal, notes: 'careers page does not link the board' }))).toEqual([]);
    // A claim of ownership still owes its markup.
    expect(evidenceViolations(evidence({ evidenceExcerpt: '', notes: 'trust me' })))
      .toEqual(['evidenceExcerpt is empty']);
  });

  it('rejects evidence sourced from Lever itself or an aggregator', () => {
    for (const url of [
      'https://jobs.lever.co/cirrus',
      'https://www.linkedin.com/jobs/view/123',
      'https://simplify.jobs/p/abc',
      'https://web.archive.org/web/2026/https://www.cirrus.com/careers/',
    ]) {
      expect(evidenceViolations(evidence({ firstPartyEvidenceUrl: url, careersUrl: url })))
        .toEqual(expect.arrayContaining([expect.stringContaining('cannot')]));
    }
  });

  it('requires the excerpt to name the exact site, not a prefix of it', () => {
    expect(excerptProvesSite('href="https://jobs.lever.co/cirrus"', 'cirrus')).toBe(true);
    expect(excerptProvesSite('href="https://jobs.lever.co/cirrus/abc/apply"', 'cirrus')).toBe(true);
    expect(excerptProvesSite('href="https://jobs.lever.co/cirrus-2"', 'cirrus')).toBe(false);
    expect(evidenceViolations(evidence({ evidenceExcerpt: 'We are hiring! See our careers page.' })))
      .toEqual(['evidenceExcerpt does not contain jobs.lever.co/cirrus']);
  });

  it('requires the evidence page and the careers page to share a domain', () => {
    expect(evidenceViolations(evidence({ firstPartyEvidenceUrl: 'https://www.cirruslogic.example/careers/' })))
      .toEqual(expect.arrayContaining([expect.stringContaining('not on the same domain')]));
    expect(evidenceViolations(evidence({ firstPartyEvidenceUrl: 'https://careers.cirrus.com/openings' }))).toEqual([]);
  });

  it('keeps two-label public suffixes distinct', () => {
    expect(evidenceViolations(evidence({
      careersUrl: 'https://www.good.co.uk/careers',
      firstPartyEvidenceUrl: 'https://www.evil.co.uk/careers',
    }))).toEqual(expect.arrayContaining([expect.stringContaining('not on the same domain')]));
  });

  it('rejects an observed job URL that does not belong to the site', () => {
    expect(evidenceViolations(evidence({ observedJobUrl: 'https://jobs.lever.co/other/abc/apply' })))
      .toEqual(['observedJobUrl is not a posting under /cirrus']);
  });

  it('requires custom-host-review when application links leave jobs.lever.co', () => {
    expect(evidenceViolations(evidence({ initialHosts: ['careers.cirrus.com'] })))
      .toEqual(expect.arrayContaining([expect.stringContaining('custom-host-review')]));
    expect(evidenceViolations(evidence({ initialHosts: ['careers.cirrus.com'], state: 'custom-host-review' }))).toEqual([]);
  });

  it('admits into shadow, never straight into the catalog', () => {
    expect(reviewedSourceFromEvidence(evidence())).toEqual({
      id: 'lever-cirrus',
      company: 'Cirrus Logic',
      site: 'cirrus',
      careersUrl: 'https://www.cirrus.com/careers/',
      admittedAt: '2026-07-29T00:00:00Z',
      status: 'shadow',
      region: 'global',
      evidenceStatus: 'agent-verified',
    });
  });
});

describe('lever manifest gate', () => {
  const now = new Date('2026-07-29T00:00:00Z');
  const source = {
    id: 'lever-cirrus',
    company: 'Cirrus Logic',
    site: 'cirrus',
    careersUrl: 'https://www.cirrus.com/careers/',
    admittedAt: '2026-07-29',
    status: 'shadow' as const,
    region: 'global' as const,
    evidenceStatus: 'agent-verified' as const,
  };
  const files = {
    'fixtures/cirrus/evidence.json': evidence(),
    'fixtures/cirrus/probe.json': {
      probedAt: '2026-07-29T00:00:00Z',
      attribution: 'unattributed',
      results: [{
        state: 'ok',
        site: 'cirrus',
        region: 'global',
        attribution: 'unattributed',
        malformedRows: 0,
        urlContractViolations: 0,
        applicationHostSummary: { 'jobs.lever.co': 1 },
      }],
    },
  };
  const options = (overrides: Partial<Parameters<typeof collectLeverManifestViolations>[1]> = {}) => ({
    fs: fakeFs(files),
    root: 'fixtures',
    now,
    policies: policiesFor(['lever-cirrus']),
    ...overrides,
  });

  it('passes when the registry, the policy, and the evidence agree', () => {
    expect(collectLeverManifestViolations([source], options())).toEqual([]);
  });

  it('gates an empty-board acknowledgement on an owner, a reason, and a fresh timestamp', () => {
    const acknowledged = {
      ...source,
      emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-07-29T00:00:00Z', reason: 'seasonally empty' },
    };
    expect(collectLeverManifestViolations([acknowledged], options())).toEqual([]);
    const malformed = { ...source, emptyBoardAcknowledged: { acknowledgedBy: '', acknowledgedAt: 'not-a-timestamp', reason: ' ' } };
    expect(collectLeverManifestViolations([malformed], options())).toEqual([
      'lever-cirrus: empty-board acknowledgement lacks an owner',
      'lever-cirrus: empty-board acknowledgement lacks a reason',
      'lever-cirrus: empty-board acknowledgement timestamp is invalid',
    ]);
    const future = { ...source, emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-07-29T00:06:00Z', reason: 'seasonally empty' } };
    expect(collectLeverManifestViolations([future], options())).toEqual(['lever-cirrus: empty-board acknowledgement timestamp is in the future']);
    const stale = { ...source, emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-01-01T00:00:00Z', reason: 'seasonally empty' } };
    expect(collectLeverManifestViolations([stale], options())).toEqual(['lever-cirrus: empty-board acknowledgement is overdue for re-verification (limit 180 days)']);
  });

  it('fails an agent-verified board with no evidence record', () => {
    expect(collectLeverManifestViolations([source], options({ fs: fakeFs({}) })))
      .toEqual(['lever-cirrus: missing fixtures/cirrus/evidence.json']);
  });

  it('fails when the evidence names a different company than the registry shows', () => {
    expect(collectLeverManifestViolations([{ ...source, company: 'Cirrus Aircraft' }], options()))
      .toEqual(expect.arrayContaining([expect.stringContaining('does not match registry company')]));
  });

  it('binds the re-verification clock to the evidence timestamp', () => {
    expect(collectLeverManifestViolations([{ ...source, admittedAt: '2026-07-28' }], options()))
      .toEqual(expect.arrayContaining([expect.stringContaining('verifiedAt')]));
  });

  it('rejects an empty, wrong-site, or unhealthy probe for admission', () => {
    const emptyProbe = fakeFs({ ...files, 'fixtures/cirrus/probe.json': {} });
    expect(collectLeverManifestViolations([source], options({ fs: emptyProbe })))
      .toEqual(expect.arrayContaining([expect.stringContaining('probe.json')]));

    const wrongSite = fakeFs({
      ...files,
      'fixtures/cirrus/probe.json': {
        ...files['fixtures/cirrus/probe.json'],
        results: [{ ...files['fixtures/cirrus/probe.json'].results[0], site: 'cirrus-2' }],
      },
    });
    expect(collectLeverManifestViolations([source], options({ fs: wrongSite })))
      .toEqual(expect.arrayContaining([expect.stringContaining('probe site')]));

    const unhealthy = fakeFs({
      ...files,
      'fixtures/cirrus/probe.json': {
        ...files['fixtures/cirrus/probe.json'],
        results: [{ ...files['fixtures/cirrus/probe.json'].results[0], urlContractViolations: 1 }],
      },
    });
    expect(collectLeverManifestViolations([source], options({ fs: unhealthy })))
      .toEqual(expect.arrayContaining([expect.stringContaining('URL-contract violations')]));
  });

  it('fails when the registry and the quality policy disagree about the site', () => {
    expect(collectLeverManifestViolations([source], options({ policies: [{ id: 'lever-cirrus', sourceClass: 'lever', leverSite: 'cirrus-logic' }] })))
      .toEqual([expect.stringContaining('does not match registry site')]);
  });

  it('fails a lever quality policy with no reviewed source', () => {
    expect(collectLeverManifestViolations([source], options({ policies: policiesFor(['lever-cirrus', 'lever-ghost']) })))
      .toEqual(['quality policy lever-ghost has no reviewed Lever source']);
  });

  it('demands re-verification once admittedAt passes 180 days', () => {
    const january = fakeFs({
      ...files,
      'fixtures/cirrus/evidence.json': evidence({ verifiedAt: '2026-01-01' }),
    });
    expect(collectLeverManifestViolations(
      [{ ...source, admittedAt: '2026-01-01' }],
      options({ fs: january }),
    ))
      .toEqual([expect.stringContaining('re-verification overdue')]);
    const february = fakeFs({
      ...files,
      'fixtures/cirrus/evidence.json': evidence({ verifiedAt: '2026-02-01' }),
    });
    expect(collectLeverManifestViolations(
      [{ ...source, admittedAt: '2026-02-01' }],
      options({ fs: february }),
    )).toEqual([]);
  });

  it('applies the re-verification clock to legacy-review boards too', () => {
    expect(collectLeverManifestViolations(
      [{ ...source, evidenceStatus: 'legacy-review', admittedAt: '2025-01-01' }],
      options({ fs: fakeFs({}) }),
    )).toEqual([expect.stringContaining('re-verification overdue')]);
  });

  it('allows a verified but unadmitted record as the exception queue', () => {
    const queue = fakeFs({
      'fixtures/tomtom/evidence.json': evidence({ site: 'tomtom', displayName: 'TomTom', careersUrl: 'https://www.tomtom.com/careers/', firstPartyEvidenceUrl: 'https://www.tomtom.com/careers/', evidenceExcerpt: '<a href="https://jobs.lever.co/tomtom">Jobs</a>', observedJobUrl: 'https://jobs.lever.co/tomtom/abc/apply' }),
      'fixtures/tomtom/probe.json': {
        ...files['fixtures/cirrus/probe.json'],
        results: [{ ...files['fixtures/cirrus/probe.json'].results[0], site: 'tomtom' }],
      },
      ...files,
    });
    expect(collectLeverManifestViolations([source], options({ fs: queue }))).toEqual([]);
    expect(summariseLeverManifest([source], options({ fs: queue })).pendingAdmission).toEqual(['tomtom']);
  });

  it('fails a malformed record sitting in the queue', () => {
    const queue = fakeFs({
      'fixtures/tomtom/evidence.json': evidence({ site: 'tomtom' }),
      'fixtures/tomtom/probe.json': {
        ...files['fixtures/cirrus/probe.json'],
        results: [{ ...files['fixtures/cirrus/probe.json'].results[0], site: 'tomtom' }],
      },
      ...files,
    });
    expect(collectLeverManifestViolations([source], options({ fs: queue })))
      .toEqual(expect.arrayContaining([expect.stringContaining('tomtom: evidenceExcerpt does not contain')]));
  });

  it('fails a stray evidence directory', () => {
    const queue = fakeFs({ 'fixtures/tomtom/probe.json': {}, ...files });
    expect(collectLeverManifestViolations([source], options({ fs: queue })))
      .toEqual(['evidence directory "tomtom" contains no evidence.json']);
  });
});

describe('recheckLeverEvidence', () => {
  const page = (html: string) => (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;

  it('reports exact when the recorded markup is still on the page', async () => {
    const result = await recheckLeverEvidence(
      evidence(),
      page('<nav>\n  <a href="https://jobs.lever.co/cirrus">View openings</a>\n</nav>'),
      '2026-07-30T00:00:00Z',
    );
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result).toMatchObject({ fidelity: 'exact', stillProven: true });
  });

  it('reports link-only when the agent paraphrased its own evidence', async () => {
    // The link is there; the excerpt was not copied off the page. That is a
    // finding about the record, not about the employer.
    const result = await recheckLeverEvidence(
      evidence(),
      page('<a href="https://jobs.lever.co/cirrus" class="menu-link">View openings</a>'),
      '2026-07-30T00:00:00Z',
    );
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result).toMatchObject({ fidelity: 'link-only', stillProven: true });
  });

  it('reports missing once the employer stops linking the board', async () => {
    const result = await recheckLeverEvidence(evidence(), page('<a href="https://jobs.lever.co/cirrus-2">Jobs</a>'), '2026-07-30T00:00:00Z');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result).toMatchObject({ fidelity: 'missing', stillProven: false });
  });

  it('refuses to recheck a record that was never valid', async () => {
    const result = await recheckLeverEvidence(evidence({ evidenceExcerpt: 'no link here' }), page(''), '2026-07-30T00:00:00Z');
    expect(result.state).toBe('malformed-record');
  });
});

describe('the checked-in registry', () => {
  it('satisfies its own manifest gate', () => {
    expect(collectLeverManifestViolations()).toEqual([]);
  });

  it('keeps every reviewed board paired with a lever quality policy', () => {
    const leverPolicies = sourceQualityPolicies.filter((policy) => policy.sourceClass === 'lever');
    expect(leverPolicies.map((policy) => policy.leverSite).sort())
      .toEqual(reviewedLeverSources.map((source) => source.site).sort());
  });
});
