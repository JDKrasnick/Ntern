import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { verifyPublicWebApi } from '../scripts/verify-public-web-api.js';

const manifest = { apiOrigin: 'https://intern-notifs.jdkrasnick.workers.dev' };

describe('API-first public web release', () => {
  it('requires the selected API capability before publishing even an empty catalog', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ jobs: [], scanBudget: 100 }));
    await expect(verifyPublicWebApi(manifest, request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith(`${manifest.apiOrigin}/jobs?status=open&scan=bounded&limit=1`, expect.objectContaining({ redirect: 'manual' }));
    request.mockResolvedValue(Response.json({ jobs: [] }));
    await expect(verifyPublicWebApi(manifest, request)).rejects.toThrow('has not deployed');
  });

  it('rejects an unavailable, redirecting, malformed or over-limit API', async () => {
    for (const response of [new Response(null, { status: 503 }), new Response(null, { status: 302 }),
      new Response('<html>shell</html>', { headers: { 'Content-Type': 'text/html' } }),
      Response.json(null), Response.json({ jobs: [{}, {}], scanBudget: 100 })]) {
      await expect(verifyPublicWebApi(manifest, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow();
    }
  });

  it('rejects arbitrary artifact destinations without making a request', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(verifyPublicWebApi({ apiOrigin: 'https://attacker.example' }, request)).rejects.toThrow('Unapproved');
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps Pages out of CI and behind a successful guarded Worker deployment', () => {
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const release = readFileSync(new URL('../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');
    expect(ci).not.toContain('wrangler pages deploy');
    expect(ci).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n");
    const web = release.slice(release.indexOf('  deploy-web:'));
    expect(web).toContain('needs: deploy');
    expect(web).not.toContain('always()');
    expect(web).toContain('run-id: ${{ needs.deploy.outputs.ci_run_id }}');
    expect(web).toContain('name: web-dist-${{ env.DEPLOY_SHA }}');
    expect(web.indexOf('verify-public-web-api.ts')).toBeLessThan(web.indexOf('wrangler pages deploy'));
    expect(web).toContain('--commit-hash "$DEPLOY_SHA"');
  });
});
