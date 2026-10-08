import { describe, expect, it } from 'vitest';
import { CatalogReconciler } from '../src/ingestion/catalog-reconciler.js';
import { buildPostingIdentity } from '../src/identity/posting.js';
import type { CatalogAdmission, ProcessedListing } from '../src/types.js';

const now = '2026-10-08T12:00:00.000Z';
function candidate(sourceId = 'simplify-summer-2026', externalId = 'new-url'): ProcessedListing {
  const applyUrl = 'https://fifththird.wd5.myworkdayjobs.com/en-US/53careers/job/Cincinnati-OH/Software-Engineer-Co-Op_R71588';
  const postingIdentity = buildPostingIdentity({ applicationUrl: applyUrl });
  const admission: CatalogAdmission = {
    employerResolution: 'source-reported', postingAttribution: 'attributed',
    destination: { candidateUrl: applyUrl, provider: 'workday', tenant: 'fifththird',
      expectedPostingId: 'r71588', inspectedAt: now, classification: 'posting-detail', closureState: 'open' },
    metadata: { complete: true, title: 'complete', location: 'complete' },
    catalogEligible: true, alertEligible: false, reasonCodes: ['employer-unresolved'],
    evidenceCodes: ['trusted-community-source'], evaluatedAt: now, evidenceObservedAt: now,
  };
  return { sourceId, externalId, document: 'README.md', sourceUrl: 'https://raw.githubusercontent.com/example/feed/main/README.md',
    row: 1, company: 'Fifth Third Bank', title: 'Software Engineer Co-Op', location: 'Cincinnati, OH',
    season: 'summer-2027', applyUrl, compensation: { raw: '' },
    requirements: { requiresUsCitizenship: false, advancedDegreeRequired: false },
    state: 'open', technical: true, fetchedAt: now, provenance: 'reviewed-community', admission, postingIdentity,
    postingIdentityDecision: { status: 'confirmed', exactKey: 'provider:workday:fifththird:r71588',
      evidenceKind: 'immutable-provider-id', provider: 'workday', tenant: 'fifththird',
      contractId: 'posting-provider-workday', contractVersion: 1, approvalReference: 'registry:workday:v1',
      evidenceHash: 'fixture-hash', observedAt: now } };
}

function scenario(options: { sameSource?: boolean; officialPrior?: boolean; modify?: (row: ProcessedListing) => void;
  priorGoneAt?: string; withdrawn?: boolean } = {}) {
  const reconciler = new CatalogReconciler();
  const prior = candidate(options.sameSource ? 'simplify-summer-2026' : 'speedyapply-2027-swe', 'old-url');
  prior.state = 'closed';
  if (options.officialPrior) prior.provenance = 'official-ats';
  if (options.priorGoneAt) prior.admission = { ...prior.admission!, catalogEligible: false,
    destination: { ...prior.admission!.destination, classification: 'gone', closureState: 'gone', inspectedAt: options.priorGoneAt } };
  const first = reconciler.reconcile({ sourceId: prior.sourceId, snapshotHash: 'old',
    activeExternalIds: new Set(['old-url']), listings: [prior], priorOccurrences: [], resolvedJobs: new Map(),
    now, baseline: true });
  const closed = first.jobs[0]!;
  expect(closed.open).toBe(false);
  const incoming = candidate(); options.modify?.(incoming);
  const result = reconciler.reconcile({ sourceId: incoming.sourceId, snapshotHash: 'new',
    activeExternalIds: new Set(['new-url']), listings: [incoming], priorOccurrences: [],
    resolvedJobs: new Map([['new-url', closed]]), now, baseline: true,
    ...(options.withdrawn ? { withdrawnPostingKeys: new Set(['workday:fifththird:r71588']) } : {}) });
  return { closed, result };
}

describe('verified trusted posting reappearance', () => {
  it.each([false, true])('reopens exact verified posting silently with a new occurrence (same source: %s)', sameSource => {
    const { closed, result } = scenario({ sameSource });
    expect(result.jobs[0]).toMatchObject({ jobId: closed.jobId, open: true, technical: true,
      notification: { smsPending: false, digestPending: false } });
    expect(result.occurrences[0]?.jobId).toBe(closed.jobId);
    expect(result.jobs[0]?.sourceReferences).toHaveLength(2);
    expect(result.notifications).toEqual([]); expect(result.newJobs).toEqual([]);
  });
  it('accepts fresh exact employer evidence after older community closure evidence', () => {
    expect(scenario({ priorGoneAt: '2026-10-04T12:00:00.000Z' }).result.jobs[0]?.open).toBe(true);
  });
  it.each(['unconfirmed', 'different-posting', 'different-tenant', 'different-provider', 'board', 'untrusted', 'future-inspection'] as const)(
    'keeps %s community arrival from reviving a closed role', variant => {
      const { result } = scenario({ modify: row => {
        if (variant === 'unconfirmed') delete row.postingIdentityDecision;
        if (variant === 'different-posting') row.postingIdentity = { ...row.postingIdentity!, providerPostingId: 'r-other' };
        if (variant === 'different-tenant') row.postingIdentity = { ...row.postingIdentity!, tenant: 'other-employer' };
        if (variant === 'different-provider') row.postingIdentity = { ...row.postingIdentity!, provider: 'greenhouse' };
        if (variant === 'board') row.admission = { ...row.admission!, destination: { ...row.admission!.destination, classification: 'aggregate-board' } };
        if (variant === 'untrusted') row.admission = { ...row.admission!, evidenceCodes: [] };
        if (variant === 'future-inspection') row.admission = { ...row.admission!, destination: { ...row.admission!.destination, inspectedAt: '2026-10-09T12:00:00.000Z' } };
      } });
      expect(result.jobs[0]?.open).toBe(false); expect(result.notifications).toEqual([]);
    });
  it('preserves an official source closure', () => {
    expect(scenario({ officialPrior: true }).result.jobs[0]?.open).toBe(false);
  });
  it('preserves newer known closure evidence', () => {
    expect(scenario({ priorGoneAt: '2026-10-08T11:30:00.000Z', modify: row => {
      row.admission = { ...row.admission!, destination: { ...row.admission!.destination, inspectedAt: '2026-10-08T11:00:00.000Z' } };
    } }).result.jobs[0]?.open).toBe(false);
  });
  it('preserves a reviewed withdrawn posting', () => {
    expect(scenario({ withdrawn: true }).result.jobs[0]?.open).toBe(false);
  });
});
