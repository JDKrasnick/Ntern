/** Bounded, serial catch-up through the authenticated ingestion resolver.
 * CATALOG_API_URL and OPERATIONS_SHARED_SECRET must be supplied in the environment.
 * Usage: tsx scripts/catch-up-company-icons.ts [--max-tasks 100] [--max-minutes 30]
 */
const args = process.argv.slice(2);
function budget(name: string, fallback: number, ceiling: number): number {
  const index = args.indexOf(name);
  const value = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`${name} must be 1..${ceiling}`);
  return value;
}
const maximum = budget('--max-tasks', 100, 2_000);
const deadline = Date.now() + budget('--max-minutes', 30, 360) * 60_000;
const endpoint = process.env.CATALOG_API_URL;
const secret = process.env.OPERATIONS_SHARED_SECRET;
if (!endpoint || !secret) throw new Error('CATALOG_API_URL and OPERATIONS_SHARED_SECRET are required');
const url = new URL('/internal/admission/employer-icons/sweep', endpoint);
if (url.protocol !== 'https:') throw new Error('CATALOG_API_URL must use HTTPS');
let attempted = 0;
let resolved = 0;
let batch = 0;
while (attempted < maximum && Date.now() < deadline) {
  // No overlapping requests or automatic retries after uncertain network failures.
  const response = await fetch(url, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-Operations-Key': secret },
    body: JSON.stringify({ maxTasks: Math.min(5, maximum - attempted) }), signal: AbortSignal.timeout(300_000) });
  if (response.status === 409) {
    console.log(JSON.stringify({ at: new Date().toISOString(), event: 'sweep-busy', attempted, resolved }));
    // A bounded pause also lets the scheduled sweep finish before catch-up resumes.
    await new Promise((done) => setTimeout(done, 30_000));
    continue;
  }
  if (!response.ok) throw new Error(`Icon catch-up stopped at HTTP ${response.status}; inspect D1 health before resuming`);
  const result = await response.json() as {
    mode: string; claimed: number; deferredTasks?: number; resolved: number; reasonCodes: string[];
  };
  const completed = result.claimed - (result.deferredTasks ?? 0);
  attempted += completed;
  resolved += result.resolved;
  console.log(JSON.stringify({ at: new Date().toISOString(), batch: ++batch, attempted, resolved, result }));
  if (result.mode === 'off' || result.claimed === 0 || completed === 0) break;
  await new Promise((done) => setTimeout(done, 2_000));
}
console.log(JSON.stringify({ event: 'catchup-stopped', at: new Date().toISOString(), attempted, resolved }));
