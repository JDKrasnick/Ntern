import { readFile, writeFile } from 'node:fs/promises';
import { canonicalCompanyKey } from '../src/core/normalize.js';
import { companyRankingTiers, reviewCompanyRanking, type CompanyRankingTier } from '../src/company-ranking.js';
import { companyRankingSeeds } from './company-ranking-seeds.js';

// Read-only audit. An explicit complete-coverage gate is required before the
// catalog-wide review can be published; a valid file alone is not completion.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1]!.startsWith('--')) throw new Error(`${name} needs a path`);
  return args[at + 1]!;
};
const input = option('--inventory', '.context/holistic-ranking-inventory.json');
const reviewsPath = option('--reviews', 'scripts/data/company-ranking-holistic-reviews.jsonl');
const output = option('--output', '.context/holistic-ranking-coverage.json');
const inventory = JSON.parse(await readFile(input, 'utf8')) as {
  summary: { at: string }; rows: Array<{ key: string; names: string[]; employers: Array<{ id: string }> }>;
};
if (!Array.isArray(inventory.rows) || !inventory.rows.length) throw new Error('Inventory is empty or invalid');
const reviews = (await readFile(reviewsPath, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as {
  company: string; tier: CompanyRankingTier; reviewedOn: string; confidence: string; compensationEvidence: string; linkedInFollowers: number | null;
  sources: string[]; aliases: string[];
});
const explicit = new Map<string, typeof reviews[number]>();
for (const review of reviews) {
  reviewCompanyRanking(review, 'coverage-audit', new Date().toISOString());
  const key = canonicalCompanyKey(review.company);
  if (!key) throw new Error(`Empty review key: ${review.company}`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(review.reviewedOn) || !['high', 'medium', 'limited'].includes(review.confidence)) throw new Error(`Missing review provenance: ${review.company}`);
  if (!review.sources.length || !review.compensationEvidence) throw new Error(`Missing evidence context: ${review.company}`);
  if (review.linkedInFollowers !== null && (!Number.isSafeInteger(review.linkedInFollowers) || review.linkedInFollowers < 0)) throw new Error(`Invalid follower evidence: ${review.company}`);
  for (const name of [review.company, ...review.aliases]) {
    const aliasKey = canonicalCompanyKey(name);
    if (explicit.has(aliasKey) && explicit.get(aliasKey) !== review) throw new Error(`Duplicate or conflicting review identity: ${name}`);
    explicit.set(aliasKey, review);
  }
}
const seeds = new Map<string, typeof companyRankingSeeds[number]>();
for (const seed of companyRankingSeeds) for (const name of [seed.company, ...seed.aliases]) {
  const key = canonicalCompanyKey(name);
  if (seeds.has(key) && seeds.get(key) !== seed) throw new Error(`Conflicting reviewed seed identity: ${name}`);
  seeds.set(key, seed);
}
const rows = inventory.rows.map(row => {
  const review = explicit.get(row.key);
  const seed = seeds.get(row.key);
  const rating = review ?? seed;
  return { key: row.key, companies: row.names, employerIds: row.employers.map(e => e.id),
    basis: review ? 'individual-review' : seed ? 'existing-reviewed-roster' : 'missing',
    ...(rating ? { tier: rating.tier, score: companyRankingTiers[rating.tier as keyof typeof companyRankingTiers] } : {}) };
});
const summary = { inventoryAt: inventory.summary.at, companies: rows.length, individualReviews: rows.filter(r => r.basis === 'individual-review').length,
  existingRoster: rows.filter(r => r.basis === 'existing-reviewed-roster').length, missing: rows.filter(r => r.basis === 'missing').length,
  complete: rows.every(r => r.basis !== 'missing'), applied: false };
await writeFile(output, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify({ ...summary, output }, null, 2));
if (args.includes('--require-complete') && !summary.complete) process.exitCode = 1;
