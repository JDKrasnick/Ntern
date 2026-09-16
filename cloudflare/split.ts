import { createHash, timingSafeEqual } from 'node:crypto';

export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * Routes whose work mutates, inspects, or controls catalog ingestion. They stay
 * reachable at their established public paths, but only through the API Worker.
 */
export function isIngestionOperationPath(pathname: string): boolean {
  return pathname === '/internal/billing-shutdown'
    || pathname === '/internal/refresh-catalog'
    || pathname === '/internal/recover-notifications'
    || pathname === '/internal/catalog-quality-backfill'
    || pathname === '/internal/trusted-admission-backfill'
    || pathname === '/internal/posting-identity-repair'
    || pathname === '/internal/poll-source'
    || pathname === '/internal/backfill'
    || pathname.startsWith('/internal/admission/')
    || pathname.startsWith('/internal/role-metadata/')
    || pathname.startsWith('/internal/operations/')
    || pathname.startsWith('/operations/');
}

export function secretMatches(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
