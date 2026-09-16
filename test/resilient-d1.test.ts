import { describe, expect, it, vi } from 'vitest';
import { resilientD1 } from '../cloudflare/resilient-d1.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

const instanceGone = () => new Error('D1_ERROR: Connection closed: this D1 DB instance is no longer active. Reconnect or retry the request.');
const resetOnDeploy = () => new Error('D1_ERROR: D1 DB reset because its code was updated.');
const internalError = () => new Error('D1_ERROR: internal error; reference = 6hi9i83lajvi9r65mtnuni1t');
const overloaded = () => new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.');

function statement(overrides: Partial<Record<'first' | 'all' | 'run', () => Promise<unknown>>>): D1PreparedStatement {
  const self: D1PreparedStatement = {
    bind: () => self,
    first: overrides.first as D1PreparedStatement['first'] ?? (async () => null),
    all: overrides.all as D1PreparedStatement['all'] ?? (async () => ({ results: [] })),
    run: overrides.run as D1PreparedStatement['run'] ?? (async () => ({ meta: { changes: 0 } })),
  };
  return self;
}

const noSleep = { random: () => 0.5, sleep: async () => {} };

describe('resilientD1', () => {
  it('retries a read that fails with the reconnect error, rebuilding the statement each attempt', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(instanceGone())
      .mockResolvedValueOnce({ results: [{ value: 'ok' }] });
    const prepare = vi.fn(() => statement({ all: run }));
    const db = resilientD1({ prepare, batch: async () => [] } as unknown as D1Database, noSleep);

    await expect(db.prepare('SELECT 1').bind('x').all()).resolves.toEqual({ results: [{ value: 'ok' }] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('retries a write and a batch on the reconnect error', async () => {
    const run = vi.fn().mockRejectedValueOnce(instanceGone()).mockResolvedValueOnce({ meta: { changes: 1 } });
    const batch = vi.fn().mockRejectedValueOnce(instanceGone()).mockResolvedValueOnce([{ meta: { changes: 2 } }]);
    const db = resilientD1({ prepare: () => statement({ run }), batch } as unknown as D1Database, noSleep);

    await expect(db.prepare('UPDATE t SET a = 1').run()).resolves.toEqual({ meta: { changes: 1 } });
    await expect(db.batch([db.prepare('UPDATE t SET a = 1')])).resolves.toEqual([{ meta: { changes: 2 } }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenCalledTimes(2);
  });

  it('retries the transient D1 reset that follows a code deploy', async () => {
    const run = vi.fn().mockRejectedValueOnce(resetOnDeploy()).mockResolvedValueOnce({ meta: { changes: 1 } });
    const db = resilientD1({ prepare: () => statement({ run }), batch: async () => [] } as unknown as D1Database, noSleep);

    await expect(db.prepare('UPDATE t SET a = 1').run()).resolves.toEqual({ meta: { changes: 1 } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry a bare internal error or an overload in-request', async () => {
    const internalRun = vi.fn().mockRejectedValue(internalError());
    const internalDb = resilientD1({ prepare: () => statement({ run: internalRun }), batch: async () => [] } as unknown as D1Database, noSleep);
    await expect(internalDb.prepare('UPDATE t SET a = 1').run()).rejects.toThrow('internal error');
    expect(internalRun).toHaveBeenCalledTimes(1);

    const overloadRun = vi.fn().mockRejectedValue(overloaded());
    const overloadDb = resilientD1({ prepare: () => statement({ run: overloadRun }), batch: async () => [] } as unknown as D1Database, noSleep);
    await expect(overloadDb.prepare('UPDATE t SET a = 1').run()).rejects.toThrow('overloaded');
    expect(overloadRun).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unrelated error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('UNIQUE constraint failed'));
    const db = resilientD1({ prepare: () => statement({ run }), batch: async () => [] } as unknown as D1Database, noSleep);

    await expect(db.prepare('INSERT INTO t VALUES (1)').run()).rejects.toThrow('UNIQUE constraint failed');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and surfaces the last reconnect error', async () => {
    const run = vi.fn().mockRejectedValue(instanceGone());
    const db = resilientD1({ prepare: () => statement({ run }), batch: async () => [] } as unknown as D1Database, { attempts: 3, ...noSleep });

    await expect(db.prepare('UPDATE t SET a = 1').run()).rejects.toThrow('no longer active');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('bounds a statement that never settles and retries it as a stall', async () => {
    const stalled = vi.fn(() => new Promise<never>(() => undefined));
    const db = resilientD1({ prepare: () => statement({ first: stalled }), batch: async () => [] } as unknown as D1Database,
      { ...noSleep, attempts: 2, attemptTimeoutMs: 20 });

    await expect(db.prepare('SELECT 1').first()).rejects.toThrow('D1 statement did not settle within 20 ms');
    expect(stalled).toHaveBeenCalledTimes(2);
  });

  it('recovers when a later attempt settles after a stall', async () => {
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined))
      .mockResolvedValueOnce({ results: [{ value: 'ok' }] });
    const db = resilientD1({ prepare: () => statement({ all: run }), batch: async () => [] } as unknown as D1Database,
      { ...noSleep, attemptTimeoutMs: 20 });

    await expect(db.prepare('SELECT 1').all()).resolves.toEqual({ results: [{ value: 'ok' }] });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('uses exponential backoff with jitter between reconnect attempts', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(instanceGone())
      .mockRejectedValueOnce(instanceGone())
      .mockRejectedValueOnce(instanceGone())
      .mockRejectedValueOnce(instanceGone())
      .mockResolvedValueOnce({ meta: { changes: 1 } });
    const sleep = vi.fn(async () => {});
    const db = resilientD1(
      { prepare: () => statement({ run }), batch: async () => [] } as unknown as D1Database,
      { baseDelayMs: 40, random: () => 0.25, sleep },
    );

    await expect(db.prepare('UPDATE t SET a = 1').run()).resolves.toEqual({ meta: { changes: 1 } });
    expect(sleep).toHaveBeenNthCalledWith(1, 30);
    expect(sleep).toHaveBeenNthCalledWith(2, 60);
    expect(sleep).toHaveBeenNthCalledWith(3, 120);
    expect(sleep).toHaveBeenNthCalledWith(4, 240);
    expect(run).toHaveBeenCalledTimes(5);
  });
});
