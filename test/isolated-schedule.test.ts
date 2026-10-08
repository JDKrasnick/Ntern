import { describe, expect, it, vi } from 'vitest';
import { forwardIsolatedSchedule, isolatedScheduleRequest } from '../cloudflare/isolated-schedule.js';
import publisher from '../cloudflare/catalog-publisher-worker.js';
import admission from '../cloudflare/admission-worker.js';
import * as dispatch from '../cloudflare/admission-v2-dispatch.js';
import { isR2InternalFailure } from '../cloudflare/r2-errors.js';

const event = { cron: '9-59/10 * * * *', scheduledTime: 1791440000000 };
const request = (body: unknown, method = 'POST') => new Request('https://isolated.internal/internal/scheduled', {
  method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});

describe('private scheduled delivery', () => {
  it.each(['put: We encountered an internal error. Please try again. (10001)', 'get: An internal error occurred. (10001)'])('recognizes the R2 transport failure: %s', message => {
    expect(isR2InternalFailure(new Error(message))).toBe(true);
  });
  it.each(['put: Precondition failed. (10031)', 'put: Access denied. (10003)', 'D1_ERROR: internal error (10001)', 'R2 unavailable', null])('keeps unrelated failures fatal: %s', message => {
    expect(isR2InternalFailure(message === null ? null : new Error(message))).toBe(false);
  });
  it.each(['1,11,21,31,41,51 * * * *', '5,15,25,35,45,55 * * * *'])('defers only an acknowledged R2 failure on publication cron %s', async cron => {
    const fetch = vi.fn(async () => Response.json({ completed: false, deferred: true, failureClass: 'r2-internal' },
      { status: 503, headers: { 'Retry-After': '600' } }));
    await expect(forwardIsolatedSchedule({ fetch }, { ...event, cron })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { completed: true, deferred: true, failureClass: 'r2-internal' },
    { completed: false, deferred: false, failureClass: 'r2-internal' },
    { completed: false, deferred: true, failureClass: 'internal' },
    null,
  ])('rejects malformed deferral acknowledgements: %j', async body => {
    await expect(forwardIsolatedSchedule({ fetch: async () => Response.json(body,
      { status: 503, headers: { 'Retry-After': '600' } }) }, { ...event, cron: '5,15,25,35,45,55 * * * *' })).rejects.toThrow('503');
  });
  it('requires the publication cadence and retry interval for a deferral', async () => {
    const body = { completed: false, deferred: true, failureClass: 'r2-internal' };
    await expect(forwardIsolatedSchedule({ fetch: async () => Response.json(body,
      { status: 503, headers: { 'Retry-After': '600' } }) }, event)).rejects.toThrow('503');
    await expect(forwardIsolatedSchedule({ fetch: async () => Response.json(body,
      { status: 503 }) }, { ...event, cron: '5,15,25,35,45,55 * * * *' })).rejects.toThrow('503');
  });
  it.each(['D1_ERROR: internal error; reference = test', 'D1_ERROR: database busy'])('defers %s and completes on the next cadence', async (message) => {
    const result = { enabled: true, sources: 1, bootstrapped: 0, migrated: 0, batches: 0, rows: 0 };
    for (const manual of [false, true]) {
      const spy = vi.spyOn(dispatch, 'runAdmissionV2Dispatch').mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(result);
      const markers: Array<{ scope: string; status: string }> = [];
      const DB = { prepare() {
        let values: unknown[] = [];
        const statement = { bind(...args: unknown[]) { values = args; return statement; }, async first() { return null; },
          async run() { markers.push(JSON.parse(String(values[1]))); return {}; } };
        return statement;
      } };
      const env = { DB, INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'true', INGESTION_V2_ADMISSION_ENABLED: 'true',
        INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: 'greenhouse-figma',
        INGESTION_V2_CATALOG_WRITER_ENABLED: 'true', INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: 'greenhouse-figma',
        INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: 'greenhouse-figma', INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: 'greenhouse-figma' } as never;
      const next = () => manual ? new Request('https://isolated.internal/internal/dispatch', { method: 'POST', body: JSON.stringify({ sourceId: 'greenhouse-figma' }) }) : request(event);
      try {
        const deferred = await admission.fetch(next(), env);
        expect(deferred.status).toBe(503);
        expect(deferred.headers.get('Retry-After')).toBe('600');
        expect(await deferred.json()).toMatchObject({ completed: false, deferred: true });
        expect(spy).toHaveBeenCalledOnce();
        expect(markers.at(-1)).toMatchObject({ status: 'failed', scope: manual ? 'admission_v2_manual:greenhouse-figma' : 'admission_v2' });
        expect((await admission.fetch(manual ? next() : request({ ...event, scheduledTime: event.scheduledTime + 600_000 }), env)).status).toBe(200);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(markers.at(-1)?.status).toBe('complete');
      } finally { spy.mockRestore(); }
    }
  });
  it('keeps unexpected dispatcher failures visible', async () => {
    const spy = vi.spyOn(dispatch, 'runAdmissionV2Dispatch').mockRejectedValue(new Error('SQLITE_ERROR: malformed query'));
    const DB = { prepare() { const statement = { bind() { return statement; }, async first() { return null; }, async run() { return {}; } }; return statement; } };
    try { await expect(admission.fetch(request(event), { DB, INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'true' } as never)).rejects.toThrow('malformed query'); }
    finally { spy.mockRestore(); }
  });
  it.each(['D1_ERROR: Network connection lost.', 'D1_ERROR: internal error; reference = billing'])('handles a billing read failure: %s', async (message) => {
    let reads = 0;
    const markers: Array<{ status: string }> = [];
    const spy = vi.spyOn(dispatch, 'runAdmissionV2Dispatch').mockResolvedValue({ enabled: false, sources: 0, bootstrapped: 0, migrated: 0, batches: 0, rows: 0 });
    const DB = { prepare() {
      let values: unknown[] = [];
      const statement = { bind(...args: unknown[]) { values = args; return statement; },
        async first() { if (reads++ === 0) throw new Error(message); return null; },
        async run() { markers.push(JSON.parse(String(values[1]))); return {}; } };
      return statement;
    } };
    try {
      const response = await admission.fetch(request(event), { DB, INGESTION_V2_ISOLATED_WORKERS_ENABLED: 'true' } as never);
      if (message.includes('Network')) { expect(response.status).toBe(200); expect(reads).toBe(2); expect(spy).toHaveBeenCalledOnce(); expect(markers.at(-1)?.status).toBe('complete'); }
      else { expect(response.status).toBe(503); expect(reads).toBe(1); expect(spy).not.toHaveBeenCalled(); expect(markers.at(-1)?.status).toBe('failed'); }
    } finally { spy.mockRestore(); }
  });
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
