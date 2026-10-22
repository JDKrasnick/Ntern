import { describe, expect, it, vi } from 'vitest';
import { assessOfficialEarlyCareer, earlyCareerFromEvidence, explicitProgramType, selectEarlyCareerAssessment, withEarlyCareerAdmission } from '../src/early-career-eligibility.js';
import { deriveCanonicalAdmission, evaluateCatalogAdmission } from '../src/catalog-admission.js';
import { classifyDestination } from '../src/destination-verification.js';
import { extractPostingMetadataEvidence, projectRoleMetadata } from '../src/role-metadata.js';
import { processPosting } from '../src/ingestion/processor.js';
import { gradeAdmissionRow, RuleBasedAdmissionV2Evaluator } from '../src/ingestion-v2/admission/evaluator.js';
import { ingestionV2AdmissionVersion } from '../src/ingestion-v2/admission/version.js';
import { effectiveAdmissionConfigurationVersion } from '../src/sources/trust-policy.js';
import type { AdmissionRowContext } from '../src/ingestion-v2/admission/types.js';
import type { EarlyCareerAssessment, Internship, ProcessedListing, SourceOccurrence, SourcedPosting } from '../src/types.js';

const now = '2026-10-21T12:00:00Z';
const url = 'https://job-boards.greenhouse.io/acme/jobs/1234567';
function evidence(title: string, text = '', observedAt = now) {
  return extractPostingMetadataEvidence({ artifact: { title, text }, sourceClass: 'official-api', sourceId: 'greenhouse-acme', sourceUrl: url, observedAt, exactPosting: true });
}
function listing(overrides: Partial<ProcessedListing> = {}): ProcessedListing {
  return { sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: '1234567', document: '1234567', sourceUrl: url,
    row: 1, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027', applyUrl: url,
    compensation: { raw: '' }, state: 'open', fetchedAt: now, technical: true,
    employerEvidence: { authority: 'reviewed-registry', canonicalEmployer: { id: 'acme', displayName: 'Acme' } },
    providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-acme', tenant: 'acme', postingId: '1234567', sourceUrl: url },
    metadataCompleteness: { complete: true, title: 'complete', location: 'complete' }, ...overrides };
}
function admission(role = listing(), enabled = true) {
  return evaluateCatalogAdmission({ listing: role, destination: classifyDestination({ listing: role, reachability: 'blocked', inspectedAt: now }),
    postingAttributed: true, evaluatedAt: now, earlyCareerEligibilityEnabled: enabled });
}
function job(refs: SourceOccurrence[], current = admission(listing({ metadataEvidence: evidence('Software Engineering Intern') }))) : Internship {
  return { jobId: 'job', company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027', applyUrl: url,
    normalizedUrl: url, fingerprint: 'fingerprint', compensation: { raw: '' }, sourceReferences: refs, open: true,
    firstSeenAt: now, lastSeenAt: now, admission: current, notification: { smsPending: true, digestPending: true } };
}
function posting(title: string, text: string): SourcedPosting {
  return { sourceId: 'greenhouse-acme', externalId: '1234567', sourceUrl: url, fetchedAt: now, provenance: 'official-ats',
    employer: { id: 'acme', name: 'Acme', authority: 'reviewed-registry' }, title,
    content: [{ kind: 'description', format: 'plain', value: text }], locations: ['Remote'], applyUrl: url, sourceState: 'open' };
}
function admissionContext(role: SourcedPosting): AdmissionRowContext {
  return { sourceId: role.sourceId, externalId: role.externalId, posting: role, snapshotHash: 'snapshot', admissionVersion: 'coverage-v2',
    baseline: false, firstObservationEligible: true, row: { sourceId: role.sourceId, externalId: role.externalId, snapshotHash: 'snapshot',
      materialHash: 'material', admissionVersion: 'coverage-v2', state: 'queued', attemptCount: 0, consecutiveOmissions: 0,
      notificationBaseline: false, firstObservedAt: now, lastObservedAt: now, updatedAt: now } };
}

describe('employer-authoritative early-career policy', () => {
  it.each([
    ['Backend Software Engineer, Cooperative AI (Evals)', '4+ years of backend engineering experience at product-driven companies (excluding internships).', 'unknown'],
    ['Software Engineer Intern', 'Employment is full time.', 'eligible'],
    ['PhD Research Intern', '3 years of research experience in a PhD program.', 'eligible'],
    ['Graduate Software Engineer', 'A permanent full-time position.', 'eligible'],
    ['Software Engineering Co-op', '', 'eligible'],
    ['Working Student Software Engineering', '', 'eligible'],
    ['Software Engineering Apprentice', '', 'eligible'],
    ['Early Career Talent Partner - Trading', 'Recruit and hire students.', 'ineligible'],
    ['Senior Software Engineer', 'You will mentor interns.', 'ineligible'],
    ['Software Engineer', 'Prior internship experience is desirable.', 'unknown'],
    ['Software Engineer', 'Experience as an intern is desirable.', 'unknown'],
    ['Software Engineer', 'No prior experience required with Kubernetes.', 'unknown'],
    ['Software Engineer Intern', 'This role is not an internship.', 'unknown'],
    ['Software Engineer', 'Our company has 20 years of engineering experience.', 'unknown'],
    ['Software Engineer', '3+ years of software engineering experience required.', 'unknown'],
    ['Software Engineer', 'About our company.\nBring 5+ years of engineering or technical deployment experience that includes customer-facing work.', 'unknown'],
    ['Marketing Scientist', 'Have deep expertise (10+ years) in advertising measurement.', 'unknown'],
    ['Hardware Engineer', '8+ years in hardware quality/reliability, server systems.', 'unknown'],
    ['Software Engineer', '0–3 years of professional software development experience.', 'unknown'],
    ['Software Engineer', '3+ years of professional experience preferred.', 'unknown'],
    ['Physical Engineering Business Lead', 'Firsthand experience designing or building physical products.', 'unknown'],
    ['Software Engineer', 'No aerospace experience required.', 'unknown'],
    ['Software Engineer', 'No prior experience required.', 'eligible'],
    ['Software Engineer', '0–2 years of professional experience.', 'eligible'],
    ['Software Engineer', 'Recent graduates are welcome.', 'eligible'],
    ['Cohort 0', 'At least one semester of schooling remaining after the internship.', 'eligible'],
    ['Software Engineer Intern', '4+ years of professional engineering experience excluding internships.', 'unknown'],
  ])('%s: %s -> %s', (title, text, status) => {
    expect(assessOfficialEarlyCareer({ title, text }).status).toBe(status);
  });
  it.each([
    ['Software Engineer', 'You will mentor interns and review their work.', 'unknown', undefined],
    ['Software Engineer', 'Our company offers an internship programme every summer.', 'unknown', undefined],
    ['Software Engineer', 'Experience working as an intern is preferred.', 'unknown', undefined],
    ['Internship Program Manager', 'Manage the university recruiting programme.', 'ineligible', undefined],
    ['Software Engineer', 'This position is a paid internship.', 'eligible', 'internship'],
    ['Engineer', 'This role is a co-op.', 'eligible', 'co-op'],
    ['Software Developer', 'This is a paid apprenticeship.', 'eligible', 'apprenticeship'],
    ['Network Security Engineer', 'This position is open to experienced candidates, as well as fresh graduates who will be graduating in December 2026.\nYou have a minimum of 4 years experience supporting networking products.', 'eligible', 'entry-level'],
    ['Applied AI Engineer, Cyber', 'Have 5+ years of technical consulting, solutions engineering, security architecture, cyber advisory, deployment engineering, professional services, or equivalent customer-facing technical experience.', 'unknown', undefined],
    ['Mechanical Engineer', 'This is a senior individual-contributor role leading PCBA test fixtures.', 'unknown', undefined],
    ['Anthropic Fellows Program, AI Safety & Security', 'Four months of funded research and mentorship regardless of previous experience.', 'unknown', undefined],
  ])('requires role-directed evidence for %s: %s', (title, text, status, programType) => {
    expect(assessOfficialEarlyCareer({ title, text })).toMatchObject({ status });
    expect(assessOfficialEarlyCareer({ title, text }).programType).toBe(programType);
  });
  it.each([
    ['Prácticas en BI - Data Analytics', '', 'internship'],
    ['Pflichtpraktikum - Embedded Linux Entwicklung', '', 'internship'],
    ['Stage Full Stack – IA Générative', 'Étudiant·e en dernière année en informatique.', 'internship'],
    ["AI Analytics - Stage de fin d'études", '', 'internship'],
    ['Stage Consultant Data Science', 'Sia ricerca uno stagista come Data Scientist.', 'internship'],
    ['Software Engineer - Student Placement', '', 'co-op'],
    ['Data Science Industrial Placement', '', 'co-op'],
    ['Summer Placement Software Engineer', '', 'internship'],
    ['Part-Time Student - Software Engineering', '', 'co-op'],
    ['Contract Student Worker – Software Engineer', 'This is not an internship. Ongoing work alongside your studies.', 'co-op'],
    ['MTS Intern', 'This is not an internship built around shadowing. Own real software projects.', 'internship'],
    ['Research Assistant', 'The lab is seeking Undergraduate Research Assistants/Interns for machine learning projects.', 'internship'],
  ])('preserves explicit student programmes: %s', (title, text, type) => {
    expect(assessOfficialEarlyCareer({ title, text })).toMatchObject({ status: 'eligible', programType: type });
  });
  it.each([
    ['Software Engineer', 'We are hiring engineers to mentor interns.'],
    ['Student Placement Coordinator', 'Manage the student placement programme.'],
    ['Stage Systems Engineer', 'Manage deployment stages for production systems.'],
    ['Software Engineer - Mejores Prácticas', 'Improve software engineering best practices.'],
  ])('does not confuse programme administration or generic stages with a placement: %s', (title,text) => {
    expect(assessOfficialEarlyCareer({ title,text }).status).not.toBe('eligible');
  });
  it('never defaults generic titles or Cooperative AI to an internship', () => {
    expect(explicitProgramType('Backend Software Engineer, Cooperative AI')).toBe('unknown');
    expect(explicitProgramType('Software Engineer')).toBe('unknown');
    expect(assessOfficialEarlyCareer({ title: 'Software Engineer', employmentType: 'FullTime' }).status).toBe('unknown');
    expect(assessOfficialEarlyCareer({ title: 'Software Engineer', employmentType: 'Intern' }).status).toBe('eligible');
  });
  it('requires exact official evidence, even when community labels say Intern', () => {
    const community = evidence('Software Engineering Intern').map(e => ({ ...e, sourceClass: 'reviewed-community' as const }));
    expect(earlyCareerFromEvidence(community).status).toBe('unknown');
    const inexact = evidence('Software Engineering Intern');
    for (const item of inexact) Reflect.set(item, 'exactPosting', false);
    expect(earlyCareerFromEvidence(inexact).status).toBe('unknown');
    expect(admission(listing({ metadataEvidence: community }))).toMatchObject({ catalogEligible: false, alertEligible: false });
  });
  it('leaves the rollout disabled by default', () => {
    expect(admission(listing(), false)).toMatchObject({ catalogEligible: true, alertEligible: true });
    expect(admission(listing(), false).earlyCareer).toBeUndefined();
  });
  it('keeps reviewed enrollment enforced on later refreshes while the global rollout is off', () => {
    const role = listing({ metadataEvidence: evidence('Backend Software Engineer', '4+ years of professional experience excluding internships.') });
    const previous = admission(role);
    expect(evaluateCatalogAdmission({ listing: role, previous, earlyCareerEligibilityEnabled: false,
      postingAttributed: true, evaluatedAt: now, destination: classifyDestination({ listing: role, reachability: 'blocked', inspectedAt: now }) }))
      .toMatchObject({ catalogEligible: false, earlyCareer: { reason: 'no-explicit-programme' } });
  });
  it('holds an unreviewed legacy withdrawal without opening new or otherwise blocked roles', () => {
    const role = listing({ metadataEvidence: evidence('Backend Software Engineer') });
    const previous = admission(role, false);
    const input = { listing: role, previous, earlyCareerEligibilityEnabled: true, postingAttributed: true,
      evaluatedAt: now, destination: classifyDestination({ listing: role, reachability: 'blocked' as const, inspectedAt: now }) };
    expect(evaluateCatalogAdmission(input)).toMatchObject({ catalogEligible: true, alertEligible: false,
      earlyCareerReviewPending: { reason: 'no-explicit-programme' } });
    expect(evaluateCatalogAdmission({ ...input, previous: undefined }).catalogEligible).toBe(false);
    expect(evaluateCatalogAdmission({ ...input, previous: { ...previous, catalogEligible: false } }).catalogEligible).toBe(false);
    expect(evaluateCatalogAdmission({ ...input, destination: { ...input.destination, classification: 'gone' } }).catalogEligible).toBe(false);
  });
  it('withholds verified general roles without inventing a programme or minting alerts', () => {
    const role = listing({ title: 'Software Engineer', metadataEvidence: evidence('Software Engineer', 'Build services using Python and personal projects.') });
    const decision = admission(role);
    expect(decision).toMatchObject({ catalogEligible: false, alertEligible: false, earlyCareer: { status: 'unknown', reason: 'no-explicit-programme' } });
    const refreshed = projectRoleMetadata(job([{ ...role, admission: decision }], decision)).job;
    expect(refreshed).toMatchObject({ title: 'Software Engineer', programType: 'unknown', admission: { catalogEligible: false, alertEligible: false },
      notification: { smsPending: false, digestPending: false } });
  });
  it('does not confuse a verified open-level role with missing or contradictory employer evidence', () => {
    expect(admission(listing())).toMatchObject({ catalogEligible: false, alertEligible: false });
    const contradiction = listing({ metadataEvidence: evidence('Software Engineer Intern', '4+ years of professional experience excluding internships.') });
    expect(admission(contradiction)).toMatchObject({ catalogEligible: false, alertEligible: false });
    const unavailable = listing({ metadataEvidence: evidence('Software Engineer') });
    const destination = classifyDestination({ listing: unavailable, reachability: 'gone', inspectedAt: now });
    expect(evaluateCatalogAdmission({ listing: unavailable, destination, postingAttributed: true, evaluatedAt: now, earlyCareerEligibilityEnabled: true }).catalogEligible).toBe(false);
  });
  it('requires role-directed programme evidence before admitting generic official candidates', () => {
    const role = posting('Software Engineer', 'Build distributed software systems.');
    expect(processPosting(role, [], true).decision.reason).toBe('not-early-career');
    expect(processPosting({ ...role, content: [{ kind: 'description', format: 'plain', value: 'This position is an internship building software.' }] }, [], true).decision.outcome).toBe('included');
    expect(processPosting({ ...role, title: 'Senior Software Engineer' }, [], true).decision.reason).toBe('not-early-career');
    expect(processPosting({ ...role, title: 'Office Coordinator' }, [], true).decision.reason).toBe('not-early-career');
  });
  it('keeps other admission failures blocked even with positive employer evidence', () => {
    const base = admission(listing({ employerEvidence: undefined }), false);
    const result = withEarlyCareerAdmission(base, earlyCareerFromEvidence(evidence('Software Engineering Intern')));
    expect(result.catalogEligible).toBe(false);
    expect(result.reasonCodes).toContain('employer-unresolved');
  });
  it('cannot restore publication after a later canonical identity or metadata conflict', () => {
    const positive = earlyCareerFromEvidence(evidence('Software Engineering Intern'));
    const enrolled = admission(listing({ metadataEvidence: evidence('Software Engineering Intern') }));
    for (const conflict of ['employer-conflict', 'metadata-conflict'] as const) {
      const blocked = { ...enrolled, catalogEligible: false, alertEligible: false, reasonCodes: [conflict] };
      expect(withEarlyCareerAdmission(blocked, positive)).toMatchObject({ catalogEligible: false, alertEligible: false });
    }
  });
  it('withdraws publication and pending alerts on refresh while retaining lifecycle and history', () => {
    const bad = listing({ metadataEvidence: evidence('Backend Software Engineer', '4+ years of backend engineering experience excluding internships.') });
    const original = job([{ ...bad, admission: admission(bad) }]);
    const refreshed = projectRoleMetadata(original).job;
    expect(refreshed).toMatchObject({ jobId: 'job', open: true, firstSeenAt: now, title: 'Backend Software Engineer', programType: 'unknown', season: 'ongoing',
      admission: { catalogEligible: false, alertEligible: false }, notification: { smsPending: false, digestPending: false } });
    expect(deriveCanonicalAdmission(refreshed.sourceReferences, now)?.catalogEligible).toBe(false);
  });
  it('does not let stale community admission reopen an officially rejected role', () => {
    const bad = listing({ metadataEvidence: evidence('Backend Software Engineer', '4+ years of backend engineering experience excluding internships.') });
    const community = listing({ sourceId: 'community', provenance: 'reviewed-community' });
    const refs = [{ ...bad, admission: admission(bad) }, { ...community, admission: admission(community, false) }];
    expect(deriveCanonicalAdmission(refs, now)).toMatchObject({ catalogEligible: false, earlyCareer: { status: 'unknown' } });
    expect(deriveCanonicalAdmission([...refs].reverse(), now)?.catalogEligible).toBe(false);
  });
  it('can recover publication from newer positive employer evidence', () => {
    const bad = listing({ metadataEvidence: evidence('Senior Software Engineer') });
    const old = job([{ ...bad, admission: admission(bad) }], admission(bad));
    const positive = evidence('Software Engineering Intern', '', '2026-10-22T12:00:00Z');
    const refreshed = projectRoleMetadata({ ...old, sourceReferences: [{ ...bad, metadataEvidence: positive }] }).job;
    expect(refreshed.admission?.catalogEligible).toBe(true);
    expect(refreshed.programType).toBe('internship');
  });
  it('ignores evidence from a closed different posting when an open occurrence exists', () => {
    const other = url.replace('1234567', '7654321');
    const closed = listing({ state: 'closed', applyUrl: other, providerIdentity: { ...listing().providerIdentity!, postingId: '7654321' }, metadataEvidence: evidence('Senior Software Engineer', '', '2026-10-22T12:00:00Z').map(e => ({ ...e, sourceUrl: other })) });
    const open = listing({ metadataEvidence: evidence('Software Engineering Intern') });
    const refreshed = projectRoleMetadata(job([{ ...closed, admission: admission(closed) }, { ...open, admission: admission(open) }])).job;
    expect(refreshed.admission?.catalogEligible).toBe(true);
  });
  it('retains employer proof after one community occurrence closes while the same posting stays open', () => {
    const closed = listing({ state: 'closed', metadataEvidence: evidence('Software Engineering Intern') });
    const open = listing({ sourceId: 'another-community', provenance: 'reviewed-community' });
    const refreshed = projectRoleMetadata(job([{ ...closed, admission: admission(closed) }, { ...open, admission: admission(open, false) }])).job;
    expect(refreshed.admission).toMatchObject({ catalogEligible: true, earlyCareer: { status: 'eligible' } });
    expect(refreshed.open).toBe(true);
  });
  it('does not transfer proof to a different posting or an unrecognized URL', () => {
    const closed = listing({ state: 'closed', metadataEvidence: evidence('Software Engineering Intern') });
    for (const applyUrl of [url.replace('1234567', '7654321'), url.replace('/acme/', '/other/'), 'https://example.test/unknown']) {
      const open = listing({ sourceId: 'another-community', provenance: 'reviewed-community', applyUrl });
      const refreshed = projectRoleMetadata(job([{ ...closed, admission: admission(closed) }, { ...open, admission: admission(open, false) }])).job;
      expect(refreshed.admission?.catalogEligible).toBe(false);
    }
  });
  it('does not confuse identical artifact hashes from distinct posting occurrences', () => {
    const proof = evidence('Software Engineering Intern');
    const closed = listing({ state: 'closed', metadataEvidence: proof });
    const open = listing({ sourceId: 'another-community', applyUrl: url.replace('1234567', '7654321'),
      metadataEvidence: proof.map(e => ({ ...e, sourceId: 'another-community', sourceUrl: url.replace('1234567', '7654321'), earlyCareer: undefined })) });
    const refreshed = projectRoleMetadata(job([{ ...closed, admission: admission(closed) }, { ...open, admission: admission(open, false) }])).job;
    expect(refreshed.admission?.catalogEligible).toBe(false);
  });
  it('honors newer employer rejection on the same posting even when its community occurrence closed', () => {
    const closed = listing({ state: 'closed', metadataEvidence: evidence('Senior Software Engineer', '', '2026-10-22T12:00:00Z') });
    const open = listing({ sourceId: 'another-community', metadataEvidence: evidence('Software Engineering Intern') });
    const refreshed = projectRoleMetadata(job([{ ...closed, admission: admission(closed) }, { ...open, admission: admission(open) }])).job;
    expect(refreshed.admission?.catalogEligible).toBe(false);
  });
  it('retains legitimate closed-role classification and preserves lifecycle and alert suppression', () => {
    const closed = listing({ state: 'closed', metadataEvidence: evidence('Software Engineering Intern') });
    const refreshed = projectRoleMetadata({ ...job([{ ...closed, admission: admission(closed) }]), open: false, notification: { smsPending: false, digestPending: false } }).job;
    expect(refreshed).toMatchObject({ open: false, admission: { catalogEligible: true, earlyCareer: { status: 'eligible' } }, notification: { smsPending: false, digestPending: false } });
  });
  it('preserves programme proof when the last occurrence closes before canonical lifecycle reconciliation', () => {
    const closed = listing({ state: 'closed', metadataEvidence: evidence('Software Engineering Intern') });
    const original = { ...job([{ ...closed, admission: admission(closed) }]), notification: { smsPending: false, digestPending: false } };
    const refreshed = projectRoleMetadata(original).job;
    expect(refreshed).toMatchObject({ open: true, programType: 'internship',
      admission: { catalogEligible: true, earlyCareer: { status: 'eligible' } },
      notification: { smsPending: false, digestPending: false } });
    expect(refreshed.sourceReferences[0]?.state).toBe('closed');
  });
  it('carries reviewed base admission across aliases of the same exact posting without bypassing new conflicts', () => {
    const closed = listing({ state: 'closed', metadataEvidence: evidence('Software Engineering Intern') });
    const vetted = { ...admission(closed), employerResolution: 'source-reported' as const, evidenceCodes: ['trusted-community-source' as const] };
    const open = listing({ sourceId: 'another-community', provenance: 'reviewed-community' });
    const weak = withEarlyCareerAdmission({ ...admission(open, false), employerResolution: 'unresolved', catalogEligible: false, alertEligible: false,
      reasonCodes: ['employer-unresolved'], evidenceCodes: [] }, earlyCareerFromEvidence([]));
    const refs = [{ ...closed, admission: vetted }, { ...open, admission: weak }];
    const refreshed = projectRoleMetadata(job(refs, weak)).job;
    expect(refreshed.admission).toMatchObject({ catalogEligible: true, alertEligible: false });
    expect(deriveCanonicalAdmission(refreshed.sourceReferences, now)?.catalogEligible).toBe(true);
    const historical = projectRoleMetadata({ ...job(refs.map(r => ({ ...r, state: 'closed' as const })), weak), open: false }).job;
    expect(historical).toMatchObject({ open: false, admission: { catalogEligible: true, alertEligible: false } });
    const blocked = projectRoleMetadata(job(refs, { ...weak, reasonCodes: [...weak.reasonCodes, 'metadata-conflict'] })).job;
    expect(blocked.admission?.catalogEligible).toBe(false);
  });
  it('uses current official evidence and holds conflicting same-time claims', () => {
    const positive = earlyCareerFromEvidence(evidence('Software Engineering Intern'));
    const negative: EarlyCareerAssessment = { ...earlyCareerFromEvidence(evidence('Senior Software Engineer')), sourceClass: 'official-page', observedAt: '2026-10-22T12:00:00Z' };
    expect(selectEarlyCareerAssessment([positive, negative]).status).toBe('ineligible');
    expect(selectEarlyCareerAssessment([positive, { ...negative, observedAt: now }]).status).toBe('unknown');
    expect(selectEarlyCareerAssessment([positive, { ...negative, observedAt: '2026-10-21T12:00:00.000Z' }]).status).toBe('unknown');
    const shell = { ...earlyCareerFromEvidence(evidence('Apply at Acme')), sourceClass: 'official-page' as const };
    expect(selectEarlyCareerAssessment([positive, shell]).status).toBe('eligible');
    expect(selectEarlyCareerAssessment([{ ...positive, observedAt: undefined }]).status).toBe('eligible');
    expect(selectEarlyCareerAssessment([{ ...positive, artifactHash: undefined }]).status).toBe('unknown');
  });
  it('admits body-supported official programmes through source processing when enabled', () => {
    const role = posting('Software Engineer - Cohort 0', 'Software engineering internship. At least one semester of schooling remaining after the internship.');
    expect(processPosting(role).decision.reason).toBe('not-early-career');
    expect(processPosting(role, [], true).decision.outcome).toBe('included');
    expect(processPosting({ ...role, provenance: 'reviewed-community' }, [], true).decision.reason).toBe('not-early-career');
  });
  it('gates the actual v2 admission path, including later employer contradictions', () => {
    const role = posting('Software Engineering Intern', 'An internship for software engineering students.');
    const input = { sourceId: role.sourceId, externalId: role.externalId, posting: role, evaluatedAt: now, earlyCareerEligibilityEnabled: true,
      probe: { reachability: 'blocked' as const } };
    expect(gradeAdmissionRow(input)).toMatchObject({ admission: { catalogEligible: true } });
    const experienced = { ...role, title: 'Backend Software Engineer Intern', content: [{ kind: 'description' as const, format: 'plain' as const,
      value: '4+ years of professional backend engineering experience excluding internships.' }] };
    expect(gradeAdmissionRow({ ...input, posting: experienced })).toMatchObject({ decision: { kind: 'blocked', reason: 'early-career-unverified' } });
  });
  it('revokes an existing v2 catalog occurrence only through the fenced commit effect', async () => {
    const role = posting('Backend Software Engineer Intern', '4+ years of professional backend engineering experience excluding internships.');
    const revoke = vi.fn(async () => {}), commit = vi.fn(async () => {});
    const evaluator = new RuleBasedAdmissionV2Evaluator({ earlyCareerEligibilityEnabled: true, now: () => new Date(now),
      prober: { async probe() { return { reachability: 'blocked' }; } }, sink: { commit, revoke } });
    const context: AdmissionRowContext = { sourceId: role.sourceId, externalId: role.externalId, posting: role, snapshotHash: 'snapshot',
      admissionVersion: 'policy-on', baseline: true, row: { sourceId: role.sourceId, externalId: role.externalId, snapshotHash: 'snapshot',
        materialHash: 'material', admissionVersion: 'policy-on', state: 'queued', attemptCount: 0, consecutiveOmissions: 0,
        firstObservedAt: now, lastObservedAt: now, updatedAt: now, leaseOwner: 'lease', leaseExpiresAt: '2026-10-21T13:00:00Z' } };
    const result = await evaluator.evaluate(context);
    expect(result.decision).toMatchObject({ kind: 'blocked', reason: 'early-career-unverified' });
    expect(revoke).not.toHaveBeenCalled();
    await result.commitEffect!();
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ sourceId: role.sourceId, externalId: role.externalId, admissionVersion: 'policy-on',
      effectFence: expect.objectContaining({ materialHash: 'material', leaseOwner: 'lease' }) }));
    expect(commit).not.toHaveBeenCalled();
  });
  it('versions activation so settled rows migrate, with dormant versions unchanged', () => {
    expect(ingestionV2AdmissionVersion('v1')).toBe(ingestionV2AdmissionVersion('v1', { earlyCareerEligibilityEnabled: false }));
    expect(ingestionV2AdmissionVersion('v1', { earlyCareerEligibilityEnabled: true })).not.toBe(ingestionV2AdmissionVersion('v1'));
    const config = { sourceId: 'greenhouse-acme', resolverVersion: 'v1', trustedCommunityCatalogEnabled: false };
    expect(effectiveAdmissionConfigurationVersion(config)).toBe('v1');
    expect(effectiveAdmissionConfigurationVersion({ ...config, earlyCareerEligibilityEnabled: true })).not.toBe('v1');
  });
  it('retains an unreviewed legacy v2 role without a speculative notification', async () => {
    const role = posting('Software Engineer', 'Build software with Python.');
    const previous = admission(listing(), false), commit = vi.fn(async () => {});
    const resolvePriorContext = vi.fn(async () => ({ admission: previous }));
    const evaluator = new RuleBasedAdmissionV2Evaluator({ earlyCareerEligibilityEnabled: true, now: () => new Date(now),
      resolvePriorContext, prober: { async probe() { return { reachability: 'blocked' }; } }, sink: { commit } });
    const result = await evaluator.evaluate(admissionContext(role));
    expect(result.decision.kind).toBe('admitted');
    await result.commitEffect!();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ notify: false, admission: expect.objectContaining({
      catalogEligible: true, alertEligible: false, earlyCareerReviewPending: expect.objectContaining({ reason: 'no-explicit-programme' }) }) }));
    expect(resolvePriorContext).toHaveBeenCalledTimes(1);
  });
  it('never commits or requests notifications for a general v2 role', async () => {
    const role = posting('Software Engineer', 'Build software with Python. Personal projects count.');
    const commit = vi.fn(async () => {});
    const evaluator = new RuleBasedAdmissionV2Evaluator({ earlyCareerEligibilityEnabled: true, now: () => new Date(now),
      prober: { async probe() { return { reachability: 'blocked' }; } }, sink: { commit } });
    const result = await evaluator.evaluate(admissionContext(role));
    expect(result.decision.kind).toBe('blocked');
    await result.commitEffect?.();
    expect(commit).not.toHaveBeenCalled();
  });
  it('admits an explicit graduate invitation through the complete v2 grading path', () => {
    const role = posting('Network Security Engineer', 'This position is open to experienced candidates, as well as fresh graduates who will be graduating in December 2026.\nYou have a minimum of 4 years experience supporting network security products.');
    expect(gradeAdmissionRow({ sourceId: role.sourceId, externalId: role.externalId, posting: role,
      evaluatedAt: now, earlyCareerEligibilityEnabled: true, probe: { reachability: 'blocked' } }))
      .toMatchObject({ decision: { kind: 'admitted' }, admission: { catalogEligible: true, alertEligible: true,
        earlyCareer: { status: 'eligible', programType: 'entry-level' } } });
  });
  it('preserves a provider-declared internship when the title and prose omit intern', () => {
    const role = { ...posting('Associate Software Developer', 'Build Python services while completing your degree.'), lifecycleAuthority: 'posting' as const };
    const input = { sourceId: role.sourceId, externalId: role.externalId, posting: role,
      evaluatedAt: now, earlyCareerEligibilityEnabled: true, probe: { reachability: 'blocked' as const } };
    expect(gradeAdmissionRow(input)).toMatchObject({ decision: { kind: 'admitted' }, admission: {
      catalogEligible: true, earlyCareer: { status: 'eligible', programType: 'internship' } } });
    const unofficial = processPosting({ ...role, provenance: 'reviewed-community' }, [], true).listing!;
    expect(earlyCareerFromEvidence(unofficial.metadataEvidence ?? []).status).toBe('unknown');
  });
  it('hydrates an index-only generic title and commits the body-supported internship', async () => {
    const full = posting('Software Engineer', 'This position is a paid internship building software.');
    const index = { ...full, content: [], contentCompleteness: 'index-only' as const };
    const commit = vi.fn(async () => {});
    const evaluator = new RuleBasedAdmissionV2Evaluator({ earlyCareerEligibilityEnabled: true, now: () => new Date(now),
      prober: { async probe() { return { reachability: 'live', hydratedPosting: full }; } }, sink: { commit } });
    const result = await evaluator.evaluate(admissionContext(index));
    expect(result.decision.kind).toBe('admitted');
    await result.commitEffect!();
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ admission: expect.objectContaining({
      catalogEligible: true, earlyCareer: expect.objectContaining({ programType: 'internship' }) }) }));
  });
  it('hydrates a generic technical index candidate before rejecting its experienced minimum', async () => {
    const full = posting('Software Engineer', '4+ years of professional software engineering experience required.');
    const index = { ...full, content: [], contentCompleteness: 'index-only' as const };
    const probe = vi.fn(async () => ({ reachability: 'live' as const, hydratedPosting: full }));
    const commit = vi.fn(async () => {}), revoke = vi.fn(async () => {});
    const evaluator = new RuleBasedAdmissionV2Evaluator({ earlyCareerEligibilityEnabled: true, now: () => new Date(now), prober: { probe }, sink: { commit, revoke } });
    const result = await evaluator.evaluate(admissionContext(index));
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.decision.kind).toBe('blocked');
    await result.commitEffect!();
    expect(commit).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
