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

function tofu(args: string[], options: { allowExitCodes?: number[] } = {}): { status: number; stdout: string } {
  const result = spawnSync('tofu', [`-chdir=${tofuDir}`, ...args], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (!(options.allowExitCodes ?? [0]).includes(status)) throw new Error(`tofu ${args[0]} failed with exit code ${status}`);
  return { status, stdout: result.stdout ?? '' };
}

tofu(['init', '-reconfigure', '-input=false']);
const planPath = join(tmpdir(), `cloudflare-${process.pid}.tfplan`);
try {
  tofu(['plan', '-input=false', '-lock-timeout=5m', `-out=${planPath}`]);
  const plan = JSON.parse(tofu(['show', '-json', planPath]).stdout) as Plan;
  // Throws on a plan that touches anything outside the Worker bundles and the
  // bindings the release is permitted to reconcile.
  const changes = validateCloudflarePlan(plan);
  console.log(`Safe plan: ${changes.length} Worker script update(s).`);
  if (planOnly || !changes.length) {
    console.log(planOnly ? 'Plan only: nothing applied.' : 'Nothing to apply: production already matches this working tree.');
    process.exit(0);
  }
  tofu(['apply', '-input=false', '-auto-approve', planPath]);
  const converged = tofu(['plan', '-input=false', '-lock-timeout=5m', '-detailed-exitcode'], { allowExitCodes: [0, 2] });
  if (converged.status !== 0) throw new Error('Production still differs from this working tree after apply; inspect the plan above.');
  console.log('Deployed and converged.');
} finally {
  rmSync(planPath, { force: true });
}
