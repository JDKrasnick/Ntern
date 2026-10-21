import { companyRankingNameKey, companyRankingTiers, employerRankingKey, storedCompanyRanking,
  type CompanyRankingScores } from '../src/company-ranking.js';
import type { D1Database } from './types.js';

/** One bounded snapshot per Best request, reused for ranking and hydration. */
export class D1CompanyRankingStore {
  constructor(private readonly db: D1Database) {}
  async scores(): Promise<CompanyRankingScores> {
    const scores = new Map<string, number>();
    const names = new Map<string, Set<number>>();
    const addName = (name: string, score: number) => {
      const key = companyRankingNameKey(name);
      if (key === 'name:') return;
      const values = names.get(key) ?? new Set<number>();
      values.add(score);
      names.set(key, values);
    };
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
          addName(name, score);
        }
      }
      if (page.results.length < 200) break;
      after = page.results.at(-1)!.id;
    }
    after = '';
    for (;;) {
      const page = await this.db.prepare(`SELECT company_key, display_name, ranking_json FROM catalog_company_rankings
        WHERE company_key > ? ORDER BY company_key LIMIT 200`).bind(after)
        .all<{ company_key: string; display_name: string; ranking_json: string }>();
      for (const row of page.results) {
        const ranking = storedCompanyRanking(row.ranking_json);
        if (ranking.status !== 'reviewed') continue;
        for (const name of [row.display_name, ...ranking.aliases]) addName(name, companyRankingTiers[ranking.tier]);
      }
      if (page.results.length < 200) break;
      after = page.results.at(-1)!.company_key;
    }
    // Conflicting aliases cannot confer a rank on unattributed listings.
    for (const [key, values] of names) if (values.size === 1) scores.set(key, [...values][0]!);
    return scores;
  }
}
