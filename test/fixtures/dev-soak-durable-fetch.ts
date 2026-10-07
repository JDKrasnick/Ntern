// Run the real soak CLI against migrated SQLite without Cloudflare mutations.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const database = new DatabaseSync(process.env.SOAK_TEST_DATABASE!);
const configs = Object.fromEntries(['ingestion', 'admission', 'catalog-publisher', 'api'].map((role) => [role,
  JSON.parse(readFileSync(new URL(`../../wrangler.dev.${role}.jsonc`, import.meta.url), 'utf8')),
]));
const runtimeRoles = ['ingestion', 'admission', 'catalog-publisher'];
const queueNames = [
  'greenhouse', 'lever', 'ashby', 'github', 'gmail', 'destination-verification',
  'shadow-extraction', 'resume-job-import', 'admission-v2',
].flatMap((suffix) => [`intern-notifs-dev-${suffix}`, `intern-notifs-dev-${suffix}-dlq`]);
function roleFor(url: string): string {
  if (url.includes('/workers/scripts/intern-notifs-dev-admission/')) return 'admission';
  if (url.includes('/workers/scripts/intern-notifs-dev-catalog-publisher/')) return 'catalog-publisher';
  if (url.includes('/workers/scripts/intern-notifs-dev-ingestion/')) return 'ingestion';
  if (url.includes('/workers/scripts/intern-notifs-dev/')) return 'api';
  throw new Error(`Unknown Worker in request: ${url}`);
}
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const result = (value: unknown) => Response.json({ success: true, result: value });
  if (url.endsWith('/query')) {
    const { sql, params } = JSON.parse(String(init?.body));
    if (!sql.startsWith('SELECT')) throw new Error('Only read-only queries are allowed');
    if (sql.includes('queue_failure_events') && sql.includes('resolved_at IS NULL')) {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      assert.ok(plan.some(row => String(row.detail).includes('queue_failure_unresolved_age')),
        'Unresolved incident inspection must use the partial index rather than scan resolved history');
    }
    return result([{ results: database.prepare(sql).all(...params) }]);
  }
  if (url.endsWith('/deployments')) {
    const role = roleFor(url);
    return result({ deployments: [{
    created_on: new Date(Date.now() - Number(process.env.SOAK_TEST_DEPLOYMENT_HOURS) * 3_600_000).toISOString(),
    versions: [{ version_id: `${role}-test-version`, percentage: 100 }],
    }] });
  }
  if (url.endsWith('/settings')) {
    const config = configs[roleFor(url)];
    return result({ bindings: Object.entries(config.vars)
      .map(([name, text]) => ({ name, type: 'plain_text', text })) });
  }
  if (url.endsWith('/schedules')) {
    const config = configs[roleFor(url)];
    return result({ schedules: (config.triggers?.crons ?? []).map((cron: string) => ({ cron })) });
  }
  if (url.includes('/queues?')) return result(queueNames.map((queue_name, index) => ({ queue_name, queue_id: `queue-${index}` })));
  if (url.endsWith('/consumers')) return result([{ script_name: 'intern-notifs-dev-admission' }]);
  if (url.endsWith('/metrics')) return result({ backlog_count: 0, backlog_bytes: 0 });
  if (url.includes('/objects/')) return new Response('', { status: 404 });
  if (url.includes('/catalog?')) return Response.json({ groups: [] });
  if (url.endsWith('/graphql')) return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: runtimeRoles.map((role) => ({
    dimensions: { scriptName: `intern-notifs-dev-${role}`, scriptVersion: `${role}-test-version`, status: 'success' },
    sum: { requests: 30, errors: 0 }, quantiles: { cpuTimeP99: 1, memoryUsageBytesP99: 60 * 1024 * 1024 },
  })) }] } } });
  throw new Error(`Unexpected test request: ${url}`);
};
