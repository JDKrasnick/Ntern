import type { SourceCheckpoint, SourceFetchResult } from '../types.js';
import { reviewedGreenhouseSources, type ReviewedGreenhouseSource } from './greenhouse-config.js';
import { reviewedLeverSources, type ReviewedLeverSource } from './lever-config.js';

export type SourceClass = 'curated' | 'lever' | 'greenhouse' | 'ashby' | 'smartrecruiters';

export interface SourceQualityPolicy {
  id: string;
  sourceClass: SourceClass;
  /** Sources announced as dormant are checked for URL policy but exempt from row-count drift. */
  dormant?: boolean;
  leverSite?: string;
  /** Reviewed application hosts a verified Greenhouse board's roles may use. */
  greenhouseAllowedHosts?: string[];
  /** Curated lists should represent the market, not a single mirror/ATS. */
  minimumDistinctApplicationHosts?: number;
  maximumApplicationHostShare?: number;
}

export interface SourceQualityInput {
  policy: SourceQualityPolicy;
  result: Pick<SourceFetchResult, 'sourceId' | 'listings' | 'notModified' | 'rejectedApplicationUrls' | 'rawRowCount'>;
  previous?: SourceCheckpoint;
}

export interface SourceQualityRowReport {
  sourceId: string;
  rowCount: number;
  openRoleCount: number;
  hostDistribution: Record<string, number>;
  rejectedUrls: Array<{ row: number; url: string; reason: string }>;
  policyFailures: string[];
}

export interface SourceQualityReport {
  generatedAt: string;
  sources: SourceQualityRowReport[];
  failures: string[];
}

const aggregatorHosts = new Set([
  'linkedin.com', 'www.linkedin.com', 'indeed.com', 'www.indeed.com', 'glassdoor.com', 'www.glassdoor.com',
  'simplify.jobs', 'www.simplify.jobs', 'handshake.com', 'www.joinhandshake.com', 'ziprecruiter.com', 'www.ziprecruiter.com'
]);

function host(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

export function applicationUrlRejection(url: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'invalid application URL'; }
  if (parsed.protocol !== 'https:') return 'application URL must use HTTPS';
  if (aggregatorHosts.has(parsed.hostname.toLowerCase())) return `aggregator-only host is not allowed (${parsed.hostname})`;
  return undefined;
}

/**
 * Adapter-facing host gate: baseline policy plus the reviewed board's allowed
 * hosts, so an off-allowlist destination is pre-withheld at the row level rather
 * than left for a separate source-quality pass to discover.
 */
export function greenhouseApplicationUrlRejection(url: string, allowedHosts: string[]): string | undefined {
  const baseline = applicationUrlRejection(url);
  if (baseline) return baseline;
  const { hostname } = new URL(url); // Baseline already confirmed a parseable HTTPS URL.
  if (!hostMatchesAllowlist(hostname, allowedHosts)) return `application host ${hostname} is not a reviewed Greenhouse destination`;
  return undefined;
}

interface UrlFailure {
  reason: string;
  /** A withheld-role result (does not fail the whole source) versus a gate breach. */
  roleLevel: boolean;
}

function urlFailure(url: string, policy: SourceQualityPolicy): UrlFailure | undefined {
  const baselineFailure = applicationUrlRejection(url);
  if (baselineFailure) return { reason: baselineFailure, roleLevel: false };
  const parsed = new URL(url);
  if (policy.sourceClass === 'lever') {
    const expectedPath = new RegExp(`^/${escapeRegExp(policy.leverSite ?? '')}/[^/]+/apply/?$`);
    if (parsed.hostname !== 'jobs.lever.co' || !expectedPath.test(parsed.pathname)) {
      return { reason: `expected direct Lever URL jobs.lever.co/${policy.leverSite}/<posting>/apply`, roleLevel: false };
    }
  }
  if (policy.sourceClass === 'greenhouse') {
    const allowed = policy.greenhouseAllowedHosts ?? [];
    // An off-allowlist Greenhouse destination withholds only that role; the rest
    // of the board's snapshot is still valid, so it is not a source failure.
    if (!hostMatchesAllowlist(parsed.hostname, allowed)) {
      return { reason: `application host ${parsed.hostname} is not a reviewed Greenhouse destination`, roleLevel: true };
    }
  }
  return undefined;
}

/** Exact host or dot-boundary subdomain match; `greenhouse.io.evil.test` never matches `greenhouse.io`. */
function hostMatchesAllowlist(hostname: string, allowedHosts: string[]): boolean {
  const normalized = hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const candidate = allowed.trim().toLowerCase();
    return normalized === candidate || normalized.endsWith(`.${candidate}`);
  });
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function reportFor(input: SourceQualityInput): SourceQualityRowReport {
  const { policy, result, previous } = input;
  const rejectedUrls: SourceQualityRowReport['rejectedUrls'] = [...(result.rejectedApplicationUrls ?? [])];
  const hosts: Record<string, number> = {};
  // Pre-publication URL rejections are expected policy enforcement and remain
  // visible in the report. A URL that survives into listings and violates a
  // role-level host policy is withheld; one that breaches the baseline gate is a
  // source failure.
  const policyFailures: string[] = [];
  for (const listing of result.listings) {
    const applicationHost = host(listing.applyUrl);
    if (applicationHost) hosts[applicationHost] = (hosts[applicationHost] ?? 0) + 1;
    const failure = urlFailure(listing.applyUrl, policy);
    if (!failure) continue;
    rejectedUrls.push({ row: listing.row, url: listing.applyUrl, reason: failure.reason });
    if (!failure.roleLevel) policyFailures.push(`${policy.id}: row ${listing.row}: ${failure.reason}`);
  }
  if (!result.notModified && !policy.dormant && (previous?.successfulFetches ?? 0) > 0 && (previous?.lastRowCount ?? 0) > 0 && (result.rawRowCount ?? result.listings.length) === 0) {
    policyFailures.push(`${policy.id}: suspicious zero-row result after ${previous?.lastRowCount} rows; investigate parser/source drift`);
  }
  if (policy.sourceClass === 'curated' && result.listings.length > 0) {
    const distribution = Object.values(hosts);
    const total = distribution.reduce((sum, count) => sum + count, 0);
    const distinctRequired = policy.minimumDistinctApplicationHosts ?? 2;
    const maxShare = policy.maximumApplicationHostShare ?? 0.85;
    if (Object.keys(hosts).length < distinctRequired) policyFailures.push(`${policy.id}: curated source has ${Object.keys(hosts).length} application host(s); requires ${distinctRequired}`);
    if (total > 0 && Math.max(...distribution) / total > maxShare) policyFailures.push(`${policy.id}: curated source application-host concentration exceeds ${Math.round(maxShare * 100)}%`);
  }
  return { sourceId: result.sourceId, rowCount: result.listings.length, openRoleCount: result.listings.filter((listing) => listing.state === 'open').length, hostDistribution: hosts, rejectedUrls, policyFailures };
}

/** Validates only publisher-bound sources. A discovery artifact must be human-approved before it reaches this API. */
export function verifySourceQuality(inputs: SourceQualityInput[], generatedAt = new Date().toISOString()): SourceQualityReport {
  const sources = inputs.map(reportFor);
  return { generatedAt, sources, failures: sources.flatMap((source) => source.policyFailures) };
}

/** A reviewed Greenhouse board contributes a quality policy only once its adapter is enabled. */
export function greenhouseQualityPolicy(source: ReviewedGreenhouseSource): SourceQualityPolicy {
  return {
    id: source.id,
    sourceClass: 'greenhouse',
    greenhouseAllowedHosts: [...new Set([...source.allowedInitialHosts, ...source.allowedFinalHosts])],
    // An owner-acknowledged empty board is dormant: its zero rows are expected.
    ...(source.emptyBoardAcknowledged ? { dormant: true } : {}),
  };
}

/**
 * Registers a quality policy only for boards whose adapter is enabled in
 * production (`published`). A merely reviewed or shadow board contributes its
 * policy through the shadow-run path, not the catalog-wide static gate.
 */
export function enabledGreenhouseQualityPolicies(
  sources: ReviewedGreenhouseSource[] = reviewedGreenhouseSources,
): SourceQualityPolicy[] {
  return sources.filter((source) => source.status === 'published').map(greenhouseQualityPolicy);
}

/** A reviewed Lever board contributes a policy keyed to its reviewed site. */
export function leverQualityPolicy(source: ReviewedLeverSource): SourceQualityPolicy {
  return {
    id: source.id,
    sourceClass: 'lever',
    leverSite: source.site,
    // An owner-acknowledged empty board is dormant: its zero rows are expected.
    ...(source.emptyBoardAcknowledged ? { dormant: true } : {}),
  };
}

export const sourceQualityPolicies: SourceQualityPolicy[] = [
  ...enabledGreenhouseQualityPolicies(),
  { id: 'vanshb03-summer-2027', sourceClass: 'curated' },
  { id: 'simplify-summer-2026', sourceClass: 'curated' },
  { id: 'zapply-2027', sourceClass: 'curated' },
  { id: 'speedyapply-2027-swe', sourceClass: 'curated' },
  { id: 'speedyapply-2027-ai', sourceClass: 'curated' },
  { id: 'northwestern-fintech-2027-quant', sourceClass: 'curated' },
  { id: 'canadian-tech-2027', sourceClass: 'curated' },
  ...reviewedLeverSources.map(leverQualityPolicy),
];

export function qualityPolicyFor(sourceId: string): SourceQualityPolicy {
  const policy = sourceQualityPolicies.find((candidate) => candidate.id === sourceId);
  // Test and one-off injected adapters still receive transport/zero-row checks.
  // Production adapters must be explicitly present in sourceQualityPolicies.
  return policy ?? { id: sourceId, sourceClass: 'curated', minimumDistinctApplicationHosts: 1, maximumApplicationHostShare: 1 };
}

/** A declared dormant source may be unavailable without making the live CI audit fail. */
export function liveSourceFetchFailure(policy: SourceQualityPolicy, error: unknown): string | undefined {
  if (policy.dormant) return undefined;
  return `${policy.id}: live fetch failed after retries: ${error instanceof Error ? error.message : String(error)}`;
}

/** Shared runtime guard so sources cannot silently accept a parser-zero regression. */
export function sourceQualityFailures(
  result: SourceFetchResult,
  previous: SourceCheckpoint | undefined,
  options: { allowCompleteEmptySnapshot?: boolean } = {},
): string[] {
  if (options.allowCompleteEmptySnapshot && !result.notModified
    && (result.rawRowCount ?? result.listings.length) === 0) return [];
  const configuredPolicy = sourceQualityPolicies.find((candidate) => candidate.id === result.sourceId);
  // Test adapters and one-off integrations are processed row-by-row by the
  // poller.  Applying the catalog-wide URL policy to those inputs here would
  // discard otherwise valid rows when a single listing is malformed.
  if (!configuredPolicy) {
    return !result.notModified && (previous?.successfulFetches ?? 0) > 0 && (previous?.lastRowCount ?? 0) > 0 && (result.rawRowCount ?? result.listings.length) === 0
      ? [`${result.sourceId}: suspicious zero-row result after ${previous?.lastRowCount ?? 0} rows; investigate parser/source drift`]
      : [];
  }
  return verifySourceQuality([{ policy: configuredPolicy, result, previous }]).failures;
}
