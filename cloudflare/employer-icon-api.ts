/**
 * Operations surface for automatic company-icon resolution.
 *
 * The normal path needs no human: an employer without a reviewed icon gets one
 * resolved in the background. This API exists for the three cases that do need a
 * person — confirming the resolver may run, forcing a re-look at one employer,
 * and reporting a wrong icon so the decision is withdrawn immediately and sorted
 * to the front of the review queue.
 */

import { validCompanyIconEmployerId } from './company-icon.js';
import { enqueueEmployerIconResolution } from './employer-icon-resolver.js';
import { employerNamesDomain, isIconTransportHost } from '../src/employer-icon-resolution.js';
import { normalizeCompanyDomain } from '../src/employer/domain.js';
import { registrableDomain } from '../src/core/registrable-domain.js';
import type { D1EmployerIconStore, EmployerIconMode } from './employer-icon-store.js';

const MAX_REVIEW_QUEUE = 50;
const ICON_MODES: Record<string, true> = { off: true, observe: true, resolve: true };

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function body(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A JSON object is required');
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function employerId(value: unknown): string {
  const id = optionalText(value, 160);
  if (!id) throw new Error('canonicalEmployerId is required');
  if (!validCompanyIconEmployerId(id)) throw new Error('canonicalEmployerId must use lowercase letters, digits, and hyphens');
  return id;
}

export interface EmployerIconProviderStatus {
  logoDev: boolean;
  brandfetch: boolean;
  tieBreaker: boolean;
}

export async function handleEmployerIconOperations(
  request: Request,
  store: D1EmployerIconStore,
  providerStatus: () => EmployerIconProviderStatus,
  now = () => new Date(),
  /** Confirms a real logo exists for an operator-supplied domain; absent means the route is unavailable. */
  verifyDomain?: (domain: string) => Promise<boolean>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const timestamp = now().toISOString();
  try {
    if (request.method === 'GET' && path === '/internal/admission/employer-icons') {
      const requested = Number(url.searchParams.get('limit'));
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_REVIEW_QUEUE) : 25;
      const [settings, counts, reviewQueue] = await Promise.all([
        store.settings(), store.counts(), store.reviewQueue(limit),
      ]);
      return json(200, { settings, counts, reviewQueue, providers: providerStatus() });
    }
    if (request.method === 'PUT' && path === '/internal/admission/employer-icons/settings') {
      const input = await body(request);
      const mode = input.mode === undefined ? undefined : String(input.mode);
      if (mode !== undefined && ICON_MODES[mode] !== true) throw new Error('mode must be off, observe, or resolve');
      const current = await store.settings();
      const maxPerSweep = Number.isSafeInteger(input.maxPerSweep) && Number(input.maxPerSweep) > 0
        ? Math.min(Number(input.maxPerSweep), 25) : current.maxPerSweep;
      // Retention may be enabled, or withdrawn, but never silently inherited from
      // a previous confirmation: the timestamp is the audit trail for licensing.
      const licensedAt = input.logoDevRetentionLicensedAt === undefined
        ? current.logoDevRetentionLicensedAt
        : optionalText(input.logoDevRetentionLicensedAt, 40);
      if (licensedAt !== undefined && !Number.isFinite(Date.parse(licensedAt))) {
        throw new Error('logoDevRetentionLicensedAt must be an ISO instant or null');
      }
      const settings = {
        mode: (mode ?? current.mode) as EmployerIconMode,
        maxPerSweep,
        ...(licensedAt ? { logoDevRetentionLicensedAt: new Date(licensedAt).toISOString() } : {}),
      };
      await store.putSettings(settings, timestamp);
      return json(200, { settings });
    }
    if (request.method === 'POST' && path === '/internal/admission/employer-icons/resolve') {
      const input = await body(request);
      const id = employerId(input.canonicalEmployerId);
      const context = await store.context(id);
      if (!context) throw new Error('Canonical employer was not found');
      // A person has now looked at whatever was reported, so a previously
      // withdrawn decision becomes eligible again on this request.
      const reopened = await store.reopen(id, timestamp);
      const tenant = optionalText(input.tenant, 300);
      const enqueued = await enqueueEmployerIconResolution(store, {
        canonicalEmployerId: id,
        displayName: context.displayName,
        roleTitle: optionalText(input.roleTitle, 200) ?? '',
        applicationUrl: optionalText(input.applicationUrl, 2_048) ?? '',
        provider: optionalText(input.provider, 80) ?? 'reviewed-registry',
        ...(tenant ? { tenant } : {}),
        sourceId: optionalText(input.sourceId, 300) ?? 'reviewed-registry',
      }, now());
      return json(202, { employerId: id, enqueued, reopened });
    }
    if (request.method === 'POST' && path === '/internal/admission/employer-icons/confirm') {
      const input = await body(request);
      const id = employerId(input.canonicalEmployerId);
      const context = await store.context(id);
      if (!context) throw new Error('Canonical employer was not found');
      const hostname = normalizeCompanyDomain(optionalText(input.domain, 253) ?? '');
      if (!hostname) throw new Error('domain must be a bare hostname such as example.com');
      // Verified and served through the same registrable domain, so what an
      // operator confirms is exactly what the read path later requests.
      const domain = registrableDomain(hostname);
      // A platform domain is refused unless it is this employer's own — Google may
      // confirm google.com, but nobody may confirm a board that hosts others.
      if (isIconTransportHost(domain) && !employerNamesDomain(context.displayName, domain)) {
        throw new Error('domain cannot be an ATS or job-board host');
      }
      if (!verifyDomain) throw new Error('Domain verification is not configured');
      // A person may confirm a domain, but never an unverified icon: the same
      // real-image gate that an automatic decision passes applies here too.
      if (!await verifyDomain(domain)) throw new Error('No real logo exists for that domain');
      await store.markConfirmed({
        canonicalEmployerId: id, domain,
        evidenceJson: JSON.stringify({
          version: 1, kind: 'confirmed', canonicalEmployerId: id, displayName: context.displayName.slice(0, 200),
          outcome: 'resolved', reasonCode: 'operator-confirmed', candidates: [{ domain, score: 1, signals: ['confirmed'] }],
        }),
        revalidateAt: new Date(Date.parse(timestamp) + 365 * 24 * 60 * 60 * 1_000).toISOString(),
        now: timestamp,
      });
      return json(200, { employerId: id, domain, confirmed: true });
    }
    if (request.method === 'POST' && path === '/internal/admission/employer-icons/report-wrong') {
      const input = await body(request);
      const id = employerId(input.canonicalEmployerId);
      const context = await store.context(id);
      if (!context) throw new Error('Canonical employer was not found');
      await store.invalidate(id, timestamp, optionalText(input.reason, 200) ?? 'wrong-icon-report');
      return json(200, { employerId: id, invalidated: true, reviewQueueFront: true });
    }
    return json(404, { message: 'Not found' });
  } catch (error) {
    return json(409, { message: error instanceof Error ? error.message : 'Employer icon operation failed' });
  }
}
