import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function dockerIsAvailable() {
  const result = spawnSync('docker', ['info'], {
    cwd: ROOT,
    env: process.env,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function buildWorker(name) {
  const config = `wrangler.${name}.jsonc`;
  const output = `cloudflare/dist/${name}`;
  run('wrangler', [
    'deploy',
    '--config',
    config,
    '--dry-run',
    '--containers-rollout=none',
    '--outdir',
    output,
  ]);
  run(process.execPath, ['scripts/prepare-worker-modules.mjs', output]);
}

if (dockerIsAvailable()) {
  console.log('Docker is available; building the complete Cloudflare deployment bundles.');
  run('npm', ['run', 'build:cloudflare']);
} else {
  console.log(
    'Docker is unavailable; building Worker bundles with Wrangler container rollout disabled for local E2E tests.',
  );
  buildWorker('api');
  buildWorker('ingestion');
  buildWorker('admission');
  buildWorker('catalog-publisher');
}

const testFiles = readdirSync(new URL('../test/e2e/', import.meta.url))
  .filter((file) => file.endsWith('.e2e.mjs'))
  .sort()
  .map((file) => `test/e2e/${file}`);

if (testFiles.length === 0) {
  throw new Error('No Cloudflare E2E test files found.');
}

run(process.execPath, ['--test', ...testFiles]);
