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
  /** Logo.dev name search selected this domain. */
  | 'logo-dev'
  /** Brandfetch name search selected this domain, as corroboration only. */
  | 'brandfetch';

export interface IconDomainCandidate {
  /** Registrable domain (eTLD+1). Callers normalize before constructing. */
  domain: string;
  signals: readonly IconEvidenceSignal[];
  /** The provider returned a real image, not a monogram/placeholder fallback. */
  imageAvailable?: boolean;
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
} as const;
const PROVIDER_AGREEMENT_BONUS = 0.25;
const MAX_SCORE = 1.0;

/** A domain is accepted automatically only above this score and beyond the margin. */
export const ICON_AUTO_RESOLVE_SCORE = 0.85;
export const ICON_AUTO_RESOLVE_MARGIN = 0.15;
/** The band where one bounded LLM tie-breaker may be consulted. */
export const ICON_LLM_BAND_MINIMUM = 0.55;
/** The LLM may never accept below this confidence. */
export const ICON_LLM_MINIMUM_CONFIDENCE = 0.9;
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
};

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
}

/** A metadata string clearly names the employer only when every distinctive term appears. */
export function iconTextMatchesEmployer(text: string | undefined, displayName: string): boolean {
  if (!text) return false;
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()} `;
  const terms = canonicalCompanyKey(displayName).split(' ').filter((term) => term.length > 2);
  if (!terms.length) return false;
  return terms.every((term) => haystack.includes(` ${term} `));
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
  if (!domain || isIconTransportHost(domain) || !signals.length) {
    return {
      domain, score: 0, signals, evidenceIds, rejected: true,
      rejectionReason: !domain ? 'candidate has no registrable domain'
        : isIconTransportHost(domain) ? 'ATS or job-board host without employer evidence'
          : 'candidate carries no supporting signal',
    };
  }
  let score = 0;
  if (signals.includes('final-url') || signals.includes('redirect-host')) score += GROUP_WEIGHTS.url;
  if (signals.includes('jsonld-url') || signals.includes('jsonld-name')) score += GROUP_WEIGHTS.jsonld;
  if (signals.includes('logo-dev')) score += GROUP_WEIGHTS.provider;
  if (signals.includes('brandfetch')) score += GROUP_WEIGHTS.provider;
  if (signals.includes('logo-dev') && signals.includes('brandfetch') && options.providersAgree) {
    score += PROVIDER_AGREEMENT_BONUS;
  }
  if (signals.includes('page-title') || signals.includes('opengraph')) score += GROUP_WEIGHTS.metadata;
  return { domain, score: Math.min(score, MAX_SCORE), signals, evidenceIds, rejected: false };
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
  if (best.score >= ICON_LLM_BAND_MINIMUM || closeCompetition) {
    return {
      outcome: 'llm-review', scores, selectedDomain: best.domain, selectedScore: best.score,
      ...(runnerUp ? { runnerUpScore: runnerUp.score } : {}),
      reason: closeCompetition && best.score < ICON_LLM_BAND_MINIMUM
        ? `Two candidates within ${ICON_AUTO_RESOLVE_MARGIN} of each other`
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
  if (decision.confidence < ICON_LLM_MINIMUM_CONFIDENCE) return { accepted: false, reasonCode: 'confidence-below-floor' };
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
  return { accepted: true, domain: selected.domain, reasonCode: 'accepted' };
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
