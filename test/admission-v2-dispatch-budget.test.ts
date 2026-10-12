import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import { runAdmissionV2Dispatch, ADMISSION_V2_DISPATCH_BUDGET_MS, ADMISSION_V2_SOURCE_LIMIT, type AdmissionDispatchEnvironment } from '../cloudflare/admission-v2-dispatch.js';
import * as dispatcher from '../src/ingestion-v2/admission/dispatcher.js';

const observedAt = new Date('2026-10-12T20:00:00Z');

describe('scheduled admission dispatch progress', () => {
  let cursor: string | undefined;
  let elapsed: number;
  let ids: string[];
  let env: AdmissionDispatchEnvironment;
  const repository = D1IngestionV2Repository.prototype;

  beforeEach(() => {
    cursor = undefined;
    elapsed = 0;
    ids = ['a', 'b', 'c'];
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(repository, 'getDispatchSourceCursor').mockImplementation(async () => cursor);
    vi.spyOn(repository, 'setDispatchSourceCursor').mockImplementation(async (next) => { cursor = next; });
    vi.spyOn(repository, 'listActiveSourceIds').mockImplementation(async (limit, after) => ids.filter(id => !after || id > after).slice(0, limit));
    vi.spyOn(repository, 'overview').mockImplementation(async sourceId => ({ sourceId, pending: 0, queued: 0, processing: 0, settled: 0, quarantined: 0, absent: 0 }));
    vi.spyOn(dispatcher, 'planAdmissionV2Dispatch').mockImplementation(async sourceId => ({ sourceId, snapshotHash: '', snapshotKey: '', admissionVersion: '', baseline: false, messages: [] }));
    env = { DB: {}, INGESTION_V2_ADMISSION_ENABLED: 'true', ADMISSION_V2_QUEUE: { sendBatch: vi.fn(async () => {}) } } as unknown as AdmissionDispatchEnvironment;
  });
  afterEach(() => vi.restoreAllMocks());

  it('rotates across a fleet larger than one page and wraps only after its end', async () => {
    ids = Array.from({ length: ADMISSION_V2_SOURCE_LIMIT * 2 + 1 }, (_, i) => `source-${String(i).padStart(3, '0')}`);
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(ADMISSION_V2_SOURCE_LIMIT);
    expect(cursor).toBe(ids[ADMISSION_V2_SOURCE_LIMIT - 1]);
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(ADMISSION_V2_SOURCE_LIMIT);
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(1);
    expect(cursor).toBeUndefined();
    expect(vi.mocked(repository.overview).mock.calls.flat()).toEqual(ids);
  });

  it('yields after a slow completed source and resumes the untouched tail', async () => {
    vi.mocked(repository.overview).mockImplementation(async sourceId => {
      elapsed += ADMISSION_V2_DISPATCH_BUDGET_MS;
      return { sourceId, pending: 0, queued: 0, processing: 0, settled: 0, quarantined: 0, absent: 0 };
    });
    for (const id of ids) {
      expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(1);
      expect(cursor).toBe(id === 'c' ? undefined : id);
    }
    expect(vi.mocked(repository.overview).mock.calls.flat()).toEqual(ids);
  });

  it('persists progress only after queue delivery succeeds', async () => {
    vi.mocked(dispatcher.planAdmissionV2Dispatch).mockImplementation(async sourceId => ({ sourceId, snapshotHash: 'hash', snapshotKey: 'key', admissionVersion: 'version', baseline: true,
      messages: [{ externalIds: ['one'] }] as never }));
    let fail = true;
    vi.mocked(env.ADMISSION_V2_QUEUE.sendBatch).mockImplementation(async () => {
      if (cursor === 'a' && fail) { fail = false; throw new Error('queue unavailable'); }
    });
    await expect(runAdmissionV2Dispatch(env, observedAt)).rejects.toThrow('queue unavailable');
    expect(cursor).toBe('a');
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(2);
    expect(vi.mocked(dispatcher.planAdmissionV2Dispatch).mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'b', 'c']);
  });

  it('keeps a failing first source retryable', async () => {
    vi.mocked(repository.overview).mockRejectedValueOnce(new Error('D1 unavailable'));
    await expect(runAdmissionV2Dispatch(env, observedAt)).rejects.toThrow('D1 unavailable');
    expect(repository.setDispatchSourceCursor).not.toHaveBeenCalled();
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(3);
  });

  it('advances past sources outside the admission allowlist', async () => {
    env.INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST = 'c';
    vi.mocked(repository.setDispatchSourceCursor).mockImplementation(async next => { cursor = next; elapsed += ADMISSION_V2_DISPATCH_BUDGET_MS; });
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(0);
    expect(cursor).toBe('a');
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(0);
    expect(cursor).toBe('b');
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(1);
    expect(cursor).toBeUndefined();
    expect(vi.mocked(repository.overview).mock.calls.flat()).toEqual(['c']);
  });

  it('wraps an exhausted cursor and clears an empty fleet', async () => {
    cursor = 'z';
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(3);
    expect(cursor).toBeUndefined();
    ids = [];
    cursor = 'z';
    expect((await runAdmissionV2Dispatch(env, observedAt)).sources).toBe(0);
    expect(cursor).toBeUndefined();
  });

  it('leaves the shared cursor untouched when manual readiness fails', async () => {
    Object.assign(env, { INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: 'b',
      INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: 'b', INGESTION_V2_CATALOG_WRITER_ENABLED: 'true',
      INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: 'b', INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: 'b',
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } });
    cursor = 'a';
    await expect(runAdmissionV2Dispatch(env, observedAt, 'b')).rejects.toThrow('Complete active snapshot required');
    expect(cursor).toBe('a');
    expect(repository.getDispatchSourceCursor).not.toHaveBeenCalled();
    expect(repository.setDispatchSourceCursor).not.toHaveBeenCalled();
  });
});
