import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDeploySha, validateExpectedWorkerIdentity } from '../scripts/deploy-cloudflare.js';

const headSha = 'a'.repeat(40);
const staleSha = 'b'.repeat(40);
const worker = { scriptName: 'intern-notifs', config: 'wrangler.api.jsonc' };
const deployment = { versions: [{ version_id: 'version-1', percentage: 100 }] };
const version = {
  id: 'version-1',
  annotations: { 'workers/tag': headSha },
  resources: { script: { etag: 'release-etag' } },
};
const latest = { id: 'version-1', created_on: '2026-10-01T00:00:00Z' };

describe('local Cloudflare deploy provenance', () => {
  it('stops the real deploy before infrastructure commands when production billing is latched', () => {
    const directory = mkdtempSync(join(tmpdir(), 'production-billing-pause-'));
    const log = join(directory, 'mutations');
    try {
      const stub = join(directory, 'fetch.mjs');
      writeFileSync(stub, "globalThis.fetch = async () => Response.json({success:true,result:[{results:[{value:'stopped'}]}]});\n");
      writeFileSync(join(directory, 'tofu'), '#!/bin/sh\nprintf "mutation" >> "$BILLING_TEST_LOG"\nexit 1\n', { mode: 0o755 });
      const result = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'),
        '--import', stub, resolve('scripts/deploy-cloudflare.ts')], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: directory,
          BILLING_TEST_LOG: log, CLOUDFLARE_ACCOUNT_ID: '4d67a0f1b73641df84af0a283dd5b3d8', CLOUDFLARE_API_TOKEN: 'test-token' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Billing shutdown is latched');
      expect(existsSync(log)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses Git HEAD and accepts only matching release overrides', () => {
    expect(resolveDeploySha(headSha)).toBe(headSha);
    expect(resolveDeploySha(headSha, headSha, headSha)).toBe(headSha);
  });

  it('rejects a valid but stale DEPLOY_SHA or TF_VAR_deploy_sha', () => {
    expect(() => resolveDeploySha(headSha, staleSha)).toThrow('DEPLOY_SHA must match the current Git HEAD');
    expect(() => resolveDeploySha(headSha, undefined, staleSha)).toThrow('TF_VAR_deploy_sha must match the current Git HEAD');
  });

  it('rejects malformed commit identities', () => {
    expect(() => resolveDeploySha('short')).toThrow('Could not resolve a full Git commit SHA');
    expect(() => resolveDeploySha(headSha, 'short')).toThrow('DEPLOY_SHA must match the current Git HEAD');
  });

  it('captures a tagged active version and its immutable script identity', () => {
    expect(validateExpectedWorkerIdentity(worker, headSha, deployment, version, latest)).toEqual({
      ...worker,
      versionId: 'version-1',
      etag: 'release-etag',
    });
  });

  it('rejects a foreign active upload before it can become the secret base', () => {
    expect(() => validateExpectedWorkerIdentity(worker, headSha, deployment, {
      ...version,
      annotations: { 'workers/tag': staleSha },
    }, latest)).toThrow('active version is not tagged for release');
    expect(() => validateExpectedWorkerIdentity(worker, headSha, deployment, version, {
      id: 'foreign-version',
      created_on: '2026-10-01T00:01:00Z',
    })).toThrow('has an unreviewed version newer than its active release');
  });

  it('rejects inconsistent or missing active code identity', () => {
    expect(() => validateExpectedWorkerIdentity(worker, headSha, deployment, {
      ...version,
      id: 'other-version',
    }, latest)).toThrow('does not match the version read from Wrangler');
    expect(() => validateExpectedWorkerIdentity(worker, headSha, deployment, {
      ...version,
      resources: { script: {} },
    }, latest)).toThrow('is missing its script etag');
  });
});
