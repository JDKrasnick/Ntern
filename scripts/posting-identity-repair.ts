const args = new Set(process.argv.slice(2));
const value = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const apply = args.has('--apply');
const gate = args.has('--gate');
/** Read-only integrity gate. It pages the catalog, so it runs on production
 * catalogs that cannot be read whole inside one Worker invocation. */
const audit = args.has('--audit');
const jobBatch = args.has('--job-batch') ? Number(value('--job-batch')) : undefined;
const repairToken = args.has('--repair-token') ? value('--repair-token') : undefined;
const expectedChanges = args.has('--expected-changes') ? Number(value('--expected-changes')) : undefined;
const expectedDuplicateJobs = args.has('--expected-duplicate-jobs') ? Number(value('--expected-duplicate-jobs')) : undefined;
const scope = args.has('--scope') ? value('--scope') : 'all';
if (!['all', 'identity', 'occurrences'].includes(scope)) throw new Error('--scope must be all, identity, or occurrences');
if (apply && (!repairToken || !Number.isSafeInteger(expectedChanges) || !Number.isSafeInteger(expectedDuplicateJobs))) {
  throw new Error('--apply requires --repair-token, --expected-changes, and --expected-duplicate-jobs');
}
const baseUrl = process.env.CATALOG_API_URL ?? 'https://intern-notifs.jdkrasnick.workers.dev';
const secret = process.env.OPERATIONS_SHARED_SECRET;
if (!secret) throw new Error('OPERATIONS_SHARED_SECRET is required');
const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/internal/posting-identity-repair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Operations-Key': secret },
  body: JSON.stringify({ apply, repairToken, expectedChanges, expectedDuplicateJobs, scope, audit, jobBatch }),
});
const body = await response.text();
console.log(body);
if (!response.ok) process.exitCode = 1;
else if (gate) {
  const report = JSON.parse(body) as { gate?: { passed?: boolean } };
  if (report.gate?.passed !== true) process.exitCode = 2;
}
