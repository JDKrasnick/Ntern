import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1IngestionV2Repository } from '../cloudflare/ingestion-v2-store.js';
import { runAdmissionV2Dispatch, ADMISSION_V2_DISPATCH_BUDGET_MS, ADMISSION_V2_SOURCE_LIMIT, type AdmissionDispatchEnvironment } from '../cloudflare/admission-v2-dispatch.js';
import * as dispatcher from '../src/ingestion-v2/admission/dispatcher.js';
import * as migration from '../src/ingestion-v2/admission/migration.js';

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
    vi.spyOn(repository, 'listReadyAdmissionSourceIds').mockResolvedValue([]);
    vi.spyOn(repository, 'overview').mockImplementation(async sourceId => ({ sourceId, pending: 0, queued: 0, processing: 0, settled: 0, quarantined: 0, absent: 0 }));
    vi.spyOn(dispatcher, 'planAdmissionV2Dispatch').mockImplementation(async sourceId => ({ sourceId, snapshotHash: '', snapshotKey: '', admissionVersion: '', baseline: false, messages: [] }));
    env = { DB: {}, INGESTION_V2_ADMISSION_ENABLED: 'true', ADMISSION_V2_QUEUE: { sendBatch: vi.fn(async () => {}) } } as unknown as AdmissionDispatchEnvironment;
  });
  afterEach(() => vi.restoreAllMocks());

  it('dispatches due work beyond the cursor before a slow fleet sweep', async () => {
    cursor = 'a';
    vi.mocked(repository.listReadyAdmissionSourceIds).mockResolvedValue(['z-due']);
    vi.mocked(repository.overview).mockImplementation(async sourceId => {
      elapsed += ADMISSION_V2_DISPATCH_BUDGET_MS;
      return { sourceId, pending: 0, queued: 0, processing: 0, settled: 0, quarantined: 0, absent: 0 };
    });
    await runAdmissionV2Dispatch(env, observedAt);
    expect(vi.mocked(dispatcher.planAdmissionV2Dispatch).mock.calls.map(([id]) => id)).toEqual(['z-due', 'b']);
    expect(cursor).toBe('b');
  });

  it('reserves migration progress when the ready lane consumes its budget', async () => {
    vi.mocked(repository.listReadyAdmissionSourceIds).mockResolvedValue(['x-due', 'y-due']);
    vi.mocked(dispatcher.planAdmissionV2Dispatch).mockImplementation(async sourceId => {
      elapsed += ADMISSION_V2_DISPATCH_BUDGET_MS;
      return { sourceId, snapshotHash: '', snapshotKey: '', admissionVersion: '', baseline: false, messages: [] };
    });
    await runAdmissionV2Dispatch(env, observedAt);
    expect(vi.mocked(dispatcher.planAdmissionV2Dispatch).mock.calls.map(([id]) => id)).toEqual(['x-due', 'a']);
    expect(cursor).toBe('a');
  });

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

  describe('manual dispatch of queued work without a live delivery', () => {
    let status: string;
    let healthState: string;
    let leased: boolean;
    let handoff: boolean;
    let malformed: boolean;

    beforeEach(() => {
      status = 'paused'; healthState = 'healthy'; leased = false; handoff = false; malformed = false;
      cursor = 'a';
      Object.assign(env, { INGESTION_V2_SHADOW_DISCOVERY_ENABLED: 'true', INGESTION_V2_SHADOW_SOURCE_ALLOWLIST: 'b',
        INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST: 'b', INGESTION_V2_CATALOG_WRITER_ENABLED: 'true',
        INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST: 'b', INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST: 'b',
        DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => {
          if (sql.includes('catalog_items')) return { value: malformed ? '{invalid' : JSON.stringify({ sourceStatus: status, state: healthState }) };
          if (sql.includes('lease_owner')) return leased ? { leased: 1 } : null;
          if (sql.includes('ingestion_admission_handoffs')) return handoff ? { pending: 1 } : null;
          throw new Error('Unexpected readiness query');
        } }) }) } });
      vi.mocked(repository.overview).mockResolvedValue({ sourceId: 'b', pending: 0, queued: 2, processing: 0, settled: 0,
        quarantined: 0, absent: 0, currentSnapshotHash: 'hash' });
      vi.spyOn(repository, 'getSnapshot').mockResolvedValue({ sourceId: 'b', snapshotHash: 'hash', objectKey: 'key',
        admissionVersion: 'version', documentCount: 1, rowCount: 2, state: 'active', isComplete: true, baseline: true, createdAt: observedAt.toISOString() });
      vi.spyOn(migration, 'bootstrapAdmissionSnapshot').mockResolvedValue(0);
      vi.spyOn(migration, 'migrateAdmissionPolicy').mockResolvedValue({ sourceId: 'b', admissionVersion: 'version', reopened: 0, remaining: false });
      vi.mocked(dispatcher.planAdmissionV2Dispatch).mockResolvedValue({ sourceId: 'b', snapshotHash: 'hash', snapshotKey: 'key', admissionVersion: 'version', baseline: true,
        messages: [{ externalIds: ['one', 'two'] }] as never });
    });

    it('sends a bounded paused-source plan without reading or moving the scheduled cursor', async () => {
      const result = await runAdmissionV2Dispatch(env, observedAt, 'b');
      expect(result).toMatchObject({ sources: 1, rows: 2, batches: 1 });
      expect(dispatcher.planAdmissionV2Dispatch).toHaveBeenCalledOnce();
      expect(dispatcher.planAdmissionV2Dispatch).toHaveBeenCalledWith('b', expect.anything());
      expect(env.ADMISSION_V2_QUEUE.sendBatch).toHaveBeenCalledWith([{ body: { externalIds: ['one', 'two'] } }]);
      expect(repository.getDispatchSourceCursor).not.toHaveBeenCalled();
      expect(repository.setDispatchSourceCursor).not.toHaveBeenCalled();
      expect(cursor).toBe('a');
    });

    it.each(['active', 'unknown'])('rejects queued work for a %s source', async sourceStatus => {
      status = sourceStatus;
      await expect(runAdmissionV2Dispatch(env, observedAt, 'b')).rejects.toThrow('healthy paused source');
      expect(dispatcher.planAdmissionV2Dispatch).not.toHaveBeenCalled();
      expect(env.ADMISSION_V2_QUEUE.sendBatch).not.toHaveBeenCalled();
    });

    it.each(['degraded', 'quarantined'])('rejects a %s source health record', async state => {
      healthState = state;
      await expect(runAdmissionV2Dispatch(env, observedAt, 'b')).rejects.toThrow('healthy paused source');
      expect(env.ADMISSION_V2_QUEUE.sendBatch).not.toHaveBeenCalled();
    });

    it('rejects malformed source health without dispatch effects', async () => {
      malformed = true;
      await expect(runAdmissionV2Dispatch(env, observedAt, 'b')).rejects.toThrow('healthy paused source');
      expect(env.ADMISSION_V2_QUEUE.sendBatch).not.toHaveBeenCalled();
    });

    it('rejects a queued row lease', async () => {
      leased = true;
      await expect(runAdmissionV2Dispatch(env, observedAt, 'b')).rejects.toThrow('row leases must drain');
      expect(env.ADMISSION_V2_QUEUE.sendBatch).not.toHaveBeenCalled();
    });

    it('rejects an unacknowledged handoff even with unleased queued rows', async () => {
      handoff = true;
      await expect(runAdmissionV2Dispatch(env, observedAt, 'b')).rejects.toThrow('handoffs must drain');
      expect(env.ADMISSION_V2_QUEUE.sendBatch).not.toHaveBeenCalled();
    });

    it.each(['processing', 'quarantined'] as const)('rejects %s peers before making a plan', async state => {
      vi.mocked(repository.overview).mockResolvedValue({ sourceId: 'b', pending: 0, queued: 2, processing: state === 'processing' ? 1 : 0,
        settled: 0, quarantined: state === 'quarantined' ? 1 : 0, absent: 0, currentSnapshotHash: 'hash' });
      await expect(runAdmissionV2Dispatch(env, observedAt, 'b')).rejects.toThrow('work must drain');
      expect(env.ADMISSION_V2_QUEUE.sendBatch).not.toHaveBeenCalled();
    });

    it('requires a complete retained snapshot for queued work', async () => {
      vi.mocked(repository.getSnapshot).mockResolvedValue(undefined);
      await expect(runAdmissionV2Dispatch(env, observedAt, 'b')).rejects.toThrow('Complete active snapshot');
      expect(env.ADMISSION_V2_QUEUE.sendBatch).not.toHaveBeenCalled();
    });
  });

});
