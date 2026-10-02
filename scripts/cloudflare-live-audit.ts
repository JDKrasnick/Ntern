import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/**
 * Post-deploy convergence audit. The pre-apply saved plan proves the release
 * *intends* only reviewed changes; this audit proves what Cloudflare is actually
 * serving matches that reviewed configuration after every Worker mutation
 * (OpenTofu apply, container rollout, and secret restoration).
 *
 * Inputs are the post-apply OpenTofu plan (`tofu show -json`), the active
 * deployment for each Worker (`wrangler deployments status --json`), and the
 * active version (`wrangler versions view <id> --json`). We compare every
 * non-secret binding, the compatibility settings, handlers, and limits. Extra
 * `secret_text` bindings are allowed because secrets are written out-of-band and
 * are the one binding kind OpenTofu deliberately keeps rather than owns.
 */

type Json = Record<string, unknown>;

export type LiveDeployment = Json & {
  versions?: unknown;
};

export type LiveVersion = Json & {
  resources?: unknown;
};

export type PlannedResource = {
  address?: unknown;
  values?: unknown;
};

type PlannedModule = {
  resources?: unknown;
  child_modules?: unknown;
};

export type Plan = {
  planned_values?: { root_module?: PlannedModule } | unknown;
};

export type WorkerAuditInput = {
  scriptName: string;
  address: string;
  deployment: LiveDeployment;
  version: LiveVersion;
};

export type WorkerAuditResult = {
  scriptName: string;
  versionId: string;
  bindingCount: number;
};

export type AuditResult = {
  workers: WorkerAuditResult[];
};

const apiAddress = 'cloudflare_workers_script.application';
const ingestionAddress = 'cloudflare_workers_script.ingestion';

const secretBindingType = 'secret_text';

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  return JSON.stringify(value);
}

function collectPlannedResources(plan: Plan): Map<string, Json> {
  const resources = new Map<string, Json>();
  const root = plan.planned_values;
  if (!isRecord(root)) return resources;
  const visit = (module: unknown): void => {
    if (!isRecord(module)) return;
    if (Array.isArray(module.resources)) {
      for (const resource of module.resources) {
        if (isRecord(resource) && typeof resource.address === 'string' && isRecord(resource.values)) {
          resources.set(resource.address, resource.values);
        }
      }
    }
    if (Array.isArray(module.child_modules)) module.child_modules.forEach(visit);
  };
  visit(root.root_module);
  return resources;
}

export function plannedWorkerValues(plan: Plan, address: string): Json {
  const resources = collectPlannedResources(plan);
  const values = resources.get(address);
  if (!values) throw new Error(`Final OpenTofu plan is missing ${address}`);
  return values;
}

export function activeVersionId(scriptName: string, deployment: LiveDeployment): string {
  const versions = deployment.versions;
  if (!Array.isArray(versions) || versions.length !== 1) {
    throw new Error(`${scriptName} must serve exactly one active version, found ${describe(versions)}`);
  }
  const version = versions[0];
  if (!isRecord(version) || typeof version.version_id !== 'string' || version.version_id.length === 0) {
    throw new Error(`${scriptName} active version is missing a version id: ${describe(version)}`);
  }
  if (version.percentage !== 100) {
    throw new Error(`${scriptName} must serve its active version at 100%, found ${describe(version.percentage)}`);
  }
  return version.version_id;
}

type NormalizedBinding = {
  type: string;
  target: Json;
};

function normalizeBindingTarget(binding: Json): Json | undefined {
  const type = binding.type;
  switch (type) {
    case 'plain_text':
      return { text: binding.text };
    case 'd1':
      // Wrangler/OpenTofu call this `id`; the Worker Versions API calls it `database_id`.
      return { database_id: binding.database_id ?? binding.id };
    case 'r2_bucket':
      return { bucket_name: binding.bucket_name };
    case 'queue':
      return { queue_name: binding.queue_name };
    case 'service':
      return { service: binding.service };
    case 'durable_object_namespace':
      return { class_name: binding.class_name, script_name: binding.script_name ?? null };
    case 'vectorize':
      return { index_name: binding.index_name };
    case 'ai':
    case 'browser':
    case 'version_metadata':
      return {};
    default:
      return undefined;
  }
}

function normalizeBindings(scriptName: string, bindings: unknown, source: string): Map<string, NormalizedBinding> {
  if (!Array.isArray(bindings)) throw new Error(`${scriptName} ${source} has no binding list: ${describe(bindings)}`);
  const normalized = new Map<string, NormalizedBinding>();
  for (const binding of bindings) {
    if (!isRecord(binding) || typeof binding.name !== 'string' || typeof binding.type !== 'string') {
      throw new Error(`${scriptName} ${source} has a malformed binding: ${describe(binding)}`);
    }
    if (binding.type === secretBindingType) continue;
    if (normalized.has(binding.name)) {
      throw new Error(`${scriptName} ${source} repeats the non-secret binding ${binding.name}`);
    }
    const target = normalizeBindingTarget(binding);
    if (target === undefined) {
      throw new Error(`${scriptName} ${source} has an unrecognized binding type ${binding.type} for ${binding.name}`);
    }
    normalized.set(binding.name, { type: binding.type, target });
  }
  return normalized;
}

/** Plan targets may omit a provider-assigned sub-value (for example a local
 * Durable Object's `script_name`); only values the plan states are required. */
function targetMatches(planned: Json, live: Json): boolean {
  return Object.entries(planned).every(([key, value]) => (
    value === null || value === undefined || isDeepStrictEqual(value, live[key])
  ));
}

function bindingSetsMatch(scriptName: string, planned: Json, live: Json): number {
  const planBindings = normalizeBindings(scriptName, planned.bindings, 'planned bindings');
  const liveBindings = normalizeBindings(scriptName, live.resources && isRecord(live.resources)
    ? (live.resources as Json).bindings
    : undefined, 'live bindings');

  for (const [name, planBinding] of planBindings) {
    const liveBinding = liveBindings.get(name);
    if (!liveBinding) throw new Error(`${scriptName} live version is missing the non-secret binding ${name}`);
    if (planBinding.type !== liveBinding.type) {
      throw new Error(`${scriptName} binding ${name} is ${liveBinding.type} live but ${planBinding.type} in the plan`);
    }
    if (!targetMatches(planBinding.target, liveBinding.target)) {
      throw new Error(`${scriptName} binding ${name} target drifted: plan ${describe(planBinding.target)} live ${describe(liveBinding.target)}`);
    }
  }
  for (const name of liveBindings.keys()) {
    if (!planBindings.has(name)) {
      throw new Error(`${scriptName} live version has an unreviewed non-secret binding ${name}`);
    }
  }
  return planBindings.size;
}

function asStringArray(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return [...value].sort();
}

function normalizeCompatibilityDate(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10);
  return undefined;
}

function requireEqual(scriptName: string, label: string, planned: unknown, live: unknown): void {
  if (!isDeepStrictEqual(planned, live)) {
    throw new Error(`${scriptName} ${label} drifted: plan ${describe(planned)} live ${describe(live)}`);
  }
}

function auditRuntime(scriptName: string, planned: Json, live: Json): void {
  const resources = isRecord(live.resources) ? live.resources : {};
  const script = isRecord(resources.script) ? resources.script : {};
  const runtime = isRecord(resources.script_runtime) ? resources.script_runtime : {};

  const plannedDate = normalizeCompatibilityDate(planned.compatibility_date);
  const liveDate = normalizeCompatibilityDate(runtime.compatibility_date);
  if (plannedDate === undefined || liveDate === undefined || plannedDate !== liveDate) {
    throw new Error(`${scriptName} compatibility date drifted: plan ${describe(planned.compatibility_date)} live ${describe(runtime.compatibility_date)}`);
  }

  requireEqual(scriptName, 'compatibility flags', asStringArray(planned.compatibility_flags) ?? [], asStringArray(runtime.compatibility_flags) ?? []);
  requireEqual(scriptName, 'handlers', asStringArray(planned.handlers) ?? [], asStringArray(script.handlers) ?? []);

  if (!isRecord(runtime.limits)) throw new Error(`${scriptName} live version reports no limits: ${describe(runtime.limits)}`);
  const runtimeLimits = runtime.limits;
  const plannedLimits = isRecord(planned.limits) ? planned.limits : {};
  // The Worker Versions API exposes `cpu_ms` but not `subrequests`, so only the
  // limits it reports can be checked live; the plan still owns the rest.
  for (const [key, value] of Object.entries(runtimeLimits)) {
    if (!(key in plannedLimits) || !isDeepStrictEqual(value, plannedLimits[key])) {
      throw new Error(`${scriptName} limit ${key} drifted: plan ${describe(plannedLimits[key])} live ${describe(value)}`);
    }
  }
}

export function auditWorkerParity(input: WorkerAuditInput, plan: Plan): WorkerAuditResult {
  const { scriptName, address, deployment, version } = input;
  const versionId = activeVersionId(scriptName, deployment);
  if (isRecord(version) && typeof version.id === 'string' && version.id !== versionId) {
    throw new Error(`${scriptName} active version ${versionId} does not match the version read from Wrangler (${version.id})`);
  }
  const planned = plannedWorkerValues(plan, address);
  const bindingCount = bindingSetsMatch(scriptName, planned, version);
  auditRuntime(scriptName, planned, version);
  return { scriptName, versionId, bindingCount };
}

export function auditLiveVersions(plan: Plan, input: { api: WorkerAuditInput; ingestion: WorkerAuditInput }): AuditResult {
  return {
    workers: [
      auditWorkerParity({ ...input.api, address: apiAddress }, plan),
      auditWorkerParity({ ...input.ingestion, address: ingestionAddress }, plan),
    ],
  };
}

export function auditSummaryLines(result: AuditResult, driftExitCode: number): string[] {
  const lines = ['### Final convergence gate', ''];
  for (const worker of result.workers) {
    lines.push(`- ${worker.scriptName}: active version \`${worker.versionId}\` at 100%; ${worker.bindingCount} non-secret binding(s) match the plan.`);
  }
  lines.push('', driftExitCode === 0
    ? '- Final OpenTofu plan: no drift (exit code 0).'
    : `- Final OpenTofu plan: drift detected (exit code ${driftExitCode}).`);
  lines.push('');
  return lines;
}

type CliOptions = {
  plan: string;
  apiName: string;
  apiDeployment: string;
  apiVersion: string;
  ingestionName: string;
  ingestionDeployment: string;
  ingestionVersion: string;
};

function readOption(argv: string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing required --${name}`);
  return value;
}

function parseCli(argv: string[]): CliOptions {
  return {
    plan: readOption(argv, 'plan'),
    apiName: readOption(argv, 'api-name'),
    apiDeployment: readOption(argv, 'api-deployment'),
    apiVersion: readOption(argv, 'api-version'),
    ingestionName: readOption(argv, 'ingestion-name'),
    ingestionDeployment: readOption(argv, 'ingestion-deployment'),
    ingestionVersion: readOption(argv, 'ingestion-version'),
  };
}

function readJson(path: string): Json {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCli(process.argv.slice(2));
  const driftIndex = process.argv.indexOf('--drift-exit-code');
  const driftExitCode = driftIndex >= 0 ? Number(process.argv[driftIndex + 1]) : 0;
  const result = auditLiveVersions(readJson(options.plan) as Plan, {
    api: {
      scriptName: options.apiName,
      address: apiAddress,
      deployment: readJson(options.apiDeployment) as LiveDeployment,
      version: readJson(options.apiVersion) as LiveVersion,
    },
    ingestion: {
      scriptName: options.ingestionName,
      address: ingestionAddress,
      deployment: readJson(options.ingestionDeployment) as LiveDeployment,
      version: readJson(options.ingestionVersion) as LiveVersion,
    },
  });
  const summary = auditSummaryLines(result, driftExitCode);
  process.stdout.write(summary.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
}
