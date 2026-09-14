import type { D1EmployerStore } from './employer-store.js';
import { reviewedAshbySources, type ReviewedAshbySource } from '../src/sources/ashby-config.js';
import { reviewedGreenhouseSources, type ReviewedGreenhouseSource } from '../src/sources/greenhouse-config.js';
import { reviewedLeverSources, type ReviewedLeverSource } from '../src/sources/lever-config.js';
import { verificationIsActive, type ReviewedSourceRecord } from '../src/employer-types.js';
import type { EmptyBoardAcknowledgement } from '../src/sources/reviewed-source.js';
import type { StructuredSourceConfig } from '../src/sources/structured/index.js';

/** Stable comparison for a stored JSON config versus the checked-in reviewed config. */
function configKey(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item);
}

/**
 * D1 stores reviewed config as JSON, so a declaration only reaches dispatch
 * when it survives this mapping. A malformed one is dropped and the row-count
 * guard stays armed.
 */
function acknowledgementField(value: unknown): { emptyBoardAcknowledged?: EmptyBoardAcknowledgement } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.acknowledgedBy !== 'string' || typeof candidate.acknowledgedAt !== 'string'
    || typeof candidate.reason !== 'string') return {};
  return { emptyBoardAcknowledged: {
    acknowledgedBy: candidate.acknowledgedBy, acknowledgedAt: candidate.acknowledgedAt, reason: candidate.reason,
  } };
}

function seededRecord(source: ReviewedGreenhouseSource | ReviewedLeverSource | ReviewedAshbySource, provider: 'greenhouse' | 'lever' | 'ashby'): ReviewedSourceRecord {
  const timestamp = 'admittedAt' in source ? source.admittedAt : new Date(0).toISOString();
  return {
    sourceId: source.id, provider, config: { ...source },
    evidence: { origin: 'checked-in-reviewed-registry', retained: true },
    state: source.status === 'published' ? 'active' : 'shadow', createdAt: timestamp, updatedAt: timestamp,
  };
}

/**
 * Reconcile the checked-in reviewed registry with D1, then dispatch from D1:
 * a missing record is seeded and a drifted, employer-unowned config is
 * refreshed, while lifecycle columns stay owned by D1 and the employer portal.
 */
export async function reviewedProviderRegistry(store: D1EmployerStore): Promise<{
  greenhouse: ReviewedGreenhouseSource[]; lever: ReviewedLeverSource[]; ashby: ReviewedAshbySource[];
}> {
  const current = await store.listReviewedSources();
  const byId = new Map(current.map((record) => [record.sourceId, record]));
  const checkedIn = [
    ...reviewedGreenhouseSources.map((source) => ['greenhouse', source] as const),
    ...reviewedLeverSources.map((source) => ['lever', source] as const),
    ...reviewedAshbySources.map((source) => ['ashby', source] as const),
  ];
  for (const [provider, source] of checkedIn) {
    const existing = byId.get(source.id);
    if (!existing) {
      await store.putReviewedSource(seededRecord(source, provider));
      continue;
    }
    // The checked-in registry owns reviewed config and D1 owns lifecycle state,
    // so a reviewed config change shipped in code has to refresh the stored row
    // or it never reaches dispatch. Employer-owned rows stay with the portal.
    if (existing.organizationId || configKey(existing.config) === configKey(source)) continue;
    await store.putReviewedSource({ ...existing, provider, config: { ...source }, updatedAt: new Date().toISOString() });
    console.log(JSON.stringify({ event: 'reviewed_source_config_refreshed', sourceId: source.id, provider }));
  }
  const candidates = await store.listReviewedSources(undefined, ['active', 'shadow']);
  const active = (await Promise.all(candidates.map(async (record) => {
    if (!record.organizationId) return record;
    const [organization, verification] = await Promise.all([store.getOrganization(record.organizationId), store.getVerification(record.organizationId)]);
    return organization?.state === 'active' && verificationIsActive(verification) ? record : undefined;
  }))).filter((record): record is ReviewedSourceRecord => Boolean(record));
  const records = (provider: ReviewedSourceRecord['provider']) => active.filter((record) => record.provider === provider);
  const greenhouse = (record: ReviewedSourceRecord): ReviewedGreenhouseSource | undefined => {
    const value = record.config;
    if (typeof value.id !== 'string' || typeof value.employerId !== 'string' || typeof value.displayName !== 'string'
      || !Array.isArray(value.aliases) || typeof value.boardToken !== 'string' || typeof value.careersUrl !== 'string'
      || !Array.isArray(value.expectedBoardNames) || typeof value.admittedBoardName !== 'string' || typeof value.admittedAt !== 'string'
      || !Array.isArray(value.allowedInitialHosts) || !Array.isArray(value.allowedFinalHosts)
      || (value.status !== 'shadow' && value.status !== 'published')) return undefined;
    return {
      ...acknowledgementField(value.emptyBoardAcknowledged),
      id: value.id, employerId: value.employerId, displayName: value.displayName,
      aliases: value.aliases.filter((item): item is string => typeof item === 'string'), boardToken: value.boardToken,
      careersUrl: value.careersUrl, expectedBoardNames: value.expectedBoardNames.filter((item): item is string => typeof item === 'string'),
      admittedBoardName: value.admittedBoardName, admittedAt: value.admittedAt,
      allowedInitialHosts: value.allowedInitialHosts.filter((item): item is string => typeof item === 'string'),
      allowedFinalHosts: value.allowedFinalHosts.filter((item): item is string => typeof item === 'string'), status: value.status,
      ...(typeof value.groupId === 'string' ? { groupId: value.groupId } : {}),
      ...(typeof value.hostExceptionReason === 'string' ? { hostExceptionReason: value.hostExceptionReason } : {}),
    };
  };
  const lever = (record: ReviewedSourceRecord): ReviewedLeverSource | undefined => {
    const value = record.config;
    if (typeof value.id !== 'string' || typeof value.company !== 'string' || typeof value.site !== 'string'
      || typeof value.careersUrl !== 'string' || typeof value.admittedAt !== 'string'
      || (value.status !== 'shadow' && value.status !== 'published') || value.region !== 'global'
      || (value.evidenceStatus !== 'agent-verified' && value.evidenceStatus !== 'legacy-review')) return undefined;
    return {
      ...acknowledgementField(value.emptyBoardAcknowledged),
      id: value.id, company: value.company, site: value.site, careersUrl: value.careersUrl, admittedAt: value.admittedAt,
      status: value.status, region: value.region, evidenceStatus: value.evidenceStatus,
    };
  };
  const ashby = (record: ReviewedSourceRecord): ReviewedAshbySource | undefined => {
    const value = record.config; const identity = value.identity;
    if (typeof value.id !== 'string' || typeof value.company !== 'string' || typeof value.careersUrl !== 'string'
      || typeof value.admittedAt !== 'string' || !identity || typeof identity !== 'object' || Array.isArray(identity)
      || !Array.isArray(value.allowedApplicationHosts) || (value.status !== 'shadow' && value.status !== 'published')) return undefined;
    const board = identity as Record<string, unknown>;
    if (board.provider !== 'ashby' || typeof board.boardKey !== 'string' || board.apiRegion !== 'global') return undefined;
    return {
      ...acknowledgementField(value.emptyBoardAcknowledged),
      id: value.id, company: value.company, identity: { provider: 'ashby', boardKey: board.boardKey, apiRegion: 'global' },
      careersUrl: value.careersUrl, admittedAt: value.admittedAt,
      evidenceState: value.evidenceState === 'ownership-verified' ? 'ownership-verified' : 'pending-review',
      allowedApplicationHosts: value.allowedApplicationHosts.flatMap((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).host === 'string'
        ? [{ host: (item as Record<string, unknown>).host as string }] : []),
      status: value.status,
    };
  };
  return {
    greenhouse: records('greenhouse').map(greenhouse).filter((value): value is ReviewedGreenhouseSource => Boolean(value)),
    lever: records('lever').map(lever).filter((value): value is ReviewedLeverSource => Boolean(value)),
    ashby: records('ashby').map(ashby).filter((value): value is ReviewedAshbySource => Boolean(value)),
  };
}

/** Return only operator-reviewed structured configurations that satisfy the runtime contract. */
export async function reviewedStructuredRegistry(store: D1EmployerStore): Promise<Array<StructuredSourceConfig & { status: 'shadow' | 'published' }>> {
  const candidates = await store.listReviewedSources(undefined, ['active', 'shadow']);
  const records = (await Promise.all(candidates.map(async (record) => {
    if (!record.organizationId) return record;
    const [organization, verification] = await Promise.all([store.getOrganization(record.organizationId), store.getVerification(record.organizationId)]);
    return organization?.state === 'active' && verificationIsActive(verification) ? record : undefined;
  }))).filter((record): record is ReviewedSourceRecord => Boolean(record));
  return records.flatMap((record): Array<StructuredSourceConfig & { status: 'shadow' | 'published' }> => {
    if (!['json-ld', 'sitemap', 'embedded'].includes(record.provider)) return [];
    const value = record.config;
    if (typeof value.id !== 'string' || typeof value.url !== 'string'
      || !value.employer || typeof value.employer !== 'object' || Array.isArray(value.employer)
      || !Array.isArray(value.allowedApplicationHosts)) return [];
    const employer = value.employer as Record<string, unknown>;
    if (typeof employer.name !== 'string') return [];
    const allowedApplicationHosts = value.allowedApplicationHosts.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const contract = item as Record<string, unknown>;
      if (typeof contract.host !== 'string') return [];
      return [{ host: contract.host, ...(contract.includeSubdomains === true ? { includeSubdomains: true } : {}),
        ...(typeof contract.pathPrefix === 'string' ? { pathPrefix: contract.pathPrefix } : {}) }];
    });
    if (!allowedApplicationHosts.length) return [];
    const kind = record.provider === 'sitemap' ? 'job-sitemap' as const : record.provider === 'embedded' ? 'embedded-json' as const : 'json-ld' as const;
    const embeddedValue = value.embedded;
    const embedded = embeddedValue && typeof embeddedValue === 'object' && !Array.isArray(embeddedValue)
      ? embeddedValue as Record<string, unknown> : undefined;
    if (kind === 'embedded-json' && (typeof embedded?.scriptId !== 'string' || !Array.isArray(embedded.jobsPath)
      || !embedded.jobsPath.every((item) => typeof item === 'string'))) return [];
    return [{
      id: value.id, kind, url: value.url,
      status: record.state === 'active' ? 'published' : 'shadow',
      employer: { ...(typeof employer.id === 'string' ? { id: employer.id } : {}), name: employer.name },
      allowedApplicationHosts,
      ...(kind === 'embedded-json' ? { embedded: { scriptId: embedded!.scriptId as string, jobsPath: embedded!.jobsPath as string[] } } : {}),
    }];
  });
}
