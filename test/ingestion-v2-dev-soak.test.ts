import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateDevSoak, type DevSoakSample } from '../scripts/ingestion-v2-dev-soak.js';

const healthy = (): DevSoakSample => ({
  capturedAt: '2026-10-04T21:00:00.000Z', windowStartedAt: '2026-10-03T21:00:00.000Z', windowHours: 24, soakStartedAt: '2026-10-03T21:00:00.000Z',
  runtime: [{ status: 'success', requests: 30, errors: 0, cpuTimeP99: 5_000_000, memoryUsageBytesP99: 90 * 1024 * 1024 }],
  canary: {
    sourceId: 'northwestern-fintech-2027-quant',
    health: { state: 'healthy', sourceStatus: 'active', lastSuccessAt: '2026-10-04T20:45:00.000Z', consecutiveFailures: 0 },
    activeSnapshot: { snapshot_hash: 'snapshot', admission_version: 'policy', is_complete: 1 },
    shadowComparison: {
      snapshot_hash: 'snapshot', admission_version: 'policy', complete: 1,
      observed_at: '2026-10-04T20:45:00.000Z', window_started_at: '2026-10-04T20:00:00.000Z',
      window_run_count: 6, window_d1_rows_written: 300,
    },
    rows: [{ state: 'settled', decision: 'admitted', rows: 71, attempts: 71, attempted: 71 }],
    pendingHandoffs: 0, staleHandoffs: 0, expiredLeases: 0, r2SnapshotValid: true,
  },
  maintenance: [{
    key: 'maintenance_phase:maintenance:ingestion_v2_admission_dispatch',
    value: '{"status":"complete"}', updated_at: '2026-10-04T20:49:00.000Z',
  }, { key: 'maintenance_phase:catalog_projection_r2:catalog_projection_r2_complete',
    value: '{"status":"complete"}', updated_at: '2026-10-04T20:49:00.000Z' }],
  publication: { generatedAt: '2026-10-04T20:49:00.000Z', version: 'a'.repeat(20), count: 12 },
  schedules: (JSON.parse(readFileSync(new URL('../wrangler.ingestion.jsonc', import.meta.url), 'utf8')) as { triggers: { crons: string[] } }).triggers.crons,
  controlMismatches: [], unresolvedFailures: [], exhaustedFailures: [], cronCount: 12, publicCatalogStatus: 200,
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
    sample.exhaustedFailures = [{ queue_name: 'intern-notifs-dev-greenhouse', source_id: 'greenhouse-awardco' }];
    sample.queues['intern-notifs-dev-admission-v2-dlq']!.backlog_count = 1;
    const failed = evaluateDevSoak(sample).filter((check) => check.status === 'fail').map((check) => check.name);
    expect(failed).toEqual(expect.arrayContaining([
      'canary polling freshness', 'no expired admission lease', 'no stale admission handoff',
      'no unresolved queue failures', 'no exhausted queue deliveries', 'admission-v2 DLQ empty',
    ]));
  });

  it('warns on a large work backlog without treating in-flight work as poison', () => {
    const sample = healthy();
    sample.queues['intern-notifs-dev-github']!.backlog_count = 101;
    expect(evaluateDevSoak(sample).find((check) => check.name === 'github work backlog')?.status).toBe('warn');
  });

  it('fails an uninitialized or over-budget V2 cost window', () => {
    const sample = healthy();
    sample.canary.shadowComparison = {
      observed_at: '2026-10-04T20:45:00.000Z', window_run_count: 60, window_d1_rows_written: 100_000,
    };
    const failed = evaluateDevSoak(sample).filter((check) => check.status === 'fail').map((check) => check.name);
    expect(failed).toEqual(expect.arrayContaining([
      'V2 cost window initialized', 'V2 shadow run budget', 'V2 D1 write budget',
    ]));
  });
  it('rejects the old cron topology and a same-count incorrect trigger', () => {
    const sample = healthy();
    sample.schedules = sample.schedules.filter((cron) => cron !== '4,14,24,34,44,54 * * * *');
    expect(evaluateDevSoak(sample).find((check) => check.name === 'production cron parity')?.status).toBe('fail');
    sample.schedules.push('4-54/10 * * * *');
    expect(evaluateDevSoak(sample).find((check) => check.name === 'production cron parity')?.status).toBe('fail');
  });

  it('rejects missing or stale R2 publication even when the public catalog succeeds', () => {
    const sample = healthy();
    delete sample.publication;
    sample.maintenance = sample.maintenance.filter((row) => !String(row.key).includes('catalog_projection_r2'));
    expect(evaluateDevSoak(sample).filter((check) => check.status === 'fail').map((check) => check.name))
      .toEqual(['fresh R2 catalog publication', 'scheduled R2 publication']);
    sample.publication = { generatedAt: '2026-10-04T18:00:00.000Z', version: 'a'.repeat(20), count: 12 };
    expect(evaluateDevSoak(sample).find((check) => check.name === 'fresh R2 catalog publication')?.status).toBe('fail');
  });

  it('checks each cohort source instead of allowing a healthy small canary to hide a failed large board', () => {
    const sample = healthy();
    sample.canaries = [sample.canary, { ...sample.canary, sourceId: 'simplify-summer-2026',
      shadowComparison: { ...sample.canary.shadowComparison, complete: 0 }, expiredLeases: 1 }];
    const failed = evaluateDevSoak(sample).filter((check) => check.status === 'fail').map((check) => check.name);
    expect(failed).toEqual(['simplify-summer-2026: recent shadow comparison', 'simplify-summer-2026: no expired admission lease']);
  });

  it('rejects stale comparisons, policy drift, and unsafe live dev controls', () => {
    const sample = healthy();
    sample.canary.shadowComparison!.observed_at = '2026-10-04T18:00:00.000Z';
    sample.canary.shadowComparison!.admission_version = 'old-policy';
    sample.controlMismatches = ['OUTBOUND_NOTIFICATIONS_ENABLED differs from tracked dev configuration'];
    expect(evaluateDevSoak(sample).filter((check) => check.status === 'fail').map((check) => check.name))
      .toEqual(['dev rollout controls', 'recent shadow comparison', 'snapshot comparison identity']);
  });

  it('does not label a fresh deployment as a completed 24-hour soak', () => {
    const sample = healthy();
    sample.soakStartedAt = '2026-10-04T20:00:00.000Z';
    expect(evaluateDevSoak(sample).find((check) => check.name === 'dev soak elapsed')?.status).toBe('fail');
  });

  it('fails missing immutable snapshots and memory-killed invocations', () => {
    const sample = healthy();
    sample.canary.r2SnapshotValid = false;
    sample.runtime = [{ status: 'exceededMemory', errors: 1, requests: 1, cpuTimeP99: 0, memoryUsageBytesP99: 130 * 1024 * 1024 }];
    expect(evaluateDevSoak(sample).filter((check) => check.status === 'fail').map((check) => check.name))
      .toEqual(['Worker runtime healthy', 'R2 snapshot integrity']);
    expect(evaluateDevSoak(sample).find((check) => check.name === 'Worker resource headroom')?.status).toBe('warn');
  });

  it('does not mistake inherited shadow classifications for completed admission', () => {
    const sample = healthy();
    sample.canary.rows = [{ state: 'settled', decision: 'admitted', rows: 71, attempts: 0, attempted: 0 }];
    expect(evaluateDevSoak(sample).find((check) => check.name === 'independent admission complete')?.status).toBe('fail');
  });

});
