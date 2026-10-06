import { D1IngestionV2Repository } from './ingestion-v2-store.js';
import { admissionSourceAllowed, type AdmissionV2Environment } from './admission-v2.js';
import { admissionV2FeatureConfig } from '../src/ingestion-v2/admission/types.js';
import { planAdmissionV2Dispatch } from '../src/ingestion-v2/admission/dispatcher.js';
import { bootstrapAdmissionSnapshot, migrateAdmissionPolicy } from '../src/ingestion-v2/admission/migration.js';
import type { Queue } from './types.js';

export interface AdmissionDispatchEnvironment extends AdmissionV2Environment { ADMISSION_V2_QUEUE: Queue }

async function sendQueueMessages(queue: Queue, messages: unknown[]): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += 100) {
    await queue.sendBatch(messages.slice(offset, offset + 100).map((body) => ({ body })));
  }
}

export const ADMISSION_V2_SOURCE_LIMIT = 500;

export async function runAdmissionV2Dispatch(env: AdmissionDispatchEnvironment, observedAt: Date): Promise<{ enabled: boolean; sources: number; bootstrapped: number; migrated: number; batches: number; rows: number }> {
  const features = admissionV2FeatureConfig(env);
  if (!features.admissionEnabled) return { enabled: false, sources: 0, bootstrapped: 0, migrated: 0, batches: 0, rows: 0 };
  const ledger = new D1IngestionV2Repository(env.DB);
  const cursor = await ledger.getDispatchSourceCursor();
  let selectedSourceIds = await ledger.listActiveSourceIds(ADMISSION_V2_SOURCE_LIMIT, cursor);
  if (!selectedSourceIds.length && cursor) selectedSourceIds = await ledger.listActiveSourceIds(ADMISSION_V2_SOURCE_LIMIT);
  const nextCursor = selectedSourceIds.length === ADMISSION_V2_SOURCE_LIMIT
    ? selectedSourceIds[selectedSourceIds.length - 1]
    : undefined;
  await ledger.setDispatchSourceCursor(nextCursor, observedAt.toISOString());
  const sourceIds = selectedSourceIds.filter((sourceId) => admissionSourceAllowed(env, sourceId));
  let bootstrapped = 0;
  let migrated = 0;
  let batches = 0;
  let rows = 0;
  for (const sourceId of sourceIds) {
    // Regrade a bounded batch of active rows settled under an older policy
    // version before dispatching their fresh work. Migration only reopens rows;
    // it never hides a visible role or sets a source-wide suppression, so a new
    // eligible role still publishes while stale peers are regraded.
    const overview = await ledger.overview(sourceId);
    if (overview.currentSnapshotHash) {
      const snapshot = await ledger.getSnapshot(sourceId, overview.currentSnapshotHash);
      if (snapshot?.isComplete) {
        bootstrapped += await bootstrapAdmissionSnapshot(sourceId, snapshot.snapshotHash, snapshot.admissionVersion, { ledger, now: () => observedAt });
        const migration = await migrateAdmissionPolicy(sourceId, snapshot.admissionVersion, { ledger, now: () => observedAt });
        migrated += migration.reopened;
      }
    }
    const plan = await planAdmissionV2Dispatch(sourceId, { ledger, now: () => observedAt });
    if (!plan.messages.length) continue;
    await sendQueueMessages(env.ADMISSION_V2_QUEUE, plan.messages as unknown[]);
    batches += plan.messages.length;
    rows += plan.messages.reduce((sum, message) => sum + message.externalIds.length, 0);
  }
  return { enabled: true, sources: sourceIds.length, bootstrapped, migrated, batches, rows };
}

