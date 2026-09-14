import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Plan = {
  resource_changes?: Array<{ address: string; change: { actions: string[] } }>;
};

const allowedUpdates = new Set([
  'cloudflare_workers_script.application',
  'cloudflare_workers_script.ingestion',
]);

export function actionableChanges(plan: Plan): Array<{ address: string; actions: string[] }> {
  return (plan.resource_changes ?? [])
    .filter(({ change }) => !change.actions.every((action) => action === 'no-op' || action === 'read'))
    .map(({ address, change }) => ({ address, actions: change.actions }));
}

export function validateCloudflarePlan(plan: Plan): Array<{ address: string; actions: string[] }> {
  const changes = actionableChanges(plan);
  const unsafe = changes.filter(({ address, actions }) => (
    !allowedUpdates.has(address)
    || actions.length !== 1
    || actions[0] !== 'update'
  ));

  if (unsafe.length > 0) {
    throw new Error(`Refusing unsafe Cloudflare plan: ${JSON.stringify(unsafe)}`);
  }

  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Plan;
  const changes = validateCloudflarePlan(plan);
  console.log(`Safe plan: ${changes.length} Worker script update(s).`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\n`);
  }
}
