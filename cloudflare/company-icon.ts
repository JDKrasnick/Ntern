import type { CanonicalEmployer } from '../src/types.js';
import type { R2Bucket } from './types.js';

const COMPANY_ICON_ID = /^[a-z0-9][a-z0-9-]{0,159}$/u;
const PUBLIC_ICON_CONTENT_TYPES = new Set(['image/avif', 'image/png', 'image/svg+xml', 'image/webp']);

export interface CanonicalEmployerIconStore {
  getCanonicalEmployer(id: string): Promise<CanonicalEmployer | undefined>;
}

/** Serves only a reviewed icon linked to the requested canonical employer. */
export async function companyIconResponse(
  encodedEmployerId: string,
  employers: CanonicalEmployerIconStore,
  documents: R2Bucket,
): Promise<Response> {
  let employerId: string;
  try { employerId = decodeURIComponent(encodedEmployerId); } catch { return notFound(); }
  if (!COMPANY_ICON_ID.test(employerId)) return notFound();

  const employer = await employers.getCanonicalEmployer(employerId);
  if (!employer?.iconKey) return notFound();
  const object = await documents.get(employer.iconKey);
  const contentType = object?.httpMetadata?.contentType?.toLowerCase();
  if (!object || !contentType || !PUBLIC_ICON_CONTENT_TYPES.has(contentType)) return notFound();

  const headers = new Headers({
    'Content-Type': contentType,
    // Reviewed assets have versioned keys; an icon update gets a new key.
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  if (object.size !== undefined) headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

function notFound() { return Response.json({ message: 'Company icon not found' }, { status: 404 }); }
