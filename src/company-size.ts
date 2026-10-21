import { canonicalCompanyKey } from './core/normalize.js';
import { readBoundedJson } from './core/bounded-body.js';

export type CompanySizeScores = ReadonlyMap<string, number>;
export interface CompanySizeCandidate { company: string; domain?: string; roles: number; }
export type CompanySizeLookup =
  | { status: 'matched'; employeeCount: number; providerId: string }
  | { status: 'unmatched' }
  | { status: 'error'; reason: 'credentials' | 'quota' | 'unavailable' | 'invalid-response' };

export const companySizeKey = canonicalCompanyKey;
export function companySizeScore(count: number): number | undefined {
  if (!Number.isSafeInteger(count) || count < 0) return undefined;
  return count >= 10_000 ? 85 : count >= 1_000 ? 75 : count >= 200 ? 65 : count >= 50 ? 55 : 50;
}

// Only an employer's own known domain is a matching hint. An ATS host is not
// evidence about the employer operating the board.
export function companyWebsiteDomain(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u.test(host)) return undefined;
    if (['myworkdayjobs.com', 'workday.com', 'greenhouse.io', 'lever.co', 'ashbyhq.com', 'smartrecruiters.com', 'icims.com', 'linkedin.com']
      .some(domain => host === domain || host.endsWith(`.${domain}`))) return undefined;
    return host;
  } catch { return undefined; }
}

/** One bounded, timed request. No raw provider payload or credential is logged. */
export async function lookupCompanySize(candidate: CompanySizeCandidate, apiKey: string, fetcher: typeof fetch = fetch): Promise<CompanySizeLookup> {
  const key = companySizeKey(candidate.company);
  if (!key || key.length > 200) return { status: 'unmatched' };
  const domain = companyWebsiteDomain(candidate.domain);
  const url = new URL('https://api.peopledatalabs.com/v5/company/enrich');
  url.search = new URLSearchParams({ name: candidate.company.replace(/^[^\p{L}\p{N}]+/gu, '').trim(),
    ...(domain ? { website: domain } : {}), min_likelihood: domain ? '6' : '5',
    include_if_matched: 'true', data_include: 'id,name,website,employee_count,size' }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(url, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 404) return { status: 'unmatched' };
      return { status: 'error', reason: [401, 403].includes(response.status) ? 'credentials' : [402, 429].includes(response.status) ? 'quota' : 'unavailable' };
    }
    const { value } = await readBoundedJson(response, 16_384, 'company-size');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'error', reason: 'invalid-response' };
    // Company enrichment fields are top-level, unlike the person/search APIs.
    const data = value as Record<string, unknown>;
    if (data.status !== 200 || typeof data.likelihood !== 'number' || data.likelihood < (domain ? 6 : 5)
      || data.likelihood > 10 || !Array.isArray(data.matched)) return { status: 'unmatched' };
    const exactName = typeof data.name === 'string' && companySizeKey(data.name) === key;
    const exactDomain = domain && data.matched.includes('website') && companyWebsiteDomain(data.website) === domain;
    if (!exactDomain && (!exactName || !data.matched.includes('name'))) return { status: 'unmatched' };
    if (typeof data.employee_count !== 'number' || companySizeScore(data.employee_count) === undefined
      || typeof data.id !== 'string' || !data.id || data.id.length > 200) return { status: 'unmatched' };
    return { status: 'matched', employeeCount: data.employee_count, providerId: data.id };
  } catch { return { status: 'error', reason: 'unavailable' }; }
  finally { clearTimeout(timer); }
}
