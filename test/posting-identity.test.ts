import { describe, expect, it } from 'vitest';
import { normalizeUrl, postingIdentity, postingIdentityKey, roleFamilyFingerprint } from '../src/core/normalize.js';
import { buildPostingIdentity, providerPostingReference, resolvePostingAliases } from '../src/identity/posting.js';
import { providerEvidenceForOccurrence, reviewedProviderUrlReference } from '../src/identity/reviewed-provider.js';
import { postingReviewFamily, resolvePostingIdentityDecision, reviewedCanonicalUrlEvidenceHash, stableSourceOccurrenceJobId } from '../src/identity/registry.js';

describe('posting identity', () => {
  const plusId = '5f2c0f4e-1c3a-4f2b-9d3e-77c1a2b4c5d6';
  it('keeps syntactically normalized but unreviewed URLs source-local', () => {
    const first = resolvePostingIdentityDecision({
      sourceId: 'community-a', externalId: '42', applicationUrl: 'https://careers.example.test/jobs/42?utm_source=a',
      observedAt: '2026-08-29T12:00:00.000Z',
    });
    expect(first).toMatchObject({ decision: { status: 'unconfirmed', reason: 'unrecognized-url-family' } });
    expect(first.identity).toBeUndefined();
    expect(stableSourceOccurrenceJobId('community-a', '42')).not.toBe(stableSourceOccurrenceJobId('community-b', '42'));
  });

  it('confirms reviewed provider evidence with a versioned evidence hash', () => {
    const result = resolvePostingIdentityDecision({
      sourceId: 'greenhouse-figma', externalId: '100',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100', observedAt: '2026-08-29T12:00:00.000Z',
      providerEvidence: { provider: 'greenhouse', tenant: 'figma', postingId: '100', sourceId: 'greenhouse-figma', urls: [] },
    });
    expect(result).toMatchObject({
      decision: { status: 'confirmed', evidenceKind: 'immutable-provider-id', exactKey: 'provider:greenhouse:figma:100', contractVersion: 1 },
      identity: { provider: 'greenhouse', providerPostingId: '100' },
    });
  });

  it('preserves historical confirmation but does not authorize a new alias from stale evidence', () => {
    const input = {
      sourceId: 'greenhouse-figma', externalId: '100', applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedAt: '2026-08-29T12:00:00.000Z',
      providerEvidence: { provider: 'greenhouse' as const, tenant: 'figma', postingId: '100', sourceId: 'greenhouse-figma', urls: [], expiresAt: '2026-08-28T00:00:00.000Z' },
    };
    expect(resolvePostingIdentityDecision(input)).toMatchObject({ decision: { status: 'unconfirmed', reason: 'stale-evidence' } });
    const current = resolvePostingIdentityDecision({ ...input, providerEvidence: { ...input.providerEvidence, expiresAt: undefined } });
    const historical = resolvePostingIdentityDecision({ ...input, previousDecision: current.decision });
    expect(historical).toMatchObject({ decision: { status: 'confirmed' } });
    expect(historical.identity?.aliases.map((alias) => alias.value)).toEqual(['provider:greenhouse:figma:100']);
  });

  it('keeps an immutable provider decision byte-stable as observed URL evidence changes', () => {
    const initial = resolvePostingIdentityDecision({
      sourceId: 'greenhouse-figma', externalId: '100',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedAt: '2026-08-29T12:00:00.000Z',
      providerEvidence: {
        provider: 'greenhouse', tenant: 'figma', postingId: '100', sourceId: 'greenhouse-figma',
        urls: ['https://boards.greenhouse.io/embed/job_app?token=100'],
      },
    });
    const replay = resolvePostingIdentityDecision({
      sourceId: 'greenhouse-figma', externalId: '100',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedAt: '2026-08-30T12:00:00.000Z',
      providerEvidence: {
        provider: 'greenhouse', tenant: 'figma', postingId: '100', sourceId: 'greenhouse-figma',
        urls: ['https://job-boards.greenhouse.io/figma/jobs/100'],
      },
      previousDecision: initial.decision,
    });
    expect(replay.decision).toEqual(initial.decision);
  });

  it('retains a confirmed provider route after its active checkpoint evidence expires', () => {
    const initial = resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedAt: '2026-08-29T12:00:00.000Z',
      reviewedProviderReferences: [{ provider: 'greenhouse', tenant: 'figma', postingId: '100' }],
    });
    const historical = resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedAt: '2026-08-30T12:00:00.000Z', previousDecision: initial.decision,
    });
    expect(historical.decision).toEqual(initial.decision);
    expect(historical.identity?.aliases.map((alias) => alias.value)).toEqual(['provider:greenhouse:figma:100']);
  });

  it('does not retain a confirmed decision after the provider posting route changes', () => {
    const initial = resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedAt: '2026-08-29T12:00:00.000Z',
      reviewedProviderReferences: [{ provider: 'greenhouse', tenant: 'figma', postingId: '100' }],
    });
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/101',
      observedAt: '2026-08-30T12:00:00.000Z', previousDecision: initial.decision,
    })).toMatchObject({
      decision: { status: 'confirmed', exactKey: 'provider:greenhouse:figma:101', evidenceKind: 'immutable-provider-id' },
    });
  });

  it('confirms identity from a scoped provider route with no other evidence', () => {
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedAt: '2026-08-29T12:00:00.000Z',
    })).toMatchObject({
      decision: { status: 'confirmed', exactKey: 'provider:greenhouse:figma:100', evidenceKind: 'immutable-provider-id' },
    });
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role-2',
      applicationUrl: `https://jobs.lever.co/plus-2/${plusId}/apply`,
      observedAt: '2026-08-29T12:00:00.000Z',
    })).toMatchObject({ decision: { status: 'confirmed', exactKey: `provider:lever:plus-2:${plusId}` } });
  });

  it('quarantines routes that name two ids or two provider scopes', () => {
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedUrls: ['https://job-boards.greenhouse.io/figma/jobs/101'],
      observedAt: '2026-08-29T12:00:00.000Z',
    }).decision).toMatchObject({ status: 'quarantined', reason: 'multiple-immutable-provider-postings' });
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/100',
      observedUrls: [`https://jobs.lever.co/plus-2/${plusId}`],
      observedAt: '2026-08-29T12:00:00.000Z',
    }).decision).toMatchObject({ status: 'quarantined', reason: 'provider-scope-mismatch' });
  });

  it('confirms a scoped route on the legacy greenhouse board host', () => {
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://boards.greenhouse.io/figma/jobs/100',
      observedAt: '2026-08-29T12:00:00.000Z',
    })).toMatchObject({
      decision: { status: 'confirmed', exactKey: 'provider:greenhouse:figma:100', evidenceKind: 'immutable-provider-id' },
    });
  });

  it('confirms scoped provider routes for SmartRecruiters and iCIMS', () => {
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://jobs.smartrecruiters.com/BoschGroup/744000139649345',
      observedAt: '2026-08-29T12:00:00.000Z',
    })).toMatchObject({
      decision: { status: 'confirmed', exactKey: 'provider:smartrecruiters:boschgroup:744000139649345', evidenceKind: 'immutable-provider-id' },
    });
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role-2',
      applicationUrl: 'https://careers-springswindowfashions.icims.com/jobs/12891/job?mobile=true&needsRedirect=false',
      observedAt: '2026-08-29T12:00:00.000Z',
    })).toMatchObject({ decision: { status: 'confirmed', exactKey: 'provider:icims:careers-springswindowfashions:12891' } });
  });

  it.each([
    ['EU Greenhouse', 'https://job-boards.eu.greenhouse.io/Acme/jobs/101', 'provider:greenhouse:acme:101'],
    ['SmartRecruiters slug', 'https://jobs.smartrecruiters.com/Acme/744000139649345-software-engineer', 'provider:smartrecruiters:acme:744000139649345'],
    ['SuccessFactors', 'https://jobs.successfactors.com/job/London/Software-Intern/123456', 'provider:successfactors:jobs.successfactors.com:123456'],
    ['Workable', 'https://apply.workable.com/Acme/j/ABC123DEF/', 'provider:workable:acme:abc123def'],
    ['Microsoft', 'https://jobs.careers.microsoft.com/global/en/job/1891234', 'provider:microsoft:microsoft:1891234'],
    ['Rippling', 'https://ats.rippling.com/acme/jobs/123e4567-e89b-12d3-a456-426614174000', 'provider:rippling:acme:123e4567-e89b-12d3-a456-426614174000'],
    ['Eightfold', 'https://careers.acme.eightfold.ai/careers/job/REQ-42', 'provider:eightfold:careers.acme.eightfold.ai:req-42'],
    ['Paylocity', 'https://recruiting.paylocity.com/recruiting/jobs/Details/12345/Acme', 'provider:paylocity:acme:12345'],
    ['Jobvite', 'https://jobs.jobvite.com/Acme/job/ABC123', 'provider:jobvite:acme:abc123'],
    ['Amazon', 'https://www.amazon.jobs/en/jobs/2891234/software-development-engineer-intern', 'provider:amazon:amazon:2891234'],
    ['Google', 'https://www.google.com/about/careers/applications/jobs/results/123456789-software-engineering-intern', 'provider:google:google:123456789'],
  ])('recognizes a scoped immutable %s route', (_name, url, exactKey) => {
    expect(resolvePostingIdentityDecision({ sourceId: 'community', externalId: 'role', applicationUrl: url,
      observedAt: '2026-09-19T00:00:00.000Z' })).toMatchObject({
      decision: { status: 'confirmed', exactKey, evidenceKind: 'immutable-provider-id' },
    });
  });

  it('does not turn arbitrary identifiers or provider query parameters into claims', () => {
    for (const url of [
      'https://apply.workable.com/acme/',
      'https://jobs.jobvite.com/acme/job/',
      'https://careers.acme.eightfold.ai/careers',
      'https://careers.example.test/openings?gh_jid=100',
    ]) expect(providerPostingReference(url)).toEqual({ provider: 'unknown' });
  });

  it('keeps identical provider IDs on different tenants from merging', () => {
    const acme = buildPostingIdentity({ applicationUrl: 'https://apply.workable.com/acme/j/ABC123DEF' });
    const other = buildPostingIdentity({ applicationUrl: 'https://apply.workable.com/other/j/ABC123DEF' });
    expect(acme.canonicalJobId).not.toBe(other.canonicalJobId);
    const combined = buildPostingIdentity({
      applicationUrl: 'https://apply.workable.com/acme/j/ABC123DEF',
      observedUrls: ['https://apply.workable.com/other/j/ABC123DEF'],
    });
    expect(resolvePostingAliases(combined, new Map())).toMatchObject({ outcome: 'quarantine', reason: 'provider-scope-mismatch' });
  });

  it('confirms a scoped Oracle Cloud route and keeps its sites apart', () => {
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210774074',
      observedAt: '2026-08-29T12:00:00.000Z',
    })).toMatchObject({
      decision: {
        status: 'confirmed',
        exactKey: 'provider:oracle:jpmc.fa.oraclecloud.com/cx_1001:210774074',
        evidenceKind: 'immutable-provider-id',
      },
    });
    // One pod can carry the same posting id under two candidate-experience
    // sites, so two sites in one reference set must not merge.
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210774074',
      observedUrls: ['https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/job/210774074'],
      observedAt: '2026-08-29T12:00:00.000Z',
    }).decision).toMatchObject({ status: 'quarantined' });
  });

  it('leaves a provider host without a posting route unconfirmed', () => {
    for (const url of ['https://jobs.smartrecruiters.com/BoschGroup', 'https://careers-sig.icims.com/jobs']) {
      expect(resolvePostingIdentityDecision({
        sourceId: 'community', externalId: 'role', applicationUrl: url, observedAt: '2026-08-29T12:00:00.000Z',
      }).decision).toMatchObject({ status: 'unconfirmed' });
    }
  });

  it('keeps an unscoped greenhouse embed token unconfirmed', () => {
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: 'role',
      applicationUrl: 'https://boards.greenhouse.io/embed/job_app?token=100&utm_source=Simplify',
      observedAt: '2026-08-29T12:00:00.000Z',
    }).decision).toMatchObject({ status: 'unconfirmed', reason: 'under-scoped-id' });
  });

  it('sanitizes URL-family candidates without retaining query values', () => {
    expect(postingReviewFamily('https://Careers.Example.test/jobs/123?token=secret&ref=email'))
      .toBe('careers.example.test/jobs/:number?ref&token');
  });

  it('confirms an authoritative employer requisition without relying on URL syntax', () => {
    const result = resolvePostingIdentityDecision({
      sourceId: 'employer:acme:submission:req-42', externalId: 'req-42',
      applicationUrl: 'https://careers.acme.test/apply', observedAt: '2026-08-29T12:00:00.000Z',
      employerId: 'acme', employerRequisitionId: 'REQ-42', employerRequisitionAuthoritative: true,
    });
    expect(result).toMatchObject({
      decision: {
        status: 'confirmed', evidenceKind: 'authoritative-employer-requisition',
        exactKey: 'requisition:acme:req-42', employerId: 'acme', contractVersion: 1,
      },
      identity: { employerRequisitionId: 'req-42', employerRequisitionAuthoritative: true },
    });
    expect(result.identity?.aliases.map((alias) => alias.value)).toEqual(['requisition:acme:req-42']);
  });

  it('does not let one reused application URL bridge different exact provider postings', () => {
    const applicationUrl = 'https://careers.example.test/apply';
    const first = resolvePostingIdentityDecision({
      sourceId: 'ashby-acme', externalId: 'first', applicationUrl,
      observedAt: '2026-08-29T12:00:00.000Z',
      reviewedProviderReferences: [{ provider: 'ashby', tenant: 'acme', postingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
    });
    const second = resolvePostingIdentityDecision({
      sourceId: 'ashby-acme', externalId: 'second', applicationUrl,
      observedAt: '2026-08-29T12:00:00.000Z',
      reviewedProviderReferences: [{ provider: 'ashby', tenant: 'acme', postingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }],
    });
    expect(first.identity?.aliases.map((alias) => alias.value)).toEqual(['provider:ashby:acme:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);
    expect(second.identity?.aliases.map((alias) => alias.value)).toEqual(['provider:ashby:acme:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']);
    expect(first.identity?.canonicalJobId).not.toBe(second.identity?.canonicalJobId);
  });

  it('requires a checked-in contract and an observed exact URL for reviewer-approved URL identity', () => {
    const canonicalUrl = 'https://careers.example.test/jobs/42';
    const reviewedCanonicalUrl = {
      canonicalUrl,
      contractId: 'reviewed-canonical-url',
      contractVersion: 1,
      approvalReference: 'review:decision-42',
      evidenceHash: reviewedCanonicalUrlEvidenceHash(canonicalUrl),
      observedAt: '2026-08-29T12:00:00.000Z',
    };
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: '42', applicationUrl: canonicalUrl,
      observedAt: reviewedCanonicalUrl.observedAt, reviewedCanonicalUrl,
    })).toMatchObject({ decision: { status: 'confirmed', evidenceKind: 'reviewed-canonical-url' } });
    expect(resolvePostingIdentityDecision({
      sourceId: 'community', externalId: '43', applicationUrl: 'https://careers.example.test/jobs/43',
      observedAt: reviewedCanonicalUrl.observedAt, reviewedCanonicalUrl,
    })).toMatchObject({ decision: { status: 'quarantined', reason: 'evidence-contract-mismatch' } });
  });

  it.each([
    [
      'multiple-authoritative-requisitions',
      [{ employerId: 'acme', requisitionId: 'one' }, { employerId: 'acme', requisitionId: 'two' }],
    ],
    [
      'employer-scope-mismatch',
      [{ employerId: 'acme', requisitionId: 'one' }, { employerId: 'other', requisitionId: 'one' }],
    ],
  ] as const)('quarantines %s before any alias is claimed', (reason, authoritativeEmployerRequisitions) => {
    expect(resolvePostingIdentityDecision({
      sourceId: 'employer-review', externalId: 'row', applicationUrl: 'https://careers.example.test/apply',
      observedAt: '2026-08-29T12:00:00.000Z', authoritativeEmployerRequisitions: [...authoritativeEmployerRequisitions],
    })).toMatchObject({ decision: { status: 'quarantined', reason } });
  });
  it.each([
    ['Ashby', 'https://jobs.ashbyhq.com/OpusClip/501d374d-7d4f-4889-bc53-0a1fd16253ea/application?embed=true', 'https://jobs.ashbyhq.com/opusclip/501d374d-7d4f-4889-bc53-0a1fd16253ea'],
    ['Greenhouse', 'https://boards.greenhouse.io/AssuredGuaranty/jobs/8700953002?gh_jid=8700953002', 'https://job-boards.greenhouse.io/assuredguaranty/jobs/8700953002'],
    ['Greenhouse gh_jid', 'https://boards.greenhouse.io/AssuredGuaranty?gh_jid=8700953002&utm_source=feed', 'https://job-boards.greenhouse.io/assuredguaranty/jobs/8700953002'],
    ['Workday', 'https://micron.wd1.myworkdayjobs.com/External/job/Boise/Intern_JR108448', 'https://micron.wd1.myworkdayjobs.com/external/job/Boise/renamed-role_JR108448'],
    ['Workday route host', 'https://micron.wd1.myworkdayjobs.com/External/job/Boise/Intern_JR108448', 'https://micron.wd5.myworkdayjobs.com/en-US/External/job/Intern_JR108448'],
    ['ByteDance family', 'https://lifeattiktok.com/search/7672883129493948677', 'https://jobs.bytedance.com/en/position/7672883129493948677/detail'],
    ['Tesla Careers', 'https://www.tesla.com/careers/search/job/275558', 'https://www.tesla.com/en_CA/careers/search/job/internship-distributed-systems-engineer-275558'],
    ['Meta Careers', 'https://www.metacareers.com/jobs/1027438186737957', 'https://www.metacareers.com/profile/job_details/1027438186737957/'],
    ['Jane Street', 'https://www.janestreet.com/join-jane-street/position/8599644002', 'https://www.janestreet.com/join-jane-street/apply/8599644002/'],
    ['Goldman Sachs', 'https://higher.gs.com/roles/171567', 'https://higher.gs.com/roles/171567?type=students'],
    ['IMC', 'https://www.imc.com/us/careers/jobs/4823924101', 'https://www.imc.com/gb/careers/jobs/4823924101?ref=feed'],
  ])('matches %s URL aliases', (_provider, left, right) => {
    expect(postingIdentity(left)).toBe(postingIdentity(right));
    expect(postingIdentityKey(left)).toBe(postingIdentityKey(right));
  });

  it('keeps distinct provider requisitions separate even when their titles would match', () => {
    expect(postingIdentity('https://lifeattiktok.com/search/7672569081632229685')).not.toBe(postingIdentity('https://lifeattiktok.com/search/7672562486917286149'));
  });

  it('does not treat provider-ID prefixes or malformed UUID slugs as authoritative aliases', () => {
    const leverBackend = buildPostingIdentity({ applicationUrl: 'https://jobs.lever.co/acme/deadbeef/backend' });
    const leverFrontend = buildPostingIdentity({ applicationUrl: 'https://jobs.lever.co/acme/deadbeef/frontend' });
    const ashbyBackend = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/deadbeef/backend' });
    const ashbyFrontend = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/deadbeef/frontend' });
    expect(leverBackend.provider).toBe('unknown');
    expect(ashbyBackend.provider).toBe('unknown');
    expect(leverBackend.canonicalJobId).not.toBe(leverFrontend.canonicalJobId);
    expect(ashbyBackend.canonicalJobId).not.toBe(ashbyFrontend.canonicalJobId);
  });

  it('accepts only reviewed provider suffixes after an immutable posting ID', () => {
    const uuid = '501d374d-7d4f-4889-bc53-0a1fd16253ea';
    for (const url of [
      `https://jobs.lever.co/acme/${uuid}/backend`,
      `https://jobs.ashbyhq.com/acme/${uuid}/frontend`,
      'https://job-boards.greenhouse.io/acme/jobs/123/backend',
      'https://jobs.bytedance.com/en/position/123/frontend',
      'https://www.tesla.com/careers/search/job/software-intern',
      'https://www.metacareers.com/jobs/not-a-number',
      'https://www.janestreet.com/join-jane-street/position/not-a-number',
      'https://higher.gs.com/roles/not-a-number',
      'https://www.imc.com/us/careers/jobs/not-a-number',
    ]) expect(providerPostingReference(url).provider).toBe('unknown');
    expect(providerPostingReference(`https://jobs.lever.co/acme/${uuid}/apply`).provider).toBe('lever');
    expect(providerPostingReference(`https://jobs.ashbyhq.com/acme/${uuid}/application`).provider).toBe('ashby');
    expect(providerPostingReference('https://jobs.bytedance.com/en/position/123/detail').provider).toBe('bytedance');
  });

  it.each([
    ['tesla', 'https://www.tesla.com/careers/search/job/internship-software-engineer-275558', 'tesla', '275558'],
    ['meta', 'https://www.metacareers.com/profile/job_details/1027438186737957/', 'meta', '1027438186737957'],
    ['janestreet', 'https://www.janestreet.com/join-jane-street/position/8599644002/', 'janestreet', '8599644002'],
    ['goldman-sachs', 'https://higher.gs.com/roles/171567', 'goldman-sachs', '171567'],
    ['imc', 'https://www.imc.com/us/careers/jobs/4823924101', 'imc', '4823924101'],
  ] as const)('confirms a reviewed %s route directly', (provider, applicationUrl, tenant, postingId) => {
    expect(resolvePostingIdentityDecision({
      sourceId: 'reviewed-community', externalId: applicationUrl, applicationUrl,
      observedAt: '2026-09-01T12:00:00.000Z',
    })).toMatchObject({
      decision: {
        status: 'confirmed', evidenceKind: 'immutable-provider-id',
        exactKey: `provider:${provider}:${tenant}:${postingId}`,
      },
      identity: { provider, tenant, providerPostingId: postingId },
    });
  });

  it('groups location variants only as a soft role family', () => {
    expect(roleFamilyFingerprint('🔥 TikTok', 'Product Manager Intern - Ads Interface and Platform', 'summer-2027')).toBe(roleFamilyFingerprint('TikTok', 'Product Manager Internship - Ads Interface and Platform', 'Summer 2027'));
  });

  it('canonicalizes provider presentation routes without dropping meaningful query data', () => {
    expect(normalizeUrl('HTTPS://Jobs.AshbyHQ.com/Acme/ABC-123/application/?embed=true&utm_source=x#apply'))
      .toBe('https://jobs.ashbyhq.com/acme/abc-123');
    expect(normalizeUrl('https://jobs.example.test/opening/?department=eng&ref=feed&candidate=42'))
      .toBe('https://jobs.example.test/opening?candidate=42&department=eng');
  });

  it('builds a stable exact identity and scopes authoritative requisitions to an employer', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://boards.greenhouse.io/Acme/jobs/123?gh_jid=123',
      observedUrls: ['https://job-boards.greenhouse.io/acme/jobs/123?utm_source=community'],
      employerId: 'acme',
      employerRequisitionId: ' SWE-42 ',
      employerRequisitionAuthoritative: true,
      reviewedProviderReferences: [{ provider: 'greenhouse', tenant: 'acme', postingId: '123' }],
    });
    expect(identity).toMatchObject({
      provider: 'greenhouse',
      tenant: 'acme',
      providerPostingId: '123',
      canonicalApplicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
    });
    expect(identity).not.toHaveProperty('employerId');
    expect(identity.aliases.map((item) => item.value)).toContain('requisition:acme:swe-42');
    expect(buildPostingIdentity({ applicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/123', reviewedProviderReferences: [{ provider: 'greenhouse', tenant: 'acme', postingId: '123' }] }).canonicalJobId)
      .toBe(identity.canonicalJobId);
  });

  it('keeps a reviewed board token provider-scoped instead of treating it as an employer', () => {
    const evidence = providerEvidenceForOccurrence(
      'greenhouse-axontalentcommunity',
      '8675309',
      ['https://job-boards.greenhouse.io/axontalentcommunity/jobs/8675309'],
    );
    expect(evidence).toEqual({
      provider: 'greenhouse',
      tenant: 'axontalentcommunity',
      postingId: '8675309',
      sourceId: 'greenhouse-axontalentcommunity',
      urls: ['https://job-boards.greenhouse.io/axontalentcommunity/jobs/8675309'],
    });
    const identity = buildPostingIdentity({
      applicationUrl: 'https://job-boards.greenhouse.io/axontalentcommunity/jobs/8675309',
      providerEvidence: evidence,
    });
    expect(identity).toMatchObject({ provider: 'greenhouse', tenant: 'axontalentcommunity', providerPostingId: '8675309' });
    expect(identity).not.toHaveProperty('employerId');
  });

  it('deterministically creates, merges, or quarantines alias claims', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      observedUrls: ['https://careers.acme.test/jobs/a?utm_source=feed'],
    });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({ outcome: 'create', canonicalJobId: identity.canonicalJobId });
    const firstAlias = identity.aliases[0]!.value;
    expect(resolvePostingAliases(identity, new Map([[firstAlias, 'existing-job']]))).toMatchObject({ outcome: 'merge', canonicalJobId: 'existing-job' });
    const claims = new Map(identity.aliases.slice(0, 2).map((item, index) => [item.value, `job-${index}`]));
    expect(resolvePostingAliases(identity, claims)).toMatchObject({
      outcome: 'quarantine',
      conflictingCanonicalJobIds: ['job-0', 'job-1'],
      reason: 'aliases-resolve-to-different-jobs',
    });
  });

  it('quarantines two immutable IDs from the same provider tenant even before claims exist', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      observedUrls: ['https://jobs.lever.co/acme/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
      reviewedProviderReferences: [
        { provider: 'lever', tenant: 'acme', postingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        { provider: 'lever', tenant: 'acme', postingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      ],
    });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({ outcome: 'quarantine', reason: 'multiple-immutable-provider-postings' });
  });

  it('recognizes a reviewed DRW custom route but not an arbitrary lookalike host', () => {
    expect(reviewedProviderUrlReference('https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670?utm_source=list')).toMatchObject({
      outcome: 'match', reference: { provider: 'greenhouse', tenant: 'drweng', postingId: '3413670', sourceId: 'greenhouse-drweng', customHost: true },
    });
    expect(reviewedProviderUrlReference('https://drw.example.test/work-at-drw/listings/quantitative-research-intern-3413670')).toEqual({ outcome: 'none' });
  });

  it('recognizes only the immutable public ID on a reviewed Roblox custom host', () => {
    expect(reviewedProviderUrlReference('https://careers.roblox.com/jobs/7116940/software-engineering-intern?gh_jid=7116940')).toMatchObject({
      outcome: 'match', reference: { provider: 'greenhouse', tenant: 'roblox', postingId: '7116940', sourceId: 'greenhouse-roblox', customHost: true },
    });
    expect(reviewedProviderUrlReference('https://careers.roblox.com/jobs/software-engineering-intern')).toEqual({ outcome: 'none' });
    expect(reviewedProviderUrlReference('https://careers.roblox.com/jobs/7116940?gh_jid=7116999')).toMatchObject({ outcome: 'conflict' });
  });

  it('quarantines aliases that cross provider tenants or providers', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/123',
      reviewedProviderReferences: [
        { provider: 'greenhouse', tenant: 'figma', postingId: '123' },
        { provider: 'greenhouse', tenant: 'spacex', postingId: '123' },
      ],
    });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({ outcome: 'quarantine', reason: 'provider-scope-mismatch' });
  });

  it('quarantines conflicting authoritative requisition scopes', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://careers.acme.test/jobs/one',
      employerId: 'acme',
      employerRequisitionId: 'REQ-1',
      employerRequisitionAuthoritative: true,
    });
    identity.aliases.push({ kind: 'employer-requisition', value: 'requisition:acme:req-2' });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({
      outcome: 'quarantine',
      reason: 'multiple-authoritative-requisitions',
    });
  });
});
