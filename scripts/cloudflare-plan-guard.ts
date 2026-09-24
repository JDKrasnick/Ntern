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

function isProspectiveMetadataPolicy(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const fields = value.allowedFields;
  const startsAt = value.startsAt;
  const version = value.version;
  return Object.keys(value).sort().join(',') === 'allowedFields,cohort,enabled,maxReceipts,mode,startsAt,version'
    && value.enabled === true && value.mode === 'prospective-provider-poll'
    && typeof version === 'string' && /^prospective-provider-poll-2026-09-[a-z0-9-]+$/u.test(version)
    && Array.isArray(value.cohort) && value.cohort.length === 0
    && Array.isArray(fields) && fields.length > 0 && fields.length <= 2
    && new Set(fields).size === fields.length && fields.every(field => field === 'compensation' || field === 'locations')
    && Number.isSafeInteger(value.maxReceipts) && Number(value.maxReceipts) >= 1 && Number(value.maxReceipts) <= 25
    && typeof startsAt === 'string' && Number.isFinite(Date.parse(startsAt))
    && new Date(startsAt).toISOString() === startsAt;
}

function permitsProspectiveMetadataPolicy(before: string, after: string): boolean {
  try {
    const prior = JSON.parse(before) as unknown;
    const next = JSON.parse(after) as unknown;
    return (isDeepStrictEqual(prior, disabledMetadataPolicy) && isProspectiveMetadataPolicy(next))
      || (isProspectiveMetadataPolicy(prior) && isDeepStrictEqual(next, disabledMetadataPolicy));
  } catch { return false; }
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
       if (!disablesReviewedMetadataCanary(beforeText, afterText) && !permitsProspectiveMetadataPolicy(beforeText, afterText)) return false;
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
    return enabled.text === 'true'
      && Object.entries(enabled).every(([key, value]) => ['name', 'type', 'text'].includes(key) || value === null)
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
    !allowedUpdates.has(address)
    || change.actions.length !== 1
    || change.actions[0] !== 'update'
    || !isSafeWorkerUpdate(address, change)
  )).map(({ address, change }) => ({ address, actions: change.actions }));

  if (unsafe.length > 0) {
    throw new Error(`Refusing unsafe Cloudflare plan: ${JSON.stringify(unsafe)}`);
  }

  return actionableChanges(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Plan;
  const changes = validateCloudflarePlan(plan);
  console.log(`Safe plan: ${changes.length} Worker script update(s).`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\n`);
  }
}
