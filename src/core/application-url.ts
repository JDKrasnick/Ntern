import { applicationUrlRejection } from '../sources/quality.js';
import { createHash } from 'node:crypto';
import { isApplicationTrackingParameter } from '../identity/posting.js';
import { platformFetch } from './platform-fetch.js';
import { applicationMetadataArtifactsFromJsonDocuments, type ApplicationMetadataArtifact } from '../role-metadata.js';

const requestHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent': 'InternNotifs link verifier/1.0',
};

export class ApplicationUrlValidationError extends Error {}

export interface ApplicationUrlValidation { url: string; evidence: ApplicationPageEvidence; }
export type ApplicationUrlValidator = (url: string) => Promise<string | ApplicationUrlValidation>;

/**
 * Rewrites known employer URL aliases to the public route that actually
 * renders a job. TikTok serves a generic 200 shell at `/position/<id>`;
 * its canonical public posting route is `/search/<id>`.
 */
export function canonicalApplicationUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const match = url.hostname.toLowerCase() === 'lifeattiktok.com'
      ? /^\/position\/(\d+)\/?$/.exec(url.pathname)
      : undefined;
    return match ? `https://lifeattiktok.com/search/${match[1]}` : value;
  } catch {
    // Validation remains responsible for reporting malformed URLs.
    return value;
  }
}

/**
 * Public handoff URL: the source URL minus reviewed referral parameters.
 *
 * Only tracking parameters are removed. Posting-selecting and
 * route-controlling parameters (`gh_jid`, locale, form and detail parameters)
 * survive, and the occurrence keeps the exact source URL for provenance.
 * Unparseable input returns unchanged so a stored bad URL cannot break a
 * public read, and a URL with nothing to strip returns byte-for-byte so
 * existing links are not rewritten incidentally.
 */
export function publicApplicationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return value;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
  let removed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (!isApplicationTrackingParameter(key)) continue;
    url.searchParams.delete(key);
    removed = true;
  }
  return removed ? url.toString() : value;
}

/** Minimal server-rendered evidence available for any employer application page. */
export type ApplicationPageConfidenceLevel = 'high' | 'medium' | 'low';

export interface ApplicationPageConfidence {
  score: number;
  level: ApplicationPageConfidenceLevel;
  /** High-confidence roles may alert; uncertain roles remain catalog/review candidates. */
  recommendation: 'alert-eligible' | 'catalog-only' | 'review';
  signals: string[];
}

export interface ApplicationPageEvidence {
  url: string;
  /** True when only the bounded prefix of the response was inspected. */
  inspectionTruncated?: boolean;
  /** Renderer never reached a role description or a recognized terminal state. */
  loadingShell?: boolean;
  /** Exact number of response bytes inspected before decoding. */
  inspectedBytes?: number;
  /** A specific source path collapsed to a site's root after redirecting. */
  redirectedToGenericDestination?: boolean;
  title?: string;
  description?: string;
  expectedPostingId?: string;
  postingIdPresent?: boolean;
  jobPostingCount?: number;
  distinctJobLinkCount?: number;
  applicationFormPresent?: boolean;
  /** Browser frame that supplied the selected rendered posting proof. */
  evidenceFrameUrl?: string;
  evidenceFrameKind?: 'main' | 'child';
  renderedFrameCount?: number;
  failedFrameCount?: number;
  selfReferentialFrame?: boolean;
  /** Hash of bounded rendered frame evidence, excluding applicant-entered values. */
  renderedEvidenceHash?: string;
  /** Another expected posting ID produced the same normalized rendered artifact. */
  identicalEvidenceForDifferentPosting?: boolean;
  /** A conclusive publisher artifact wins over otherwise role-specific HTTP-200 content. */
  closureState?: 'open' | 'gone' | 'unknown';
  closureSignal?: 'explicit-language' | 'valid-through-expired';
  validThrough?: string;
  /** Bounded public job text, never applicant-entered data. */
  contentExcerpt?: string;
  contentHash?: string;
  contentSource?: 'json-ld' | 'main' | 'body';
  /** Transient normalized JSON-LD artifacts. Callers persist only extracted field evidence. */
  metadataArtifacts?: ApplicationMetadataArtifact[];
  compensationSections?: Array<{ label: string; text: string }>;
  confidence: ApplicationPageConfidence;
}

export type SourceRoleAgreement = 'strong' | 'partial' | 'weak';

function genericCareerTitle(title: string | undefined): boolean {
  if (!title) return false;
  const value = title.replace(/\s+/g, ' ').trim();
  const hasSpecificRole = /\b(?:intern(?:ship)?|engineer|developer|scientist|analyst|designer|manager|researcher|associate|consultant|apprentice|co-?op)\b/i.test(value);
  if (hasSpecificRole) return false;
  return /\b(?:candidate experience|career section|job opportunities|open roles?|jobs? (?:and employment )?at|careers? at|join (?:our )?team|careers?)\b/i.test(value)
    || value.split(/\s+/).length <= 3;
}

function normalizedRoleText(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/co[-\s]?op/g, ' coop ')
    .replace(/internships?/g, ' intern ')
    .replace(/engineerings?/g, ' engineer ')
    .replace(/developers?|development/g, ' develop ')
    .replace(/analysts?/g, ' analyst ')
    .replace(/scientists?/g, ' scientist ')
    .replace(/researchers?/g, ' researcher ')
    .replace(/designers?/g, ' design ')
    .replace(/[^a-z0-9+#.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function roleTerms(value: string): string[] {
  const ignored = new Set(['intern', 'coop', 'summer', 'fall', 'winter', 'spring', 'the', 'and', 'for', 'with', 'at', 'of', 'to', 'in', 'new', 'grad', 'university', 'college', 'software', 'technical', 'technology', 'technologies']);
  return [...new Set(normalizedRoleText(value).split(' ').filter((term) => term.length > 1 && !ignored.has(term) && !/^202\d$/.test(term)))];
}

/** Compares a source role with public title, metadata, and extracted job text. */
export function sourceRoleAgreement(role: string, evidence: ApplicationPageEvidence): SourceRoleAgreement {
  const source = normalizedRoleText(role);
  const page = normalizedRoleText([evidence.title, evidence.description, evidence.contentExcerpt].filter(Boolean).join(' '));
  if (!page) return 'weak';
  const sourcePhrase = source.split(' ').filter((term) => !['intern', 'coop', 'summer', 'fall', 'winter', 'spring'].includes(term)).join(' ');
  if (sourcePhrase.split(' ').length >= 2 && page.includes(sourcePhrase)) return 'strong';
  const terms = roleTerms(role);
  if (!terms.length) return 'partial';
  const found = terms.filter((term) => page.split(' ').includes(term)).length;
  const ratio = found / terms.length;
  return ratio >= 0.75 ? 'strong' : ratio >= 0.4 ? 'partial' : 'weak';
}

/**
 * Applies source-row context to transient scrape evidence. The caller must not
 * persist this result or `contentExcerpt`; it is only an alerting decision for
 * the current polling run.
 */
export function assessApplicationPageForListing(role: string, evidence: ApplicationPageEvidence): ApplicationPageConfidence {
  const base = evidence.confidence;
  const signals = [...base.signals];
  const agreement = sourceRoleAgreement(role, evidence);
  const substantiveJobContent = Boolean(evidence.contentExcerpt && evidence.contentExcerpt.length >= 300 && base.signals.includes('job-description language'));
  let score = base.score;
  if (agreement === 'strong' && substantiveJobContent) {
    score = Math.max(score, 75);
    signals.push('source role matches public job content');
  }
  if (evidence.redirectedToGenericDestination) {
    score = Math.min(score, 65);
    signals.push('specific posting redirected to generic destination');
  } else if (genericCareerTitle(evidence.title) && agreement !== 'strong') {
    score = Math.min(score, 65);
    signals.push('generic career-page title lacks source-role match');
  }
  const level: ApplicationPageConfidenceLevel = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
  return { score, level, recommendation: level === 'high' ? 'alert-eligible' : level === 'medium' ? 'catalog-only' : 'review', signals };
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|#38);/gi, '&').replace(/&(?:quot|#34);/gi, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&(?:nbsp|#160);/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function textFromHtml(value: string): string {
  return decodeHtml(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function normalizedStructuredDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function structuredPostingMatches(record: Record<string, unknown>, expectedPostingId: string): boolean {
  const escaped = expectedPostingId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'iu').test(JSON.stringify(record));
}

function structuredPostingDeclaresIdentity(record: Record<string, unknown>): boolean {
  return ['identifier', '@id', 'url', 'jobId', 'postingId', 'requisitionId']
    .some((key) => record[key] !== undefined && record[key] !== null);
}

function structuredJobText(html: string, expectedPostingId?: string): { text?: string; source?: 'json-ld'; validThrough?: string; metadataArtifacts?: ApplicationMetadataArtifact[] } {
  const postings: Record<string, unknown>[] = [];
  const documents = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]!);
  const metadataArtifacts = applicationMetadataArtifactsFromJsonDocuments(documents);
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const queue = [...values];
      while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) { queue.push(...value); continue; }
        const record = value as Record<string, unknown>;
        if (record['@graph']) queue.push(record['@graph']);
        const type = record['@type'];
        if ((Array.isArray(type) ? type : [type]).includes('JobPosting')) postings.push(record);
      }
    } catch { /* A malformed publisher JSON-LD block is non-fatal. */ }
  }
  const matching = expectedPostingId ? postings.filter((record) => structuredPostingMatches(record, expectedPostingId)) : [];
  const selected = matching.length === 1 ? matching[0]
    : postings.length === 1 && (!expectedPostingId || !structuredPostingDeclaresIdentity(postings[0])) ? postings[0] : undefined;
  if (!selected) return metadataArtifacts.length ? { metadataArtifacts } : {};
  return {
    ...(metadataArtifacts.length ? { metadataArtifacts } : {}),
    ...(typeof selected.description === 'string' ? { text: textFromHtml(selected.description), source: 'json-ld' as const } : {}),
    ...(normalizedStructuredDate(selected.validThrough) ? { validThrough: normalizedStructuredDate(selected.validThrough) } : {}),
  };
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body || response.bodyUsed) return;
  try {
    // Calling cancel marks the body consumed and starts connection cleanup.
    // Some remote stream sources do not settle the returned promise promptly,
    // so cleanup must not become an unbounded part of URL validation.
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Cleanup is best-effort and must not replace the validation outcome.
  }
}

async function boundedResponseText(
  response: Response,
  maximumBytes = 512 * 1024,
): Promise<{ text: string; inspectedBytes: number; inspectionTruncated: boolean }> {
  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader === null ? undefined : Number(declaredHeader);
  if (!response.body) return { text: '', inspectedBytes: 0, inspectionTruncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  const deadline = Date.now() + 8_000;
  const readChunk = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { void reader.cancel().catch(() => undefined); } catch { /* best-effort cleanup */ }
      reject(new ApplicationUrlValidationError('Application page body timed out'));
    }, Math.max(0, deadline - Date.now()));
    reader.read().then(resolve, reject).finally(() => clearTimeout(timeout));
  });
  try {
    while (true) {
      const { done, value } = await readChunk();
      if (done) { complete = true; break; }
      const remaining = maximumBytes - size;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        size = maximumBytes;
        break;
      }
      size += value.byteLength;
      chunks.push(value);
      if (size === maximumBytes) break;
    }
  } finally {
    if (!complete) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // Preserve the read or validation error that caused cancellation.
      }
    }
    try { reader.releaseLock(); } catch { /* cancellation may still own the pending read */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return {
    text: new TextDecoder().decode(bytes),
    inspectedBytes: size,
    inspectionTruncated: !complete || (Number.isFinite(declared) && declared! > size),
  };
}

function applicationContent(
  html: string,
  expectedPostingId: string | undefined,
  inspection: Pick<ApplicationPageEvidence, 'inspectionTruncated' | 'inspectedBytes'>,
): { excerpt?: string; hash?: string; source?: 'json-ld' | 'main' | 'body'; metadataArtifacts?: ApplicationMetadataArtifact[]; validThrough?: string } {
  const structured = structuredJobText(html, expectedPostingId);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1];
  const text = structured.text ?? (main ? textFromHtml(main) : textFromHtml(/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html));
  if (!text) return structured.metadataArtifacts?.length ? { metadataArtifacts: structured.metadataArtifacts } : {};
  return {
    ...(structured.validThrough ? { validThrough: structured.validThrough } : {}),
    excerpt: text.slice(0, 12_000),
    hash: createHash('sha256').update(JSON.stringify({
      text,
      inspectionTruncated: inspection.inspectionTruncated === true,
      inspectedBytes: inspection.inspectedBytes ?? 0,
    })).digest('hex'),
    source: structured.source ?? (main ? 'main' : 'body'),
    ...(structured.metadataArtifacts?.length ? { metadataArtifacts: structured.metadataArtifacts } : {}),
  };
}

/** Deliberately narrow: generic careers copy mentioning expiry must not close a specific role. */
export function explicitDestinationClosure(value: string): boolean {
  const text = value.replace(/\s+/gu, ' ').trim();
  return /^(?:this\s+(?:job|role|position|opening)\s+is\s+)?no\s+longer\s+accepting\s+applications\b/iu.test(text)
    || /^(?:(?:this|the)\s+)?(?:job|role|position|opening)\s+(?:filled|expired|closed)[.!]?$/iu.test(text)
    || /^no\s+longer\s+available[.!]?$/iu.test(text)
    || /\b(?:this|the)\s+(?:job|role|position|opening)\s+(?:has(?:\s+been)?|is|was)\s+(?:filled|expired|closed|no\s+longer\s+available)\b/iu.test(text)
    || /\b(?:this|the)\s+(?:job|role|position|opening)\s+is\s+no\s+longer\s+accepting\s+applications\b/iu.test(text)
    || /\bwe\s+(?:are|['’]?re)\s+no\s+longer\s+accepting\s+applications\s+for\s+(?:this|the)\s+(?:job|role|position|opening)\b/iu.test(text);
}

const JOB_ROUTE = /(?:^|\/)(?:careers?|jobs?|openings?|positions?|roles?|vacancies?)(?:\/|$)/iu;

function distinctJobLinkCount(html: string, pageUrl: URL): number {
  const page = new URL(pageUrl);
  page.hash = '';
  const links = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/giu)) {
    try {
      const candidate = new URL(decodeHtml(match[1]!), page);
      candidate.hash = '';
      if (!['http:', 'https:'].includes(candidate.protocol) || candidate.toString() === page.toString()) continue;
      if (JOB_ROUTE.test(candidate.pathname)) links.add(candidate.toString());
    } catch { /* Malformed link evidence is ignored. */ }
  }
  return links.size;
}

function postingId(url: URL): string | undefined {
  // Long numeric IDs are common across ATSes. This remains optional evidence:
  // a valid posting may use a slug or load its structured data client-side.
  return [...url.pathname.matchAll(/\/(\d{6,})(?:\/|$)/g)].at(-1)?.[1];
}

function explicitErrorDestination(url: URL): boolean {
  const pathLooksLikeError = /(?:^|\/)(?:404|not[-_]?found|error(?:page)?)(?:\/|$)/i.test(url.pathname);
  const errorCode = [...url.searchParams.entries()].some(([key, value]) => /(?:error|status|code)/i.test(key) && /(?:404|not[-_]?found)/i.test(value));
  return pathLooksLikeError && errorCode;
}

function postingRedirectedToGenericDestination(source: URL, destination: URL): boolean {
  return source.hostname === destination.hostname
    && source.pathname !== '/'
    && destination.pathname === '/';
}

function confidenceFor(input: { html: boolean; title?: string; description?: string; contentExcerpt?: string; expectedPostingId?: string; postingIdPresent?: boolean; accessRestricted?: boolean; temporarilyUnavailable?: boolean }): ApplicationPageConfidence {
  let score = 25; const signals = ['destination reached'];
  if (input.accessRestricted) return { score, level: 'low', recommendation: 'review', signals: [...signals, 'access restricted to scraper'] };
  if (input.temporarilyUnavailable) return { score, level: 'low', recommendation: 'review', signals: [...signals, 'temporary server failure'] };
  if (!input.html) return { score, level: 'low', recommendation: 'review', signals: [...signals, 'non-HTML destination'] };
  score += 10; signals.push('HTML response');
  const hasRoleSignal = Boolean(input.title && /\b(?:intern(?:ship)?|job|position|role|engineer|developer|scientist|analyst|manager|designer|researcher|associate|consultant|apprentice|co-?op)\b/i.test(input.title));
  if (input.title) { score += 20; signals.push('page title'); }
  if (hasRoleSignal) { score += 10; signals.push('role-like title'); }
  if (input.description) { score += 15; signals.push('page description'); }
  if (input.contentExcerpt && input.contentExcerpt.length >= 300) {
    score += 10; signals.push('substantive page content');
    if (/\b(?:responsibilities|qualifications|requirements|what you(?:'|’)ll do|about the role|apply|intern(?:ship)?)\b/i.test(input.contentExcerpt)) {
      score += 5; signals.push('job-description language');
    }
  }
  if (input.expectedPostingId) {
    if (input.postingIdPresent) { score += 20; signals.push('posting ID appears in page'); }
    else signals.push('posting ID absent from server HTML');
  } else if (input.title) {
    score += 5; signals.push('slug-based or opaque URL');
  }
  if (genericCareerTitle(input.title)) {
    score = Math.min(score, 65); signals.push('generic career-page title');
  }
  const normalized = Math.min(score, 100);
  const level = normalized >= 70 ? 'high' : normalized >= 45 ? 'medium' : 'low';
  return { score: normalized, level, recommendation: level === 'high' ? 'alert-eligible' : level === 'medium' ? 'catalog-only' : 'review', signals };
}

/**
 * Reads a compact, server-rendered evidence layer for any application page.
 * Status codes alone are insufficient because many career sites return a 200
 * shell for expired or malformed role URLs.
 */
export async function inspectApplicationPage(
  value: string | URL,
  fetcher: typeof fetch = platformFetch,
): Promise<ApplicationPageEvidence> {
  const url = typeof value === 'string' ? new URL(value) : value;
  const expectedPostingId = postingId(url);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      redirect: 'follow',
      headers: requestHeaders,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ApplicationUrlValidationError('Application page could not be reached');
  }
  const destination = new URL(response.url || url.toString());
  if (!response.ok) {
    await discardResponseBody(response);
    if ([401, 403, 406, 429].includes(response.status) || response.status >= 500) {
      return {
        url: destination.toString(),
        ...(expectedPostingId ? { expectedPostingId } : {}),
        confidence: confidenceFor({ html: false, ...([401, 403, 406, 429].includes(response.status) ? { accessRestricted: true } : { temporarilyUnavailable: true }), ...(expectedPostingId ? { expectedPostingId } : {}) }),
      };
    }
    throw new ApplicationUrlValidationError(`Application page returned HTTP ${response.status}`);
  }
  if (explicitErrorDestination(destination)) {
    await discardResponseBody(response);
    throw new ApplicationUrlValidationError('Application page redirected to an explicit error destination');
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('html')) {
    await discardResponseBody(response);
    return {
      url: destination.toString(),
      ...(expectedPostingId ? { expectedPostingId } : {}),
      confidence: confidenceFor({ html: false, ...(expectedPostingId ? { expectedPostingId } : {}) }),
    };
  }
  const inspection = await boundedResponseText(response);
  const html = inspection.text;
  const content = applicationContent(html, expectedPostingId, inspection);
  const title = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim();
  const description = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim();
  const postingIdObserved = expectedPostingId ? html.includes(expectedPostingId) : undefined;
  const postingIdPresent = inspection.inspectionTruncated && postingIdObserved === false ? undefined : postingIdObserved;
  const jobPostingCount = [...html.matchAll(/["']@type["']\s*:\s*["']JobPosting["']/gi)].length;
  const jobLinkCount = distinctJobLinkCount(html, destination);
  const applicationFormPresent = /<form\b[^>]*(?:action=["'][^"']*(?:apply|application)|id=["'][^"']*(?:apply|application))|<input\b[^>]*(?:type=["']file["']|name=["'](?:resume|cv)["'])/i.test(html);
  const explicitlyGone = [title, description,
    ...(content.source !== 'json-ld' && applicationFormPresent ? [] : [content.excerpt?.slice(0, 2_000)])]
    .some((value) => explicitDestinationClosure(value ?? ''));
  const validThroughExpired = Boolean(content.validThrough && Date.parse(content.validThrough) < Date.now());
  if (title && /^(?:404 |page )?not found$|^(?:access denied|application error|error)$/i.test(title)) {
    throw new ApplicationUrlValidationError(`Application page reports ${title}`);
  }
  return {
    url: destination.toString(),
    inspectionTruncated: inspection.inspectionTruncated,
    inspectedBytes: inspection.inspectedBytes,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(expectedPostingId ? { expectedPostingId } : {}),
    ...(postingIdPresent !== undefined ? { postingIdPresent } : {}),
    ...(jobPostingCount ? { jobPostingCount } : {}),
    ...(jobLinkCount ? { distinctJobLinkCount: jobLinkCount } : {}),
    ...(applicationFormPresent ? { applicationFormPresent: true } : {}),
    ...(content.validThrough ? { validThrough: content.validThrough } : {}),
    ...(validThroughExpired
      ? { closureState: 'gone' as const, closureSignal: 'valid-through-expired' as const }
      : explicitlyGone ? { closureState: 'gone' as const, closureSignal: 'explicit-language' as const }
        : { closureState: 'open' as const }),
    ...(content.excerpt ? { contentExcerpt: content.excerpt, contentHash: content.hash, contentSource: content.source } : {}),
    ...(content.metadataArtifacts?.length ? { metadataArtifacts: content.metadataArtifacts } : {}),
    confidence: confidenceFor({ html: true, ...(title ? { title } : {}), ...(description ? { description } : {}), ...(content.excerpt ? { contentExcerpt: content.excerpt } : {}), ...(expectedPostingId ? { expectedPostingId } : {}), ...(postingIdPresent !== undefined ? { postingIdPresent } : {}) }),
  };
}

/** Optional source-specific host contract enforced in addition to the generic checks. */
export interface ApplicationUrlPolicy {
  /** Hosts the reported application URL may start on before any redirect. */
  allowedInitialHosts?: string[];
  /** Hosts the application URL may finally resolve to after redirects. */
  allowedFinalHosts?: string[];
}

/** Exact host or dot-boundary subdomain match; `greenhouse.io.evil.test` never matches `greenhouse.io`. */
function hostAllowed(host: string, allowedHosts: string[]): boolean {
  const normalized = host.toLowerCase();
  return allowedHosts.some((allowed) => {
    const candidate = allowed.trim().toLowerCase();
    return normalized === candidate || normalized.endsWith(`.${candidate}`);
  });
}

function httpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ApplicationUrlValidationError(`${label} is not a URL`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new ApplicationUrlValidationError(`${label} must be an HTTPS URL`);
  }
  return parsed;
}

/**
 * Confirms an official application URL resolves before it reaches the catalog
 * or an alert. The GET fallback covers career sites that reject or do not
 * implement HEAD requests.
 */
export async function validateApplicationUrlWithEvidence(
  value: string,
  fetcher: typeof fetch = platformFetch,
  policy?: ApplicationUrlPolicy,
): Promise<ApplicationUrlValidation> {
  const sourceUrl = httpsUrl(canonicalApplicationUrl(value), 'Application link');
  // Aggregators are never official application destinations, even for legacy
  // callers without a source-specific host contract.
  const rejection = applicationUrlRejection(value);
  if (rejection) throw new ApplicationUrlValidationError(rejection);
  // A source policy adds the initial-host contract; generic callers remain
  // backward compatible with respect to ordinary employer hosts.
  if (policy) {
    if (policy.allowedInitialHosts && !hostAllowed(sourceUrl.hostname, policy.allowedInitialHosts)) {
      throw new ApplicationUrlValidationError(`Application link host ${sourceUrl.hostname} is not an approved source host`);
    }
  }
  const request = async (method: 'HEAD' | 'GET') =>
    fetcher(sourceUrl, {
      method,
      redirect: 'follow',
      headers: method === 'GET' ? { ...requestHeaders, Range: 'bytes=0-0' } : requestHeaders,
      signal: AbortSignal.timeout(8_000),
    });

  let response: Response;
  try {
    response = await request('HEAD');
    if (!response.ok) {
      await discardResponseBody(response);
      response = await request('GET');
    }
  } catch (error) {
    const detail = error instanceof Error && error.name === 'TimeoutError'
      ? 'timed out'
      : 'could not be reached';
    throw new ApplicationUrlValidationError(`Application link ${detail}`);
  }

  if (!response.ok) {
    await discardResponseBody(response);
    if ([401, 403, 406, 429].includes(response.status) || response.status >= 500) {
      const restricted = httpsUrl(response.url || sourceUrl.toString(), 'Resolved application link');
      if (policy?.allowedFinalHosts && !hostAllowed(restricted.hostname, policy.allowedFinalHosts)) {
        throw new ApplicationUrlValidationError(`Resolved application link host ${restricted.hostname} is not an approved destination host`);
      }
      return { url: restricted.toString(), evidence: { url: restricted.toString(), confidence: confidenceFor({ html: false, ...([401, 403, 406, 429].includes(response.status) ? { accessRestricted: true } : { temporarilyUnavailable: true }) }) } };
    }
    throw new ApplicationUrlValidationError(`Application link returned HTTP ${response.status}`);
  }

  const resolved = httpsUrl(response.url || sourceUrl.toString(), 'Resolved application link');
  await discardResponseBody(response);
  if (policy?.allowedFinalHosts && !hostAllowed(resolved.hostname, policy.allowedFinalHosts)) {
    throw new ApplicationUrlValidationError(`Resolved application link host ${resolved.hostname} is not an approved destination host`);
  }
  const evidence = await inspectApplicationPage(resolved, fetcher);
  if (postingRedirectedToGenericDestination(sourceUrl, resolved)) {
    return { url: resolved.toString(), evidence: { ...evidence, redirectedToGenericDestination: true } };
  }
  return { url: resolved.toString(), evidence };
}

export async function validateApplicationUrl(value: string, fetcher: typeof fetch = platformFetch, policy?: ApplicationUrlPolicy): Promise<string> {
  return (await validateApplicationUrlWithEvidence(value, fetcher, policy)).url;
}

/** Binds a source policy (and optional fetcher) into the single-argument validator shape. */
export function createSourceUrlValidator(policy: ApplicationUrlPolicy, fetcher: typeof fetch = platformFetch): ApplicationUrlValidator {
  return (url: string) => validateApplicationUrlWithEvidence(url, fetcher, policy);
}
