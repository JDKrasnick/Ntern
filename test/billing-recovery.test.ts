import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Environment } from '../cloudflare/worker.js';

const policyName = 'InternNotifs budget warning: $5';
const approved = { policyName, approvedAt: '2026-10-22T04:00:00Z', expiresAt: '2026-10-24T00:00:00Z' };

describe('approved billing recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function deliver(value: string | null, authenticated = true, policy = policyName) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T05:00:00Z'));
    const run = vi.fn().mockResolvedValue({ success: true });
    const first = vi.fn().mockResolvedValue(value === null ? null : { value });
    const statement = { first, run, bind: vi.fn() };
    statement.bind.mockReturnValue(statement);
    const prepare = vi.fn().mockReturnValue(statement);
    const fetch = vi.fn().mockImplementation(async () => Response.json({ success: true, result: [] }));
    vi.stubGlobal('fetch', fetch);
    const env = {
      DB: { prepare }, BILLING_WEBHOOK_SECRET: 'test-secret', CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_SHUTDOWN_TOKEN: 'test-token', WORKER_NAME: 'intern-notifs-ingestion',
      GREENHOUSE_QUEUE_ID: 'greenhouse', LEVER_QUEUE_ID: 'lever', ASHBY_QUEUE_ID: 'ashby', GITHUB_QUEUE_ID: 'github',
      GMAIL_QUEUE_ID: 'gmail', DESTINATION_VERIFICATION_QUEUE_ID: 'destination-verification',
      SHADOW_EXTRACTION_QUEUE_ID: 'shadow',
    } as Environment;
    const response = await worker.fetch(new Request('https://example.test/internal/billing-shutdown', {
      method: 'POST', headers: { 'cf-webhook-auth': authenticated ? 'test-secret' : 'wrong' },
      body: JSON.stringify({ account_id: 'account', alert_type: 'billing_budget_alert', policy_name: policy }),
    }), env);
    return { response, run, first, fetch };
  }

  it('acknowledges repeated approved alerts without relatching or changing consumers and schedules', async () => {
    const { response, run, fetch } = await deliver(JSON.stringify(approved));
    expect(await response.json()).toEqual({ ignored: true, reason: 'owner-approved-recovery', expiresAt: approved.expiresAt });
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    null, 'invalid-json', 'null', JSON.stringify({ ...approved, policyName: 'another policy' }),
    JSON.stringify({ ...approved, expiresAt: '2026-10-22T05:00:00Z' }),
    JSON.stringify({ ...approved, approvedAt: '2026-10-22T06:00:00Z' }),
    JSON.stringify({ ...approved, expiresAt: 'invalid-date' }),
    JSON.stringify({ ...approved, expiresAt: '2027-10-24T00:00:00Z' }),
  ])('retains the shutdown without a valid current approval: %s', async value => {
    const { response, run, fetch } = await deliver(value);
    expect(await response.json()).toEqual({ stopped: true });
    expect(run).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalled();
  });

  it('still requires webhook authentication before reading an approval', async () => {
    const { response, first, run, fetch } = await deliver(JSON.stringify(approved), false);
    expect(response.status).toBe(404);
    expect(first).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores another policy before reading an approval', async () => {
    const { response, first } = await deliver(JSON.stringify(approved), true, 'another policy');
    expect(await response.json()).toEqual({ ignored: true });
    expect(first).not.toHaveBeenCalled();
  });
});
