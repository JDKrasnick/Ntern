import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import apiWorker, { type ApiEnvironment } from '../cloudflare/api-worker.js';
import ingestionWorker, { type IngestionEnvironment } from '../cloudflare/ingestion-worker.js';
import { isIngestionOperationPath, secretMatches } from '../cloudflare/split.js';
import { billingShutdownQueueIds, type Environment } from '../cloudflare/worker.js';

describe('API and ingestion Worker boundary', () => {
  it('forwards the trusted-admission backfill through the authenticated service binding', async () => {
    let forwarded: Request | undefined;
    const env = {
      INTERNAL_SERVICE_SECRET: 'internal-test-secret',
      OPERATIONS_SHARED_SECRET: 'operations-test-secret',
      DEPLOYMENT_ROLE: 'api', VERSION_METADATA: { id: 'api-version' },
      INGESTION: { async fetch(request: Request) { forwarded = request; return Response.json({ queued: 0 }); } },
    } as ApiEnvironment;

    const response = await apiWorker.fetch(new Request('https://api.example.test/internal/trusted-admission-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operations-Key': 'operations-test-secret' },
      body: JSON.stringify({ sourceIds: ['speedyapply-2027-swe'] }),
    }), env);

    expect(response.status).toBe(200);
    expect(forwarded?.headers.get('X-InternNotifs-Service-Key')).toBe('internal-test-secret');
    expect(forwarded?.headers.get('X-Operations-Key')).toBe('operations-test-secret');
    expect(await forwarded?.json()).toEqual({ sourceIds: ['speedyapply-2027-swe'] });
    expect(isIngestionOperationPath('/internal/trusted-admission-backfill')).toBe(true);
    expect(isIngestionOperationPath('/internal/backfill')).toBe(true);
    expect(isIngestionOperationPath('/internal/role-metadata/backfill')).toBe(true);
    expect(isIngestionOperationPath('/jobs')).toBe(false);
  });

  it('reports both Worker identities only to an authorized operator', async () => {
    const env = {
      INTERNAL_SERVICE_SECRET: 'internal-test-secret', OPERATIONS_SHARED_SECRET: 'operations-test-secret',
      DEPLOYMENT_ROLE: 'api', VERSION_METADATA: { id: 'api-version' },
      INGESTION: { async fetch() { return Response.json({ role: 'ingestion', version: { id: 'ingestion-version' } }); } },
    } as ApiEnvironment;

    const denied = await apiWorker.fetch(new Request('https://api.example.test/internal/deployment'), env);
    expect(denied.status).toBe(404);
    const allowed = await apiWorker.fetch(new Request('https://api.example.test/internal/deployment', {
      headers: { 'X-Operations-Key': 'operations-test-secret' },
    }), env);
    expect(await allowed.json()).toEqual({
      api: { role: 'api', version: { id: 'api-version' } },
      ingestion: { role: 'ingestion', version: { id: 'ingestion-version' } },
    });
  });

  it('does not expose the ingestion Worker without service authentication', async () => {
    const env = { INTERNAL_SERVICE_SECRET: 'internal-test-secret' } as IngestionEnvironment;
    const response = await ingestionWorker.fetch(new Request('https://ingestion.example.test/internal/backfill', { method: 'POST' }), env);
    expect(response.status).toBe(404);
  });

  it('requires a matching service secret even when the request has an operations key', async () => {
    const env = { INTERNAL_SERVICE_SECRET: 'internal-test-secret', OPERATIONS_SHARED_SECRET: 'operations-test-secret' } as IngestionEnvironment;
    const response = await ingestionWorker.fetch(new Request('https://ingestion.example.test/internal/backfill', {
      method: 'POST', headers: { 'X-Operations-Key': 'operations-test-secret', 'X-InternNotifs-Service-Key': 'wrong-secret' },
    }), env);
    expect(response.status).toBe(404);
  });

  it('compares internal secrets without accepting an empty value', () => {
    expect(secretMatches('same', 'same')).toBe(true);
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches('different', 'same')).toBe(false);
  });

  it('stops every ingestion queue during billing shutdown', () => {
    const env = {
      GREENHOUSE_QUEUE_ID: 'greenhouse', LEVER_QUEUE_ID: 'lever', ASHBY_QUEUE_ID: 'ashby',
      GITHUB_QUEUE_ID: 'github', GMAIL_QUEUE_ID: 'gmail',
      DESTINATION_VERIFICATION_QUEUE_ID: 'destination-verification',
      SHADOW_EXTRACTION_QUEUE_ID: 'shadow-extraction',
    } as Environment;

    expect(billingShutdownQueueIds(env)).toEqual([
      'greenhouse', 'lever', 'ashby', 'github', 'gmail', 'destination-verification', 'shadow-extraction',
    ]);
  });

  it('resolves the shadow queue by exact name for Wrangler billing shutdowns without a configured ID', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      return Response.json({ success: true, result: url.endsWith('/queues?per_page=100')
        ? [{ queue_id: 'resolved-shadow-id', queue_name: 'intern-notifs-shadow-extraction' }] : [] });
    }));
    try {
      const env = {
        INTERNAL_SERVICE_SECRET: 'internal-test-secret', BILLING_WEBHOOK_SECRET: 'billing-test-secret',
        CLOUDFLARE_SHUTDOWN_TOKEN: 'cloudflare-test-token', CLOUDFLARE_ACCOUNT_ID: 'account', WORKER_NAME: 'intern-notifs-ingestion',
        GREENHOUSE_QUEUE_ID: 'greenhouse', LEVER_QUEUE_ID: 'lever', ASHBY_QUEUE_ID: 'ashby', GITHUB_QUEUE_ID: 'github',
        GMAIL_QUEUE_ID: 'gmail', DESTINATION_VERIFICATION_QUEUE_ID: 'destination-verification',
        SHADOW_EXTRACTION_QUEUE_NAME: 'intern-notifs-shadow-extraction',
      } as IngestionEnvironment;
      const response = await ingestionWorker.fetch(new Request('https://ingestion.example.test/internal/billing-shutdown?dry-run=true', {
        method: 'POST', headers: { 'X-InternNotifs-Service-Key': 'internal-test-secret', 'cf-webhook-auth': 'billing-test-secret' },
      }), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ready: true });
      expect(requested.some((url) => url.endsWith('/queues/resolved-shadow-id/consumers'))).toBe(true);
      expect(requested.some((url) => url.includes('/queues/undefined/'))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns 502 instead of throwing when ingestion is unreachable', async () => {
    const throwingEnv = {
      INTERNAL_SERVICE_SECRET: 'internal-test-secret', OPERATIONS_SHARED_SECRET: 'operations-test-secret',
      INGESTION: { async fetch(): Promise<Response> { throw new Error('connection refused'); } },
    } as ApiEnvironment;
    const headers = { 'X-Operations-Key': 'operations-test-secret' };
    const threw = await apiWorker.fetch(new Request('https://api.example.test/internal/deployment', { headers }), throwingEnv);
    expect(threw.status).toBe(502);

    const nonJsonEnv = {
      ...throwingEnv,
      INGESTION: { async fetch() { return new Response('not json', { status: 200 }); } },
    } as ApiEnvironment;
    const nonJson = await apiWorker.fetch(new Request('https://api.example.test/internal/deployment', { headers }), nonJsonEnv);
    expect(nonJson.status).toBe(502);
  });

  it('keeps the ingestion route inventory synchronized with the worker router', () => {
    const router = readFileSync(new URL('../cloudflare/worker.ts', import.meta.url), 'utf8');
    const exactPaths = [...router.matchAll(/url\.pathname === ["']([^"']+)["']/g)].map((match) => match[1]!);
    const prefixPaths = [...router.matchAll(/url\.pathname\.startsWith\(["']([^"']+)["']\)/g)].map((match) => match[1]!);
    expect(exactPaths.length).toBeGreaterThan(0);
    expect(prefixPaths.length).toBeGreaterThan(0);

    // Any /internal/* or /operations/* route added to the router must be
    // classified for ingestion forwarding; anything else must stay on the API.
    for (const path of exactPaths) {
      const ingestionOwned = path.startsWith('/internal/') || path.startsWith('/operations/');
      expect(isIngestionOperationPath(path)).toBe(ingestionOwned);
    }
    for (const prefix of prefixPaths) {
      const ingestionOwned = prefix.startsWith('/internal/') || prefix.startsWith('/operations/');
      expect(isIngestionOperationPath(`${prefix}probe`)).toBe(ingestionOwned);
    }
    // Regex-routed public paths never enter ingestion.
    expect(isIngestionOperationPath('/roles/engineer/reports')).toBe(false);
    expect(isIngestionOperationPath('/me/documents/abc/content')).toBe(false);
  });
});
