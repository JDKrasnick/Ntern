import type { ProviderPostingEvidence } from '../types.js';
import { hostMatchesAllowlist, reviewedGreenhouseSources } from '../sources/greenhouse-config.js';
import { reviewedLeverSources } from '../sources/lever-config.js';
import { customGreenhouseReference, providerPostingReference, type ProviderPostingReference } from './posting.js';

export interface ReviewedProviderReference extends ProviderPostingReference {
  provider: 'greenhouse' | 'lever';
  tenant: string;
  postingId: string;
  sourceId: string;
  customHost: boolean;
}

function greenhouseSource(sourceId: string) {
  return reviewedGreenhouseSources.find((source) => source.id === sourceId);
}

function leverSource(sourceId: string) {
  return reviewedLeverSources.find((source) => source.id === sourceId);
}

/** Rejects forged or stale evidence before it can mint a provider alias. */
export function reviewedProviderEvidenceError(evidence: ProviderPostingEvidence): string | undefined {
  if (!evidence.postingId.trim() || !evidence.tenant.trim() || !evidence.sourceId.trim()) return 'provider evidence is incomplete';
  if (evidence.provider === 'greenhouse') {
    const source = greenhouseSource(evidence.sourceId);
    if (source && source.boardToken.toLowerCase() !== evidence.tenant.toLowerCase()) return 'Greenhouse evidence disagrees with the reviewed source';
    if (!source && evidence.sourceId !== `greenhouse-${evidence.tenant.toLowerCase()}`) return 'Greenhouse evidence disagrees with the reviewed source';
    if (!/^\d+$/.test(evidence.postingId)) return 'Greenhouse public posting ID is invalid';
    return undefined;
  }
  const source = leverSource(evidence.sourceId);
  if (source && source.site.toLowerCase() !== evidence.tenant.toLowerCase()) return 'Lever evidence disagrees with the reviewed source';
  if (!source && !evidence.sourceId.startsWith('lever-')) return 'Lever evidence disagrees with the reviewed source';
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(evidence.postingId)) {
    return 'Lever posting UUID is invalid';
  }
  return undefined;
}

function customGreenhousePostingId(url: URL): { postingId?: string; conflict?: boolean } {
  const queryId = url.searchParams.get('gh_jid');
  const pathIds = [...url.pathname.matchAll(/(?:^|[-/])(\d{5,})(?=\/|$)/g)].map((match) => match[1]!);
  const ids = new Set([...(queryId && /^\d+$/.test(queryId) ? [queryId] : []), ...pathIds]);
  if (ids.size > 1) return { conflict: true };
  return { postingId: [...ids][0] };
}

export type ReviewedProviderUrlResult =
  | { outcome: 'match'; reference: ReviewedProviderReference }
  | { outcome: 'none' }
  | { outcome: 'conflict'; reason: string };

/**
 * Parses only routes whose board/site ownership is checked in. Custom
 * Greenhouse hosts must map to exactly one source; callers must additionally
 * confirm the returned public ID against that source's active checkpoint.
 */
export function reviewedProviderUrlReference(input: string): ReviewedProviderUrlResult {
  let url: URL;
  try { url = new URL(input); } catch { return { outcome: 'none' }; }
  const inputHost = url.hostname.toLowerCase().replace(/^www\./, '');
  const syntactic = providerPostingReference(input);
  if (syntactic.provider === 'greenhouse' && syntactic.tenant && syntactic.postingId) {
    const source = reviewedGreenhouseSources.find((candidate) => candidate.boardToken.toLowerCase() === syntactic.tenant);
    return source ? { outcome: 'match', reference: {
      ...syntactic, provider: 'greenhouse', tenant: syntactic.tenant, postingId: syntactic.postingId,
      sourceId: source.id, customHost: !hostMatchesAllowlist(inputHost, ['greenhouse.io']),
    } } : { outcome: 'none' };
  }
  if (syntactic.provider === 'lever' && syntactic.tenant && syntactic.postingId) {
    const source = reviewedLeverSources.find((candidate) => candidate.site.toLowerCase() === syntactic.tenant);
    return source ? { outcome: 'match', reference: {
      ...syntactic, provider: 'lever', tenant: syntactic.tenant, postingId: syntactic.postingId,
      sourceId: source.id, customHost: false,
    } } : { outcome: 'none' };
  }

  const host = inputHost;
  const sources = reviewedGreenhouseSources.filter((source) =>
    [...source.allowedInitialHosts, ...source.allowedFinalHosts]
      .filter((allowed) => !hostMatchesAllowlist(allowed, ['greenhouse.io']))
      .some((allowed) => hostMatchesAllowlist(host, [allowed])),
  );
  if (sources.length !== 1) return { outcome: 'none' };
  const candidate = customGreenhouseReference(url, host);
  const id = candidate?.postingId
    ? { postingId: candidate.postingId }
    : customGreenhousePostingId(url);
  if (id.conflict) return { outcome: 'conflict', reason: 'custom Greenhouse URL contains disagreeing public IDs' };
  if (!id.postingId) return { outcome: 'none' };
  const source = sources[0]!;
  return { outcome: 'match', reference: {
    provider: 'greenhouse', tenant: source.boardToken.toLowerCase(), postingId: id.postingId,
    sourceId: source.id, customHost: true,
  } };
}

/** Provider evidence reconstructed from an occurrence emitted by a reviewed connector. */
export function providerEvidenceForOccurrence(sourceId: string, externalId: string, urls: string[] = []): ProviderPostingEvidence | undefined {
  const greenhouse = greenhouseSource(sourceId);
  if (greenhouse && /^\d+$/.test(externalId)) return {
    provider: 'greenhouse', tenant: greenhouse.boardToken.toLowerCase(), postingId: externalId,
    sourceId, urls,
  };
  const lever = leverSource(sourceId);
  if (lever && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(externalId)) return {
    provider: 'lever', tenant: lever.site.toLowerCase(), postingId: externalId.toLowerCase(), sourceId, urls,
  };
  return undefined;
}

/** Extracts an immutable public ID from Greenhouse's tenant-less embed route. */
export function unscopedGreenhouseEmbedPostingId(input: string): string | undefined {
  let url: URL;
  try { url = new URL(input); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if ((host !== 'boards.greenhouse.io' && host !== 'job-boards.greenhouse.io')
      || !/^\/embed\/job_app\/?$/i.test(url.pathname)) return undefined;
  const postingId = url.searchParams.get('token');
  return postingId && /^\d+$/.test(postingId) ? postingId : undefined;
}

/** Returns evidence only when an active public ID belongs to one reviewed board. */
export function uniqueGreenhouseEvidenceForSources(
  postingId: string,
  sourceIds: Iterable<string>,
  urls: string[] = [],
): ProviderPostingEvidence | undefined {
  const matches = [...sourceIds].flatMap((sourceId) => {
    const evidence = providerEvidenceForOccurrence(sourceId, postingId, urls);
    return evidence?.provider === 'greenhouse' ? [evidence] : [];
  });
  const unique = [...new Map(matches.map((item) => [`${item.provider}:${item.tenant.toLowerCase()}:${item.postingId}`, item])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

/** Exact aliases emitted by Greenhouse for an otherwise tenant-less embed. */
export function unscopedGreenhouseEmbedUrls(postingId: string): string[] {
  if (!/^\d+$/.test(postingId)) return [];
  return [
    `https://boards.greenhouse.io/embed/job_app?token=${postingId}`,
    `https://job-boards.greenhouse.io/embed/job_app?token=${postingId}`,
  ];
}
