const args = new Set(process.argv.slice(2));
const value = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const sourceId = args.has('--source') ? value('--source') : undefined;
const apply = args.has('--apply');
const repairToken = args.has('--repair-token') ? value('--repair-token') : undefined;
const expectedActive = args.has('--expected-active') ? Number(value('--expected-active')) : undefined;
const expectedActionable = args.has('--expected-actionable') ? Number(value('--expected-actionable')) : undefined;
if (!sourceId) throw new Error('--source is required');
if (apply && (!repairToken || !Number.isSafeInteger(expectedActive) || !Number.isSafeInteger(expectedActionable))) {
  throw new Error('--apply requires --repair-token, --expected-active, and --expected-actionable');
}
const baseUrl = (process.env.CATALOG_API_URL ?? 'https://intern-notifs.jdkrasnick.workers.dev').replace(/\/$/u, '');
const secret = process.env.OPERATIONS_SHARED_SECRET;
if (!secret) throw new Error('OPERATIONS_SHARED_SECRET is required');
const response = await fetch(`${baseUrl}/internal/operations/ingestion/bootstrap`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Operations-Key': secret,
    'X-Operations-Actor': process.env.OPERATIONS_ACTOR ?? 'ingestion-v2-bootstrap-cli',
  },
  body: JSON.stringify({ sourceId, apply, repairToken, expectedActive, expectedActionable }),
});
const body = await response.text();
console.log(body);
if (!response.ok) process.exitCode = 1;
