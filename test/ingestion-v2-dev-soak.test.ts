import { describe, expect, it } from 'vitest';
import { evaluateDevSoak, type DevSoakSample } from '../scripts/ingestion-v2-dev-soak.js';

const healthy = (): DevSoakSample => ({
  capturedAt: '2026-10-04T21:00:00.000Z', windowHours: 24,
  canary: {
    sourceId: 'northwestern-fintech-2027-quant',
    health: { state: 'healthy', sourceStatus: 'active', lastSuccessAt: '2026-10-04T20:45:00.000Z', consecutiveFailures: 0 },
    activeSnapshot: { snapshot_hash: 'snapshot', is_complete: 1 },
    shadowComparison: { observed_at: '2026-10-04T20:45:00.000Z' },
    rows: [{ state: 'settled', decision: 'admitted', rows: 71, attempts: 71 }],
    pendingHandoffs: 0, staleHandoffs: 0, expiredLeases: 0,
  },
  maintenance: [{
    key: 'maintenance_phase:maintenance:ingestion_v2_admission_dispatch',
    value: '{"status":"complete"}', updated_at: '2026-10-04T20:49:00.000Z',
  }], unresolvedFailures: [], cronCount: 11, publicCatalogStatus: 200,
  queues: Object.fromEntries([
    'greenhouse', 'lever', 'ashby', 'github', 'gmail', 'destination-verification',
    'shadow-extraction', 'resume-job-import', 'admission-v2',
  ].flatMap((name) => [
    [`intern-notifs-dev-${name}`, { backlog_count: 0, backlog_bytes: 0 }],
    [`intern-notifs-dev-${name}-dlq`, { backlog_count: 0, backlog_bytes: 0 }],
  ])),
});

describe('dev ingestion soak evaluation', () => {
  it('passes a fresh, drained production-mirrored sample', () => {
    expect(evaluateDevSoak(healthy()).filter((check) => check.status !== 'pass')).toEqual([]);
  });

  it('fails stale health, expired work, unresolved failures, and DLQ poison', () => {
    const sample = healthy();
    sample.canary.health!.lastSuccessAt = '2026-10-04T18:00:00.000Z';
    sample.canary.expiredLeases = 1;
    sample.canary.staleHandoffs = 2;
    sample.unresolvedFailures = [{ queue_name: 'intern-notifs-dev-admission-v2' }];
    sample.queues['intern-notifs-dev-admission-v2-dlq']!.backlog_count = 1;
    const failed = evaluateDevSoak(sample).filter((check) => check.status === 'fail').map((check) => check.name);
    expect(failed).toEqual(expect.arrayContaining([
      'canary polling freshness', 'no expired admission lease', 'no stale admission handoff',
      'no unresolved queue failures', 'admission-v2 DLQ empty',
    ]));
  });

  it('warns on a large work backlog without treating in-flight work as poison', () => {
    const sample = healthy();
    sample.queues['intern-notifs-dev-github']!.backlog_count = 101;
    expect(evaluateDevSoak(sample).find((check) => check.name === 'github work backlog')?.status).toBe('warn');
  });
});
