import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCloudflarePlan, type Plan } from './cloudflare-plan-guard.js';

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
const planOnly = process.argv.includes('--plan-only');

function currentDeploySha(): string {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (git.error) throw git.error;
  const sha = process.env.DEPLOY_SHA ?? git.stdout.trim();
  if (git.status !== 0 || !/^[0-9a-f]{40}$/u.test(sha)) throw new Error('Could not resolve a full Git commit SHA for the release');
  if (process.env.TF_VAR_deploy_sha && process.env.TF_VAR_deploy_sha !== sha) {
    throw new Error('TF_VAR_deploy_sha must match DEPLOY_SHA (or the current Git HEAD)');
  }
  process.env.TF_VAR_deploy_sha = sha;
  return sha;
}

const deploySha = currentDeploySha();

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

function activeVersionId(scriptName: string, config: string): string {
  const deployment = JSON.parse(wrangler([
    'deployments', 'status', '--name', scriptName, '--config', config, '--json',
  ])) as unknown;
  if (!isRecord(deployment) || !Array.isArray(deployment.versions) || deployment.versions.length !== 1) {
    throw new Error(`${scriptName} must have exactly one active version before restoring its secret`);
  }
  const version = deployment.versions[0];
  if (!isRecord(version) || typeof version.version_id !== 'string' || version.percentage !== 100) {
    throw new Error(`${scriptName} must have one active version at 100% before restoring its secret`);
  }
  return version.version_id;
}

function latestVersion(scriptName: string, config: string): Record<string, unknown> {
  const versions = JSON.parse(wrangler([
    'versions', 'list', '--name', scriptName, '--config', config, '--json',
  ])) as unknown;
  if (!Array.isArray(versions) || versions.length === 0 || versions.some((version) => !isRecord(version))) {
    throw new Error(`${scriptName} reports no Worker versions`);
  }
  return (versions as Array<Record<string, unknown>>).reduce((latest, version) => (
    String(version.created_on) > String(latest.created_on) ? version : latest
  ));
}

function restoreOperationsSecret(scriptName: string, config: string, secret: string) {
  const expectedVersion = activeVersionId(scriptName, config);
  if (latestVersion(scriptName, config).id !== expectedVersion) {
    throw new Error(`${scriptName} has an unreviewed version newer than its active release`);
  }
  wrangler([
    'versions', 'secret', 'put', 'OPERATIONS_SHARED_SECRET',
    '--name', scriptName, '--config', config,
    '--tag', deploySha, '--message', `Release ${deploySha}`,
  ], secret);
  const secretVersion = latestVersion(scriptName, config);
  const annotations = isRecord(secretVersion.annotations) ? secretVersion.annotations : {};
  if (typeof secretVersion.id !== 'string' || secretVersion.id === expectedVersion
    || annotations['workers/tag'] !== deploySha
    || annotations['workers/message'] !== `Release ${deploySha}`) {
    throw new Error(`${scriptName} secret version is not bound to release ${deploySha}`);
  }
  wrangler([
    'versions', 'deploy', `${secretVersion.id}@100%`,
    '--name', scriptName, '--config', config, '--yes',
    '--message', `Restore operations binding for ${deploySha}`,
  ]);
}

function restoreOperationsSecrets() {
  const secret = process.env.OPERATIONS_SHARED_SECRET;
  if (!secret) throw new Error('OPERATIONS_SHARED_SECRET is required to restore protected production operations after deployment');
  restoreOperationsSecret('intern-notifs-ingestion', 'wrangler.ingestion.jsonc', secret);
  restoreOperationsSecret('intern-notifs', 'wrangler.api.jsonc', secret);
}

tofu(['init', '-reconfigure', '-input=false']);
const planPath = join(tmpdir(), `cloudflare-${process.pid}.tfplan`);
try {
  tofu(['plan', '-input=false', '-lock-timeout=5m', `-out=${planPath}`]);
  const plan = JSON.parse(tofu(['show', '-json', planPath]).stdout) as Plan;
  // Throws on a plan that touches anything outside the Worker bundles and the
  // bindings the release is permitted to reconcile.
  const changes = validateCloudflarePlan(plan, { expectedDeploySha: deploySha });
  console.log(`Safe plan: ${changes.length} reviewed infrastructure change(s).`);
  if (planOnly || !changes.length) {
    console.log(planOnly ? 'Plan only: nothing applied.' : 'Nothing to apply: production already matches this working tree.');
    process.exit(0);
  }
  tofu(['apply', '-input=false', '-auto-approve', planPath]);
  restoreOperationsSecrets();
  const converged = tofu(['plan', '-input=false', '-lock-timeout=5m', '-detailed-exitcode'], { allowExitCodes: [0, 2] });
  if (converged.status !== 0) throw new Error('Production still differs from this working tree after apply; inspect the plan above.');
  console.log('Deployed and converged.');
} finally {
  rmSync(planPath, { force: true });
}
