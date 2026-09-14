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
type Plan = {
  resource_changes?: ResourceChange[];
};

const allowedUpdates = new Set([
  'cloudflare_workers_script.application',
  'cloudflare_workers_script.ingestion',
]);

const allowedContentFields = new Set(['content_file', 'content_sha256']);
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

function isContentOnlyUpdate(change: ResourceChange['change']): boolean {
  if (!isRecord(change.before) || !isRecord(change.after)) return false;
  const before = change.before;
  const after = change.after;

  const contentChanged = [...allowedContentFields].some((field) => (
    !isDeepStrictEqual(before[field], after[field])
  ));
  if (!contentChanged) return false;

  const afterUnknown = change.after_unknown;
  if (!isDeepStrictEqual(
    protectedWorkerValue(before, afterUnknown),
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
    || !isContentOnlyUpdate(change)
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
