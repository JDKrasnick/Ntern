import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D1CompanyRankingStore } from '../cloudflare/company-ranking-store.js';
import { companyRankingTiers, pendingCompanyRanking, reviewCompanyRanking } from '../src/company-ranking.js';
import { scoreOpportunity } from '../src/opportunity-score.js';
import { companyRankingSeeds } from '../scripts/company-ranking-seeds.js';
import { canonicalCompanyKey } from '../src/core/normalize.js';
import type { D1Database } from '../cloudflare/types.js';

const at = '2026-10-21T12:00:00.000Z';
const input = { company: 'Acme', title: 'Software Engineer Intern', compensation: { raw: '' } };
const ranking = (tier = 'strong', aliases = ['Acme Technology']) => reviewCompanyRanking({ tier,
  reason: 'Established engineering product business.', sources: ['https://acme.test/'], aliases }, 'reviewer', at);

describe('admitted company ranking', () => {
  it('validates the rubric, requires evidence, and stamps reviewer identity', () => {
    expect(ranking()).toMatchObject({ tier: 'strong', status: 'reviewed', reviewedBy: 'reviewer', reviewedAt: at });
    for (const invalid of [null, {}, { tier: 'constructor' }, { tier: 'size' }, { tier: 'strong', reason: 'Valid reason here', sources: [] },
      { tier: 'strong', reason: 'Valid reason here', sources: ['http://acme.test'] },
      { tier: 'strong', reason: 'Valid reason here', sources: ['https://user:secret@acme.test'] }]) {
      expect(() => reviewCompanyRanking(invalid, 'reviewer', at)).toThrow();
    }
    expect(reviewCompanyRanking({ ...ranking(), reviewedBy: 'spoofed' }, 'actual-reviewer', at).reviewedBy).toBe('actual-reviewer');
  });

  it('uses only admission scores and exact identity; legacy tiers and headcount confer no rank', () => {
    const scores = new Map([['employer:acme', 85], ['name:acme', 70]]);
    expect(scoreOpportunity({ ...input, canonicalEmployerId: 'acme' }, scores)).toMatchObject({ company: 85, companyEvidence: 'reviewed' });
    expect(scoreOpportunity(input, scores)).toMatchObject({ company: 70, companyEvidence: 'reviewed' });
    expect(scoreOpportunity({ ...input, canonicalEmployerId: 'other' }, scores)).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    for (const company of ['Microsoft', 'Dell Technologies', 'Klaviyo', 'F5', 'Acme Partners']) {
      expect(scoreOpportunity({ ...input, company })).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    }
    for (const invalid of [NaN, Infinity, -10, 101]) expect(scoreOpportunity(input, new Map([['name:acme', invalid]])).company).toBe(50);
    expect(scoreOpportunity({ ...input, company: '未知公司' }, new Map([['name:', 95]])).company).toBe(50);
  });

  it('reads every employer in bounded pages and makes conflicting aliases neutral without losing ID ranks', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE canonical_employers(id TEXT PRIMARY KEY, display_name TEXT NOT NULL)');
    database.exec(readFileSync(new URL('../cloudflare/migrations/0059_company_admission_ranking.sql', import.meta.url), 'utf8'));
    database.exec(readFileSync(new URL('../cloudflare/migrations/0060_catalog_company_rankings.sql', import.meta.url), 'utf8'));
    const insert = database.prepare('INSERT INTO canonical_employers(id,display_name,ranking_json) VALUES (?,?,?)');
    for (let i = 0; i < 401; i++) insert.run(`employer-${i.toString().padStart(3, '0')}`, `Company ${i}`, JSON.stringify(ranking('established', [])));
    insert.run('acme', 'Acme', JSON.stringify(ranking()));
    insert.run('other', 'Other', JSON.stringify(ranking('established', ['Acme Technology'])));
    database.prepare('INSERT INTO canonical_employers(id,display_name) VALUES (?,?)').run('new', 'New Company');
    const insertCatalog = database.prepare('INSERT INTO catalog_company_rankings(company_key,display_name,ranking_json,created_at,updated_at) VALUES (?,?,?,?,?)');
    for (let i = 0; i < 401; i++) insertCatalog.run(`catalog-${i.toString().padStart(3, '0')}`, `Catalog ${i}`, JSON.stringify(ranking('established', [])), at, at);
    insertCatalog.run('conflict', 'Catalog Conflict', JSON.stringify(ranking('established', ['Acme'])), at, at);
    insertCatalog.run('pending-conflict', 'Catalog Pending Conflict', JSON.stringify(ranking('strong', ['New Company'])), at, at);
    insertCatalog.run('broken', 'Broken Catalog Company', '{}', at, at);
    let pages = 0;
    const db = { prepare(query: string) { return { bind(...values: SQLInputValue[]) { return { async all() {
      pages++;
      expect(query).toContain('LIMIT 200');
      return { results: database.prepare(query).all(...values) };
    } }; } }; } } as D1Database;
    try {
      expect(JSON.parse(database.prepare('SELECT ranking_json FROM canonical_employers WHERE id=?').get('new')!.ranking_json as string)).toEqual(pendingCompanyRanking());
      const scores = await new D1CompanyRankingStore(db).scores();
      expect(pages).toBe(6);
      expect(scores.get('employer:employer-400')).toBe(70);
      expect(scores.get('name:acme technology')).toBeUndefined();
      expect(scores.get('employer:acme')).toBe(85);
      expect(scores.get('name:new')).toBeUndefined();
      expect(scores.get('employer:new')).toBeUndefined();
      expect(scores.get('name:catalog 400')).toBe(70);
      expect(scores.get('name:acme')).toBeUndefined();
      expect(scores.get('name:broken catalog')).toBeUndefined();
      expect(scoreOpportunity({ ...input, company: 'Catalog 400' }, scores)).toMatchObject({ company: 70, companyEvidence: 'reviewed' });
      expect(scoreOpportunity({ ...input, company: 'Catalog 400', canonicalEmployerId: 'unreviewed-id' }, scores).company).toBe(50);
    } finally { database.close(); }
  });

  it('keeps backfill seed aliases unique and bases every non-neutral tier on explicit evidence', () => {
    const keys = new Map<string, string>();
    for (const seed of companyRankingSeeds) {
      expect(companyRankingTiers[seed.tier]).toBeGreaterThan(50);
      expect(() => reviewCompanyRanking(seed, 'backfill-reviewer', at)).not.toThrow();
      for (const name of [seed.company, ...seed.aliases]) {
        const key = canonicalCompanyKey(name);
        expect(keys.get(key) ?? seed.company, name).toBe(seed.company);
        keys.set(key, seed.company);
      }
    }
  });

  it('validates the complete individual review file and prevents known company-name mix-ups', () => {
    const reviews = readFileSync(new URL('../scripts/data/company-ranking-holistic-reviews.jsonl', import.meta.url), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown> & { company: string; aliases: string[]; sources: string[] });
    const keys = new Set<string>();
    for (const review of reviews) {
      expect(() => reviewCompanyRanking(review, 'data-validation', at), review.company).not.toThrow();
      expect(review.reviewedOn, review.company).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(['high', 'medium', 'limited'], review.company).toContain(review.confidence);
      expect(review.compensationEvidence, review.company).toBeTruthy();
      expect(review.sources.length, review.company).toBeGreaterThan(0);
      if (review.linkedInFollowers !== null) {
        expect(Number.isSafeInteger(review.linkedInFollowers), review.company).toBe(true);
        expect(review.sources.some(source => new URL(source).hostname.endsWith('linkedin.com')), review.company).toBe(true);
      }
      for (const name of [review.company, ...review.aliases]) {
        const key = canonicalCompanyKey(name);
        expect(key, name).not.toBe('');
        expect(keys.has(key), name).toBe(false);
        keys.add(key);
      }
    }
    expect(reviews.find(review => review.company === 'Sage')).toMatchObject({ tier: 'established' });
    expect(reviews.find(review => review.company === 'Sage')?.sources.some(source => source.includes('sage49'))).toBe(true);
    expect(reviews.find(review => review.company === 'Pivotal Software')).toMatchObject({ tier: 'unrated', confidence: 'limited' });
  });
});
