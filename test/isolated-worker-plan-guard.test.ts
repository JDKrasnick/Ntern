import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateCloudflarePlan } from '../scripts/cloudflare-plan-guard.js';

const sha = 'a'.repeat(40);
function create(role: 'admission' | 'catalog-publisher') {
  const config = JSON.parse(readFileSync(`wrangler.${role}.jsonc`, 'utf8'));
  const after = { script_name: config.name, main_module: config.main.split('/').at(-1)!.replace('.ts', '.js'),
    compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    limits: config.limits, content_sha256: 'b'.repeat(64), annotations: { workers_tag: sha, workers_message: `Release ${sha}` },
    bindings: [
      { name: 'DB', type: 'd1', id: config.d1_databases[0].database_id },
      ...config.r2_buckets.map((b: { binding: string; bucket_name: string }) => ({ name: b.binding, type: 'r2_bucket', bucket_name: b.bucket_name })),
      { name: 'VERSION_METADATA', type: 'version_metadata' },
      ...config.queues.producers.map((q: { binding: string; queue: string }) => ({ name: q.binding, type: 'queue', queue_name: q.queue })),
      ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    ] };
  return { address: `cloudflare_workers_script.isolated["${role}"]`, change: { actions: ['create'], before: null, after } };
}
function validate(resource: ReturnType<typeof create>) {
  return validateCloudflarePlan({ resource_changes: [resource] }, { expectedDeploySha: sha });
}
describe('isolated Worker release boundaries', () => {
  it.each(['admission', 'catalog-publisher'] as const)('accepts the inert least-privilege %s Worker', (role) => {
    expect(validate(create(role))).toHaveLength(1);
  });
  it.each(['DB', 'OUTBOUND_NOTIFICATIONS_ENABLED', 'INGESTION_V2_ISOLATED_WORKERS_ENABLED', 'ADMISSION_V2_QUEUE'])('rejects unsafe %s bindings at provisioning', (name) => {
    const r = create('admission');
    const binding = r.change.after.bindings.find((b: { name: string }) => b.name === name)!;
    if (name === 'DB') Object.assign(binding, { id: 'another-database' });
    else if (name === 'ADMISSION_V2_QUEUE') Object.assign(binding, { queue_name: 'another-queue' });
    else Object.assign(binding, { text: 'true' });
    expect(() => validate(r)).toThrow('unsafe');
  });
  it('rejects extra model secrets, malformed publication policy, and increased limits', () => {
    const secret = create('admission'); secret.change.after.bindings.push({ name: 'OPENAI_API_KEY', type: 'secret_text' });
    expect(() => validate(secret)).toThrow('unsafe');
    const publisher = create('catalog-publisher');
    Object.assign(publisher.change.after.bindings.find((b: { name: string }) => b.name === 'LLM_METADATA_PUBLICATION_POLICY_JSON')!, { text: '{"enabled":true}' });
    expect(() => validate(publisher)).toThrow('unsafe');
    const enlarged = create('admission'); enlarged.change.after.limits.cpu_ms = 300000;
    expect(() => validate(enlarged)).toThrow('unsafe');
  });
  it('stages the existing verified metadata policy without enabling the publisher', () => {
    const resource = create('catalog-publisher');
    const binding = resource.change.after.bindings.find((b: { name: string }) => b.name === 'LLM_METADATA_PUBLICATION_POLICY_JSON')!;
    const policy = { enabled: true, version: 'prospective-provider-poll-2026-09-v1', mode: 'prospective-provider-poll',
      startsAt: '2026-09-24T03:20:27.000Z', allowedFields: ['compensation', 'locations'], cohort: [], maxReceipts: null };
    Object.assign(binding, { text: JSON.stringify(policy) });
    expect(validate(resource)).toHaveLength(1);
    Object.assign(binding, { text: JSON.stringify({ ...policy, allowedFields: ['eligibility'] }) });
    expect(() => validate(resource)).toThrow('unsafe');
    Object.assign(binding, { text: JSON.stringify(policy) });
    Object.assign(resource.change.after.bindings.find((b: { name: string }) => b.name === 'INGESTION_V2_ISOLATED_WORKERS_ENABLED')!, { text: 'true' });
    expect(() => validate(resource)).toThrow('unsafe');
  });
  it('permits only the admission attachment replacement and preserves the existing queue', () => {
    const before = { account_id: 'account', queue_id: 'existing-queue', consumer_id: 'old-consumer',
      script_name: 'intern-notifs-ingestion', type: 'worker', dead_letter_queue: 'intern-notifs-admission-v2-dlq', settings: { max_retries: 2 } };
    const after = { ...before, consumer_id: null, script_name: 'intern-notifs-admission' };
    const resource = { address: 'cloudflare_queue_consumer.admission', change: { actions: ['delete', 'create'], before, after, after_unknown: { consumer_id: true } } };
    expect(validateCloudflarePlan({ resource_changes: [resource] })).toHaveLength(1);
    expect(() => validateCloudflarePlan({ resource_changes: [{ ...resource, address: 'cloudflare_queue_consumer.ingestion["greenhouse"]' }] })).toThrow('unsafe');
    after.queue_id = 'another-queue';
    expect(() => validateCloudflarePlan({ resource_changes: [resource] })).toThrow('unsafe');
    after.queue_id = before.queue_id; after.settings = { max_retries: 0 };
    expect(() => validateCloudflarePlan({ resource_changes: [resource] })).toThrow('unsafe');
  });

  it('pins the local owner state to the two reviewed Worker names', () => {
    const resource = { address: 'terraform_data.admission_queue_owner', change: { actions: ['create'], before: null, after: { input: 'intern-notifs-ingestion' } } };
    expect(validateCloudflarePlan({ resource_changes: [resource] })).toHaveLength(1);
    resource.change.after.input = 'another-worker';
    expect(() => validateCloudflarePlan({ resource_changes: [resource] })).toThrow('unsafe');
  });

  it('transfers only the existing admission consumer and preserves retry settings', () => {
    const before = { script_name: 'intern-notifs-ingestion', dead_letter_queue: 'intern-notifs-admission-v2-dlq', settings: { batch_size: 1, max_retries: 2 } };
    const resource = { address: 'cloudflare_queue_consumer.ingestion["admission-v2"]', change: { actions: ['update'], before, after: { ...before, script_name: 'intern-notifs-admission' } } };
    expect(validateCloudflarePlan({ resource_changes: [resource] })).toHaveLength(1);
    resource.change.after.settings = { ...before.settings, max_retries: 0 };
    expect(() => validateCloudflarePlan({ resource_changes: [resource] })).toThrow('unsafe');
  });
});
