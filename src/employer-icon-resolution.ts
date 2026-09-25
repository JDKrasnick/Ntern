/**
 * Deterministic company-icon domain resolution.
 *
 * Identity is decided from evidence, never from a model: the application link,
 * its redirects, the page's JSON-LD Organization, and two independent logo
 * providers each contribute weighted signals. A single clear winner above the
 * automatic threshold is accepted; the middle band is escalated to one bounded
 * LLM tie-breaker that may only choose among the submitted candidates; every
 * other outcome degrades to a stable monogram.
 *
 * Nothing here performs I/O. The resolver supplies evidence and applies the
 * decisions, so every rule below is directly testable.
 */

import { createHash } from 'node:crypto';
import { canonicalCompanyKey } from './core/normalize.js';
import { registrableDomain } from './core/registrable-domain.js';
import type { OccurrenceProvenance } from './types.js';

/**
 * Signals a candidate domain can carry. Each group contributes at most once, so
 * a page that repeats the employer name in five tags cannot inflate a score.
 */
export type IconEvidenceSignal =
  /** A non-ATS final or careers URL resolves to this eTLD+1. */
  | 'final-url'
  /** A redirect hop landed on this non-ATS employer eTLD+1. */
  | 'redirect-host'
  /** JSON-LD Organization `url` resolves to this eTLD+1. */
  | 'jsonld-url'
  /** JSON-LD Organization `name` matches the canonical employer. */
  | 'jsonld-name'
  /** `<title>` clearly names the canonical employer. */
  | 'page-title'
  /** `og:site_name` or `og:title` clearly names the canonical employer. */
  | 'opengraph'
  /** The employer's own site, established by the role's reviewed application destination. */
  | 'official-application-host'
  /** The employer's own site as its ATS board declares it. */
  | 'platform-website'
  /** The employer's name as its ATS board declares it. */
  | 'platform-name'
  /** A domain a model proposed and that then verified itself against the employer. */
  | 'proposed-domain'
  /** The posting's own reviewed ATS board slug names the canonical employer. */
  | 'ats-tenant'
  /** Logo.dev name search selected this domain. */
  | 'logo-dev'
  /** Brandfetch name search selected this domain, as corroboration only. */
  | 'brandfetch';

export interface IconDomainCandidate {
  /** Registrable domain (eTLD+1). Callers normalize before constructing. */
  domain: string;
  signals: readonly IconEvidenceSignal[];
  /** The employer's own name denotes this domain, so a transport host is its real site. */
  employerNamesDomain?: boolean;
}

export interface IconCandidateScore {
  domain: string;
  score: number;
  signals: readonly IconEvidenceSignal[];
  evidenceIds: readonly string[];
  /** Rejected candidates are reported for review but can never be selected. */
  rejected: boolean;
  rejectionReason?: string;
}

export type IconResolutionOutcome = 'resolved' | 'llm-review' | 'unresolved';

export interface IconDomainDecision {
  outcome: IconResolutionOutcome;
  scores: readonly IconCandidateScore[];
  selectedDomain?: string;
  selectedScore?: number;
  runnerUpScore?: number;
  reason: string;
}

/** Group weights from the reviewed scoring table. */
const GROUP_WEIGHTS = {
  url: 0.45,
  jsonld: 0.35,
  provider: 0.30,
  metadata: 0.15,
  /**
   * Added to the 0.45 URL weight when the candidate is the application host that
   * an officially-admitted role was recorded on, taking it to exactly the 0.85
   * automatic threshold.
   *
   * A role admitted from an official ATS, structured, or employer-submitted source
   * has already had its destination reviewed as the employer's own application
   * form. If that form is served from a host that is not a transport platform, then
   * that host *is* the employer's application host, and no page or provider needs to
   * confirm what the catalog already established. Community listings are excluded,
   * because their links are not the employer's own destination.
   */
  officialHost: 0.40,
} as const;
const PROVIDER_AGREEMENT_BONUS = 0.25;
const MAX_SCORE = 1.0;

/** A domain is accepted automatically only above this score and beyond the margin. */
export const ICON_AUTO_RESOLVE_SCORE = 0.85;
export const ICON_AUTO_RESOLVE_MARGIN = 0.15;
/** The band where one bounded LLM tie-breaker may be consulted. */
export const ICON_LLM_BAND_MINIMUM = 0.55;
/** The LLM may accept on its own word at or above this confidence. */
export const ICON_LLM_MINIMUM_CONFIDENCE = 0.9;
/**
 * ...or below it, down to this floor, when the domain it selected proves itself.
 *
 * Measured against the live catalog, the real model answers *correctly* at 0.45–0.80
 * more often than it answers at all above 0.90 — `notion.com`, `snowflake.com`, and
 * `deepgram.com` all arrived at 0.80 — so a self-reported confidence is a poor gate
 * on its own. What makes a below-floor answer usable is the same independent proof a
 * proposal needs: the domain, fetched, must name the employer in its own metadata.
 * A self-report is a guess; that is evidence.
 */
export const ICON_LLM_VERIFIED_MINIMUM_CONFIDENCE = 0.3;
/** Each provider may contribute at most this many domain candidates. */
export const MAX_PROVIDER_CANDIDATES = 5;

/**
 * ATS and job-board hosts are transport, not employer identity. A posting on one
 * of them says who is hiring, never which domain owns the brand. Employer-owned
 * vanity hosts such as `careers.example.com` are deliberately absent.
 */
const ICON_TRANSPORT_HOSTS: Record<string, true> = {
  'greenhouse.io': true, 'lever.co': true, 'ashbyhq.com': true, 'workable.com': true,
  'smartrecruiters.com': true, 'jobvite.com': true, 'icims.com': true, 'taleo.net': true,
  'myworkdayjobs.com': true, 'myworkdaysite.com': true, 'avature.net': true, 'paylocity.com': true,
  'breezy.hr': true, 'recruitee.com': true, 'bamboohr.com': true, 'eightfold.ai': true,
  'pinpointhq.com': true, 'applytojob.com': true, 'hrmdirect.com': true, 'brassring.com': true,
  'hiringthing.com': true, 'recsolu.com': true, 'oraclecloud.com': true, 'successfactors.com': true,
  'sapsf.com': true, 'yello.co': true, 'jibeapply.com': true, 'adp.com': true, 'rippling.com': true,
  'linkedin.com': true, 'indeed.com': true, 'glassdoor.com': true, 'ziprecruiter.com': true,
  'simplify.jobs': true, 'handshake.com': true, 'joinhandshake.com': true, 'wellfound.com': true,
  'builtin.com': true, 'ycombinator.com': true, 'workatastartup.com': true, 'jobright.ai': true,
  'levels.fyi': true, 'angel.co': true, 'github.com': true, 'web.archive.org': true,
  'google.com': true, 'bing.com': true, 'duckduckgo.com': true, 'crunchbase.com': true,
  'medium.com': true, 'reddit.com': true, 'wikipedia.org': true, 'notion.site': true,
  // Profile and social platforms: an Organization's `sameAs` routinely points at
  // one of these, which is a profile, never the employer's own site.
  'twitter.com': true, 'x.com': true, 'facebook.com': true, 'instagram.com': true,
  'youtube.com': true, 'tiktok.com': true, 'threads.net': true, 'gitlab.com': true,
  'bit.ly': true, 'linktr.ee': true, 'about.me': true, 'wordpress.com': true, 'substack.com': true,
};

/**
 * Whether a transport host is in fact the employer's own domain.
 *
 * The transport list names the platforms that host *other* employers' postings,
 * so a candidate on one of them is normally rejected. Some of those platforms are
 * also employers in their own right — Google, GitHub, LinkedIn, Rippling, Ashby —
 * and blocking them outright would mean those employers could never have an icon.
 * The exemption is narrow: every distinctive term of the employer's name must
 * appear in the domain itself, so `google.com` is reachable for an employer named
 * Google while `greenhouse.io` stays unreachable for anyone but Greenhouse.
 */
export function employerNamesDomain(displayName: string, domain: string): boolean {
  const terms = employerDistinctiveTerms(displayName);
  if (!terms.length) return false;
  const label = registrableDomain(domain).toLowerCase().replace(/[^a-z0-9]/gu, '');
  return label !== '' && terms.every((term) => label.includes(term));
}

/** True when a host can only transport a posting, never vouch for an employer brand. */
export function isIconTransportHost(host: string): boolean {
  const domain = registrableDomain(host);
  return domain !== '' && ICON_TRANSPORT_HOSTS[domain] === true;
}

/**
 * The compact evidence recorded at admission, when the application link and the
 * canonical employer first become known together.
 *
 * It deliberately carries no page content and no provider response: the resolver
 * gathers those later, off the ingestion hot path, so admission never waits on a
 * provider or a model.
 */
export interface EmployerIconSeed {
  canonicalEmployerId: string;
  displayName: string;
  roleTitle: string;
  applicationUrl: string;
  provider: string;
  tenant?: string;
  sourceId: string;
  /**
   * Reviewed occurrence provenance. Only an official occurrence makes the role's
   * application host the employer's own site; a community listing may point
   * anywhere, so its link is never treated as the employer's destination.
   */
  provenance?: OccurrenceProvenance;
}

/** The provenances whose application URL is the employer's own reviewed destination. */
export function officialIconProvenance(provenance: OccurrenceProvenance | undefined): boolean {
  return provenance === 'official-ats' || provenance === 'official-structured'
    || provenance === 'employer-submitted';
}

/** Page and program words that name a landing page rather than a company. */
const EMPLOYER_NAME_STOPWORDS: Record<string, true> = {
  join: true, talent: true, community: true, program: true, programme: true, careers: true,
  career: true, jobs: true, job: true, opportunities: true, opportunity: true, apply: true,
  hiring: true, internships: true, internship: true, students: true, graduate: true,
  recruitment: true, recruiting: true, university: true, campus: true,
};

/**
 * Whether a name a platform declares for its board is usable as an employer
 * identity. ATS boards sometimes carry a landing-page title — Axon's board declares
 * "Join Our Talent Community" — which names a page, not a company, and would send a
 * provider search and a logo lookup in the wrong direction.
 */
export function plausibleEmployerName(name: string | undefined): boolean {
  if (!name) return false;
  const terms = name.trim().toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  if (!terms.length || EMPLOYER_NAME_STOPWORDS[terms[0]!] === true) return false;
  return terms.some((term) => term.length > 2 && EMPLOYER_NAME_STOPWORDS[term] !== true);
}

/**
 * Organizational qualifiers a real posting page may legitimately omit, and whose
 * removal does not change which employer is being named. Catalog employer names
 * carry these ("Palantir Technologies", "Flagship Pioneering Co-Op Program")
 * while the page usually shows the brand alone.
 */
const EMPLOYER_QUALIFIERS: Record<string, true> = {
  program: true, programme: true, programs: true, coop: true, op: true,
  internship: true, internships: true, intern: true, interns: true,
  apprenticeship: true, apprenticeships: true, apprentice: true, apprentices: true,
  fellowship: true, fellowships: true, fellow: true, fellows: true, rotational: true,
  rotation: true, cohort: true, student: true, students: true,
  graduate: true, graduates: true, grad: true, newgrad: true, class: true,
  summer: true, spring: true, fall: true, winter: true, university: true, campus: true,
  careers: true, technologies: true, technology: true, group: true, holdings: true,
  international: true, global: true, solutions: true, systems: true, labs: true,
  laboratory: true, partners: true, digital: true, consulting: true, services: true,
  investment: true, management: true, capital: true, asset: true, advisors: true,
  trading: true, securities: true, financial: true,
};

/**
 * The tokens that actually identify the employer, after corporate suffixes and
 * organizational qualifiers are removed. Never empty for a name with at least one
 * distinctive token; a name made only of qualifiers yields none, and matching then
 * fails closed rather than guessing.
 */
export function employerDistinctiveTerms(displayName: string): string[] {
  return canonicalCompanyKey(displayName).split(' ')
    .filter((term) => term.length > 2 && EMPLOYER_QUALIFIERS[term] !== true && !CALENDAR_YEAR.test(term));
}

/**
 * A season's year identifies a hiring cycle, never a company: "Acme Summer 2026
 * Students" is Acme, and treating `2026` as a distinctive term made the page rule and
 * the provider rule both fail on a name that is otherwise unambiguous. Only four-digit
 * calendar years are dropped, so `500 Global` and `37signals` keep their numbers.
 */
const CALENDAR_YEAR = /^(?:19|20)\d{2}$/u;

/**
 * A metadata string clearly names the employer when every distinctive term
 * appears as its own word. Qualifiers are dropped first, so a page showing the
 * brand alone still counts for a name that carries an entity or program suffix.
 */
export function iconTextMatchesEmployer(text: string | undefined, displayName: string): boolean {
  if (!text) return false;
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()} `;
  const terms = employerDistinctiveTerms(displayName);
  if (!terms.length) return false;
  return terms.every((term) => haystack.includes(` ${term} `));
}

/**
 * A company name reduced to what a brand treats as the same name: case, punctuation,
 * spaces, and — for an entry that is the domain itself — the trailing public suffix are
 * removed. `distinctive terms` still decides meaning; this only settles spelling.
 */
function simplifyCompanyName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // `rivetindustries.com` is the same name as `Rivet Industries`; a dot only appears in
  // a host, so the last label is a public suffix rather than part of the name.
  const withoutSuffix = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(trimmed) ? trimmed.split('.').slice(0, -1).join('') : trimmed;
  return withoutSuffix.replace(/[^a-z0-9]/gu, '');
}

/** Shorter than this, a simplified name is a generic word rather than a brand. */
const MIN_SIMPLIFIED_NAME = 6;

/**
 * Whether a provider's own reported brand name denotes the canonical employer.
 *
 * Symmetric with the page rule: the provider name must contain every distinctive
 * employer term and must not add a distinctive term of its own. So a provider
 * reporting "Flagship Pioneering" for the catalog's "Flagship Pioneering Co-Op
 * Program" matches, while "Scale Computing" never matches an employer "Scale AI"
 * — the extra distinctive token is exactly the evidence of a different company.
 */
export function providerNameMatchesEmployer(providerName: string, displayName: string): boolean {
  return providerNameMatchStrength(providerName, displayName) > 0;
}

/**
 * How well a provider's reported brand name denotes the employer: `2` when the names
 * are the same name under our canonical rules, `1` when they are the same name only
 * under a brand's own spelling, `0` when they are not the same employer.
 *
 * The strength exists so a caller can order candidates rather than take the index's
 * word for which entry is best. Search results put a domain-shaped entry
 * (`appiancorporation.com`) ahead of the brand's own (`appian.com`) for the query
 * "Appian Corporation", and the first one may well have no logo: strength keeps the
 * exact match ahead of the spelling variant.
 */
export function providerNameMatchStrength(providerName: string, displayName: string): 0 | 1 | 2 {
  const reported = canonicalCompanyKey(providerName);
  if (!reported) return 0;
  if (reported === canonicalCompanyKey(displayName)) return 2;
  const terms = employerDistinctiveTerms(displayName);
  const reportedTerms = reported.split(' ');
  if (terms.length
    && terms.every((term) => reportedTerms.includes(term))
    && reportedTerms.every((term) => terms.includes(term)
      || term.length <= 3 || EMPLOYER_QUALIFIERS[term] === true)) {
    return 2;
  }
  // The same name written the way brands write it: `Rendezvous Robotics` is indexed as
  // `rendezvousrobotics`, `Toshiba Global Commerce Solutions` as
  // `toshibaglobalcommercesolutions`, and an index entry is sometimes the domain itself
  // (`rivetindustries.com`). Equality only — never containment — so `Bree` still does not
  // match `Breeze` and `N1` does not match `Nexl`, and both sides must be long enough
  // that a short generic word cannot be the whole of the other.
  const simplified = simplifyCompanyName(providerName);
  return simplified.length >= MIN_SIMPLIFIED_NAME && simplified === simplifyCompanyName(displayName) ? 1 : 0;
}

/**
 * Whether the posting's own ATS board slug corroborates the canonical employer.
 *
 * The tenant is part of the provider identity the catalog already reviewed — it
 * is the board that hosts this employer's postings — so it is evidence about the
 * employer, independent of whatever domain a provider nominates. Compared against
 * the canonical employer ID, which is a reviewed stable slug, rather than against
 * fuzzy name tokens, so a weak generic word can never satisfy it.
 */
export function tenantCorroboratesEmployer(tenant: string | undefined, canonicalEmployerId: string): boolean {
  const simplify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, '');
  const employer = simplify(canonicalEmployerId);
  const board = simplify(tenant ?? '');
  if (employer.length < 2 || !board) return false;
  if (board === employer) return true;
  // A board may carry the provider's own segment, so a whole-segment or affix
  // match counts too ("job-boards/artefactlinkedin" hosts "artefact").
  const segments = (tenant ?? '').toLowerCase().split(/[^a-z0-9]+/u).map(simplify).filter(Boolean);
  if (segments.includes(employer)) return true;
  // Affix matching needs a distinctive employer slug: "tech" occurs inside
  // "fintechcorp" without either naming the other, so a whole-segment or exact
  // match is always required, and an affix only from four characters up. Prefixes
  // are how real boards name short employers ("axontalentcommunity" hosts "axon").
  return employer.length >= 4 && (board.startsWith(employer) || board.endsWith(employer));
}

/** Stable evidence identifier a decision may cite, e.g. `logo-dev:example.com`. */
export function iconEvidenceId(signal: IconEvidenceSignal, domain: string): string {
  return `${signal}:${domain}`;
}

/**
 * Scores one candidate against the reviewed table. Provider agreement is
 * supplied by the caller because it depends on the whole candidate set.
 */
export function scoreIconCandidate(
  candidate: IconDomainCandidate,
  options: { providersAgree?: boolean } = {},
): IconCandidateScore {
  const domain = registrableDomain(candidate.domain);
  const signals = [...new Set(candidate.signals)];
  const evidenceIds = signals.map((signal) => iconEvidenceId(signal, domain));
  const transport = isIconTransportHost(domain) && candidate.employerNamesDomain !== true;
  if (!domain || transport || !signals.length) {
    return {
      domain, score: 0, signals, evidenceIds, rejected: true,
      rejectionReason: !domain ? 'candidate has no registrable domain'
        : transport ? 'ATS or job-board host without employer evidence'
          : 'candidate carries no supporting signal',
    };
  }
  let score = 0;
  if (signals.includes('final-url') || signals.includes('redirect-host')) score += GROUP_WEIGHTS.url;
  if (signals.includes('official-application-host')) score += GROUP_WEIGHTS.officialHost;
  if (signals.includes('jsonld-url') || signals.includes('jsonld-name') || signals.includes('platform-website')) {
    score += GROUP_WEIGHTS.jsonld;
  }
  if (signals.includes('logo-dev')) score += GROUP_WEIGHTS.provider;
  if (signals.includes('brandfetch')) score += GROUP_WEIGHTS.provider;
  if (signals.includes('logo-dev') && signals.includes('brandfetch') && options.providersAgree) {
    score += PROVIDER_AGREEMENT_BONUS;
  }
  if (signals.includes('page-title') || signals.includes('opengraph') || signals.includes('ats-tenant')
    || signals.includes('platform-name')) {
    score += GROUP_WEIGHTS.metadata;
  }
  // Decimal weights accumulate binary float error, and a resolved/unresolved
  // decision compares against a threshold exactly, so the sum is settled here
  // rather than left to whatever `0.45 + 0.40` happens to produce.
  return { domain, score: Math.min(Number(score.toFixed(6)), MAX_SCORE), signals, evidenceIds, rejected: false };
}

/**
 * Scores every candidate and orders them best-first. Ties keep insertion order,
 * which is the order the resolver gathered evidence in, so a decision for a
 * given evidence set is reproducible.
 */
export function scoreIconCandidates(candidates: readonly IconDomainCandidate[]): IconCandidateScore[] {
  const providerDomains: Record<string, { 'logo-dev'?: true; brandfetch?: true }> = {};
  for (const candidate of candidates) {
    const domain = registrableDomain(candidate.domain);
    if (!domain) continue;
    const providers = providerDomains[domain] ?? {};
    if (candidate.signals.includes('logo-dev')) providers['logo-dev'] = true;
    if (candidate.signals.includes('brandfetch')) providers.brandfetch = true;
    providerDomains[domain] = providers;
  }
  return candidates
    .map((candidate) => {
      const providers = providerDomains[registrableDomain(candidate.domain)] ?? {};
      return scoreIconCandidate(candidate, { providersAgree: providers['logo-dev'] === true && providers.brandfetch === true });
    })
    .sort((left, right) => right.score - left.score);
}

/** Chooses between automatic resolution, one LLM tie-break, and a monogram. */
export function decideIconDomain(candidates: readonly IconDomainCandidate[]): IconDomainDecision {
  const scores = scoreIconCandidates(candidates);
  const eligible = scores.filter((candidate) => !candidate.rejected);
  const best = eligible[0];
  if (!best) {
    return { outcome: 'unresolved', scores, reason: 'No eligible employer domain candidate' };
  }
  // The employer's own ATS board declares the employer's site. When that declaration is
  // a different domain from the one the providers agreed on, the employer's own word
  // wins: two providers agreeing with each other is exactly how a namesake gets
  // published (an employer that links `figure.ai` on its board while both providers
  // nominate the unrelated `figure.com`), and the board's domain is the employer
  // stating its own site. This is deliberately narrow — it only overrides a decision
  // the providers would have made on their own; with no declaration, nothing changes.
  const declared = eligible.find((candidate) => candidate.signals.includes('platform-website'));
  if (declared && declared.domain !== best.domain) {
    return {
      outcome: 'resolved', scores, selectedDomain: declared.domain, selectedScore: declared.score,
      runnerUpScore: best.score,
      reason: `the employer's own board names ${declared.domain}, not ${best.domain}`,
    };
  }
  const runnerUp = eligible.find((candidate) => candidate.domain !== best.domain);
  const margin = runnerUp ? best.score - runnerUp.score : MAX_SCORE;
  if (best.score >= ICON_AUTO_RESOLVE_SCORE && margin >= ICON_AUTO_RESOLVE_MARGIN) {
    return {
      outcome: 'resolved', scores, selectedDomain: best.domain, selectedScore: best.score,
      ...(runnerUp ? { runnerUpScore: runnerUp.score } : {}),
      reason: `Score ${best.score.toFixed(2)} clears ${ICON_AUTO_RESOLVE_SCORE} with a ${margin.toFixed(2)} margin`,
    };
  }
  const closeCompetition = runnerUp !== undefined && margin < ICON_AUTO_RESOLVE_MARGIN;
  // A candidate that carries two independent evidence ids is one the tie-breaker
  // could actually accept, because its own acceptance rule requires exactly that.
  // Escalating it costs one bounded call and is the only path by which a posting
  // hosted on an ATS host — whose page proves the employer but names no domain —
  // can reach a decision at all.
  const corroborated = best.evidenceIds.length >= 2;
  if (best.score >= ICON_LLM_BAND_MINIMUM || closeCompetition || corroborated) {
    return {
      outcome: 'llm-review', scores, selectedDomain: best.domain, selectedScore: best.score,
      ...(runnerUp ? { runnerUpScore: runnerUp.score } : {}),
      reason: closeCompetition && best.score < ICON_LLM_BAND_MINIMUM
        ? `Two candidates within ${ICON_AUTO_RESOLVE_MARGIN} of each other`
        : best.score < ICON_LLM_BAND_MINIMUM
          ? `Score ${best.score.toFixed(2)} carries ${best.evidenceIds.length} independent evidence sources and needs a bounded tie-breaker`
          : `Score ${best.score.toFixed(2)} needs a bounded tie-breaker`,
    };
  }
  return {
    outcome: 'unresolved', scores, selectedDomain: best.domain, selectedScore: best.score,
    ...(runnerUp ? { runnerUpScore: runnerUp.score } : {}),
    reason: `Best score ${best.score.toFixed(2)} is below the ${ICON_LLM_BAND_MINIMUM} evidence floor`,
  };
}

/** The strict JSON schema the tie-breaker must satisfy. */
export const iconTieBreakSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'officialDomain', 'confidence', 'evidenceIds', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['accept', 'uncertain', 'reject'] },
    officialDomain: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidenceIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 8 },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
} as const;

export interface IconTieBreakDecision {
  decision: 'accept' | 'uncertain' | 'reject';
  officialDomain: string | null;
  confidence: number;
  evidenceIds: readonly string[];
  reason: string;
}

/** Structural validation only; no field escapes the declared shape. */
export function parseIconTieBreakDecision(value: unknown): IconTieBreakDecision | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'confidence,decision,evidenceIds,officialDomain,reason') return undefined;
  const { decision, officialDomain, confidence, evidenceIds, reason } = record;
  if (decision !== 'accept' && decision !== 'uncertain' && decision !== 'reject') return undefined;
  if (officialDomain !== null && typeof officialDomain !== 'string') return undefined;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined;
  if (!Array.isArray(evidenceIds) || evidenceIds.length > 8) return undefined;
  if (evidenceIds.some((id) => typeof id !== 'string' || !id.trim())) return undefined;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) return undefined;
  return { decision, officialDomain: officialDomain === null ? null : officialDomain.trim().toLowerCase(),
    confidence, evidenceIds: [...new Set(evidenceIds.map((id) => (id as string).trim()))], reason: reason.trim() };
}

export interface IconTieBreakAcceptance {
  accepted: boolean;
  domain?: string;
  /** Compact, persistable reason code; never the model's prose. */
  reasonCode: string;
  /**
   * Set when every structural rule passed and only the model's own confidence fell
   * short of the self-reporting floor. The caller may still accept the candidate by
   * proving the domain names this employer, which is what makes the answer usable.
   */
  pendingVerification?: { domain: string; confidence: number };
}

/**
 * Applies server-side validation to a tie-breaker answer. The model may only
 * select a domain from the submitted candidates and may only cite evidence that
 * supports that candidate; two independent evidence sources are required. No
 * model output can introduce a URL, asset, storage key, or provider request.
 *
 * A candidate named as a subdomain (`careers.acme.com` for the submitted
 * `acme.com`) folds to the submitted candidate and the model's own string is
 * discarded, so an answer can narrow a host but never widen one.
 */
export function acceptIconTieBreak(
  decision: IconTieBreakDecision | undefined,
  submitted: readonly IconCandidateScore[],
): IconTieBreakAcceptance {
  if (!decision) return { accepted: false, reasonCode: 'malformed-decision' };
  if (decision.decision !== 'accept') return { accepted: false, reasonCode: `decision-${decision.decision}` };
  const officialDomain = decision.officialDomain;
  if (!officialDomain) return { accepted: false, reasonCode: 'domain-missing' };
  const selected = submitted.find((candidate) => !candidate.rejected
    && candidate.domain === registrableDomain(officialDomain));
  if (!selected) return { accepted: false, reasonCode: 'domain-outside-candidates' };
  const known = new Set(submitted.flatMap((candidate) => [...candidate.evidenceIds]));
  if (decision.evidenceIds.some((id) => !known.has(id))) return { accepted: false, reasonCode: 'evidence-outside-input' };
  const cited = decision.evidenceIds.filter((id) => selected.evidenceIds.includes(id));
  if (cited.length !== decision.evidenceIds.length) return { accepted: false, reasonCode: 'evidence-does-not-support-domain' };
  if (cited.length < 2) return { accepted: false, reasonCode: 'insufficient-independent-evidence' };
  // Every structural rule holds, so the only question left is whether this answer is
  // believed on its own confidence or has to be proven against the domain.
  if (decision.confidence >= ICON_LLM_MINIMUM_CONFIDENCE) {
    return { accepted: true, domain: selected.domain, reasonCode: 'accepted' };
  }
  if (decision.confidence < ICON_LLM_VERIFIED_MINIMUM_CONFIDENCE) {
    return { accepted: false, reasonCode: 'confidence-below-floor' };
  }
  return {
    accepted: false, reasonCode: 'needs-domain-confirmation',
    pendingVerification: { domain: selected.domain, confidence: decision.confidence },
  };
}

/**
 * The strict JSON schema for the proposal mode, used when the resolver has no
 * candidate to choose among and must find a domain instead of ranking one.
 */
export const iconProposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'confidence', 'reason'],
  properties: {
    domain: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
} as const;

/** A proposed domain is only ever attempted at or above this confidence. */
export const ICON_PROPOSAL_MINIMUM_CONFIDENCE = 0.9;

/**
 * The schema for one bounded asset call.
 *
 * This is the single place a model is allowed to name an asset rather than a domain.
 * The answer is never trusted on its own: a pick must be one of the assets submitted
 * to it, and a URL it names itself is admitted only on the employer's verified domain
 * and only after the same fetch, raster, size, and shape gates every other asset
 * passes. `assetUrl` is therefore a *nomination*, exactly as a proposed domain is.
 */
export const iconAssetPickSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['assetUrl', 'confidence', 'reason'],
  properties: {
    assetUrl: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
} as const;

/** An asset answer is only ever attempted at or above this confidence. */
export const ICON_ASSET_MINIMUM_CONFIDENCE = 0.5;

/** One asset answer: either a submitted candidate, or a same-domain nomination. */
export type IconAssetNomination =
  | { kind: 'submitted'; url: string; confidence: number }
  | { kind: 'nominated'; url: string; confidence: number };

export interface IconAssetPick {
  assetUrl: string | null;
  confidence: number;
  reason: string;
}

/** Structural validation only; the URL is normalized and never trusted as an asset yet. */
export function parseIconAssetPick(value: unknown): IconAssetPick | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'assetUrl,confidence,reason') return undefined;
  const { assetUrl, confidence, reason } = record;
  if (assetUrl !== null && typeof assetUrl !== 'string') return undefined;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) return undefined;
  return {
    assetUrl: typeof assetUrl === 'string' && assetUrl.trim() ? assetUrl.trim() : null,
    confidence, reason: reason.trim(),
  };
}

/**
 * Applies the server-side rule to one asset answer.
 *
 * A submitted URL is admitted as a pick. Any other URL is a *nomination*, and is
 * admitted only when it is `https` on the employer's own verified domain — the model
 * may choose an asset the extraction missed, but it can never point us outside the
 * domain we already established. Everything else about the answer, including whether
 * the bytes are usable at all, is decided by the fetch and the gates afterwards.
 */
export function acceptIconAssetPick(
  pick: IconAssetPick | undefined,
  submitted: readonly string[],
  verifiedDomain: string,
): IconAssetNomination | undefined {
  if (!pick || !pick.assetUrl || pick.confidence < ICON_ASSET_MINIMUM_CONFIDENCE) return undefined;
  const url = normalizeAssetUrl(pick.assetUrl);
  if (!url) return undefined;
  const selected = submitted.find((candidate) => normalizeAssetUrl(candidate) === url);
  if (selected) return { kind: 'submitted', url: selected, confidence: pick.confidence };
  const host = new URL(url).hostname.toLowerCase();
  const domain = verifiedDomain.toLowerCase();
  const sameDomain = host === domain || host.endsWith(`.${domain}`);
  return sameDomain ? { kind: 'nominated', url, confidence: pick.confidence } : undefined;
}

function normalizeAssetUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}

export interface IconDomainProposal {
  domain: string | null;
  confidence: number;
  reason: string;
}

/** Structural validation only; the domain is normalized to a registrable hostname. */
export function parseIconProposal(value: unknown): IconDomainProposal | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'confidence,domain,reason') return undefined;
  const { domain, confidence, reason } = record;
  if (domain !== null && typeof domain !== 'string') return undefined;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) return undefined;

  let normalized: string | null = null;
  if (typeof domain === 'string' && domain.trim()) {
    const raw = domain.trim().toLowerCase();
    const host = raw.includes('://') ? (() => { try { return new URL(raw).hostname; } catch { return ''; } })()
      : raw.split('/')[0]!.split('@').pop()!.split(':')[0]!;
    const registrable = registrableDomain(host.replace(/^www\./u, ''));
    if (registrable.includes('.') && registrable.length <= 253) normalized = registrable;
    else return undefined;
  }
  return { domain: normalized, confidence, reason: reason.trim() };
}

/**
 * Deduplication key for one resolution attempt. A newer posting with stronger
 * evidence produces a different fingerprint and therefore supersedes an earlier
 * failed attempt, while a redelivery of the same evidence collapses onto one row.
 *
 * The employer name is hashed in its canonical form, so a redelivered variant
 * with different spacing, casing, or a corporate suffix is the same evidence
 * rather than a new attempt. Query strings and trailing slashes are likewise not
 * evidence, but the path is: a different role on the same host is a new attempt.
 */
export function iconEvidenceFingerprint(input: {
  canonicalEmployerId: string;
  displayName: string;
  applicationUrl: string;
  provider: string;
  tenant?: string;
}): string {
  let host = '';
  let path = '';
  try {
    const url = new URL(input.applicationUrl);
    host = url.hostname.toLowerCase();
    path = url.pathname.replace(/\/+$/u, '') || '/';
  } catch { /* An unparsable link still contributes its own text below. */ }
  return createHash('sha256').update([
    input.canonicalEmployerId,
    canonicalCompanyKey(input.displayName),
    host,
    path,
    input.provider,
    input.tenant ?? '',
  ].join('\0')).digest('hex');
}
