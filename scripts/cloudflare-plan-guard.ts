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

type PlanValidationOptions = {
  expectedDeploySha?: string;
};

const isolatedAddresses = new Map([
  ['cloudflare_workers_script.isolated["admission"]', 'admission'],
  ['cloudflare_workers_script.isolated["catalog-publisher"]', 'catalog-publisher'],
]);
const allowedUpdates = new Set([
  ...isolatedAddresses.keys(),
  'cloudflare_workers_script.application',
  'cloudflare_workers_script.ingestion',
]);

const resumeInfrastructureCreates = new Set([
  'cloudflare_queue.work["resume-job-import"]',
  'cloudflare_queue.dead_letter["resume-job-import"]',
  'cloudflare_queue_consumer.ingestion["resume-job-import"]',
]);

// Ingestion V2 adds one dedicated admission queue, its DLQ, and one consumer,
// plus the Stage 2 and Stage 3 default-off bindings on the ingestion Worker.
// The create names, settings, and bindings are pinned so a plan cannot
// repurpose them.
const admissionV2InfrastructureCreates = new Set([
  'cloudflare_queue.work["admission-v2"]',
  'cloudflare_queue.dead_letter["admission-v2"]',
  'cloudflare_queue_consumer.ingestion["admission-v2"]',
  'cloudflare_queue_consumer.admission',
]);

const admissionV2IngestionBindings: Array<Record<string, unknown>> = [
  { name: 'ADMISSION_V2_QUEUE', type: 'queue', queue_name: 'intern-notifs-admission-v2' },
  { name: 'ADMISSION_V2_DLQ', type: 'queue', queue_name: 'intern-notifs-admission-v2-dlq' },
  { name: 'INGESTION_V2_ADMISSION_ENABLED', type: 'plain_text', text: 'false' },
  { name: 'INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
  { name: 'INGESTION_V2_CATALOG_WRITER_ENABLED', type: 'plain_text', text: 'false' },
  { name: 'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
  { name: 'INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
  { name: 'INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST', type: 'plain_text', text: '' },
];

const resumeWorkerBindings: Record<string, Array<Record<string, unknown>>> = {
  'cloudflare_workers_script.application': [
    { name: 'AI', type: 'ai' },
    { name: 'RESUME_EMBEDDINGS', type: 'vectorize', index_name: 'intern-notifs-resume-bank-v1' },
    { name: 'RESUME_PDF_COMPILER', type: 'durable_object_namespace', class_name: 'ResumePdfCompilerV2' },
    { name: 'RESUME_JOB_IMPORT_QUEUE', type: 'queue', queue_name: 'intern-notifs-resume-job-import' },
    { name: 'RESUME_TUNER_ENABLED', type: 'plain_text', text: 'false' },
  ],
  'cloudflare_workers_script.ingestion': [
    { name: 'RESUME_JOB_IMPORT_QUEUE', type: 'queue', queue_name: 'intern-notifs-resume-job-import' },
    { name: 'RESUME_JOB_IMPORT_DLQ', type: 'queue', queue_name: 'intern-notifs-resume-job-import-dlq' },
    { name: 'RESUME_TUNER_ENABLED', type: 'plain_text', text: 'false' },
  ],
};

const allowedContentFields = new Set(['content_file', 'content_sha256', 'files']);
/**
 * The only extra module part a release may carry is the SVG rasterizer, which
 * Wrangler emits and `scripts/prepare-worker-modules.mjs` names. A part is accepted
 * only as an `application/wasm` file whose path is a wasm file, so a plan cannot
 * smuggle an arbitrary file into the upload, and a `files` change counts as a
 * content change so a wasm-only update is still a legitimate release.
 */
function isPermittedModuleParts(before: unknown, after: unknown): boolean {
  if (!isRecord(after)) return false;
  const priorNames = isRecord(before) ? Object.keys(before) : [];
  const names = Object.keys(after);
  if (!names.length || names.some((name) => !/^[a-z0-9._-]+\.wasm$/u.test(name))) return false;
  if (priorNames.some((name) => !names.includes(name))) return false;
  return names.every((name) => {
    const part = after[name];
    return isRecord(part)
      && part.content_type === 'application/wasm'
      // A relative path, never an absolute one: Terraform emits `./../../…/resvg.wasm`,
      // and nothing legitimate starts at the filesystem root.
      && typeof part.content_file === 'string' && part.content_file.endsWith('.wasm')
      && !part.content_file.startsWith('/');
  });
}
// Terraform redacts these production values in a Worker script update. They
// are the only configuration bindings that the production release workflow is
// allowed to reconcile along with a new Worker bundle.
const permittedPlainTextBindings = new Set([
  'AUTH_FROM_EMAIL',
  'IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED',
  'IDENTITY_CONFIRMED_COVERAGE_FLOOR',
  // Owner decision 2026-09-16: trust reviewed community lists for source-reported
  // admission. The gate ships off; turning it on is a reviewed release, so the
  // binding is reconcilable rather than protected.
  'TRUSTED_COMMUNITY_CATALOG_ENABLED',
]);
// A binding this release may remove. Durable admission (2026-09-17) made the
// stale-evidence alert structural rather than actionable, so its threshold is
// retired with the signal. Every other binding removal still fails closed.
const retiredPlainTextBindings = new Set([
  'ADMISSION_STALE_ALERT_THRESHOLD',
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

function isProspectiveMetadataPolicy(value: unknown, allowUnlimited = false): boolean {
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
    && ((allowUnlimited && value.maxReceipts === null)
      || (Number.isSafeInteger(value.maxReceipts) && Number(value.maxReceipts) >= 1 && Number(value.maxReceipts) <= 25))
    && typeof startsAt === 'string' && Number.isFinite(Date.parse(startsAt))
    && new Date(startsAt).toISOString() === startsAt;
}

function permitsProspectiveMetadataPolicy(before: string, after: string): boolean {
  try {
    const prior = JSON.parse(before) as unknown;
    const next = JSON.parse(after) as unknown;
    return (isDeepStrictEqual(prior, disabledMetadataPolicy) && isProspectiveMetadataPolicy(next))
      || (isProspectiveMetadataPolicy(prior, true) && isDeepStrictEqual(next, disabledMetadataPolicy))
      || (isProspectiveMetadataPolicy(prior) && isProspectiveMetadataPolicy(next, true)
        && isRecord(prior) && isRecord(next) && prior.maxReceipts === 25 && next.maxReceipts === null
        && isDeepStrictEqual({ ...prior, maxReceipts: null }, next));
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

function bindingsMatchByName(before: unknown[], after: unknown[]): boolean {
  if (before.length !== after.length) return false;
  const indexed = new Map<string, Record<string, unknown>>();
  for (const binding of after) {
    if (!isRecord(binding) || typeof binding.name !== 'string' || indexed.has(binding.name)) return false;
    indexed.set(binding.name, binding);
  }
  const seen = new Set<string>();
  return before.every((binding) => {
    if (!isRecord(binding) || typeof binding.name !== 'string' || seen.has(binding.name)) return false;
    seen.add(binding.name);
    return isDeepStrictEqual(binding, indexed.get(binding.name));
  });
}

function normalizeStableDurableObjectNamespaceIds(
  before: unknown,
  after: unknown,
  unknown: unknown,
): { after: unknown; unknown: unknown } {
  if (!Array.isArray(before) || !Array.isArray(after) || !Array.isArray(unknown)) return { after, unknown };
  const beforeByName = new Map(before.flatMap((binding) => (
    isRecord(binding) && typeof binding.name === 'string' ? [[binding.name, binding] as const] : []
  )));
  const normalizedAfter = [...after];
  const normalizedUnknown = [...unknown];

  after.forEach((binding, index) => {
    if (!isRecord(binding) || binding.type !== 'durable_object_namespace' || typeof binding.name !== 'string') return;
    if (!isDeepStrictEqual(unknown[index], { namespace_id: true })) return;
    const previous = beforeByName.get(binding.name);
    if (!isRecord(previous) || previous.type !== 'durable_object_namespace') return;
    const { namespace_id: previousNamespaceId, ...previousIdentity } = previous;
    const { namespace_id: nextNamespaceId, ...nextIdentity } = binding;
    if (typeof previousNamespaceId !== 'string' && previousNamespaceId !== null) return;
    if (nextNamespaceId !== null && nextNamespaceId !== undefined) return;
    if (!isDeepStrictEqual(previousIdentity, nextIdentity)) return;
    normalizedAfter[index] = { ...binding, namespace_id: previousNamespaceId };
    normalizedUnknown[index] = {};
  });

  return { after: normalizedAfter, unknown: normalizedUnknown };
}

function isExpectedResumeMigration(migration: unknown, oldTag: null | ''): boolean {
  return isRecord(migration)
    && migration.new_tag === 'v4-resume-pdf-compiler-v2'
    && isDeepStrictEqual(migration.new_sqlite_classes, ['ResumePdfCompilerV2'])
    && migration.old_tag === oldTag
    && Object.entries(migration).every(([key, value]) => (
      ['new_tag', 'new_sqlite_classes', 'old_tag'].includes(key) || value === null
    ));
}

function isResumeMigrationTagTransition(before: unknown, after: unknown): boolean {
  if (!isRecord(before) || !isRecord(after)) return false;
  if (!isExpectedResumeMigration(before, before.old_tag === '' ? '' : null)
    || !isExpectedResumeMigration(after, after.old_tag === '' ? '' : null)) return false;
  return (before.old_tag === null && after.old_tag === '')
    || (before.old_tag === '' && after.old_tag === null);
}

function isControllerMigrationTagTransition(before: unknown, after: unknown): boolean {
  if (!isRecord(before) || !isRecord(after)) return false;
  const isExpected = (migration: Record<string, unknown>) => (
    migration.new_tag === 'v1-d1-traffic-controller'
    && isDeepStrictEqual(migration.new_sqlite_classes, ['D1TrafficController'])
    && (migration.old_tag === '' || migration.old_tag === null)
    && Object.entries(migration).every(([key, value]) => (
      ['new_tag', 'new_sqlite_classes', 'old_tag'].includes(key) || value === null
    ))
  );
  return isExpected(before)
    && isExpected(after)
    && before.old_tag === ''
    && after.old_tag === null;
}

function isAppliedMigrationRetirement(address: string, before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  if (after.migrations !== null || !isRecord(before.migrations)) return false;
  const expected = address === 'cloudflare_workers_script.ingestion'
    ? { tag: 'v1-d1-traffic-controller', classes: ['D1TrafficController'] }
    : address === 'cloudflare_workers_script.application'
      ? { tag: 'v4-resume-pdf-compiler-v2', classes: ['ResumePdfCompilerV2'] }
      : undefined;
  if (!expected || before.migration_tag !== expected.tag) return false;
  const migration = before.migrations;
  return migration.new_tag === expected.tag
    && isDeepStrictEqual(migration.new_sqlite_classes, expected.classes)
    && (migration.old_tag === null || migration.old_tag === undefined)
    && Object.entries(migration).every(([key, value]) => (
      ['new_tag', 'new_sqlite_classes', 'old_tag'].includes(key) || value === null
    ));
}

/** Permits removing the bindings in `retiredPlainTextBindings`. The retained
 * bindings must match `after` except that a permitted plain-text binding may also
 * carry its own reviewed text change, so a retirement can land in the same
 * release as a reconciled binding. */
function isPermittedBindingRetirement(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const retained = before.filter((binding) => !(isRecord(binding) && retiredPlainTextBindings.has(String(binding.name))));
  if (retained.length === before.length || retained.length !== after.length) return false;
  return retained.every((binding, index) => {
    const next = after[index];
    if (!isRecord(binding) || !isRecord(next) || binding.name !== next.name) return false;
    if (!permittedPlainTextBindings.has(String(binding.name))) return isDeepStrictEqual(binding, next);
    if (binding.type !== 'plain_text' || next.type !== 'plain_text') return false;
    const { text: beforeText, ...beforeRest } = binding;
    const { text: afterText, ...afterRest } = next;
    return typeof beforeText === 'string' && typeof afterText === 'string' && isDeepStrictEqual(beforeRest, afterRest);
  });
}

function isPermittedBindingUpdate(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const controllers = after.filter((binding) => isRecord(binding) && binding.name === 'D1_TRAFFIC_CONTROLLER');
  const controller = controllers[0];
  const afterWithoutController = after.filter((binding) => !isRecord(binding) || binding.name !== 'D1_TRAFFIC_CONTROLLER');
  const addedController = !before.some((binding) => isRecord(binding) && binding.name === 'D1_TRAFFIC_CONTROLLER')
    && controllers.length === 1
    && afterWithoutController.length + 1 === after.length
    && isRecord(controller)
    && controller.type === 'durable_object_namespace'
    && controller.class_name === 'D1TrafficController'
    && Object.entries(controller).every(([key, value]) => (
      ['name', 'type', 'class_name'].includes(key) || value === null
    ));
  if (addedController) {
    return bindingsMatchByName(before, afterWithoutController)
      || isPermittedBindingUpdate(before, afterWithoutController);
  }
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
    if (binding.name === 'SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS') {
      if (binding.type !== 'plain_text' || nextBinding.type !== 'plain_text') return false;
      const { text: beforeText, ...beforeRest } = binding;
      const { text: afterText, ...afterRest } = nextBinding;
      if (!isDeepStrictEqual(beforeRest, afterRest)) return false;
      if (beforeText === afterText) return true;
      if (!((beforeText === '500' && afterText === '2000') || (beforeText === '2000' && afterText === '500'))) return false;
      permittedBindingChanged = true;
      return true;
    }
    if (binding.name === 'RESUME_TUNER_ENABLED') {
      if (binding.type !== 'plain_text' || nextBinding.type !== 'plain_text') return false;
      const { text: beforeText, ...beforeRest } = binding;
      const { text: afterText, ...afterRest } = nextBinding;
      if (!isDeepStrictEqual(beforeRest, afterRest)) return false;
      if (beforeText === afterText) return true;
      if (beforeText !== 'false' || afterText !== 'true') return false;
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

/**
 * Reviewed privacy change: the API Worker's invocation logs are turned off while
 * its structured application and error logs stay persisted at full sampling.
 * Only `invocation_logs` may move, and only from on to off; every other
 * observability setting must be identical so this cannot silently alter
 * sampling, traces, or log persistence.
 */
function isApiInvocationLogShutdown(before: unknown, after: unknown): boolean {
  if (!isRecord(before) || !isRecord(after)) return false;
  const { logs: beforeLogs, ...beforeRest } = before;
  const { logs: afterLogs, ...afterRest } = after;
  if (!isDeepStrictEqual(beforeRest, afterRest)) return false;
  if (!isRecord(beforeLogs) || !isRecord(afterLogs)) return false;
  const { invocation_logs: beforeInvocation, ...beforeLogRest } = beforeLogs;
  const { invocation_logs: afterInvocation, ...afterLogRest } = afterLogs;
  return beforeInvocation === true
    && afterInvocation === false
    && isDeepStrictEqual(beforeLogRest, afterLogRest);
}

function isReleaseAnnotationUpdate(address: string, after: Record<string, unknown>, expectedDeploySha: string | undefined): boolean {
  if (!allowedUpdates.has(address)
    || typeof expectedDeploySha !== 'string'
    || !/^[0-9a-f]{40}$/u.test(expectedDeploySha)
    || !isRecord(after.annotations)) return false;
  const annotations = after.annotations;
  return annotations.workers_tag === expectedDeploySha
    && annotations.workers_message === `Release ${expectedDeploySha}`
    && Object.entries(annotations).every(([key, value]) => (
      ['workers_message', 'workers_tag'].includes(key)
      || (key === 'workers_triggered_by' && value === null)
    ));
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

const outboundNotificationsBindingName = 'OUTBOUND_NOTIFICATIONS_ENABLED';

/**
 * Removes the first reviewed production addition of the outbound-notification
 * switch so it can be validated together with another reviewed binding change.
 * The binding is pinned to an enabled boolean plain-text value; duplicates,
 * replacements, and configured extra attributes remain unsafe. Provider-schema
 * attributes represented as null are harmless and match the other binding guards.
 */
function withoutReviewedOutboundNotificationsAddition(before: unknown, after: unknown): unknown[] | undefined {
  if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
  if (before.some((binding) => isRecord(binding) && binding.name === outboundNotificationsBindingName)) return undefined;
  const additions = after.filter((binding) => isRecord(binding) && binding.name === outboundNotificationsBindingName);
  if (additions.length !== 1 || !isRecord(additions[0])) return undefined;
  const addition = additions[0];
  if (addition.name !== outboundNotificationsBindingName
    || addition.type !== 'plain_text'
    || addition.text !== 'true'
    || Object.entries(addition).some(([key, value]) => (
      !['name', 'type', 'text'].includes(key) && value !== null
    ))) return undefined;
  return after.filter((binding) => !isRecord(binding) || binding.name !== outboundNotificationsBindingName);
}

// Stage 1/2 ingestion V2 ships behind default-off plain-text bindings. Their
// first addition and later value toggles are reviewed, additive config changes;
// every other binding stays protected. The admission flags need the same
// value-toggle path as shadow discovery, otherwise the reviewed canary that
// flips `INGESTION_V2_ADMISSION_ENABLED` would be refused.
const ingestionV2BooleanToggles = new Set([
  'INGESTION_V2_ISOLATED_WORKERS_ENABLED',
  'INGESTION_V2_SHADOW_DISCOVERY_ENABLED',
  'INGESTION_V2_ADMISSION_ENABLED',
  'INGESTION_V2_CATALOG_WRITER_ENABLED',
]);
const ingestionV2ToggleBindings = new Set([
  ...ingestionV2BooleanToggles,
  'INGESTION_V2_SHADOW_SOURCE_ALLOWLIST',
  'INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST',
  'INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST',
  'INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST',
  'INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST',
]);

function isIngestionV2Toggle(binding: unknown): boolean {
  return isRecord(binding) && ingestionV2ToggleBindings.has(String(binding.name));
}

function isIngestionV2ToggleBinding(binding: unknown): boolean {
  if (!isRecord(binding)) return false;
  const name = String(binding.name);
  if (!ingestionV2ToggleBindings.has(name)) return false;
  if (binding.type !== 'plain_text' || typeof binding.text !== 'string') return false;
  if (!Object.entries(binding).every(([key, value]) => ['name', 'type', 'text'].includes(key) || value === null)) return false;
  return ingestionV2BooleanToggles.has(name)
    ? binding.text === 'true' || binding.text === 'false'
    : binding.text.length <= 1000 && /^[a-z0-9._,-]*$/iu.test(binding.text);
}

function isIngestionV2BindingUpdate(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const isToggle = (binding: unknown) => isRecord(binding) && ingestionV2ToggleBindings.has(String(binding.name));
  const beforeToggles = before.filter(isToggle);
  const afterToggles = after.filter(isToggle);
  if (!afterToggles.length || !afterToggles.every(isIngestionV2ToggleBinding)) return false;
  const names = afterToggles.map((binding) => String((binding as Record<string, unknown>).name));
  if (new Set(names).size !== names.length) return false;
  const stableBefore = before.filter((binding) => !isToggle(binding));
  const stableAfter = after.filter((binding) => !isToggle(binding));
  if (!bindingsMatchByName(stableBefore, stableAfter)) return false;

  if (!beforeToggles.length) {
    // First addition: every toggle is new, so length grows by exactly that many.
    return after.length === before.length + afterToggles.length;
  }
  const afterByName = new Map(afterToggles.map((binding) => [String((binding as Record<string, unknown>).name), binding]));
  let changed = afterToggles.length > beforeToggles.length;
  for (const prior of beforeToggles) {
    const toggle = afterByName.get(String((prior as Record<string, unknown>).name));
    if (!isRecord(prior) || !isRecord(toggle)) return false;
    const { text: priorText, ...priorRest } = prior;
    const { text: nextText, ...nextRest } = toggle;
    if (!isDeepStrictEqual(priorRest, nextRest)) return false;
    if (priorText !== nextText) changed = true;
  }
  return changed;
}

const admissionV2BindingNames = new Set(admissionV2IngestionBindings.map((binding) => String(binding.name)));

function isAdmissionV2WorkerBindingUpdate(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const isAdmission = (binding: unknown) => isRecord(binding) && admissionV2BindingNames.has(String(binding.name));
  if (before.some(isAdmission)) return false;
  const added = after.filter(isAdmission);
  if (added.length !== admissionV2IngestionBindings.length) return false;
  for (const expected of admissionV2IngestionBindings) {
    const matches = added.filter((binding) => isRecord(binding) && binding.name === expected.name);
    if (matches.length !== 1 || !isRecord(matches[0])) return false;
    const match = matches[0];
    if (expected.type === 'queue') {
      if (match.type !== 'queue' || match.queue_name !== expected.queue_name) return false;
    } else if (match.type !== 'plain_text' || typeof match.text !== 'string') {
      return false;
    }
    if (Object.entries(match).some(([key, value]) => (key in expected ? !isDeepStrictEqual(value, expected[key]) : value !== null))) return false;
  }
  const stableAfter = after.filter((binding) => !isAdmission(binding) && !isIngestionV2Toggle(binding));
  const stableBefore = before.filter((binding) => !isAdmission(binding) && !isIngestionV2Toggle(binding));
  if (!bindingsMatchByName(stableBefore, stableAfter)) return false;
  // Stage 1's shadow toggles may arrive in the same reviewed release as the
  // Stage 2 admission bindings, so they are excluded from the stable match.
  // Validate every accompanying toggle's shape here so the combined first
  // rollout is still pinned to the reviewed names and values.
  return after.filter(isIngestionV2Toggle).every(isIngestionV2ToggleBinding);
}

function isResumeTunerEnablement(before: unknown, after: unknown): boolean {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  const name = 'RESUME_TUNER_ENABLED';
  const prior = before.filter((binding) => isRecord(binding) && binding.name === name);
  const next = after.filter((binding) => isRecord(binding) && binding.name === name);
  if (prior.length !== 1 || next.length !== 1 || !isRecord(prior[0]) || !isRecord(next[0])) return false;
  if (prior[0].type !== 'plain_text' || prior[0].text !== 'false') return false;
  if (!isDeepStrictEqual({ ...prior[0], text: 'true' }, next[0])) return false;
  const stableBindingIdentity = (binding: unknown): unknown => {
    if (!isRecord(binding) || binding.type !== 'durable_object_namespace') return binding;
    return { ...binding, namespace_id: null };
  };
  return bindingsMatchByName(
    before.filter((binding) => !isRecord(binding) || binding.name !== name).map(stableBindingIdentity),
    after.filter((binding) => !isRecord(binding) || binding.name !== name).map(stableBindingIdentity),
  );
}

function isSafeWorkerUpdate(address: string, change: ResourceChange['change'], expectedDeploySha?: string): boolean {
  if (!isRecord(change.before) || !isRecord(change.after)) return false;
  const before = change.before;
  const after = change.after;

  const contentChanged = [...allowedContentFields].some((field) => (
    !isDeepStrictEqual(before[field], after[field])
  ));
  // A wasm-only change (a rasterizer bump) carries no new JavaScript, so the module
  // part is what makes it a release, and it must have the shape this build produces.
  // The renderer belongs to the ingestion Worker alone — the API bundle must stay
  // wasm-free — so a new module part is valid only on that address.
  if (!isDeepStrictEqual(before.files, after.files)
    && !(address === 'cloudflare_workers_script.ingestion' && isPermittedModuleParts(before.files, after.files))) return false;
  // Normalize Durable Object namespace IDs before evaluating binding changes.
  // The provider reports `namespace_id = (known after apply)` whenever it will
  // re-resolve a binding, and a permitted plain-text change alongside that would
  // otherwise read as an unpermitted identity change.
  let afterUnknown = change.after_unknown;
  let afterForComparison = after;
  let normalizedAfterBindings = after.bindings;
  if (isRecord(afterUnknown)) {
    const normalized = normalizeStableDurableObjectNamespaceIds(
      before.bindings,
      after.bindings,
      afterUnknown.bindings,
    );
    afterForComparison = { ...after, bindings: normalized.after };
    afterUnknown = { ...afterUnknown, bindings: normalized.unknown };
    normalizedAfterBindings = normalized.after;
  }
  const withoutOutboundAddition = withoutReviewedOutboundNotificationsAddition(before.bindings, normalizedAfterBindings);
  const bindingCandidates = withoutOutboundAddition === undefined
    ? [normalizedAfterBindings]
    : [normalizedAfterBindings, withoutOutboundAddition];
  const permittedBindingChanged = bindingCandidates.some((candidate) => (
    isPermittedBindingUpdate(before.bindings, candidate)
    || isPermittedBindingRetirement(before.bindings, candidate)
    || isResumeTunerEnablement(before.bindings, candidate)
    || ((address === 'cloudflare_workers_script.ingestion' || isolatedAddresses.has(address)) && isIngestionV2BindingUpdate(before.bindings, candidate))
    || (address === 'cloudflare_workers_script.ingestion' && isAdmissionV2WorkerBindingUpdate(before.bindings, candidate))
    || (address === 'cloudflare_workers_script.application' && isCatalogR2ReadToggle(before.bindings, candidate))
    || (withoutOutboundAddition !== undefined
      && Array.isArray(before.bindings)
      && Array.isArray(candidate)
      && bindingsMatchByName(before.bindings, candidate))
  ));
  // The ingestion Worker exhausted its 10,000-subrequest invocation budget
  // while finishing a bounded GitHub source slice. Permit only this reviewed
  // increase; all other Worker limits remain protected.
  const permittedSubrequestIncrease = address === 'cloudflare_workers_script.ingestion'
    && isDeepStrictEqual(before.limits, { cpu_ms: 120_000, subrequests: 10_000 })
    && isDeepStrictEqual(after.limits, { cpu_ms: 120_000, subrequests: 50_000 });
  const permittedInvocationLogShutdown = address === 'cloudflare_workers_script.application'
    && isApiInvocationLogShutdown(before.observability, after.observability);
  const permittedReleaseAnnotation = isReleaseAnnotationUpdate(address, after, expectedDeploySha);
  const permittedControllerMigration = address === 'cloudflare_workers_script.ingestion'
    && (before.migrations === null || before.migrations === undefined)
    && isRecord(after.migrations)
    && after.migrations.old_tag === ''
    && after.migrations.new_tag === 'v1-d1-traffic-controller'
    && isDeepStrictEqual(after.migrations.new_sqlite_classes, ['D1TrafficController'])
    && Object.entries(after.migrations).every(([key, value]) => (
      ['old_tag', 'new_tag', 'new_sqlite_classes'].includes(key) || value === null
    ));
  const permittedControllerMigrationTagTransition = address === 'cloudflare_workers_script.ingestion'
    && isControllerMigrationTagTransition(before.migrations, after.migrations);
  const permittedResumeMigrationTagTransition = address === 'cloudflare_workers_script.application'
    && isResumeMigrationTagTransition(before.migrations, after.migrations);
  const permittedResumeMigrationBootstrap = address === 'cloudflare_workers_script.application'
    && (before.migrations === null || before.migrations === undefined)
    && isExpectedResumeMigration(after.migrations, '');
  const permittedAppliedMigrationRetirement = isAppliedMigrationRetirement(address, before, after);
  if (!contentChanged && !permittedBindingChanged && !permittedSubrequestIncrease
    && !permittedInvocationLogShutdown
    && !permittedReleaseAnnotation
    && !permittedControllerMigration && !permittedControllerMigrationTagTransition
    && !permittedResumeMigrationTagTransition
    && !permittedResumeMigrationBootstrap && !permittedAppliedMigrationRetirement) return false;

  const beforeForComparison = {
    ...before,
    ...(permittedBindingChanged ? { bindings: normalizedAfterBindings } : {}),
    ...(permittedSubrequestIncrease ? { limits: after.limits } : {}),
    ...(permittedInvocationLogShutdown ? { observability: after.observability } : {}),
    ...(permittedReleaseAnnotation ? { annotations: after.annotations } : {}),
    ...(permittedControllerMigration ? { migrations: after.migrations } : {}),
    ...(permittedControllerMigrationTagTransition ? { migrations: after.migrations } : {}),
    ...(permittedResumeMigrationTagTransition ? { migrations: after.migrations } : {}),
    ...(permittedResumeMigrationBootstrap ? { migrations: after.migrations } : {}),
    ...(permittedAppliedMigrationRetirement ? { migrations: after.migrations } : {}),
  };
  if (permittedControllerMigration && isRecord(afterUnknown) && Array.isArray(afterUnknown.bindings)) {
    const controllerIndex = Array.isArray(after.bindings)
      ? after.bindings.findIndex((binding) => isRecord(binding) && binding.name === 'D1_TRAFFIC_CONTROLLER')
      : -1;
    const controllerUnknown = afterUnknown.bindings[controllerIndex];
    if (controllerIndex < 0 || !isDeepStrictEqual(controllerUnknown, { namespace_id: true })) return false;
    afterUnknown = {
      ...afterUnknown,
      bindings: afterUnknown.bindings.map((binding, index) => (index === controllerIndex ? {} : binding)),
    };
  }
  if (permittedReleaseAnnotation && isRecord(afterUnknown) && isRecord(afterUnknown.annotations)) {
    const annotationUnknowns = afterUnknown.annotations;
    if (!Object.entries(annotationUnknowns).every(([key, value]) => (
      key === 'workers_triggered_by' && value === true
    ))) return false;
    afterUnknown = { ...afterUnknown, annotations: {} };
  }
  if (!isDeepStrictEqual(
    protectedWorkerValue(beforeForComparison, afterUnknown),
    protectedWorkerValue(afterForComparison, afterUnknown),
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
    || change.after.migrations.new_tag !== 'v4-resume-pdf-compiler-v2'
    || !isDeepStrictEqual(change.after.migrations.new_sqlite_classes, ['ResumePdfCompilerV2'])
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

const customDomainAddresses = new Set(['cloudflare_workers_custom_domain.api[0]']);
const apiSubdomainAddress = 'cloudflare_workers_script_subdomain.application';

/**
 * Reviewed privacy change: the API Worker keeps its public `workers.dev` endpoint
 * (`enabled = true`) but stops serving preview URLs. Identity fields and the
 * workers.dev toggle must be untouched, and previews may only move from on to off.
 */
function isApiPreviewUrlShutdown(address: string, change: ResourceChange['change']): boolean {
  if (address !== apiSubdomainAddress || !isRecord(change.before) || !isRecord(change.after)) return false;
  const before = change.before;
  const after = change.after;
  const allowedKeys = new Set(['account_id', 'enabled', 'id', 'previews_enabled', 'script_name']);
  if (Object.keys(before).some((key) => !allowedKeys.has(key))
    || Object.keys(after).some((key) => !allowedKeys.has(key))) return false;
  if (!isDeepStrictEqual(before.account_id, after.account_id)
    || before.id !== 'intern-notifs' || after.id !== 'intern-notifs'
    || before.script_name !== 'intern-notifs' || after.script_name !== 'intern-notifs'
    || before.enabled !== true || after.enabled !== true) return false;
  return before.previews_enabled === true && after.previews_enabled === false;
}
const priorIngestionCrons = [
  '*/5 * * * *', '7-57/10 * * * *', '9-59/10 * * * *',
  '12,42 * * * *', '22,52 * * * *', '2,32 * * * *',
  '0 * * * *', '42 8 * * *', '17 9 * * *',
];
const currentIngestionCrons = priorIngestionCrons.map((cron) => cron === '42 8 * * *' ? '34 8 * * *' : cron);
const iconResolutionIngestionCrons = [
  ...currentIngestionCrons.slice(0, 3), '6-56/10 * * * *', ...currentIngestionCrons.slice(3),
];
const projectionIsolationIngestionCrons = [
  ...iconResolutionIngestionCrons.slice(0, 3), '1-51/10 * * * *', ...iconResolutionIngestionCrons.slice(3),
];
const splitProjectionIngestionCrons = [
  ...projectionIsolationIngestionCrons.slice(0, 4), '4-54/10 * * * *', ...projectionIsolationIngestionCrons.slice(4),
];
const reliableSplitProjectionIngestionCrons = splitProjectionIngestionCrons.map((cron) => (
  cron === '4-54/10 * * * *' ? '4,14,24,34,44,54 * * * *' : cron
));

function cronValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const crons: string[] = [];
  for (const schedule of value) {
    if (!isRecord(schedule) || typeof schedule.cron !== 'string') return undefined;
    if (Object.keys(schedule).some((key) => !['created_on', 'cron', 'modified_on'].includes(key))) return undefined;
    if (schedule.created_on !== undefined && typeof schedule.created_on !== 'string') return undefined;
    if (schedule.modified_on !== undefined && typeof schedule.modified_on !== 'string') return undefined;
    crons.push(schedule.cron);
  }
  return crons;
}

/**
 * Pin each reviewed cron migration as a complete before/after schedule so a
 * release cannot add, remove, or repurpose any other production trigger.
 */
function isReviewedIngestionCronUpdate(address: string, change: ResourceChange['change']): boolean {
  if (address !== 'cloudflare_workers_cron_trigger.ingestion'
    || !isRecord(change.before) || !isRecord(change.after)) return false;
  const before = change.before;
  const after = change.after;
  const stableKeys = ['account_id', 'id', 'script_name'] as const;
  if (Object.keys(before).some((key) => ![...stableKeys, 'schedules'].includes(key))
    || Object.keys(after).some((key) => ![...stableKeys, 'schedules'].includes(key))
    || stableKeys.some((key) => before[key] !== after[key])
    || before.id !== 'intern-notifs-ingestion'
    || before.script_name !== 'intern-notifs-ingestion'
    || typeof before.account_id !== 'string' || before.account_id.length === 0) return false;
  const beforeCrons = cronValues(before.schedules);
  const afterCrons = cronValues(after.schedules);
  const addsIconCron = isDeepStrictEqual(beforeCrons, currentIngestionCrons)
    && isDeepStrictEqual(afterCrons, iconResolutionIngestionCrons);
  const addsProjectionCron = isDeepStrictEqual(beforeCrons, iconResolutionIngestionCrons)
    && isDeepStrictEqual(afterCrons, projectionIsolationIngestionCrons);
  const addsR2ProjectionCron = isDeepStrictEqual(beforeCrons, projectionIsolationIngestionCrons)
    && isDeepStrictEqual(afterCrons, splitProjectionIngestionCrons);
  const repairsR2ProjectionCron = isDeepStrictEqual(beforeCrons, splitProjectionIngestionCrons)
    && isDeepStrictEqual(afterCrons, reliableSplitProjectionIngestionCrons);
  const reviewedTransition = (isDeepStrictEqual(beforeCrons, priorIngestionCrons)
      && isDeepStrictEqual(afterCrons, currentIngestionCrons))
    || addsIconCron || addsProjectionCron || addsR2ProjectionCron || repairsR2ProjectionCron;
  if (!reviewedTransition || !afterCrons) return false;
  const insertsElement = addsIconCron || addsProjectionCron || addsR2ProjectionCron;
  return isDeepStrictEqual(change.after_unknown, {
    // The provider models schedules as an ordered list. Inserting a cron shifts
    // every following value and associates the new element's unknown metadata
    // with the final list slot rather than with the inserted cron value.
    schedules: afterCrons.map((_, index) => insertsElement && index === afterCrons.length - 1
      ? { created_on: true, modified_on: true }
      : { modified_on: true }),
  });
}

/**
 * The API's custom domain is what lets the icon route use Cloudflare's Cache API —
 * caching does not populate on `workers.dev`. The create is pinned to this service
 * and hostname so a plan cannot attach an arbitrary zone or hostname, and it is
 * additive: an existing custom domain or any update/destroy is still refused.
 */
function isCustomDomainCreate(address: string, change: ResourceChange['change']): boolean {
  if (!customDomainAddresses.has(address) || change.before !== null || !isRecord(change.after)) return false;
  const after = change.after;
  return typeof after.account_id === 'string' && after.account_id.length > 0
    && after.service === 'intern-notifs'
    && after.hostname === 'api.ntern.app'
    && typeof after.zone_id === 'string' && after.zone_id.length > 0;
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

function isAdmissionV2InfrastructureCreate(address: string, change: ResourceChange['change']): boolean {
  if (!admissionV2InfrastructureCreates.has(address) || change.before !== null || !isRecord(change.after)) return false;
  const after = change.after;
  if (typeof after.account_id !== 'string' || after.account_id.length === 0) return false;

  if (address === 'cloudflare_queue.work["admission-v2"]') {
    return after.queue_name === 'intern-notifs-admission-v2'
      && isDeepStrictEqual(after.settings, { delivery_paused: false, message_retention_period: 86_400 });
  }
  if (address === 'cloudflare_queue.dead_letter["admission-v2"]') {
    return after.queue_name === 'intern-notifs-admission-v2-dlq'
      && isDeepStrictEqual(after.settings, { message_retention_period: 1_209_600 });
  }
  return after.script_name === 'intern-notifs-ingestion'
    && after.type === 'worker'
    && after.dead_letter_queue === 'intern-notifs-admission-v2-dlq'
    && isRecord(after.settings)
    && after.settings.batch_size === 1
    && after.settings.max_concurrency === 1
    && after.settings.max_retries === 2
    && after.settings.max_wait_time_ms === 5_000
    && Object.keys(after.settings).every((key) => ['batch_size', 'max_concurrency', 'max_retries', 'max_wait_time_ms'].includes(key));
}

function isIsolatedWorkerCreate(address: string, change: ResourceChange['change'], sha?: string): boolean {
  const role = isolatedAddresses.get(address);
  if (!role || change.before !== null || !isRecord(change.after)) return false;
  const a = change.after;
  if (a.script_name !== `intern-notifs-${role}` || a.main_module !== `${role === 'admission' ? 'admission' : 'catalog-publisher'}-worker.js`
    || a.compatibility_date !== '2026-09-08' || !isDeepStrictEqual(a.compatibility_flags, ['nodejs_compat'])
    || !isDeepStrictEqual(a.limits, { cpu_ms: 120000, subrequests: 50000 })
    || !isReleaseAnnotationUpdate(address, a, sha) || !Array.isArray(a.bindings)
    || typeof a.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(a.content_sha256)
    || (a.files !== undefined && a.files !== null && Object.keys(a.files as object).length !== 0)) return false;
  const expected: Record<string, Record<string, unknown>> = {
    DB: { type: 'd1', id: '4e389f1c-7c6d-48e1-aa97-dc4cb1769bb8' },
    DOCUMENTS: { type: 'r2_bucket', bucket_name: 'intern-notifs-documents' },
    VERSION_METADATA: { type: 'version_metadata' },
    DEPLOYMENT_ROLE: { type: 'plain_text', text: role },
    OUTBOUND_NOTIFICATIONS_ENABLED: { type: 'plain_text', text: 'false' },
    INGESTION_V2_ISOLATED_WORKERS_ENABLED: { type: 'plain_text', text: 'false' },
    ...(role === 'admission' ? {
      ADMISSION_V2_QUEUE: { type: 'queue', queue_name: 'intern-notifs-admission-v2' },
      ADMISSION_V2_QUEUE_NAME: { type: 'plain_text', text: 'intern-notifs-admission-v2' },
    } : { SHADOW_EXTRACTION_ARTIFACTS: { type: 'r2_bucket', bucket_name: 'intern-notifs-shadow-extraction' } }),
  };
  const names = new Set<string>();
  for (const binding of a.bindings) {
    if (!isRecord(binding) || typeof binding.name !== 'string' || names.has(binding.name)) return false;
    names.add(binding.name);
    const pinned = expected[binding.name];
    if (pinned) {
      if (!Object.entries(pinned).every(([key, value]) => isDeepStrictEqual(binding[key], value))) return false;
      if (!Object.entries(binding).every(([key, value]) => key === 'name' || key in pinned || value === null)) return false;
    } else if (role === 'admission' && binding.name === 'TRUSTED_COMMUNITY_CATALOG_ENABLED' && binding.type === 'plain_text' && ['true', 'false'].includes(String(binding.text))) {
      // Match the independently configured catalog policy.
    } else if (role === 'admission' && isIngestionV2ToggleBinding(binding)) {
      // Existing source and ownership flags are copied; isolation itself remains off.
    } else if (role === 'catalog-publisher' && binding.name === 'LLM_METADATA_PUBLICATION_POLICY_JSON' && binding.type === 'plain_text') {
      try { if (JSON.parse(String(binding.text)).enabled !== false) return false; } catch { return false; }
    } else return false;
  }
  return Object.keys(expected).every((name) => names.has(name));
}

function isIsolatedRoutingChange(address: string, change: ResourceChange['change']): boolean {
  if (!isRecord(change.after)) return false;
  const a = change.after;
  const b = isRecord(change.before) ? change.before : undefined;
  const subdomain = address.match(/^cloudflare_workers_script_subdomain\.isolated\["(admission|catalog-publisher)"\]$/u)?.[1];
  if (subdomain) return a.script_name === `intern-notifs-${subdomain}` && a.enabled === false && a.previews_enabled === false
    && (!b || isDeepStrictEqual({ ...b, enabled: false, previews_enabled: false }, a));
  const role = address.match(/^cloudflare_workers_cron_trigger\.isolated\["(admission|catalog-publisher)"\]$/u)?.[1];
  if (role) {
    if (a.script_name !== `intern-notifs-${role}` || !Array.isArray(a.schedules)) return false;
    const target = role === 'admission' ? [{ cron: '9-59/10 * * * *' }] : [{ cron: '1-51/10 * * * *' }, { cron: '4,14,24,34,44,54 * * * *' }];
    if (!isDeepStrictEqual(a.schedules, []) && !isDeepStrictEqual(a.schedules, target)) return false;
    if (!b) return isDeepStrictEqual(a.schedules, []);
    return isDeepStrictEqual({ ...b, schedules: a.schedules }, a);
  }
  if (['cloudflare_queue_consumer.ingestion["admission-v2"]', 'cloudflare_queue_consumer.admission'].includes(address) && b) {
    return ['intern-notifs-ingestion', 'intern-notifs-admission'].includes(String(b.script_name))
      && ['intern-notifs-ingestion', 'intern-notifs-admission'].includes(String(a.script_name))
      && isDeepStrictEqual({ ...b, script_name: a.script_name }, a);
  }
  if (address === 'cloudflare_workers_cron_trigger.ingestion' && b && Array.isArray(b.schedules) && Array.isArray(a.schedules)) {
    const projection = new Set(['1-51/10 * * * *', '4,14,24,34,44,54 * * * *']);
    const omit = (rows: unknown[]) => rows.filter((row) => !isRecord(row) || !projection.has(String(row.cron)));
    // Only the two reviewed projection crons may transfer in either direction.
    const valid = (rows: unknown[]) => rows.every((row) => isRecord(row) && Object.keys(row).length === 1 && typeof row.cron === 'string');
    return valid(b.schedules) && valid(a.schedules)
      && new Set(a.schedules.map((row) => String((row as Record<string, unknown>).cron))).size === a.schedules.length
      && isDeepStrictEqual(omit(b.schedules), omit(a.schedules)) && isDeepStrictEqual({ ...b, schedules: a.schedules }, a);
  }
  return false;
}

function isAdmissionAttachmentReplacement(address: string, change: ResourceChange['change']): boolean {
  if (address !== 'cloudflare_queue_consumer.admission' || !isDeepStrictEqual(change.actions, ['delete', 'create'])
    || !isRecord(change.before) || !isRecord(change.after)) return false;
  const b = change.before, a = change.after;
  const generated = new Set(['consumer_id', 'id', 'created_on']);
  const stable = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !generated.has(key) && key !== 'script_name'));
  return typeof b.queue_id === 'string' && b.queue_id.length > 0 && b.queue_id === a.queue_id
    && b.type === 'worker' && a.type === 'worker'
    && b.dead_letter_queue === 'intern-notifs-admission-v2-dlq'
    && ['intern-notifs-ingestion', 'intern-notifs-admission'].includes(String(b.script_name))
    && ['intern-notifs-ingestion', 'intern-notifs-admission'].includes(String(a.script_name))
    && isDeepStrictEqual(stable(b), stable(a))
    && (!isRecord(change.after_unknown) || Object.entries(change.after_unknown).every(([key, value]) => value === false || generated.has(key)));
}

function isAdmissionRouteState(address: string, change: ResourceChange['change']): boolean {
  if (address !== 'terraform_data.admission_queue_owner' || !isRecord(change.after)) return false;
  if (!['intern-notifs-ingestion', 'intern-notifs-admission'].includes(String(change.after.input))) return false;
  if (change.before === null) return change.actions[0] === 'create';
  if (!isRecord(change.before)) return false;
  const omit = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([key]) => !['id', 'input', 'output'].includes(key)));
  return ['intern-notifs-ingestion', 'intern-notifs-admission'].includes(String(change.before.input)) && isDeepStrictEqual(omit(change.before), omit(change.after));
}

export function actionableChanges(plan: Plan): Array<{ address: string; actions: string[] }> {
  return (plan.resource_changes ?? [])
    .filter(({ change }) => !change.actions.every((action) => action === 'no-op' || action === 'read'))
    .map(({ address, change }) => ({ address, actions: change.actions }));
}

export function validateCloudflarePlan(plan: Plan, options: PlanValidationOptions = {}): Array<{ address: string; actions: string[] }> {
  const resourceChanges = (plan.resource_changes ?? []).filter(({ change }) => (
    !change.actions.every((action) => action === 'no-op' || action === 'read')
  ));
  const unsafe = resourceChanges.filter(({ address, change }) => (
    !isAdmissionAttachmentReplacement(address, change) && (change.actions.length !== 1
    || !(
      (change.actions[0] === 'update'
        && ((allowedUpdates.has(address)
          && (isSafeWorkerUpdate(address, change, options.expectedDeploySha) || isResumeWorkerUpdate(address, change)))
          || isReviewedIngestionCronUpdate(address, change)
          || isIsolatedRoutingChange(address, change)
          || isApiPreviewUrlShutdown(address, change)
          || isAdmissionRouteState(address, change)))
      || (change.actions[0] === 'create' && (isResumeInfrastructureCreate(address, change)
        || isAdmissionV2InfrastructureCreate(address, change)
        || isIsolatedWorkerCreate(address, change, options.expectedDeploySha)
        || isIsolatedRoutingChange(address, change)
        || isCustomDomainCreate(address, change)
        || isAdmissionRouteState(address, change)))
    ))
  )).map(({ address, change }) => ({ address, actions: change.actions }));

  if (unsafe.length > 0) {
    throw new Error(`Refusing unsafe Cloudflare plan: ${JSON.stringify(unsafe)}`);
  }

  return actionableChanges(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Plan;
  const changes = validateCloudflarePlan(plan, { expectedDeploySha: process.env.DEPLOY_SHA });
  console.log(`Safe plan: ${changes.length} reviewed infrastructure change(s).`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\n`);
  }
}
