import { createHash } from 'node:crypto';
import type { Internship, PostingAlias, PostingIdentity, PostingProvider, ProviderPostingEvidence } from '../types.js';

/** Referral parameters community feeds and campaigns append; none selects a posting. */
const TRACKING_PARAMETERS: Record<string, true> = {
  fbclid: true, gclid: true, gh_src: true, mc_cid: true, mc_eid: true, ref: true, source: true,
  utm_source: true, utm_medium: true, utm_campaign: true, utm_term: true, utm_content: true,
};

/**
 * Case-insensitive referral/tracking parameter test. `utm_` is a whole family
 * rather than a fixed list, so it matches by prefix.
 */
export function isApplicationTrackingParameter(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACKING_PARAMETERS[lower] === true || lower.startsWith('utm_');
}

function withoutTrailingSlash(pathname: string): string {
  return pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
}

/** Canonicalizes only syntax and reviewed provider presentation variants. */
export function canonicalizePostingUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Posting URL must use HTTP or HTTPS');
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (isApplicationTrackingParameter(key)) url.searchParams.delete(key);
  }

  const host = url.hostname.replace(/^www\./, '');
  let match: RegExpExecArray | null;
  if (host === 'jobs.ashbyhq.com' && (match = /^\/([^/]+)\/([^/]+)(?:\/application)?\/?$/i.exec(url.pathname))) {
    url.pathname = `/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
    url.searchParams.delete('embed');
  } else if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io')
      && (match = /^\/([^/]+)\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    url.hostname = 'job-boards.greenhouse.io';
    url.pathname = `/${match[1]!.toLowerCase()}/jobs/${match[2]}`;
    if (url.searchParams.get('gh_jid') === match[2]) url.searchParams.delete('gh_jid');
  } else if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io')
      && /^\d+$/.test(url.searchParams.get('gh_jid') ?? '')
      && (match = /^\/([^/]+)\/?$/i.exec(url.pathname))) {
    const postingId = url.searchParams.get('gh_jid')!;
    url.hostname = 'job-boards.greenhouse.io';
    url.pathname = `/${match[1]!.toLowerCase()}/jobs/${postingId}`;
    url.searchParams.delete('gh_jid');
  } else {
    url.pathname = withoutTrailingSlash(url.pathname);
  }
  url.searchParams.sort();
  return url.toString().replace(/\/$/, '');
}

export interface ProviderPostingReference {
  provider: PostingProvider;
  tenant?: string;
  postingId?: string;
}

/** Extracts immutable IDs only from reviewed routes. */
export function providerPostingReference(input: string): ProviderPostingReference {
  const url = new URL(canonicalizePostingUrl(input));
  const host = url.hostname.replace(/^www\./, '');
  let match: RegExpExecArray | null;
  if ((host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io') && (match = /^\/([^/]+)\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'greenhouse', tenant: match[1]!.toLowerCase(), postingId: match[2] };
  }
  if (host === 'jobs.lever.co' && (match = /^\/([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/apply)?\/?$/i.exec(url.pathname))) {
    return { provider: 'lever', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if (host === 'jobs.ashbyhq.com' && (match = /^\/([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/application)?\/?$/i.exec(url.pathname))) {
    return { provider: 'ashby', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if ((host === 'lifeattiktok.com' || host === 'joinbytedance.com') && (match = /^\/(?:search|position)\/(\d+)(?:\/detail)?\/?$/i.exec(url.pathname))) {
    return { provider: 'bytedance', tenant: 'bytedance', postingId: match[1] };
  }
  if (host === 'jobs.bytedance.com' && (match = /^\/[a-z-]+\/position\/(\d+)(?:\/detail)?\/?$/i.exec(url.pathname))) {
    return { provider: 'bytedance', tenant: 'bytedance', postingId: match[1] };
  }
  if (host.endsWith('.myworkdayjobs.com') && (match = /_([^/_]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'workday', tenant: host.split('.')[0]!.toLowerCase(), postingId: match[1]!.toLowerCase() };
  }
  if (host === 'tesla.com'
      && (match = /^(?:\/[a-z]{2}(?:_[a-z]{2})?)?\/careers\/search\/job\/(?:[^/]*-)?(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'tesla', tenant: 'tesla', postingId: match[1] };
  }
  if (host === 'metacareers.com'
      && (match = /^\/(?:jobs|profile\/job_details)\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'meta', tenant: 'meta', postingId: match[1] };
  }
  if (host === 'janestreet.com'
      && (match = /^\/join-jane-street\/(?:position|apply)\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'janestreet', tenant: 'janestreet', postingId: match[1] };
  }
  if (host === 'higher.gs.com' && (match = /^\/roles\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'goldman-sachs', tenant: 'goldman-sachs', postingId: match[1] };
  }
  if (host === 'imc.com' && (match = /^\/[a-z]{2}\/careers\/jobs\/(\d+)\/?$/i.exec(url.pathname))) {
    return { provider: 'imc', tenant: 'imc', postingId: match[1] };
  }
  if (host === 'jobs.smartrecruiters.com' && (match = /^\/([^/]+)\/([a-z0-9]+)\/?$/i.exec(url.pathname))) {
    return { provider: 'smartrecruiters', tenant: match[1]!.toLowerCase(), postingId: match[2]!.toLowerCase() };
  }
  if (host.endsWith('.icims.com') && (match = /^\/jobs\/(\d+)(?:\/[^/]*)?\/job\/?$/i.exec(url.pathname))) {
    return { provider: 'icims', tenant: host.slice(0, -'.icims.com'.length), postingId: match[1] };
  }
  if (host.endsWith('.oraclecloud.com')
      && (match = /^\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/([^/]+)\/job\/(\d+)\/?$/i.exec(url.pathname))) {
    // The candidate-experience site scopes the id: one pod can carry the same
    // posting id under two sites, so the scope is host plus site.
    return { provider: 'oracle', tenant: `${host}/${match[1]!.toLowerCase()}`, postingId: match[2]! };
  }
  return { provider: 'unknown' };
}

export function providerPostingAlias(reference: ProviderPostingReference): string | undefined {
  if (!reference.postingId || reference.provider === 'unknown') return undefined;
  return `provider:${reference.provider}:${reference.tenant ?? '-'}:${reference.postingId}`;
}

export function exactPostingKey(input: string): string {
  const canonicalUrl = canonicalizePostingUrl(input);
  return providerPostingAlias(providerPostingReference(canonicalUrl)) ?? `url:${canonicalUrl}`;
}

export function stableCanonicalJobId(exactKey: string): string {
  return createHash('sha256').update(`posting-v1:${exactKey}`).digest('hex').slice(0, 32);
}

export interface BuildPostingIdentityInput {
  applicationUrl: string;
  observedUrls?: string[];
  finalOfficialUrl?: string;
  /** Strongest evidence: immutable fields carried directly from a reviewed provider row. */
  providerEvidence?: ProviderPostingEvidence;
  /** Provider references already checked against a reviewed registry/checkpoint. */
  reviewedProviderReferences?: ProviderPostingReference[];
  employerId?: string;
  employerRequisitionId?: string;
  employerRequisitionAuthoritative?: boolean;
}

function alias(kind: PostingAlias['kind'], value: string, sourceUrl?: string): PostingAlias {
  return sourceUrl ? { kind, value, sourceUrl } : { kind, value };
}

export function buildPostingIdentity(input: BuildPostingIdentityInput): PostingIdentity {
  const urls = [
    input.applicationUrl,
    ...(input.providerEvidence?.urls ?? []),
    ...(input.observedUrls ?? []),
    ...(input.finalOfficialUrl ? [input.finalOfficialUrl] : []),
  ];
  const canonicalApplicationUrl = canonicalizePostingUrl(input.finalOfficialUrl ?? input.applicationUrl);
  const explicitReference = input.providerEvidence ? {
    provider: input.providerEvidence.provider,
    tenant: input.providerEvidence.tenant.toLowerCase(),
    postingId: input.providerEvidence.postingId.toLowerCase(),
  } satisfies ProviderPostingReference : undefined;
  // Provider routes in URLs are scoped provider-owned keys and are claimed like
  // any other exact reference; `resolvePostingAliases` and the registry both
  // quarantine reference sets that disagree on scope or name two ids.
  const exactRouteReferences = urls.map(providerPostingReference);
  const references = [explicitReference, ...(input.reviewedProviderReferences ?? []), ...exactRouteReferences]
    .filter((candidate): candidate is ProviderPostingReference => Boolean(candidate?.postingId));
  const reference = references[0] ?? { provider: 'unknown' as const };
  const aliases: PostingAlias[] = [];
  for (const url of urls) {
    const canonicalUrl = canonicalizePostingUrl(url);
    aliases.push(alias(url === input.finalOfficialUrl ? 'official-url' : 'application-url', `url:${canonicalUrl}`, url));
  }
  for (const candidate of references) {
    const providerAlias = providerPostingAlias(candidate);
    if (providerAlias) aliases.push(alias('provider-route', providerAlias));
  }
  const primaryProviderAlias = providerPostingAlias(reference);
  if (primaryProviderAlias) aliases.push(alias('provider-posting', primaryProviderAlias));
  if (input.employerRequisitionAuthoritative && input.employerRequisitionId && input.employerId) {
    aliases.push(alias('employer-requisition', `requisition:${input.employerId}:${input.employerRequisitionId.trim().toLowerCase()}`));
  }
  const uniqueAliases = [...new Map(aliases.map((item) => [`${item.kind}:${item.value}`, item])).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value));
  const exactKey = primaryProviderAlias
    ?? uniqueAliases.find((item) => item.kind === 'employer-requisition')?.value
    ?? `url:${canonicalApplicationUrl}`;
  return {
    provider: reference.provider,
    ...(reference.tenant ? { tenant: reference.tenant } : {}),
    ...(reference.postingId ? { providerPostingId: reference.postingId } : {}),
    ...(input.employerRequisitionId ? { employerRequisitionId: input.employerRequisitionId } : {}),
    ...(input.employerRequisitionAuthoritative !== undefined ? { employerRequisitionAuthoritative: input.employerRequisitionAuthoritative } : {}),
    canonicalApplicationUrl,
    aliases: uniqueAliases,
    canonicalJobId: stableCanonicalJobId(exactKey),
  };
}

export type AliasResolution =
  | { outcome: 'create'; canonicalJobId: string; aliases: string[] }
  | { outcome: 'merge'; canonicalJobId: string; aliases: string[] }
  | {
      outcome: 'quarantine';
      aliases: string[];
      conflictingCanonicalJobIds: string[];
      reason:
        | 'aliases-resolve-to-different-jobs'
        | 'multiple-immutable-provider-postings'
        | 'provider-scope-mismatch'
        | 'employer-scope-mismatch'
        | 'multiple-authoritative-requisitions';
    };

/** Pure decision used before an atomic alias-registry transaction. */
export function resolvePostingAliases(identity: PostingIdentity, claims: ReadonlyMap<string, string>): AliasResolution {
  const aliases = [...new Set(identity.aliases.map((item) => item.value))].sort();
  const providerPostingGroups = new Map<string, Set<string>>();
  for (const value of aliases.filter((item) => item.startsWith('provider:'))) {
    const [, provider, tenant, postingId] = value.split(':');
    if (!provider || !tenant || !postingId) continue;
    const group = `${provider}:${tenant}`;
    const ids = providerPostingGroups.get(group) ?? new Set<string>();
    ids.add(postingId);
    providerPostingGroups.set(group, ids);
  }
  if (providerPostingGroups.size > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'provider-scope-mismatch' };
  }
  if ([...providerPostingGroups.values()].some((ids) => ids.size > 1)) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'multiple-immutable-provider-postings' };
  }
  const requisitions = aliases.filter((value) => value.startsWith('requisition:'))
    .map((value) => value.split(':')).filter((parts) => parts[1] && parts[2]);
  const requisitionEmployers = new Set(requisitions.map((parts) => parts[1]!));
  if (requisitionEmployers.size > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'employer-scope-mismatch' };
  }
  if (new Set(requisitions.map((parts) => `${parts[1]}:${parts[2]}`)).size > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [], reason: 'multiple-authoritative-requisitions' };
  }
  const claimedIds = [...new Set(aliases.map((item) => claims.get(item)).filter((item): item is string => Boolean(item)))].sort();
  if (claimedIds.length > 1) {
    return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: claimedIds, reason: 'aliases-resolve-to-different-jobs' };
  }
  if (claimedIds.length === 1) return { outcome: 'merge', canonicalJobId: claimedIds[0]!, aliases };
  return { outcome: 'create', canonicalJobId: identity.canonicalJobId, aliases };
}

/** Prevents a caller-provided lookup hint from bridging two reviewed exact IDs. */
export function preferredJobIdentityConflicts(identity: PostingIdentity, job: Internship | undefined): boolean {
  if (!job) return false;
  const incoming = new Set(identity.aliases.map((alias) => alias.value));
  const confirmed = new Set(job.sourceReferences.flatMap((reference) =>
    reference.postingIdentityDecision?.status === 'confirmed' ? [reference.postingIdentityDecision.exactKey] : []));
  if (job.postingIdentityStatus === 'confirmed') {
    for (const alias of job.postingIdentity?.aliases ?? []) {
      if (alias.value.startsWith('provider:') || alias.value.startsWith('requisition:')) confirmed.add(alias.value);
    }
    // A confirmed URL-only identity can only have been created by the reviewed
    // canonical-URL contract. Provider-backed jobs also compare their claimed
    // provider reference, which now includes scoped provider routes.
    if (!confirmed.size && job.postingIdentity?.provider === 'unknown') {
      for (const alias of job.postingIdentity.aliases) confirmed.add(alias.value);
    }
  }
  return confirmed.size > 0 && ![...confirmed].some((exactKey) => incoming.has(exactKey));
}
