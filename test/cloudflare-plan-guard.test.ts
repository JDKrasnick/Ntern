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
  it('accepts only the existing admission attachment transfer with computed Cloudflare defaults', () => {
    const before = {
      account_id: 'account', queue_id: 'existing-admission-queue', queue_name: 'intern-notifs-admission-v2',
      consumer_id: 'existing-consumer', created_on: '2026-10-03T19:55:29Z', type: 'worker',
      script_name: 'intern-notifs-ingestion', dead_letter_queue: 'intern-notifs-admission-v2-dlq',
      settings: { batch_size: 1, max_concurrency: 1, max_retries: 2, max_wait_time_ms: 5000, retry_delay: 0 },
    };
    const after = { ...before, consumer_id: null, created_on: null, queue_name: null,
      script_name: 'intern-notifs-admission', settings: { ...before.settings, retry_delay: null, visibility_timeout_ms: null } };
    const transfer = { address: 'cloudflare_queue_consumer.admission', actions: ['delete', 'create'], before, after,
      after_unknown: { consumer_id: true, created_on: true, queue_name: true,
        settings: { retry_delay: true, visibility_timeout_ms: true } } };
    expect(validateCloudflarePlan(plan([transfer]))).toHaveLength(1);
    const rollback = { ...transfer, before: { ...before, script_name: 'intern-notifs-admission' },
      after: { ...after, script_name: 'intern-notifs-ingestion' } };
    expect(validateCloudflarePlan(plan([rollback]))).toHaveLength(1);
    for (const unsafe of [
      { ...transfer, address: 'cloudflare_queue_consumer.ingestion["greenhouse"]' },
      { ...transfer, actions: ['delete'] },
      { ...transfer, after: { ...after, queue_id: 'replacement-queue' } },
      { ...transfer, after: { ...after, queue_name: 'other-queue' } },
      { ...transfer, after: { ...after, script_name: 'unreviewed-worker' } },
      { ...transfer, after: { ...after, dead_letter_queue: 'other-dlq' } },
      { ...transfer, after: { ...after, settings: { ...after.settings, max_concurrency: 2 } } },
      { ...transfer, after: { ...after, settings: { ...after.settings, max_retries: 3 } } },
      { ...transfer, after: { ...after, settings: { ...after.settings, batch_size: 2 } } },
      { ...transfer, after: { ...after, settings: { ...after.settings, max_wait_time_ms: 1000 } } },
      { ...transfer, after: { ...after, settings: { ...after.settings, visibility_timeout_ms: 1000 } } },
      { ...transfer, after_unknown: { ...transfer.after_unknown, queue_id: true } },
      { ...transfer, after_unknown: { ...transfer.after_unknown, settings: { max_retries: true } } },
      { ...transfer, after_unknown: {} },
    ]) expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('compares retained ingestion crons as a set during projection transfer', () => {
    const retained = ['0 * * * *', '9-59/10 * * * *', '12,42 * * * *'];
    const projection = ['1-51/10 * * * *', '4,14,24,34,44,54 * * * *'];
    const schedules = (crons: string[]) => crons.map((cron) => ({ cron }));
    const before = { account_id: 'account', script_name: 'intern-notifs-ingestion',
      schedules: schedules([retained[0], projection[0], retained[1], projection[1], retained[2]]) };
    const after = { ...before, schedules: schedules([...retained].reverse()) };
    const transfer = { address: 'cloudflare_workers_cron_trigger.ingestion', actions: ['update'], before, after };
    expect(validateCloudflarePlan(plan([transfer]))).toHaveLength(1);
    expect(validateCloudflarePlan(plan([{ ...transfer, before: after, after: before }]))).toHaveLength(1);
    for (const unsafe of [
      { ...transfer, after: { ...after, schedules: schedules(retained.slice(1)) } },
      { ...transfer, after: { ...after, schedules: schedules([...retained, '*/1 * * * *']) } },
      { ...transfer, after: { ...after, schedules: schedules([...retained, retained[0]]) } },
      { ...transfer, before: { ...before, schedules: [...before.schedules, before.schedules[0]] } },
      { ...transfer, after: { ...after, script_name: 'unreviewed-worker' } },
      { ...transfer, after: { ...after, schedules: [...after.schedules, { cron: projection[0], extra: true }] } },
    ]) expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('accepts no-op plans and in-place Worker script updates', () => {
    expect(validateCloudflarePlan(plan([]))).toEqual([]);
    expect(validateCloudflarePlan(plan([
      contentUpdate,
      { ...contentUpdate, address: 'cloudflare_workers_script.ingestion' },
      { address: 'cloudflare_queue.work["ashby"]', actions: ['no-op'] },
    ]))).toHaveLength(2);
  });

  it('permits only the reviewed Greenhouse concurrency reduction', () => {
    const settings = {
      batch_size: 1,
      max_concurrency: 6,
      max_retries: 2,
      max_wait_time_ms: 5_000,
      retry_delay: 0,
      visibility_timeout_ms: null,
    };
    const consumer = {
      account_id: 'account',
      consumer_id: 'consumer',
      dead_letter_queue: 'intern-notifs-greenhouse-dlq',
      queue_id: 'queue',
      script_name: 'intern-notifs-ingestion',
      settings,
      type: 'worker',
    };
    const reduction = {
      address: 'cloudflare_queue_consumer.ingestion["greenhouse"]',
      actions: ['update'],
      before: consumer,
      after: {
        ...consumer,
        settings: { ...settings, max_concurrency: 2, retry_delay: null },
      },
      after_unknown: { settings: { retry_delay: true, visibility_timeout_ms: true } },
    };

    expect(validateCloudflarePlan(plan([reduction]))).toHaveLength(1);
    for (const unsafe of [
      { ...reduction, address: 'cloudflare_queue_consumer.ingestion["lever"]' },
      { ...reduction, after: { ...reduction.after, settings: { ...reduction.after.settings, max_concurrency: 3 } } },
      { ...reduction, after: { ...reduction.after, settings: { ...reduction.after.settings, batch_size: 2 } } },
      { ...reduction, after: { ...reduction.after, script_name: 'other-worker' } },
      { ...reduction, after_unknown: { settings: { max_retries: true } } },
    ]) expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the exact release annotation on the ingestion upload', () => {
    const priorSha = 'a'.repeat(40);
    const deploySha = 'b'.repeat(40);
    const annotationUpdate = {
      address: 'cloudflare_workers_script.ingestion',
      actions: ['update'],
      before: {
        ...worker,
        annotations: { workers_message: `Release ${priorSha}`, workers_tag: priorSha, workers_triggered_by: 'upload' },
      },
      after: {
        ...worker,
        annotations: { workers_message: `Release ${deploySha}`, workers_tag: deploySha, workers_triggered_by: null },
      },
      after_unknown: {
        ...contentUpdate.after_unknown,
        annotations: { workers_triggered_by: true },
      },
    };
    expect(validateCloudflarePlan(plan([annotationUpdate]), { expectedDeploySha: deploySha })).toHaveLength(1);
    for (const unsafe of [
      { change: annotationUpdate, options: {} },
      { change: annotationUpdate, options: { expectedDeploySha: priorSha } },
      { change: { ...annotationUpdate, address: 'cloudflare_workers_script.other' }, options: { expectedDeploySha: deploySha } },
      {
        change: {
          ...annotationUpdate,
          after: { ...annotationUpdate.after, annotations: { ...annotationUpdate.after.annotations, extra: 'value' } },
        },
        options: { expectedDeploySha: deploySha },
      },
    ]) {
      expect(() => validateCloudflarePlan(plan([unsafe.change]), unsafe.options)).toThrow('Refusing unsafe Cloudflare plan');
    }
    expect(validateCloudflarePlan(plan([{
      ...annotationUpdate,
      address: 'cloudflare_workers_script.application',
    }]), { expectedDeploySha: deploySha })).toHaveLength(1);
  });

  it('permits only the reviewed API invocation-log shutdown', () => {
    const observability = {
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1, persist: true },
      traces: { enabled: false, head_sampling_rate: 1, persist: true },
    };
    const afterObservability = {
      ...observability,
      logs: { ...observability.logs, invocation_logs: false },
    };
    // Content and bindings are unchanged, so only the reviewed logging change can
    // make this an accepted update.
    const shutdown = {
      address: 'cloudflare_workers_script.application',
      actions: ['update'],
      before: { ...worker, observability },
      after: { ...worker, observability: afterObservability },
      after_unknown: contentUpdate.after_unknown,
    };
    expect(validateCloudflarePlan(plan([shutdown]))).toHaveLength(1);
    // Ingestion logging stays at full sampling.
    expect(() => validateCloudflarePlan(plan([{ ...shutdown, address: 'cloudflare_workers_script.ingestion' }])))
      .toThrow('Refusing unsafe Cloudflare plan');
    // Re-enabling invocation logs is refused: the reviewed change is one-way.
    expect(() => validateCloudflarePlan(plan([{
      ...shutdown,
      before: { ...worker, observability: afterObservability },
      after: { ...worker, observability },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
    // No other observability setting may move alongside it.
    expect(() => validateCloudflarePlan(plan([{
      ...shutdown,
      after: { ...worker, observability: { ...afterObservability, head_sampling_rate: 0.5 } },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{
      ...shutdown,
      after: { ...worker, observability: { ...afterObservability, logs: { ...afterObservability.logs, persist: false } } },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the reviewed API preview-URL shutdown', () => {
    const subdomain = {
      account_id: 'account',
      id: 'intern-notifs',
      script_name: 'intern-notifs',
      enabled: true,
      previews_enabled: true,
    };
    const shutdown = {
      address: 'cloudflare_workers_script_subdomain.application',
      actions: ['update'],
      before: subdomain,
      after: { ...subdomain, previews_enabled: false },
    };
    expect(validateCloudflarePlan(plan([shutdown]))).toHaveLength(1);
    for (const unsafe of [
      // Not the API subdomain.
      { ...shutdown, address: 'cloudflare_workers_script_subdomain.ingestion' },
      // The public workers.dev endpoint must stay on.
      { ...shutdown, after: { ...shutdown.after, enabled: false } },
      // Identity must not move.
      { ...shutdown, after: { ...shutdown.after, script_name: 'other' } },
      { ...shutdown, after: { ...shutdown.after, id: 'other' } },
      { ...shutdown, before: { ...subdomain, script_name: 'other' }, after: { ...shutdown.after, script_name: 'other' } },
      // Previews may only move from on to off.
      { ...shutdown, before: { ...subdomain, previews_enabled: false }, after: { ...subdomain } },
    ]) {
      expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
    }
  });

  it('accepts a wasm module part and refuses anything else in it', () => {
    // The shape the provider actually plans: a relative `content_file`, a null
    // `content_base64`, and the computed hash alongside an `application/wasm` type.
    const part = {
      content_base64: null,
      content_file: './../../cloudflare/dist/ingestion/resvg.wasm',
      content_sha256: 'old',
      content_type: 'application/wasm',
    };
    const updated = {
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, files: { 'resvg.wasm': part } },
      after: { ...worker, files: { 'resvg.wasm': { ...part, content_sha256: 'new' } } },
    };
    expect(validateCloudflarePlan(plan([updated]))).toHaveLength(1);
    // Adding the part for the first time is a content change on its own.
    expect(validateCloudflarePlan(plan([{
      ...updated,
      before: { ...worker, files: null },
    }]))).toHaveLength(1);
    // A wasm-only change carries no new JavaScript, so the part is the release.
    expect(validateCloudflarePlan(plan([{
      ...updated,
      before: { ...worker, files: { 'resvg.wasm': { ...part, content_sha256: 'unchanged' } } },
      after: { ...worker, content_sha256: worker.content_sha256, files: { 'resvg.wasm': { ...part, content_sha256: 'new' } } },
    }]))).toHaveLength(1);
    // Any other part, or a part that is not an application/wasm file, is refused.
    for (const files of [
      { 'payload.js': { content_type: 'text/javascript', content_file: 'cloudflare/dist/ingestion/payload.js' } },
      { 'resvg.wasm': { ...part, content_type: 'text/plain' } },
      { 'resvg.wasm': { ...part, content_file: 'cloudflare/dist/ingestion/resvg.js' } },
      { 'resvg.wasm': { ...part, content_file: '/etc/passwd.wasm' } },
      { 'resvg.wasm': 'cloudflare/dist/ingestion/resvg.wasm' },
    ]) {
      expect(() => validateCloudflarePlan(plan([{ ...updated, after: { ...updated.after, files } }])))
        .toThrow('Refusing unsafe Cloudflare plan');
    }
    // The renderer belongs to the ingestion Worker; the API Worker stays wasm-free.
    expect(() => validateCloudflarePlan(plan([{ ...updated, address: 'cloudflare_workers_script.application' }])))
      .toThrow('Refusing unsafe Cloudflare plan');
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
    ['cloudflare_workers_script.ingestion', 'v1-d1-traffic-controller', 'D1TrafficController'],
    ['cloudflare_workers_script.application', 'v4-resume-pdf-compiler-v2', 'ResumePdfCompilerV2'],
  ])('permits retiring only the applied migration for %s', (address, tag, className) => {
    const migration = {
      deleted_classes: null, new_classes: null, new_sqlite_classes: [className],
      new_tag: tag, old_tag: null, renamed_classes: null, steps: null, transferred_classes: null,
    };
    const change = {
      ...contentUpdate, address,
      before: { ...worker, migration_tag: tag, migrations: migration },
      after: { ...contentUpdate.after, migration_tag: tag, migrations: null },
    };
    expect(validateCloudflarePlan(plan([change]))).toHaveLength(1);
    for (const unsafe of [
      { ...change, before: { ...change.before, migration_tag: 'wrong-tag' } },
      { ...change, before: { ...change.before, migrations: { ...migration, new_sqlite_classes: ['OtherClass'] } } },
      { ...change, before: { ...change.before, migrations: { ...migration, old_tag: '' } } },
      { ...change, after: { ...change.after, bindings: [{ name: 'DB', type: 'd1', id: 'other-db' }] } },
    ]) expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it.each([
    ['creates', 'cloudflare_workers_script.ingestion', ['create']],
    ['replacements', 'cloudflare_workers_script.application', ['delete', 'create']],
  ])('rejects %s', (_label, address, actions) => {
    expect(() => validateCloudflarePlan(plan([{ address, actions }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the reviewed retention cron move', () => {
    const priorCrons = [
      '*/5 * * * *', '7-57/10 * * * *', '9-59/10 * * * *',
      '12,42 * * * *', '22,52 * * * *', '2,32 * * * *',
      '0 * * * *', '42 8 * * *', '17 9 * * *',
    ];
    const schedules = (crons: string[]) => crons.map((cron) => ({
      cron, created_on: '2026-09-09T02:46:21.716587Z', modified_on: '2026-09-09T02:46:21.716587Z',
    }));
    const before = {
      account_id: 'account', id: 'intern-notifs-ingestion', script_name: 'intern-notifs-ingestion',
      schedules: schedules(priorCrons),
    };
    const afterCrons = priorCrons.map((cron) => cron === '42 8 * * *' ? '34 8 * * *' : cron);
    const after = {
      ...before,
      schedules: schedules(afterCrons).map(({ cron, created_on }) => ({ cron, created_on })),
    };
    const after_unknown = { schedules: afterCrons.map(() => ({ modified_on: true })) };
    const change = { address: 'cloudflare_workers_cron_trigger.ingestion', actions: ['update'], before, after, after_unknown };

    expect(validateCloudflarePlan(plan([change]))).toHaveLength(1);
    for (const unsafe of [
      { ...change, after: { ...after, script_name: 'other-worker' } },
      { ...change, after: { ...after, schedules: schedules([...afterCrons, '1 * * * *']) } },
      { ...change, after: { ...after, schedules: schedules(priorCrons.map((cron) => cron === '42 8 * * *' ? '35 8 * * *' : cron)) } },
      { ...change, after_unknown: { schedules: afterCrons.map(() => ({ created_on: true, modified_on: true })) } },
      { ...change, before: after, after: before },
    ]) expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the reviewed dedicated icon cron addition', () => {
    const beforeCrons = [
      '*/5 * * * *', '7-57/10 * * * *', '9-59/10 * * * *',
      '12,42 * * * *', '22,52 * * * *', '2,32 * * * *',
      '0 * * * *', '34 8 * * *', '17 9 * * *',
    ];
    const afterCrons = [...beforeCrons.slice(0, 3), '6-56/10 * * * *', ...beforeCrons.slice(3)];
    const schedules = (crons: string[]) => crons.map((cron) => ({
      cron, created_on: '2026-09-29T04:55:25.781738Z', modified_on: '2026-09-29T04:55:25.781738Z',
    }));
    const before = {
      account_id: 'account', id: 'intern-notifs-ingestion', script_name: 'intern-notifs-ingestion',
      schedules: schedules(beforeCrons),
    };
    const after = { ...before, schedules: schedules(afterCrons).map(({ cron, created_on }) => ({ cron, created_on })) };
    // OpenTofu's ordered-list diff shifts the existing values after the
    // insertion and places the new element's unknown metadata in the last slot.
    const after_unknown = { schedules: afterCrons.map((_, index) => index === afterCrons.length - 1
      ? { created_on: true, modified_on: true }
      : { modified_on: true }) };
    const change = { address: 'cloudflare_workers_cron_trigger.ingestion', actions: ['update'], before, after, after_unknown };

    expect(validateCloudflarePlan(plan([change]))).toHaveLength(1);
    for (const unsafe of [
      { ...change, after: { ...after, script_name: 'other-worker' } },
      { ...change, after: { ...after, schedules: schedules([...afterCrons, '1 * * * *']) } },
      { ...change, after: { ...after, schedules: schedules(beforeCrons.map((cron) => cron === '34 8 * * *' ? '35 8 * * *' : cron)) } },
      { ...change, after_unknown: { schedules: afterCrons.map((_, index) => index === 0
        ? { created_on: true, modified_on: true }
        : { modified_on: true }) } },
      { ...change, before: after, after: before },
    ]) expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the reviewed catalog-projection cron addition', () => {
    const beforeCrons = [
      '*/5 * * * *', '7-57/10 * * * *', '9-59/10 * * * *', '6-56/10 * * * *',
      '12,42 * * * *', '22,52 * * * *', '2,32 * * * *',
      '0 * * * *', '34 8 * * *', '17 9 * * *',
    ];
    const afterCrons = [...beforeCrons.slice(0, 3), '1-51/10 * * * *', ...beforeCrons.slice(3)];
    const schedules = (crons: string[]) => crons.map((cron) => ({
      cron, created_on: '2026-09-29T04:55:25.781738Z', modified_on: '2026-09-29T04:55:25.781738Z',
    }));
    const before = {
      account_id: 'account', id: 'intern-notifs-ingestion', script_name: 'intern-notifs-ingestion',
      schedules: schedules(beforeCrons),
    };
    const after = { ...before, schedules: schedules(afterCrons).map(({ cron, created_on }) => ({ cron, created_on })) };
    // OpenTofu's ordered-list diff shifts the existing values after the
    // insertion and places the new element's unknown metadata in the last slot.
    const after_unknown = { schedules: afterCrons.map((_, index) => index === afterCrons.length - 1
      ? { created_on: true, modified_on: true }
      : { modified_on: true }) };
    const change = { address: 'cloudflare_workers_cron_trigger.ingestion', actions: ['update'], before, after, after_unknown };

    expect(validateCloudflarePlan(plan([change]))).toHaveLength(1);
    for (const unsafe of [
      { ...change, after: { ...after, script_name: 'other-worker' } },
      { ...change, after: { ...after, schedules: schedules([...afterCrons, '1 * * * *']) } },
      { ...change, after: { ...after, schedules: schedules(beforeCrons.map((cron) => cron === '34 8 * * *' ? '35 8 * * *' : cron)) } },
      { ...change, after_unknown: { schedules: afterCrons.map((_, index) => index === 0
        ? { created_on: true, modified_on: true }
        : { modified_on: true }) } },
      { ...change, before: after, after: before },
    ]) expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the reviewed R2 catalog-projection cron addition', () => {
    const beforeCrons = [
      '*/5 * * * *', '7-57/10 * * * *', '9-59/10 * * * *', '1-51/10 * * * *', '6-56/10 * * * *',
      '12,42 * * * *', '22,52 * * * *', '2,32 * * * *',
      '0 * * * *', '34 8 * * *', '17 9 * * *',
    ];
    const afterCrons = [...beforeCrons.slice(0, 4), '4-54/10 * * * *', ...beforeCrons.slice(4)];
    const schedules = (crons: string[]) => crons.map((cron) => ({
      cron, created_on: '2026-10-05T17:59:44.000000Z', modified_on: '2026-10-05T17:59:44.000000Z',
    }));
    const before = {
      account_id: 'account', id: 'intern-notifs-ingestion', script_name: 'intern-notifs-ingestion',
      schedules: schedules(beforeCrons),
    };
    const after = { ...before, schedules: schedules(afterCrons).map(({ cron, created_on }) => ({ cron, created_on })) };
    const after_unknown = { schedules: afterCrons.map((_, index) => index === afterCrons.length - 1
      ? { created_on: true, modified_on: true }
      : { modified_on: true }) };
    const change = { address: 'cloudflare_workers_cron_trigger.ingestion', actions: ['update'], before, after, after_unknown };

    expect(validateCloudflarePlan(plan([change]))).toHaveLength(1);
    for (const unsafe of [
      { ...change, after: { ...after, script_name: 'other-worker' } },
      { ...change, after: { ...after, schedules: schedules([...afterCrons, '1 * * * *']) } },
      { ...change, after: { ...after, schedules: schedules(beforeCrons.map((cron) => cron === '34 8 * * *' ? '35 8 * * *' : cron)) } },
      { ...change, after_unknown: { schedules: afterCrons.map((_, index) => index === 0
        ? { created_on: true, modified_on: true }
        : { modified_on: true }) } },
      { ...change, before: after, after: before },
    ]) expect(() => validateCloudflarePlan(plan([unsafe]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits only the reviewed R2 cron recreation with explicit minutes', () => {
    const beforeCrons = [
      '*/5 * * * *', '7-57/10 * * * *', '9-59/10 * * * *', '1-51/10 * * * *', '4-54/10 * * * *',
      '6-56/10 * * * *', '12,42 * * * *', '22,52 * * * *', '2,32 * * * *',
      '0 * * * *', '34 8 * * *', '17 9 * * *',
    ];
    const afterCrons = beforeCrons.map((cron) => (
      cron === '4-54/10 * * * *' ? '4,14,24,34,44,54 * * * *' : cron
    ));
    const schedules = (crons: string[]) => crons.map((cron) => ({
      cron, created_on: '2026-10-05T18:11:15.000000Z', modified_on: '2026-10-05T18:11:15.000000Z',
    }));
    const before = {
      account_id: 'account', id: 'intern-notifs-ingestion', script_name: 'intern-notifs-ingestion',
      schedules: schedules(beforeCrons),
    };
    const after = { ...before, schedules: schedules(afterCrons).map(({ cron, created_on }) => ({ cron, created_on })) };
    const after_unknown = { schedules: afterCrons.map(() => ({ modified_on: true })) };
    const change = { address: 'cloudflare_workers_cron_trigger.ingestion', actions: ['update'], before, after, after_unknown };

    expect(validateCloudflarePlan(plan([change]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{ ...change,
      after: { ...after, schedules: schedules(afterCrons.map((cron) => cron === '*/5 * * * *' ? '*/6 * * * *' : cron)) },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{ ...change, before: after, after: before }])))
      .toThrow('Refusing unsafe Cloudflare plan');
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
    'TRUSTED_COMMUNITY_CATALOG_ENABLED',
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

  it('accepts retiring the stale-evidence alert threshold binding', () => {
    const name = 'ADMISSION_STALE_ALERT_THRESHOLD';
    expect(validateCloudflarePlan(plan([{
      address: 'cloudflare_workers_script.ingestion',
      actions: ['update'],
      before: { ...worker, content_sha256: 'old-sha', bindings: [...worker.bindings, { name, type: 'plain_text', text: '1' }] },
      after: { ...worker, content_sha256: 'new-sha', bindings: worker.bindings },
    }]))).toHaveLength(1);
  });

  it('rejects retiring a binding that is not on the reviewed retirement list', () => {
    expect(() => validateCloudflarePlan(plan([{
      address: 'cloudflare_workers_script.ingestion',
      actions: ['update'],
      before: { ...worker, content_sha256: 'old-sha', bindings: [...worker.bindings, { name: 'UNRELATED_SETTING', type: 'plain_text', text: '1' }] },
      after: { ...worker, content_sha256: 'new-sha', bindings: worker.bindings },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('accepts a permitted plain-text change alongside a Durable Object namespace unknown', () => {
    const floor = 'IDENTITY_CONFIRMED_COVERAGE_FLOOR';
    const controller = { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController' };
    expect(validateCloudflarePlan(plan([{
      address: 'cloudflare_workers_script.application',
      actions: ['update'],
      before: { ...worker, bindings: [...worker.bindings, { ...controller, namespace_id: null }, { name: floor, type: 'plain_text', text: '1' }] },
      after: { ...worker, content_sha256: 'new-sha', bindings: [...worker.bindings, controller, { name: floor, type: 'plain_text', text: '0' }] },
      after_unknown: { bindings: [{}, { namespace_id: true }, {}] },
    }]))).toHaveLength(1);
  });

  it('accepts retiring the alert threshold alongside a permitted floor change with a Durable Object unknown', () => {
    const retired = 'ADMISSION_STALE_ALERT_THRESHOLD';
    const floor = 'IDENTITY_CONFIRMED_COVERAGE_FLOOR';
    const controller = { name: 'D1_TRAFFIC_CONTROLLER', type: 'durable_object_namespace', class_name: 'D1TrafficController' };
    expect(validateCloudflarePlan(plan([{
      address: 'cloudflare_workers_script.ingestion',
      actions: ['update'],
      before: { ...worker, content_sha256: 'old-sha', bindings: [
        ...worker.bindings, { ...controller, namespace_id: null },
        { name: retired, type: 'plain_text', text: '1' }, { name: floor, type: 'plain_text', text: '1' }] },
      after: { ...worker, content_sha256: 'new-sha', bindings: [
        ...worker.bindings, controller, { name: floor, type: 'plain_text', text: '0' }] },
      after_unknown: { bindings: [{}, { namespace_id: true }, {}] },
    }]))).toHaveLength(1);
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

  it('permits only the reviewed V2 admission infrastructure rollout', () => {
    const admissionBindings = [
      { name: 'ADMISSION_V2_QUEUE', type: 'queue', queue_name: 'intern-notifs-admission-v2' },
      { name: 'ADMISSION_V2_DLQ', type: 'queue', queue_name: 'intern-notifs-admission-v2-dlq' },
      { name: 'INGESTION_V2_ADMISSION_ENABLED', type: 'plain_text', text: 'false' },
      { name: 'INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
      { name: 'INGESTION_V2_CATALOG_WRITER_ENABLED', type: 'plain_text', text: 'false' },
      { name: 'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
      { name: 'INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
      { name: 'INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
    ];
    const changes = [
      {
        ...contentUpdate,
        address: 'cloudflare_workers_script.ingestion',
        after: { ...contentUpdate.after, bindings: [...worker.bindings, ...admissionBindings] },
      },
      {
        address: 'cloudflare_queue.work["admission-v2"]', actions: ['create'], before: null,
        after: { account_id: 'account', queue_name: 'intern-notifs-admission-v2', settings: { delivery_paused: false, message_retention_period: 86_400 } },
      },
      {
        address: 'cloudflare_queue.dead_letter["admission-v2"]', actions: ['create'], before: null,
        after: { account_id: 'account', queue_name: 'intern-notifs-admission-v2-dlq', settings: { message_retention_period: 1_209_600 } },
      },
      {
        address: 'cloudflare_queue_consumer.ingestion["admission-v2"]', actions: ['create'], before: null,
        after: { account_id: 'account', script_name: 'intern-notifs-ingestion', type: 'worker', dead_letter_queue: 'intern-notifs-admission-v2-dlq', settings: { batch_size: 1, max_concurrency: 1, max_retries: 2, max_wait_time_ms: 5_000 } },
      },
    ];

    expect(validateCloudflarePlan(plan(changes))).toHaveLength(4);
    expect(() => validateCloudflarePlan(plan([{ ...changes[1]!, after: { ...changes[1]!.after, queue_name: 'other' } }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{
      ...changes[0]!,
      after: { ...changes[0]!.after, bindings: [...worker.bindings, ...admissionBindings.map((binding) => binding.name === 'ADMISSION_V2_QUEUE' ? { ...binding, queue_name: 'other' } : binding)] },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits the combined Stage 1 and Stage 2 first rollout and pins the toggles', () => {
    const shadowBindings = [
      { name: 'INGESTION_V2_SHADOW_DISCOVERY_ENABLED', type: 'plain_text', text: 'false' },
      { name: 'INGESTION_V2_SHADOW_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
    ];
    const admissionBindings = [
      { name: 'ADMISSION_V2_QUEUE', type: 'queue', queue_name: 'intern-notifs-admission-v2' },
      { name: 'ADMISSION_V2_DLQ', type: 'queue', queue_name: 'intern-notifs-admission-v2-dlq' },
      { name: 'INGESTION_V2_ADMISSION_ENABLED', type: 'plain_text', text: 'false' },
      { name: 'INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
      { name: 'INGESTION_V2_CATALOG_WRITER_ENABLED', type: 'plain_text', text: 'false' },
      { name: 'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
      { name: 'INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
      { name: 'INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
    ];
    const combined = (bindings: unknown[]) => ({
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      after: { ...contentUpdate.after, bindings },
    });
    // Stage 1 is not on main, so the first production plan introduces both
    // stages' bindings in one update; the guard must accept the reviewed union.
    expect(validateCloudflarePlan(plan([combined([...worker.bindings, ...shadowBindings, ...admissionBindings])]))).toHaveLength(1);
    // A malformed accompanying shadow toggle is still refused.
    expect(() => validateCloudflarePlan(plan([combined([
      ...worker.bindings,
      { ...shadowBindings[1], text: 'Bad/Path' },
      shadowBindings[0],
      ...admissionBindings,
    ])]))).toThrow('Refusing unsafe Cloudflare plan');
    // An unrelated binding added alongside is still refused.
    expect(() => validateCloudflarePlan(plan([combined([
      ...worker.bindings, ...shadowBindings, ...admissionBindings, { name: 'OTHER', type: 'plain_text', text: 'on' },
    ])]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits reviewed V2 admission enablement and allowlist changes after creation', () => {
    const created = [
      { name: 'ADMISSION_V2_QUEUE', type: 'queue', queue_name: 'intern-notifs-admission-v2' },
      { name: 'ADMISSION_V2_DLQ', type: 'queue', queue_name: 'intern-notifs-admission-v2-dlq' },
      { name: 'INGESTION_V2_ADMISSION_ENABLED', type: 'plain_text', text: 'false' },
      { name: 'INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
    ];
    const admissionUpdate = (text: { enabled: string; allowlist: string }) => ({
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, bindings: [...worker.bindings, ...created] },
      after: { ...contentUpdate.after, bindings: [...worker.bindings, ...created.map((binding) => binding.name === 'INGESTION_V2_ADMISSION_ENABLED'
        ? { ...binding, text: text.enabled }
        : binding.name === 'INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST' ? { ...binding, text: text.allowlist } : binding)] },
    });
    // The canary the rollout depends on: turn admission on and scope it.
    expect(validateCloudflarePlan(plan([admissionUpdate({ enabled: 'true', allowlist: 'vanshb03-summer-2027' })]))).toHaveLength(1);
    // A full registry is larger than the old 1,000-character canary bound.
    const fleet = Array.from({ length: 344 }, (_, i) => `greenhouse-reviewed-${i}`).join(',');
    expect(fleet.length).toBeGreaterThan(1000);
    expect(fleet.length).toBeLessThanOrEqual(8192);
    expect(validateCloudflarePlan(plan([admissionUpdate({ enabled: 'true', allowlist: fleet })]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([admissionUpdate({ enabled: 'true', allowlist: 'x'.repeat(8193) })]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([admissionUpdate({ enabled: 'true', allowlist: '*' })]))).toThrow('Refusing unsafe Cloudflare plan');
    // And it can be turned back off.
    expect(validateCloudflarePlan(plan([admissionUpdate({ enabled: 'false', allowlist: '' })]))).toHaveLength(1);
    // An invalid enablement value is still refused.
    expect(() => validateCloudflarePlan(plan([admissionUpdate({ enabled: 'yes', allowlist: '' })]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([admissionUpdate({ enabled: 'true', allowlist: 'Bad/Path' })]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits adding the Stage 3 controls after Stage 2 is already deployed', () => {
    const stage2 = [
      { name: 'INGESTION_V2_SHADOW_DISCOVERY_ENABLED', type: 'plain_text', text: 'true' },
      { name: 'INGESTION_V2_SHADOW_SOURCE_ALLOWLIST', type: 'plain_text', text: 'canary' },
      { name: 'INGESTION_V2_ADMISSION_ENABLED', type: 'plain_text', text: 'true' },
      { name: 'INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST', type: 'plain_text', text: 'canary' },
    ];
    const stage3 = [
      { name: 'INGESTION_V2_CATALOG_WRITER_ENABLED', type: 'plain_text', text: 'false' },
      { name: 'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST', type: 'plain_text', text: ',' },
      { name: 'INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST', type: 'plain_text', text: ',' },
      { name: 'INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST', type: 'plain_text', text: ',' },
    ];
    const update = {
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, bindings: [...worker.bindings, ...stage2] },
      after: { ...contentUpdate.after, bindings: [...worker.bindings, ...stage2, ...stage3] },
    };
    expect(validateCloudflarePlan(plan([update]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{
      ...update,
      after: { ...update.after, bindings: [...worker.bindings, ...stage2, ...stage3, { name: 'OTHER', type: 'plain_text', text: 'on' }] },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits the exact outbound-notification binding addition by itself or with Stage 3', () => {
    const outbound = { name: 'OUTBOUND_NOTIFICATIONS_ENABLED', type: 'plain_text', text: 'true' };
    expect(validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: { ...contentUpdate.after, bindings: [outbound, ...worker.bindings] },
    }]))).toHaveLength(1);
    expect(validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: { ...contentUpdate.after, bindings: [{ ...outbound, namespace_id: null }, ...worker.bindings] },
    }]))).toHaveLength(1);

    const stage2 = [
      { name: 'INGESTION_V2_SHADOW_DISCOVERY_ENABLED', type: 'plain_text', text: 'true' },
      { name: 'INGESTION_V2_SHADOW_SOURCE_ALLOWLIST', type: 'plain_text', text: 'canary' },
      { name: 'INGESTION_V2_ADMISSION_ENABLED', type: 'plain_text', text: 'true' },
      { name: 'INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST', type: 'plain_text', text: 'canary' },
    ];
    const stage3 = [
      { name: 'INGESTION_V2_CATALOG_WRITER_ENABLED', type: 'plain_text', text: 'false' },
      { name: 'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST', type: 'plain_text', text: ',' },
      { name: 'INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST', type: 'plain_text', text: ',' },
      { name: 'INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST', type: 'plain_text', text: ',' },
    ];
    const ingestionUpdate = {
      ...contentUpdate,
      address: 'cloudflare_workers_script.ingestion',
      before: { ...worker, bindings: [...worker.bindings, ...stage2] },
      after: { ...contentUpdate.after, bindings: [outbound, ...worker.bindings, ...stage2, ...stage3] },
    };
    expect(validateCloudflarePlan(plan([ingestionUpdate]))).toHaveLength(1);

    for (const invalidOutbound of [
      { ...outbound, text: 'false' },
      { ...outbound, type: 'secret_text' },
      { ...outbound, extra: 'value' },
    ]) {
      expect(() => validateCloudflarePlan(plan([{
        ...contentUpdate,
        after: { ...contentUpdate.after, bindings: [invalidOutbound, ...worker.bindings] },
      }]))).toThrow('Refusing unsafe Cloudflare plan');
    }
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      after: { ...contentUpdate.after, bindings: [outbound, outbound, ...worker.bindings] },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
    expect(() => validateCloudflarePlan(plan([{
      ...ingestionUpdate,
      after: { ...ingestionUpdate.after, bindings: [...ingestionUpdate.after.bindings, { name: 'OTHER', type: 'plain_text', text: 'on' }] },
    }]))).toThrow('Refusing unsafe Cloudflare plan');
  });

  it('permits enabling the existing resume feature flag but not disabling it', () => {
    const disabled = { name: 'RESUME_TUNER_ENABLED', type: 'plain_text', text: 'false' };
    const enabled = { ...disabled, text: 'true' };
    expect(validateCloudflarePlan(plan([{
      ...contentUpdate,
      before: { ...worker, bindings: [...worker.bindings, disabled] },
      after: { ...contentUpdate.after, bindings: [enabled, ...[...worker.bindings].reverse()] },
    }]))).toHaveLength(1);
    expect(() => validateCloudflarePlan(plan([{
      ...contentUpdate,
      before: { ...worker, bindings: [...worker.bindings, enabled] },
      after: { ...contentUpdate.after, bindings: [...worker.bindings, disabled] },
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
