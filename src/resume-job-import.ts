import { metadataApiRoute, parseMetadataApiResponse, type MetadataAcquisition } from './metadata-acquisition.js';
import { providerPostingReference } from './identity/posting.js';
import type { ResumeImportFailureReason } from './resume.js';
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

/** A reviewed provider's public route plus a parser for the exact posting.
 * The caller owns the bounded, public-HTTPS fetch so this stays pure and
 * testable; parse returns undefined when the payload is not the requested job. */
export interface ResumeJobStructuredRoute {
  /** Provider-owned API URL to request with an explicit Accept header. */
  requestUrl: string;
  method: MetadataAcquisition['method'];
  /** JSON responses are parsed; the iCIMS frame route answers with HTML. */
  accept: 'application/json' | 'text/html';
  /** Present for provider routes that need a body (Ashby's posting lookup). */
  request?: { method: 'POST'; contentType: string; body: string };
  parse(payload: unknown): { title?: string; description: string } | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Import failures a user can act on. Each carries the wording the client shows,
 * so a closed posting, a rate limit, and an unreadable page are distinguishable. */
export const resumeImportFailureMessage: Record<ResumeImportFailureReason, string> = {
  'posting-unavailable': 'This posting looks closed or removed.',
  'rate-limited': 'The employer is rate-limiting requests right now.',
  'unreadable-page': 'We could not read this page.',
};

export class ResumeImportError extends Error {
  constructor(readonly code: ResumeImportFailureReason) {
    super(resumeImportFailureMessage[code]);
    this.name = 'ResumeImportError';
  }
}

export function classifyResumeImportStatus(status: number | undefined): ResumeImportFailureReason {
  if (status === 404 || status === 410) return 'posting-unavailable';
  if (status === 429) return 'rate-limited';
  return 'unreadable-page';
}

/** A rendered error page (for example Lever's "Not found - 404 error") is short
 * and starts with a not-found phrase. Never accept it as a job description. */
export function looksLikeErrorPage(value: { title?: string; description: string }): boolean {
  if (value.description.trim().length >= 400) return false;
  const head = `${value.title ?? ''}\n${value.description.slice(0, 300)}`;
  return /(?:^|\s)(?:not found|page not found|job not found|404|410)\b/iu.test(head)
    || /(?:job|position|posting)\b[^.\n]{0,40}\b(?:no longer|has been)\s+(?:available|filled|closed|removed)/iu.test(head);
}

/** Ashby's board endpoint returns the tenant's entire board, which fails for a
 * large board and can omit an unlisted posting. The board page itself resolves a
 * single posting through this GraphQL operation, so fetch only that posting. */
const ASHBY_POSTING_URL = 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting';
const ASHBY_POSTING_QUERY = 'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id title descriptionHtml } }';

/** Modern ATS pages (Ashby, Lever, Greenhouse) are client-rendered shells or
 * exceed the HTML budget, so scraping them yields empty or boilerplate text.
 * When the URL names a reviewed provider posting, resolve the provider's public
 * route for that exact posting instead — the same immutable IDs the catalog
 * ingestion path trusts. */
export function resumeJobStructuredRoute(canonicalUrl: string): ResumeJobStructuredRoute | undefined {
  let reference: ReturnType<typeof providerPostingReference>;
  try { reference = providerPostingReference(canonicalUrl); } catch { return undefined; }
  if (!reference.postingId || reference.provider === 'unknown') return undefined;
  if (reference.provider === 'ashby') {
    if (!reference.tenant) return undefined;
    return {
      requestUrl: ASHBY_POSTING_URL,
      method: 'ashby-api',
      accept: 'application/json',
      request: { method: 'POST', contentType: 'application/json', body: JSON.stringify({ operationName: 'ApiJobPosting', variables: { organizationHostedJobsPageName: reference.tenant, jobPostingId: reference.postingId }, query: ASHBY_POSTING_QUERY }) },
      parse(payload) {
        const job = isRecord(payload) && isRecord(payload.data) ? payload.data.jobPosting : undefined;
        if (!isRecord(job) || typeof job.descriptionHtml !== 'string' || !job.descriptionHtml.trim()) return undefined;
        const extracted = extractResumeJobText(job.descriptionHtml);
        const title = typeof job.title === 'string' && job.title.trim() ? job.title.trim().slice(0, 240) : extracted.title;
        return { ...(title ? { title } : {}), description: extracted.description };
      },
    };
  }
  const identity: ProviderIdentity = {
    provider: reference.provider,
    ...(reference.tenant ? { tenant: reference.tenant } : {}),
    postingId: reference.postingId,
    sourceId: 'resume-import',
    sourceUrl: canonicalUrl,
  };
  const route = metadataApiRoute(identity, canonicalUrl);
  if (!route) return undefined;
  const html = route.method === 'icims-page';
  if (html) {
    // The iCIMS frame route is HTML, and its tenant must come from a provider host
    // (a `.icims.com` subdomain), never from an arbitrary path segment.
    try { if (!new URL(route.url).hostname.endsWith('.icims.com')) return undefined; } catch { return undefined; }
  } else if (!RESUME_STRUCTURED_JSON_METHODS.has(route.method)) return undefined;
  return {
    requestUrl: route.url,
    method: route.method,
    accept: html ? 'text/html' : 'application/json',
    parse(payload) {
      const artifact = parseMetadataApiResponse(route.identity ?? identity, route.method, payload, route.url);
      if (!artifact?.text) return undefined;
      return { title: artifact.title, description: artifact.text };
    },
  };
}
