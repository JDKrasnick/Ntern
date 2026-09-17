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
