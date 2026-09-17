import { describe, expect, it } from 'vitest';
import { alertEligible, catalogEligible, deriveCanonicalAdmission, evaluateCatalogAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { classifyDestination, requiresBrowserVerification } from '../src/destination-verification.js';
import { inspectApplicationPage, type ApplicationPageEvidence } from '../src/core/application-url.js';
import { reachabilityFromFailure } from '../src/core/application-verification.js';
import type { CatalogAdmission, ProcessedListing, SourceOccurrence } from '../src/types.js';

function listing(overrides: Partial<ProcessedListing> = {}): ProcessedListing {
  return {
    sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: '1234567', document: '1234567',
    sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme',
    title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1234567', compensation: { raw: '' }, state: 'open',
    fetchedAt: '2026-08-26T12:00:00Z', technical: true,
    providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-acme', tenant: 'acme', postingId: '1234567', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' },
    employerEvidence: { authority: 'reviewed-registry', canonicalEmployer: { id: 'acme', displayName: 'Acme' } },
    metadataCompleteness: { complete: true, title: 'complete', location: 'complete' },
    ...overrides,
  };
}

function page(overrides: Partial<ApplicationPageEvidence> = {}): ApplicationPageEvidence {
  return {
    url: 'https://careers.acme.test/jobs/1234567', title: 'Software Engineering Intern — Acme',
    contentExcerpt: 'About the role. Responsibilities and qualifications for this software engineering internship.',
    confidence: { score: 90, level: 'high', recommendation: 'alert-eligible', signals: ['job-description language'] },
    ...overrides,
  };
}

describe('record-level catalog admission', () => {
  it('accepts blocked reviewed standard routes with the expected immutable posting ID', () => {
    const role = listing();
    const destination = classifyDestination({ listing: role, reachability: 'blocked', inspectedAt: '2026-08-26T12:00:00Z' });
    const admission = evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' });
    expect(destination.classification).toBe('posting-detail');
    expect(admission).toMatchObject({ catalogEligible: true, alertEligible: true, reasonCodes: [] });
  });

  it('quarantines generic employer labels such as Axon talent-community boards', () => {
    const role = listing({
      company: 'Join Our Talent Community',
      employerEvidence: { authority: 'reviewed-registry', canonicalEmployer: { id: 'axontalentcommunity', displayName: 'Join Our Talent Community' } },
    });
    const destination = classifyDestination({ listing: role, reachability: 'implied', inspectedAt: '2026-08-26T12:00:00Z' });
    expect(evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' }))
      .toMatchObject({ catalogEligible: false, reasonCodes: ['employer-generic-label'] });
  });

  it('distinguishes ignored Zipline-style shells from valid custom redirects', () => {
    const role = listing({
      applyUrl: 'https://www.zipline.com/open-roles?gh_jid=1234567',
      providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-zipline', tenant: 'zipline', postingId: '1234567', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/zipline/jobs' },
    });
    const aggregate = classifyDestination({ listing: role, reachability: 'live', evidence: page({
      url: role.applyUrl, title: 'Open Roles at Zipline | Join Our Team', contentExcerpt: 'Browse every open role.',
      jobPostingCount: 16, postingIdPresent: false,
    }), inspectedAt: '2026-08-26T12:00:00Z', browserVisible: true });
    expect(aggregate.classification).toBe('aggregate-board');

    const valid = classifyDestination({ listing: { ...role, applyUrl: 'https://careers.acme.test/roles/software-intern' },
      reachability: 'live', evidence: page({ postingIdPresent: true, jobPostingCount: 1 }),
      inspectedAt: '2026-08-26T12:00:00Z', browserVisible: true });
    expect(valid.classification).toBe('posting-detail');
  });

  it('does not treat one structured posting in a truncated prefix as exact-page proof', () => {
    const role = listing({ applyUrl: 'https://careers.acme.test/custom' });
    const destination = classifyDestination({ listing: role, reachability: 'live', inspectedAt: '2026-09-04T12:00:00Z',
      evidence: page({ title: 'Careers', contentExcerpt: 'Browse opportunities', jobPostingCount: 1,
        inspectionTruncated: true, inspectedBytes: 512 * 1024 }) });
    expect(destination).toMatchObject({ classification: 'unresolved', inspectionTruncated: true, inspectedBytes: 512 * 1024 });
  });

  it('uses the required missing-location copy but rejects truncated and malformed display fields', () => {
    expect(metadataCompleteness({ title: 'Software Engineering Intern', locations: [] }))
      .toEqual({ complete: true, title: 'complete', location: 'not-specified' });
    expect(metadataCompleteness({ title: 'Embedded Engineering Intern (Summer', locations: ['South San Francisco, C...'] }))
      .toEqual({ complete: false, title: 'malformed', location: 'truncated' });
    expect(metadataCompleteness({ title: 'Software Engineering Intern…', locations: ['Remote'], titleRepaired: true }).title)
      .toBe('truncated');
    for (const title of ['Software Engineer II', 'Machine Learning Intern AI', 'Research Intern - Cedar Park, TX', 'Intern/ Graduate Software Engineer, NZ']) {
      expect(metadataCompleteness({ title, locations: ['Remote'] }), title)
        .toEqual({ complete: true, title: 'complete', location: 'complete' });
    }
  });

  it('does not accept an aggregate page from a matching role title alone', async () => {
    const role = listing({ applyUrl: 'https://careers.acme.test/open-roles' });
    const evidence = await inspectApplicationPage(role.applyUrl, async () => new Response(`<title>Open roles at Acme</title><main>
      <a href="/jobs/software-intern">Software Engineering Intern</a>
      <a href="/jobs/data-intern">Data Science Intern</a>
      <a href="/roles/design-intern">Product Design Intern</a>
    </main>`, { status: 200, headers: { 'content-type': 'text/html' } }));
    const destination = classifyDestination({
      listing: role,
      reachability: 'live',
      inspectedAt: '2026-08-26T12:00:00Z',
      browserVisible: true,
      evidence,
    });
    expect(destination.classification).toBe('aggregate-board');
    expect(evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' }))
      .toMatchObject({ catalogEligible: false, reasonCodes: ['destination-aggregate-board'] });
  });

  it('keeps exact posting evidence authoritative when the page links related roles', () => {
    const role = listing({ applyUrl: 'https://careers.acme.test/jobs/1234567' });
    const destination = classifyDestination({
      listing: role,
      reachability: 'live',
      inspectedAt: '2026-08-26T12:00:00Z',
      browserVisible: true,
      evidence: page({ postingIdPresent: true, distinctJobLinkCount: 4 }),
    });
    expect(destination.classification).toBe('posting-detail');
  });

  it.each([7, 8, 10, 14, 17, 100])('admits a matching single posting with %s navigation/related links', async (links) => {
    const role = listing({ applyUrl: 'https://careers.future-employer.test/opportunities/software-intern',
      providerIdentity: { provider: 'github', sourceId: 'community', sourceUrl: 'https://example.test/source' } });
    const evidence = await inspectApplicationPage(role.applyUrl, async () => new Response(`
      <title>Software Engineering Intern</title>
      <script type="application/ld+json">{"@type":"JobPosting","title":"Software Engineering Intern",
      "description":"Build software with our engineering team during this internship."}</script>
      ${Array.from({ length: links }, (_, i) => `<a href="/jobs/related-${i}">Related role</a>`).join('')}
    `, { headers: { 'content-type': 'text/html' } }));
    expect(evidence).toMatchObject({ jobPostingCount: 1, distinctJobLinkCount: links });
    for (const browserVisible of [undefined, true]) {
      const destination = classifyDestination({ listing: role, evidence, reachability: 'live',
        inspectedAt: role.fetchedAt, browserVisible });
      expect(destination.classification).toBe('posting-detail');
      expect(evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: role.fetchedAt }))
        .toMatchObject({ catalogEligible: true, alertEligible: true });
    }
  });

  it.each([
    { jobPostingCount: 2 },
    { redirectedToGenericDestination: true },
    { identicalEvidenceForDifferentPosting: true },
    { title: 'Restaurant General Manager', description: 'Manage restaurant staffing', contentExcerpt: 'Restaurant management' },
    { jobPostingCount: 0, postingIdPresent: true },
    { jobPostingCount: 0, applicationFormPresent: true },
  ])('keeps contradictory or weak high-link-count pages withheld: %j', (overrides) => {
    const role = listing({ applyUrl: 'https://careers.future-employer.test/jobs/1234567' });
    const evidence = page({ jobPostingCount: 1, distinctJobLinkCount: 14, ...overrides });
    for (const browserVisible of [undefined, true]) {
      const destination = classifyDestination({ listing: role, evidence, reachability: 'live',
        inspectedAt: role.fetchedAt, browserVisible });
      expect(destination.classification).toBe('aggregate-board');
      expect(evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: role.fetchedAt }))
        .toMatchObject({ catalogEligible: false, alertEligible: false });
    }
  });

  it('queues a matching truncated structured page instead of permanently labeling its navigation a board', () => {
    const role = listing({ applyUrl: 'https://careers.future-employer.test/opportunities/software-intern' });
    const evidence = page({ jobPostingCount: 1, distinctJobLinkCount: 14, inspectionTruncated: true });
    for (const browserVisible of [undefined, true]) {
      const destination = classifyDestination({ listing: role, evidence, reachability: 'live',
        inspectedAt: role.fetchedAt, browserVisible });
      expect(destination.classification).toBe('unresolved');
      expect(requiresBrowserVerification(destination)).toBe(true);
      expect(evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: role.fetchedAt }))
        .toMatchObject({ catalogEligible: false, alertEligible: false });
    }
    const verified = classifyDestination({ listing: role, evidence: { ...evidence, inspectionTruncated: false },
      reachability: 'live', inspectedAt: role.fetchedAt, browserVisible: true });
    expect(verified.classification).toBe('posting-detail');
    for (const contradiction of [{ jobPostingCount: 2 }, { redirectedToGenericDestination: true }, { identicalEvidenceForDifferentPosting: true }]) {
      expect(classifyDestination({ listing: role, evidence: { ...evidence, ...contradiction }, reachability: 'live',
        inspectedAt: role.fetchedAt }).classification).toBe('aggregate-board');
    }
  });

  it('anchors temporary unreadability to the last successful exact-role verification and pauses alerts', () => {
    const role = listing({ applyUrl: 'https://careers.acme.test/roles/1234567' });
    const goodDestination = classifyDestination({ listing: role, reachability: 'live', evidence: page({ postingIdPresent: true }), inspectedAt: '2026-08-20T12:00:00Z' });
    const previous = evaluateCatalogAdmission({ listing: role, destination: goodDestination, postingAttributed: true, evaluatedAt: '2026-08-20T12:00:00Z' });
    const unresolved = classifyDestination({ listing: role, reachability: 'unreachable', inspectedAt: '2026-08-26T12:00:00Z' });
    const grace = evaluateCatalogAdmission({ listing: role, destination: unresolved, postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z', previous });
    expect(grace).toMatchObject({ catalogEligible: true, alertEligible: false, reasonCodes: ['destination-grace'],
      lastVerifiedAt: '2026-08-20T12:00:00Z', graceDeadline: '2026-08-27T12:00:00.000Z',
      destination: { lastKnownGoodAt: '2026-08-20T12:00:00Z' } });
    const retry = evaluateCatalogAdmission({ listing: role, destination: { ...unresolved, inspectedAt: '2026-08-26T18:00:00Z' },
      postingAttributed: true, evaluatedAt: '2026-08-26T18:00:00Z', previous: grace });
    expect(retry).toMatchObject({ catalogEligible: true, alertEligible: false,
      lastVerifiedAt: '2026-08-20T12:00:00Z', graceDeadline: '2026-08-27T12:00:00.000Z',
      destination: { lastKnownGoodAt: '2026-08-20T12:00:00Z' } });
    const expired = evaluateCatalogAdmission({ listing: role, destination: unresolved, postingAttributed: true, evaluatedAt: '2026-08-27T12:00:00Z', previous: retry });
    expect(expired).toMatchObject({ catalogEligible: false, alertEligible: false, reasonCodes: ['destination-unresolved'] });
  });

  it.each([404, 410])('immediately closes a previously verified role on confirmed HTTP %s', (status) => {
    const role = listing();
    const previous = evaluateCatalogAdmission({ listing: role,
      destination: classifyDestination({ listing: role, reachability: 'live', evidence: page({ postingIdPresent: true }), inspectedAt: '2026-08-20T12:00:00Z' }),
      postingAttributed: true, evaluatedAt: '2026-08-20T12:00:00Z' });
    const gone = classifyDestination({ listing: role,
      reachability: reachabilityFromFailure(new Error(`official destination returned HTTP ${status}`)),
      inspectedAt: '2026-08-21T12:00:00Z' });
    expect(evaluateCatalogAdmission({ listing: role, destination: gone, postingAttributed: true,
      evaluatedAt: '2026-08-21T12:00:00Z', previous })).toMatchObject({
      catalogEligible: false, alertEligible: false, reasonCodes: ['destination-gone'],
      lastVerifiedAt: '2026-08-20T12:00:00Z',
    });

  });

  it('keeps a stored admission eligible after its evidence timestamp ages out', () => {
    // Owner decision, 2026-09-17: nothing re-inspects a destination after it is
    // admitted, so an aged evidence timestamp must not retire a role or stop its
    // alerts. Only the stored decision itself decides.
    const role = listing();
    const destination = classifyDestination({ listing: role, reachability: 'live', evidence: page({ postingIdPresent: true }),
      inspectedAt: '2026-08-20T12:00:00Z' });
    const admission = evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true,
      evaluatedAt: '2026-08-20T12:00:00Z' });

    expect(alertEligible({ admission })).toBe(true);
    expect(catalogEligible({ admission })).toBe(true);
    expect(catalogEligible({ admission: { ...admission, catalogEligible: false } })).toBe(false);
    expect(alertEligible({ admission: { ...admission, alertEligible: false } })).toBe(false);
  });

  it('treats validThrough as conclusive closure without catalog grace', () => {
    const role = listing();
    const destination = classifyDestination({ listing: role, reachability: 'live', browserVisible: true,
      evidence: page({ postingIdPresent: true, validThrough: '2026-09-01T12:00:00Z' }),
      inspectedAt: '2026-08-26T12:00:00Z' });
    const admission = evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true,
      evaluatedAt: '2026-08-26T12:00:00Z' });
    expect(catalogEligible({ admission })).toBe(true);
    const transient = classifyDestination({ listing: role, reachability: 'unreachable', inspectedAt: '2026-08-31T12:00:00Z' });
    const retained = evaluateCatalogAdmission({ listing: role, destination: transient, postingAttributed: true,
      evaluatedAt: '2026-08-31T12:00:00Z', previous: admission });
    expect(retained.destination.validThrough).toBe('2026-09-01T12:00:00Z');
    // The deadline is evidence at admission time; it does not retire a role that
    // is already admitted, because nothing re-inspects it.
    expect(catalogEligible({ admission: retained })).toBe(true);
  });

  it('classifies explicit closure and expired validThrough before role-specific 200 evidence', () => {
    const role = listing({ applyUrl: 'https://careers.acme.test/roles/1234567' });
    for (const evidence of [
      page({ postingIdPresent: true, closureState: 'gone', closureSignal: 'explicit-language' }),
      page({ postingIdPresent: true, validThrough: '2026-08-25T00:00:00Z' }),
    ]) {
      const destination = classifyDestination({ listing: role, reachability: 'live', evidence,
        inspectedAt: '2026-08-26T12:00:00Z', browserVisible: true });
      expect(destination.classification).toBe('gone');
      expect(evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true,
        evaluatedAt: '2026-08-26T12:00:00Z' })).toMatchObject({ catalogEligible: false, alertEligible: false,
        reasonCodes: ['destination-gone'] });
    }
    const future = classifyDestination({ listing: role, reachability: 'live', browserVisible: true,
      evidence: page({ postingIdPresent: true, validThrough: '2026-09-01T12:00:00Z' }), inspectedAt: '2026-08-26T12:00:00Z' });
    expect(future).toMatchObject({ classification: 'posting-detail', closureState: 'open',
      validThrough: '2026-09-01T12:00:00Z', freshUntil: '2026-09-01T12:00:00.000Z', nextCheckAt: '2026-08-31T12:00:00.000Z' });
    const nearDeadline = classifyDestination({ listing: role, reachability: 'live', browserVisible: true,
      evidence: page({ postingIdPresent: true, validThrough: '2026-08-26T18:00:00Z' }), inspectedAt: '2026-08-26T12:00:00Z' });
    expect(nearDeadline).toMatchObject({ classification: 'posting-detail',
      freshUntil: '2026-08-26T18:00:00.000Z', nextCheckAt: '2026-08-27T12:00:00.000Z' });
  });

  it('lets valid official evidence repair a community row and blocks reviewed employer conflicts', () => {
    const valid = evaluateCatalogAdmission({ listing: listing(), destination: classifyDestination({ listing: listing(), reachability: 'implied', inspectedAt: '2026-08-26T12:00:00Z' }), postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' });
    const invalid: CatalogAdmission = { ...valid, canonicalEmployer: undefined, employerResolution: 'unresolved', catalogEligible: false, alertEligible: false, reasonCodes: ['employer-unresolved'] };
    const occurrence = (sourceId: string, provenance: SourceOccurrence['provenance'], admission: CatalogAdmission): SourceOccurrence => ({
      sourceId, provenance, externalId: sourceId, document: sourceId, sourceUrl: 'https://source.test', row: 1,
      company: admission.canonicalEmployer?.displayName ?? 'Community Acme', title: 'Software Engineering Intern', location: 'Remote',
      season: 'summer-2027', applyUrl: admission.destination.candidateUrl, compensation: { raw: '' }, state: 'open', admission,
    });
    expect(deriveCanonicalAdmission([
      occurrence('community', 'reviewed-community', invalid), occurrence('official', 'official-ats', valid),
    ], '2026-08-26T13:00:00Z')).toMatchObject({ catalogEligible: true, canonicalEmployer: { id: 'acme' } });

    const conflict = { ...valid, canonicalEmployer: { id: 'other', displayName: 'Other' } };
    expect(deriveCanonicalAdmission([
      occurrence('official-a', 'official-ats', valid), occurrence('official-b', 'official-structured', conflict),
    ], '2026-08-26T13:00:00Z')).toMatchObject({ employerResolution: 'conflict', catalogEligible: false, reasonCodes: ['employer-conflict'] });

    const technology = { ...occurrence('community-a', 'reviewed-community', valid), title: '2027 Technology Internship (US)' };
    const software = { ...occurrence('community-b', 'reviewed-community', valid), title: 'Software Engineer Intern' };
    expect(deriveCanonicalAdmission([technology, software], '2026-08-26T13:00:00Z')).toMatchObject({
      catalogEligible: false, alertEligible: false, reasonCodes: ['metadata-conflict'],
    });
    expect(deriveCanonicalAdmission([
      technology, { ...occurrence('official-title', 'official-ats', valid), title: 'Software Engineering Intern' },
    ], '2026-08-26T13:00:00Z')).toMatchObject({ catalogEligible: true, reasonCodes: [] });
  });

  it('derives an open role only from open occurrences while retaining a closed-history fallback', () => {
    const valid = evaluateCatalogAdmission({ listing: listing(), destination: classifyDestination({ listing: listing(), reachability: 'implied', inspectedAt: '2026-08-26T12:00:00Z' }), postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' });
    const invalid: CatalogAdmission = { ...valid, catalogEligible: false, alertEligible: false, reasonCodes: ['destination-aggregate-board'],
      destination: { ...valid.destination, classification: 'aggregate-board' } };
    const occurrence = (sourceId: string, state: SourceOccurrence['state'], admission: CatalogAdmission): SourceOccurrence => ({
      sourceId, provenance: 'official-ats', externalId: sourceId, document: sourceId, sourceUrl: 'https://source.test', row: 1,
      company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: admission.destination.candidateUrl, compensation: { raw: '' }, state, admission,
    });
    expect(deriveCanonicalAdmission([
      occurrence('closed-good', 'closed', valid), occurrence('open-bad', 'open', invalid),
    ], '2026-08-26T13:00:00Z')).toMatchObject({ catalogEligible: false, reasonCodes: ['destination-aggregate-board'] });

    const conflict = { ...valid, canonicalEmployer: { id: 'other', displayName: 'Other' } };
    expect(deriveCanonicalAdmission([
      occurrence('closed-conflict', 'closed', conflict), occurrence('open-good', 'open', valid),
    ], '2026-08-26T13:00:00Z')).toMatchObject({ catalogEligible: true, canonicalEmployer: { id: 'acme' } });
    expect(deriveCanonicalAdmission([occurrence('closed-good', 'closed', valid)], '2026-08-26T13:00:00Z'))
      .toMatchObject({ catalogEligible: true, canonicalEmployer: { id: 'acme' } });
  });

  it('applies reviewed destination decisions before built-in route inference', () => {
    const role = listing();
    const rule = (decision: 'standard-provider-route' | 'browser-required' | 'aggregate-board' | 'blocked-accepted') => ({
      id: decision, host: 'job-boards.greenhouse.io', provider: 'greenhouse' as const, tenant: 'acme', decision,
      reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer',
    });
    expect(classifyDestination({ listing: role, reachability: 'implied', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('browser-required') }).classification)
      .toBe('unresolved');
    expect(classifyDestination({ listing: role, reachability: 'live', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('browser-required'),
      evidence: page({ postingIdPresent: true, jobPostingCount: 1 }) }).classification).toBe('unresolved');
    expect(classifyDestination({ listing: role, reachability: 'live', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('browser-required'),
      browserVisible: true, evidence: page({ postingIdPresent: true, jobPostingCount: 1 }) }).classification).toBe('posting-detail');
    expect(classifyDestination({ listing: role, reachability: 'live', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('aggregate-board') }).classification)
      .toBe('aggregate-board');
    expect(classifyDestination({ listing: { ...role, applyUrl: 'https://job-boards.greenhouse.io/acme/custom/1234567' }, reachability: 'implied',
      inspectedAt: '2026-08-26T12:00:00Z', rule: rule('standard-provider-route') }).classification).toBe('posting-detail');
    expect(classifyDestination({ listing: role, reachability: 'blocked', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('blocked-accepted') }).classification)
      .toBe('posting-detail');
    expect(classifyDestination({ listing: { ...role, applyUrl: 'https://job-boards.greenhouse.io/acme/careers' }, reachability: 'blocked',
      inspectedAt: '2026-08-26T12:00:00Z', rule: rule('blocked-accepted') }).classification).toBe('blocked-uninspectable');
  });
});
