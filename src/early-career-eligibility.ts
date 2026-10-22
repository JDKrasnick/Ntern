import { htmlToText } from './core/early-career.js';
import { providerPostingAlias, providerPostingReference } from './identity/posting.js';
import type { CatalogAdmission, CatalogAdmissionReason, EarlyCareerAssessment, EvidenceSource, Internship, InternshipIdentity, InternshipProgramType, RoleMetadataEvidence } from './types.js';

export const EARLY_CAREER_POLICY_VERSION = 4;
const officialSources: Partial<Record<EvidenceSource, number>> = { 'official-api': 0, 'official-ats': 1, 'official-json-ld': 2, 'official-page': 3 };
const bounded = (s: string) => s.replace(/\s+/gu, ' ').trim().slice(0, 240);

/** A programme must be stated; a generic engineer title is never an internship. */
export function explicitProgramType(title: string): InternshipProgramType {
  if (/\b(?:co[ -]?ops?|cooperative education|working student|student worker|part[ -]time student|student placement|industrial placement|werkstudent\w*)\b/iu.test(title)) return 'co-op';
  if (/\bapprentices?(?:hips?)?\b/iu.test(title)) return 'apprenticeship';
  if (/\b(?:interns?(?:hips?)?|stagiaire\w*|stagiair\w*|praktikant\w*)\b/iu.test(title)) return 'internship';
  if (/\b(?:pflichtpraktikum|praktikum|tirocinio|est[aá]gio|estagi[aá]ri[oa])\b|^(?:pr[aá]cticas|becari[oa])\b/iu.test(title)) return 'internship';
  if (/\bsummer placement\b|\bstage de fin d['’]études\b/iu.test(title)) return 'internship';
  if (/\b(?:new[ -]?grad(?:uate)?s?|graduate (?:(?:software |data |mechanical |electrical )?engineer\w*|program(?:me)?|scheme|trainee|analyst|developer)|(?:university|college|campus)[ -](?:hire|graduate|program(?:me)?))\b/iu.test(title)) return 'new-grad';
  // This phrase can name the audience a recruiter hires, rather than this role.
  if (/\b(?:early[ -]career|campus|university)\b.{0,35}\b(?:talent|recruit\w*)\b/iu.test(title)) return 'unknown';
  if (/\b(?:early[ -]career|entry[ -]level|placement (?:year|student)|year in industry)\b/iu.test(title)) return 'entry-level';
  return 'unknown';
}

/** Require a programme or applicant eligibility stated by the exact employer. */
export function assessOfficialEarlyCareer(input: { title: string; text?: string; employmentType?: string }): EarlyCareerAssessment {
  const title = htmlToText(input.title).slice(0, 500);
  const sentences = (input.text ?? '').slice(0, 80_000).replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?\s*>/giu, '\n')
    .split(/\n+|(?<=[.!?;])\s+/u).map(htmlToText).filter(Boolean);
  const decision = (status: EarlyCareerAssessment['status'], reason: EarlyCareerAssessment['reason'], quotes: string[], programType?: InternshipProgramType): EarlyCareerAssessment => ({
    policyVersion: EARLY_CAREER_POLICY_VERSION, status, reason, officialTitle: title,
    ...(programType && programType !== 'unknown' ? { programType } : {}), evidence: quotes.map(bounded).filter(Boolean).slice(0, 3),
  });
  const recruiter = /\b(?:early[ -]career|campus|university)\b.{0,35}\b(?:talent|recruit\w*)\b|\b(?:internship|student placement|industrial placement) (?:program(?:me)? )?(?:manager|coordinator|recruiter)\b/iu.test(title);
  if (recruiter) return decision('ineligible', 'experienced-role', [title]);
  // Categorical denials differ from marketing such as “not an internship
  // built around shadowing”. Denying an internship does not deny a co-op.
  const denied = sentences.find(s => /\bthis(?: (?:role|position))? is not (?:an? )?(?:internship|entry[ -]level)(?: (?:position|role|opportunity|programme?))?\s*(?:[.,!;]|$)/iu.test(s));
  const denies = (type: InternshipProgramType) => Boolean(denied && (/internship/iu.test(denied) ? type === 'internship' : type === 'entry-level' || type === 'new-grad'));
  const programme = explicitProgramType(title);
  const localizedStage = /(?:^|[-–:(])\s*stage\b/iu.test(title) || /\bstage de fin d['’]études\b/iu.test(title);
  const stageContext = localizedStage && (sentences.find(s => /\bstag(?:iaire|ista|iair)\w*\b|stage de fin d['’]études|durée (?:du |de )?stage|convention de stage|stageperiode|(?<!\p{L})(?:étudiant|école|université|études)|stage de \d+ mois/iu.test(s)) || (/\b(?:ingénieur|développeur|étudiant)\b/iu.test(title) ? title : undefined));
  // A positive programme with an explicitly incompatible professional minimum
  // needs review. Academic/research duration and preferred experience do not.
  const contradictory = sentences.find(s => /\b(?:[3-9]|[1-9]\d)\s*(?:\+|[-–—]\s*\d+)?\s*years?\b.{0,250}\bexcluding internships\b/iu.test(s)
    && !/\b(?:preferred|nice to have|bonus|a plus)\b/iu.test(s));
  if (stageContext) return denies('internship') || contradictory ? decision('unknown', 'conflicting-employer-evidence', [denied ?? contradictory!]) : decision('eligible', 'explicit-programme', [title, stageContext], 'internship');
  if (programme !== 'unknown') {
    if (denies(programme)) return decision('unknown', 'conflicting-employer-evidence', [denied!]);
    if (contradictory) return decision('unknown', 'conflicting-employer-evidence', [title, contradictory]);
    return decision('eligible', 'explicit-programme', [title], programme);
  }
  if (/\b(?:senior|sr\.?|staff\+?|principal|director|head of)\b|\bengineering manager\b/iu.test(title)) {
    return decision('ineligible', 'experienced-role', [title]);
  }
  if (/^(?:intern(?:ship)?|co[ -]?op|apprenticeship)$/iu.test(input.employmentType?.trim() ?? '')) {
    if (denies(explicitProgramType(input.employmentType!))) return decision('unknown', 'conflicting-employer-evidence', [denied!]);
    if (contradictory) return decision('unknown', 'conflicting-employer-evidence', [input.employmentType!, contradictory]);
    return decision('eligible', 'explicit-programme', [input.employmentType!], explicitProgramType(input.employmentType!));
  }
  // Mentioning prior internships, mentoring interns or company-wide recruiting
  // does not describe this applicant's role. Match role-directed statements.
  const programmeStatement = sentences.find(s => /\b(?:as an? (?:[\w-]+\s+){0,3}(?:intern|apprentice)|(?:seeking|hiring|looking for).{0,100}\binterns?\b|(?:(?:this|the) (?:role|position) is|this is) (?:an? )?(?:(?:paid|full[ -]time|part[ -]time) )?(?:internship|co[ -]?op|apprenticeship)|this internship (?:runs?|lasts?|is (?:a|for)|dates|duration)|(?:must|required to) (?:be )?(?:returning|return) to school.{0,80}internship|semester of schooling remaining after the internship)\b/iu.test(s)
    && !/\b(?:(?:mentor\w*|supervis\w*|manag\w*)\b.{0,30}\binterns?|not an? internship|excluding internships|prior internship|previous internship|(?:experience|worked|working|served) as an? (?:[\w-]+\s+){0,3}(?:intern|apprentice))\b/iu.test(s));
  if (programmeStatement) {
    if (contradictory) return decision('unknown', 'conflicting-employer-evidence', [programmeStatement, contradictory]);
    const type = explicitProgramType(programmeStatement);
    const supportedType = type === 'unknown' ? 'internship' : type;
    if (denies(supportedType)) return decision('unknown', 'conflicting-employer-evidence', [denied!]);
    return decision('eligible', 'explicit-programme', [programmeStatement], supportedType);
  }
  const placement = /\bplacement\b/iu.test(title) && sentences.find(s => /placement program(?:me)?.{0,100}(?:undergraduate|student)/iu.test(s));
  if (placement) return decision('eligible', 'explicit-programme', [title, placement], 'co-op');
  // A direct graduate invitation can coexist with an experienced-applicant
  // template. It is positive eligibility; a generic skills requirement is not.
  const entry = sentences.find(s => /\b(?:no (?:prior |previous |professional |work )?experience (?:is )?(?:required|necessary)|(?:0|zero)\s*(?:[-–]|to)\s*[12]\s+years? (?:of )?(?:professional |work |industry )?experience|(?:recent|fresh|new) graduates (?:are )?(?:encouraged|welcome|eligible)|(?:this|the) (?:position|role) is open to.{0,100}\b(?:fresh|recent|new) graduates)\b/iu.test(s)
    && !/\b(?:no .{0,15}(?:aerospace|printing|AI|domain|industry-specific) experience|experience (?:is )?(?:required|necessary) (?:with|in|using|on)\b)/iu.test(s));
  if (entry) return denies('entry-level') ? decision('unknown', 'conflicting-employer-evidence', [denied!]) : decision('eligible', 'explicit-entry-level', [entry], 'entry-level');
  if (denied) return decision('unknown', 'conflicting-employer-evidence', [denied]);
  return decision('unknown', 'no-explicit-programme', []);
}

export function selectEarlyCareerAssessment(values: readonly EarlyCareerAssessment[]): EarlyCareerAssessment {
  const usable = values.filter(v => v.policyVersion === EARLY_CAREER_POLICY_VERSION && v.sourceClass && officialSources[v.sourceClass] !== undefined && v.artifactHash);
  if (!usable.length) return { policyVersion: EARLY_CAREER_POLICY_VERSION, status: 'unknown', reason: 'missing-official-evidence', evidence: [] };
  const observed = (v: EarlyCareerAssessment) => Number.isFinite(Date.parse(v.observedAt ?? '')) ? Date.parse(v.observedAt!) : -Infinity;
  const latest = Math.max(...usable.map(observed));
  const simultaneous = usable.filter(v => observed(v) === latest);
  // Missing detail in a page shell does not contradict an exact API programme
  // observed at the same time. Explicit negative/conflicting claims still do.
  const informative = simultaneous.filter(v => v.reason !== 'no-explicit-programme' && v.reason !== 'missing-official-evidence');
  const current = informative.length ? informative : simultaneous;
  const outcomes = new Set(current.map(v => `${v.status}:${v.programType ?? ''}`));
  const winner = [...current].sort((a,b) => officialSources[a.sourceClass!]! - officialSources[b.sourceClass!]!
    || a.artifactHash!.localeCompare(b.artifactHash!))[0]!;
  return outcomes.size === 1 ? winner : { ...winner, status: 'unknown', programType: undefined, reason: 'conflicting-employer-evidence' };
}

export function earlyCareerFromEvidence(evidence: readonly RoleMetadataEvidence[]): EarlyCareerAssessment {
  return selectEarlyCareerAssessment(evidence.flatMap(e => e.exactPosting && e.earlyCareer && officialSources[e.sourceClass] !== undefined
    ? [{ ...e.earlyCareer, sourceClass: e.sourceClass, sourceUrl: e.sourceUrl, artifactHash: e.artifactHash, observedAt: e.observedAt }] : []));
}

/** Preserve all other admission decisions; this gate cannot bypass destination or identity policy. */
export function withEarlyCareerAdmission(admission: CatalogAdmission, assessment: EarlyCareerAssessment): CatalogAdmission {
  const reasons: CatalogAdmissionReason[] = admission.reasonCodes.filter(r => r !== 'not-early-career' && r !== 'early-career-unverified');
  const diagnosticOnly = admission.evidenceCodes?.includes('trusted-community-source')
    ? new Set<CatalogAdmissionReason>(['employer-unresolved', 'posting-unattributed']) : new Set<CatalogAdmissionReason>();
  const blockedElsewhere = reasons.some(r => r !== 'destination-grace' && !diagnosticOnly.has(r));
  // Canonical merging may add an identity/metadata conflict after this policy
  // was enrolled. Saved base flags must never erase that later revocation.
  const baseCatalogEligible = (admission.earlyCareer?.baseCatalogEligible ?? admission.catalogEligible) && !blockedElsewhere;
  const baseAlertEligible = (admission.earlyCareer?.baseAlertEligible ?? admission.alertEligible) && !blockedElsewhere && !reasons.includes('destination-grace');
  if (assessment.status !== 'eligible') reasons.push(assessment.status === 'ineligible' ? 'not-early-career' : 'early-career-unverified');
  // A verified general role is still not a verified early-career programme.
  const catalogCandidate = assessment.status === 'eligible';
  return { ...admission, earlyCareerReviewPending: undefined, earlyCareer: { ...assessment, baseCatalogEligible, baseAlertEligible },
    catalogEligible: baseCatalogEligible && catalogCandidate, alertEligible: baseAlertEligible && assessment.status === 'eligible', reasonCodes: [...new Set(reasons)].sort() };
}

/** Refresh a policy-enrolled role without closing its lifecycle or deleting application history. */
export function enforceJobEarlyCareer(job: Internship, evidence: readonly RoleMetadataEvidence[]): Internship {
  if (!job.admission?.earlyCareer) return job;
  const evidenceKey = (e: RoleMetadataEvidence) => JSON.stringify([e.sourceClass, e.sourceId, e.sourceUrl, e.artifactHash]);
  const target = (r: Pick<Internship['sourceReferences'][number], 'applyUrl'>) => {
    try {
      const posting = providerPostingReference(r.applyUrl);
      return posting.provider !== 'unknown' && posting.postingId ? providerPostingAlias(posting) : undefined;
    } catch { return undefined; }
  };
  const openTargets = new Set(job.sourceReferences.filter(r => r.state === 'open').map(target).filter(Boolean));
  const openEvidence = new Set(job.sourceReferences.filter(r => r.state === 'open').flatMap(r => r.metadataEvidence?.map(evidenceKey) ?? []));
  const closedEvidence = new Map<string, Set<string>>();
  for (const reference of job.sourceReferences.filter(r => r.state === 'closed')) {
    const posting = target(reference);
    for (const e of reference.metadataEvidence ?? []) {
      const key = evidenceKey(e), targets = closedEvidence.get(key) ?? new Set<string>();
      if (posting) targets.add(posting);
      closedEvidence.set(key, targets);
    }
  }
  // A community omission closes its occurrence, not the employer's posting.
  // Keep exact employer proof while another alias of that posting remains open.
  // Closed jobs retain their historical classification without reopening them.
  const assessment = earlyCareerFromEvidence(evidence.filter(e => !job.open || !closedEvidence.has(evidenceKey(e))
    || openEvidence.has(evidenceKey(e)) || [...closedEvidence.get(evidenceKey(e))!].some(posting => openTargets.has(posting))));
  const canonicalTarget = target({ applyUrl: job.admission.destination.finalUrl ?? job.admission.destination.candidateUrl });
  const qualified = assessment.status === 'eligible' && canonicalTarget && (!job.open || openTargets.has(canonicalTarget))
    ? job.sourceReferences.find(r => target(r) === canonicalTarget && r.admission?.earlyCareer?.baseCatalogEligible)
    : undefined;
  const preserveQualifiedBase = (current: CatalogAdmission, posting: string | undefined): CatalogAdmission => {
    if (!qualified?.admission || posting !== canonicalTarget || current.earlyCareer?.baseCatalogEligible !== false) return current;
    // Admission to this exact employer posting was already reviewed. Moving
    // between community aliases must not turn its older unresolved-employer
    // diagnostic into a new blocker. Other current gates remain enforced below.
    return { ...current, employerResolution: qualified.admission.employerResolution,
      ...(qualified.admission.canonicalEmployer ? { canonicalEmployer: qualified.admission.canonicalEmployer } : {}),
      evidenceCodes: [...new Set([...(current.evidenceCodes ?? []), ...(qualified.admission.evidenceCodes ?? [])])],
      earlyCareer: { ...current.earlyCareer!, baseCatalogEligible: true, baseAlertEligible: false } };
  };
  const admission = withEarlyCareerAdmission(preserveQualifiedBase(job.admission, canonicalTarget), assessment);
  const identity = job.internshipIdentity as Partial<InternshipIdentity> | undefined;
  const programType = assessment.programType ?? 'unknown';
  const provenance = assessment.sourceClass && assessment.sourceUrl ? [{ source: assessment.sourceClass, sourceId: 'early-career-policy', sourceUrl: assessment.sourceUrl,
    contentHash: assessment.artifactHash, evidenceCode: assessment.reason }] : [];
  return { ...job, admission, programType,
    sourceReferences: job.sourceReferences.map(reference => reference.admission
      ? { ...reference, admission: withEarlyCareerAdmission(preserveQualifiedBase(reference.admission, target(reference)), assessment) } : reference),
    ...(assessment.officialTitle ? { title: assessment.officialTitle } : {}),
    ...(identity?.title?.official && identity.programType ? { internshipIdentity: { ...identity,
      title: { official: { value: assessment.officialTitle ?? job.title, provenance },
        display: { value: assessment.officialTitle ?? job.title, provenance }, search: { value: assessment.officialTitle ?? job.title, provenance } },
      programType: { value: programType, provenance } } as InternshipIdentity } : {}),
    ...(assessment.status !== 'eligible' ? { season: 'ongoing' } : {}),
    notification: admission.alertEligible ? job.notification : { ...job.notification, smsPending: false, digestPending: false },
  };
}
