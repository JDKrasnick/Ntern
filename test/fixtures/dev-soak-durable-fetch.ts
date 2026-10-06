// Run the real soak CLI against migrated SQLite without Cloudflare mutations.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const database = new DatabaseSync(process.env.SOAK_TEST_DATABASE!);
const config = JSON.parse(readFileSync(new URL('../../wrangler.dev.ingestion.jsonc', import.meta.url), 'utf8'));
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
  if (url.endsWith('/deployments')) return result({ deployments: [{
    created_on: new Date(Date.now() - Number(process.env.SOAK_TEST_DEPLOYMENT_HOURS) * 3_600_000).toISOString(),
    versions: [{ version_id: 'test-version', percentage: 100 }],
  }] });
  if (url.endsWith('/settings')) return result({ bindings: Object.entries(config.vars)
    .map(([name, text]) => ({ name, type: 'plain_text', text })) });
  if (url.endsWith('/schedules')) return result({ schedules: config.triggers.crons.map((cron: string) => ({ cron })) });
  if (url.includes('/queues?')) return result([]);
  if (url.includes('/objects/')) return new Response('', { status: 404 });
  if (url.includes('/catalog?')) return Response.json({ groups: [] });
  if (url.endsWith('/graphql')) return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{
    dimensions: { scriptName: 'intern-notifs-dev-ingestion', scriptVersion: 'test-version', status: 'success' },
    sum: { requests: 30, errors: 0 }, quantiles: { cpuTimeP99: 1, memoryUsageBytesP99: 60 * 1024 * 1024 },
  }] }] } } });
  throw new Error(`Unexpected test request: ${url}`);
};
