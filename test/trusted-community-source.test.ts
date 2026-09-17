import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrustedCommunitySourceMetrics } from '../src/types.js';
import simplifyBaselineReport from '../docs/trusted-community/simplify-summer-2026-baseline.json' with { type: 'json' };
import { deriveCanonicalAdmission, evaluateCatalogAdmission } from '../src/catalog-admission.js';
import { CatalogReconciler } from '../src/ingestion/catalog-reconciler.js';
import { Poller } from '../src/poll.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import { createApiHandler } from '../src/api.js';
import { defaultSources } from '../src/sources/github.js';
import { trustedCommunityBaselineReport } from '../src/sources/trusted-community-baseline.js';
import {
  activeTrustedCommunityPolicy,
  advanceTrustedCommunityQualification,
  effectiveAdmissionConfigurationVersion,
  sourceAdmissionPolicy,
  type TrustedCommunityAdmissionPolicy,
} from '../src/sources/trust-policy.js';
import {
  SIMPLIFY_TRUSTED_COMMUNITY_BASELINE,
  SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS,
  TRUSTED_COMMUNITY_BASELINES,
  trustedCommunityCircuitBreaches,
  trustedCommunityMetrics,
  trustedCommunityThresholds,
  trustedCommunityThresholdsFor,
} from '../src/sources/trusted-community-health.js';
import type {
  CatalogAdmission,
  DestinationEvidence,
  Internship,
  PostingIdentityDecision,
  ProcessedListing,
  SourceOccurrenceState,
  SourceAdapter,
  SourceFetchResult,
} from '../src/types.js';

const inspectedAt = '2026-09-04T12:00:00.000Z';
const policy: TrustedCommunityAdmissionPolicy = {
  trust: 'trusted-community', version: 'test-v2',
  catalogMode: 'validated-posting-specific-destination',
  alertMode: 'exact-identity-or-two-complete-snapshots',
};

function destination(overrides: Partial<DestinationEvidence> = {}): DestinationEvidence {
  return {
    classification: 'posting-detail',
    candidateUrl: 'https://careers.example.test/jobs/role-1?utm_source=simplify',
    finalUrl: 'https://careers.example.test/jobs/role-1',
    provider: 'unknown', expectedPostingId: 'role-1', inspectedAt,
    ...overrides,
  };
}

function unconfirmed(): PostingIdentityDecision {
  return { status: 'unconfirmed', reason: 'unrecognized-url-family', reviewFamilyKey: 'example.test/jobs', observedAt: inspectedAt };
}

function listing(overrides: Partial<ProcessedListing> = {}): ProcessedListing {
  return {
    sourceId: 'simplify-summer-2026', provenance: 'reviewed-community', externalId: 'README.md:https://careers.example.test/jobs/role-1',
    document: 'README.md', sourceUrl: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md', row: 12,
    company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
    applyUrl: 'https://careers.example.test/jobs/role-1', compensation: { raw: '' }, state: 'open', fetchedAt: inspectedAt,
    technical: true, postingIdentityDecision: unconfirmed(),
    employerEvidence: { authority: 'source-row' },
    providerIdentity: { provider: 'github', sourceId: 'simplify-summer-2026', sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', postingId: 'role-1' },
    metadataCompleteness: { complete: true, title: 'complete', location: 'complete' },
    ...overrides,
  };
}

function admission(alertEligible: boolean): CatalogAdmission {
  return {
    employerResolution: 'source-reported', postingAttribution: 'unattributed', destination: destination(),
    metadata: { complete: true, title: 'complete', location: 'complete' }, catalogEligible: true, alertEligible,
    reasonCodes: ['employer-unresolved', 'posting-unattributed'], evidenceCodes: ['trusted-community-source'],
    evaluatedAt: inspectedAt, evidenceObservedAt: inspectedAt,
  };
}

/** The reviewed community lists whose rows the trusted policy may admit. */
const COMMUNITY_LIST_IDS = [
  'vanshb03-summer-2027',
  'simplify-summer-2026',
  'speedyapply-2027-swe',
  'speedyapply-2027-ai',
  'northwestern-fintech-2027-quant',
  'canadian-tech-2027',
] as const;

/** Durable admission for one reviewed-community board polled through the real wire. */
async function pollCommunityBoard(sourceId: string, trustedCommunityCatalogEnabled: boolean) {
  const store = new MemoryInternshipStore();
  const boards = [['careers.example.test', 'role-1'], ['careers-2.example.test', 'role-2']] as const;
  const rows = boards.map(([host, postingId]) => {
    const applyUrl = `https://${host}/jobs/${postingId}`;
    return listing({ sourceId, externalId: `README.md:${applyUrl}`, applyUrl, title: `Software Engineering Intern ${postingId}`,
      providerIdentity: { provider: 'github', sourceId, sourceUrl: 'https://github.com/example/jobs', postingId } });
  });
  const adapter: SourceAdapter = { id: sourceId, async fetch(previous) {
    return { sourceId, listings: rows, rawRowCount: rows.length, notModified: false,
      checkpoint: { sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: rows.length } };
  } };
  const resolver = {
    async configurationVersion() { return 'registry-v1'; },
    async resolveCanonicalEmployer() { return undefined; },
    async resolveDestinationRule() { return undefined; },
  };
  const validate = async (url: string) => ({ url, evidence: { url, title: 'Software Engineering Intern', postingIdPresent: true,
    confidence: { score: 100, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: [] } } });
  await new Poller([adapter], store, () => new Date(inspectedAt), undefined, validate, false, undefined, resolver, true,
    trustedCommunityCatalogEnabled).poll();
  const admissions = [...store.jobs.values()].sort((left, right) => left.title.localeCompare(right.title))
    .map((job) => job.admission);
  return { store, admissions };
}

describe('trusted community source policy', () => {
  it('trusts every reviewed community list behind the catalog gate and nothing else', () => {
    // The reviewed set is the polled GitHub list registry; a list added there
    // needs its own reviewed policy entry before it may publish.
    expect(defaultSources.map((source) => source.id)).toEqual([...COMMUNITY_LIST_IDS]);
    for (const sourceId of COMMUNITY_LIST_IDS) {
      expect(sourceAdmissionPolicy(sourceId)).toEqual({
        trust: 'trusted-community',
        version: sourceId === 'simplify-summer-2026' ? 'simplify-trusted-community-v1' : `${sourceId}-trusted-community-v1`,
        catalogMode: 'validated-posting-specific-destination',
        alertMode: 'disabled',
        // The reviewed lists alarm on a floor breach instead of quarantining:
        // their boards are manually verified and anomalies are caught per posting.
        circuitBreaker: 'alert',
      });
      expect(activeTrustedCommunityPolicy(sourceId, false)).toBeUndefined();
      expect(activeTrustedCommunityPolicy(sourceId, true)).toEqual(sourceAdmissionPolicy(sourceId));
    }
    for (const sourceId of ['zapply-2027', 'greenhouse-figma', 'standard-review-fixture']) {
      expect(sourceAdmissionPolicy(sourceId)).toEqual({ trust: 'standard', version: 'standard-v1' });
      expect(activeTrustedCommunityPolicy(sourceId, true)).toBeUndefined();
    }
  });

  it('includes both source policy and catalog gate state in the effective configuration version', () => {
    const off = effectiveAdmissionConfigurationVersion({ sourceId: 'simplify-summer-2026', resolverVersion: 'registry-v1', trustedCommunityCatalogEnabled: false });
    const on = effectiveAdmissionConfigurationVersion({ sourceId: 'simplify-summer-2026', resolverVersion: 'registry-v1', trustedCommunityCatalogEnabled: true });
    expect(off).not.toBe(on);
    expect(effectiveAdmissionConfigurationVersion({ sourceId: 'ordinary', trustedCommunityCatalogEnabled: true })).toBeUndefined();
  });

  it('re-grades a newly listed community list while standard sources stay on the resolver version', () => {
    const sourceId = 'speedyapply-2027-ai';
    const resolverVersion = 'registry-v1';
    const dormant = effectiveAdmissionConfigurationVersion({ sourceId, resolverVersion, trustedCommunityCatalogEnabled: false });
    const enabled = effectiveAdmissionConfigurationVersion({ sourceId, resolverVersion, trustedCommunityCatalogEnabled: true });
    expect(dormant).toBe(resolverVersion);
    expect(enabled).not.toBe(resolverVersion);
    // Each list carries its own policy version, so one list's rollout does not
    // re-grade another's occurrences.
    expect(enabled).not.toBe(effectiveAdmissionConfigurationVersion({ sourceId: 'canadian-tech-2027', resolverVersion, trustedCommunityCatalogEnabled: true }));
    expect(effectiveAdmissionConfigurationVersion({ sourceId: 'zapply-2027', resolverVersion, trustedCommunityCatalogEnabled: true })).toBe(resolverVersion);
  });

  it.each(['posting-detail', 'application-form'] as const)(
    'admits a newly listed community list from source-reported evidence with a %s destination',
    (classification) => {
      const sourceId = 'northwestern-fintech-2027-quant';
      const trusted = activeTrustedCommunityPolicy(sourceId, true)!;
      const rowDestination = destination({ classification });
      const qualification = advanceTrustedCommunityQualification({ destination: rowDestination, postingIdentityDecision: unconfirmed(),
        alertMode: trusted.alertMode, completeFetchSequence: 1 });
      const admitted = evaluateCatalogAdmission({ listing: listing({ sourceId }), destination: rowDestination, postingAttributed: false,
        evaluatedAt: inspectedAt, trustedCommunity: { policy: trusted, qualification } });
      expect(admitted).toMatchObject({
        employerResolution: 'source-reported', catalogEligible: true, alertEligible: false,
        evidenceCodes: ['trusted-community-source'],
      });
      expect(admitted.canonicalEmployer).toBeUndefined();

      const unlisted = 'greenhouse-figma';
      expect(activeTrustedCommunityPolicy(unlisted, true)).toBeUndefined();
      const blocked = evaluateCatalogAdmission({ listing: listing({ sourceId: unlisted }), destination: rowDestination,
        postingAttributed: false, evaluatedAt: inspectedAt });
      expect(blocked).toMatchObject({ employerResolution: 'unresolved', catalogEligible: false });
      expect(blocked.reasonCodes).toContain('employer-unresolved');
    },
  );

  it('leaves a newly listed community list dormant while the catalog gate is off', async () => {
    const sourceId = 'canadian-tech-2027';
    const dormant = await pollCommunityBoard(sourceId, false);
    const control = await pollCommunityBoard('zapply-2027', false);
    // The gate-off deploy must resolve a newly listed source exactly like a
    // source that has no policy at all.
    expect(dormant.admissions).toHaveLength(2);
    expect(dormant.admissions).toEqual(control.admissions);
    for (const item of dormant.admissions) {
      expect(item).toMatchObject({ employerResolution: 'unresolved', catalogEligible: false, alertEligible: false });
      expect(item?.reasonCodes).toContain('employer-unresolved');
      expect(item?.evidenceCodes).toBeUndefined();
    }
    expect(await dormant.store.getCheckpoint(sourceId)).toMatchObject({ admissionConfigurationVersion: 'registry-v1' });
  });

  it('admits validated source-reported roles without inventing a canonical employer', () => {
    const qualification = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 1 });
    const result = evaluateCatalogAdmission({ listing: listing(), destination: destination(), postingAttributed: false, evaluatedAt: inspectedAt,
      trustedCommunity: { policy, qualification } });
    expect(result).toMatchObject({
      employerResolution: 'source-reported', catalogEligible: true, alertEligible: false,
      reasonCodes: ['employer-unresolved', 'posting-unattributed'], evidenceCodes: ['trusted-community-source'],
    });
    expect(result.canonicalEmployer).toBeUndefined();

    const canonical = evaluateCatalogAdmission({ listing: listing({ employerEvidence: { authority: 'reviewed-registry', canonicalEmployer: { id: 'acme', displayName: 'Acme' } } }),
      destination: destination(), postingAttributed: true, evaluatedAt: inspectedAt, trustedCommunity: { policy, qualification } });
    expect(canonical).toMatchObject({ employerResolution: 'resolved', canonicalEmployer: { id: 'acme' } });

    const sourceReported = { ...listing(), admission: result };
    const official = { ...listing({ sourceId: 'greenhouse-acme', provenance: 'official-ats', admission: canonical }), admission: canonical };
    expect(deriveCanonicalAdmission([sourceReported, official], inspectedAt)).toMatchObject({
      employerResolution: 'resolved', canonicalEmployer: { id: 'acme' },
    });
  });

  it('still blocks generic source-reported employer metadata', () => {
    const qualification = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(),
      alertMode: policy.alertMode, completeFetchSequence: 1 });
    const result = evaluateCatalogAdmission({ listing: listing({ company: 'External Careers' }), destination: destination(),
      postingAttributed: false, evaluatedAt: inspectedAt, trustedCommunity: { policy, qualification } });
    expect(result).toMatchObject({ employerResolution: 'source-reported', catalogEligible: false });
    expect(result.reasonCodes).toContain('employer-generic-label');
  });

  it.each(['aggregate-board', 'gone', 'blocked-uninspectable', 'unresolved'] as const)(
    'gives trusted roles no grace for a %s destination',
    (classification) => {
      const prior = admission(false);
      const nextDestination = destination({ classification });
      const qualification = advanceTrustedCommunityQualification({ destination: nextDestination, postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 2 });
      const result = evaluateCatalogAdmission({ listing: listing(), destination: nextDestination, postingAttributed: false,
        evaluatedAt: inspectedAt, previous: prior, trustedCommunity: { policy, qualification } });
      expect(result.catalogEligible).toBe(false);
      expect(result.reasonCodes).not.toContain('destination-grace');
    },
  );

  it('counts each complete fetch once, including unchanged bodies, and excludes 304/retry replays', () => {
    const first = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 7 });
    const retry = advanceTrustedCommunityQualification({ previous: first, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 7 });
    const notModified = advanceTrustedCommunityQualification({ previous: retry, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode });
    const second = advanceTrustedCommunityQualification({ previous: notModified, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 8 });
    const settled = advanceTrustedCommunityQualification({ previous: second, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 9 });
    expect(first).toMatchObject({ consecutiveCompleteSnapshots: 1, status: 'pending' });
    expect(retry.consecutiveCompleteSnapshots).toBe(1);
    expect(notModified.consecutiveCompleteSnapshots).toBe(1);
    expect(second).toMatchObject({ consecutiveCompleteSnapshots: 2, status: 'eligible', basis: 'two-complete-snapshots' });
    expect(settled).toMatchObject({ consecutiveCompleteSnapshots: 2, lastCountedSuccessfulFetchSequence: 8 });
  });

  it('restarts an unconfirmed qualification streak after a missing complete snapshot', () => {
    const first = advanceTrustedCommunityQualification({
      destination: destination(), postingIdentityDecision: unconfirmed(),
      alertMode: policy.alertMode, completeFetchSequence: 10,
    });
    const afterGap = advanceTrustedCommunityQualification({
      previous: first, destination: destination(), postingIdentityDecision: unconfirmed(),
      alertMode: policy.alertMode, completeFetchSequence: 12,
    });
    const adjacent = advanceTrustedCommunityQualification({
      previous: afterGap, destination: destination(), postingIdentityDecision: unconfirmed(),
      alertMode: policy.alertMode, completeFetchSequence: 13,
    });

    expect(afterGap).toMatchObject({
      consecutiveCompleteSnapshots: 1,
      lastCountedSuccessfulFetchSequence: 12,
      status: 'pending',
    });
    expect(afterGap.basis).toBeUndefined();
    expect(adjacent).toMatchObject({
      consecutiveCompleteSnapshots: 2,
      lastCountedSuccessfulFetchSequence: 13,
      status: 'eligible',
      basis: 'two-complete-snapshots',
    });
  });

  it('resets on a changed destination, fast-tracks exact identity, and preserves permanent baseline suppression', () => {
    const first = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 1, baselineSuppressed: true });
    const changed = advanceTrustedCommunityQualification({ previous: first, destination: destination({ candidateUrl: 'https://careers.example.test/jobs/role-2', finalUrl: 'https://careers.example.test/jobs/role-2' }), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 2 });
    expect(changed).toMatchObject({ consecutiveCompleteSnapshots: 1, status: 'pending', baselineSuppressed: true });

    const confirmed: PostingIdentityDecision = { status: 'confirmed', exactKey: 'provider:tenant:role-2', evidenceKind: 'immutable-provider-id', provider: 'greenhouse', tenant: 'acme', contractId: 'reviewed', contractVersion: 1, approvalReference: 'review', evidenceHash: 'hash', observedAt: inspectedAt };
    const exact = advanceTrustedCommunityQualification({ previous: changed, destination: changedDestination(), postingIdentityDecision: confirmed, alertMode: policy.alertMode, completeFetchSequence: 3 });
    expect(exact).toMatchObject({ status: 'eligible', basis: 'exact-identity', baselineSuppressed: true });
  });

  it('lets browser validation after the second snapshot use the same counted candidate history', () => {
    const unresolved = destination({ classification: 'unresolved', finalUrl: undefined });
    const first = advanceTrustedCommunityQualification({ destination: unresolved, postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 1 });
    const second = advanceTrustedCommunityQualification({ previous: first, destination: unresolved, postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 2 });
    const browser = advanceTrustedCommunityQualification({ previous: second, destination: destination(), postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode });
    expect(browser).toMatchObject({ consecutiveCompleteSnapshots: 2, status: 'eligible', basis: 'two-complete-snapshots' });
  });

  it('keeps browser publication suppressed until the complete migration clears it', () => {
    const migrating = advanceTrustedCommunityQualification({ destination: destination(), postingIdentityDecision: unconfirmed(),
      alertMode: policy.alertMode, completeFetchSequence: 1, catalogPublicationSuppressed: true });
    const browser = advanceTrustedCommunityQualification({ previous: migrating, destination: destination(),
      postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode });
    const held = evaluateCatalogAdmission({ listing: listing(), destination: destination(), postingAttributed: false,
      evaluatedAt: inspectedAt, trustedCommunity: { policy, qualification: browser } });
    expect(browser.catalogPublicationSuppressed).toBe(true);
    expect(held.catalogEligible).toBe(false);

    const completed = advanceTrustedCommunityQualification({ previous: browser, destination: destination(),
      postingIdentityDecision: unconfirmed(), alertMode: policy.alertMode, completeFetchSequence: 2,
      catalogPublicationSuppressed: false });
    expect(completed.catalogPublicationSuppressed).toBe(false);
    expect(evaluateCatalogAdmission({ listing: listing(), destination: destination(), postingAttributed: false,
      evaluatedAt: inspectedAt, trustedCommunity: { policy, qualification: completed } }).catalogEligible).toBe(true);
  });
});

// These suites include production-sized snapshots and multiple durable polls.
// Preserve full fixtures while allowing bounded headroom on shared runners.
describe('trusted community source health', { timeout: 20_000 }, () => {
  it('derives every route metric from technically eligible listings only', () => {
    const technicalExact = listing({
      applyUrl: 'https://jobs.lever.co/acme/role-1',
      providerIdentity: {
        provider: 'lever', sourceId: 'simplify-summer-2026',
        sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', tenant: 'acme', postingId: 'role-1',
      },
    });
    const technicalBrowser = listing({
      externalId: 'README.md:https://careers.example.test/openings',
      applyUrl: 'https://careers.example.test/openings',
    });
    const shelvedExact = listing({
      externalId: 'README.md:https://jobs.lever.co/acme/role-3',
      applyUrl: 'https://jobs.lever.co/acme/role-3',
      technical: false,
      providerIdentity: {
        provider: 'lever', sourceId: 'simplify-summer-2026',
        sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', tenant: 'acme', postingId: 'role-3',
      },
    });
    const report = trustedCommunityBaselineReport({
      sourceId: 'simplify-summer-2026',
      generatedAt: inspectedAt,
      sourcePolicyVersion: 'test-v1',
      processed: {
        listings: [technicalExact, technicalBrowser, shelvedExact],
        decisions: [],
        counts: { raw: 3, valid: 3, eligible: 2, shelved: 1, filtered: 0, withheld: 0 },
      },
      diagnostics: { rejectedAggregatorRows: 0, survivingAggregatorRows: 0, duplicateOccurrenceIds: 0 },
    });

    expect(report.counts).toMatchObject({
      technicallyEligibleRows: 2,
      exactRouteShapes: 1,
      browserInspectionCandidates: 1,
    });
    expect(report.rates).toMatchObject({ exactRouteShare: 0.5, browserInspectionShare: 0.5 });
  });

  it('derives explicit numeric thresholds from the recorded baseline', () => {
    expect(SIMPLIFY_TRUSTED_COMMUNITY_BASELINE).toEqual({
      rawRows: simplifyBaselineReport.counts.rawRows,
      eligibleRows: simplifyBaselineReport.counts.technicallyEligibleRows,
      destinationFailures: simplifyBaselineReport.counts.rejectedAggregatorRows,
      browserInspectionCandidates: simplifyBaselineReport.counts.browserInspectionCandidates,
      catalogAdmissions: simplifyBaselineReport.counts.technicallyEligibleRows,
      alertQualifications: simplifyBaselineReport.counts.exactRouteShapes,
    });
    expect(trustedCommunityThresholds(SIMPLIFY_TRUSTED_COMMUNITY_BASELINE)).toEqual(SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS);
    // The recorded thresholds came from the strict derivation. The loosened one
    // keeps the same count floors and raises only the rate ceilings: the recorded
    // rates were measured against eligible rows while the metrics measure against
    // inspected candidates, and the policy review on 2026-09-16 (after five of six
    // verified lists were quarantined) set a ten-point tolerance on those rates.
    expect(SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS.minimumRawRows).toBe(simplifyBaselineReport.thresholds.minimumRawRows);
    expect(SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS.minimumEligibleRows).toBe(simplifyBaselineReport.thresholds.minimumEligibleRows);
    expect(SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS.maximumDestinationFailureRate)
      .toBeGreaterThan(simplifyBaselineReport.thresholds.maximumDestinationFailureRate);
  });

  it('keeps each reviewed list’s inspection floor satisfiable by its own snapshot', () => {
    // A complete pass inspects the list's whole eligible snapshot, so a
    // family-sized floor of 100 candidates is unsatisfiable for a small list:
    // every wake re-inspected the same bounded slice, coverage never climbed to
    // the coverage floor, and the source could never leave quarantine.
    for (const [sourceId, baseline] of Object.entries(TRUSTED_COMMUNITY_BASELINES)) {
      const thresholds = trustedCommunityThresholdsFor(sourceId);
      const inspected = baseline.inspectedCandidates ?? baseline.eligibleRows;
      expect(thresholds.minimumInspectedCandidates).toBeLessThanOrEqual(baseline.eligibleRows);
      expect(trustedCommunityCircuitBreaches({
        metrics: {
          rawRows: baseline.rawRows,
          eligibleRows: baseline.eligibleRows,
          rejectedAggregatorRows: 0, survivingAggregatorRows: 0,
          duplicateOccurrenceIds: 0,
          inspectedCandidates: inspected,
          browserInspectionCandidates: baseline.browserInspectionCandidates ?? 0,
          destinationFailures: baseline.destinationFailures ?? 0, destinationFailuresByReason: {},
          inspectionCoverage: 1,
          browserInspectionShare: (baseline.browserInspectionCandidates ?? 0) / inspected,
          destinationFailureRate: (baseline.destinationFailures ?? 0) / inspected,
          catalogYield: (baseline.catalogAdmissions ?? 0) / baseline.rawRows,
          alertYield: (baseline.alertQualifications ?? 0) / baseline.eligibleRows,
        },
        thresholds,
        alertMode: 'disabled',
        requireCompleteInspection: true,
      })).toEqual([]);
    }
  });

  it('applies structural gates immediately and rate gates only at sufficient coverage', () => {
    const thresholds = SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS;
    const healthy = {
      rawRows: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.rawRows,
      eligibleRows: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.eligibleRows,
      rejectedAggregatorRows: 0, survivingAggregatorRows: 0,
      duplicateOccurrenceIds: 0,
      inspectedCandidates: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.eligibleRows,
      browserInspectionCandidates: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.browserInspectionCandidates,
      destinationFailures: 0, destinationFailuresByReason: {},
      inspectionCoverage: 1,
      browserInspectionShare: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.browserInspectionCandidates
        / SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.eligibleRows,
      destinationFailureRate: 0,
      catalogYield: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.catalogAdmissions
        / SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.rawRows,
      alertYield: SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.alertQualifications
        / SIMPLIFY_TRUSTED_COMMUNITY_BASELINE.eligibleRows,
    };
    expect(trustedCommunityCircuitBreaches({ metrics: healthy, alertMode: 'exact-identity-or-two-complete-snapshots' })).toEqual([]);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, duplicateOccurrenceIds: 1 }, alertMode: 'disabled' }))
      .toEqual([]);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, duplicateOccurrenceIds: 40 }, alertMode: 'disabled' }))
      .toEqual(['40 duplicate occurrence identity row(s)']);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, inspectedCandidates: 99, inspectionCoverage: 0.05,
      destinationFailureRate: 1, browserInspectionShare: 1, catalogYield: 0, alertYield: 0 }, alertMode: 'exact-identity-or-two-complete-snapshots' }))
      .toEqual([]);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, inspectedCandidates: 99, inspectionCoverage: 0.05 },
      alertMode: 'disabled', requireCompleteInspection: true })).toEqual([
      'inspected candidates 99 below 100',
      'inspection coverage 5.00% below 90.00%',
    ]);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, destinationFailureRate: 0.9 }, alertMode: 'disabled' }))
      .toContain('destination failure rate exceeded');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, rawRows: 0 }, alertMode: 'disabled' }))
      .toEqual(expect.arrayContaining(['parser returned zero rows', `raw rows 0 below ${thresholds.minimumRawRows}`]));
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, survivingAggregatorRows: 1 }, alertMode: 'disabled' }))
      .toContain('1 aggregator row(s) survived rejection');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, rawRows: thresholds.minimumRawRows - 1 }, alertMode: 'disabled' }))
      .toContain(`raw rows ${thresholds.minimumRawRows - 1} below ${thresholds.minimumRawRows}`);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, eligibleRows: thresholds.minimumEligibleRows - 1 }, alertMode: 'disabled' }))
      .toContain(`eligible rows ${thresholds.minimumEligibleRows - 1} below ${thresholds.minimumEligibleRows}`);
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, browserInspectionShare: 1 }, alertMode: 'disabled' }))
      .toContain('browser inspection share exceeded');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, catalogYield: 0 }, alertMode: 'disabled' }))
      .toContain('catalog yield fell below its floor');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, alertYield: 0 }, alertMode: 'disabled' }))
      .not.toContain('alert yield fell below its floor');
    expect(trustedCommunityCircuitBreaches({ metrics: { ...healthy, alertYield: 0 }, alertMode: 'exact-identity-or-two-complete-snapshots' }))
      .toContain('alert yield fell below its floor');
  });

  it('measures underlying catalog qualification while migration publication is suppressed', () => {
    const role = listing({ admission: { ...admission(false), catalogEligible: false },
      admissionConfigurationVersion: 'policy-v1', trustedCommunityAlertQualification: {
        candidateKey: 'https://careers.example.test/jobs/role-1', validatedDestinationKey: 'https://careers.example.test/jobs/role-1',
        consecutiveCompleteSnapshots: 1, status: 'disabled', baselineSuppressed: true, catalogPublicationSuppressed: true,
      } });
    const metrics = trustedCommunityMetrics({ rawRows: 1, eligibleRows: 1, listings: [role], priorOccurrences: [],
      eligibleExternalIds: new Set([role.externalId!]), admissionConfigurationVersion: 'policy-v1',
      rejectedAggregatorRows: 0, survivingAggregatorRows: 0, duplicateOccurrenceIds: 0 });
    expect(metrics.catalogYield).toBe(1);
  });

  it('excludes stale prior occurrences from current snapshot health metrics', () => {
    const current = listing({ externalId: 'README.md:https://careers.example.test/jobs/current' });
    const staleSuccess = listing({ externalId: 'README.md:https://careers.example.test/jobs/stale-success',
      admission: admission(false), admissionConfigurationVersion: 'policy-v1' });
    const staleFailure = listing({ externalId: 'README.md:https://careers.example.test/jobs/stale-failure',
      admission: { ...admission(false), catalogEligible: false,
        destination: destination({ classification: 'gone' }), reasonCodes: ['destination-gone'] },
      admissionConfigurationVersion: 'policy-v1' });
    const priorOccurrences = [staleSuccess, staleFailure].map((role): SourceOccurrenceState => ({
      sourceId: role.sourceId, externalId: role.externalId!, jobId: role.externalId!, occurrence: role,
      present: false, consecutiveOmissions: 1, changedSnapshotHash: 'prior', changedAt: inspectedAt,
    }));

    const metrics = trustedCommunityMetrics({
      rawRows: 1, eligibleRows: 1, listings: [], priorOccurrences,
      eligibleExternalIds: new Set([current.externalId!]), admissionConfigurationVersion: 'policy-v1',
      rejectedAggregatorRows: 0, survivingAggregatorRows: 0, duplicateOccurrenceIds: 0,
    });

    expect(metrics).toMatchObject({
      inspectedCandidates: 0, inspectionCoverage: 0, destinationFailures: 0,
      catalogYield: 0, alertYield: 0,
    });
  });

  it('alerts on a circuit breach for a reviewed list, advancing without publishing and without quarantining', async () => {
    const store = new MemoryInternshipStore();
    const adapter: SourceAdapter = {
      id: 'simplify-summer-2026',
      async fetch(previous): Promise<SourceFetchResult> {
        const second = listing({ externalId: 'README.md:https://jobs.other.test/role-2', company: 'Other',
          title: 'Data Engineering Intern', applyUrl: 'https://jobs.other.test/role-2' });
        return { sourceId: this.id, listings: [listing(), second], notModified: false,
          checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: 2 } };
      },
    };
    const resolver = { async configurationVersion() { return 'registry-v1'; },
      async resolveCanonicalEmployer() { return undefined; }, async resolveDestinationRule() { return undefined; } };
    await new Poller([adapter], store, () => new Date(inspectedAt), undefined, undefined, undefined, undefined,
      resolver, true, false).poll();
    const checkpoint = await store.getCheckpoint(adapter.id);
    const alerts: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { alerts.push(String(line)); });
    const breached = await new Poller([adapter], store, () => new Date('2026-09-04T12:10:00.000Z'), undefined,
      undefined, undefined, undefined, resolver, true, true).poll({ maxAdmissionMigrationListingsPerSourceRun: 0 });
    spy.mockRestore();
    // The reviewed lists alarm instead of quarantining, and the alert names the breach.
    expect(alerts.some((line) => line.includes('trusted_community_circuit_alert') && line.includes('simplify-summer-2026'))).toBe(true);
    expect(breached.failures).toEqual([]);
    // The pass still advances. A breach that withheld the continuation left any
    // list with a not-yet-complete inspection floor re-inspecting the same
    // bounded slice on every wake, so its coverage floor could never clear. The
    // success counters stay put: a breaching pass is not evidence of advance.
    expect(breached.continuationSources).toEqual([adapter.id]);
    expect((await store.getCheckpoint(adapter.id))?.successfulFetches).toBe(checkpoint?.successfulFetches);
    // Nothing a breaching pass saw may reach the catalog.
    expect(breached.filteredJobs.every((job) => job.admission?.catalogEligible !== true)).toBe(true);
    expect((await store.getSourceHealth(adapter.id))?.state).not.toBe('quarantined');
  });

  it('alerts on incomplete inspection coverage, publishing nothing and quarantining nothing', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'simplify-summer-2026';
    const { minimumRawRows, minimumEligibleRows } = SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS;
    const previous = {
      sourceId,
      successfulFetches: 1,
      lastRowCount: minimumEligibleRows,
      lastRawCount: minimumRawRows,
      contentHash: 'prior-snapshot',
      admissionConfigurationVersion: 'registry-v1',
    };
    await store.putCheckpoint(previous);
    const listings = Array.from({ length: minimumEligibleRows }, (_, index) => {
      const postingId = `role-${index}`;
      const host = index % 2 === 0 ? 'careers-a.example.test' : 'careers-b.example.test';
      return listing({
        externalId: `README.md:https://${host}/jobs/${postingId}`,
        row: index + 1,
        applyUrl: `https://${host}/jobs/${postingId}`,
        providerIdentity: {
          provider: 'github', sourceId, sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', postingId,
        },
      });
    });
    const adapter: SourceAdapter = {
      id: sourceId,
      async fetch(): Promise<SourceFetchResult> {
        return {
          sourceId,
          rawRowCount: minimumRawRows,
          listings,
          notModified: false,
          checkpoint: { sourceId, successfulFetches: 2, lastRowCount: listings.length, contentHash: 'current-snapshot' },
        };
      },
    };
    const resolver = {
      async configurationVersion() { return 'registry-v1'; },
      async resolveCanonicalEmployer(identity: ProcessedListing['providerIdentity']) {
        if (Number(identity!.postingId!.slice('role-'.length)) >= 100) throw new Error('fixture resolution failure');
        return undefined;
      },
      async resolveDestinationRule(identity: ProcessedListing['providerIdentity'], candidateUrl: string) {
        return {
          id: `rule-${identity!.postingId}`, host: new URL(candidateUrl).hostname, provider: 'github' as const,
          decision: 'standard-provider-route' as const, reviewedAt: inspectedAt, reviewedBy: 'test',
        };
      },
    };

    const alerts: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { alerts.push(String(line)); });
    const result = await new Poller([adapter], store, () => new Date(inspectedAt), undefined,
      undefined, undefined, undefined, resolver, true, true).poll({ maxAdmissionMigrationListingsPerSourceRun: minimumEligibleRows });
    spy.mockRestore();

    const inspectedCoverage = ((100 / minimumEligibleRows) * 100).toFixed(2);
    // The reviewed list alerts on the coverage breach and ends the delivery
    // without quarantining. Publication is gated per row by each occurrence's
    // own destination evidence, which this pass did inspect.
    expect(alerts.some((line) => line.includes('trusted_community_circuit_alert')
      && line.includes(`inspection coverage ${inspectedCoverage}% below 90.00%`))).toBe(true);
    // The fixture's own resolution failures are expected; the breach must not be
    // one of them, because an alert policy never fails the delivery.
    expect(result.failures.some((failure) => failure.includes('circuit breaker'))).toBe(false);
    // The pass advances so a later wake-up can finish the bounded inspection,
    // while publishing nothing: every listing it saw is withheld. Snapshot
    // bookkeeping moves; the success counters stay put.
    expect(result.continuationSources).toEqual([sourceId]);
    expect(await store.getCheckpoint(sourceId)).toMatchObject({
      contentHash: 'current-snapshot',
      successfulFetches: previous.successfulFetches,
    });
    expect(await store.listCatalog()).toEqual([]);
    expect((await store.getSourceHealth(sourceId))?.state).not.toBe('quarantined');
  });

  it('restarts qualification when an occurrence is absent from a complete source snapshot', async () => {
    const store = new MemoryInternshipStore();
    const sourceId = 'simplify-summer-2026';
    // Degenerate, floor-passing board for the same reason as `migrationFixture`:
    // a short snapshot is what this test manipulates, not a short board.
    const thresholds = trustedCommunityThresholdsFor(sourceId);
    const target = listing();
    const filler = Array.from({ length: thresholds.minimumEligibleRows }, (_, index) => {
      const postingId = `filler-${index}`;
      const applyUrl = `https://careers-${index % 2}.example.test/jobs/${postingId}`;
      return listing({
        externalId: `README.md:${applyUrl}`,
        row: index + 20,
        company: `Employer ${index}`,
        applyUrl,
        providerIdentity: {
          provider: 'github', sourceId,
          sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', postingId,
        },
      });
    });
    const snapshots = [
      [target, ...filler.slice(0, -1)],
      filler,
      [target, ...filler.slice(0, -1)],
      [target, ...filler.slice(0, -1)],
    ];
    let fetchIndex = 0;
    const adapter: SourceAdapter = {
      id: sourceId,
      async fetch(previous): Promise<SourceFetchResult> {
        const listings = snapshots[fetchIndex++]!;
        return {
          sourceId,
          rawRowCount: thresholds.minimumRawRows,
          listings,
          notModified: false,
          checkpoint: {
            sourceId,
            successfulFetches: (previous?.successfulFetches ?? 0) + 1,
            lastRowCount: listings.length,
            contentHash: `snapshot-${fetchIndex}`,
          },
        };
      },
    };
    const resolver = {
      async configurationVersion() { return 'registry-v1'; },
      async resolveCanonicalEmployer() { return undefined; },
      async resolveDestinationRule(identity: ProcessedListing['providerIdentity'], candidateUrl: string) {
        return {
          id: `rule-${identity!.postingId}`, host: new URL(candidateUrl).hostname,
          provider: 'github' as const, decision: 'standard-provider-route' as const,
          reviewedAt: inspectedAt, reviewedBy: 'test',
        };
      },
    };
    const poller = new Poller([adapter], store, () => new Date(inspectedAt), undefined,
      undefined, undefined, undefined, resolver, true, true);

    await poller.poll();
    await poller.poll();
    await poller.poll();
    const reappeared = (await store.getSourceOccurrences(sourceId))
      .find((occurrence) => occurrence.externalId === target.externalId);
    expect(reappeared?.occurrence.trustedCommunityAlertQualification).toMatchObject({
      consecutiveCompleteSnapshots: 1,
      lastCountedSuccessfulFetchSequence: 3,
    });
    expect(reappeared?.occurrence.trustedCommunityAlertQualification?.basis).toBeUndefined();
    expect(store.notificationEvents.size).toBe(0);

    await poller.poll();
    const adjacent = (await store.getSourceOccurrences(sourceId))
      .find((occurrence) => occurrence.externalId === target.externalId);
    expect(adjacent?.occurrence.trustedCommunityAlertQualification).toMatchObject({
      consecutiveCompleteSnapshots: 2,
      lastCountedSuccessfulFetchSequence: 4,
      basis: 'two-complete-snapshots',
    });
    expect(store.notificationEvents.size).toBe(0);
  });
});

function changedDestination() {
  return destination({ candidateUrl: 'https://careers.example.test/jobs/role-2', finalUrl: 'https://careers.example.test/jobs/role-2' });
}

function migrationFixture() {
  const store = new MemoryInternshipStore();
  const sourceId = 'simplify-summer-2026';
  // Deliberately degenerate board: the fixture is pinned to the floors its own
  // source is judged by, so these boundaries exercise the rollout machinery
  // rather than tripping a floor and ending the pass in the alert path.
  const thresholds = trustedCommunityThresholdsFor(sourceId);
  const rows = Array.from({ length: thresholds.minimumEligibleRows + 1 }, (_, index) => {
    const postingId = `role-${index}`;
    const applyUrl = `https://careers-${index % 2}.example.test/jobs/${postingId}`;
    return listing({ externalId: `README.md:${applyUrl}`, applyUrl, row: index + 1, company: `Employer ${index}`,
      providerIdentity: { provider: 'github', sourceId, sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', postingId } });
  });
  const state = { version: 'registry-v1', calls: 0, gone: false, aggregate: false, tick: 0, failFetch: false };
  const adapter: SourceAdapter = { id: sourceId, async fetch(previous) {
    if (state.failFetch) throw new Error('source unavailable');
    return { sourceId, listings: rows, rawRowCount: thresholds.minimumRawRows, notModified: false,
      checkpoint: { sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: rows.length } };
  } };
  const resolver = {
    async configurationVersion() { return state.version; },
    async resolveCanonicalEmployer() { return undefined; },
    async resolveDestinationRule(_identity: ProcessedListing['providerIdentity'], url: string) {
      return state.aggregate && url === rows[0]!.applyUrl ? {
        id: 'rejected', host: new URL(url).hostname, provider: 'github' as const, decision: 'aggregate-board' as const,
        reviewedAt: inspectedAt, reviewedBy: 'test',
      } : undefined;
    },
  };
  const validate = async (url: string) => {
    state.calls++;
    if (state.gone && url === rows[0]!.applyUrl) throw new Error('Application page returned HTTP 404');
    return { url, evidence: { url, title: 'Software Engineering Intern', postingIdPresent: true,
      confidence: { score: 100, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: [] } } };
  };
  const poll = (enabled: boolean, limit?: number) => new Poller([adapter], store,
    () => new Date(Date.parse(inspectedAt) + state.tick++ * 1000), undefined, validate, false, undefined, resolver, true, enabled)
    .poll({ maxAdmissionMigrationListingsPerSourceRun: limit });
  return { store, rows, state, poll, sourceId };
}

describe('trusted rollout repair boundaries', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(inspectedAt));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('revokes without upstream access and can reverse an interrupted rollback', async () => {
    const { store, rows, state, poll, sourceId } = migrationFixture();
    await poll(true);
    state.failFetch = true;
    const rollback = await poll(false, 1);
    expect(rollback.failures).toEqual([]);
    expect(rollback.continuationSources).toEqual([sourceId]);
    expect((await store.listCatalog()).length).toBe(rows.length - 1);
    expect((await store.getCheckpoint(sourceId))!.pendingAdmissionConfigurationVersion).toBeDefined();
    state.failFetch = false;
    const restored = await poll(true, 20);
    expect(restored.failures).toEqual([]);
    expect(restored.continuationSources).toEqual([]);
    expect(await store.listCatalog()).toHaveLength(rows.length);
    expect((await store.getCheckpoint(sourceId))!.pendingAdmissionConfigurationVersion).toBeUndefined();
    expect(store.notificationEvents.size).toBe(0);
  });

  it('retains independent official admission when revoking an absent trusted reference', async () => {
    const { store, rows, poll, sourceId } = migrationFixture();
    await poll(true);
    const target = rows.shift()!;
    const prior = (await store.getSourceOccurrences(sourceId)).find(item => item.externalId === target.externalId)!;
    const job = (await store.getJob(prior.jobId))!;
    const official = { ...prior.occurrence, sourceId: 'official-acme', externalId: 'official-role', provenance: 'official-ats' as const,
      admission: { ...admission(true), employerResolution: 'resolved' as const, canonicalEmployer: { id: 'acme', displayName: 'Acme' },
        evidenceCodes: undefined, postingAttribution: 'attributed' as const, reasonCodes: [] } };
    await store.putInternship({ ...job, sourceReferences: [...job.sourceReferences, official], admission: official.admission });
    await poll(false, 1);
    expect(await store.getJob(prior.jobId)).toMatchObject({ admission: { catalogEligible: true,
      canonicalEmployer: { id: 'acme' } }, firstSeenAt: job.firstSeenAt });
    expect((await store.getSourceOccurrences(sourceId)).find(item => item.externalId === target.externalId)!.occurrence.admission)
      .toMatchObject({ catalogEligible: false, alertEligible: false });
    expect(store.notificationEvents.size).toBe(0);
  });

  it.each([false, true])('keeps standard admission repairs silent with trusted gate=%s', async (enabled) => {
    const store = new MemoryInternshipStore();
    const sourceId = 'standard-review-fixture';
    const url = 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const role = listing({ sourceId, externalId: 'role-1', provenance: 'official-ats', applyUrl: url,
      providerIdentity: { provider: 'ashby', sourceId, sourceUrl: 'https://example.test/source', tenant: 'acme',
        postingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } });
    let mapped = false;
    const adapter: SourceAdapter = { id: sourceId, async fetch(previous) {
      return { sourceId, listings: [role], rawRowCount: 1, notModified: false,
        checkpoint: { sourceId, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: 1 } };
    } };
    const resolver = { async configurationVersion() { return mapped ? 'registry-v2' : 'registry-v1'; },
      async resolveCanonicalEmployer() { return mapped ? { id: 'acme', displayName: 'Acme' } : undefined; },
      async resolveDestinationRule() { return undefined; } };
    const validate = async () => ({ url, evidence: { url, title: role.title, postingIdPresent: true,
      confidence: { score: 100, level: 'high' as const, recommendation: 'alert-eligible' as const, signals: [] } } });
    const run = () => new Poller([adapter], store, () => new Date(mapped ? '2026-09-05T12:00:00Z' : inspectedAt),
      undefined, validate, false, undefined, resolver, true, enabled).poll();
    await run();
    expect([...store.jobs.values()][0]?.admission?.catalogEligible).toBe(false);
    mapped = true;
    const result = await run();
    expect(result.failures).toEqual([]);
    expect([...store.jobs.values()][0]).toMatchObject({ admission: { catalogEligible: true },
      notification: { smsPending: false, digestPending: false } });
    expect(result.newJobs).toEqual([]);
    expect(store.notificationEvents.size).toBe(0);
  });

  it('reopens settled occurrences after two omissions without changing identity or discovery history', async () => {
    const { store, rows, poll, sourceId } = migrationFixture();
    await poll(true);
    await poll(true);
    const target = rows.shift()!;
    const prior = (await store.getSourceOccurrences(sourceId)).find(item => item.externalId === target.externalId)!;
    const original = (await store.getJob(prior.jobId))!;
    await poll(true);
    await poll(true);
    expect((await store.getJob(prior.jobId))!.open).toBe(false);
    rows.unshift(target);
    await poll(true);
    expect((await store.getSourceOccurrences(sourceId)).find(item => item.externalId === target.externalId))
      .toMatchObject({ present: true, consecutiveOmissions: 0, jobId: prior.jobId, occurrence: { state: 'open' } });
    expect(await store.getJob(prior.jobId)).toMatchObject({ open: true, firstSeenAt: original.firstSeenAt,
      catalogVisibleAt: original.catalogVisibleAt, notification: { smsPending: false, digestPending: false } });
    expect(store.notificationEvents.size).toBe(0);
  });

  it.each(['open', 'closed'] as const)('revokes absent %s roles in bounded rollback slices', async (state) => {
    const { store, rows, poll, sourceId } = migrationFixture();
    await poll(true);
    const target = rows.shift()!;
    const prior = (await store.getSourceOccurrences(sourceId)).find(item => item.externalId === target.externalId)!;
    const original = (await store.getJob(prior.jobId))!;
    if (state === 'closed') { await poll(true); await poll(true); }
    const before = (await store.getSourceOccurrences(sourceId)).find(item => item.externalId === target.externalId)!;
    const first = await poll(false, 1);
    expect(first.continuationSources).toEqual([sourceId]);
    const after = (await store.getSourceOccurrences(sourceId)).find(item => item.externalId === target.externalId)!;
    expect(after).toMatchObject({ present: before.present, consecutiveOmissions: before.consecutiveOmissions,
      occurrence: { state, admission: { catalogEligible: false, alertEligible: false } } });
    const api = createApiHandler({ jobs: store, users: new MemoryUserStore(), identityUnconfirmedPublicationEnabled: true });
    expect((await api({ rawPath: `/jobs/${prior.jobId}`, requestContext: { http: { method: 'GET' } } })).statusCode).toBe(404);
    const final = await poll(false, rows.length);
    expect(final.failures).toEqual([]);
    expect(final.continuationSources).toEqual([]);
    expect(await store.listCatalog()).toEqual([]);
    expect(await store.getJob(prior.jobId)).toMatchObject({ firstSeenAt: original.firstSeenAt, catalogVisibleAt: original.catalogVisibleAt });
    expect(store.notificationEvents.size).toBe(0);
  });

  it('rolls back publication even before the gate-on migration checkpoint advances', async () => {
    const { store, rows, poll, sourceId } = migrationFixture();
    await poll(false);
    await poll(true, rows.length - 16);
    await poll(true, 20);
    expect(await store.listCatalog()).toHaveLength(20);
    expect((await store.getCheckpoint(sourceId))!.pendingAdmissionConfigurationVersion).toBeDefined();
    const rollback = await poll(false, rows.length);
    expect(rollback.failures).toEqual([]);
    expect(rollback.continuationSources).toEqual([]);
    expect(await store.listCatalog()).toEqual([]);
    expect((await store.getCheckpoint(sourceId))!.pendingAdmissionConfigurationVersion).toBeUndefined();
    expect(store.notificationEvents.size).toBe(0);
  });

  it('collects evidence and publishes in bounded slices without probing completed rows again', async () => {
    const { store, rows, state, poll, sourceId } = migrationFixture();
    await poll(false);
    const parserCheckpoint = (await store.getCheckpoint(sourceId))!;
    await store.putCheckpoint({ ...parserCheckpoint, metadataExtractionVersion: 0 });
    const oldVersion = (await store.getCheckpoint(sourceId))!.admissionConfigurationVersion;
    const initial = await poll(true, rows.length - 16);
    expect(initial.failures).toEqual([]);
    expect(initial.continuationSources).toEqual([sourceId]);
    expect(await store.listCatalog()).toEqual([]);
    const before = state.calls;
    const finalEvidence = await poll(true, 20);
    expect(finalEvidence.failures).toEqual([]);
    expect(state.calls - before).toBe(16);
    expect((await store.listCatalog()).length).toBe(20);
    expect((await store.getCheckpoint(sourceId))!.admissionConfigurationVersion).toBe(oldVersion);
    expect(finalEvidence.continuationSources).toEqual([sourceId]);
    // A source edit during publication invalidates only that row's evidence.
    const beforeChange = state.calls;
    rows[50]!.title = 'Data Engineering Intern';
    const changed = await poll(true, 20);
    expect(changed.failures).toEqual([]);
    expect(state.calls - beforeChange).toBe(1);
    const afterEvidence = state.calls;
    let continuation = changed.continuationSources;
    for (let slice = 0; continuation.length && slice < 10; slice++) {
      const count = (await store.listCatalog()).length;
      const result = await poll(true, 200);
      expect(result.failures).toEqual([]);
      expect((await store.listCatalog()).length - count).toBeLessThanOrEqual(200);
      continuation = result.continuationSources;
    }
    expect(continuation).toEqual([]);
    expect(state.calls).toBe(afterEvidence);
    expect(await store.listCatalog()).toHaveLength(rows.length);
    const changedOccurrence = (await store.getSourceOccurrences(sourceId)).find(item => item.externalId === rows[50]!.externalId)!;
    expect(changedOccurrence.occurrence.title).toBe('Data Engineering Intern');
    expect((await store.getCheckpoint(sourceId))!.admissionConfigurationVersion).not.toBe(oldVersion);
    // The shared bounded pass inspected every current row before either
    // checkpoint advanced, so the parser version is now certified too.
    expect((await store.getCheckpoint(sourceId))!.metadataExtractionVersion).toBe(ROLE_METADATA_EXTRACTION_VERSION);
    expect(store.notificationEvents.size).toBe(0);
  });

  it.each(['gone', 'aggregate'] as const)('withdraws a cached good destination after fresh %s evidence', async (kind) => {
    const { store, rows, state, poll, sourceId } = migrationFixture();
    await poll(true);
    const prior = (await store.getSourceOccurrences(sourceId)).find(item => item.externalId === rows[0]!.externalId)!;
    expect((await store.getJob(prior.jobId))!.admission!.catalogEligible).toBe(true);
    state.version = 'registry-v2';
    state[kind] = true;
    await poll(true);
    const job = (await store.getJob(prior.jobId))!;
    expect(job.admission).toMatchObject({ catalogEligible: false, destination: { classification: kind === 'gone' ? 'gone' : 'aggregate-board' } });
    expect((await store.listCatalog()).some(item => item.jobId === job.jobId)).toBe(false);
    expect((await store.getSourceHealth(sourceId))!.trustedCommunity!.destinationFailures).toBe(1);
    expect(store.notificationEvents.size).toBe(0);
  });
});

describe('trusted community delayed promotion', () => {
  it.each(['closed', 'baseline', 'identity-hidden', 'filtered', 'unverified', 'nontechnical'] as const)(
    'keeps %s delayed roles out of the outbox and reported new jobs', (condition) => {
      const reconciler = new CatalogReconciler();
      const role = listing({ admission: { ...admission(false), catalogEligible: false },
        trustedCommunityAlertQualification: { candidateKey: destination().candidateUrl, status: 'eligible',
          consecutiveCompleteSnapshots: 2, baselineSuppressed: false, basis: 'two-complete-snapshots' },
        ...(condition === 'closed' ? { state: 'closed' } : {}),
        ...(condition === 'nontechnical' ? { technical: false } : {}),
      });
      const first = reconciler.reconcile({ sourceId: role.sourceId, snapshotHash: 'one', activeExternalIds: new Set([role.externalId!]),
        listings: [role], priorOccurrences: [], resolvedJobs: new Map(), now: inspectedAt, baseline: true });
      const result = reconciler.reconcile({ sourceId: role.sourceId, snapshotHash: 'two', activeExternalIds: new Set([role.externalId!]),
        listings: [{ ...role, admission: admission(true) }], priorOccurrences: first.occurrences,
        resolvedJobs: new Map([[role.externalId!, first.jobs[0]!]]), now: '2026-09-05T12:00:00Z',
        baseline: condition === 'baseline', publishUnconfirmedIdentities: condition !== 'identity-hidden', trustedCommunityAlertsEnabled: true,
        ...(condition === 'filtered' ? { filter: { includeKeywords: ['unmatchable'] } } : {}),
        ...(condition === 'unverified' ? { alertEligible: new Set<string>() } : {}),
      });
      expect(result.notifications).toEqual([]);
      expect(result.newJobs).toEqual([]);
      expect(result.jobs[0]?.notification).toMatchObject({ smsPending: false, digestPending: false });
    },
  );

  it('preserves first visibility when a previously published role is hidden and readmitted', () => {
    const reconciler = new CatalogReconciler();
    const role = listing({ admission: admission(false) });
    const first = reconciler.reconcile({ sourceId: role.sourceId, snapshotHash: 'one', activeExternalIds: new Set([role.externalId!]),
      listings: [role], priorOccurrences: [], resolvedJobs: new Map(), now: inspectedAt, baseline: true });
    const hidden = { ...first.jobs[0]!, admission: { ...admission(false), catalogEligible: false } };
    const next = reconciler.reconcile({ sourceId: role.sourceId, snapshotHash: 'two', activeExternalIds: new Set([role.externalId!]),
      listings: [role], priorOccurrences: first.occurrences, resolvedJobs: new Map([[role.externalId!, hidden]]),
      now: '2026-09-05T12:00:00Z', baseline: false });
    expect(next.jobs[0]).toMatchObject({ catalogVisibleAt: inspectedAt, catalogRecency: 'baseline', firstSeenAt: inspectedAt });
  });

  it('creates one deterministic event only on the first eligible transition', () => {
    const reconciler = new CatalogReconciler();
    const initialListing = listing({ admission: { ...admission(false), catalogEligible: false }, trustedCommunityAlertQualification: {
      candidateKey: 'https://careers.example.test/jobs/role-1', validatedDestinationKey: 'https://careers.example.test/jobs/role-1',
      consecutiveCompleteSnapshots: 1, lastCountedSuccessfulFetchSequence: 1, status: 'pending', baselineSuppressed: false,
    } });
    const first = reconciler.reconcile({ sourceId: initialListing.sourceId, snapshotHash: 'one', activeExternalIds: new Set([initialListing.externalId!]),
      listings: [initialListing], priorOccurrences: [], resolvedJobs: new Map(), now: inspectedAt, baseline: true });
    const existing = first.jobs[0]!;
    const prior = first.occurrences[0]!;
    const promotedListing = listing({ admission: admission(true), trustedCommunityAlertQualification: {
      ...initialListing.trustedCommunityAlertQualification!, consecutiveCompleteSnapshots: 2, lastCountedSuccessfulFetchSequence: 2,
      status: 'eligible', basis: 'two-complete-snapshots',
    } });
    const dormant = reconciler.reconcile({ sourceId: promotedListing.sourceId, snapshotHash: 'two', activeExternalIds: new Set([promotedListing.externalId!]),
      listings: [promotedListing], priorOccurrences: [prior], resolvedJobs: new Map([[promotedListing.externalId!, existing]]),
      now: '2026-09-05T12:00:00.000Z', baseline: false, trustedCommunityAlertsEnabled: false });
    expect(dormant.notifications).toEqual([]);
    expect(dormant.jobs[0]?.notification).toMatchObject({ smsPending: false, digestPending: false });
    const promoted = reconciler.reconcile({ sourceId: promotedListing.sourceId, snapshotHash: 'two', activeExternalIds: new Set([promotedListing.externalId!]),
      listings: [promotedListing], priorOccurrences: [prior], resolvedJobs: new Map([[promotedListing.externalId!, existing]]), now: '2026-09-05T12:00:00.000Z', baseline: false, trustedCommunityAlertsEnabled: true });
    expect(promoted.notifications).toHaveLength(1);
    expect(promoted.jobs[0]).toMatchObject({ firstSeenAt: inspectedAt, catalogRecency: 'normal',
      notification: { smsPending: true, digestPending: true } });

    const replay = reconciler.reconcile({ sourceId: promotedListing.sourceId, snapshotHash: 'three', activeExternalIds: new Set([promotedListing.externalId!]),
      listings: [promotedListing], priorOccurrences: promoted.occurrences, resolvedJobs: new Map([[promotedListing.externalId!, promoted.jobs[0]!]]), now: '2026-09-06T12:00:00.000Z', baseline: false, trustedCommunityAlertsEnabled: true });
    expect(replay.notifications).toHaveLength(0);
  });

  it('never promotes a baseline-suppressed occurrence', () => {
    const reconciler = new CatalogReconciler();
    const priorAdmission = { ...admission(false), catalogEligible: false };
    const role = listing({ admission: admission(true), trustedCommunityAlertQualification: {
      candidateKey: 'https://careers.example.test/jobs/role-1', validatedDestinationKey: 'https://careers.example.test/jobs/role-1',
      consecutiveCompleteSnapshots: 2, lastCountedSuccessfulFetchSequence: 2, status: 'eligible', basis: 'two-complete-snapshots', baselineSuppressed: true,
    } });
    const existing: Internship = { jobId: 'job-1', company: role.company, title: role.title, location: role.location, season: role.season,
      applyUrl: role.applyUrl, normalizedUrl: role.applyUrl, fingerprint: 'fp', compensation: { raw: '' }, sourceReferences: [], technical: true,
      open: true, admission: priorAdmission, firstSeenAt: inspectedAt, lastSeenAt: inspectedAt, notification: { smsPending: false, digestPending: false } };
    const prior: SourceOccurrenceState = { sourceId: role.sourceId, externalId: role.externalId!, jobId: existing.jobId,
      occurrence: { ...role, admission: priorAdmission }, present: true, consecutiveOmissions: 0, changedSnapshotHash: 'one', changedAt: inspectedAt };
    existing.sourceReferences = [prior.occurrence];
    const result = reconciler.reconcile({ sourceId: role.sourceId, snapshotHash: 'two', activeExternalIds: new Set([role.externalId!]), listings: [role],
      priorOccurrences: [prior], resolvedJobs: new Map([[role.externalId!, existing]]), now: '2026-09-05T12:00:00.000Z', baseline: false, trustedCommunityAlertsEnabled: true });
    expect(result.notifications).toHaveLength(0);
    expect(result.jobs[0]).toMatchObject({ catalogRecency: 'baseline' });
  });

  it('does not promote when the final canonical admission remains hidden by an official employer conflict', () => {
    const reconciler = new CatalogReconciler();
    const priorAdmission = { ...admission(false), catalogEligible: false };
    const role = listing({ admission: admission(true), trustedCommunityAlertQualification: {
      candidateKey: 'https://careers.example.test/jobs/role-1', validatedDestinationKey: 'https://careers.example.test/jobs/role-1',
      consecutiveCompleteSnapshots: 2, lastCountedSuccessfulFetchSequence: 2, status: 'eligible',
      basis: 'two-complete-snapshots', baselineSuppressed: false,
    } });
    const trustedReference = { ...role, admission: priorAdmission };
    const officialAdmission = (id: string): CatalogAdmission => ({
      ...admission(true), canonicalEmployer: { id, displayName: id }, employerResolution: 'resolved',
      postingAttribution: 'attributed', reasonCodes: [], evidenceCodes: undefined,
    });
    const officialA = { ...trustedReference, sourceId: 'official-a', externalId: 'official-a',
      provenance: 'official-ats' as const, admission: officialAdmission('employer-a') };
    const officialB = { ...trustedReference, sourceId: 'official-b', externalId: 'official-b',
      provenance: 'official-structured' as const, admission: officialAdmission('employer-b') };
    const existing: Internship = {
      jobId: 'job-1', company: role.company, title: role.title, location: role.location, season: role.season,
      applyUrl: role.applyUrl, normalizedUrl: role.applyUrl, fingerprint: 'fp', compensation: { raw: '' },
      sourceReferences: [trustedReference, officialA, officialB], technical: true, open: true,
      admission: { ...priorAdmission, employerResolution: 'conflict', catalogEligible: false, alertEligible: false,
        reasonCodes: ['employer-conflict'] },
      firstSeenAt: inspectedAt, lastSeenAt: inspectedAt,
      notification: { smsPending: false, digestPending: false },
    };
    const prior: SourceOccurrenceState = {
      sourceId: role.sourceId, externalId: role.externalId!, jobId: existing.jobId,
      occurrence: trustedReference, present: true, consecutiveOmissions: 0,
      changedSnapshotHash: 'one', changedAt: inspectedAt,
    };

    const result = reconciler.reconcile({
      sourceId: role.sourceId, snapshotHash: 'two', activeExternalIds: new Set([role.externalId!]),
      listings: [role], priorOccurrences: [prior], resolvedJobs: new Map([[role.externalId!, existing]]),
      now: '2026-09-05T12:00:00.000Z', baseline: false, trustedCommunityAlertsEnabled: true,
    });

    expect(result.jobs[0]).toMatchObject({
      admission: { catalogEligible: false, alertEligible: false },
      notification: { smsPending: false, digestPending: false },
    });
    expect(result.jobs[0]?.admission?.reasonCodes).toContain('employer-conflict');
    expect(result.notifications).toHaveLength(0);
  });
});

describe('per-source trusted community floors', () => {
  const observedMetrics = (sourceId: string): TrustedCommunitySourceMetrics => {
    const baseline = TRUSTED_COMMUNITY_BASELINES[sourceId]!;
    return {
      rawRows: baseline.rawRows,
      eligibleRows: baseline.eligibleRows,
      rejectedAggregatorRows: 0,
      survivingAggregatorRows: 0,
      duplicateOccurrenceIds: 3,
      inspectedCandidates: baseline.inspectedCandidates!,
      browserInspectionCandidates: baseline.browserInspectionCandidates,
      destinationFailures: baseline.destinationFailures,
      destinationFailuresByReason: {},
      inspectionCoverage: 0.9,
      browserInspectionShare: baseline.browserInspectionCandidates / baseline.inspectedCandidates!,
      destinationFailureRate: baseline.destinationFailures / baseline.inspectedCandidates!,
      catalogYield: baseline.catalogAdmissions / baseline.rawRows,
      alertYield: 0,
    };
  };

  it.each(Object.keys(TRUSTED_COMMUNITY_BASELINES))(
    'admits the verified %s list against its own observed shape',
    (sourceId) => {
      // The family preset demanded 1,456 raw rows of every list; each of these
      // was quarantined by a floor measured on a board four times its size. The
      // structural inspection gate is a global constant rather than a per-source
      // floor — a 71-row board cannot report 100 inspected candidates — so it is
      // asserted by the gate test above and left out of this one.
      expect(trustedCommunityCircuitBreaches({
        metrics: observedMetrics(sourceId),
        thresholds: trustedCommunityThresholdsFor(sourceId),
        alertMode: 'disabled',
      })).toEqual([]);
    },
  );

  it('still breaches when a list genuinely degrades', () => {
    const sourceId = 'canadian-tech-2027';
    const thresholds = trustedCommunityThresholdsFor(sourceId);
    const metrics = observedMetrics(sourceId);
    const breachesFor = (patch: Partial<TrustedCommunitySourceMetrics>) => trustedCommunityCircuitBreaches({
      metrics: { ...metrics, ...patch }, thresholds, alertMode: 'disabled', requireCompleteInspection: true,
    });

    expect(breachesFor({ rawRows: 0 })).toContain('parser returned zero rows');
    expect(breachesFor({ survivingAggregatorRows: 1 })).toContain('1 aggregator row(s) survived rejection');
    expect(breachesFor({ rawRows: 10, eligibleRows: 10 })).toEqual(expect.arrayContaining([
      expect.stringContaining('raw rows 10 below'), expect.stringContaining('eligible rows 10 below'),
    ]));
    expect(breachesFor({ catalogYield: 0.05 })).toContain('catalog yield fell below its floor');
    // The metrics carry the rate as measured; a failure spike has to move both.
    expect(breachesFor({ destinationFailures: Math.ceil(metrics.inspectedCandidates * 0.6), destinationFailureRate: 0.6 }))
      .toContain('destination failure rate exceeded');
  });

  it('falls back to the family preset for a source without a baseline', () => {
    expect(trustedCommunityThresholdsFor('unobserved-list-2027')).toEqual(SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS);
  });

  it('pins the alert-only breaker to the six reviewed lists and blocks everything else', () => {
    // The reviewed set and the measured set are the same six lists; a list that
    // were measured but not reviewed would silently keep blocking.
    expect(Object.keys(TRUSTED_COMMUNITY_BASELINES).sort()).toEqual([
      'canadian-tech-2027', 'northwestern-fintech-2027-quant', 'simplify-summer-2026',
      'speedyapply-2027-ai', 'speedyapply-2027-swe', 'vanshb03-summer-2027',
    ]);
    for (const sourceId of Object.keys(TRUSTED_COMMUNITY_BASELINES)) {
      expect(sourceAdmissionPolicy(sourceId)).toMatchObject({ trust: 'trusted-community', circuitBreaker: 'alert' });
    }
    // The field is an explicit opt-in: anything unreviewed quarantines on breach.
    expect(sourceAdmissionPolicy('unreviewed-list-2027')).not.toHaveProperty('circuitBreaker');
  });
});
