import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { withBillingDeployment, type CloudflareManagementApi } from '../src/cloudflare-budget.js';
import { cloudflareManagementApi } from './cloudflare-budget-guard.js';
import { deploymentCommand } from './cloudflare-deploy-guard.js';

export async function deployCloudflareDev(api: CloudflareManagementApi,
  run = deploymentCommand): Promise<void> {
  await withBillingDeployment(api, 'dev', async () => {
    for (const [command, ...args] of [
      ['tsx', 'scripts/verify-cloudflare-dev-profile.ts', '--preflight'],
      ['npm', 'run', 'cloudflare:dev:provision'],
      ['wrangler', 'deploy', '--config', 'wrangler.dev.ingestion.jsonc'],
      ['tsx', 'scripts/verify-cloudflare-dev-profile.ts', '--release-legacy-consumer'],
      ['wrangler', 'deploy', '--config', 'wrangler.dev.admission.jsonc'],
      ['wrangler', 'deploy', '--config', 'wrangler.dev.catalog-publisher.jsonc'],
      ['wrangler', 'deploy', '--config', 'wrangler.dev.api.jsonc', '--containers-rollout=none'],
      ['tsx', 'scripts/verify-cloudflare-dev-profile.ts'],
    ]) {
      await withBillingDeployment(api, 'dev', () => run(command!, args));
    }
  });
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
  await deployCloudflareDev(cloudflareManagementApi(account, token));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
