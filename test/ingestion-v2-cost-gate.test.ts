import { describe, expect, it } from 'vitest';
import { evaluateIngestionV2CostWindows, type IngestionV2CostWindow } from '../scripts/ingestion-v2-cost-gate.js';

const row = (overrides: Partial<IngestionV2CostWindow> = {}): IngestionV2CostWindow => ({
  source_id: 'simplify-summer-2026',
  window_started_at: '2026-10-05T00:00:00.000Z',
  window_run_count: 6,
  window_d1_rows_written: 6_000,
  updated_at: '2026-10-05T00:30:00.000Z',
  ...overrides,
});

describe('ingestion V2 production cost gate', () => {
  it('passes initialized windows below both production thresholds', () => {
    expect(evaluateIngestionV2CostWindows([row()])).toEqual([{
      sourceId: 'simplify-summer-2026', status: 'pass', detail: '6 runs, 6000 D1 rows',
    }]);
  });

  it('fails missing telemetry and either threshold at the boundary', () => {
    const checks = evaluateIngestionV2CostWindows([
      row({ source_id: 'missing', window_started_at: null }),
      row({ source_id: 'runs', window_run_count: 60 }),
      row({ source_id: 'writes', window_d1_rows_written: 100_000 }),
    ]);
    expect(checks.map((check) => [check.sourceId, check.status])).toEqual([
      ['missing', 'fail'], ['runs', 'fail'], ['writes', 'fail'],
    ]);
  });

  it('fails closed when no source updated a cost window in the last hour', () => {
    expect(evaluateIngestionV2CostWindows([])).toEqual([{
      sourceId: 'all', status: 'fail', detail: 'no V2 cost window updated in the last hour',
    }]);
  });
});
