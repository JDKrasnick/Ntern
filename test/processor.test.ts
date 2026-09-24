import { describe, expect, it } from 'vitest';
import { processSnapshot } from '../src/ingestion/processor.js';
import type { SourcedPosting } from '../src/types.js';

const posting = (overrides: Partial<SourcedPosting> = {}): SourcedPosting => ({
  sourceId: 'lever-acme',
  externalId: 'role-1',
  sourceUrl: 'https://api.lever.co/v0/postings/acme',
  fetchedAt: '2026-07-29T12:00:00.000Z',
  employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' },
  title: 'Software Engineering Intern, Summer 2027',
  content: [{ kind: 'description', format: 'html', value: '<p>Pays $50/hour &amp; requires a U.S. citizen.</p>' }],
  locations: ['New York, NY (Hybrid)'],
  applyUrl: 'https://jobs.lever.co/acme/role-1/apply',
  sourceState: 'open',
  ...overrides,
});

describe('shared posting processor', () => {
  it('includes an explicitly technical project management internship from an official board', () => {
    const result = processSnapshot({ sourceId: 'greenhouse-astranis', outcome: 'changed', complete: true,
      postings: [posting({ sourceId: 'greenhouse-astranis', title: 'Technical Project Management Intern (Summer 2027)',
        content: [{ kind: 'description', format: 'plain', value: 'Coordinate mission schedules and engineering risk reviews.' }] })],
      rawCount: 1, contentHash: 'hash', checkpoint: { sourceId: 'greenhouse-astranis', successfulFetches: 1 },
    });
    expect(result.counts).toMatchObject({ eligible: 1, shelved: 0 });
    expect(result.listings[0]?.technical).toBe(true);
  });
  it('normalizes content and emits a reason-coded included decision', () => {
    const result = processSnapshot({
      sourceId: 'lever-acme', outcome: 'changed', complete: true, postings: [posting()],
      rawCount: 1, contentHash: 'hash', checkpoint: { sourceId: 'lever-acme', successfulFetches: 1 },
    });
    expect(result.counts).toEqual({ raw: 1, valid: 1, eligible: 1, shelved: 0, filtered: 0, withheld: 0 });
    expect(result.decisions).toEqual([{ externalId: 'role-1', outcome: 'included', reason: 'source-policy' }]);
    expect(result.listings[0]).toMatchObject({
      externalId: 'role-1', company: 'Acme', workMode: 'hybrid', season: 'summer-2027',
      compensation: { maxHourlyUSD: 50 },
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false },
      technical: true,
      providerIdentity: { employerScope: 'employer:acme' },
      employerEvidence: { authority: 'reviewed-registry' },
    });
    expect(result.listings[0]?.employerEvidence?.canonicalEmployer).toBeUndefined();
  });

  it('prefers a declared work mode and infers one only when the source declares nothing usable', () => {
    const modes = (postings: Parameters<typeof processSnapshot>[0]['postings']) => processSnapshot({
      sourceId: 'lever-acme', outcome: 'changed', complete: true, postings, rawCount: postings.length,
      contentHash: 'hash', checkpoint: { sourceId: 'lever-acme', successfulFetches: 1 },
    }).listings.map((listing) => listing.workMode);

    expect(modes([
      posting({ externalId: 'declared', declaredWorkMode: 'hybrid', locations: ['New York, NY (Onsite)'] }),
      posting({ externalId: 'unusable', declaredWorkMode: 'unspecified', locations: ['Remote'] }),
      posting({ externalId: 'absent', locations: ['Remote'], content: [] }),
      posting({ externalId: 'silent', locations: ['New York, NY'], content: [] }),
    ])).toEqual(['hybrid', 'remote', 'remote', undefined]);
  });

  it('takes an explicit title season over a conflicting source-wide default', () => {
    const result = processSnapshot({
      sourceId: 'markdown-list', outcome: 'changed', complete: true, rawCount: 1, contentHash: 'hash',
      checkpoint: { sourceId: 'markdown-list', successfulFetches: 1 },
      postings: [posting({
        title: 'Software Engineering Intern, Summer 2026',
        seasonHint: 'summer-2027',
        seasonHintAuthority: 'source-default',
      })],
    });

    expect(result.listings[0]).toMatchObject({ season: 'summer-2026' });
    expect(result.listings[0]?.seasonSource).toBeUndefined();
  });

  it('keeps a reviewed early-career document as the lifecycle authority', () => {
    const result = processSnapshot({
      sourceId: 'markdown-list', outcome: 'changed', complete: true, rawCount: 2, contentHash: 'hash',
      checkpoint: { sourceId: 'markdown-list', successfulFetches: 1 },
      postings: [
        posting({ externalId: 'new-grad', title: 'Software Engineer, New Grad', lifecycleAuthority: 'source', content: [] }),
        posting({ externalId: 'recruiter', title: 'Campus Recruiter', lifecycleAuthority: 'source', content: [] }),
      ],
    });
    expect(result.decisions).toEqual([
      { externalId: 'new-grad', outcome: 'included', reason: 'source-policy' },
      { externalId: 'recruiter', outcome: 'shelved', reason: 'nontechnical' },
    ]);
    expect(result.counts).toMatchObject({ eligible: 1, shelved: 1 });
    // The shelved role is still persisted; only the catalog-eligible one is technical.
    expect(result.listings.map((listing) => [listing.title, listing.technical])).toEqual([
      ['Software Engineer, New Grad', true],
      ['Campus Recruiter', false],
    ]);
  });

  it('reports prospect, lifecycle, technical, invalid URL, and aggregator decisions', () => {
    const postings = [
      posting({ externalId: 'prospect', sourceState: 'prospect' }),
      posting({ externalId: 'senior', title: 'Senior Software Engineer' }),
      posting({ externalId: 'marketing', title: 'Marketing Intern' }),
      posting({ externalId: 'http', applyUrl: 'http://careers.example.test/role' }),
      posting({ externalId: 'aggregator', applyUrl: 'https://linkedin.com/jobs/role' }),
    ];
    const result = processSnapshot({
      sourceId: 'lever-acme', outcome: 'changed', complete: true, postings, rawCount: 5,
      contentHash: 'hash', checkpoint: { sourceId: 'lever-acme', successfulFetches: 1 },
    });
    expect(result.decisions.map(({ externalId, outcome, reason }) => ({ externalId, outcome, reason }))).toEqual([
      { externalId: 'prospect', outcome: 'filtered', reason: 'prospect' },
      { externalId: 'senior', outcome: 'filtered', reason: 'not-early-career' },
      { externalId: 'marketing', outcome: 'shelved', reason: 'nontechnical' },
      { externalId: 'http', outcome: 'withheld', reason: 'invalid-application-url' },
      { externalId: 'aggregator', outcome: 'withheld', reason: 'aggregator-destination' },
    ]);
  });

  it('applies new-grad and explicit entry-level title rules identically across providers', () => {
    const postings = ['lever', 'greenhouse', 'ashby'].flatMap((provider) => [
      posting({ sourceId: `${provider}-acme`, externalId: `${provider}-new-grad`, title: 'Software Engineer, New Grad', content: [] }),
      posting({ sourceId: `${provider}-acme`, externalId: `${provider}-entry`, title: 'Entry-Level Data Engineer', content: [] }),
      posting({ sourceId: `${provider}-acme`, externalId: `${provider}-generic`, title: 'Software Engineer', content: [] }),
      posting({ sourceId: `${provider}-acme`, externalId: `${provider}-junior`, title: 'Junior Software Engineer', content: [] }),
    ]);
    const result = processSnapshot({
      sourceId: 'cross-provider', outcome: 'changed', complete: true, postings, rawCount: postings.length,
      contentHash: 'hash', checkpoint: { sourceId: 'cross-provider', successfulFetches: 1 },
    });
    for (const provider of ['lever', 'greenhouse', 'ashby']) {
      expect(result.decisions.filter(({ externalId }) => externalId.startsWith(provider)).map(({ outcome, reason }) => [outcome, reason])).toEqual([
        ['included', 'source-policy'], ['included', 'source-policy'],
        ['filtered', 'not-early-career'], ['filtered', 'not-early-career'],
      ]);
    }
  });

  it('repairs a cut title from the employer rows collected in one pass without moving any other row', () => {
    const result = processSnapshot({
      sourceId: 'lever-acme', outcome: 'changed', complete: true, rawCount: 3, contentHash: 'hash',
      checkpoint: { sourceId: 'lever-acme', successfulFetches: 1 },
      postings: [
        posting({ externalId: 'cut', title: 'Backend Software Engineer Intern - Paym…' }),
        posting({ externalId: 'whole', title: 'Backend Software Engineer Intern - Payments (Summer 2027)' }),
        posting({ externalId: 'marketing', title: 'Marketing Intern' }),
      ],
    });

    // One whole row of the employer's board repairs the row the source cut short,
    // whichever order the rows arrive in.
    expect(result.listings.map(({ externalId, title }) => [externalId, title])).toEqual([
      ['cut', 'Backend Software Engineer Intern - Payments (Summer 2027)'],
      ['whole', 'Backend Software Engineer Intern - Payments (Summer 2027)'],
      ['marketing', 'Marketing Intern'],
    ]);
    expect(result.listings[0]).toMatchObject({ titleRepaired: true, season: 'summer-2027' });
    // Accumulating the employer titles in place must not change any row's outcome.
    expect(result.decisions).toEqual([
      { externalId: 'cut', outcome: 'included', reason: 'source-policy' },
      { externalId: 'whole', outcome: 'included', reason: 'source-policy' },
      { externalId: 'marketing', outcome: 'shelved', reason: 'nontechnical' },
    ]);
    expect(result.counts).toEqual({ raw: 3, valid: 3, eligible: 2, shelved: 1, filtered: 0, withheld: 0 });
  });
});
