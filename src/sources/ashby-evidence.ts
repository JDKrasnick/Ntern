import { ASHBY_JOB_HOST, ashbyBoardNameFromUrl, validateAshbyBoardName } from './ashby-ledger.js';
import type { EmployerCareersEvidence, ReviewedApplicationHost, ReviewedSourceRecord } from './reviewed-source.js';

export const ASHBY_ADMISSIBLE_EVIDENCE_STATES = ['ownership-verified'] as const;
const BLOCKED_EVIDENCE_HOSTS = [
  'ashbyhq.com', 'linkedin.com', 'indeed.com', 'glassdoor.com', 'simplify.jobs', 'builtin.com',
  'wellfound.com', 'ycombinator.com', 'workatastartup.com', 'github.com', 'web.archive.org',
  'google.com', 'bing.com', 'duckduckgo.com',
];
const MAX_EXCERPT_LENGTH = 2_000;

export interface AshbyOwnershipEvidence extends EmployerCareersEvidence {
  provider: 'ashby';
  apiRegion: 'global';
  initialTechnicalEarlyCareerRoles: number;
  /** Explicit owner approval for a proven board whose known role is currently unlisted in the board API. */
  initialRoleRequirementOverride?: {
    approvedBy: string;
    approvedAt: string;
    reason: string;
  };
  allowedApplicationHosts: ReviewedApplicationHost[];
}

function httpsHost(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
}

function sameHostOrSubdomain(left: string, right: string): boolean {
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function blocked(host: string): boolean {
  return BLOCKED_EVIDENCE_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

export function excerptProvesAshbyBoard(excerpt: string, boardName: string): boolean {
  const escaped = boardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`jobs\\.ashbyhq\\.com/${escaped}(?:[/?#"'\\s<]|$)`, 'i').test(excerpt);
}

export function ashbyEvidenceViolations(evidence: AshbyOwnershipEvidence): string[] {
  const violations: string[] = [];
  if (evidence.provider !== 'ashby') violations.push('provider is not ashby');
  if (!validateAshbyBoardName(evidence.boardKey)) violations.push(`boardKey ${JSON.stringify(evidence.boardKey)} is invalid`);
  if (evidence.apiRegion !== 'global') violations.push('apiRegion must be global');
  const roleOverride = evidence.initialRoleRequirementOverride;
  if (!Number.isInteger(evidence.initialTechnicalEarlyCareerRoles) || evidence.initialTechnicalEarlyCareerRoles < 0) {
    violations.push('initial technical early-career role count must be a non-negative integer');
  } else if (evidence.initialTechnicalEarlyCareerRoles < 1 && !roleOverride) {
    violations.push('initial admission requires at least one technical early-career role');
  }
  if (roleOverride) {
    if (!roleOverride.approvedBy.trim()) violations.push('initial-role override lacks approver');
    if (Number.isNaN(Date.parse(roleOverride.approvedAt))) violations.push('initial-role override approvedAt is invalid');
    if (!roleOverride.reason.trim()) violations.push('initial-role override lacks a reason');
  }
  if (Number.isNaN(Date.parse(evidence.verifiedAt))) violations.push('verifiedAt is not a parseable timestamp');
  const careersHost = httpsHost(evidence.careersUrl);
  const evidenceHost = httpsHost(evidence.firstPartyEvidenceUrl);
  if (!careersHost || blocked(careersHost)) violations.push('careersUrl is not an employer-controlled HTTPS URL');
  if (!evidenceHost || blocked(evidenceHost)) violations.push('firstPartyEvidenceUrl is not an employer-controlled HTTPS URL');
  if (careersHost && evidenceHost && !sameHostOrSubdomain(careersHost, evidenceHost)) {
    violations.push('firstPartyEvidenceUrl is not on the same employer domain as careersUrl');
  }
  if (ashbyBoardNameFromUrl(evidence.exactBoardUrl) !== evidence.boardKey) violations.push('exactBoardUrl does not identify boardKey');
  if (ashbyBoardNameFromUrl(evidence.observedJobUrl) !== evidence.boardKey) violations.push('observedJobUrl does not identify boardKey');
  if (!evidence.evidenceExcerpt.trim()) violations.push('evidenceExcerpt is empty');
  else if (evidence.evidenceExcerpt.length > MAX_EXCERPT_LENGTH) violations.push(`evidenceExcerpt exceeds ${MAX_EXCERPT_LENGTH} characters`);
  else if (!excerptProvesAshbyBoard(evidence.evidenceExcerpt, evidence.boardKey)) violations.push('evidenceExcerpt does not contain the exact Ashby board link');
  else if (!evidence.evidenceExcerpt.includes(evidence.exactBoardUrl)) violations.push('evidenceExcerpt does not contain exactBoardUrl verbatim');
  if (!evidence.allowedApplicationHosts.length) violations.push('allowedApplicationHosts is empty');
  const seen = new Set<string>();
  for (const entry of evidence.allowedApplicationHosts) {
    const host = entry.host.trim().toLowerCase();
    if (!host || seen.has(host)) violations.push(`application host ${JSON.stringify(entry.host)} is empty or duplicated`);
    if (entry.host !== host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.')) {
      violations.push(`application host ${JSON.stringify(entry.host)} is not a normalized hostname`);
    }
    seen.add(host);
    if (host !== ASHBY_JOB_HOST && (!entry.justification?.trim() || Number.isNaN(Date.parse(entry.reviewedAt ?? '')))) {
      violations.push(`external application host ${host} lacks human-reviewed justification and timestamp`);
    }
  }
  if (!seen.has(ASHBY_JOB_HOST)) violations.push(`allowedApplicationHosts must include ${ASHBY_JOB_HOST}`);
  if (evidence.state !== 'ownership-verified') violations.push(`evidence state ${evidence.state} is not admissible`);
  return violations;
}

export function reviewedAshbySourceFromEvidence(evidence: AshbyOwnershipEvidence, company: string): ReviewedSourceRecord {
  const violations = ashbyEvidenceViolations(evidence);
  if (violations.length) throw new Error(`Ashby evidence for ${evidence.boardKey} is invalid: ${violations.join('; ')}`);
  return {
    id: `ashby-${evidence.boardKey.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    company,
    identity: { provider: 'ashby', boardKey: evidence.boardKey, apiRegion: evidence.apiRegion },
    careersUrl: evidence.careersUrl,
    admittedAt: evidence.verifiedAt,
    evidenceState: evidence.state,
    allowedApplicationHosts: evidence.allowedApplicationHosts,
    status: 'shadow',
  };
}
