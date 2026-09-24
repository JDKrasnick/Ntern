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

  it('accepts a computed namespace ID for an unchanged Durable Object binding', () => {
    const namespace = {
      name: 'RESUME_PDF_COMPILER',
      type: 'durable_object_namespace',
      class_name: 'ResumePdfCompilerV2',
    };
    expect(validateCloudflarePlan(plan([{
      ...contentUpdate,
      before: {
        ...worker,
        bindings: [...worker.bindings, { ...namespace, namespace_id: null }],
      },
      after: {
        ...contentUpdate.after,
        bindings: [...worker.bindings, namespace],
      },
      after_unknown: {
        ...contentUpdate.after_unknown,
        bindings: [{}, { namespace_id: true }],
      },
    }]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      before: {
        ...worker,
        bindings: [...worker.bindings, { ...namespace, namespace_id: null }],
      },
      after: {
        ...contentUpdate.after,
        bindings: [...worker.bindings, { ...namespace, class_name: 'OtherCompiler' }],
      },
      after_unknown: {
        ...contentUpdate.after_unknown,
        bindings: [{}, { namespace_id: true }],
      },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the temporary resume migration tag bootstrap and cleanup', () => {
    const migration = {
      deleted_classes: null,
      new_classes: null,
      new_sqlite_classes: ['ResumePdfCompilerV2'],
      new_tag: 'v4-resume-pdf-compiler-v2',
      old_tag: null,
      renamed_classes: null,
      steps: null,
      transferred_classes: null,
    };
    const bootstrap = {
      ...contentUpdate,
      before: { ...worker, migrations: migration },
      after: { ...contentUpdate.after, migrations: { ...migration, old_tag: '' } },
    };
    expect(validateCloudflarePlan(plan([bootstrap]))).toHaveLength(1);
    expect(validateCloudflarePlan(plan([{
      ...bootstrap,
      before: bootstrap.after,
      after: bootstrap.before,
    }]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{
      ...bootstrap,
      after: { ...contentUpdate.after, migrations: { ...migration, old_tag: 'wrong-tag' } },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(validateCloudflarePlan(plan([{
      ...bootstrap,
      before: { ...worker, migrations: null },
    }]))).toHaveLength(1);
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
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, migrations: null },
      after: {
        ...contentUpdate.after,
        bindings: [{ name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController', namespace_id: null }, ...worker.bindings],
        migrations: {
          deleted_classes: null,
          new_classes: null,
          new_sqlite_classes: ['D1TrafficController'],
          new_tag: 'v1-d1-traffic-controller',
          old_tag: '',
          renamed_classes: null,
          steps: null,
          transferred_classes: null,
        },
      },
      after_unknown: {
        ...contentUpdate.after_unknown,
        bindings: [{ namespace_id: true }, {}],
        migration_tag: true,
      },
    }]))).toHaveLength(1);
    expect(validateCloudflarePlan(plan([{
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: {
        ...worker,
        migrations: null,
        bindings: [...worker.bindings, { name: 'AUTH_FROM_EMAIL', type: 'plain_text', text: 'old@example.test' }],
      },
      after: {
        ...contentUpdate.after,
        bindings: [
          { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController' },
          { name: 'DB', type: 'd1', id: 'production-db' },
          { name: 'AUTH_FROM_EMAIL', type: 'plain_text', text: 'new@example.test' },
        ],
        migrations: { old_tag: '', new_tag: 'v1-d1-traffic-controller', new_sqlite_classes: ['D1TrafficController'] },
      },
      after_unknown: {
        ...contentUpdate.after_unknown,
        bindings: [{ namespace_id: true }, {}, {}],
      },
    }]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, migrations: null },
      after: {
        ...contentUpdate.after,
        bindings: [...worker.bindings, { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController' }],
        migrations: { old_tag: '', new_tag: 'v1-wrong-class', new_sqlite_classes: ['OtherController'] },
      },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, migrations: null },
      after: {
        ...contentUpdate.after,
        bindings: [...worker.bindings, { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController' }],
        migrations: { old_tag: 'unverified', new_tag: 'v1-d1-traffic-controller', new_sqlite_classes: ['D1TrafficController'] },
      },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
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
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, migrations: null },
      after: {
        ...contentUpdate.after,
        bindings: [
          { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController' },
          ...worker.bindings,
          { name: 'UNRELATED', type: 'plain_text', text: 'unsafe' },
        ],
        migrations: { old_tag: '', new_tag: 'v1-d1-traffic-controller', new_sqlite_classes: ['D1TrafficController'] },
      },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('accepts removing only the verified ingestion bootstrap tag', () => {
    const migration = {
      new_tag: 'v1-d1-traffic-controller',
      new_sqlite_classes: ['D1TrafficController'],
      old_tag: '',
    };
    expect(validateCloudflarePlan(plan([{
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, migrations: migration },
      after: { ...contentUpdate.after, migrations: { ...migration, old_tag: null } },
    }]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, migrations: { ...migration, old_tag: 'unverified' } },
      after: { ...contentUpdate.after, migrations: { ...migration, old_tag: null } },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the reviewed resume infrastructure rollout', () => {
    const apiBindings = [
      { name: 'AI', type: 'ai' },
      { name: 'RESUME_EMBEDDINGS', type: 'vectorize', index_name: 'intern-notifs-resume-bank-v1' },
      { name: 'RESUME_PDF_COMPILER', type: 'durable_object_namespace', class_name: 'ResumePdfCompilerV2' },
      { name: 'RESUME_JOB_IMPORT_QUEUE', type: 'queue', queue_name: 'intern-notifs-resume-job-import' },
      { name: 'RESUME_TUNER_ENABLED', type: 'plain_text', text: 'false' },
    ];
    const ingestionBindings = [
      { name: 'RESUME_JOB_IMPORT_QUEUE', type: 'queue', queue_name: 'intern-notifs-resume-job-import' },
      { name: 'RESUME_JOB_IMPORT_DLQ', type: 'queue', queue_name: 'intern-notifs-resume-job-import-dlq' },
      { name: 'RESUME_TUNER_ENABLED', type: 'plain_text', text: 'false' },
    ];
    const changes = [
      {
        ...contentUpdate,
        before: { ...worker, migrations: null },
        after: {
          ...contentUpdate.after,
          bindings: [...worker.bindings, ...apiBindings],
          migrations: { new_tag: 'v4-resume-pdf-compiler-v2', new_sqlite_classes: ['ResumePdfCompilerV2'] },
        },
        after_unknown: {
          bindings: [...worker.bindings.map(() => ({})), {}, {}, { namespace_id: true }, {}, {}],
          etag: true,
        },
      },
      {
        ...contentUpdate,
        address: 'cloudflare_workers_script.ingestion',
        after: { ...contentUpdate.after, bindings: [...worker.bindings, ...ingestionBindings] },
      },
      {
        address: 'cloudflare_queue.work["resume-job-import"]', actions: ['create'], before: null,
        after: { account_id: 'account', queue_name: 'intern-notifs-resume-job-import', settings: { delivery_paused: false, message_retention_period: 86_400 } },
      },
      {
        address: 'cloudflare_queue.dead_letter["resume-job-import"]', actions: ['create'], before: null,
        after: { account_id: 'account', queue_name: 'intern-notifs-resume-job-import-dlq', settings: { message_retention_period: 1_209_600 } },
      },
      {
        address: 'cloudflare_queue_consumer.ingestion["resume-job-import"]', actions: ['create'], before: null,
        after: { account_id: 'account', script_name: 'intern-notifs-ingestion', type: 'worker', dead_letter_queue: 'intern-notifs-resume-job-import-dlq', settings: { batch_size: 1, max_concurrency: 1, max_retries: 2, max_wait_time_ms: 5_000 } },
      },
    ];

    expect(validateCloudflarePlan(plan(changes))).toHaveLength(5);
    expect(() => validateCloudflarePlan(plan([{ ...changes[2]!, after: { ...changes[2]!.after, queue_name: 'other' } }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{ ...changes[0]!, after: { ...changes[0]!.after, bindings: [...worker.bindings, ...apiBindings.map((binding) => binding.name === 'RESUME_TUNER_ENABLED' ? { ...binding, text: 'true' } : binding)] } }]))).toThrow('Refusing unsafe Cloudflare plan');
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
