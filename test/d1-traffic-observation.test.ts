import { describe, expect, it, vi } from 'vitest';
import { observeD1Delivery, observeQueueBatch, type D1TrafficObservation } from '../cloudflare/d1-traffic-observation.js';

describe('D1 traffic observation', () => {
  it('observes an actual catalog delivery and reports its D1 failure class without changing its outcome', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ permit: { permitId: 'permit-1', expiresAt: '2026-09-17T00:00:30.000Z', fenced: true }, status: { mode: 'observation', permitsInUse: { P0: 1, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 } }))
      .mockResolvedValueOnce(Response.json({ mode: 'guarded', permitsInUse: { P0: 0, P1: 0, P2: 0 }, budgets: { P0: 2, P1: 1, P2: 0 }, recentPressure: 3 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const observation = await observeD1Delivery({
      controller: { idFromName: vi.fn(() => 'catalog-ingestion'), get: vi.fn(() => ({ fetch })) },
      workload: 'catalog:greenhouse', queue: 'intern-notifs-greenhouse', messageId: 'delivery-1', details: { provider: 'greenhouse' },
    });
    await observation?.complete('failure', new Error('D1_ERROR: database is locked'));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ workload: 'catalog:greenhouse', priority: 'P0', messageId: 'delivery-1' });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({ permitId: 'permit-1', outcome: 'failure', d1FailureClass: 'overloaded' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('d1_traffic_permit_completed'));
    vi.restoreAllMocks();
  });

  it('records non-catalog queue workloads at their assigned priority', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ permit: { permitId: 'permit-p1', expiresAt: '2026-09-21T00:00:30.000Z', fenced: true }, status: { mode: 'observation', permitsInUse: { P0: 0, P1: 1, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 } }))
      .mockResolvedValueOnce(Response.json({ mode: 'observation', permitsInUse: { P0: 0, P1: 0, P2: 0 }, budgets: { P0: 4, P1: 2, P2: 2 }, recentPressure: 0 }));
    const observation = await observeD1Delivery({
      controller: { idFromName: vi.fn(() => 'catalog-ingestion'), get: vi.fn(() => ({ fetch })) },
      workload: 'destination-verification', priority: 'P1', queue: 'intern-notifs-destination-verification', messageId: 'destination-1',
    });
    await observation!.complete('success');

    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ workload: 'destination-verification', priority: 'P1', messageId: 'destination-1' });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({ permitId: 'permit-p1', outcome: 'success' });
  });

  it('fails open when the observation controller is unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(observeD1Delivery({
      controller: { idFromName: () => 'catalog-ingestion', get: () => ({ fetch: async () => { throw new Error('controller unavailable'); } }) },
      workload: 'catalog:github', queue: 'intern-notifs-github', messageId: 'delivery-2', details: { provider: 'github' },
    })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('d1_traffic_observation_failed'));
    vi.restoreAllMocks();
  });
});

describe('D1 queue batch observation', () => {
  const observing = () => ({ complete: vi.fn(async () => undefined) }) as D1TrafficObservation;

  it('completes each permit from the delivery it observed: ack, retry, or neither', async () => {
    const acked = observing();
    const retried = observing();
    const unresolved = observing();
    const ack = vi.fn();
    const retry = vi.fn();
    const overloaded = new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.');
    const batch = {
      queue: 'intern-notifs-destination-verification',
      messages: [
        { id: 'acked', body: 'acked', ack, retry: vi.fn() },
        { id: 'retried', body: 'retried', ack: vi.fn(), retry },
        { id: 'unresolved', body: 'unresolved', ack: vi.fn(), retry: vi.fn() },
      ],
    };

    await observeQueueBatch(batch, new Map<string, D1TrafficObservation>([
      ['acked', acked], ['retried', retried], ['unresolved', unresolved],
    ]), async (observed) => {
      observed.messages[0]!.ack();
      observed.messages[1]!.retry({ delaySeconds: 300 }, overloaded);
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(acked.complete).toHaveBeenCalledWith('success', undefined);
    expect(retried.complete).toHaveBeenCalledWith('failure', overloaded);
    expect(unresolved.complete).toHaveBeenCalledWith('cancelled', undefined);
  });

  it('completes the permits and rethrows when the consumer fails the delivery', async () => {
    const observed = observing();
    const batch = { queue: 'intern-notifs-shadow-extraction', messages: [{ id: 'shadow-1', body: 'shadow-1', ack: vi.fn(), retry: vi.fn() }] };

    await expect(observeQueueBatch(batch, new Map<string, D1TrafficObservation>([['shadow-1', observed]]),
      async () => { throw new Error('shadow consumer failed'); })).rejects.toThrow('shadow consumer failed');

    expect(observed.complete).toHaveBeenCalledWith('cancelled', undefined);
  });
});
