import { describe, expect, it } from 'vitest';
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
