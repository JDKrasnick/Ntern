import { describe, expect, it, vi } from 'vitest';
import { forwardIsolatedSchedule, isolatedScheduleRequest } from '../cloudflare/isolated-schedule.js';
import publisher from '../cloudflare/catalog-publisher-worker.js';
import admission from '../cloudflare/admission-worker.js';

const event = { cron: '9-59/10 * * * *', scheduledTime: 1791440000000 };
const request = (body: unknown, method = 'POST') => new Request('https://isolated.internal/internal/scheduled', {
  method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});

describe('private scheduled delivery', () => {
  it('rejects unscoped manual dispatch and incomplete ownership before database work', async () => {
    const DB = { prepare() { throw Error('unexpected database work'); } };
    const manual = (body: unknown) => new Request('https://isolated.internal/internal/dispatch', { method: 'POST', body: JSON.stringify(body) });
    expect((await admission.fetch(manual({ sourceId: 'greenhouse-figma' }), { DB, INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'false' } as never)).status).toBe(404);
    const env = { DB, INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'true' } as never;
    for (const body of [null, {}, { sourceId: '*' }, { sourceId: ['greenhouse-figma'] }, { sourceId: 'greenhouse-figma', limit: 9999 }]) {
      expect((await admission.fetch(manual(body), env)).status).toBe(400);
    }
    expect((await admission.fetch(manual({ sourceId: 'greenhouse-figma' }), env)).status).toBe(409);
  });
  it('preserves the natural cron and time and waits for acknowledged completion', async () => {
    const fetch = vi.fn(async (r: Request) => {
      expect(r.method).toBe('POST');
      expect(await r.json()).toEqual(event);
      return Response.json({ completed: true });
    });
    await forwardIsolatedSchedule({ fetch }, event);
    expect(fetch).toHaveBeenCalledOnce();
    expect(await isolatedScheduleRequest(request(event), [event.cron])).toEqual(event);
  });
  it('fails closed on missing bindings, downstream failures, and missing completion', async () => {
    await expect(forwardIsolatedSchedule(undefined, event)).rejects.toThrow('binding missing');
    await expect(forwardIsolatedSchedule({ fetch: async () => new Response('failed', { status: 503 }) }, event)).rejects.toThrow('503');
    await expect(forwardIsolatedSchedule({ fetch: async () => Response.json({}) }, event)).rejects.toThrow('did not complete');
  });
  it.each([
    { ...event, cron: '*/1 * * * *' }, { ...event, scheduledTime: 'now' },
    { ...event, scheduledTime: -1 }, { ...event, scheduledTime: 8_640_000_000_000_001 },
    { ...event, padding: 'x'.repeat(1024) },
  ])('rejects malformed or unexpected private work: %j', async (body) => {
    expect(await isolatedScheduleRequest(request(body), [event.cron])).toBeUndefined();
  });
  it('keeps other paths, GET requests, and disabled isolates inert', async () => {
    expect(await isolatedScheduleRequest(request(event, 'GET'), [event.cron])).toBeUndefined();
    const db = { prepare() { throw Error('unexpected database work'); } };
    const env = { DB: db, INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'false' } as never;
    expect((await admission.fetch(request(event), env)).status).toBe(404);
    expect((await publisher.fetch(request({ ...event, cron: '1-51/10 * * * *' }), env)).status).toBe(404);
    await admission.scheduled();
    await publisher.scheduled({ ...event, cron: '1-51/10 * * * *' }, env);
  });
});
