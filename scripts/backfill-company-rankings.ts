import { writeFile } from 'node:fs/promises';
import { canonicalCompanyKey } from '../src/core/normalize.js';
import { pendingCompanyRanking } from '../src/company-ranking.js';
import type { CanonicalEmployer } from '../src/types.js';
import { companyRankingSeeds } from './company-ranking-seeds.js';

try { process.loadEnvFile('.env'); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const args = process.argv.slice(2);
const argument = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const api = argument('--api') ?? 'https://api.ntern.app';
if (!['https://api.ntern.app', 'https://intern-notifs-dev.jdkrasnick.workers.dev'].includes(api)) throw new Error('Use the production or isolated development API origin');
const apply = args.includes('--apply');
if (apply && !argument('--api')) throw new Error('--api is required when applying a backfill');
const key = process.env.OPERATIONS_SHARED_SECRET;
if (!key) throw new Error('OPERATIONS_SHARED_SECRET is required in untracked .env');
const headers = { 'X-Operations-Key': key, 'Content-Type': 'application/json' };
const response = await fetch(`${api}/internal/admission/employers`, { headers, signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Employer inventory returned HTTP ${response.status}`);
const { employers } = await response.json() as { employers: CanonicalEmployer[] };
const seeds = new Map<string, typeof companyRankingSeeds[number]>();
for (const seed of companyRankingSeeds) for (const name of [seed.company, ...seed.aliases]) {
  const normalized = canonicalCompanyKey(name);
  if (seeds.has(normalized) && seeds.get(normalized) !== seed) throw new Error(`Conflicting seed alias: ${name}`);
  seeds.set(normalized, seed);
}
const rows = employers.map(employer => {
  const seed = seeds.get(canonicalCompanyKey(employer.displayName));
  const existing = employer.ranking ?? pendingCompanyRanking();
  const proposal = seed ? { tier: seed.tier, reason: seed.reason, sources: seed.sources,
    aliases: [...new Set([seed.company, ...seed.aliases])].filter(name => canonicalCompanyKey(name) !== canonicalCompanyKey(employer.displayName)) } : undefined;
  return { employerId: employer.id, company: employer.displayName, existing,
    action: existing.status === 'reviewed' ? 'preserve-reviewed' : proposal ? 'review-tier' : 'neutral-pending',
    ...(proposal ? { proposal } : {}) };
});
const outcomes = { applied: 0, skippedReviewed: 0 };
if (apply) for (const row of rows.filter(row => row.action === 'review-tier')) {
  const result = await fetch(`${api}/internal/admission/company-rankings/${encodeURIComponent(row.employerId)}`, {
    method: 'PUT', headers, body: JSON.stringify({ ranking: row.proposal, onlyUnreviewed: true }), signal: AbortSignal.timeout(30_000),
  });
  if (!result.ok) throw new Error(`Ranking update for ${row.employerId} returned HTTP ${result.status}; retry preserves reviewed rows`);
  const value = await result.json() as { applied: boolean };
  if (value.applied) outcomes.applied++; else outcomes.skippedReviewed++;
}
const summary = { api, apply, employers: rows.length, proposedReviews: rows.filter(row => row.action === 'review-tier').length,
  preservedReviews: rows.filter(row => row.action === 'preserve-reviewed').length,
  neutralPending: rows.filter(row => row.action === 'neutral-pending').length, ...outcomes };
const output = argument('--output') ?? '.context/company-ranking-backfill.json';
await writeFile(output, JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify({ ...summary, output }, null, 2));
