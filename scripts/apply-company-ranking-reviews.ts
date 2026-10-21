import { readFile, writeFile } from 'node:fs/promises';
import { canonicalCompanyKey } from '../src/core/normalize.js';
import { reviewCompanyRanking } from '../src/company-ranking.js';
import type { CanonicalEmployer } from '../src/types.js';

try { process.loadEnvFile('.env'); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  if (!args[at + 1] || args[at + 1]!.startsWith('--')) throw new Error(`${name} needs a value`);
  return args[at + 1]!;
};
const api = option('--api', 'https://api.ntern.app');
if (!['https://api.ntern.app', 'https://intern-notifs-dev.jdkrasnick.workers.dev'].includes(api)) throw new Error('Use the production or isolated development API origin');
const apply = args.includes('--apply');
if (apply && !args.includes('--api')) throw new Error('--api is required for writes');
const key = process.env.OPERATIONS_SHARED_SECRET;
if (!key) throw new Error('OPERATIONS_SHARED_SECRET is required in untracked .env');
const headers = { 'X-Operations-Key': key, 'Content-Type': 'application/json' };
const reviews = (await readFile(option('--reviews', 'scripts/data/company-ranking-holistic-reviews.jsonl'), 'utf8'))
  .split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as { company: string; aliases?: string[] });
const byName = new Map<string, ReturnType<typeof reviewCompanyRanking>>();
for (const review of reviews) {
  const ranking = reviewCompanyRanking(review, 'offline-review-validation', new Date().toISOString());
  for (const name of [review.company, ...ranking.aliases]) {
    const normalized = canonicalCompanyKey(name);
    if (!normalized || byName.has(normalized)) throw new Error(`Empty or conflicting review identity: ${name}`);
    byName.set(normalized, ranking);
  }
}
async function inventory(): Promise<CanonicalEmployer[]> {
  const response = await fetch(`${api}/internal/admission/employers`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Employer inventory returned HTTP ${response.status}`);
  const value = await response.json() as { employers: CanonicalEmployer[] };
  if (!Array.isArray(value.employers) || !value.employers.length) throw new Error('Employer inventory is empty or invalid');
  return value.employers;
}
const before = await inventory();
const rows = before.map(employer => ({ employerId: employer.id, company: employer.displayName,
  existing: employer.ranking, proposal: byName.get(canonicalCompanyKey(employer.displayName)), applied: false }));
const output = option('--output', '.context/holistic-ranking-apply.json');
// Write a recovery artifact before the first mutation. A failed run is safely
// resumable because every update is an atomic onlyUnreviewed operation.
async function report(verified: boolean) {
  const summary = { api, apply, reviews: reviews.length, employers: rows.length,
    proposed: rows.filter(row => row.proposal && row.existing?.status !== 'reviewed').length,
    preservedReviewed: rows.filter(row => row.existing?.status === 'reviewed').length,
    applied: rows.filter(row => row.applied).length, verified, scope: 'canonical-employer review batch; not full catalog coverage' };
  await writeFile(output, JSON.stringify({ summary, rows }, null, 2));
  return summary;
}
await report(false);
if (apply) {
  try {
    for (const row of rows.filter(row => row.proposal && row.existing?.status !== 'reviewed')) {
      const response = await fetch(`${api}/internal/admission/company-rankings/${encodeURIComponent(row.employerId)}`, {
        method: 'PUT', headers, body: JSON.stringify({ ranking: row.proposal, onlyUnreviewed: true }), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Review for ${row.employerId} returned HTTP ${response.status}`);
      const value = await response.json() as { applied: boolean };
      row.applied = value.applied === true;
    }
    const after = new Map((await inventory()).map(employer => [employer.id, employer]));
    for (const row of rows) {
      const actual = after.get(row.employerId)?.ranking;
      if (row.applied) {
        const expected = row.proposal!;
        if (!actual || actual.status !== 'reviewed' || actual.tier !== expected.tier || actual.reason !== expected.reason
          || JSON.stringify(actual.sources) !== JSON.stringify(expected.sources) || JSON.stringify(actual.aliases) !== JSON.stringify(expected.aliases)) throw new Error(`Persisted review mismatch: ${row.employerId}`);
      } else if (row.existing?.status === 'reviewed' && JSON.stringify(actual) !== JSON.stringify(row.existing)) {
        throw new Error(`Existing review changed concurrently: ${row.employerId}`);
      }
    }
  } catch (error) { await report(false); throw error; }
}
console.log(JSON.stringify({ ...await report(apply), output }, null, 2));
