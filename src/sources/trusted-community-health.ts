import simplifyBaselineReport from '../../docs/trusted-community/simplify-summer-2026-baseline.json' with { type: 'json' };
import type {
  CatalogAdmissionReason,
  ProcessedListing,
  SourceOccurrenceState,
  TrustedCommunityAlertMode,
  TrustedCommunitySourceMetrics,
} from '../types.js';

export interface TrustedCommunityBaseline {
  rawRows: number;
  eligibleRows: number;
  destinationFailures: number;
  browserInspectionCandidates: number;
  catalogAdmissions: number;
  alertQualifications: number;
  /** Occurrences the baseline pass could inspect. The rate gates are measured
   * against inspected candidates, so a baseline has to carry the same
   * denominator the metrics use. */
  inspectedCandidates?: number;
}

export interface TrustedCommunityThresholds {
  minimumRawRows: number;
  minimumEligibleRows: number;
  minimumInspectedCandidates: number;
  minimumInspectionCoverage: number;
  maximumDestinationFailureRate: number;
  maximumBrowserInspectionShare: number;
  minimumCatalogYield: number;
  minimumAlertYield: number;
}

export const SIMPLIFY_TRUSTED_COMMUNITY_BASELINE: TrustedCommunityBaseline = {
  rawRows: simplifyBaselineReport.counts.rawRows,
  eligibleRows: simplifyBaselineReport.counts.technicallyEligibleRows,
  destinationFailures: simplifyBaselineReport.counts.rejectedAggregatorRows,
  browserInspectionCandidates: simplifyBaselineReport.counts.browserInspectionCandidates,
  catalogAdmissions: simplifyBaselineReport.counts.technicallyEligibleRows,
  alertQualifications: simplifyBaselineReport.counts.exactRouteShapes,
};

/**
 * Floors come from the source's own baseline. Absolute floors only fit the board
 * they were measured on: on 2026-09-16 the family preset demanded 1,456 raw rows
 * and a 5% destination-failure rate of boards holding 71 to 3,063 rows, which
 * quarantined five of six verified lists. Rates are measured against inspected
 * candidates with ten points of tolerance, so a list is judged against its own
 * shape; the count floors keep the original 70%.
 */
export function trustedCommunityThresholds(baseline: TrustedCommunityBaseline): TrustedCommunityThresholds {
  const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0;
  const inspected = baseline.inspectedCandidates && baseline.inspectedCandidates > 0
    ? baseline.inspectedCandidates
    : baseline.eligibleRows;
  return {
    minimumRawRows: Math.ceil(baseline.rawRows * 0.7),
    minimumEligibleRows: Math.ceil(baseline.eligibleRows * 0.7),
    // The inspection floor is a ceiling on a family-sized board, not a count
    // every list can reach: a list with 70 eligible rows can never inspect 100
    // candidates, so the absolute 100 made every complete pass breach and left
    // such a source permanently quarantined. Small lists keep the same 70% shape
    // as the count floors above.
    minimumInspectedCandidates: Math.max(1, Math.min(100, Math.ceil(inspected * 0.7))),
    minimumInspectionCoverage: 0.9,
    maximumDestinationFailureRate: Math.min(0.5, ratio(baseline.destinationFailures, inspected) + 0.1),
    maximumBrowserInspectionShare: Math.min(0.9, ratio(baseline.browserInspectionCandidates, inspected) + 0.1),
    minimumCatalogYield: Math.max(0, ratio(baseline.catalogAdmissions, baseline.rawRows) - 0.1),
    minimumAlertYield: Math.max(0, ratio(baseline.alertQualifications, baseline.eligibleRows) - 0.1),
  };
}

/** Duplicate occurrence identities are deduped before publication, so a handful
 * is a data-entry quirk in the upstream list rather than a reason to stop polling
 * a trusted board: allow 1% of raw rows, at least five. */
export function duplicateOccurrenceTolerance(metrics: { rawRows: number }): number {
  return Math.max(5, Math.ceil(metrics.rawRows * 0.01));
}

/**
 * Baselines observed from live passes on 2026-09-16, after each board was
 * verified healthy in a browser (board renders, sampled application links resolve
 * to live postings). Re-measure before tightening: these describe the shapes the
 * lists actually have, and a list that shrinks by more than 30% still breaches.
 */
export const TRUSTED_COMMUNITY_BASELINES: Record<string, TrustedCommunityBaseline> = {
  'vanshb03-summer-2027': {
    rawRows: 371, eligibleRows: 352, inspectedCandidates: 137,
    destinationFailures: 27, browserInspectionCandidates: 109, catalogAdmissions: 110, alertQualifications: 0,
  },
  'simplify-summer-2026': {
    rawRows: 3_063, eligibleRows: 2_542, inspectedCandidates: 2_293,
    destinationFailures: 261, browserInspectionCandidates: 1_081, catalogAdmissions: 2_032, alertQualifications: 0,
  },
  'speedyapply-2027-swe': {
    rawRows: 1_035, eligibleRows: 1_017, inspectedCandidates: 187,
    destinationFailures: 19, browserInspectionCandidates: 92, catalogAdmissions: 168, alertQualifications: 0,
  },
  'speedyapply-2027-ai': {
    rawRows: 952, eligibleRows: 931, inspectedCandidates: 192,
    destinationFailures: 27, browserInspectionCandidates: 103, catalogAdmissions: 168, alertQualifications: 0,
  },
  'northwestern-fintech-2027-quant': {
    rawRows: 71, eligibleRows: 70, inspectedCandidates: 38,
    destinationFailures: 15, browserInspectionCandidates: 26, catalogAdmissions: 23, alertQualifications: 0,
  },
  'canadian-tech-2027': {
    rawRows: 273, eligibleRows: 220, inspectedCandidates: 162,
    destinationFailures: 34, browserInspectionCandidates: 52, catalogAdmissions: 128, alertQualifications: 0,
  },
};

/** Thresholds for a source: its own baseline when measured, else the family preset. */
export function trustedCommunityThresholdsFor(sourceId: string): TrustedCommunityThresholds {
  const baseline = TRUSTED_COMMUNITY_BASELINES[sourceId];
  return baseline ? trustedCommunityThresholds(baseline) : SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS;
}

export const SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS = trustedCommunityThresholds(SIMPLIFY_TRUSTED_COMMUNITY_BASELINE);

const DESTINATION_FAILURES = new Set<CatalogAdmissionReason>([
  'destination-aggregate-board',
  'destination-blocked-uninspectable',
  'destination-gone',
  'destination-unresolved',
]);

const TRUSTED_COMMUNITY_DIAGNOSTICS = new Set<CatalogAdmissionReason>([
  'employer-unresolved',
  'posting-unattributed',
]);

function catalogQualified(occurrence: ProcessedListing | SourceOccurrenceState['occurrence']): boolean {
  const admission = occurrence.admission;
  if (!admission) return false;
  const postingSpecific = admission.destination.classification === 'posting-detail'
    || admission.destination.classification === 'application-form';
  return postingSpecific && admission.reasonCodes.every((reason) => TRUSTED_COMMUNITY_DIAGNOSTICS.has(reason));
}

export function trustedCommunityMetrics(input: {
  rawRows: number;
  eligibleRows: number;
  listings: readonly ProcessedListing[];
  priorOccurrences: readonly SourceOccurrenceState[];
  eligibleExternalIds: ReadonlySet<string>;
  admissionConfigurationVersion?: string;
  rejectedAggregatorRows: number;
  survivingAggregatorRows: number;
  duplicateOccurrenceIds: number;
}): TrustedCommunitySourceMetrics {
  const prior = new Map(input.priorOccurrences.map((item) => [item.externalId, item.occurrence]));
  const current = new Map(input.listings.map((item) => [item.externalId!, item]));
  const inspected = [...input.eligibleExternalIds].flatMap((externalId) => {
    const occurrence = current.get(externalId) ?? prior.get(externalId);
    if (!occurrence || (input.admissionConfigurationVersion
      && occurrence.admissionConfigurationVersion !== input.admissionConfigurationVersion)) return [];
    return occurrence.admission ? [occurrence] : [];
  });
  const failuresByReason: TrustedCommunitySourceMetrics['destinationFailuresByReason'] = {};
  for (const occurrence of inspected) {
    for (const reason of occurrence.admission?.reasonCodes ?? []) {
      if (DESTINATION_FAILURES.has(reason)) failuresByReason[reason] = (failuresByReason[reason] ?? 0) + 1;
    }
  }
  const destinationFailures = Object.values(failuresByReason).reduce((sum, count) => sum + count, 0);
  const browserInspectionCandidates = inspected.filter((occurrence) => {
    const destination = occurrence.admission!.destination;
    return destination.browserVisible !== undefined
      || destination.classification === 'unresolved'
      || destination.classification === 'blocked-uninspectable';
  }).length;
  const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : 0;
  return {
    rawRows: input.rawRows,
    eligibleRows: input.eligibleRows,
    rejectedAggregatorRows: input.rejectedAggregatorRows,
    survivingAggregatorRows: input.survivingAggregatorRows,
    duplicateOccurrenceIds: input.duplicateOccurrenceIds,
    inspectedCandidates: inspected.length,
    browserInspectionCandidates,
    destinationFailures,
    destinationFailuresByReason: failuresByReason,
    inspectionCoverage: ratio(inspected.length, input.eligibleRows),
    browserInspectionShare: ratio(browserInspectionCandidates, inspected.length),
    destinationFailureRate: ratio(destinationFailures, inspected.length),
    // Bounded migrations deliberately suppress publication until the final
    // complete pass. Measure the underlying decision so that suppression
    // cannot make an otherwise healthy migration deadlock at 90% coverage.
    catalogYield: ratio(inspected.filter(catalogQualified).length, input.rawRows),
    alertYield: ratio(inspected.filter((item) => item.trustedCommunityAlertQualification?.status === 'eligible').length, input.eligibleRows),
  };
}

export function trustedCommunityCircuitBreaches(input: {
  metrics: TrustedCommunitySourceMetrics;
  thresholds?: TrustedCommunityThresholds;
  alertMode: TrustedCommunityAlertMode;
  /** Final publication/checkpoint passes must prove the current snapshot was inspected. */
  requireCompleteInspection?: boolean;
}): string[] {
  const thresholds = input.thresholds ?? SIMPLIFY_TRUSTED_COMMUNITY_THRESHOLDS;
  const { metrics } = input;
  const breaches: string[] = [];
  if (metrics.rawRows === 0) breaches.push('parser returned zero rows');
  if (metrics.survivingAggregatorRows > 0) breaches.push(`${metrics.survivingAggregatorRows} aggregator row(s) survived rejection`);
  if (metrics.duplicateOccurrenceIds > duplicateOccurrenceTolerance(metrics)) {
    breaches.push(`${metrics.duplicateOccurrenceIds} duplicate occurrence identity row(s)`);
  }
  if (metrics.rawRows < thresholds.minimumRawRows) breaches.push(`raw rows ${metrics.rawRows} below ${thresholds.minimumRawRows}`);
  if (metrics.eligibleRows < thresholds.minimumEligibleRows) breaches.push(`eligible rows ${metrics.eligibleRows} below ${thresholds.minimumEligibleRows}`);
  if (input.requireCompleteInspection && metrics.inspectedCandidates < thresholds.minimumInspectedCandidates) {
    breaches.push(`inspected candidates ${metrics.inspectedCandidates} below ${thresholds.minimumInspectedCandidates}`);
  }
  if (input.requireCompleteInspection && metrics.inspectionCoverage < thresholds.minimumInspectionCoverage) {
    breaches.push(`inspection coverage ${(metrics.inspectionCoverage * 100).toFixed(2)}% below ${(thresholds.minimumInspectionCoverage * 100).toFixed(2)}%`);
  }
  const rateGatesActive = metrics.inspectedCandidates >= thresholds.minimumInspectedCandidates
    && metrics.inspectionCoverage >= thresholds.minimumInspectionCoverage;
  if (rateGatesActive) {
    if (metrics.destinationFailureRate > thresholds.maximumDestinationFailureRate) breaches.push('destination failure rate exceeded');
    if (metrics.browserInspectionShare > thresholds.maximumBrowserInspectionShare) breaches.push('browser inspection share exceeded');
    if (metrics.catalogYield < thresholds.minimumCatalogYield) breaches.push('catalog yield fell below its floor');
    if (input.alertMode !== 'disabled' && metrics.alertYield < thresholds.minimumAlertYield) breaches.push('alert yield fell below its floor');
  }
  return breaches;
}
