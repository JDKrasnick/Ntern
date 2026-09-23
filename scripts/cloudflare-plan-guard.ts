import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

type ResourceChange = {
  address: string;
  change: {
    actions: string[];
    before?: unknown;
    after?: unknown;
    after_unknown?: unknown;
  };
};
export type Plan = {
  resource_changes?: ResourceChange[];
};

const allowedUpdates = new Set([
  'cloudflare_workers_script.application',
  'cloudflare_workers_script.ingestion',
]);

const resumeInfrastructureCreates = new Set([
  'cloudflare_queue.work["resume-job-import"]',
  'cloudflare_queue.dead_letter["resume-job-import"]',
  'cloudflare_queue_consumer.ingestion["resume-job-import"]',
]);

const resumeWorkerBindings: Record<string, Array<Record<string, unknown>>> = {
  'cloudflare_workers_script.application': [
    { name: 'AI', type: 'ai' },
    { name: 'RESUME_EMBEDDINGS', type: 'vectorize', index_name: 'intern-notifs-resume-bank-v1' },
    { name: 'RESUME_PDF_COMPILER', type: 'durable_object_namespace', class_name: 'ResumePdfCompiler' },
    { name: 'RESUME_JOB_IMPORT_QUEUE', type: 'queue', queue_name: 'intern-notifs-resume-job-import' },
    { name: 'RESUME_TUNER_ENABLED', type: 'plain_text', text: 'false' },
  ],
  'cloudflare_workers_script.ingestion': [
    { name: 'RESUME_JOB_IMPORT_QUEUE', type: 'queue', queue_name: 'intern-notifs-resume-job-import' },
    { name: 'RESUME_JOB_IMPORT_DLQ', type: 'queue', queue_name: 'intern-notifs-resume-job-import-dlq' },
    { name: 'RESUME_TUNER_ENABLED', type: 'plain_text', text: 'false' },
  ],
};

const allowedContentFields = new Set(['content_file', 'content_sha256']);
// Terraform redacts these production values in a Worker script update. They
// are the only configuration bindings that the production release workflow is
// allowed to reconcile along with a new Worker bundle.
const permittedPlainTextBindings = new Set([
  'AUTH_FROM_EMAIL',
  'IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED',
  'IDENTITY_CONFIRMED_COVERAGE_FLOOR',
]);
const disabledMetadataPolicy = {
  enabled: false,
  version: 'disabled',
  allowedFields: [],
  cohort: [],
};

function disablesReviewedMetadataCanary(before: string, after: string): boolean {
  try {
    const prior = JSON.parse(before) as unknown;
    const next = JSON.parse(after) as unknown;
    return isRecord(prior)
      && prior.enabled === true
      && prior.version === 'production-canary-2026-09-09-v1'
      && isDeepStrictEqual(next, disabledMetadataPolicy);
  } catch {
    return false;
  }
}
// These provider-computed values may legitimately change after uploading new
// code. Keep this list explicit so a new provider field fails closed.
const computedWorkerPaths = new Set([
  'created_on',
  'etag',
  'handlers',
  'has_assets',
  'has_modules',
  'id',
  'last_deployed_from',
  'migration_tag',
  'modified_on',
  'named_handlers',
  'placement_mode',
  'placement_status',
  'startup_time_ms',
]);
// The provider reports these optional computed values as unknown when they are
// not configured. Ignore them only in that case; a configured value remains
// protected and is rejected if it changes.
const optionallyComputedWorkerPaths = new Set([
  'annotations',
  'observability.traces.propagation_policy',
  'placement',
  'tail_consumers',
]);
const omitted = Symbol('omitted');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protectedWorkerValue(
  value: unknown,
  unknown: unknown,
  path = '',
): unknown | typeof omitted {
  if (allowedContentFields.has(path) || computedWorkerPaths.has(path)) return omitted;
  if (optionallyComputedWorkerPaths.has(path) && unknown === true) return omitted;
  if (Array.isArray(value)) {
    return value.map((item, index) => (
      protectedWorkerValue(item, Array.isArray(unknown) ? unknown[index] : undefined, path)
    )).filter((item) => item !== omitted);
  }
  if (!isRecord(value)) return value;

  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const childPath = path ? `${path}.${key}` : key;
    const child = protectedWorkerValue(item, isRecord(unknown) ? unknown[key] : undefined, childPath);
    return child === omitted ? [] : [[key, child]];
  }));
}

function containsUnknown(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsUnknown);
  if (isRecord(value)) return Object.values(value).some(containsUnknown);
  return false;
}

function isPermittedBindingUpdate(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const controller = after.find((binding) => isRecord(binding) && binding.name === 'D1_TRAFFIC_CONTROLLER');
  const afterWithoutController = after.filter((binding) => !isRecord(binding) || binding.name !== 'D1_TRAFFIC_CONTROLLER');
  const addedController = !before.some((binding) => isRecord(binding) && binding.name === 'D1_TRAFFIC_CONTROLLER')
    && afterWithoutController.length + 1 === after.length
    && isRecord(controller)
    && controller.type === 'durable_object_namespace'
    && controller.class_name === 'D1TrafficController';
  if (addedController) return isDeepStrictEqual(before, afterWithoutController);
  if (before.length !== after.length) return false;
  let permittedBindingChanged = false;
  const plainTextUpdate = before.every((binding, index) => {
    const nextBinding = after[index];
    if (!isRecord(binding) || !isRecord(nextBinding)) return false;
    if (binding.name !== nextBinding.name) return false;
    if (binding.name === 'LLM_METADATA_PUBLICATION_POLICY_JSON') {
      if (binding.type !== 'plain_text' || nextBinding.type !== 'plain_text') return false;
      const { text: beforeText, ...beforeRest } = binding;
      const { text: afterText, ...afterRest } = nextBinding;
      if (!isDeepStrictEqual(beforeRest, afterRest) || typeof beforeText !== 'string' || typeof afterText !== 'string') return false;
      if (beforeText === afterText) return true;
      if (!disablesReviewedMetadataCanary(beforeText, afterText)) return false;
      permittedBindingChanged = true;
      return true;
    }
    if (!permittedPlainTextBindings.has(String(binding.name))) return isDeepStrictEqual(binding, nextBinding);
    if (binding.type !== 'plain_text' || nextBinding.type !== 'plain_text') return false;
    const { text: beforeText, ...beforeRest } = binding;
    const { text: afterText, ...afterRest } = nextBinding;
    if (typeof beforeText !== 'string' || typeof afterText !== 'string' || !isDeepStrictEqual(beforeRest, afterRest)) return false;
    permittedBindingChanged ||= beforeText !== afterText;
    return true;
  }) && permittedBindingChanged;
  return addedController || plainTextUpdate;
}

function isCatalogR2ReadToggle(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const name = 'CATALOG_R2_READ_ENABLED';
  const oldBindings = before.filter((binding) => isRecord(binding) && binding.name === name);
  const newBindings = after.filter((binding) => isRecord(binding) && binding.name === name);
  if (newBindings.length !== 1 || !isRecord(newBindings[0])) return false;
  const enabled = newBindings[0];
  if (enabled.type !== 'plain_text' || !['true', 'false'].includes(String(enabled.text))) return false;
  if (oldBindings.length === 0) {
    // First enablement is the only permitted binding addition. Terraform may
    // insert it into the ordered list, so compare everything after removal.
    return isDeepStrictEqual(enabled, { name, type: 'plain_text', text: 'true' })
      && after.length === before.length + 1
      && isDeepStrictEqual(before, after.filter((binding) => !isRecord(binding) || binding.name !== name));
  }
  if (oldBindings.length !== 1 || before.length !== after.length || !isRecord(oldBindings[0])) return false;
  if (!isDeepStrictEqual({ ...oldBindings[0], text: enabled.text }, enabled)) return false;
  if (oldBindings[0].text === enabled.text) return false;
  return isDeepStrictEqual(
    before.filter((binding) => !isRecord(binding) || binding.name !== name),
    after.filter((binding) => !isRecord(binding) || binding.name !== name),
  );
}

function isSafeWorkerUpdate(address: string, change: ResourceChange['change']): boolean {
  if (!isRecord(change.before) || !isRecord(change.after)) return false;
  const before = change.before;
  const after = change.after;

  const contentChanged = [...allowedContentFields].some((field) => (
    !isDeepStrictEqual(before[field], after[field])
  ));
  const permittedBindingChanged = isPermittedBindingUpdate(before.bindings, after.bindings)
    || (address === 'cloudflare_workers_script.application' && isCatalogR2ReadToggle(before.bindings, after.bindings));
  // The ingestion Worker exhausted its 10,000-subrequest invocation budget
  // while finishing a bounded GitHub source slice. Permit only this reviewed
  // increase; all other Worker limits remain protected.
  const permittedSubrequestIncrease = address === 'cloudflare_workers_script.ingestion'
    && isDeepStrictEqual(before.limits, { cpu_ms: 120_000, subrequests: 10_000 })
    && isDeepStrictEqual(after.limits, { cpu_ms: 120_000, subrequests: 50_000 });
  if (!contentChanged && !permittedBindingChanged && !permittedSubrequestIncrease) return false;

  const beforeForComparison = {
    ...before,
    ...(permittedBindingChanged ? { bindings: after.bindings } : {}),
    ...(permittedSubrequestIncrease ? { limits: after.limits } : {}),
  };

  const afterUnknown = change.after_unknown;
  if (!isDeepStrictEqual(
    protectedWorkerValue(beforeForComparison, afterUnknown),
    protectedWorkerValue(after, afterUnknown),
  )) return false;

  return !containsUnknown(protectedWorkerValue(afterUnknown, afterUnknown));
}

function isResumeWorkerUpdate(address: string, change: ResourceChange['change']): boolean {
  if (!isRecord(change.before) || !isRecord(change.after)) return false;
  const expectedBindings = resumeWorkerBindings[address];
  if (!expectedBindings || !Array.isArray(change.before.bindings) || !Array.isArray(change.after.bindings)) return false;
  const expectedNames = new Set(expectedBindings.map(({ name }) => name));
  if (change.before.bindings.some((binding) => isRecord(binding) && expectedNames.has(binding.name))) return false;
  for (const expected of expectedBindings) {
    const matches = change.after.bindings.filter((binding) => isRecord(binding) && binding.name === expected.name);
    if (matches.length !== 1 || !isRecord(matches[0])) return false;
    if (Object.entries(matches[0]).some(([key, value]) => (
      key in expected ? !isDeepStrictEqual(value, expected[key]) : value !== null
    ))) return false;
  }
  const bindingsWithoutResume = change.after.bindings.filter((binding) => !isRecord(binding) || !expectedNames.has(binding.name));
  if (!isDeepStrictEqual(change.before.bindings, bindingsWithoutResume)) return false;

  const migrationChanged = address === 'cloudflare_workers_script.application';
  if (migrationChanged && (!isRecord(change.after.migrations)
    || change.after.migrations.new_tag !== 'v2-resume-pdf-compiler'
    || !isDeepStrictEqual(change.after.migrations.new_sqlite_classes, ['ResumePdfCompiler'])
    || Object.entries(change.after.migrations).some(([key, value]) => (
      !['new_tag', 'new_sqlite_classes'].includes(key) && value !== null
    )))) return false;
  if (!migrationChanged && !isDeepStrictEqual(change.before.migrations, change.after.migrations)) return false;

  const beforeForComparison = {
    ...change.before,
    bindings: change.after.bindings,
    ...(migrationChanged ? { migrations: change.after.migrations } : {}),
  };
  let afterUnknown = change.after_unknown;
  if (isRecord(afterUnknown) && Array.isArray(afterUnknown.bindings)) {
    const compilerIndex = change.after.bindings.findIndex((binding) => isRecord(binding) && binding.name === 'RESUME_PDF_COMPILER');
    const bindingUnknowns = afterUnknown.bindings;
    if (compilerIndex >= 0 && !isDeepStrictEqual(bindingUnknowns[compilerIndex], { namespace_id: true })) return false;
    afterUnknown = {
      ...afterUnknown,
      bindings: bindingUnknowns.map((unknown, index) => index === compilerIndex ? {} : unknown),
    };
  }
  if (!isDeepStrictEqual(
    protectedWorkerValue(beforeForComparison, afterUnknown),
    protectedWorkerValue(change.after, afterUnknown),
  )) return false;
  return !containsUnknown(protectedWorkerValue(afterUnknown, afterUnknown));
}

function isResumeInfrastructureCreate(address: string, change: ResourceChange['change']): boolean {
  if (!resumeInfrastructureCreates.has(address) || change.before !== null || !isRecord(change.after)) return false;
  const after = change.after;
  const accountId = after.account_id;
  if (typeof accountId !== 'string' || accountId.length === 0) return false;

  if (address === 'cloudflare_queue.work["resume-job-import"]') {
    return after.queue_name === 'intern-notifs-resume-job-import'
      && isDeepStrictEqual(after.settings, { delivery_paused: false, message_retention_period: 86_400 });
  }
  if (address === 'cloudflare_queue.dead_letter["resume-job-import"]') {
    return after.queue_name === 'intern-notifs-resume-job-import-dlq'
      && isDeepStrictEqual(after.settings, { message_retention_period: 1_209_600 });
  }
  return after.script_name === 'intern-notifs-ingestion'
    && after.type === 'worker'
    && after.dead_letter_queue === 'intern-notifs-resume-job-import-dlq'
    && isRecord(after.settings)
    && after.settings.batch_size === 1
    && after.settings.max_concurrency === 1
    && after.settings.max_retries === 2
    && after.settings.max_wait_time_ms === 5_000
    && Object.keys(after.settings).every((key) => ['batch_size', 'max_concurrency', 'max_retries', 'max_wait_time_ms'].includes(key));
}

export function actionableChanges(plan: Plan): Array<{ address: string; actions: string[] }> {
  return (plan.resource_changes ?? [])
    .filter(({ change }) => !change.actions.every((action) => action === 'no-op' || action === 'read'))
    .map(({ address, change }) => ({ address, actions: change.actions }));
}

export function validateCloudflarePlan(plan: Plan): Array<{ address: string; actions: string[] }> {
  const resourceChanges = (plan.resource_changes ?? []).filter(({ change }) => (
    !change.actions.every((action) => action === 'no-op' || action === 'read')
  ));
  const unsafe = resourceChanges.filter(({ address, change }) => (
    change.actions.length !== 1
    || !(
      (change.actions[0] === 'update'
        && allowedUpdates.has(address)
        && (isSafeWorkerUpdate(address, change) || isResumeWorkerUpdate(address, change)))
      || (change.actions[0] === 'create' && isResumeInfrastructureCreate(address, change))
    )
  )).map(({ address, change }) => ({ address, actions: change.actions }));

  if (unsafe.length > 0) {
    throw new Error(`Refusing unsafe Cloudflare plan: ${JSON.stringify(unsafe)}`);
  }

  return actionableChanges(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Plan;
  const changes = validateCloudflarePlan(plan);
  console.log(`Safe plan: ${changes.length} reviewed infrastructure change(s).`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\n`);
  }
}
