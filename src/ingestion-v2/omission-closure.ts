import { SupersededPostingObservationError } from '../store.js';
import type { ReconcilerAdmissionV2CatalogSink } from './admission/catalog-sink.js';
import type { IngestionRowRecord, IngestionSnapshotRecord } from './types.js';

export interface OmissionClosureRepository {
  getSnapshot(sourceId: string, snapshotHash: string): Promise<IngestionSnapshotRecord | undefined>;
  listPendingOmissionClosures(sourceId: string, limit: number): Promise<IngestionRowRecord[]>;
  acknowledgeOmissionClosure(row: IngestionRowRecord): Promise<void>;
  hasPendingOmissionClosures(sourceId: string): Promise<boolean>;
}

export interface OmissionClosureInput {
  sourceId: string;
  snapshotHash: string;
  admissionVersion: string;
  observedAt: string;
}

export const OMISSION_CLOSURE_LIMIT = 25;

/** Replay durable negative effects even when this complete snapshot is reused. */
export async function reconcileIngestionV2Omissions(
  dependencies: { repository: OmissionClosureRepository; sink: Pick<ReconcilerAdmissionV2CatalogSink, 'closeOmission'> },
  input: OmissionClosureInput,
): Promise<{ attempted: number; completed: number; superseded: number }> {
  const { repository, sink } = dependencies;
  const snapshot = await repository.getSnapshot(input.sourceId, input.snapshotHash);
  const result = { attempted: 0, completed: 0, superseded: 0 };
  if (snapshot?.state !== 'active' || !snapshot.isComplete || snapshot.admissionVersion !== input.admissionVersion) return result;
  const rows = await repository.listPendingOmissionClosures(input.sourceId, OMISSION_CLOSURE_LIMIT);
  const failures: unknown[] = [];
  for (const row of rows) {
    result.attempted += 1;
    try {
      await sink.closeOmission({
        sourceId: row.sourceId, externalId: row.externalId,
        admissionVersion: input.admissionVersion, observedAt: row.updatedAt,
        fence: {
          snapshotHash: row.snapshotHash, materialHash: row.materialHash,
          admissionVersion: row.admissionVersion, updatedAt: row.updatedAt,
          activeSnapshotHash: input.snapshotHash,
        },
      });
      await repository.acknowledgeOmissionClosure(row);
      result.completed += 1;
    } catch (error) {
      if (error instanceof SupersededPostingObservationError) result.superseded += 1;
      else failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Omission closures remain pending for recovery');
  if (await repository.hasPendingOmissionClosures(input.sourceId)) {
    throw new Error('Omission closures remain pending for a bounded continuation');
  }
  return result;
}
