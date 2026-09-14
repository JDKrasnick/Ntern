import { describe, expect, it } from 'vitest';
import { ashbyAdmissionViolations } from '../src/sources/ashby-admission.js';
import { ashbyExpansionFallbacks, reviewedAshbySources } from '../src/sources/ashby-config.js';
import { ashbyEvidenceViolations, reviewedAshbySourceFromEvidence, type AshbyOwnershipEvidence } from '../src/sources/ashby-evidence.js';
import { ashbyBoardNameFromUrl, buildAshbyCandidateLedger } from '../src/sources/ashby-ledger.js';
import { collectAshbyManifestViolations, nodeAshbyManifestFs, type AshbyManifestFs } from '../src/sources/ashby-manifest.js';
import { probeAshbyBoard, type AshbyProbeResult } from '../src/sources/ashby-probe.js';
import { recheckAshbyEvidence } from '../src/sources/ashby-reverify.js';
import type { ReviewedSourceRecord, SourcePromotionSnapshotEvidence } from '../src/sources/reviewed-source.js';

const evidence = (overrides: Partial<AshbyOwnershipEvidence> = {}): AshbyOwnershipEvidence => ({
  provider: 'ashby', boardKey: 'acme.io', apiRegion: 'global',
  careersUrl: 'https://acme.io/careers', firstPartyEvidenceUrl: 'https://www.acme.io/careers',
  exactBoardUrl: 'https://jobs.ashbyhq.com/acme.io',
  evidenceExcerpt: '<a href="https://jobs.ashbyhq.com/acme.io">Open roles</a>',
  observedJobUrl: 'https://jobs.ashbyhq.com/acme.io/11111111-1111-4111-8111-111111111111',
  verifiedAt: '2026-08-09T00:00:00Z', state: 'ownership-verified', initialTechnicalEarlyCareerRoles: 1,
  allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], ...overrides,
});

const source = (overrides: Partial<ReviewedSourceRecord> = {}): ReviewedSourceRecord => ({
  id: 'ashby-acme-io', company: 'Acme', identity: { provider: 'ashby', boardKey: 'acme.io', apiRegion: 'global' },
  careersUrl: 'https://acme.io/careers', admittedAt: '2026-08-09T00:00:00Z', evidenceState: 'ownership-verified',
  allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }], status: 'shadow', ...overrides,
});

const row = (id: string, title: string, overrides: Record<string, unknown> = {}) => ({
  id, title, location: 'Toronto', isListed: true, employmentType: 'Intern',
  jobUrl: `https://jobs.ashbyhq.com/acme.io/${id}`,
  applyUrl: `https://jobs.ashbyhq.com/acme.io/${id}/application`, ...overrides,
});

const response = (payload: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(payload), { status: 200, ...init });

async function okProbe(rows = [row('one', 'Software Engineer Intern')]): Promise<AshbyProbeResult> {
  return probeAshbyBoard('acme.io', (async () => response({ apiVersion: '1', jobs: rows })) as typeof fetch);
}

function fakeFs(files: Record<string, unknown>): AshbyManifestFs {
  return {
    listBoardDirs: (root) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${root}/`)).map((path) => path.slice(root.length + 1).split('/')[0]!))],
    fileExists: (path) => path in files,
    readJson: (path) => { if (!(path in files)) throw new Error('missing'); if (files[path] === 'INVALID') throw new SyntaxError('bad'); return files[path]; },
  };
}

describe('Ashby candidate ledger', () => {
  it('extracts exact, case-sensitive board identities from observed URLs', () => {
    expect(ashbyBoardNameFromUrl('https://jobs.ashbyhq.com/Deepgram/abc/application?x=1')).toBe('Deepgram');
    expect(ashbyBoardNameFromUrl('https://jobs.ashbyhq.com/partly.com/embed')).toBe('partly.com');
    expect(ashbyBoardNameFromUrl('https://jobs.ashbyhq.com/cohere')).toBe('cohere');
  });

  it('rejects ambiguous paths, insecure URLs, and malicious lookalike hosts', () => {
    for (const value of [
      'http://jobs.ashbyhq.com/acme', 'https://jobs.ashbyhq.com.evil.test/acme',
      'https://jobs.ashbyhq.com@evil.test/acme', 'https://api.ashbyhq.com/acme',
      'https://jobs.ashbyhq.com/acme/a/not-application', 'not a url',
    ]) expect(ashbyBoardNameFromUrl(value)).toBeUndefined();
  });

  it('records variants, sources, role counts, geography, timestamps, ambiguity, and deterministic ordering', () => {
    const result = buildAshbyCandidateLedger([
      { sourceId: 'b', company: 'Acme Inc', location: 'New York', applyUrl: 'https://jobs.ashbyhq.com/acme/a/application' },
      { sourceId: 'a', company: 'Acme', location: 'Toronto', applyUrl: 'https://jobs.ashbyhq.com/acme/b/application' },
      { sourceId: 'a', company: 'Beta', location: 'Paris', applyUrl: 'https://jobs.ashbyhq.com/beta/c/application' },
    ], { observedAt: '2026-08-09T01:02:03Z' });
    expect(result.map(({ boardName }) => boardName)).toEqual(['acme', 'beta']);
    expect(result[0]).toMatchObject({
      observedCompanyVariants: ['Acme', 'Acme Inc'], referencingSources: ['a', 'b'], roleCount: 2,
      geographicCoverage: ['New York', 'Toronto'], firstSeenAt: '2026-08-09T01:02:03Z',
      lastSeenAt: '2026-08-09T01:02:03Z', reviewState: 'ambiguous-owner',
    });
  });

  it('never guesses a board name and omits registered identities', () => {
    expect(buildAshbyCandidateLedger([
      { sourceId: 'a', company: 'Mistral AI', location: 'Paris', applyUrl: 'https://example.com/jobs' },
      { sourceId: 'a', company: 'Notion', location: 'SF', applyUrl: 'https://jobs.ashbyhq.com/notion/id/application' },
    ], { registeredBoards: ['notion'] })).toEqual([]);
  });

  it('suppresses registered board aliases case-insensitively', () => {
    expect(buildAshbyCandidateLedger([
      { sourceId: 'a', company: 'Etched', location: 'San Jose', applyUrl: 'https://jobs.ashbyhq.com/Etched/id/application' },
    ], { registeredBoards: ['etched'] })).toEqual([]);
  });
});

describe('Ashby read-only probe', () => {
  it('validates version/schema and qualifies only listed technical early-career roles', async () => {
    const result = await okProbe([
      row('one', 'Software Engineer Intern'), row('two', 'Finance Intern'),
      row('three', 'Secret Software Intern', { isListed: false, location: 'Secret place' }),
      row('four', 'Staff Software Engineer', { employmentType: 'FullTime' }),
    ]);
    expect(result).toMatchObject({ state: 'ok', apiVersion: '1', rawRows: 4, listedRows: 3, unlistedRows: 1, technicalEarlyCareerRoles: 1 });
    expect(JSON.stringify(result)).not.toContain('Secret Software Intern');
    expect(JSON.stringify(result)).not.toContain('Secret place');
  });

  it('classifies empty, malformed, version-drift, HTTP, and transport responses', async () => {
    expect(await okProbe([])).toMatchObject({ state: 'ok', technicalEarlyCareerRoles: 0 });
    expect((await probeAshbyBoard('acme.io', (async () => response({ apiVersion: '1', jobs: [{}] })) as typeof fetch))).toMatchObject({ state: 'ok', malformedRows: 1 });
    expect((await probeAshbyBoard('acme.io', (async () => response({ apiVersion: '2', jobs: [] })) as typeof fetch)).state).toBe('api-version-error');
    expect((await probeAshbyBoard('acme.io', (async () => response({ apiVersion: '1' })) as typeof fetch)).state).toBe('schema-error');
    expect((await probeAshbyBoard('acme.io', (async () => new Response('{', { status: 200 })) as typeof fetch)).state).toBe('json-error');
    expect((await probeAshbyBoard('acme.io', (async () => new Response('', { status: 404 })) as typeof fetch)).state).toBe('not-found');
    expect((await probeAshbyBoard('acme.io', (async () => { throw new Error('offline'); }) as typeof fetch)).state).toBe('transport-error');
  });

  it('rejects redirects and counts wrong-board paths', async () => {
    const redirected = response({ apiVersion: '1', jobs: [] });
    Object.defineProperties(redirected, { redirected: { value: true }, url: { value: 'https://api.ashbyhq.com/other' } });
    expect((await probeAshbyBoard('acme.io', (async () => redirected) as typeof fetch)).state).toBe('redirect-error');
    const result = await okProbe([row('one', 'Software Intern', { jobUrl: 'https://jobs.ashbyhq.com/other/one' })]);
    expect(result).toMatchObject({ state: 'ok', boardPathViolations: 1 });
  });

  it('records custom application hosts without automatically allowing them', async () => {
    const result = await okProbe([row('one', 'Software Intern', { applyUrl: 'https://careers.acme.io/apply/one' })]);
    expect(result).toMatchObject({ state: 'ok', boardPathViolations: 0, applicationHostSummary: { 'careers.acme.io': 1 } });
  });
});

describe('Ashby ownership and admission evidence', () => {
  it('requires first-party evidence containing the exact board link', () => {
    expect(ashbyEvidenceViolations(evidence())).toEqual([]);
    expect(ashbyEvidenceViolations(evidence({ evidenceExcerpt: '<a href="https://jobs.ashbyhq.com/acme.io-2">Jobs</a>' })))
      .toContain('evidenceExcerpt does not contain the exact Ashby board link');
  });

  it('blocks Ashby itself and aggregators from establishing ownership', () => {
    for (const url of ['https://jobs.ashbyhq.com/acme.io', 'https://linkedin.com/jobs/1', 'https://web.archive.org/example']) {
      expect(ashbyEvidenceViolations(evidence({ careersUrl: url, firstPartyEvidenceUrl: url }))).toContain('careersUrl is not an employer-controlled HTTPS URL');
    }
  });

  it('rejects unrelated hosts that share an unlisted multi-label public suffix', () => {
    expect(ashbyEvidenceViolations(evidence({
      careersUrl: 'https://real-company.co.kr/careers',
      firstPartyEvidenceUrl: 'https://attacker.co.kr/jobs',
    }))).toContain('firstPartyEvidenceUrl is not on the same employer domain as careersUrl');
  });

  it('requires explicit justification and review time for employer-controlled external application hosts', () => {
    expect(ashbyEvidenceViolations(evidence({ allowedApplicationHosts: [{ host: 'jobs.ashbyhq.com' }, { host: 'careers.acme.io' }] })))
      .toContain('external application host careers.acme.io lacks human-reviewed justification and timestamp');
    expect(ashbyEvidenceViolations(evidence({ allowedApplicationHosts: [
      { host: 'jobs.ashbyhq.com' }, { host: 'careers.acme.io', justification: 'Employer application form', reviewedAt: '2026-08-09T00:00:00Z' },
    ] }))).toEqual([]);
  });

  it('proposes shadow only and gates current technical roles and unreviewed hosts', async () => {
    const probe = await okProbe([]);
    const proposed = reviewedAshbySourceFromEvidence(evidence(), 'Acme');
    expect(proposed.status).toBe('shadow');
    expect(ashbyAdmissionViolations({ reviewerApprovedOwnership: true, reviewerApprovedAdmission: true, company: 'Acme', evidence: evidence(), probe, proposedSource: proposed }))
      .toContain('initial admission requires a current technical early-career role');
  });

  it('allows an owner-approved board expansion when the known early-career role is unlisted', async () => {
    const probe = await okProbe([]);
    const overridden = evidence({
      initialTechnicalEarlyCareerRoles: 0,
      initialRoleRequirementOverride: {
        approvedBy: 'JDKrasnick', approvedAt: '2026-08-18T01:18:19Z',
        reason: 'Known public internship is currently unlisted in the board API.',
      },
    });
    expect(ashbyAdmissionViolations({
      reviewerApprovedOwnership: true, reviewerApprovedAdmission: true, company: 'Acme',
      evidence: overridden, probe, proposedSource: source(),
    })).toEqual([]);
  });
});

describe('Ashby offline manifest and reverification', () => {
  it('passes the published cohort and ownership-verified shadow expansion', () => {
    expect(reviewedAshbySources.filter(({ status }) => status === 'published').map(({ company }) => company)).toEqual([
      'Etched', 'Deepgram', 'Cohere', 'Mistral AI', 'Partly',
      'Notion', 'Alan', 'Base Power', 'Reonic', 'Terranova', 'Melius', 'CTGT', 'OpusClip',
      'WindBorne Systems', 'Persona AI', 'Skydio', 'Beacon Software', 'Centerfield', 'RV Tech',
      'Circleback', 'Eragon', 'Modal', 'Yotta Labs', 'Anthelion Capital', 'Saronic', 'First Order Effects',
      'Junior', 'Airwallex', 'Netic', 'Retell AI', 'Quadrillion', 'Pylon', 'NationGraph',
    ]);
    expect(reviewedAshbySources.filter(({ status }) => status === 'shadow')).toHaveLength(63);
    expect(collectAshbyManifestViolations(reviewedAshbySources, { fs: nodeAshbyManifestFs(), now: new Date('2026-09-11T12:00:00Z') })).toEqual([]);
  });

  it('keeps any expansion replacements ordered and unadmitted', () => {
    expect(ashbyExpansionFallbacks).toEqual([]);
  });

  it('rejects duplicate identities, expired evidence, and pending admissions', async () => {
    const probe = await okProbe();
    const artifact = { probedAt: '2026-08-09T00:00:00Z', retention: 'metadata-only', results: [probe] };
    const files = { 'fixtures/acme.io/evidence.json': evidence(), 'fixtures/acme.io/probe.json': artifact, 'fixtures/pending/evidence.json': evidence({ boardKey: 'pending', exactBoardUrl: 'https://jobs.ashbyhq.com/pending', observedJobUrl: 'https://jobs.ashbyhq.com/pending/id' }) };
    const violations = collectAshbyManifestViolations([source(), source({ id: 'ashby-other' })], { fs: fakeFs(files), root: 'fixtures', now: new Date('2027-03-01T00:00:00Z') });
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('duplicate board identity'), expect.stringContaining('overdue for re-verification'),
      'pending: reviewed evidence is pending explicit registry admission',
    ]));
  });

  it('gates empty-board acknowledgements on an owner, a reason, and a fresh timestamp', async () => {
    const probe = await okProbe();
    const files = {
      'fixtures/acme.io/evidence.json': evidence(),
      'fixtures/acme.io/probe.json': { probedAt: '2026-08-09T00:00:00Z', retention: 'metadata-only', results: [probe] },
    };
    const options = { fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-10T12:00:00Z') };
    const acknowledged = source({ emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-08-09T00:00:00Z', reason: 'seasonally empty' } });
    expect(collectAshbyManifestViolations([acknowledged], options)).toEqual([]);
    const malformed = source({ emptyBoardAcknowledged: { acknowledgedBy: ' ', acknowledgedAt: 'not-a-timestamp', reason: '' } });
    expect(collectAshbyManifestViolations([malformed], options)).toEqual([
      'ashby-acme-io: empty-board acknowledgement lacks an owner',
      'ashby-acme-io: empty-board acknowledgement lacks a reason',
      'ashby-acme-io: empty-board acknowledgement timestamp is invalid',
    ]);
    const future = source({ emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-08-10T12:06:00Z', reason: 'seasonally empty' } });
    expect(collectAshbyManifestViolations([future], options)).toEqual(['ashby-acme-io: empty-board acknowledgement timestamp is in the future']);
    const stale = source({ emptyBoardAcknowledged: { acknowledgedBy: 'JDKrasnick', acknowledgedAt: '2026-02-01T00:00:00Z', reason: 'seasonally empty' } });
    expect(collectAshbyManifestViolations([stale], options)).toEqual(['ashby-acme-io: empty-board acknowledgement is overdue for re-verification (limit 180 days)']);
  });

  it('rejects stale admission probes and future-dated evidence', async () => {
    const probe = await okProbe();
    const staleFiles = {
      'fixtures/acme.io/evidence.json': evidence(),
      'fixtures/acme.io/probe.json': { probedAt: '2026-07-01T00:00:00Z', retention: 'metadata-only', results: [probe] },
    };
    expect(collectAshbyManifestViolations([source()], {
      fs: fakeFs(staleFiles), root: 'fixtures', now: new Date('2026-08-09T14:00:00Z'),
    })).toContain('ashby-acme-io: probe and admission timestamps differ by more than 7 days');

    const futureSource = source({ admittedAt: '2026-08-10T00:00:00Z' });
    const futureFiles = {
      'fixtures/acme.io/evidence.json': evidence({ verifiedAt: '2026-08-10T00:00:00Z' }),
      'fixtures/acme.io/probe.json': { probedAt: '2026-08-10T00:00:00Z', retention: 'metadata-only', results: [probe] },
    };
    expect(collectAshbyManifestViolations([futureSource], {
      fs: fakeFs(futureFiles), root: 'fixtures', now: new Date('2026-08-09T14:00:00Z'),
    })).toEqual(expect.arrayContaining([
      'ashby-acme-io: admittedAt is in the future',
      'ashby-acme-io: probe artifact probedAt is in the future',
    ]));
  });

  it('blocks publication without three approved clean snapshots spanning 24 hours', async () => {
    const probe = await okProbe();
    const files = {
      'fixtures/acme.io/evidence.json': evidence(),
      'fixtures/acme.io/probe.json': { probedAt: '2026-08-09T00:00:00Z', retention: 'metadata-only', results: [probe] },
    };
    const withoutEvidence = collectAshbyManifestViolations([source({ status: 'published' })], {
      fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-10T12:00:00Z'),
    });
    expect(withoutEvidence).toContain('ashby-acme-io: published source lacks promotionEvidence');

    const snapshot = (runId: string, completedAt: string): SourcePromotionSnapshotEvidence => ({
      runId, completedAt, outcome: 'success_unchanged_hash', rawRows: 1, eligibleRows: 1, withheldRows: 0,
      applicationLinksChecked: 1, applicationLinkFailures: 0, complete: true, identityVerified: true, schemaValid: true,
    });
    const promoted = source({
      status: 'published',
      promotionEvidence: {
        approvedAt: '2026-08-10T12:00:00Z', approvedBy: 'JDKrasnick', quietBaselineApproved: true,
        stableIdentity: true, stableApplicationHosts: true,
        snapshots: [
          snapshot('run-1', '2026-08-09T00:00:00Z'),
          snapshot('run-2', '2026-08-09T12:00:00Z'),
          snapshot('run-3', '2026-08-10T00:00:00Z'),
        ],
      },
    });
    expect(collectAshbyManifestViolations([promoted], {
      fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-10T12:00:00Z'),
    })).toEqual([]);

    const inconsistentCounts = source({
      status: 'published',
      promotionEvidence: {
        ...promoted.promotionEvidence!,
        snapshots: promoted.promotionEvidence!.snapshots.map((item, index) => index === 0
          ? { ...item, eligibleRows: 0, applicationLinksChecked: 0, applicationLinkFailures: 1 }
          : item),
      },
    });
    expect(collectAshbyManifestViolations([inconsistentCounts], {
      fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-10T12:00:00Z'),
    })).toContain('ashby-acme-io: run-1: application-link failures exceed checked links');

    const futureEvidence = source({
      status: 'published',
      promotionEvidence: {
        ...promoted.promotionEvidence!, approvedAt: '2026-08-12T01:00:00Z',
        snapshots: [
          snapshot('future-1', '2026-08-11T00:00:00Z'),
          snapshot('future-2', '2026-08-11T12:00:00Z'),
          snapshot('future-3', '2026-08-12T00:00:00Z'),
        ],
      },
    });
    expect(collectAshbyManifestViolations([futureEvidence], {
      fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-10T12:00:00Z'),
    })).toEqual(expect.arrayContaining([
      'ashby-acme-io: promotion evidence approvedAt is in the future',
      'ashby-acme-io: promotion snapshot timestamp is in the future',
    ]));

    const prematureApproval = source({
      status: 'published',
      promotionEvidence: { ...promoted.promotionEvidence!, approvedAt: '2026-08-09T23:59:59Z' },
    });
    expect(collectAshbyManifestViolations([prematureApproval], {
      fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-10T12:00:00Z'),
    })).toContain('ashby-acme-io: promotion approval must follow the latest snapshot');

    const ownerOverride = source({
      status: 'published',
      promotionEvidence: {
        approvedAt: '2026-08-09T01:00:00Z', approvedBy: 'JDKrasnick', quietBaselineApproved: true,
        stableIdentity: true, stableApplicationHosts: true,
        snapshots: [snapshot('override-run', '2026-08-09T00:30:00Z')],
        observationWindowOverride: {
          reason: 'Owner directed immediate publication after reviewing the boards.',
          followUpAfter: '2026-08-10T01:00:00Z',
        },
      },
    });
    expect(collectAshbyManifestViolations([ownerOverride], {
      fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-09T02:00:00Z'),
    })).toEqual([]);

    expect(collectAshbyManifestViolations([ownerOverride], {
      fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-10T01:00:00Z'),
    })).toEqual(expect.arrayContaining([
      'ashby-acme-io: observation-window override follow-up is overdue',
      'ashby-acme-io: promotion requires at least 3 clean snapshots',
    ]));

    const invalidOverride = source({
      ...ownerOverride,
      promotionEvidence: {
        ...ownerOverride.promotionEvidence!,
        observationWindowOverride: { reason: '', followUpAfter: '2026-08-09T00:59:00Z' },
      },
    });
    expect(collectAshbyManifestViolations([invalidOverride], {
      fs: fakeFs(files), root: 'fixtures', now: new Date('2026-08-09T02:00:00Z'),
    })).toEqual(expect.arrayContaining([
      'ashby-acme-io: observation-window override lacks a reason',
      'ashby-acme-io: observation-window override follow-up must be after approval',
    ]));
  });

  it('rechecks the employer page without writing state', async () => {
    const fetchImpl = (async () => new Response('<a href="https://jobs.ashbyhq.com/acme.io">Jobs</a>', { status: 200 })) as typeof fetch;
    expect(await recheckAshbyEvidence(evidence(), fetchImpl)).toMatchObject({ state: 'ok', stillProven: true });
    const missing = (async () => new Response('<p>No board here</p>', { status: 200 })) as typeof fetch;
    expect(await recheckAshbyEvidence(evidence(), missing)).toMatchObject({ state: 'ok', stillProven: false });
  });

  it('accepts an employer careers redirect only when it lands on the exact reviewed board', async () => {
    const exact = (async () => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'url', { value: 'https://jobs.ashbyhq.com/acme.io' });
      return response;
    }) as typeof fetch;
    expect(await recheckAshbyEvidence(evidence(), exact)).toMatchObject({ state: 'ok', stillProven: true });

    const wrong = (async () => {
      const response = new Response('', { status: 200 });
      Object.defineProperty(response, 'url', { value: 'https://jobs.ashbyhq.com/other' });
      return response;
    }) as typeof fetch;
    expect((await recheckAshbyEvidence(evidence(), wrong)).state).toBe('redirect-error');
  });

  it('follows bounded same-origin script references but ignores third-party scripts', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://www.acme.io/careers') return new Response(
        '<script src="/assets/jobs.js"></script><script src="https://cdn.example.test/untrusted.js"></script>',
        { status: 200 },
      );
      if (url === 'https://www.acme.io/assets/jobs.js') return new Response('import("./chunk.js")', { status: 200 });
      if (url === 'https://www.acme.io/assets/chunk.js') return new Response(
        'const board = "https://jobs.ashbyhq.com/acme.io";', { status: 200 },
      );
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;
    expect(await recheckAshbyEvidence(evidence(), fetchImpl)).toMatchObject({ state: 'ok', stillProven: true });
  });
});
