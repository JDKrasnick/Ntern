import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activeVersionId,
  auditLiveVersions,
  auditSummaryLines,
  type LiveDeployment,
  type LiveVersion,
  type Plan as AuditPlan,
} from './cloudflare-live-audit.js';
import { validateCloudflarePlan, type Plan as GuardPlan } from './cloudflare-plan-guard.js';

/**
 * Local production deploy: build, plan, guard, apply the exact plan, then require
 * convergence. The release workflow does the same steps, but the guard is what
 * catches a plan that would change production configuration the release is not
 * allowed to touch — a hand-run `tofu apply` skips it, which is how a stale local
 * `.env` once wrote the wrong catalog gate into production.
 *
 * Source the deployment environment first (`set -a && . ./.env && set +a`) so the
 * plan carries the configuration that file intends; `--plan-only` stops after the
 * guard report.
 */

const tofuDir = 'infra/cloudflare';
const fullSha = /^[0-9a-f]{40}$/u;

type Worker = {
  scriptName: string;
  config: string;
};

type ExpectedWorkerIdentity = Worker & {
  versionId: string;
  etag: string;
};

const workers = {
  api: { scriptName: 'intern-notifs', config: 'wrangler.api.jsonc' },
  ingestion: { scriptName: 'intern-notifs-ingestion', config: 'wrangler.ingestion.jsonc' },
} satisfies Record<string, Worker>;

export function resolveDeploySha(headSha: string, deploySha?: string, terraformDeploySha?: string): string {
  if (!fullSha.test(headSha)) throw new Error('Could not resolve a full Git commit SHA for the release');
  if (deploySha !== undefined && (!fullSha.test(deploySha) || deploySha !== headSha)) {
    throw new Error('DEPLOY_SHA must match the current Git HEAD');
  }
  if (terraformDeploySha !== undefined && (!fullSha.test(terraformDeploySha) || terraformDeploySha !== headSha)) {
    throw new Error('TF_VAR_deploy_sha must match the current Git HEAD');
  }
  return headSha;
}

function currentDeploySha(): string {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (git.error) throw git.error;
  if (git.status !== 0) throw new Error('Could not resolve a full Git commit SHA for the release');
  const sha = resolveDeploySha(git.stdout.trim(), process.env.DEPLOY_SHA, process.env.TF_VAR_deploy_sha);
  process.env.DEPLOY_SHA = sha;
  process.env.TF_VAR_deploy_sha = sha;
  return sha;
}

function tofu(args: string[], options: { allowExitCodes?: number[] } = {}): { status: number; stdout: string } {
  const result = spawnSync('tofu', [`-chdir=${tofuDir}`, ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (!(options.allowExitCodes ?? [0]).includes(status)) throw new Error(`tofu ${args[0]} failed with exit code ${status}`);
  return { status, stdout: result.stdout ?? '' };
}

function wrangler(args: string[], input?: string): string {
  const result = spawnSync('npx', ['wrangler', ...args], {
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed`);
  return result.stdout ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wranglerJson(args: string[]): Record<string, unknown> {
  const value = JSON.parse(wrangler(args)) as unknown;
  if (!isRecord(value)) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} did not return a JSON object`);
  return value;
}

function deployment(worker: Worker): LiveDeployment {
  return wranglerJson([
    'deployments', 'status', '--name', worker.scriptName, '--config', worker.config, '--json',
  ]);
}

function version(worker: Worker, versionId: string): LiveVersion {
  return wranglerJson([
    'versions', 'view', versionId, '--name', worker.scriptName, '--config', worker.config, '--json',
  ]);
}

function latestVersion(worker: Worker): Record<string, unknown> {
  const versions = JSON.parse(wrangler([
    'versions', 'list', '--name', worker.scriptName, '--config', worker.config, '--json',
  ])) as unknown;
  if (!Array.isArray(versions) || versions.length === 0 || versions.some((candidate) => !isRecord(candidate))) {
    throw new Error(`${worker.scriptName} reports no Worker versions`);
  }
  return (versions as Array<Record<string, unknown>>).reduce((latest, candidate) => (
    String(candidate.created_on) > String(latest.created_on) ? candidate : latest
  ));
}

export function validateExpectedWorkerIdentity(
  worker: Worker,
  deploySha: string,
  liveDeployment: LiveDeployment,
  liveVersion: LiveVersion,
  latest: Record<string, unknown>,
): ExpectedWorkerIdentity {
  const versionId = activeVersionId(worker.scriptName, liveDeployment);
  if (liveVersion.id !== versionId) {
    throw new Error(`${worker.scriptName} active version ${versionId} does not match the version read from Wrangler`);
  }
  const annotations = isRecord(liveVersion.annotations) ? liveVersion.annotations : {};
  if (annotations['workers/tag'] !== deploySha) {
    throw new Error(`${worker.scriptName} active version is not tagged for release ${deploySha}`);
  }
  const resources = isRecord(liveVersion.resources) ? liveVersion.resources : {};
  const script = isRecord(resources.script) ? resources.script : {};
  if (typeof script.etag !== 'string' || script.etag.length === 0) {
    throw new Error(`${worker.scriptName} active version is missing its script etag`);
  }
  if (latest.id !== versionId) {
    throw new Error(`${worker.scriptName} has an unreviewed version newer than its active release`);
  }
  return { ...worker, versionId, etag: script.etag };
}

function captureExpectedWorkerIdentity(worker: Worker, deploySha: string): ExpectedWorkerIdentity {
  const liveDeployment = deployment(worker);
  const versionId = activeVersionId(worker.scriptName, liveDeployment);
  return validateExpectedWorkerIdentity(
    worker,
    deploySha,
    liveDeployment,
    version(worker, versionId),
    latestVersion(worker),
  );
}

function restoreOperationsSecret(expected: ExpectedWorkerIdentity, secret: string, deploySha: string): void {
  const currentActiveVersion = activeVersionId(expected.scriptName, deployment(expected));
  if (currentActiveVersion !== expected.versionId || latestVersion(expected).id !== expected.versionId) {
    throw new Error(`${expected.scriptName} changed after its release identity was captured`);
  }
  wrangler([
    'versions', 'secret', 'put', 'OPERATIONS_SHARED_SECRET',
    '--name', expected.scriptName, '--config', expected.config,
    '--tag', deploySha, '--message', `Release ${deploySha}`,
  ], secret);
  const secretVersion = latestVersion(expected);
  const annotations = isRecord(secretVersion.annotations) ? secretVersion.annotations : {};
  if (typeof secretVersion.id !== 'string' || secretVersion.id === expected.versionId
    || annotations['workers/tag'] !== deploySha
    || annotations['workers/message'] !== `Release ${deploySha}`) {
    throw new Error(`${expected.scriptName} secret version is not bound to release ${deploySha}`);
  }
  wrangler([
    'versions', 'deploy', `${secretVersion.id}@100%`,
    '--name', expected.scriptName, '--config', expected.config, '--yes',
    '--message', `Restore operations binding for ${deploySha}`,
  ]);
}

function restoreOperationsSecrets(
  expected: { api: ExpectedWorkerIdentity; ingestion: ExpectedWorkerIdentity },
  deploySha: string,
): void {
  const secret = process.env.OPERATIONS_SHARED_SECRET;
  if (!secret) throw new Error('OPERATIONS_SHARED_SECRET is required to restore protected production operations after deployment');
  restoreOperationsSecret(expected.ingestion, secret, deploySha);
  restoreOperationsSecret(expected.api, secret, deploySha);
}

function auditFinalState(
  plan: AuditPlan,
  expected: { api: ExpectedWorkerIdentity; ingestion: ExpectedWorkerIdentity },
  driftExitCode: number,
  isolated: Array<ExpectedWorkerIdentity & { address: string }> = [],
): void {
  const apiDeployment = deployment(expected.api);
  const ingestionDeployment = deployment(expected.ingestion);
  const result = auditLiveVersions(plan, {
    isolated: isolated.map((worker) => { const live = deployment(worker); return { scriptName: worker.scriptName, address: worker.address, expectedEtag: worker.etag, deployment: live, version: version(worker, activeVersionId(worker.scriptName, live)) }; }),
    api: {
      scriptName: expected.api.scriptName,
      address: 'cloudflare_workers_script.application',
      expectedEtag: expected.api.etag,
      deployment: apiDeployment,
      version: version(expected.api, activeVersionId(expected.api.scriptName, apiDeployment)),
    },
    ingestion: {
      scriptName: expected.ingestion.scriptName,
      address: 'cloudflare_workers_script.ingestion',
      expectedEtag: expected.ingestion.etag,
      deployment: ingestionDeployment,
      version: version(expected.ingestion, activeVersionId(expected.ingestion.scriptName, ingestionDeployment)),
    },
  });
  process.stdout.write(`${auditSummaryLines(result, driftExitCode).join('\n')}\n`);
  if (driftExitCode !== 0) throw new Error('Production still differs from this working tree after apply; inspect the final plan.');
}

function main(): void {
  const planOnly = process.argv.includes('--plan-only');
  const deploySha = currentDeploySha();
  tofu(['init', '-reconfigure', '-input=false']);
  const planPath = join(tmpdir(), `cloudflare-${process.pid}.tfplan`);
  const finalPlanPath = join(tmpdir(), `cloudflare-${process.pid}-final.tfplan`);
  try {
    tofu(['plan', '-input=false', '-lock-timeout=5m', `-out=${planPath}`]);
    const plan = JSON.parse(tofu(['show', '-json', planPath]).stdout) as GuardPlan;
    const changes = validateCloudflarePlan(plan, { expectedDeploySha: deploySha });
    console.log(`Safe plan: ${changes.length} reviewed infrastructure change(s).`);
    if (planOnly) {
      console.log('Plan only: nothing applied.');
      return;
    }
    if (changes.length) tofu(['apply', '-input=false', '-auto-approve', planPath]);
    const expected = {
      api: captureExpectedWorkerIdentity(workers.api, deploySha),
      ingestion: captureExpectedWorkerIdentity(workers.ingestion, deploySha),
    };
    const isolated = ['admission', 'catalog-publisher'].map((role) => ({
      ...captureExpectedWorkerIdentity({ scriptName: `intern-notifs-${role}`, config: `wrangler.${role}.jsonc` }, deploySha),
      address: `cloudflare_workers_script.isolated["${role}"]`,
    }));
    if (changes.length) restoreOperationsSecrets(expected, deploySha);
    const converged = tofu([
      'plan', '-input=false', '-lock-timeout=5m', '-detailed-exitcode', `-out=${finalPlanPath}`,
    ], { allowExitCodes: [0, 2] });
    const finalPlan = JSON.parse(tofu(['show', '-json', finalPlanPath]).stdout) as AuditPlan;
    auditFinalState(finalPlan, expected, converged.status, isolated);
    console.log(changes.length ? 'Deployed and converged.' : 'Production already matches this working tree and passed the live audit.');
  } finally {
    rmSync(planPath, { force: true });
    rmSync(finalPlanPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
