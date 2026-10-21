import { opportunityWeights, type OpportunityScore } from '../shared/opportunity-score.js';
import { companyRating, companyTierScore } from './company-ratings.js';
import { companySizeKey, type CompanySizeScores } from './company-size.js';
import { snapshotCompanySizeScore } from './company-size-snapshot.js';
import type { Compensation } from './types.js';

export interface OpportunityInput {
  company: string;
  title: string;
  disciplines?: string[];
  programType?: string;
  compensation: Compensation;
}

// Versioned editorial anchors, not claimed market percentiles or currency conversions.
// Each currency is compared with its own anchors. 2,080 annual work hours is a
// comparison convention, never a promise of an intern's total earnings.
const payAnchors: Record<string, readonly [number, number, number]> = {
  USD: [15, 35, 90], CAD: [16, 30, 65], GBP: [10, 20, 50], EUR: [10, 22, 55],
};
const clamp = (value: number) => Math.max(0, Math.min(100, value));
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function payScore(compensation: Compensation): number | undefined {
  const ranges = compensation.ranges;
  let amount: number | undefined, currency = 'USD';
  if (ranges?.length) {
    // Different location/degree bands cannot safely become one global maximum.
    // Use only a single unqualified band; the filter's location alone does not
    // establish which employer-specific degree/location label applies.
    if (ranges.length !== 1) return undefined;
    const range = ranges[0]!;
    if (range.applicableLocations?.length || range.applicableEducationLevels?.length || range.applicabilityLabel
      || !valid(range.minAmount) || !valid(range.maxAmount) || range.maxAmount < range.minAmount) return undefined;
    currency = range.currency;
    if (range.period === 'hourly') amount = range.minAmount;
    else if (range.period === 'annual') amount = range.minAmount / 2080;
    // No assumptions about hours worked in monthly, daily or weekly stipends.
  } else if (valid(compensation.minHourlyUSD)) {
    if (compensation.maxHourlyUSD != null && (!valid(compensation.maxHourlyUSD) || compensation.maxHourlyUSD < compensation.minHourlyUSD)) return undefined;
    amount = compensation.minHourlyUSD;
  } else if (valid(compensation.minAnnualUSD)) {
    if (compensation.maxAnnualUSD != null && (!valid(compensation.maxAnnualUSD) || compensation.maxAnnualUSD < compensation.minAnnualUSD)) return undefined;
    amount = compensation.minAnnualUSD / 2080;
  }
  const anchors = payAnchors[currency];
  if (amount === undefined || !anchors) return undefined;
  const [low, middle, high] = anchors;
  return clamp(amount <= middle ? (amount - low) / (middle - low) * 50 : 50 + (amount - middle) / (high - middle) * 50);
}

export function scoreOpportunity(input: OpportunityInput, companySizes?: CompanySizeScores): OpportunityScore {
  const rating = companyRating(input.company);
  const tier = companyTierScore(input.company);
  const estimated = companySizes?.get(companySizeKey(input.company));
  const size = typeof estimated === 'number' && Number.isFinite(estimated) ? clamp(estimated) : snapshotCompanySizeScore(input.company);
  const company = rating ? rating.career * 0.7 + rating.business * 0.3 : tier ?? size ?? 50;
  const disclosedPay = payScore(input.compensation);
  const pay = disclosedPay ?? 50;
  // All supported technical disciplines receive the same weight. A title is
  // evidence of fit, not evidence of mentorship, meaningful work or team quality.
  const technical = Boolean(input.disciplines?.length) || /\b(?:software|engineer(?:ing)?|developer|data|machine learning|ai|ml|security|quant(?:itative)?|product|design|infrastructure|cloud|research scientist)\b/iu.test(input.title);
  const earlyCareer = ['internship', 'co-op', 'apprenticeship', 'new-grad', 'entry-level'].includes(input.programType ?? '')
    || /\b(?:intern(?:ship)?|co[ -]?op|apprentice(?:ship)?|new[ -]?grad(?:uate)?|entry[ -]?level)\b/iu.test(input.title);
  const senior = /\b(?:senior|staff|principal|director|head of)\b/iu.test(input.title);
  const role = senior && !earlyCareer ? 20 : technical && earlyCareer ? 90 : technical || earlyCareer ? 70 : 50;
  const reasons = [
    ...((rating || tier !== undefined) && company >= 80 ? ['Strong employer'] : []),
    ...(disclosedPay !== undefined && pay >= 70 ? ['Higher listed pay'] : []),
    ...(technical && earlyCareer ? ['Technical early-career role'] : []),
  ];
  return { version: 'v1', total: Math.round((company * opportunityWeights.company + pay * opportunityWeights.pay + role * opportunityWeights.role) * 10) / 10,
    company: Math.round(company * 10) / 10, pay: Math.round(pay * 10) / 10, role,
    companyEvidence: rating ? 'reviewed' : tier !== undefined ? 'lookup' : size !== undefined ? 'size' : 'unrated', payEvidence: disclosedPay === undefined ? 'unknown' : 'listed', reasons };
}
