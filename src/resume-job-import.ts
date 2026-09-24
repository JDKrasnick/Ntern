import { metadataApiRoute, parseMetadataApiResponse, type MetadataAcquisition } from './metadata-acquisition.js';
import { providerPostingReference } from './identity/posting.js';
import type { ProviderIdentity } from './types.js';

/** Treat fetched employer pages as untrusted text. This deliberately extracts no
 * instructions, scripts, or embedded markup for downstream generation. */
export function extractResumeJobText(markup: string, maxCharacters = 30_000): { title?: string; description: string } {
  const title = markup.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1]
    ?.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
  const description = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<noscript\b[^>]*>[\s\S]*?<\/noscript>|<title\b[^>]*>[\s\S]*?<\/title>/giu, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|section|article|br)[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/giu, (_whole, entity: string) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity.toLowerCase()] ?? ' ')
    .replace(/[\t ]+/gu, ' ').replace(/\n\s*/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
    .slice(0, maxCharacters);
  return { ...(title ? { title: title.slice(0, 240) } : {}), description };
}

/** Routes whose response is JSON the caller can parse unconditionally. The
 * iCIMS frame route is deliberately excluded: it answers with HTML, and its host
 * is derived from a URL path segment rather than a reviewed tenant. */
const RESUME_STRUCTURED_JSON_METHODS = new Set<MetadataAcquisition['method']>([
  'greenhouse-api', 'lever-api', 'ashby-api', 'workday-api', 'smartrecruiters-api',
]);

/** A reviewed provider's public JSON route plus a parser for the exact posting.
 * The caller owns the bounded, public-HTTPS fetch so this stays pure and
 * testable; parse returns undefined when the payload is not the requested job. */
export interface ResumeJobStructuredRoute {
  /** Provider-owned API URL to request with an explicit JSON Accept header. */
  requestUrl: string;
  method: MetadataAcquisition['method'];
  parse(payload: unknown): { title?: string; description: string } | undefined;
}

/** Modern ATS pages (Ashby, Lever, Greenhouse) are client-rendered shells or
 * exceed the HTML budget, so scraping them yields empty or boilerplate text.
 * When the URL names a reviewed provider posting, resolve the structured public
 * API instead — the same immutable IDs the catalog ingestion path trusts. Only
 * JSON routes are returned, so the caller never has to guess an HTML payload. */
export function resumeJobStructuredRoute(canonicalUrl: string): ResumeJobStructuredRoute | undefined {
  let reference: ReturnType<typeof providerPostingReference>;
  try { reference = providerPostingReference(canonicalUrl); } catch { return undefined; }
  if (!reference.postingId || reference.provider === 'unknown') return undefined;
  const identity: ProviderIdentity = {
    provider: reference.provider,
    ...(reference.tenant ? { tenant: reference.tenant } : {}),
    postingId: reference.postingId,
    sourceId: 'resume-import',
    sourceUrl: canonicalUrl,
  };
  const route = metadataApiRoute(identity, canonicalUrl);
  if (!route || !RESUME_STRUCTURED_JSON_METHODS.has(route.method)) return undefined;
  return {
    requestUrl: route.url,
    method: route.method,
    parse(payload) {
      const artifact = parseMetadataApiResponse(route.identity ?? identity, route.method, payload, route.url);
      if (!artifact?.text) return undefined;
      return { title: artifact.title, description: artifact.text };
    },
  };
}
