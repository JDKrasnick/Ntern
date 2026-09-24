export type EmployerIconCandidateSource = 'json-ld-logo' | 'open-graph-image' | 'apple-touch-icon' | 'favicon';

export interface EmployerIconCandidate {
  source: EmployerIconCandidateSource;
  assetUrl: string;
  pageUrl: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface EmployerIconAssetCheck {
  accepted: boolean;
  contentType?: string;
  bytes?: number;
  reason?: string;
}

export interface EmployerIconDiscovery {
  pageUrl: string;
  verifiedName: boolean;
  candidates: EmployerIconCandidate[];
  blockedReason?: string;
}

const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/gu, '');
const decodeHtml = (value: string) => value.replace(/&amp;/giu, '&').replace(/&#x2f;/giu, '/');
const absoluteUrl = (raw: string, page: URL): string | undefined => {
  try {
    const url = new URL(decodeHtml(raw).trim(), page);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
};
const htmlAttribute = (tag: string, name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'iu').exec(tag)?.[1];
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'giu')) ?? [];

function jsonLdValues(html: string): Array<Record<string, unknown>> {
  return [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)]
    .flatMap((match) => {
      try {
        const value = JSON.parse(match[1]!);
        return Array.isArray(value) ? value : [value];
      } catch { return []; }
    })
    .flatMap((value) => value && typeof value === 'object' ? [value as Record<string, unknown>] : []);
}

/**
 * Extracts review candidates from one already-verified employer website. It does
 * not download, transform, or publish an asset; a reviewer makes that decision.
 */
export function discoverEmployerIcon(company: string, pageUrl: string, html: string): EmployerIconDiscovery {
  const page = new URL(pageUrl);
  const name = compact(company);
  const jsonLd = jsonLdValues(html);
  const textEvidence = [
    ...tags(html, 'title').map((tag) => tag.replace(/<[^>]+>/gu, '')),
    ...tags(html, 'meta').flatMap((tag) => [htmlAttribute(tag, 'content') ?? '']),
    ...jsonLd.flatMap((item) => [typeof item.name === 'string' ? item.name : '', typeof item.url === 'string' ? item.url : '']),
  ];
  const verifiedName = textEvidence.some((value) => compact(value).includes(name));
  const candidates: EmployerIconCandidate[] = [];
  const add = (source: EmployerIconCandidateSource, rawUrl: unknown, evidence: string) => {
    if (typeof rawUrl !== 'string') return;
    const assetUrl = absoluteUrl(rawUrl, page);
    if (!assetUrl || candidates.some((candidate) => candidate.assetUrl === assetUrl || candidate.source === source)) return;
    const base = source === 'json-ld-logo' ? 2 : source === 'open-graph-image' ? 1 : 0;
    candidates.push({ source, assetUrl, pageUrl: page.href,
      confidence: verifiedName && base === 2 ? 'high' : verifiedName && base === 1 ? 'medium' : 'low',
      evidence: [evidence, ...(verifiedName ? [`page names ${company}`] : ['page name needs review'])],
    });
  };
  for (const item of jsonLd) {
    const logo = item.logo;
    add('json-ld-logo', typeof logo === 'string' ? logo : logo && typeof logo === 'object' ? (logo as Record<string, unknown>).url : undefined, 'Organization JSON-LD logo');
  }
  for (const tag of tags(html, 'meta')) {
    const property = htmlAttribute(tag, 'property')?.toLowerCase();
    if (property === 'og:image') add('open-graph-image', htmlAttribute(tag, 'content'), 'Open Graph image');
  }
  for (const tag of tags(html, 'link')) {
    const rel = htmlAttribute(tag, 'rel')?.toLowerCase() ?? '';
    if (rel.includes('apple-touch-icon')) add('apple-touch-icon', htmlAttribute(tag, 'href'), 'Apple touch icon');
    else if (rel.split(/\s+/u).includes('icon')) add('favicon', htmlAttribute(tag, 'href'), 'Site favicon');
  }
  return { pageUrl: page.href, verifiedName, candidates };
}

/** Rejects non-image, oversized, and failed asset responses before review. */
export function verifyEmployerIconAsset(response: Response): EmployerIconAssetCheck {
  if (!response.ok) return { accepted: false, reason: `asset returned HTTP ${response.status}` };
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
  if (!contentType || !['image/avif', 'image/png', 'image/svg+xml', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(contentType)) {
    return { accepted: false, ...(contentType ? { contentType } : {}), reason: 'asset is not a supported image' };
  }
  const length = Number(response.headers.get('content-length'));
  // CDNs commonly answer HEAD on SVGs with Content-Length: 0. The final
  // downloader still enforces the byte cap; zero means "size unavailable" here.
  if (Number.isFinite(length) && length > 1_500_000) return { accepted: false, contentType, bytes: length, reason: 'asset exceeds the 1.5 MB review limit' };
  return { accepted: true, contentType, ...(Number.isFinite(length) && length > 0 ? { bytes: length } : {}) };
}
