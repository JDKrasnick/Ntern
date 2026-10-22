import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { preserveBillingShutdown, withBillingDeployment } from '../src/cloudflare-budget.js';
import { cloudflareManagementApi } from './cloudflare-budget-guard.js';

/** Wait for the command to exit before compensating, including cancellation.
 * A process group includes shell grandchildren that could otherwise restore
 * resources after the guard has finished cleaning them up.
 */
export async function deploymentCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', detached: true });
    let cancelled = false;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try { process.kill(-child.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    };
    const cancel = () => {
      cancelled = true;
      // Stop the whole group before cleanup; a shell may exit on SIGTERM while
      // a grandchild keeps deploying. These are only this guard's children.
      signalGroup('SIGKILL');
    };
    process.on('SIGTERM', cancel);
    process.on('SIGINT', cancel);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.off('SIGTERM', cancel);
      process.off('SIGINT', cancel);
      if (cancelled || code !== 0) reject(new Error(`Deployment command failed: ${command} (${signal ?? code})`));
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const [environment, separator, ...command] = process.argv.slice(2);
  if ((environment !== 'production' && environment !== 'dev')
    || (separator !== '--' && separator !== '--reconcile') || (separator === '--' && !command.length)) {
    throw new Error('Usage: cloudflare-deploy-guard.ts <production|dev> <-- command...|--reconcile>');
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.TF_VAR_cloudflare_account_id;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('Cloudflare account and API token are required');
  const api = cloudflareManagementApi(account, token);
  if (separator === '--reconcile') await preserveBillingShutdown(api, environment);
  else await withBillingDeployment(api, environment, () => deploymentCommand(command[0]!, command.slice(1)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
