import { describe, expect, it, vi } from 'vitest';
import { destinationQueueHealth } from '../cloudflare/destination-queue-health.js';

const observedAt = new Date('2026-10-18T20:42:00.000Z');
const now = () => observedAt;
const threshold = 120 * 60 * 60_000;
const metrics = (count: number, ageMs?: number) => ({ backlogCount: count, backlogBytes: count * 100,
  ...(ageMs !== undefined ? { oldestMessageTimestamp: new Date(observedAt.getTime() - ageMs) } : {}) });

describe('destination queue age confirmation', () => {
  it('does not call REST for a fresh queue', async () => {
    const confirm = vi.fn();
    expect(await destinationQueueHealth(metrics(10, 30_000), now, threshold, confirm))
      .toMatchObject({ ageMs: 30_000, signals: [] });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('ignores a stale timestamp on an empty queue', async () => {
    const confirm = vi.fn();
    expect(await destinationQueueHealth(metrics(0, 2_813_937_542), now, threshold, confirm))
      .toMatchObject({ ageMs: 0, signals: [] });
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([metrics(0), metrics(10, 30_000)])('rechecks the screenshot age against live REST metrics (%j)', async (live) => {
    const confirm = vi.fn().mockResolvedValue(live);
    const health = await destinationQueueHealth(metrics(10, 2_813_937_542), now, threshold, confirm);
    expect(health).toEqual({ metrics: live, ageMs: live.backlogCount ? 30_000 : 0, signals: [] });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('retains the age alert at its exact boundary when REST confirms it', async () => {
    expect(await destinationQueueHealth(metrics(10, threshold), now, threshold, async () => metrics(10, threshold)))
      .toMatchObject({ ageMs: threshold, signals: ['destination-verification-age'] });
  });

  it('does not hide a plausible old queue when REST fails', async () => {
    expect(await destinationQueueHealth(metrics(10, threshold), now, threshold, async () => { throw new Error('HTTP 403'); }))
      .toMatchObject({ ageMs: threshold, signals: ['destination-verification-metrics-unavailable', 'destination-verification-age'] });
  });

  it('reports confirmation failure for an impossible age without claiming a real work age', async () => {
    expect(await destinationQueueHealth(metrics(10, 2_813_937_542), now, threshold, async () => { throw new Error('timeout'); }))
      .toMatchObject({ ageMs: undefined, signals: ['destination-verification-metrics-unavailable'] });
  });

  it.each([
    metrics(10, 2_813_937_542), metrics(10, -1), metrics(10), metrics(-1),
    { ...metrics(10), oldestMessageTimestamp: new Date(NaN) },
    metrics(10, observedAt.getTime()),
  ])('reports invalid REST data instead of zero age (%j)', async (invalid) => {
    expect(await destinationQueueHealth(undefined, now, threshold, async () => invalid))
      .toMatchObject({ ageMs: undefined, signals: ['destination-verification-metrics-invalid'] });
  });

  it('uses the observation clock after a delayed confirmation', async () => {
    let sampledAt = observedAt;
    const fresh = { ...metrics(10), oldestMessageTimestamp: new Date(observedAt.getTime() + 60_000) };
    const health = await destinationQueueHealth(undefined, () => sampledAt, threshold, async () => {
      sampledAt = new Date(observedAt.getTime() + 65_000);
      return fresh;
    });
    expect(health).toMatchObject({ ageMs: 5_000, signals: [] });
  });
});
