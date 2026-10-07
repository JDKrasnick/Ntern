import { planSnapshotDiff } from './diff.js';
import { normalizeSourceSnapshot } from './normalize.js';
import type { PostingDecision } from '../types.js';
import type {
  IngestionDecision,
  IngestionRowRecord,
  IngestionSnapshotObjectStore,
  IngestionV2FeatureConfig,
  IngestionV2Repository,
  ShadowComparisonMetrics,
  ShadowDiscoveryHook,
  ShadowDiscoveryInput,
  ShadowMismatchSample,
} from './types.js';

const SAMPLE_LIMIT = 10;

export interface ShadowDiscoveryDependencies {
  repository: IngestionV2Repository;
  snapshots: IngestionSnapshotObjectStore;
  features: IngestionV2FeatureConfig;
  /**
   * Optional admission-lane producer. When V2 admission is enabled the worker
   * supplies it so rows whose material content, policy version, or presence
   * changed re-enter the admission lane as dispatchable work. Absent in pure
   * Stage 1 shadow mode, which must stay side-effect free.
   */
  reopenActionableRows?: (input: {
    sourceId: string;
    snapshotHash: string;
    admissionVersion: string;
    externalIds: readonly string[];
    now: string;
  }) => Promise<number>;
  /** Whether this source is currently inside the admission rollout boundary. */
  admissionEnabledForSource?: (sourceId: string) => boolean;
  reconcileOmissions?: (input: {
    sourceId: string; snapshotHash: string; admissionVersion: string; observedAt: string;
  }) => Promise<void>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * A shadow projection of the legacy classification, stored so the V2 ledger can
 * settle rows without running admission. It is bookkeeping only: shadow mode
 * never creates a job, occurrence, notification, or admission message.
 */
function projectDecision(decision: PostingDecision | undefined): IngestionDecision | undefined {
  if (!decision) return undefined;
  if (decision.outcome === 'included') return 'admitted';
  if (decision.outcome === 'shelved') return 'shelved';
  return 'blocked';
}

function sample(ids: Iterable<string>): ShadowMismatchSample {
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  return { count: sorted.length, samples: sorted.slice(0, SAMPLE_LIMIT) };
}

function difference(left: readonly string[], right: ReadonlySet<string>): string[] {
  return left.filter((id) => !right.has(id));
}

/**
 * Side-effect-free (relative to the live catalog) Stage 1 discovery.
 *
 * After the legacy fetch passes its quality gates it normalizes the complete
 * board, stores the content-addressed snapshot, runs the full-board diff against
 * the compact ledger, and records only V2 state plus comparison metrics.
 */
export class IngestionV2ShadowDiscovery implements ShadowDiscoveryHook {
  private readonly now: () => Date;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(private readonly dependencies: ShadowDiscoveryDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  }

  isEnabledForSource(sourceId: string): boolean {
    const { features } = this.dependencies;
    return features.shadowDiscoveryEnabled
      && (!features.sourceAllowlist || features.sourceAllowlist.includes(sourceId));
  }

  async discover(input: ShadowDiscoveryInput): Promise<{ completed: boolean; snapshotHash?: string }> {
    if (!this.isEnabledForSource(input.sourceId)) return { completed: false };
    const started = this.now().getTime();
    try {
      return { completed: true, snapshotHash: await this.run(input, started) };
    } catch (error) {
      // Shadow mode must never fail or retry a legacy delivery.
      const detail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      const empty = { count: 0, samples: [] as string[] };
      const failed: ShadowComparisonMetrics = {
        sourceId: input.sourceId,
        snapshotHash: input.snapshotHash,
        admissionVersion: input.admissionVersion,
        complete: false,
        observedAt: input.observedAt,
        durationMs: this.now().getTime() - started,
        counts: { total: input.postings.length, new: 0, changed: 0, stalePolicy: 0, retryable: 0, unchanged: 0, reappeared: 0, missing: 0 },
        v2Actionable: empty,
        legacyActionable: sample(input.legacyActionableExternalIds),
        v2Only: empty,
        legacyOnly: sample(input.legacyActionableExternalIds),
        d1RowsRead: 0,
        d1RowsWritten: 0,
        r2Bytes: 0,
        status: 'failed',
      };
      try {
        await this.dependencies.repository.putShadowComparison(failed);
      } catch (persistenceError) {
        this.log({
          event: 'ingestion_v2_shadow_failure_persistence_failed',
          sourceId: input.sourceId,
          error: persistenceError instanceof Error ? persistenceError.message.slice(0, 500) : String(persistenceError).slice(0, 500),
        });
      }
      this.log({
        event: 'ingestion_v2_shadow_failed',
        sourceId: input.sourceId,
        snapshotHash: input.snapshotHash,
        durationMs: failed.durationMs,
        status: failed.status,
        error: detail,
      });
      return { completed: false };
    }
  }

  private async run(input: ShadowDiscoveryInput, started: number): Promise<string> {
    const { repository, snapshots } = this.dependencies;
    const admissionEnabled = this.dependencies.admissionEnabledForSource?.(input.sourceId)
      ?? Boolean(this.dependencies.reopenActionableRows);
    const envelope = normalizeSourceSnapshot({
      sourceId: input.sourceId,
      postings: input.postings,
      admissionVersion: input.admissionVersion,
      observedAt: input.observedAt,
    });
    const existingSnapshot = await repository.getSnapshot(input.sourceId, envelope.snapshotHash);
    const continuationCanReuseSnapshot = input.completeFetchSequence === undefined
      && existingSnapshot?.state === 'active'
      && existingSnapshot.isComplete
      && existingSnapshot.admissionVersion === envelope.admissionVersion;
    if (continuationCanReuseSnapshot) {
      // A bounded legacy continuation repeats the same complete board. Pending
      // omission effects still need recovery, but that recovery is independent
      // of recomputing the immutable snapshot diff and comparison metrics.
      if (this.dependencies.reconcileOmissions
        && (await repository.hasPendingOmissionClosures?.(input.sourceId) ?? true)) {
        await this.dependencies.reconcileOmissions({
          sourceId: input.sourceId, snapshotHash: envelope.snapshotHash,
          admissionVersion: input.admissionVersion, observedAt: input.observedAt,
        });
      }
      this.log({
        event: 'ingestion_v2_shadow_continuation_reused',
        runId: input.runId,
        sourceId: input.sourceId,
        snapshotHash: envelope.snapshotHash,
        durationMs: this.now().getTime() - started,
      });
      return envelope.snapshotHash;
    }
    const ledger = await repository.listLedger(input.sourceId);
    const diff = planSnapshotDiff({
      sourceId: input.sourceId,
      snapshotHash: envelope.snapshotHash,
      admissionVersion: input.admissionVersion,
      complete: true,
      now: input.now,
      rows: envelope.rows,
      ledger,
    });
    // Continuation deliveries repeat the same complete board while the legacy
    // lane advances through a bounded slice. A normal cadence or pending
    // omission recovery can still reach this reuse path, so avoid rewriting
    // the immutable object and every ledger row after computing their diff.
    const reuseActiveSnapshot = existingSnapshot?.state === 'active'
      && existingSnapshot.isComplete
      && existingSnapshot.admissionVersion === envelope.admissionVersion
      && diff.omissionUpdates.length === 0;
    let bytes = 0;
    if (!reuseActiveSnapshot) {
      const stored = await snapshots.putSnapshot(envelope);
      bytes = stored.bytes;
      await repository.putSnapshot({
        sourceId: envelope.sourceId,
        snapshotHash: envelope.snapshotHash,
        objectKey: stored.key,
        admissionVersion: envelope.admissionVersion,
        documentCount: envelope.documentCount,
        rowCount: envelope.rowCount,
        state: 'staged',
        isComplete: true,
        baseline: input.baseline,
        createdAt: input.observedAt,
      });
    }

    const decisions = new Map(input.processed.decisions.map((decision) => [decision.externalId, decision]));
    const classifications = new Map(diff.rows.map((row) => [row.externalId, row.classification]));
    const rows: IngestionRowRecord[] = envelope.rows.map((row) => {
      const decision = projectDecision(decisions.get(row.externalId));
      return {
        sourceId: input.sourceId,
        externalId: row.externalId,
        snapshotHash: envelope.snapshotHash,
        materialHash: row.materialHash,
        admissionVersion: input.admissionVersion,
        // Policy migration must stay silent even when discovery observes the
        // new version before the scheduled migration pass can fence the row.
        notificationBaseline: input.baseline || !admissionEnabled || classifications.get(row.externalId) === 'stale-policy',
        state: 'settled' as const,
        ...(decision ? { decision } : {}),
        attemptCount: 0,
        consecutiveOmissions: 0,
        firstObservedAt: input.observedAt,
        lastObservedAt: input.observedAt,
        updatedAt: input.observedAt,
        settledAt: input.observedAt,
      };
    });
    if (!reuseActiveSnapshot) {
      await repository.putRows(rows);
      await repository.applyOmissions(input.sourceId, diff.omissionUpdates, input.observedAt);
      await repository.activateSnapshot(input.sourceId, envelope.snapshotHash, input.observedAt);
    }
    // Re-enter the admission lane only for rows whose material, policy version,
    // or presence changed. A due-retry row is already dispatchable, so reopening
    // it would reset the attempt count that caps its retries.
    let reopened = 0;
    if (admissionEnabled && input.completeFetchSequence !== undefined && repository.recordCompleteCadence) {
      reopened += await repository.recordCompleteCadence(
        input.sourceId, envelope.snapshotHash, input.admissionVersion,
        input.completeFetchSequence, input.observedAt,
      );
    }
    const reopenExternalIds = diff.rows
      .filter((entry) => entry.actionable && entry.classification !== 'retryable')
      .map((entry) => entry.externalId);
    if (admissionEnabled && this.dependencies.reopenActionableRows && reopenExternalIds.length) {
      reopened += await this.dependencies.reopenActionableRows({
        sourceId: input.sourceId,
        snapshotHash: envelope.snapshotHash,
        admissionVersion: input.admissionVersion,
        externalIds: reopenExternalIds,
        now: input.observedAt,
      });
    }

    // Persist new admission work before a bounded closure continuation can
    // fail this pass. Recovery must not turn newly observed rows into unchanged
    // shadow rows that never entered the admission lane.
    await this.dependencies.reconcileOmissions?.({
      sourceId: input.sourceId, snapshotHash: envelope.snapshotHash,
      admissionVersion: input.admissionVersion, observedAt: input.observedAt,
    });

    const legacySet = new Set(input.legacyActionableExternalIds);
    const v2Set = new Set(diff.actionableExternalIds);
    const metrics: ShadowComparisonMetrics = {
      sourceId: input.sourceId,
      snapshotHash: envelope.snapshotHash,
      admissionVersion: envelope.admissionVersion,
      complete: true,
      observedAt: input.observedAt,
      durationMs: this.now().getTime() - started,
      counts: diff.counts,
      v2Actionable: sample(v2Set),
      legacyActionable: sample(legacySet),
      v2Only: sample(difference(diff.actionableExternalIds, legacySet)),
      legacyOnly: sample(difference(input.legacyActionableExternalIds, v2Set)),
      d1RowsRead: ledger.length,
      d1RowsWritten: (reuseActiveSnapshot ? 0 : rows.length + diff.omissionUpdates.length + 1) + reopened + 1,
      r2Bytes: bytes,
      status: 'complete',
    };
    await repository.putShadowComparison(metrics);

    this.log({
      event: 'ingestion_v2_shadow_comparison',
      runId: input.runId,
      sourceId: input.sourceId,
      snapshotHash: envelope.snapshotHash,
      baseline: input.baseline,
      total: diff.counts.total,
      new: diff.counts.new,
      changed: diff.counts.changed,
      stalePolicy: diff.counts.stalePolicy,
      retryable: diff.counts.retryable,
      unchanged: diff.counts.unchanged,
      reappeared: diff.counts.reappeared,
      missing: diff.counts.missing,
      admissionReopened: reopened,
      snapshotReused: reuseActiveSnapshot,
      v2ActionableCount: metrics.v2Actionable.count,
      legacyActionableCount: metrics.legacyActionable.count,
      v2OnlyCount: metrics.v2Only.count,
      legacyOnlyCount: metrics.legacyOnly.count,
      v2OnlySamples: metrics.v2Only.samples,
      legacyOnlySamples: metrics.legacyOnly.samples,
      durationMs: metrics.durationMs,
      d1RowsRead: metrics.d1RowsRead,
      d1RowsWritten: metrics.d1RowsWritten,
      r2Bytes: metrics.r2Bytes,
      status: metrics.status,
    });
    return envelope.snapshotHash;
  }
}
