import { ingestionV2FeatureConfig, type IngestionDecision, type IngestionRowRecord, type IngestionRowState } from '../types.js';
import type { SourcedPosting } from '../../types.js';

/**
 * Fault-isolated ingestion V2 admission contracts (Stage 2).
 *
 * Everything here is provider-independent and free of I/O so the message
 * contract, failure taxonomy, and row state machine can be exhaustively unit
 * tested. The D1 implementation lives under `cloudflare/`.
 */

/** Bumped only when the admission message shape changes incompatibly. */
export const ADMISSION_V2_MESSAGE_VERSION = 1;

/** At most 25 external IDs per application message. */
export const ADMISSION_V2_MAX_EXTERNAL_IDS = 25;

/** Initial attempt plus two row-local retries, then quarantine. */
export const ADMISSION_V2_MAX_ATTEMPTS = 3;

/**
 * Row-local retry delays indexed by the attempt that already failed:
 * retry 1 after the initial failure, retry 2 after the first retry.
 */
export const ADMISSION_V2_RETRY_DELAYS_MS = [60_000, 300_000] as const;

/** A row lease shorter than the delivered work is a duplicate-processing risk. */
export const ADMISSION_V2_LEASE_MS = 120_000;

/** The versioned admission message. Carries references and IDs, not bodies. */
export interface AdmissionV2Message {
  version: typeof ADMISSION_V2_MESSAGE_VERSION;
  batchId: string;
  sourceId: string;
  snapshotHash: string;
  snapshotKey: string;
  admissionVersion: string;
  externalIds: string[];
  baseline: boolean;
}

export type AdmissionMessageValidation =
  | { ok: true; message: AdmissionV2Message }
  | { ok: false; reason: string };

/** Terminal business decisions settle the row and acknowledge the message. */
export type AdmissionTerminalDecision =
  | { kind: 'admitted'; jobId?: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'shelved'; reason: string };

/** Sanitized failure classes. Never carry response bodies or secrets. */
export type AdmissionRowFailureClass =
  | 'destination-timeout'
  | 'destination-rate-limited'
  | 'upstream-server-error'
  | 'evidence-acquisition'
  | 'row-evaluation';

export type AdmissionInfrastructureFailureClass =
  | 'd1-unavailable'
  | 'queue-send'
  | 'resource-exhaustion'
  | 'missing-binding'
  | 'schema-defect'
  | 'snapshot-missing'
  | 'snapshot-corrupt'
  | 'snapshot-incomplete'
  | 'internal';

export type AdmissionFailureKind = 'row-transient' | 'infrastructure';

export interface AdmissionFailure {
  kind: AdmissionFailureKind;
  classification: AdmissionRowFailureClass | AdmissionInfrastructureFailureClass;
  /** Bounded, sanitized detail. Never a raw response body. */
  detail: string;
  /** Provider-requested minimum wait, retained in the durable retry timestamp. */
  retryAfterMs?: number;
  /** No destination request occurred: wait without spending a row attempt. */
  retryWithoutAttempt?: boolean;
}

/** The evaluator's result for one row. Throws for failures; returns this to settle. */
export interface AdmissionRowEvaluation {
  completeFetchSequence?: number;
  qualificationPending?: boolean;
  decision: AdmissionTerminalDecision;
  /** Optional catalog identity recorded on the ledger row. */
  jobId?: string;
  /**
   * Deferred idempotent catalog/notification effect. The consumer invokes it
   * only after atomically claiming the evaluated row identity in D1.
   */
  commitEffect?: () => Promise<void>;
}

/** Context handed to a row evaluator for one message. */
export interface AdmissionRowContext {
  completeFetchSequence?: number;
  qualificationCompleteSnapshots?: number;
  sourceId: string;
  externalId: string;
  snapshotHash: string;
  admissionVersion: string;
  baseline: boolean;
  /** The ledger row being processed. */
  row: IngestionRowRecord;
  /** The normalized source material retained by the snapshot. */
  posting: SourcedPosting;
  /**
   * Whether this row may ever notify on first observation. Copied from the
   * normalized snapshot row so the evaluator can enforce notification fencing
   * without re-deriving it from the posting.
   */
  firstObservationEligible?: boolean;
}

export interface AdmissionV2RowEvaluator {
  /**
   * Grade one row and return any terminal effect as a deferred idempotent
   * callback. Resolve with a terminal decision, or reject with an
   * `AdmissionRowTransientError` / `AdmissionInfrastructureError`.
   */
  evaluate(context: AdmissionRowContext): Promise<AdmissionRowEvaluation>;
}

/** A durable receipt that a dispatcher handed a message to the queue. */
export interface AdmissionV2Handoff {
  batchId: string;
  sourceId: string;
  snapshotHash: string;
  admissionVersion: string;
  externalIds: string[];
  baseline: boolean;
  dispatchedAt: string;
  /** Set when the message is acknowledged (all rows independently settled). */
  acknowledgedAt?: string;
}

export interface AdmissionV2SourceOverview {
  sourceId: string;
  pending: number;
  queued: number;
  processing: number;
  settled: number;
  quarantined: number;
  absent: number;
  verificationDecisions?: number;
  notificationEligibleDecisions?: number;
  oldestWorkAt?: string;
  currentSnapshotHash?: string;
}

/** A plannable unit of dispatch work: rows that need a fresh admission message. */
export interface AdmissionV2DispatchPlan {
  sourceId: string;
  snapshotHash: string;
  snapshotKey: string;
  admissionVersion: string;
  baseline: boolean;
  messages: AdmissionV2Message[];
  /** Present only when no messages were produced. */
  skipped?: 'disabled' | 'no-work' | 'no-active-snapshot';
}

/** Repository operations the admission lane needs beyond the Stage 1 ledger. */
export type AdmissionLeaseResult =
  | { outcome: 'acquired'; row: IngestionRowRecord }
  | { outcome: 'settled'; row: IngestionRowRecord }
  | { outcome: 'quarantined'; row: IngestionRowRecord }
  | { outcome: 'no-op'; reason: 'absent' | 'stale' | 'leased' | 'retry-not-due' };

export type AdmissionRowOutcome =
  | { kind: 'settled'; decision: IngestionDecision; reason?: string; jobId?: string }
  | { kind: 'retry'; attemptCount: number; retryAt: string; failure: AdmissionFailure }
  | { kind: 'quarantined'; attemptCount: number; failure: AdmissionFailure }
  | { kind: 'infrastructure'; failure: AdmissionFailure };

export interface AdmissionV2FeatureConfig {
  admissionEnabled: boolean;
  /** Optional bounded rollout allowlist. Absent means every source. */
  sourceAllowlist?: readonly string[];
  /** Stage 3 live catalog effects remain independently default-off. */
  catalogWriterEnabled: boolean;
  /** Explicit sources allowed to use the live reconciler-backed writer. */
  catalogWriterSourceAllowlist?: readonly string[];
  /** Explicit sources whose legacy catalog writer is disabled after bootstrap. */
  legacyCatalogWriteDisabledSourceAllowlist?: readonly string[];
  /** Stage 3 sources allowed to emit trusted-community new-role alerts. */
  trustedCommunityAlertSourceAllowlist?: readonly string[];
}

/**
 * Read the admission feature switches from the Worker environment. Both default
 * off so a deploy that omits the bindings cannot silently enable V2 admission.
 */
export function admissionV2FeatureConfig(env: {
  INGESTION_V2_ADMISSION_ENABLED?: string;
  INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_CATALOG_WRITER_ENABLED?: string;
  INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST?: string;
}): AdmissionV2FeatureConfig {
  const allowlist = env.INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const catalogWriterAllowlist = env.INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const legacyCatalogWriteDisabledAllowlist = env.INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const trustedCommunityAlertAllowlist = env.INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    admissionEnabled: env.INGESTION_V2_ADMISSION_ENABLED === 'true',
    ...(allowlist?.length ? { sourceAllowlist: allowlist } : {}),
    catalogWriterEnabled: env.INGESTION_V2_CATALOG_WRITER_ENABLED === 'true',
    ...(catalogWriterAllowlist?.length ? { catalogWriterSourceAllowlist: catalogWriterAllowlist } : {}),
    ...(legacyCatalogWriteDisabledAllowlist?.length
      ? { legacyCatalogWriteDisabledSourceAllowlist: legacyCatalogWriteDisabledAllowlist }
      : {}),
    ...(trustedCommunityAlertAllowlist?.length
      ? { trustedCommunityAlertSourceAllowlist: trustedCommunityAlertAllowlist }
      : {}),
  };
}

/** Trusted-community alerts are a fourth explicit source gate after ownership. */
export function admissionV2TrustedCommunityAlertsAllowed(env: Parameters<typeof admissionV2OwnsCatalogWrites>[0] & {
  INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST?: string;
}, sourceId: string): boolean {
  const config = admissionV2FeatureConfig(env);
  return admissionV2OwnsCatalogWrites(env, sourceId)
    && config.trustedCommunityAlertSourceAllowlist?.includes(sourceId) === true;
}

/**
 * Legacy ownership can move only after the complete V2 lane is enabled for the
 * same explicit source. The third allowlist is an independent rollback switch.
 */
export function admissionV2OwnsCatalogWrites(env: {
  INGESTION_V2_SHADOW_DISCOVERY_ENABLED?: string;
  INGESTION_V2_SHADOW_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_ADMISSION_ENABLED?: string;
  INGESTION_V2_ADMISSION_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_CATALOG_WRITER_ENABLED?: string;
  INGESTION_V2_CATALOG_WRITER_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_LEGACY_CATALOG_WRITE_DISABLED_SOURCE_ALLOWLIST?: string;
  INGESTION_V2_TRUSTED_COMMUNITY_ALERT_SOURCE_ALLOWLIST?: string;
}, sourceId: string): boolean {
  const shadow = ingestionV2FeatureConfig(env);
  const config = admissionV2FeatureConfig(env);
  return shadow.shadowDiscoveryEnabled
    && shadow.sourceAllowlist?.includes(sourceId) === true
    && config.admissionEnabled
    && config.sourceAllowlist?.includes(sourceId) === true
    && config.catalogWriterEnabled
    && config.catalogWriterSourceAllowlist?.includes(sourceId) === true
    && config.legacyCatalogWriteDisabledSourceAllowlist?.includes(sourceId) === true;
}

/** Live effects require both the global Stage 3 switch and an explicit source allowlist. */
/** A guarded, idempotent replay request from the operations surface. */
export interface AdmissionReplayRequest {
  sourceId: string;
  externalId: string;
}

export interface AdmissionReplayPreview {
  sourceId: string;
  externalId: string;
  eligible: boolean;
  reason?: string;
  state?: IngestionRowState;
  attemptCount?: number;
  snapshotHash?: string;
  materialHash?: string;
  admissionVersion?: string;
  expectedTransition?: string;
}

/** Rows whose latest snapshot is retained and whose state permits reactivation. */
export interface AdmissionReopenCandidate {
  sourceId: string;
  externalId: string;
  snapshotHash: string;
}
