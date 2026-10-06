import { safeDiagnostic } from '../src/source-health.js';
import type { D1Database } from './types.js';

export type MaintenancePhaseStatus = 'started' | 'complete' | 'failed';

/** The narrow surface a scheduled handler depends on, so the D1-backed store
 * stays one implementation and a test can pass a spy without a database. */
export interface MaintenancePhaseRecorder {
  record(phase: string, status: MaintenancePhaseStatus, observedAt?: Date): Promise<void>;
}

export async function recordPhase(
  phases: MaintenancePhaseRecorder | undefined,
  phase: string,
  status: MaintenancePhaseStatus,
  observedAt?: Date,
): Promise<void> {
  try {
    if (observedAt === undefined) await phases?.record(phase, status);
    else await phases?.record(phase, status, observedAt);
  }
  catch { /* best-effort by contract; a marker failure never fails a phase */ }
}

const maintenancePhaseKeyPrefix = 'maintenance_phase';

export function maintenancePhaseKey(scope: string, phase: string): string {
  return `${maintenancePhaseKeyPrefix}:${scope}:${phase}`;
}

/**
 * Durable progress markers for the memory-bounded scheduled handlers.
 *
 * A Worker terminated on the 128 MB limit leaves no buffered console output, so
 * the only surviving evidence of how far an invocation reached is a row it wrote
 * before dying. Each phase writes a small `system_state` row when it starts and
 * again when it finishes, which is what lets an operator tell whether termination
 * happened inside the catalog projection, R2 publication, or a later phase.
 *
 * Marker writes are deliberately best-effort. The phase work is the scheduled
 * handler's responsibility, and an overloaded D1 must not turn observability into
 * another failure. See docs/197-ingestion-resource-bounds.md.
 */
export class D1MaintenancePhaseStore implements MaintenancePhaseRecorder {
  constructor(
    private readonly db: D1Database,
    private readonly scope: string,
    private readonly log: (event: string) => void = console.error,
  ) {}

  async record(phase: string, status: MaintenancePhaseStatus, observedAt: Date = new Date()): Promise<void> {
    const at = observedAt.toISOString();
    try {
      await this.db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(maintenancePhaseKey(this.scope, phase), JSON.stringify({ scope: this.scope, phase, status, observedAt: at }), at).run();
    } catch (error) {
      this.log(JSON.stringify({ event: 'maintenance_phase_marker_failed',
        scope: this.scope, phase, status, diagnostic: safeDiagnostic(error) }));
    }
  }
}
