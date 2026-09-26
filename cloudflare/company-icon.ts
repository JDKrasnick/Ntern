import { ICON_PROVIDER_TIMEOUT_MS, MAX_ICON_ASSET_BYTES, logoDevImageUrl, validIconAsset } from '../src/employer-icon-discovery.js';
import { safeFetchBytes, type HostResolver } from '../src/employer/safe-network.js';
import type { CanonicalEmployer } from '../src/types.js';
import type { R2Bucket } from './types.js';

const COMPANY_ICON_ID = /^[a-z0-9][a-z0-9-]{0,159}$/u;
const PUBLIC_ICON_CONTENT_TYPES = new Set(['image/avif', 'image/png', 'image/webp']);

export function validCompanyIconEmployerId(id: string): boolean {
  return COMPANY_ICON_ID.test(id);
}

export interface CanonicalEmployerIconStore {
  getCanonicalEmployer(id: string): Promise<CanonicalEmployer | undefined>;
}

/**
 * Automatic-icon dependencies. Every one of them is consulted only when the
 * employer has no first-party asset, so a reviewed icon never pays for a settings
 * read or a provider request.
 */
export interface CompanyIconDependencies {
  /** Employer domain an automatic decision accepted. */
  automaticDomain?: (employerId: string) => Promise<string | undefined>;
  /** Whether the operator has left observe mode and enabled automatic display. */
  automaticDisplay?: () => Promise<boolean>;
  /**
   * Logo.dev's publishable token (`pk_…`), not its secret key: only the publishable
   * token authorizes `img.logo.dev`, and the secret key is answered with `401`.
   */
  logoDevImageToken?: string;
  fetchImpl?: typeof fetch;
  resolver?: HostResolver;
}

/** Icon sources a machine path wrote; they render only once the operator leaves observe mode. */
const MACHINE_ICON_SOURCES: Record<string, true> = { 'logo-dev': true, platform: true, 'domain-asset': true };

/** Serves only a reviewed icon linked to the requested canonical employer. */
export async function companyIconResponse(
  encodedEmployerId: string,
  employers: CanonicalEmployerIconStore,
  documents: R2Bucket,
  dependencies: CompanyIconDependencies = {},
): Promise<Response> {
  let employerId: string;
  try { employerId = decodeURIComponent(encodedEmployerId); } catch { return notFound(); }
  if (!validCompanyIconEmployerId(employerId)) return notFound();

  const employer = await employers.getCanonicalEmployer(employerId);
  if (!employer) return notFound();
  if (employer.iconKey) {
    // A reviewer's icon always renders. An icon a machine stored — a cached
    // provider image, or the logo the employer uploaded to its ATS board — is
    // automatic, so observe mode must withhold it like any other automatic answer
    // rather than let a stored key route around the switch.
    if (MACHINE_ICON_SOURCES[employer.iconSource ?? ''] !== true) {
      return storedIconResponse(employer.iconKey, documents);
    }
    if (dependencies.automaticDisplay && await dependencies.automaticDisplay()) {
      return storedIconResponse(employer.iconKey, documents);
    }
  }
  return automaticIconResponse(employerId, dependencies);
}

async function storedIconResponse(iconKey: string, documents: R2Bucket): Promise<Response> {
  const object = await documents.get(iconKey);
  const contentType = object?.httpMetadata?.contentType?.toLowerCase();
  if (!object || !contentType || !PUBLIC_ICON_CONTENT_TYPES.has(contentType)) return notFound();

  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Security-Policy': 'sandbox',
    'X-Content-Type-Options': 'nosniff',
    // The public URL is stable even when the reviewed R2 key changes.
    // `must-revalidate` made every load after a minute block on the provider fetch
    // again. Stale-while-revalidate serves the cached icon at once and refreshes it
    // in the background, so a wrong-icon report still lands within about a minute
    // but a reader never waits for it.
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400',
  });
  if (object.size !== undefined) headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

/**
 * Renders an automatically resolved icon from the provider's own CDN.
 *
 * The credential stays on this origin: the client only ever sees
 * `/company-icons/:id`, so no provider token reaches a response, a catalog
 * payload, or a stored key. `fallback=404` keeps a provider-generated monogram
 * tile from being served as if it were a real logo, and the same short
 * revalidation window as a reviewed icon keeps a wrong-icon report effective
 * within a minute.
 */
async function automaticIconResponse(employerId: string, dependencies: CompanyIconDependencies): Promise<Response> {
  const { automaticDomain, automaticDisplay, logoDevImageToken, fetchImpl, resolver } = dependencies;
  if (!automaticDomain || !automaticDisplay || !logoDevImageToken || !resolver) return notFound();
  try {
    // The settings read and the resolution lookup sit inside the guard too: a
    // schema gap, a D1 hiccup, or a provider timeout must all degrade to the
    // client's monogram rather than to a broken image or a 500.
    if (!(await automaticDisplay())) return notFound();
    const domain = await automaticDomain(employerId);
    if (!domain) return notFound();
    const result = await safeFetchBytes(logoDevImageUrl(domain, logoDevImageToken), {
      resolver, fetcher: fetchImpl ?? fetch,
      timeoutMs: ICON_PROVIDER_TIMEOUT_MS, maxRedirects: 0, maxBodyBytes: MAX_ICON_ASSET_BYTES,
    });
    if (result.status < 200 || result.status >= 300) return notFound();
    const contentType = result.headers.get('content-type');
    if (!validIconAsset(contentType, result.body.byteLength)) return notFound();
    return new Response(result.body.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': contentType!.split(';')[0]!.trim().toLowerCase(),
        'Content-Security-Policy': 'sandbox',
        'X-Content-Type-Options': 'nosniff',
        // `must-revalidate` made every load after a minute block on the provider fetch
    // again. Stale-while-revalidate serves the cached icon at once and refreshes it
    // in the background, so a wrong-icon report still lands within about a minute
    // but a reader never waits for it.
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400',
      },
    });
  } catch {
    // A missing icon is the only externally visible outcome of any failure here.
    return notFound();
  }
}

function notFound() {
  return Response.json({ message: 'Company icon not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
