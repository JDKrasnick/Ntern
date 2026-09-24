import { describe, expect, it } from 'vitest';
import { registrableDomain, sameRegistrableDomain } from '../src/core/registrable-domain.js';
import {
  acceptIconTieBreak, decideIconDomain, employerDistinctiveTerms, employerNamesDomain,
  iconEvidenceFingerprint, iconTextMatchesEmployer, isIconTransportHost, parseIconTieBreakDecision,
  providerNameMatchesEmployer, scoreIconCandidate, scoreIconCandidates, tenantCorroboratesEmployer,
} from '../src/employer-icon-resolution.js';
import { companyMonogramColorIndex, companyMonogramColors, companyMonogramInitials } from '../shared/company-icon.js';
import type { IconCandidateScore, IconDomainCandidate, IconTieBreakDecision } from '../src/employer-icon-resolution.js';

function candidate(domain: string, signals: IconDomainCandidate['signals']): IconDomainCandidate {
  return { domain, signals };
}

function score(domain: string, evidenceIds: string[], rejected = false): IconCandidateScore {
  return { domain, score: 0.6, signals: [], evidenceIds, rejected };
}

function tieBreak(overrides: Partial<IconTieBreakDecision> = {}): IconTieBreakDecision {
  return {
    decision: 'accept', officialDomain: 'acme.com', confidence: 0.95,
    evidenceIds: ['final-url:acme.com', 'jsonld-url:acme.com'], reason: 'acme evidence supports acme.com',
    ...overrides,
  };
}

const submitted: readonly IconCandidateScore[] = [
  score('acme.com', ['final-url:acme.com', 'jsonld-url:acme.com']),
  score('other.com', ['final-url:other.com']),
];

describe('registrable domains', () => {
  it('strips subdomains and keeps hosts that merely share a two-label suffix apart', () => {
    expect(registrableDomain('jobs.greenhouse.io')).toBe('greenhouse.io');
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(sameRegistrableDomain('www.example.com', 'example.com')).toBe(true);

    expect(registrableDomain('a.b.co.uk')).toBe('b.co.uk');
    expect(registrableDomain('c.co.uk')).toBe('c.co.uk');
    expect(registrableDomain('a.b.co.uk')).not.toBe(registrableDomain('c.co.uk'));
    expect(sameRegistrableDomain('a.b.co.uk', 'c.co.uk')).toBe(false);
    expect(sameRegistrableDomain('a.co.uk', 'b.co.uk')).toBe(false);

    expect(sameRegistrableDomain('not-example.com', 'example.com')).toBe(false);
  });

  it('returns IPv4, IPv6, single-label, and empty hosts unchanged without comparing them equal', () => {
    expect(registrableDomain('192.168.1.10')).toBe('192.168.1.10');
    expect(registrableDomain('2001:db8::1')).toBe('2001:db8::1');
    expect(registrableDomain('localhost')).toBe('localhost');
    expect(registrableDomain('')).toBe('');

    expect(sameRegistrableDomain('localhost', 'localhost')).toBe(false);
    expect(sameRegistrableDomain('', '')).toBe(false);
    expect(sameRegistrableDomain('::1', '::1')).toBe(false);
  });
});

describe('transport hosts', () => {
  it('treats known ATS and job-board hosts as transport, never as employer identity', () => {
    expect(isIconTransportHost('greenhouse.io')).toBe(true);
    expect(isIconTransportHost('jobs.lever.co')).toBe(true);
    expect(isIconTransportHost('jobs.ashbyhq.com')).toBe(true);
    expect(isIconTransportHost('job-boards.greenhouse.io')).toBe(true);
    expect(isIconTransportHost('linkedin.com')).toBe(true);
  });

  it('does not treat an employer vanity host or a lookalike host as transport', () => {
    expect(isIconTransportHost('careers.acme.com')).toBe(false);
    expect(isIconTransportHost('lever.co.evil.test')).toBe(false);
  });
});

describe('employer text matching', () => {
  it('matches only when every distinctive employer term appears as its own word', () => {
    expect(iconTextMatchesEmployer('Join Goldman Sachs', 'Goldman Sachs')).toBe(true);
    expect(iconTextMatchesEmployer('Goldman Sachs & Co. Careers', 'Goldman Sachs')).toBe(true);

    expect(iconTextMatchesEmployer('Goldman is hiring', 'Goldman Sachs')).toBe(false);
    expect(iconTextMatchesEmployer('Morgan Stanley', 'Goldman Sachs')).toBe(false);
    expect(iconTextMatchesEmployer('Goldman Sachsville', 'Sachs')).toBe(false);
  });

  it('rejects empty metadata and ignores terms of three characters or fewer', () => {
    expect(iconTextMatchesEmployer(undefined, 'Goldman Sachs')).toBe(false);
    expect(iconTextMatchesEmployer('', 'Goldman Sachs')).toBe(false);

    expect(iconTextMatchesEmployer('ACME is hiring', 'ABC')).toBe(false);
    expect(iconTextMatchesEmployer('AB Corp is hiring', 'AB Corp')).toBe(false);
  });

  it('matches a page that shows the brand alone when the employer name carries qualifiers', () => {
    // Real catalog names carry entity and program suffixes the posting page omits.
    expect(iconTextMatchesEmployer('Home | Palantir', 'Palantir Technologies')).toBe(true);
    expect(iconTextMatchesEmployer('Home | Flagship Pioneering', 'Flagship Pioneering Co-Op Program')).toBe(true);
    expect(iconTextMatchesEmployer('Home US | IMC Trading', 'IMC')).toBe(true);

    // Dropping qualifiers must not turn a distinctive term into a match.
    expect(iconTextMatchesEmployer('Rivian and Volkswagen Group Technologies', 'RV Tech')).toBe(false);
    expect(iconTextMatchesEmployer('Palantir', 'Palantir Systems')).toBe(true);
    expect(iconTextMatchesEmployer('Globex', 'Palantir Technologies')).toBe(false);

    expect(employerDistinctiveTerms('Flagship Pioneering Co-Op Program')).toEqual(['flagship', 'pioneering']);
    expect(employerDistinctiveTerms('Palantir Technologies')).toEqual(['palantir']);
    expect(employerDistinctiveTerms('RV Tech')).toEqual(['tech']);
    // A name made only of qualifiers yields nothing, so matching fails closed.
    expect(employerDistinctiveTerms('AB Corp')).toEqual([]);
  });

  it('accepts a provider brand name that omits qualifiers but never one that adds a distinctive term', () => {
    // The provider must contain every distinctive employer term...
    expect(providerNameMatchesEmployer('Palantir', 'Palantir Technologies')).toBe(true);
    expect(providerNameMatchesEmployer('Flagship Pioneering', 'Flagship Pioneering Co-Op Program')).toBe(true);
    expect(providerNameMatchesEmployer('Scale AI', 'Scale AI')).toBe(true);
    expect(providerNameMatchesEmployer('scale ai, inc.', 'Scale AI')).toBe(true);
    // ...and may append only organizational-form or business-descriptor words, which
    // real providers do routinely ("IMC Trading", "Saronic Technologies").
    expect(providerNameMatchesEmployer('IMC Trading', 'IMC')).toBe(true);
    expect(providerNameMatchesEmployer('Saronic Technologies', 'Saronic')).toBe(true);
    expect(providerNameMatchesEmployer('Palantir Systems', 'Palantir Technologies')).toBe(true);

    // A distinctive extra term is the evidence of a different company, so it never matches.
    expect(providerNameMatchesEmployer('Scale Computing', 'Scale AI')).toBe(false);
    expect(providerNameMatchesEmployer('Palantir Federal', 'Palantir Technologies')).toBe(false);
    expect(providerNameMatchesEmployer('Rivian and Volkswagen Group Technologies', 'RV Tech')).toBe(false);
    expect(providerNameMatchesEmployer('', 'Palantir Technologies')).toBe(false);
  });

  it('corroborates an employer only from a board slug that actually names it', () => {
    // The tenant is the reviewed binding of this employer to its ATS board.
    expect(tenantCorroboratesEmployer('palantir', 'palantir')).toBe(true);
    expect(tenantCorroboratesEmployer('artefactlinkedin', 'artefact')).toBe(true);
    expect(tenantCorroboratesEmployer('rivianvw.tech', 'rivianvw-tech')).toBe(true);
    expect(tenantCorroboratesEmployer('fspco-op012325', 'fspco-op012325')).toBe(true);

    // A board that does not name the employer corroborates nothing, and a slug too
    // short to be distinctive is never enough on its own.
    expect(tenantCorroboratesEmployer('board-1', 'acme')).toBe(false);
    expect(tenantCorroboratesEmployer(undefined, 'acme')).toBe(false);
    expect(tenantCorroboratesEmployer('acme', 'ab')).toBe(false);
    expect(tenantCorroboratesEmployer('fintechcorp', 'tech')).toBe(false);
    // A four-character employer still counts when the board starts or ends with it,
    // but never on a mere substring.
    expect(tenantCorroboratesEmployer('axontalentcommunity', 'axon')).toBe(true);
    expect(tenantCorroboratesEmployer('metacareers', 'meta')).toBe(true);
    expect(tenantCorroboratesEmployer('contechsystems', 'tech')).toBe(false);
  });
});

describe('candidate scoring', () => {
  it('counts each signal group once, however many signals in the group are present', () => {
    expect(scoreIconCandidate(candidate('acme.com', ['final-url', 'redirect-host'])).score).toBe(0.45);
    expect(scoreIconCandidate(candidate('acme.com', ['jsonld-url', 'jsonld-name'])).score).toBe(0.35);
    expect(scoreIconCandidate(candidate('acme.com', ['page-title', 'opengraph'])).score).toBe(0.15);
  });

  it('repeated signals do not inflate a score and do not duplicate evidence ids', () => {
    const repeated = scoreIconCandidate(candidate('acme.com', ['final-url', 'final-url']));
    expect(repeated.score).toBe(0.45);
    expect(repeated.evidenceIds).toEqual(['final-url:acme.com']);
  });

  it('caps the combined score at 1.0', () => {
    const everything = scoreIconCandidate(
      candidate('acme.com', ['final-url', 'redirect-host', 'jsonld-url', 'jsonld-name', 'logo-dev', 'brandfetch', 'page-title', 'opengraph']),
      { providersAgree: true },
    );
    expect(everything.score).toBe(1);
    expect(everything.evidenceIds).toHaveLength(8);
  });

  it('adds the provider agreement bonus only when both providers nominate the same domain', () => {
    expect(scoreIconCandidate(candidate('acme.com', ['logo-dev', 'brandfetch']), { providersAgree: true }).score).toBe(0.85);
    expect(scoreIconCandidate(candidate('acme.com', ['logo-dev', 'brandfetch'])).score).toBe(0.6);
    expect(scoreIconCandidate(candidate('acme.com', ['logo-dev']), { providersAgree: true }).score).toBe(0.3);
  });

  it('rejects an ATS host or a signal-free candidate outright', () => {
    const transport = scoreIconCandidate(candidate('jobs.lever.co', ['final-url']));
    expect(transport).toMatchObject({
      domain: 'lever.co', score: 0, rejected: true,
      rejectionReason: 'ATS or job-board host without employer evidence',
    });

    const unsupported = scoreIconCandidate(candidate('acme.com', []));
    expect(unsupported).toMatchObject({
      domain: 'acme.com', score: 0, rejected: true,
      rejectionReason: 'candidate carries no supporting signal',
    });
  });

  it('lets a platform domain be the employer that owns it, and no one else', () => {
    // Google, GitHub, and Rippling are employers whose own site is a platform
    // domain. Without the exemption they could never have an icon.
    expect(employerNamesDomain('Google', 'google.com')).toBe(true);
    expect(employerNamesDomain('GitHub', 'github.com')).toBe(true);
    expect(employerNamesDomain('Rippling', 'rippling.com')).toBe(true);
    expect(employerNamesDomain('Acme', 'greenhouse.io')).toBe(false);
    expect(employerNamesDomain('Acme', 'lever.co')).toBe(false);

    const owned = scoreIconCandidate(
      { domain: 'google.com', signals: ['final-url', 'page-title'], employerNamesDomain: true },
    );
    expect(owned).toMatchObject({ rejected: false });
    expect(owned.score).toBeCloseTo(0.6, 10);

    // The same host stays unreachable for an employer it merely hosts.
    const hosted = scoreIconCandidate({ domain: 'google.com', signals: ['final-url'] });
    expect(hosted).toMatchObject({ rejected: true, rejectionReason: 'ATS or job-board host without employer evidence' });
  });

  it('rejects a profile platform an organization lists as its own URL', () => {
    // `sameAs` legitimately contains social profiles; none of them is the
    // employer's site, so none of them may become an icon candidate.
    for (const domain of ['twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 'youtube.com', 'substack.com']) {
      expect(isIconTransportHost(domain)).toBe(true);
      expect(scoreIconCandidate(candidate(domain, ['jsonld-url', 'jsonld-name'])).rejected).toBe(true);
    }
  });

  it('orders candidates best-first', () => {
    const ordered = scoreIconCandidates([
      candidate('slow.com', ['page-title']),
      candidate('fast.com', ['final-url', 'jsonld-url']),
    ]);
    expect(ordered.map((entry) => entry.domain)).toEqual(['fast.com', 'slow.com']);
    expect(ordered.map((entry) => entry.score)).toEqual([0.8, 0.15]);
  });

  it('marks provider agreement per eTLD+1 across the whole candidate set', () => {
    const agreed = scoreIconCandidates([
      candidate('acme.com', ['logo-dev', 'brandfetch']),
      candidate('globex.com', ['logo-dev']),
    ]);
    expect(agreed.map((entry) => entry.score)).toEqual([0.85, 0.3]);

    // Agreement is scoped to one eTLD+1 and never merges a signal from another candidate.
    const split = scoreIconCandidates([
      candidate('acme.com', ['logo-dev']),
      candidate('www.acme.com', ['brandfetch']),
    ]);
    expect(split.map((entry) => entry.score)).toEqual([0.3, 0.3]);
    expect(split.map((entry) => entry.signals)).toEqual([['logo-dev'], ['brandfetch']]);
  });
});

describe('domain decision', () => {
  it('resolves a clear winner at or above the automatic threshold', () => {
    const consensus = decideIconDomain([candidate('acme.com', ['logo-dev', 'brandfetch'])]);
    expect(consensus).toMatchObject({ outcome: 'resolved', selectedDomain: 'acme.com', selectedScore: 0.85 });
    expect(consensus.runnerUpScore).toBeUndefined();

    const strong = decideIconDomain([candidate('acme.com', ['final-url', 'jsonld-url', 'page-title'])]);
    expect(strong).toMatchObject({ outcome: 'resolved', selectedDomain: 'acme.com' });
    expect(strong.selectedScore).toBeCloseTo(0.95, 10);
  });

  it('does not auto-resolve when a runner-up sits inside the margin', () => {
    const decision = decideIconDomain([
      candidate('acme.com', ['logo-dev', 'brandfetch']),
      candidate('other.com', ['final-url', 'logo-dev']),
    ]);
    expect(decision).toMatchObject({
      outcome: 'llm-review', selectedDomain: 'acme.com', selectedScore: 0.85, runnerUpScore: 0.75,
    });
  });

  it('escalates a mid-band score to the bounded tie-breaker', () => {
    const decision = decideIconDomain([candidate('acme.com', ['final-url', 'page-title'])]);
    expect(decision).toMatchObject({
      outcome: 'llm-review', selectedDomain: 'acme.com', selectedScore: 0.6,
      reason: 'Score 0.60 needs a bounded tie-breaker',
    });
    expect(decision.runnerUpScore).toBeUndefined();
  });

  it('leaves a low score with no competitor unresolved', () => {
    const decision = decideIconDomain([candidate('acme.com', ['page-title'])]);
    expect(decision).toMatchObject({ outcome: 'unresolved', selectedScore: 0.15 });
    expect(decision.reason).toMatch(/below the 0.55 evidence floor/u);
  });

  it('escalates a corroborated candidate below the band, and only a corroborated one', () => {
    // A lone provider nomination can never be accepted by the tie-breaker, whose
    // own rule requires two independent evidence ids, so it stays a monogram
    // rather than spending a model call that cannot succeed.
    const alone = decideIconDomain([candidate('acme.com', ['logo-dev'])]);
    expect(alone).toMatchObject({ outcome: 'unresolved', selectedScore: 0.30 });

    // The posting page naming the employer is a second, independent fact about
    // the same employer, so this candidate is worth one bounded call.
    const corroborated = decideIconDomain([candidate('acme.com', ['logo-dev', 'page-title'])]);
    expect(corroborated.outcome).toBe('llm-review');
    expect(corroborated.selectedScore).toBeCloseTo(0.45, 10);
    expect(corroborated.reason).toContain('2 independent evidence sources');
  });

  it('leaves an empty or fully rejected candidate set unresolved', () => {
    const empty = decideIconDomain([]);
    expect(empty).toMatchObject({ outcome: 'unresolved', scores: [], reason: 'No eligible employer domain candidate' });

    const rejected = decideIconDomain([candidate('jobs.lever.co', ['final-url'])]);
    expect(rejected).toMatchObject({ outcome: 'unresolved', reason: 'No eligible employer domain candidate' });
  });

  it('escalates a tie between two equal candidates', () => {
    const decision = decideIconDomain([
      candidate('acme.com', ['logo-dev', 'brandfetch']),
      candidate('globex.com', ['logo-dev', 'brandfetch']),
    ]);
    expect(decision).toMatchObject({ outcome: 'llm-review', selectedScore: 0.85, runnerUpScore: 0.85 });
  });
});

describe('tie-break parsing', () => {
  it('accepts a well-formed decision and normalises its domain and reason', () => {
    expect(parseIconTieBreakDecision({
      decision: 'accept', officialDomain: '  ACME.COM ', confidence: 0.95,
      evidenceIds: [' final-url:acme.com ', 'final-url:acme.com', 'jsonld-url:acme.com'],
      reason: '  supported by the final URL and JSON-LD  ',
    })).toEqual({
      decision: 'accept', officialDomain: 'acme.com', confidence: 0.95,
      evidenceIds: ['final-url:acme.com', 'jsonld-url:acme.com'],
      reason: 'supported by the final URL and JSON-LD',
    });

    expect(parseIconTieBreakDecision({
      decision: 'uncertain', officialDomain: null, confidence: 0.5, evidenceIds: [], reason: 'not enough evidence',
    })).toMatchObject({ decision: 'uncertain', officialDomain: null, evidenceIds: [] });
  });

  it('rejects anything but the exact declared shape', () => {
    expect(parseIconTieBreakDecision(null)).toBeUndefined();
    expect(parseIconTieBreakDecision([])).toBeUndefined();
    expect(parseIconTieBreakDecision('accept')).toBeUndefined();

    expect(parseIconTieBreakDecision({
      decision: 'accept', officialDomain: 'acme.com', confidence: 0.95, evidenceIds: [], reason: '',
    })).toBeUndefined();
    expect(parseIconTieBreakDecision({
      decision: 'accept', officialDomain: 'acme.com', confidence: 0.95, evidenceIds: [],
      reason: 'ok', assetUrl: 'https://evil.test/x.webp',
    })).toBeUndefined();
    expect(parseIconTieBreakDecision({
      decision: 'accept', domain: 'acme.com', confidence: 0.95, evidenceIds: [], reason: 'ok',
    })).toBeUndefined();
  });

  it('rejects a bad decision enum or a non-numeric or out-of-range confidence', () => {
    expect(parseIconTieBreakDecision(tieBreak({ decision: 'Accept' as unknown as IconTieBreakDecision['decision'] }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ decision: 'maybe' as unknown as IconTieBreakDecision['decision'] }))).toBeUndefined();

    expect(parseIconTieBreakDecision(tieBreak({ confidence: '0.95' as unknown as number }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ confidence: Number.NaN }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ confidence: 1.01 }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ confidence: -0.01 }))).toBeUndefined();
  });

  it('rejects a non-array evidence list, a non-string id, or more than eight ids', () => {
    expect(parseIconTieBreakDecision(tieBreak({ evidenceIds: 'final-url:acme.com' as unknown as string[] }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ evidenceIds: [123 as unknown as string] }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ evidenceIds: ['   '] }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ evidenceIds: Array.from({ length: 9 }, (_, index) => `id:${index}`) }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ evidenceIds: Array.from({ length: 8 }, (_, index) => `id:${index}`) })))
      .toMatchObject({ evidenceIds: Array.from({ length: 8 }, (_, index) => `id:${index}`) });
  });

  it('rejects a blank or over-long reason and accepts the length boundary', () => {
    expect(parseIconTieBreakDecision(tieBreak({ reason: '' }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ reason: '   ' }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ reason: 'x'.repeat(301) }))).toBeUndefined();
    expect(parseIconTieBreakDecision(tieBreak({ reason: 'x'.repeat(300) }))).toMatchObject({ reason: 'x'.repeat(300) });
  });
});

describe('tie-break acceptance (the arbitrary-domain defence)', () => {
  it('rejects a malformed, declined, or uncertain decision', () => {
    expect(acceptIconTieBreak(undefined, submitted)).toEqual({ accepted: false, reasonCode: 'malformed-decision' });
    expect(acceptIconTieBreak(tieBreak({ decision: 'reject' }), submitted))
      .toEqual({ accepted: false, reasonCode: 'decision-reject' });
    expect(acceptIconTieBreak(tieBreak({ decision: 'uncertain' }), submitted))
      .toEqual({ accepted: false, reasonCode: 'decision-uncertain' });
  });

  it('rejects confidence below 0.90 and accepts exactly 0.90', () => {
    expect(acceptIconTieBreak(tieBreak({ confidence: 0.89 }), submitted))
      .toEqual({ accepted: false, reasonCode: 'confidence-below-floor' });
    expect(acceptIconTieBreak(tieBreak({ confidence: 0.9 }), submitted))
      .toEqual({ accepted: true, domain: 'acme.com', reasonCode: 'accepted' });
  });

  it('rejects a missing domain or one outside the submitted candidates', () => {
    expect(acceptIconTieBreak(tieBreak({ officialDomain: null }), submitted))
      .toEqual({ accepted: false, reasonCode: 'domain-missing' });
    expect(acceptIconTieBreak(tieBreak({ officialDomain: '' }), submitted))
      .toEqual({ accepted: false, reasonCode: 'domain-missing' });

    expect(acceptIconTieBreak(tieBreak({ officialDomain: 'evil.test' }), submitted))
      .toEqual({ accepted: false, reasonCode: 'domain-outside-candidates' });
    expect(acceptIconTieBreak(tieBreak({ officialDomain: 'acme.com.evil.test' }), submitted))
      .toEqual({ accepted: false, reasonCode: 'domain-outside-candidates' });
  });

  it('selects the submitted candidate when the model names a subdomain of it, comparing on registrable domain', () => {
    expect(acceptIconTieBreak(tieBreak({ officialDomain: 'careers.acme.com' }), submitted))
      .toEqual({ accepted: true, domain: 'acme.com', reasonCode: 'accepted' });
  });

  it('never selects a candidate that scoring rejected, even by exact domain', () => {
    const withRejected = [score('acme.com', ['final-url:acme.com', 'jsonld-url:acme.com'], true), submitted[1]!];
    expect(acceptIconTieBreak(tieBreak(), withRejected))
      .toEqual({ accepted: false, reasonCode: 'domain-outside-candidates' });
  });

  it('rejects an evidence id that was never submitted', () => {
    expect(acceptIconTieBreak(
      tieBreak({ evidenceIds: ['final-url:acme.com', 'logo-dev:acme.com'] }),
      submitted,
    )).toEqual({ accepted: false, reasonCode: 'evidence-outside-input' });
  });

  it('rejects evidence that belongs to a different candidate than the chosen domain', () => {
    expect(acceptIconTieBreak(
      tieBreak({ evidenceIds: ['final-url:acme.com', 'final-url:other.com'] }),
      submitted,
    )).toEqual({ accepted: false, reasonCode: 'evidence-does-not-support-domain' });
  });

  it('requires two distinct evidence ids, even when one id is cited twice', () => {
    expect(acceptIconTieBreak(tieBreak({ evidenceIds: ['final-url:acme.com'] }), submitted))
      .toEqual({ accepted: false, reasonCode: 'insufficient-independent-evidence' });

    const repeated = parseIconTieBreakDecision({
      decision: 'accept', officialDomain: 'acme.com', confidence: 0.95,
      evidenceIds: ['final-url:acme.com', 'final-url:acme.com'], reason: 'one source repeated',
    });
    expect(acceptIconTieBreak(repeated, submitted))
      .toEqual({ accepted: false, reasonCode: 'insufficient-independent-evidence' });
  });

  it('accepts two distinct evidence ids that both belong to the chosen candidate', () => {
    expect(acceptIconTieBreak(tieBreak(), submitted))
      .toEqual({ accepted: true, domain: 'acme.com', reasonCode: 'accepted' });
  });
});

describe('evidence fingerprint', () => {
  const base = {
    canonicalEmployerId: 'goldman-sachs',
    displayName: 'Goldman Sachs',
    applicationUrl: 'https://careers.goldmansachs.com/jobs/1?utm_source=linkedin',
    provider: 'greenhouse',
    tenant: 'goldman-sachs',
  };

  it('is identical for identical evidence', () => {
    expect(iconEvidenceFingerprint({ ...base })).toBe(iconEvidenceFingerprint({
      canonicalEmployerId: 'goldman-sachs', displayName: 'Goldman Sachs',
      applicationUrl: 'https://careers.goldmansachs.com/jobs/1?utm_source=linkedin',
      provider: 'greenhouse', tenant: 'goldman-sachs',
    }));
  });

  it('separates evidence whose employer, link host, link path, provider, or tenant differs', () => {
    const fingerprint = iconEvidenceFingerprint(base);
    expect(iconEvidenceFingerprint({ ...base, displayName: 'Morgan Stanley' })).not.toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, displayName: 'Goldman Sachs Asset Management' })).not.toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, applicationUrl: 'https://jobs.goldmansachs.com/jobs/1?utm_source=linkedin' })).not.toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, applicationUrl: 'https://careers.goldmansachs.com/jobs/2?utm_source=linkedin' })).not.toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, provider: 'lever' })).not.toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, tenant: 'globex' })).not.toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, tenant: undefined })).not.toBe(fingerprint);
  });

  it('collapses an identical link that differs only by query string or a trailing slash', () => {
    const fingerprint = iconEvidenceFingerprint(base);
    expect(iconEvidenceFingerprint({ ...base, applicationUrl: 'https://careers.goldmansachs.com/jobs/1?ref=xyz' })).toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, applicationUrl: 'https://careers.goldmansachs.com/jobs/1/' })).toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, applicationUrl: 'https://careers.goldmansachs.com/jobs/1//' })).toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, applicationUrl: 'https://careers.goldmansachs.com' }))
      .toBe(iconEvidenceFingerprint({ ...base, applicationUrl: 'https://careers.goldmansachs.com/' }));
  });

  it('collapses a redelivered display-name variant that normalises identically', () => {
    const fingerprint = iconEvidenceFingerprint(base);
    expect(iconEvidenceFingerprint({ ...base, displayName: '  goldman   sachs ' })).toBe(fingerprint);
    expect(iconEvidenceFingerprint({ ...base, displayName: 'Goldman Sachs, Inc.' })).toBe(fingerprint);
  });
});

describe('company monogram', () => {
  it('derives initials from the first two words of a label', () => {
    expect(companyMonogramInitials('acme-corp')).toBe('AC');
    expect(companyMonogramInitials('Acme Corp')).toBe('AC');
    expect(companyMonogramInitials('Hewlett-Packard')).toBe('HP');
    expect(companyMonogramInitials('Acme')).toBe('A');
  });

  it('falls back to a question mark when a label has no words', () => {
    expect(companyMonogramInitials('')).toBe('?');
    expect(companyMonogramInitials('  -  ')).toBe('?');
  });

  it('keeps the palette index stable, in range, and spread across identities', () => {
    const index = companyMonogramColorIndex('acme');
    expect(companyMonogramColorIndex('acme')).toBe(index);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(companyMonogramColors.length);
    expect(companyMonogramColorIndex('globex')).not.toBe(index);
  });
});
