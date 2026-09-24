import { readFileSync } from 'node:fs';

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
/**
 * Apply one signed batch exactly as a paged plan returned it. The saved plan is
 * the reviewed artifact: `--batch-file .context/262-occurrence-plan.json
 * --batch-index 0 --apply` posts that batch's job IDs, occurrence keys, context
 * rows, token, and expected changes, with the projection rebuild left to the
 * separate authorized refresh.
 */
const batchFile = args.has('--batch-file') ? value('--batch-file') : undefined;
const batchIndex = args.has('--batch-index') ? Number(value('--batch-index')) : 0;
/** Revalidate against the batch's current state instead of requiring the exact
 * dry-run token. Ingestion rewrites job rows while a multi-batch repair runs,
 * so the exact token cannot survive the operation; the applied slice is still
 * re-planned from current rows and every before-image is fenced. */
const acceptCurrentSnapshot = args.has('--accept-current-snapshot');
const scope = args.has('--scope') ? value('--scope') : 'all';
if (!['all', 'identity', 'occurrences'].includes(scope)) throw new Error('--scope must be all, identity, or occurrences');
if (batchFile && !Number.isSafeInteger(batchIndex)) throw new Error('--batch-index must be an integer');
if (batchFile && !apply) throw new Error('--batch-file requires --apply');
if (!batchFile && apply && (!repairToken || !Number.isSafeInteger(expectedChanges) || !Number.isSafeInteger(expectedDuplicateJobs))) {
  throw new Error('--apply requires --repair-token, --expected-changes, and --expected-duplicate-jobs, or --batch-file');
}
const baseUrl = process.env.CATALOG_API_URL ?? 'https://intern-notifs.jdkrasnick.workers.dev';
const secret = process.env.OPERATIONS_SHARED_SECRET;
if (!secret) throw new Error('OPERATIONS_SHARED_SECRET is required');
const request = batchFile
  ? readBatchRequest(batchFile, batchIndex)
  : { apply, repairToken, expectedChanges, expectedDuplicateJobs, scope, audit, jobBatch };
const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/internal/posting-identity-repair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Operations-Key': secret },
  body: JSON.stringify(request),
});
const body = await response.text();
console.log(body);
if (!response.ok) process.exitCode = 1;
else if (gate) {
  const report = JSON.parse(body) as { gate?: { passed?: boolean } };
  if (report.gate?.passed !== true) process.exitCode = 2;
}

function readBatchRequest(path: string, index: number) {
  const plan = JSON.parse(readFileSync(path, 'utf8')) as {
    scope?: string;
    batches?: Array<{ jobIds?: unknown; contextRows?: unknown; occurrenceKeys?: unknown; repairToken?: unknown;
      expectedChanges?: unknown; expectedDuplicateJobs?: unknown;
      eligibleDuplicateGroups?: unknown; unresolvedDuplicateGroups?: unknown }>;
  };
  const batch = plan.batches?.[index];
  if (!batch) throw new Error(`--batch-file ${path} has no batch at index ${index}`);
  if (plan.scope !== 'occurrences') throw new Error(`--batch-file ${path} is not an occurrence repair plan`);
  const { jobIds, contextRows, occurrenceKeys, repairToken: token, expectedChanges: changes, expectedDuplicateJobs: duplicates,
    eligibleDuplicateGroups, unresolvedDuplicateGroups } = batch;
  if (!Array.isArray(jobIds) || !Array.isArray(contextRows) || !Array.isArray(occurrenceKeys)
    || typeof token !== 'string' || typeof changes !== 'number' || typeof duplicates !== 'number') {
    throw new Error(`--batch-file ${path} batch ${index} is incomplete`);
  }
  if (acceptCurrentSnapshot && (!Number.isInteger(eligibleDuplicateGroups) || !Number.isInteger(unresolvedDuplicateGroups))) {
    throw new Error(`--batch-file ${path} batch ${index} has no revalidation bounds`);
  }
  return {
    apply: true, scope: 'occurrences', finalize: false,
    applyBatch: { jobIds, contextRows, occurrenceKeys },
    repairToken: token, expectedChanges: changes, expectedDuplicateJobs: duplicates,
    ...(acceptCurrentSnapshot
      ? { acceptCurrentSnapshot: true, expectedEligibleDuplicateGroups: eligibleDuplicateGroups, expectedUnresolvedDuplicateGroups: unresolvedDuplicateGroups }
      : {}),
  };
}
