import { canonicalCompanyKey } from './core/normalize.js';

/** Editorial career value plus business substance, never headcount or ATS. */
export const companyRankingTiers = { exceptional: 95, strong: 85, established: 70, unrated: 50 } as const;
export type CompanyRankingTier = keyof typeof companyRankingTiers;
export interface CompanyRanking {
  tier: CompanyRankingTier;
  status: 'reviewed' | 'pending';
  reason: string;
  sources: string[];
  aliases: string[];
  reviewedAt?: string;
  reviewedBy?: string;
}
export type CompanyRankingScores = ReadonlyMap<string, number>;
export const employerRankingKey = (id: string) => `employer:${id}`;
export const companyRankingNameKey = (name: string) => `name:${canonicalCompanyKey(name)}`;
export const pendingCompanyRanking = (): CompanyRanking => ({ tier: 'unrated', status: 'pending',
  reason: 'Company ranking awaits admission review.', sources: [], aliases: [] });

/** Review metadata is stamped by the operations API, never trusted from input. */
export function reviewCompanyRanking(input: unknown, actor: string, timestamp: string): CompanyRanking {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ranking is required');
  const value = input as Record<string, unknown>;
  const tier = value.tier;
  if (typeof tier !== 'string' || !Object.hasOwn(companyRankingTiers, tier)) throw new Error('ranking.tier must be exceptional, strong, established or unrated');
  if (typeof value.reason !== 'string' || value.reason.trim().length < 10 || value.reason.length > 500) throw new Error('ranking.reason must contain 10–500 characters');
  const sources = value.sources ?? [];
  if (!Array.isArray(sources) || sources.length > 10 || (tier !== 'unrated' && sources.length === 0)
    || sources.some(source => {
      if (typeof source !== 'string' || source.length > 1000) return true;
      try { const url = new URL(source); return url.protocol !== 'https:' || Boolean(url.username || url.password); } catch { return true; }
    })) throw new Error('ranking.sources must contain up to 10 HTTPS evidence URLs; rated companies need at least one');
  const aliases = value.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 40 || aliases.some(alias => typeof alias !== 'string'
    || alias.length > 160 || !canonicalCompanyKey(alias))) throw new Error('ranking.aliases must contain up to 40 exact company names');
  return { tier: tier as CompanyRankingTier, status: 'reviewed', reason: value.reason.trim(),
    sources: [...new Set(sources as string[])], aliases: [...new Set(aliases as string[])], reviewedAt: timestamp, reviewedBy: actor };
}

export function storedCompanyRanking(value: unknown): CompanyRanking {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed?.status !== 'reviewed' || typeof parsed.reviewedBy !== 'string' || !parsed.reviewedBy
      || typeof parsed.reviewedAt !== 'string' || !Number.isFinite(Date.parse(parsed.reviewedAt))) return pendingCompanyRanking();
    return reviewCompanyRanking(parsed, parsed.reviewedBy, parsed.reviewedAt);
  } catch { return pendingCompanyRanking(); }
}

export function admittedCompanyScore(input: { company: string; canonicalEmployerId?: string }, scores?: CompanyRankingScores): number | undefined {
  // A known identity must never inherit a different employer's same-name rating.
  const value = scores?.get(input.canonicalEmployerId ? employerRankingKey(input.canonicalEmployerId) : companyRankingNameKey(input.company));
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}
