/**
 * Provider client shapes and page evidence for company-icon resolution.
 *
 * Two independent providers are queried by employer name and both may only
 * nominate a domain; neither may nominate an asset. Asset URLs are always
 * rebuilt here from a validated domain, so a provider response can never smuggle
 * an arbitrary host into the catalog or into R2.
 *
 * Brandfetch's standard Logo API is hotlink-only and forbids persisting its
 * data, so its results are used as in-memory corroboration and are never stored
 * or fetched as bytes. Logo.dev is fetched only after its domain has been
 * selected by scoring.
 */

import { registrableDomain } from './core/registrable-domain.js';
import { MAX_PROVIDER_CANDIDATES, iconTextMatchesEmployer, providerNameMatchesEmployer } from './employer-icon-resolution.js';

export const logoDevSearchEndpoint = 'https://api.logo.dev/search';
export const logoDevImageEndpoint = 'https://img.logo.dev';
export const brandfetchSearchEndpoint = 'https://api.brandfetch.io/v2/search';

/** One provider request may not outlive this, whatever the provider does. */
export const ICON_PROVIDER_TIMEOUT_MS = 10_000;
/** A downloaded icon larger than this is rejected rather than stored. */
export const MAX_ICON_ASSET_BYTES = 2 * 1024 * 1024;
/** Squared, non-SVG raster types only: an SVG can run script on the API origin. */
const ICON_ASSET_CONTENT_TYPES: Record<string, true> = {
  'image/png': true, 'image/webp': true, 'image/avif': true, 'image/jpeg': true,
};

const MAX_JSON_LD_DOCUMENTS = 20;
const MAX_JSON_LD_NODES = 500;
const ORGANIZATION_TYPES = /(?:^|[^a-z])(?:organization|corporation|company|institution|agency|university|college)(?:[^a-z]|$)/u;

export function logoDevSearchUrl(displayName: string): string {
  return `${logoDevSearchEndpoint}?q=${encodeURIComponent(displayName.trim().slice(0, 100))}`;
}

export function brandfetchSearchUrl(displayName: string, clientId: string): string {
  return `${brandfetchSearchEndpoint}/${encodeURIComponent(displayName.trim().slice(0, 100))}?c=${encodeURIComponent(clientId)}`;
}

/**
 * The image URL used for the post-selection existence probe and for the
 * server-side asset fetch. `fallback=404` is what keeps Logo.dev's generated
 * monogram tile from being mistaken for a real logo.
 */
export function logoDevImageUrl(domain: string, token: string, size = 128): string {
  const params = new URLSearchParams({ token, size: String(size), format: 'webp', fallback: '404' });
  return `${logoDevImageEndpoint}/${encodeURIComponent(registrableDomain(domain))}?${params.toString()}`;
}

/** True only for a raster icon within the size ceiling. */
export function validIconAsset(contentType: string | null | undefined, byteLength: number): boolean {
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase();
  return Boolean(normalized && ICON_ASSET_CONTENT_TYPES[normalized])
    && byteLength > 0 && byteLength <= MAX_ICON_ASSET_BYTES;
}

/**
 * A provider nominates a domain only when its own reported brand name denotes the
 * canonical employer. A fuzzy provider hit is not evidence of employer identity,
 * and accepting one is how a wrong logo reaches the catalog.
 */
function exactProviderName(providerName: unknown, displayName: string): boolean {
  return typeof providerName === 'string' && providerName.trim() !== ''
    && providerNameMatchesEmployer(providerName, displayName);
}

/** Domains Logo.dev reported for the employer name, deduplicated and capped. */
export function logoDevCandidateDomains(value: unknown, displayName: string): string[] {
  return providerDomains(value, displayName);
}

/**
 * Domains Brandfetch reported for the employer name. Callers must treat these
 * as ephemeral corroboration: they are never persisted and never fetched.
 */
export function brandfetchCandidateDomains(value: unknown, displayName: string): string[] {
  return providerDomains(value, displayName);
}

function providerDomains(value: unknown, displayName: string): string[] {
  if (!Array.isArray(value)) return [];
  const domains: string[] = [];
  for (const entry of value) {
    if (domains.length >= MAX_PROVIDER_CANDIDATES) break;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!exactProviderName(record.name, displayName)) continue;
    const domain = typeof record.domain === 'string' ? registrableDomain(record.domain) : '';
    if (!domain.includes('.')) continue;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

/**
 * The logos the employer uploaded to its own ATS board, most suitable first.
 *
 * This is the employer's own mark, published by the employer on the board that
 * hosts its postings, so it is the ideal icon: no logo provider is involved and no
 * identity inference is needed. Each platform is matched on the hosts and paths it
 * actually uses for board logos, so an unrelated `og:image` — a role banner, a
 * client's CDN — is never picked up:
 *
 *   Ashby      app.ashbyhq.com/api/images/org-theme-logo|wordmark/<org>/<image>
 *   Greenhouse s<N>-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/…
 *   Lever      lever-client-logos.s3[-us-west-2|.us-west-2].amazonaws.com/<image>
 *
 * A square logo beats a wide wordmark for a square tile, and a raster beats an SVG,
 * because Ashby serves some boards an SVG that cannot be stored safely. Every
 * candidate is returned so a caller can fall through when one turns out to be
 * unusable.
 */
export function platformLogoUrls(html: string): string[] {
  const ranked = [
    // Source rank: a square logo beats a wide wordmark, and both beat the social
    // card crop, which is still the employer's own uploaded art.
    { url: jsonStringField(html, 'logoSquareImageUrl'), rank: 0 },
    { url: jsonStringField(html, 'logoWordmarkImageUrl'), rank: 1 },
    { url: metaContent(html, 'og:image'), rank: 2 },
  ].filter((candidate): candidate is { url: string; rank: number } =>
    Boolean(candidate.url) && isPlatformLogoHost(candidate.url!));
  const unique = [...new Map(ranked.map((candidate) => [candidate.url, candidate])).values()];
  const isSvg = (url: string) => /\.svg($|\?)/iu.test(url);
  // A raster is usable, an SVG cannot be stored, so format outranks source: Ashby
  // serves some boards an SVG square with a usable social image beside it.
  return unique
    .slice()
    .sort((left, right) => (isSvg(left.url) ? 1 : 0) - (isSvg(right.url) ? 1 : 0) || left.rank - right.rank)
    .map((candidate) => candidate.url);
}

/**
 * The accepted raster type for an asset, from its declared type or, when the
 * server declares nothing useful, from its own bytes. Lever's logo bucket serves
 * PNGs as `binary/octet-stream`, so a header cannot be the only evidence.
 */
export function iconAssetType(typeHeader: string | null | undefined, bytes: Uint8Array): string | undefined {
  const declared = typeHeader?.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== 'binary/octet-stream') {
    return declared !== '' && ICON_ASSET_CONTENT_TYPES[declared] ? declared : undefined;
  }
  const sniffed = sniffRasterType(bytes);
  return sniffed && ICON_ASSET_CONTENT_TYPES[sniffed] ? sniffed : undefined;
}

function sniffRasterType(bytes: Uint8Array): string | undefined {
  const at = (offset: number, expected: readonly number[]) =>
    expected.every((value, index) => bytes[offset + index] === value);
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  // ISO base media files carry `ftyp` at offset 4 with a brand that names the codec.
  if (bytes.length >= 12 && at(4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return undefined;
}

function jsonStringField(html: string, name: string): string | undefined {
  const match = new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`, 'u').exec(html);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]!);
    return typeof value === 'string' && value.startsWith('https://') ? value : undefined;
  } catch { return undefined; }
}

function isPlatformLogoHost(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host.endsWith('cdn.greenhouse.io')) return path.startsWith('/external_greenhouse_job_boards/logos/');
  if (host.startsWith('lever-client-logos.s3') && host.endsWith('amazonaws.com')) return true;
  if (host === 'app.ashbyhq.com') {
    // Every `org-theme-*` path is the employer's own uploaded art for its board:
    // the square logo, the wordmark, and the social-card crop of the same image.
    return path.startsWith('/api/images/org-theme-logo/')
      || path.startsWith('/api/images/org-theme-wordmark/')
      || path.startsWith('/api/images/org-theme-social/');
  }
  return false;
}

/** Bounded public page metadata that can independently name the employer. */
export interface IconOrganizationEvidence {
  name?: string;
  /**
   * Registrable domains the node's canonical-URL properties resolve to. `url` is
   * the obvious one, but publishers routinely put an Organization's site in
   * `sameAs` (the schema.org property for exactly that), so both are read. Asset
   * properties such as `logo` are deliberately ignored.
   */
  domains?: string[];
}

export interface IconPageEvidence {
  organizations: IconOrganizationEvidence[];
  /**
   * The employer's own site as its ATS board declares it. Ashby publishes one
   * (`publicWebsite`, else the careers page it hosts for the employer), and it is
   * the employer's own statement about its domain — the same authority as a JSON-LD
   * Organization URL, reached without a provider.
   */
  declaredWebsite?: string;
  /**
   * The employer's name as its ATS board declares it. Greenhouse publishes
   * `company_name`; Lever and Ashby put it in the page title. It is the platform's
   * own record for the board the catalog reviewed, so it identifies the employer
   * even when the catalog name differs (`RV Tech` versus
   * `Rivian and Volkswagen Group Technologies`).
   */
  declaredEmployerName?: string;
  title?: string;
  ogSiteName?: string;
  ogTitle?: string;
}

function metaContent(html: string, property: string): string | undefined {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'iu');
  return pattern.exec(html)?.[1]?.replace(/\s+/gu, ' ').trim().slice(0, 300);
}

function registrableDomainOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const domain = registrableDomain(new URL(value).hostname);
    return domain.includes('.') ? domain : undefined;
  } catch { return undefined; }
}

/**
 * Names and domains are collected together so a domain can never be attributed
 * to an employer on the strength of a different node's name.
 */
function collectOrganizations(node: unknown, found: IconOrganizationEvidence[], depth: number): void {
  if (depth > 6 || typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectOrganizations(item, found, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  const types = (Array.isArray(record['@type']) ? record['@type'] : [record['@type']])
    .filter((type): type is string => typeof type === 'string');
  if (types.some((type) => ORGANIZATION_TYPES.test(type.toLowerCase()))) {
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 200) : undefined;
    const sameAs = Array.isArray(record.sameAs) ? record.sameAs : [record.sameAs];
    const domains = [...new Set([registrableDomainOf(record.url), ...sameAs.map(registrableDomainOf)]
      .filter((domain): domain is string => Boolean(domain)))];
    if (name || domains.length) {
      found.push({ ...(name ? { name } : {}), ...(domains.length ? { domains } : {}) });
    }
  }
  for (const value of Object.values(record)) collectOrganizations(value, found, depth + 1);
}

function boundedString(html: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(html)?.[1]?.trim();
  return value ? value.slice(0, 300) : undefined;
}

/**
 * The employer's site and name as the ATS board declares them, read from the page
 * the resolver already fetched. Ashby publishes a website; Greenhouse publishes a
 * company name; Lever and Ashby name the employer in the title.
 */
function declaredEmployer(html: string, title: string | undefined): { website?: string; name?: string } {
  const published = boundedString(html, /"publicWebsite"\s*:\s*"(https?:\/\/[^"]+)"/iu)
    ?? boundedString(html, /"customJobsPageUrl"\s*:\s*"(https?:\/\/[^"]+)"/iu);
  const companyName = boundedString(html, /"company_name"\s*:\s*"([^"\\]+)"/iu);
  // "Job Application for <role> at <Employer>" (Greenhouse), or "<Employer> jobs"
  // and "<Employer> Careers" (Lever, Ashby).
  const fromTitle = /<(?:title|h1)[^>]*>[^<]*?\bat\s+([^<|]{2,120}?)\s*<\//iu.exec(html)?.[1]?.trim()
    ?? (title ? /^(.*?)\s+(?:jobs|careers)$/iu.exec(title)?.[1]?.trim() : undefined);
  return {
    ...(published ? { website: registrableDomainOf(published) } : {}),
    ...(companyName ?? fromTitle ? { name: (companyName ?? fromTitle)!.slice(0, 200) } : {}),
  };
}

/**
 * Reads only the bounded metadata a page publishes about its owning employer.
 * Page HTML is never stored; callers keep at most the normalized domains and a
 * short matched string.
 */
export function parseIconPageEvidence(html: string): IconPageEvidence {
  const organizations: IconOrganizationEvidence[] = [];
  const documents = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)]
    .slice(0, MAX_JSON_LD_DOCUMENTS);
  for (const document of documents) {
    if (organizations.length >= MAX_JSON_LD_NODES) break;
    try { collectOrganizations(JSON.parse(document[1] ?? ''), organizations, 0); }
    catch { /* Malformed publisher blocks are non-fatal. */ }
  }
  const title = /<title[^>]*>\s*([^<]+?)\s*<\/title>/iu.exec(html)?.[1]?.replace(/\s+/gu, ' ').trim().slice(0, 300);
  const ogSiteName = metaContent(html, 'og:site_name');
  const ogTitle = metaContent(html, 'og:title');
  const declared = declaredEmployer(html, title);
  return {
    organizations: organizations.slice(0, MAX_JSON_LD_NODES),
    ...(declared.website ? { declaredWebsite: declared.website } : {}),
    ...(declared.name ? { declaredEmployerName: declared.name } : {}),
    ...(title ? { title } : {}),
    ...(ogSiteName ? { ogSiteName } : {}),
    ...(ogTitle ? { ogTitle } : {}),
  };
}

/**
 * Whether a domain a model proposed really is the employer's site.
 *
 * This is the independent check that makes a proposal usable: the domain must
 * present itself as that employer, in its own metadata, when fetched. It may name
 * the catalog's employer name or the name the employer's ATS board declares —
 * `RV Tech` is catalogued that way while the company calls itself `Rivian and
 * Volkswagen Group Technologies`. Nothing else about the proposal is trusted, so a
 * plausible but wrong domain cannot pass.
 */
export function proposedDomainMatchesEmployer(
  evidence: IconPageEvidence,
  canonicalName: string,
  declaredName?: string,
): boolean {
  const stated = [
    evidence.title, evidence.ogSiteName, evidence.ogTitle, evidence.declaredEmployerName,
    ...evidence.organizations.flatMap((organization) => organization.name ?? []),
  ].filter((value): value is string => Boolean(value));
  for (const name of [canonicalName, ...(declaredName ? [declaredName] : [])]) {
    if (stated.some((value) => iconTextMatchesEmployer(value, name))) return true;
    if (stated.some((value) => providerNameMatchesEmployer(value, name))) return true;
  }
  return false;
}
