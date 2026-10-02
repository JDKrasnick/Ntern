import type { AdmissionV2Ledger } from './ledger.js';

/** Per-source batch bound for one migration pass; the remainder resumes later. */
export const ADMISSION_V2_MIGRATION_BATCH = 200;

export interface AdmissionV2MigrationDependencies {
  ledger: AdmissionV2Ledger;
  now?: () => Date;
  batchSize?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface AdmissionV2MigrationResult {
  sourceId: string;
  admissionVersion: string;
  reopened: number;
  /** True when more stale rows remain for a later bounded pass. */
  remaining: boolean;
}

/**
 * Reopen a bounded batch of active rows whose settled admission version is
 * stale so they are re-graded under the current policy.
 *
 * The reopened rows stay visible: this never clears a catalog item, never sets
 * a source-wide publication suppression, and never waits for the whole source
 * history before advancing current work. Notification fencing is enforced by the
 * evaluator/sink (an existing job never emits a new-role alert).
 */
export async function migrateAdmissionPolicy(
  sourceId: string,
  admissionVersion: string,
  dependencies: AdmissionV2MigrationDependencies,
): Promise<AdmissionV2MigrationResult> {
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const batchSize = dependencies.batchSize ?? ADMISSION_V2_MIGRATION_BATCH;
  const stale = await dependencies.ledger.listStalePolicyRows(sourceId, admissionVersion, batchSize + 1);
  const selected = stale.slice(0, batchSize);
  if (selected.length > 0) {
    await dependencies.ledger.reopenRows(sourceId, selected.map((row) => row.externalId), now, { admissionVersion });
    dependencies.log?.({ event: 'ingestion_v2_policy_migration', sourceId, admissionVersion, reopened: selected.length });
  }
  return {
    sourceId,
    admissionVersion,
    reopened: selected.length,
    remaining: stale.length > batchSize,
  };
}

/**
 * Notification fencing. A new-role alert is emitted only for a role first
 * observed after the V2 baseline, never for baseline or policy-migration work,
 * and never for a role that already has a catalog job. Retries and duplicate
 * deliveries reuse the same deterministic notification identity, so this
 * decision is stable across attempts.
 */
export function admissionShouldNotify(input: {
  baseline: boolean;
  policyMigration: boolean;
  firstObservation: boolean;
  existingJob: boolean;
}): boolean {
  if (input.baseline || input.policyMigration) return false;
  if (!input.firstObservation) return false;
  if (input.existingJob) return false;
  return true;
}
