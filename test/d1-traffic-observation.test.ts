import { describe, expect, it, vi } from 'vitest';
import { observeCatalogDelivery } from '../cloudflare/d1-traffic-observation.js';

describe('catalog traffic observation', () => {
  it('observes an actual catalog delivery and reports its D1 failure class without changing its outcome', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ permit: { permitId: 'permit-1', expiresAt: '2026-09-17T00:00:30.000Z', fenced: true }, status: { mode: 'observation', permitsInUse: { P0: 1, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 } }))
      .mockResolvedValueOnce(Response.json({ mode: 'guarded', permitsInUse: { P0: 0, P1: 0, P2: 0 }, budgets: { P0: 2, P1: 1, P2: 0 }, recentPressure: 3 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const observation = await observeCatalogDelivery({
      controller: { idFromName: vi.fn(() => 'catalog-ingestion'), get: vi.fn(() => ({ fetch })) },
      provider: 'greenhouse', queue: 'intern-notifs-greenhouse', messageId: 'delivery-1',
    });
    await observation?.complete('failure', new Error('D1_ERROR: database is locked'));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ workload: 'catalog:greenhouse', priority: 'P0', messageId: 'delivery-1' });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({ permitId: 'permit-1', outcome: 'failure', d1FailureClass: 'overloaded' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('d1_traffic_permit_completed'));
    vi.restoreAllMocks();
  });

  it('fails open when the observation controller is unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(observeCatalogDelivery({
      controller: { idFromName: () => 'catalog-ingestion', get: () => ({ fetch: async () => { throw new Error('controller unavailable'); } }) },
      provider: 'github', queue: 'intern-notifs-github', messageId: 'delivery-2',
    })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('d1_traffic_observation_failed'));
    vi.restoreAllMocks();
  });
});
