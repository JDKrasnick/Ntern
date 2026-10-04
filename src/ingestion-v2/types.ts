import type { ProcessedSnapshot, SourcedPosting } from '../types.js';

/**
 * Fault-isolated ingestion V2 contracts (Stage 1).
 *
 * Everything here is provider-independent and intentionally free of I/O so the
 * diff planner can be exhaustively unit tested. The D1 and R2 implementations
 * live under `cloudflare/`.
 */

/** Bumped only when the stored normalized snapshot shape changes incompatibly. */
export const INGESTION_V2_SNAPSHOT_SCHEMA_VERSION = 2;

export type IngestionSnapshotState = 'staged' | 'active' | 'terminal' | 'expired';
/** The full row-state domain; also validated at the operations boundary. */
export const INGESTION_ROW_STATES = ['pending', 'queued', 'processing', 'settled', 'quarantined', 'absent'] as const;
export type IngestionRowState = (typeof INGESTION_ROW_STATES)[number];
export type IngestionDecision = 'admitted' | 'blocked' | 'shelved';

/** One canonical, provider-independent row of a normalized snapshot. */
export interface NormalizedSnapshotRow {
  externalId: string;
  document: string;
  row: number;
  /** Hash of the source-owned material; excludes volatile fetch metadata. */
  materialHash: string;
  /**
   * Canonical source material retained so Stage 2 admission can grade this row
   * without refetching the source board.
   */
  posting: SourcedPosting;
  /** Whether this row may ever notify on first observation (open and technical-ready). */
  firstObservationEligible: boolean;
}

/** Content-addressed normalized snapshot envelope stored in R2. */
export interface NormalizedSnapshotEnvelope {
  schemaVersion: number;
  sourceId: string;
  snapshotHash: string;
  admissionVersion: string;
  documentCount: number;
  rowCount: number;
  observedAt: string;
  rows: NormalizedSnapshotRow[];
}

export interface IngestionSnapshotRecord {
  sourceId: string;
  snapshotHash: string;
  objectKey: string;
  admissionVersion: string;
  documentCount: number;
  rowCount: number;
  state: IngestionSnapshotState;
  isComplete: boolean;
  baseline: boolean;
  createdAt: string;
  activatedAt?: string;
  terminalAt?: string;
  expiresAt?: string;
}

export interface IngestionRowRecord {
  sourceId: string;
  externalId: string;
  snapshotHash: string;
  materialHash: string;
  admissionVersion: string;
  /** Suppress notifications until this material completes its first V2 evaluation. */
  notificationBaseline?: boolean;
  state: IngestionRowState;
  decision?: IngestionDecision;
  attemptCount: number;
  retryAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  consecutiveOmissions: number;
  jobId?: string;
  failureClass?: string;
  failureDetail?: string;
  firstObservedAt: string;
  lastObservedAt: string;
  updatedAt: string;
  settledAt?: string;
}

/** The compact projection the diff planner and work selection read. */
export interface CompactIngestionRow {
  externalId: string;
  snapshotHash: string;
  materialHash: string;
  admissionVersion: string;
  state: IngestionRowState;
  decision?: IngestionDecision;
  attemptCount: number;
  retryAt?: string;
  consecutiveOmissions: number;
}

export type IngestionRowClassification =
  | 'new'
  | 'changed'
  | 'stale-policy'
  | 'retryable'
  | 'unchanged'
  | 'reappeared'
  | 'missing';

export interface SnapshotDiffRow {
  externalId: string;
  classification: IngestionRowClassification;
  materialHash: string;
  actionable: boolean;
}

export interface SnapshotOmissionUpdate {
  externalId: string;
  consecutiveOmissions: number;
  becomesAbsent: boolean;
}

export interface SnapshotDiff {
  sourceId: string;
  snapshotHash: string;
  admissionVersion: string;
  complete: boolean;
  counts: {
    total: number;
    new: number;
    changed: number;
    stalePolicy: number;
    retryable: number;
    unchanged: number;
    reappeared: number;
    missing: number;
  };
  /** Sorted external IDs the admission lane must process. */
  actionableExternalIds: string[];
  /** Ledger rows absent from this snapshot; empty for an incomplete snapshot. */
  omissionUpdates: SnapshotOmissionUpdate[];
  rows: SnapshotDiffRow[];
}

export interface DiffPlannerInput {
  sourceId: string;
  snapshotHash: string;
  admissionVersion: string;
  complete: boolean;
  now: string;
  /** Normalized snapshot rows in any order. */
  rows: ReadonlyArray<{ externalId: string; materialHash: string }>;
  /** Compact prior ledger for the same source, in any order. */
  ledger: readonly CompactIngestionRow[];
}

/** A bounded, sanitized sample of a mismatch set. */
export interface ShadowMismatchSample {
  count: number;
  samples: string[];
}

export interface ShadowComparisonMetrics {
  sourceId: string;
  snapshotHash: string;
  admissionVersion: string;
  complete: boolean;
  observedAt: string;
  durationMs: number;
  counts: SnapshotDiff['counts'];
  v2Actionable: ShadowMismatchSample;
  legacyActionable: ShadowMismatchSample;
  v2Only: ShadowMismatchSample;
  legacyOnly: ShadowMismatchSample;
  d1RowsRead: number;
  d1RowsWritten: number;
  r2Bytes: number;
  status: 'complete' | 'incomplete' | 'failed';
}

export interface IngestionV2FeatureConfig {
  shadowDiscoveryEnabled: boolean;
  /** Optional bounded rollout allowlist. Absent means every source. */
  sourceAllowlist?: readonly string[];
}

/**
 * Read the V2 feature switches from the Worker environment. Both default off so
 * a deploy that omits the bindings cannot silently enable shadow discovery.
 */
export function ingestionV2FeatureConfig(env: {
  INGESTION_V2_SHADOW_DISCOVERY_ENABLED?: string;
  INGESTION_V2_SHADOW_SOURCE_ALLOWLIST?: string;
}): IngestionV2FeatureConfig {
  const allowlist = env.INGESTION_V2_SHADOW_SOURCE_ALLOWLIST
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    shadowDiscoveryEnabled: env.INGESTION_V2_SHADOW_DISCOVERY_ENABLED === 'true',
    ...(allowlist?.length ? { sourceAllowlist: allowlist } : {}),
  };
}

/**
 * What the ingestion runner hands to shadow discovery after its fetch passed
 * the legacy quality gates. It is deliberately read-only: the hook may not
 * enqueue admission, mutate checkpoints, or touch the live catalog.
 */
export interface ShadowDiscoveryInput {
  sourceId: string;
  postings: readonly SourcedPosting[];
  processed: ProcessedSnapshot;
  snapshotHash: string;
  admissionVersion: string;
  baseline: boolean;
  observedAt: string;
  /** External IDs the legacy path will process in this delivery. */
  legacyActionableExternalIds: readonly string[];
  /** Every external ID the complete legacy snapshot considers active. */
  legacyActiveExternalIds: readonly string[];
  runId?: string;
  now: string;
}

export interface ShadowDiscoveryHook {
  /** True when this source belongs to the current bounded shadow cohort. */
  isEnabledForSource(sourceId: string): boolean;
  /**
   * Must never throw. Implementations swallow and record their own failures so
   * shadow mode can never fail or retry a legacy delivery.
   */
  discover(input: ShadowDiscoveryInput): Promise<{ completed: boolean; snapshotHash?: string } | void>;
}

/** Repository boundary for the V2 ledger; implemented by `D1IngestionV2Repository`. */
export interface IngestionV2Repository {
  putSnapshot(record: IngestionSnapshotRecord): Promise<void>;
  getSnapshot(sourceId: string, snapshotHash: string): Promise<IngestionSnapshotRecord | undefined>;
  activateSnapshot(sourceId: string, snapshotHash: string, activatedAt: string): Promise<void>;
  putRows(records: readonly IngestionRowRecord[]): Promise<void>;
  /** Apply one-complete-snapshot omission increments without rewriting bodies. */
  applyOmissions(sourceId: string, updates: readonly SnapshotOmissionUpdate[], updatedAt: string): Promise<void>;
  getRow(sourceId: string, externalId: string): Promise<IngestionRowRecord | undefined>;
  listLedger(sourceId: string): Promise<CompactIngestionRow[]>;
  listRowsPage(sourceId: string, options?: { state?: IngestionRowState; cursor?: string; limit?: number }): Promise<{ rows: IngestionRowRecord[]; cursor?: string }>;
  listDueWork(sourceId: string, now: string, limit: number): Promise<CompactIngestionRow[]>;
  listStalePolicyRows(sourceId: string, admissionVersion: string, limit: number): Promise<CompactIngestionRow[]>;
  listExpiredLeases(now: string, limit: number): Promise<IngestionRowRecord[]>;
  listRowsForSnapshot(sourceId: string, snapshotHash: string, limit: number): Promise<CompactIngestionRow[]>;
  putShadowComparison(metrics: ShadowComparisonMetrics): Promise<void>;
  listShadowComparisons(): Promise<ShadowComparisonMetrics[]>;
  getShadowComparison(sourceId: string): Promise<ShadowComparisonMetrics | undefined>;
}

/** Content-addressed object boundary for normalized snapshots. */
export interface IngestionSnapshotObjectStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  /** Writes an envelope under its content-addressed key; identical bodies are success. */
  putSnapshot(envelope: NormalizedSnapshotEnvelope): Promise<{ key: string; bytes: number; existed: boolean }>;
  /** Reads and validates an envelope by source and hash. */
  getSnapshot(sourceId: string, snapshotHash: string): Promise<NormalizedSnapshotEnvelope>;
}
