import { describe, expect, it, vi } from 'vitest';
import { D1MaintenancePhaseStore, maintenancePhaseKey } from '../cloudflare/maintenance-phases.js';
import type { D1Database } from '../cloudflare/types.js';
import { DatabaseSync } from 'node:sqlite';
import { markerSignals } from '../scripts/ingestion-watchdog.js';

describe('maintenance phase markers', () => {
  it('retains the last completion across repeated starts and repairs malformed history', async () => {
    const sql = new DatabaseSync(':memory:');
    sql.exec('CREATE TABLE system_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)');
    const db = { prepare(query: string) { return { bind(...values: never[]) {
      return { async run() { sql.prepare(query).run(...values); } };
    } }; } } as unknown as D1Database;
    const phases = new D1MaintenancePhaseStore(db, 'admission_v2');
    const read = () => JSON.parse((sql.prepare('SELECT value FROM system_state').get() as { value: string }).value);
    try {
      const completed = new Date('2026-10-15T20:00:00Z');
      await phases.record('dispatch', 'started', completed);
      await phases.record('dispatch', 'started', new Date('2026-10-15T20:40:00Z'));
      expect(read()).toMatchObject({ firstStartedAt: completed.toISOString() });
      const key = maintenancePhaseKey('admission_v2', 'dispatch');
      expect(markerSignals([{ key, value: JSON.stringify(read()), updated_at: '2026-10-15T20:40:00Z' }],
        [key], new Date('2026-10-15T20:40:00Z'))).toHaveLength(1);
      await phases.record('dispatch', 'complete', completed);
      expect(read().firstStartedAt).toBeUndefined();
      await phases.record('dispatch', 'started', new Date('2026-10-15T20:10:00Z'));
      await phases.record('dispatch', 'started', new Date('2026-10-15T20:40:00Z'));
      expect(read()).toMatchObject({ status: 'started', lastCompletedAt: completed.toISOString() });
      const next = new Date('2026-10-15T20:41:00Z');
      await phases.record('dispatch', 'complete', next);
      expect(read().lastCompletedAt).toBe(next.toISOString());
      sql.exec("UPDATE system_state SET value='broken-json'");
      await phases.record('dispatch', 'started', next);
      expect(read().status).toBe('started');
    } finally { sql.close(); }
  });
  it('upserts one small system_state row per phase transition', async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        return { bind(...values: unknown[]) {
          runs.push({ sql, values });
          return { async run() { return { meta: { changes: 1 } }; } };
        } };
      },
    } as unknown as D1Database;
    const observedAt = new Date('2026-09-29T16:21:17.491Z');

    await new D1MaintenancePhaseStore(db, 'maintenance').record('expo_notifications', 'complete', observedAt);

    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toContain('INTO system_state');
    expect(runs[0]!.values[0]).toBe(maintenancePhaseKey('maintenance', 'expo_notifications'));
    expect(JSON.parse(String(runs[0]!.values[1]))).toEqual({
      scope: 'maintenance', phase: 'expo_notifications', status: 'complete', observedAt: observedAt.toISOString(),
    });
    expect(runs[0]!.values[2]).toBe(observedAt.toISOString());
  });

  it('keeps scopes distinct so a projection marker cannot shadow a maintenance one', () => {
    expect(maintenancePhaseKey('maintenance', 'd1_overload_metrics'))
      .not.toBe(maintenancePhaseKey('catalog_projection', 'd1_overload_metrics'));
  });

  it('never lets an overloaded D1 turn a marker into a failed phase', async () => {
    const log = vi.fn();
    const db = {
      prepare() {
        return { bind() { return { async run() { throw new Error('D1 DB is overloaded.'); } }; } };
      },
    } as unknown as D1Database;

    await expect(new D1MaintenancePhaseStore(db, 'catalog_projection', log)
      .record('catalog_projection_d1', 'started')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('maintenance_phase_marker_failed'));
  });
});
