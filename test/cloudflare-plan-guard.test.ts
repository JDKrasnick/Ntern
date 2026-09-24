import { describe, expect, it } from 'vitest';
import { actionableChanges, validateCloudflarePlan } from '../scripts/cloudflare-plan-guard.js';

type TestChange = {
  address: string;
  actions: string[];
  before?: unknown;
  after?: unknown;
  after_unknown?: unknown;
};

const plan = (resourceChanges: TestChange[]) => ({
  resource_changes: resourceChanges.map(({ address, actions, ...values }) => ({
    address,
    change: { actions, ...values },
  })),
});

const worker = {
  account_id: 'account',
  script_name: 'intern-notifs',
  content_file: 'cloudflare/dist/api/api-worker.js',
  content_sha256: 'old-sha',
  bindings: [{ name: 'DB', type: 'd1', id: 'production-db' }],
  compatibility_date: '2026-09-08',
  compatibility_flags: ['nodejs_compat'],
  limits: { cpu_ms: 30_000, subrequests: 10_000 },
};

const contentUpdate = {
  address: 'cloudflare_workers_script.application',
  actions: ['update'],
  before: worker,
  after: { ...worker, content_sha256: 'new-sha' },
  after_unknown: {
    annotations: true,
    etag: true,
    modified_on: true,
    observability: { traces: { propagation_policy: true } },
    placement: true,
    startup_time_ms: true,
    tail_consumers: true,
  },
};

describe('Cloudflare deployment plan guard', () => {
  it('accepts no-op plans and in-place Worker script updates', () => {
    expect(validateCloudflarePlan(plan([]))).toEqual([]);
    expect(validateCloudflarePlan(plan([
      contentUpdate,
      { ...contentUpdate, address: 'cloudflare_workers_script.ingestion' },
      { address: 'cloudflare_queue.work["ashby"]', actions: ['no-op'] },
    ]))).toHaveLength(2);
  });

  it.each([
    ['creates', 'cloudflare_workers_script.ingestion', ['create']],
    ['replacements', 'cloudflare_workers_script.application', ['delete', 'create']],
    ['non-script updates', 'cloudflare_workers_cron_trigger.ingestion', ['update']],
  ])('rejects %s', (_label, address, actions) => {
    expect(() => validateCloudflarePlan(plan([{ address, actions }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('omits data reads from the actionable summary', () => {
    expect(actionableChanges(plan([{ address: 'data.cloudflare_zone.application', actions: ['read'] }]))).toEqual([]);
  });

  it('permits only the reviewed ingestion subrequest increase', () => {
    const increase = { ...contentUpdate, address: 'cloudflare_workers_script.ingestion',
      after: { ...worker, limits: { cpu_ms: 120_000, subrequests: 50_000 } },
      before: { ...worker, limits: { cpu_ms: 120_000, subrequests: 10_000 } } };
    expect(validateCloudflarePlan(plan([increase]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{ ...increase, address: 'cloudflare_workers_script.application' }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{ ...increase,
      after: { ...increase.after, limits: { cpu_ms: 120_000, subrequests: 100_000 } } }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it.each([
    ['bindings', { bindings: [{ name: 'DB', type: 'd1', id: 'other-db' }] }],
    ['compatibility settings', { compatibility_date: '2026-09-09' }],
    ['limits', { limits: { cpu_ms: 10_000, subrequests: 10_000 } }],
  ])('rejects Worker updates that also change %s', (_label, changedFields) => {
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: { ...contentUpdate.after, ...changedFields },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it.each([
    'AUTH_FROM_EMAIL',
    'IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED',
    'IDENTITY_CONFIRMED_COVERAGE_FLOOR',
  ])('accepts the permitted %s plain-text binding update', (name) => {
    expect(validateCloudflarePlan(plan([{
      address: 'cloudflare_workers_script.application',
      actions: ['update'],
      before: {
        ...worker,
        bindings: [...worker.bindings, { name, type: 'plain_text', text: 'old-value' }],
      },
      after: {
        ...worker,
        bindings: [...worker.bindings, { name, type: 'plain_text', text: 'new-value' }],
      },
    }]))).toHaveLength(1);
  });

  it('rejects binding updates beyond the permitted plain-text values', () => {
    expect(() => validateCloudflarePlan(plan([{
      address: 'cloudflare_workers_script.application',
      actions: ['update'],
      before: {
        ...worker,
        bindings: [...worker.bindings, { name: 'UNRELATED_SETTING', type: 'plain_text', text: 'old-value' }],
      },
      after: {
        ...worker,
        bindings: [...worker.bindings, { name: 'UNRELATED_SETTING', type: 'plain_text', text: 'new-value' }],
      },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the reviewed monthly shadow headroom change and rollback', () => {
    const name = 'SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS';
    const change = (beforeText: string, afterText: string) => ({
      address: 'cloudflare_workers_script.ingestion', actions: ['update'],
      before: { ...worker, bindings: [...worker.bindings, { name, type: 'plain_text', text: beforeText }] },
      after: { ...worker, bindings: [...worker.bindings, { name, type: 'plain_text', text: afterText }] },
    });
    expect(validateCloudflarePlan(plan([change('500', '2000')]))).toHaveLength(1);
    expect(validateCloudflarePlan(plan([change('2000', '500')]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([change('500', '3000')]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the production API catalog R2 read toggle', () => {
    const enabled = { name: 'CATALOG_R2_READ_ENABLED', type: 'plain_text', text: 'true' };
    const added = { ...contentUpdate, after: { ...contentUpdate.after, bindings: [enabled, ...worker.bindings] } };
    expect(validateCloudflarePlan(plan([added]))).toHaveLength(1);
    const providerShaped = { ...enabled, service: null, bucket_name: null };
    expect(validateCloudflarePlan(plan([{ ...added, after: { ...added.after,
      bindings: [providerShaped, ...worker.bindings] } }]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{ ...added, address: 'cloudflare_workers_script.ingestion' }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{ ...added, after: { ...added.after,
      bindings: [{ ...enabled, text: 'false' }, ...worker.bindings] } }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{ ...added, after: { ...added.after,
      bindings: [{ ...enabled, service: 'unreviewed' }, ...worker.bindings] } }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{ ...added, after: { ...added.after,
      bindings: [enabled, ...worker.bindings, { name: 'OTHER', type: 'plain_text', text: 'on' }] } }]))).toThrow('Refusing unsafe Cloudflare plan');
    const rollback = { ...contentUpdate, before: { ...worker, bindings: [enabled, ...worker.bindings] },
      after: { ...worker, bindings: [{ ...enabled, text: 'false' }, ...worker.bindings] } };
    expect(validateCloudflarePlan(plan([rollback]))).toHaveLength(1);
  });

  it('allows only disabling the reviewed metadata canary', () => {
    const name = 'LLM_METADATA_PUBLICATION_POLICY_JSON';
    const enabled = JSON.stringify({ enabled: true, version: 'production-canary-2026-09-09-v1', allowedFields: ['compensation'], cohort: [{ sourceId: 'reviewed' }] });
    const disabled = JSON.stringify({ enabled: false, version: 'disabled', allowedFields: [], cohort: [] });
    const change = (beforeText: string, afterText: string) => ({
      address: 'cloudflare_workers_script.ingestion', actions: ['update'],
      before: { ...worker, bindings: [...worker.bindings, { name, type: 'plain_text', text: beforeText }] },
      after: { ...worker, bindings: [...worker.bindings, { name, type: 'plain_text', text: afterText }] },
    });
    expect(validateCloudflarePlan(plan([change(enabled, disabled)]))).toHaveLength(1);
    for (const next of [
      JSON.stringify({ enabled: true, version: 'new-canary', allowedFields: [], cohort: [] }),
      JSON.stringify({ enabled: false, version: 'disabled', allowedFields: ['compensation'], cohort: [] }),
      '{invalid',
    ]) {
      expect(() => validateCloudflarePlan(plan([change(enabled, next)]))).toThrow('Refusing unsafe Cloudflare plan');
    }
    expect(() => validateCloudflarePlan(plan([change(disabled, enabled)]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([change(enabled.replace('production-canary-2026-09-09-v1', 'other-canary'), disabled)]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('allows a bounded prospective provider policy and its rollback', () => {
    const name = 'LLM_METADATA_PUBLICATION_POLICY_JSON';
    const disabled = JSON.stringify({ enabled: false, version: 'disabled', allowedFields: [], cohort: [] });
    const policy = { enabled: true, version: 'prospective-provider-poll-2026-09-v1', mode: 'prospective-provider-poll',
      startsAt: '2026-09-24T03:00:00.000Z', allowedFields: ['compensation', 'locations'], cohort: [], maxReceipts: 25 };
    const update = (beforeText: string, afterText: string) => ({ address: 'cloudflare_workers_script.ingestion', actions: ['update'],
      before: { ...worker, bindings: [...worker.bindings, { name, type: 'plain_text', text: beforeText }] },
      after: { ...worker, bindings: [...worker.bindings, { name, type: 'plain_text', text: afterText }] } });
    expect(validateCloudflarePlan(plan([update(disabled, JSON.stringify(policy))]))).toHaveLength(1);
    expect(validateCloudflarePlan(plan([update(JSON.stringify(policy), disabled)]))).toHaveLength(1);
    const unlimited = { ...policy, maxReceipts: null };
    expect(validateCloudflarePlan(plan([update(JSON.stringify(policy), JSON.stringify(unlimited))]))).toHaveLength(1);
    expect(validateCloudflarePlan(plan([update(JSON.stringify(unlimited), disabled)]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([update(disabled, JSON.stringify(unlimited))]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([update(JSON.stringify(policy), JSON.stringify({ ...unlimited,
      startsAt: '2026-09-23T00:00:00.000Z' }))]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([update(JSON.stringify(policy), JSON.stringify({ ...unlimited,
      allowedFields: ['locations'] }))]))).toThrow('Refusing unsafe Cloudflare plan');
    for (const invalid of [{ ...policy, allowedFields: ['workMode'] }, { ...policy, maxReceipts: 26 },
      { ...policy, cohort: [{ sourceId: 'old' }] }, { ...policy, mode: 'all' }]) {
      expect(() => validateCloudflarePlan(plan([update(disabled, JSON.stringify(invalid))]))).toThrow('Refusing unsafe Cloudflare plan');
    }
  });

  it('accepts only the reviewed traffic-controller Durable Object binding addition', () => {
    expect(validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: { ...contentUpdate.after, bindings: [...worker.bindings, { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController' }] },
    }]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: { ...contentUpdate.after, bindings: [...worker.bindings, { name: 'UNRELATED', type: 'durable_object_namespace', class_name: 'D1TrafficController' }] },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: {
        ...contentUpdate.after,
        bindings: [
          { name: 'DB', type: 'd1', id: 'other-db' },
          { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController' },
        ],
      },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('rejects unknown values in protected Worker fields', () => {
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      after_unknown: { bindings: [{ id: true }] },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('rejects a configured value for an optional computed field', () => {
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: { ...contentUpdate.after, placement: { mode: 'smart' } },
      after_unknown: { etag: true },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('rejects Worker updates without a content change', () => {
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: worker,
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });
});
