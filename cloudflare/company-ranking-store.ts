import { companyRankingNameKey, companyRankingTiers, employerRankingKey, storedCompanyRanking,
  type CompanyRankingScores } from '../src/company-ranking.js';
import type { D1Database } from './types.js';

/** One bounded snapshot per Best request, reused for ranking and hydration. */
export class D1CompanyRankingStore {
  constructor(private readonly db: D1Database) {}
  async scores(): Promise<CompanyRankingScores> {
    const scores = new Map<string, number>();
    const names = new Map<string, Set<number>>();
    let after = '';
    for (;;) {
      const page = await this.db.prepare(`SELECT id, display_name, ranking_json FROM canonical_employers
        WHERE id > ? ORDER BY id LIMIT 200`).bind(after)
        .all<{ id: string; display_name: string; ranking_json: string | null }>();
      for (const row of page.results) {
        const ranking = storedCompanyRanking(row.ranking_json);
        const score = companyRankingTiers[ranking.tier];
        if (ranking.status === 'reviewed') scores.set(employerRankingKey(row.id), score);
        for (const name of [row.display_name, ...ranking.aliases]) {
          const key = companyRankingNameKey(name);
          const values = names.get(key) ?? new Set<number>();
          values.add(score);
          names.set(key, values);
        }
      }
      if (page.results.length < 200) break;
      after = page.results.at(-1)!.id;
    }
    // Conflicting aliases cannot confer a rank on unattributed listings.
    for (const [key, values] of names) if (values.size === 1) scores.set(key, [...values][0]!);
    return scores;
  }
}
