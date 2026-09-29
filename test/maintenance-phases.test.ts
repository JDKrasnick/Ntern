import { describe, expect, it, vi } from 'vitest';
import { D1MaintenancePhaseStore, maintenancePhaseKey } from '../cloudflare/maintenance-phases.js';
import type { D1Database } from '../cloudflare/types.js';

describe('maintenance phase markers', () => {
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
