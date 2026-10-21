/** Legacy presets for size-cache diagnostics only. Active catalog company
 * rankings come exclusively from the admission registry (company-ranking.ts). */
/** Editorial assessments, not measured prestige or investment recommendations.
 * Evidence establishes technical/business substance; the scores express our rubric.
 * Unknown employers stay neutral. Aliases are exact normalized names, never substrings.
 * Refresh sources and review scores together in a reviewed change.
 */
import { companyWeights } from './config/weights.js';
import { canonicalCompanyKey } from './core/normalize.js';

export interface CompanyRating {
  company: string;
  aliases: string[];
  career: number;
  business: number;
  reviewedAt: string;
  rationale: string;
  sources: string[];
}

export const companyRatings: readonly CompanyRating[] = [
  { company: 'Microsoft', aliases: ['microsoft corporation'], career: 95, business: 95, reviewedAt: '2026-10-20',
    rationale: 'Established software and cloud platform business with substantial engineering investment.',
    sources: ['https://www.microsoft.com/investor/reports/ar25/'] },
  { company: 'Google', aliases: ['alphabet', 'google llc', 'google deepmind'], career: 95, business: 95, reviewedAt: '2026-10-20',
    rationale: 'Established search, cloud and computing platforms with a substantial technical business.',
    sources: ['https://abc.xyz/assets/99/21/46cafdba41089a12a2d86ea47d44/goog026-annualreport2024-web.pdf'] },
  { company: 'Apple', aliases: ['apple inc'], career: 95, business: 95, reviewedAt: '2026-10-20',
    rationale: 'Established hardware, operating-system and services engineering business.',
    sources: ['https://www.apple.com/newsroom/2025/10/apple-reports-fourth-quarter-results/'] },
  { company: 'Meta', aliases: ['meta platforms', 'facebook'], career: 95, business: 90, reviewedAt: '2026-10-20',
    rationale: 'Large-scale consumer platforms and technical infrastructure; public financial reporting.',
    sources: ['https://investor.atmeta.com/financials/'] },
  { company: 'Amazon', aliases: ['amazon web services', 'aws', 'amazon.com', 'amazon com', 'amazon.com services llc', 'amazon data services inc'], career: 90, business: 95, reviewedAt: '2026-10-20',
    rationale: 'Established commerce and cloud engineering businesses with public financial reporting.',
    sources: ['https://ir.aboutamazon.com/annual-reports-proxies-and-shareholder-letters/default.aspx'] },
  { company: 'NVIDIA', aliases: ['nvidia corporation'], career: 95, business: 95, reviewedAt: '2026-10-20',
    rationale: 'Established accelerated-computing hardware and software business.',
    sources: ['https://investor.nvidia.com/financial-info/annual-reports-and-proxies/default.aspx'] },
  { company: 'Databricks', aliases: [], career: 90, business: 85, reviewedAt: '2026-10-20',
    rationale: 'Data and AI platform with disclosed revenue growth and financing; private-company evidence is more limited.',
    sources: ['https://www.databricks.com/company/newsroom/press-releases/databricks-grows-65-yoy-surpasses-5-4-billion-revenue-run-rate'] },
  { company: 'Stripe', aliases: ['stripe inc'], career: 90, business: 85, reviewedAt: '2026-10-20',
    rationale: 'Developer-focused payments infrastructure with published operating results; private-company evidence is more limited.',
    sources: ['https://stripe.com/annual-updates/2025'] },
  { company: 'Cloudflare', aliases: ['cloudflare inc'], career: 85, business: 80, reviewedAt: '2026-10-20',
    rationale: 'Network, security and developer infrastructure business with public financial reporting.',
    sources: ['https://www.cloudflare.com/press/press-releases/2026/cloudflare-announces-fourth-quarter-and-fiscal-year-2025-financial-results/'] },
];

const key = canonicalCompanyKey;
const ratings = new Map(companyRatings.flatMap(rating => [rating.company, ...rating.aliases].map(name => [key(name), rating] as const)));
export const companyRating = (company: string) => ratings.get(key(company));

/** Reuse the established simple employer tiers while enrichment is unavailable.
 * Exact normalized names and explicit aliases only; never substring matching. */
const tierScores = new Map(Object.entries(companyWeights.weights).map(([company, score]) => [canonicalCompanyKey(company), score]));
for (const [alias, company] of Object.entries(companyWeights.aliases)) {
  const score = tierScores.get(canonicalCompanyKey(company));
  if (score !== undefined) tierScores.set(canonicalCompanyKey(alias), score);
}
export const companyTierScore = (company: string) => tierScores.get(canonicalCompanyKey(company));
