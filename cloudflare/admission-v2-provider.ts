import { safeFetchText, PublicNetworkPolicyError } from '../src/employer/index.js';
import { providerPostingReference, customGreenhouseReference } from '../src/identity/posting.js';
import { metadataApiRoute, parseMetadataApiResponse } from '../src/metadata-acquisition.js';
import { metadataDescriptionText } from '../src/core/metadata-text.js';
import type { AdmissionDestinationProbe } from '../src/ingestion-v2/admission/evaluator.js';
import { AdmissionProviderDeferredError, AdmissionRowTransientError, admissionRetryAfterMs } from '../src/ingestion-v2/admission/taxonomy.js';
import type { AdmissionProviderGovernor } from './admission-v2-provider-governor.js';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function unavailable(detail: string): never { throw new AdmissionRowTransientError('upstream-server-error', detail); }
function evidence(url: string, postingId: string, title: string, description: string): AdmissionDestinationProbe {
  const contentExcerpt = metadataDescriptionText(description).slice(0, 32_768);
  return { reachability: 'live', evidence: {
    url, title, contentExcerpt, expectedPostingId: postingId, postingIdPresent: true,
    confidence: { score: 60, level: 'medium', recommendation: 'catalog-only', signals: [
      'official provider API', 'exact published posting ID',
      ...(contentExcerpt.length >= 300 && /\b(?:responsibilities|qualifications|requirements|experience|internship)\b/iu.test(contentExcerpt) ? ['job-description language'] : []),
    ] },
  } };
}

/** One bounded tenant cache per queue delivery, never a global Worker cache. */
export function officialAdmissionProviderProbe(resolver: { resolve(host: string): Promise<string[]> }, governor?: AdmissionProviderGovernor) {
  let cache: { url: string; promise: Promise<Record<string, unknown> | 'gone' | 'blocked'> } | undefined;
  async function read(url: string, permittedFinal: (final: URL) => boolean, provider?: 'workable'): Promise<Record<string, unknown> | 'gone' | 'blocked'> {
    if (provider && governor) {
      let delay = await governor.acquire(provider);
      // A short pacing reservation can finish inside this bounded delivery.
      // Long provider cooldowns remain durable queued work, never a long sleep.
      if (delay > 0 && delay <= 2_000) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = await governor.acquire(provider);
      }
      if (delay > 0) throw new AdmissionProviderDeferredError('Workable provider cooldown; no destination request made', delay);
    }
    let response;
    try { response = await safeFetchText(url, { resolver, timeoutMs: 8000, maxRedirects: 2,
      maxBodyBytes: 512 * 1024, onOversize: 'fail', headers: { Accept: 'application/json' } }); }
    catch (error) {
      if (error instanceof PublicNetworkPolicyError) return 'blocked';
      throw new AdmissionRowTransientError('destination-timeout', error instanceof Error ? error.message : String(error));
    }
    if (!permittedFinal(new URL(response.url))) unavailable('Official provider API redirected outside its posting route');
    if (response.status === 404 || response.status === 410) return 'gone';
    if (response.status === 429) {
      const delay = admissionRetryAfterMs(response.headers.get('retry-after'));
      if (provider && governor) await governor.defer(provider, delay ?? 15 * 60_000);
      throw new AdmissionRowTransientError('destination-rate-limited', `HTTP 429 from ${new URL(response.url).hostname}`, delay);
    }
    if (response.status >= 500) unavailable(`Official provider API HTTP ${response.status}`);
    if (response.status >= 400) return 'blocked';
    let payload: unknown;
    try { payload = JSON.parse(response.body); } catch { unavailable('Official provider API returned invalid JSON'); }
    if (!record(payload)) unavailable('Official provider API returned an invalid object');
    return payload;
  }
  return async (applyUrl: string): Promise<AdmissionDestinationProbe | undefined> => {
    const original = new URL(applyUrl);
    if (original.protocol !== 'https:' || original.username || original.password || original.port) return undefined;
    const identity = customGreenhouseReference(original, original.hostname.replace(/^www\./u, '')) ?? providerPostingReference(applyUrl);
    if (identity.provider === 'greenhouse' && identity.tenant && identity.postingId) {
      const providerIdentity = { provider: 'greenhouse' as const, tenant: identity.tenant, postingId: identity.postingId,
        sourceId: 'admission-v2-probe', sourceUrl: applyUrl };
      const route = metadataApiRoute(providerIdentity, applyUrl);
      if (!route) return undefined;
      const payload = await read(route.url, final => final.origin === 'https://boards-api.greenhouse.io' && final.pathname === new URL(route.url).pathname);
      if (typeof payload === 'string') return { reachability: payload };
      const artifact = parseMetadataApiResponse(providerIdentity, 'greenhouse-api', payload, route.url);
      if (!artifact) unavailable('Greenhouse posting identity or description mismatch');
      if (typeof payload.absolute_url !== 'string') unavailable('Greenhouse posting has no public application URL');
      let publishedIdentity;
      try {
        const publishedUrl = new URL(payload.absolute_url);
        publishedIdentity = customGreenhouseReference(publishedUrl, publishedUrl.hostname.replace(/^www\./u, '')) ?? providerPostingReference(payload.absolute_url);
      } catch { unavailable('Greenhouse application URL is invalid'); }
      const published = new URL(payload.absolute_url);
      if (published.protocol !== 'https:' || published.username || published.password || published.port
        || publishedIdentity!.provider !== identity.provider || publishedIdentity!.tenant !== identity.tenant
        || publishedIdentity!.postingId !== identity.postingId) unavailable('Greenhouse application URL identity mismatch');
      return evidence(applyUrl, identity.postingId, artifact.title ?? '', artifact.text ?? '');
    }
    const match = /^\/([a-z0-9_-]{1,100})\/j\/([a-z0-9]{10})(?:\/apply)?\/?$/iu.exec(original.pathname);
    if (original.hostname !== 'apply.workable.com' || !match) return undefined;
    const [, tenant, id] = match;
    const url = `https://www.workable.com/api/accounts/${tenant}?details=true`;
    const shared = cache?.url === url;
    if (!shared) cache = { url, promise: read(url, final =>
      (final.origin === 'https://www.workable.com' && final.pathname === `/api/accounts/${tenant}`)
      || (final.origin === 'https://apply.workable.com' && final.pathname === `/api/v1/widget/accounts/${tenant}`), 'workable') };
    // Cache failures too: peer rows must not repeat a throttled tenant request.
    let payload;
    try { payload = await cache!.promise; }
    catch (error) {
      if (shared && error instanceof AdmissionRowTransientError) {
        throw new AdmissionProviderDeferredError('Shared Workable failed probe; no new destination request made',
          error.retryAfterMs ?? (error.classification === 'destination-rate-limited' ? 15 * 60_000 : 60_000),
          error.classification);
      }
      throw error;
    }
    if (payload === 'gone') unavailable('Workable tenant inventory is unavailable; posting closure is unproven');
    if (typeof payload === 'string') return { reachability: payload };
    // A tenant-level 404 is not proof that an individual posting closed.
    if (typeof payload.name !== 'string' || !payload.name || !Array.isArray(payload.jobs) || payload.jobs.length > 1000
      || payload.next || payload.next_page || (typeof payload.total === 'number' && payload.total !== payload.jobs.length)) unavailable('Workable inventory is incomplete');
    const jobs = payload.jobs;
    const seen = new Set<string>();
    for (const job of jobs) {
      if (!record(job) || typeof job.shortcode !== 'string' || !/^[a-z0-9]{10}$/iu.test(job.shortcode)
        || seen.has(job.shortcode.toUpperCase())) unavailable('Workable inventory has invalid or duplicate posting IDs');
      seen.add(job.shortcode.toUpperCase());
    }
    const job = jobs.find(job => record(job) && String(job.shortcode).toUpperCase() === id!.toUpperCase());
    if (!job) return { reachability: 'gone' };
    if (!record(job) || typeof job.title !== 'string' || !job.title.trim() || typeof job.url !== 'string') unavailable('Workable posting is malformed');
    let published: URL;
    try { published = new URL(job.url); } catch { unavailable('Workable posting URL is invalid'); }
    const path = published!.pathname.replace(/\/$/u, '');
    if (published!.protocol !== 'https:' || published!.hostname !== 'apply.workable.com' || published!.username || published!.password || published!.port
      || ![`/j/${id}`, `/${tenant}/j/${id}`].includes(path)) unavailable('Workable posting URL does not match the requested ID');
    return evidence(applyUrl, id!, job.title, typeof job.description === 'string' ? job.description : '');
  };
}
