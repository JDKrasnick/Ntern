import { describe, expect, it, vi } from 'vitest';
import { destinationQueueHealth, observeDestinationUnknownAge } from '../cloudflare/destination-queue-health.js';
import type { D1Database } from '../cloudflare/types.js';

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
    metrics(10, 2_813_937_542), metrics(10, -1), metrics(-1),
    { ...metrics(10), oldestMessageTimestamp: new Date(NaN) },
  ])('reports invalid REST data instead of zero age (%j)', async (invalid) => {
    expect(await destinationQueueHealth(undefined, now, threshold, async () => invalid))
      .toMatchObject({ ageMs: undefined, signals: ['destination-verification-metrics-invalid'] });
  });

  it.each([metrics(4), metrics(4, observedAt.getTime())])('debounces documented unknown timestamps (%j)', async (unknown) => {
    const observe = vi.fn().mockResolvedValue(false);
    expect(await destinationQueueHealth(unknown, now, threshold, async () => unknown, observe))
      .toMatchObject({ ageMs: undefined, signals: [] });
    expect(observe).toHaveBeenCalledWith(true);
    observe.mockResolvedValue(true);
    expect(await destinationQueueHealth(unknown, now, threshold, async () => unknown, observe))
      .toMatchObject({ ageMs: undefined, signals: ['destination-verification-metrics-unavailable'] });
  });

  it('clears the unknown-age episode on fresh or empty observations', async () => {
    const observe = vi.fn().mockResolvedValue(false);
    for (const sample of [metrics(4, 30_000), metrics(0)]) {
      await destinationQueueHealth(sample, now, threshold, vi.fn(), observe);
    }
    expect(observe.mock.calls).toEqual([[false], [false]]);
  });

  it('keeps a plausible stale binding alert when REST cannot establish age', async () => {
    expect(await destinationQueueHealth(metrics(4, threshold), now, threshold,
      async () => metrics(4), async () => false))
      .toMatchObject({ ageMs: threshold, signals: ['destination-verification-age'] });
  });

  it('persists the grace across runs, alerts at 30 minutes, and resets after drainage', async () => {
    let value: string | undefined;
    const db = { prepare: (sql: string) => ({ bind: (_pk: string, timestamp?: string) => ({
      run: async () => {
        if (sql.startsWith('DELETE')) value = undefined;
        else if (value === undefined) value = timestamp;
      },
      first: async () => value === undefined ? null : { value },
    }) }) } as unknown as D1Database;
    expect(await observeDestinationUnknownAge(db, true, observedAt)).toBe(false);
    expect(await observeDestinationUnknownAge(db, true, new Date(observedAt.getTime() + 29 * 60_000))).toBe(false);
    expect(await observeDestinationUnknownAge(db, true, new Date(observedAt.getTime() + 30 * 60_000))).toBe(true);
    await observeDestinationUnknownAge(db, false, observedAt);
    expect(await observeDestinationUnknownAge(db, true, new Date(observedAt.getTime() + 60 * 60_000))).toBe(false);
    value = 'broken';
    expect(await observeDestinationUnknownAge(db, true, observedAt)).toBe(true);
    value = new Date(observedAt.getTime() + 60_000).toISOString();
    expect(await observeDestinationUnknownAge(db, true, observedAt)).toBe(true);
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
