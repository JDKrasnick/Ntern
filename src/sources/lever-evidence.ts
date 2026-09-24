/**
 * Lever ownership evidence.
 *
 * Greenhouse can admit a board on the strength of a name the API returned.
 * Lever has no such field, so admission here rests on one thing only: a page the
 * employer controls that links to `jobs.lever.co/{site}`. `evidenceExcerpt`
 * records either the markup that proved it or an explicit owner attestation
 * after a browser review, preserving the human approval trail.
 *
 * The states below are the agent's whole vocabulary. `api-live-unattributed` is
 * deliberately absent from the admissible set: a live API response is never
 * ownership evidence, no matter how healthy the board looks.
 */
import { validateLeverSite, LEVER_APPLICATION_HOST } from './lever-ledger.js';
import type { ReviewedLeverSource } from './lever-config.js';
import { registrableDomain } from '../core/registrable-domain.js';

export type LeverOwnershipState =
  | 'ownership-verified'
  | 'api-live-unattributed'
  | 'ambiguous-owner'
  | 'subsidiary-or-regional'
  | 'custom-host-review'
  | 'stale-or-reassigned'
  | 'inconclusive';

export const LEVER_OWNERSHIP_STATES: readonly LeverOwnershipState[] = [
  'ownership-verified',
  'api-live-unattributed',
  'ambiguous-owner',
  'subsidiary-or-regional',
  'custom-host-review',
  'stale-or-reassigned',
  'inconclusive',
];

export const LEVER_ADMISSIBLE_OWNERSHIP_STATES: readonly LeverOwnershipState[] = ['ownership-verified'];

/**
 * Hosts that cannot supply first-party evidence. `lever.co` heads the list: the
 * board's own domain confirms the board exists, which was never the question.
 */
const NON_FIRST_PARTY_HOSTS = [
  'lever.co',
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'simplify.jobs',
  'builtin.com',
  'wellfound.com',
  'angel.co',
  'jobright.ai',
  'ycombinator.com',
  'workatastartup.com',
  'levels.fyi',
  'github.com',
  'githubusercontent.com',
  'web.archive.org',
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'crunchbase.com',
  'glassdoor.co.uk',
];

const MAX_EXCERPT_LENGTH = 2_000;

export interface LeverOwnershipEvidence {
  site: string;
  /** The catalog display name a person will read; taken from the employer, not the API. */
  displayName: string;
  careersUrl: string;
  /** The employer-controlled page that carried the link. Often the same as `careersUrl`. */
  firstPartyEvidenceUrl: string;
  /** The proving markup or explicit owner-browser attestation containing `jobs.lever.co/{site}`. */
  evidenceExcerpt: string;
  observedJobUrl: string;
  initialHosts: string[];
  region: 'global';
  state: LeverOwnershipState;
  verifiedAt: string;
  notes?: string;
}

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function isNonFirstPartyHost(host: string): boolean {
  return NON_FIRST_PARTY_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function postingUrlViolation(url: string, site: string): string | undefined {
  const host = hostOf(url);
  if (!host) return 'observedJobUrl is not an https URL';
  if (host !== LEVER_APPLICATION_HOST) return `observedJobUrl is not on ${LEVER_APPLICATION_HOST}`;
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^/${escaped}/[^/]+(?:/apply)?/?$`).test(new URL(url).pathname)) {
    return `observedJobUrl is not a posting under /${site}`;
  }
  return undefined;
}

/**
 * A site string is a prefix of longer ones, so `jobs.lever.co/cirrus-2` must not
 * satisfy a claim about `cirrus`. The boundary is the whole check.
 */
export function excerptProvesSite(excerpt: string, site: string): boolean {
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`jobs\\.lever\\.co/${escaped}(?![a-z0-9-])`, 'i').test(excerpt);
}

export function evidenceViolations(evidence: LeverOwnershipEvidence): string[] {
  const violations: string[] = [];
  if (!validateLeverSite(evidence.site)) violations.push(`site ${JSON.stringify(evidence.site)} is not a Lever site identifier`);
  if (!LEVER_OWNERSHIP_STATES.includes(evidence.state)) violations.push(`state ${JSON.stringify(evidence.state)} is not a known ownership state`);
  if (!evidence.displayName.trim()) violations.push('displayName is empty');
  if (evidence.region !== 'global') violations.push(`region ${JSON.stringify(evidence.region)} is not recorded as a supported region`);
  if (Number.isNaN(Date.parse(evidence.verifiedAt))) violations.push('verifiedAt is not a parseable timestamp');

  const careersHost = hostOf(evidence.careersUrl);
  const evidenceHost = hostOf(evidence.firstPartyEvidenceUrl);
  if (!careersHost) violations.push('careersUrl is not an https URL');
  else if (isNonFirstPartyHost(careersHost)) violations.push(`careersUrl host ${careersHost} cannot be employer-controlled`);
  if (!evidenceHost) violations.push('firstPartyEvidenceUrl is not an https URL');
  else if (isNonFirstPartyHost(evidenceHost)) violations.push(`firstPartyEvidenceUrl host ${evidenceHost} cannot supply first-party evidence`);
  if (careersHost && evidenceHost && registrableDomain(careersHost) !== registrableDomain(evidenceHost)) {
    violations.push(`firstPartyEvidenceUrl (${evidenceHost}) is not on the same domain as careersUrl (${careersHost})`);
  }

  // A record that claims ownership must carry the markup that proved it. A record
  // that does not claim ownership has no such markup by definition — that absence
  // is the finding — so it owes a reproducible reason instead.
  const claimsOwnership = evidence.state === 'ownership-verified';
  if (!evidence.evidenceExcerpt?.trim()) {
    if (claimsOwnership) violations.push('evidenceExcerpt is empty');
    else if (!evidence.notes?.trim()) violations.push(`state ${evidence.state} carries neither an evidenceExcerpt nor notes explaining it`);
  } else if (evidence.evidenceExcerpt.length > MAX_EXCERPT_LENGTH) {
    violations.push(`evidenceExcerpt exceeds ${MAX_EXCERPT_LENGTH} characters`);
  } else if (!excerptProvesSite(evidence.evidenceExcerpt, evidence.site)) {
    violations.push(`evidenceExcerpt does not contain jobs.lever.co/${evidence.site}`);
  }

  const postingViolation = postingUrlViolation(evidence.observedJobUrl, evidence.site);
  if (postingViolation) violations.push(postingViolation);

  if (!evidence.initialHosts.length) violations.push('initialHosts is empty');
  const unexpectedHosts = evidence.initialHosts.filter((host) => host.toLowerCase() !== LEVER_APPLICATION_HOST);
  if (unexpectedHosts.length && evidence.state !== 'custom-host-review') {
    violations.push(`initialHosts leave ${LEVER_APPLICATION_HOST} (${unexpectedHosts.join(', ')}) without state custom-host-review`);
  }
  return violations;
}

export function admissibleLeverEvidence(evidence: LeverOwnershipEvidence): boolean {
  return LEVER_ADMISSIBLE_OWNERSHIP_STATES.includes(evidence.state) && evidenceViolations(evidence).length === 0;
}

/**
 * Admission enters the registry as `shadow`, never `published`: an evidence
 * record establishes who owns the board, not that the board behaves.
 */
export function reviewedSourceFromEvidence(evidence: LeverOwnershipEvidence): ReviewedLeverSource {
  const violations = evidenceViolations(evidence);
  if (violations.length) throw new Error(`Lever evidence for ${evidence.site} is invalid: ${violations.join('; ')}`);
  if (!LEVER_ADMISSIBLE_OWNERSHIP_STATES.includes(evidence.state)) {
    throw new Error(`Lever evidence for ${evidence.site} is in state ${evidence.state}, which is never admissible`);
  }
  return {
    id: `lever-${evidence.site}`,
    company: evidence.displayName,
    site: evidence.site,
    careersUrl: evidence.careersUrl,
    admittedAt: evidence.verifiedAt,
    status: 'shadow',
    region: evidence.region,
    evidenceStatus: 'agent-verified',
  };
}
