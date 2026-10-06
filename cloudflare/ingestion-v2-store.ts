import { readSnapshotRows } from '../src/ingestion-v2/stream-snapshot.js';
import type { D1Database, R2Bucket } from './types.js';
import {
  parseEnvelope,
  serializeEnvelope,
  snapshotObjectKey,
} from '../src/ingestion-v2/normalize.js';
import type { AcquireLeaseInput, AdmissionV2Ledger, MarkQueuedInput, AdmissionLeaseReleaseGuard } from '../src/ingestion-v2/admission/ledger.js';
import type { IngestionV2BootstrapReceipt } from '../src/ingestion-v2/bootstrap.js';
import type { SourceCheckpoint } from '../src/types.js';
import type {
  AdmissionFailure,
  AdmissionLeaseResult,
  AdmissionV2Handoff,
  AdmissionV2SourceOverview,
} from '../src/ingestion-v2/admission/types.js';
import type {
  CompactIngestionRow,
  IngestionDecision,
  IngestionRowRecord,
  IngestionRowState,
  IngestionSnapshotObjectStore,
  IngestionSnapshotRecord,
  IngestionSnapshotState,
  IngestionV2Repository,
  NormalizedSnapshotEnvelope,
  ShadowComparisonMetrics,
  SnapshotOmissionUpdate,
} from '../src/ingestion-v2/types.js';

const chunkSize = 50;
// D1 accepts at most 100 bound parameters. reopenRows has four fixed bindings,
// leaving room for 96 external IDs per statement.
const reopenRowsChunkSize = 96;
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

// A board snapshot hash changes when any peer row changes. Admission ownership
// therefore follows row material and policy identity; the current snapshot hash
// may advance while retry, quarantine, or lease state remains durable.
const ADMISSION_LANE_OWNED_STATES = ['pending', 'queued', 'processing', 'quarantined'] as const;
const laneOwnedSqlList = ADMISSION_LANE_OWNED_STATES.map((state) => `'${state}'`).join(', ');
const sameAdmissionIdentitySql = `ingestion_rows.material_hash = excluded.material_hash
  AND ingestion_rows.admission_version = excluded.admission_version
  AND ingestion_rows.consecutive_omissions < 2`;
const preserveAdmissionResultSql = `(ingestion_rows.state IN (${laneOwnedSqlList}) AND ${sameAdmissionIdentitySql})
  OR (ingestion_rows.state = 'settled' AND ingestion_rows.attempt_count > 0 AND ${sameAdmissionIdentitySql})`;

interface SnapshotDbRow {
  complete_fetch_sequence: number | null;
  source_id: string;
  snapshot_hash: string;
  object_key: string;
  admission_version: string;
  document_count: number;
  row_count: number;
  state: string;
  is_complete: number;
  baseline: number;
  created_at: string;
  activated_at: string | null;
  terminal_at: string | null;
  expires_at: string | null;
}

interface RowDbRow {
  complete_fetch_sequence: number | null;
  qualification_pending: number;
  qualification_observed_sequence: number | null;
  qualification_complete_snapshots: number;
  source_id: string;
  external_id: string;
  snapshot_hash: string;
  material_hash: string;
  admission_version: string;
  notification_baseline: number;
  state: string;
  decision: string | null;
  attempt_count: number;
  retry_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  consecutive_omissions: number;
  job_id: string | null;
  failure_class: string | null;
  failure_detail: string | null;
  first_observed_at: string;
  last_observed_at: string;
  updated_at: string;
  settled_at: string | null;
}

function snapshotFromRow(row: SnapshotDbRow): IngestionSnapshotRecord {
  return {
    ...(row.complete_fetch_sequence !== null ? { completeFetchSequence: row.complete_fetch_sequence } : {}),
    sourceId: row.source_id,
    snapshotHash: row.snapshot_hash,
    objectKey: row.object_key,
    admissionVersion: row.admission_version,
    documentCount: row.document_count,
    rowCount: row.row_count,
    state: row.state as IngestionSnapshotState,
    isComplete: row.is_complete === 1,
    baseline: row.baseline === 1,
    createdAt: row.created_at,
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

function rowFromDb(row: RowDbRow): IngestionRowRecord {
  return {
    ...(row.complete_fetch_sequence !== null ? { completeFetchSequence: row.complete_fetch_sequence } : {}),
    qualificationPending: row.qualification_pending === 1,
    ...(row.qualification_observed_sequence !== null ? { qualificationObservedSequence: row.qualification_observed_sequence } : {}),
    qualificationCompleteSnapshots: row.qualification_complete_snapshots,
    sourceId: row.source_id,
    externalId: row.external_id,
    snapshotHash: row.snapshot_hash,
    materialHash: row.material_hash,
    admissionVersion: row.admission_version,
    notificationBaseline: row.notification_baseline === 1,
    state: row.state as IngestionRowState,
    ...(row.decision ? { decision: row.decision as IngestionDecision } : {}),
    attemptCount: row.attempt_count,
    ...(row.retry_at ? { retryAt: row.retry_at } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    consecutiveOmissions: row.consecutive_omissions,
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.failure_class ? { failureClass: row.failure_class } : {}),
    ...(row.failure_detail ? { failureDetail: row.failure_detail } : {}),
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    updatedAt: row.updated_at,
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
  };
}

function compactFromDb(row: RowDbRow): CompactIngestionRow {
  return {
    externalId: row.external_id,
    snapshotHash: row.snapshot_hash,
    materialHash: row.material_hash,
    admissionVersion: row.admission_version,
    state: row.state as IngestionRowState,
    ...(row.decision ? { decision: row.decision as IngestionDecision } : {}),
    attemptCount: row.attempt_count,
    ...(row.retry_at ? { retryAt: row.retry_at } : {}),
    consecutiveOmissions: row.consecutive_omissions,
  };
}

const snapshotColumns = `source_id, snapshot_hash, object_key, admission_version, document_count, row_count,
  state, is_complete, baseline, created_at, activated_at, terminal_at, expires_at, complete_fetch_sequence`;

const rowColumns = `source_id, external_id, snapshot_hash, material_hash, admission_version, notification_baseline, state, decision,
  attempt_count, retry_at, lease_owner, lease_expires_at, consecutive_omissions, job_id, failure_class,
  failure_detail, first_observed_at, last_observed_at, updated_at, settled_at, complete_fetch_sequence, qualification_pending,
  qualification_observed_sequence, qualification_complete_snapshots`;

interface HandoffDbRow {
  batch_id: string;
  source_id: string;
  snapshot_hash: string;
  admission_version: string;
  baseline: number;
  external_ids: string;
  dispatched_at: string;
  acknowledged_at: string | null;
}

/** D1 implementation of the compact Ingestion V2 ledger and admission lane. */
export class D1IngestionV2Repository implements IngestionV2Repository, AdmissionV2Ledger {
  constructor(private readonly db: D1Database) {}

  async putSnapshot(record: IngestionSnapshotRecord): Promise<void> {
    await this.db.prepare(`
      INSERT INTO ingestion_snapshots (${snapshotColumns})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, snapshot_hash) DO UPDATE SET
        object_key = excluded.object_key,
        admission_version = excluded.admission_version,
        document_count = excluded.document_count,
        row_count = excluded.row_count,
        is_complete = excluded.is_complete,
        baseline = ingestion_snapshots.baseline OR excluded.baseline,
        -- A discovery upsert is staged, so keep the last durable lifecycle
        -- until activation succeeds. Explicit lifecycle records may advance a
        -- non-terminal snapshot, while terminal/expired records never regress.
        state = CASE
          WHEN ingestion_snapshots.state IN ('terminal', 'expired') THEN ingestion_snapshots.state
          WHEN excluded.state = 'staged' THEN ingestion_snapshots.state
          ELSE excluded.state
        END
    `).bind(
      record.sourceId,
      record.snapshotHash,
      record.objectKey,
      record.admissionVersion,
      record.documentCount,
      record.rowCount,
      record.state,
      record.isComplete ? 1 : 0,
      record.baseline ? 1 : 0,
      record.createdAt,
      record.activatedAt ?? null,
      record.terminalAt ?? null,
      record.expiresAt ?? null,
      record.completeFetchSequence ?? null,
    ).run();
  }

  async getSnapshot(sourceId: string, snapshotHash: string): Promise<IngestionSnapshotRecord | undefined> {
    const row = await this.db.prepare(
      `SELECT ${snapshotColumns} FROM ingestion_snapshots WHERE source_id = ? AND snapshot_hash = ?`,
    ).bind(sourceId, snapshotHash).first<SnapshotDbRow>();
    return row ? snapshotFromRow(row) : undefined;
  }

  async recordCompleteCadence(
    sourceId: string, snapshotHash: string, admissionVersion: string, sequence: number, now: string,
  ): Promise<number> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return 0;
    // Snapshot objects are immutable; complete cadence is mutable metadata.
    // Updating it must not replace a row's queue/retry/lease ownership.
    await this.db.prepare(`
      UPDATE ingestion_snapshots SET complete_fetch_sequence = ?
      WHERE source_id = ? AND snapshot_hash = ? AND admission_version = ? AND is_complete = 1
        AND (complete_fetch_sequence IS NULL OR complete_fetch_sequence < ?)
    `).bind(sequence, sourceId, snapshotHash, admissionVersion, sequence).run();
    // Observe every current row before bounded queue consumption. A delayed
    // first evaluation still receives both distinct complete cadences.
    await this.db.prepare(`
      UPDATE ingestion_rows SET
        qualification_complete_snapshots = CASE
          WHEN qualification_observed_sequence = ? - 1 THEN MIN(2, qualification_complete_snapshots + 1)
          ELSE 1 END,
        qualification_observed_sequence = ?
      WHERE source_id = ? AND snapshot_hash = ? AND admission_version = ?
        AND consecutive_omissions = 0 AND state <> 'absent'
        AND (qualification_observed_sequence IS NULL OR qualification_observed_sequence < ?)
        AND EXISTS (SELECT 1 FROM ingestion_snapshots WHERE source_id = ? AND snapshot_hash = ?
          AND admission_version = ? AND state = 'active' AND complete_fetch_sequence = ?)
    `).bind(sequence, sequence, sourceId, snapshotHash, admissionVersion, sequence,
      sourceId, snapshotHash, admissionVersion, sequence).run();
    const result = await this.db.prepare(`
      UPDATE ingestion_rows SET state = 'queued', attempt_count = 0, retry_at = NULL,
        lease_owner = NULL, lease_expires_at = NULL, effect_claimed_at = NULL,
        failure_class = NULL, failure_detail = NULL, settled_at = NULL, updated_at = ?
      WHERE rowid IN (
        SELECT rowid FROM ingestion_rows
        WHERE source_id = ? AND snapshot_hash = ? AND admission_version = ?
          AND state = 'settled' AND qualification_pending = 1 AND notification_baseline = 0
          AND consecutive_omissions = 0
          AND (complete_fetch_sequence IS NULL OR complete_fetch_sequence < ?)
      ) AND EXISTS (
        SELECT 1 FROM ingestion_snapshots WHERE source_id = ? AND snapshot_hash = ?
          AND admission_version = ? AND state = 'active' AND complete_fetch_sequence = ?
      )
    `).bind(now, sourceId, snapshotHash, admissionVersion, sequence,
      sourceId, snapshotHash, admissionVersion, sequence).run();
    return result.meta.changes;
  }

  async activateSnapshot(sourceId: string, snapshotHash: string, activatedAt: string): Promise<void> {
    const expiresAt = new Date(Date.parse(activatedAt) + SNAPSHOT_RETENTION_MS).toISOString();
    await this.db.batch([
      this.db.prepare(`
        UPDATE ingestion_snapshots
        SET state = 'active', activated_at = ?, terminal_at = NULL, expires_at = NULL
        WHERE source_id = ? AND snapshot_hash = ? AND is_complete = 1
      `).bind(activatedAt, sourceId, snapshotHash),
      this.db.prepare(`
        UPDATE ingestion_snapshots
        SET state = 'terminal', terminal_at = ?, expires_at = ?
        WHERE source_id = ? AND snapshot_hash <> ? AND state = 'active'
          AND EXISTS (
            SELECT 1 FROM ingestion_snapshots AS activated
            WHERE activated.source_id = ? AND activated.snapshot_hash = ?
              AND activated.state = 'active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM ingestion_rows
            WHERE ingestion_rows.source_id = ingestion_snapshots.source_id
              AND ingestion_rows.snapshot_hash = ingestion_snapshots.snapshot_hash
              AND ingestion_rows.state IN ('pending', 'queued', 'processing')
          )
      `).bind(activatedAt, expiresAt, sourceId, snapshotHash, sourceId, snapshotHash),
    ]);
  }

  async putRows(records: readonly IngestionRowRecord[]): Promise<void> {
    if (!records.length) return;
    const statement = this.db.prepare(`
      INSERT INTO ingestion_rows (${rowColumns})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, external_id) DO UPDATE SET
        snapshot_hash = excluded.snapshot_hash,
        material_hash = excluded.material_hash,
        complete_fetch_sequence = CASE WHEN ${sameAdmissionIdentitySql} THEN ingestion_rows.complete_fetch_sequence ELSE excluded.complete_fetch_sequence END,
        qualification_pending = CASE WHEN ${sameAdmissionIdentitySql} THEN ingestion_rows.qualification_pending ELSE excluded.qualification_pending END,
        qualification_observed_sequence = CASE WHEN ${sameAdmissionIdentitySql} THEN ingestion_rows.qualification_observed_sequence ELSE excluded.qualification_observed_sequence END,
        qualification_complete_snapshots = CASE WHEN ${sameAdmissionIdentitySql} THEN ingestion_rows.qualification_complete_snapshots ELSE excluded.qualification_complete_snapshots END,
        admission_version = excluded.admission_version,
        -- Baseline provenance belongs to the retained source/external role,
        -- even when its first successful publication needs replacement material.
        notification_baseline = ingestion_rows.notification_baseline OR excluded.notification_baseline,
        effect_claimed_at = CASE
          WHEN ${sameAdmissionIdentitySql} THEN ingestion_rows.effect_claimed_at
          ELSE NULL
        END,
        state = CASE
          WHEN ingestion_rows.state IN (${laneOwnedSqlList}) AND ${sameAdmissionIdentitySql} THEN ingestion_rows.state
          ELSE excluded.state
        END,
        decision = CASE
          WHEN ${preserveAdmissionResultSql} THEN ingestion_rows.decision
          ELSE excluded.decision
        END,
        attempt_count = CASE
          WHEN ${preserveAdmissionResultSql} THEN ingestion_rows.attempt_count
          ELSE excluded.attempt_count
        END,
        retry_at = CASE
          WHEN ingestion_rows.state IN (${laneOwnedSqlList}) AND ${sameAdmissionIdentitySql} THEN ingestion_rows.retry_at
          ELSE excluded.retry_at
        END,
        lease_owner = CASE
          WHEN ingestion_rows.state IN (${laneOwnedSqlList}) AND ${sameAdmissionIdentitySql} THEN ingestion_rows.lease_owner
          ELSE excluded.lease_owner
        END,
        lease_expires_at = CASE
          WHEN ingestion_rows.state IN (${laneOwnedSqlList}) AND ${sameAdmissionIdentitySql} THEN ingestion_rows.lease_expires_at
          ELSE excluded.lease_expires_at
        END,
        consecutive_omissions = excluded.consecutive_omissions,
        closure_pending = 0,
        job_id = COALESCE(excluded.job_id, ingestion_rows.job_id),
        failure_class = CASE
          WHEN ${preserveAdmissionResultSql} THEN ingestion_rows.failure_class
          ELSE excluded.failure_class
        END,
        failure_detail = CASE
          WHEN ${preserveAdmissionResultSql} THEN ingestion_rows.failure_detail
          ELSE excluded.failure_detail
        END,
        last_observed_at = excluded.last_observed_at,
        updated_at = excluded.updated_at,
        settled_at = CASE
          WHEN ${preserveAdmissionResultSql} THEN ingestion_rows.settled_at
          ELSE excluded.settled_at
        END
    `);
    const statements = records.map((record) => statement.bind(
      record.sourceId,
      record.externalId,
      record.snapshotHash,
      record.materialHash,
      record.admissionVersion,
      record.notificationBaseline ? 1 : 0,
      record.state,
      record.decision ?? null,
      record.attemptCount,
      record.retryAt ?? null,
      record.leaseOwner ?? null,
      record.leaseExpiresAt ?? null,
      record.consecutiveOmissions,
      record.jobId ?? null,
      record.failureClass ?? null,
      record.failureDetail ?? null,
      record.firstObservedAt,
      record.lastObservedAt,
      record.updatedAt,
      record.settledAt ?? null,
      record.completeFetchSequence ?? null,
      record.qualificationPending ? 1 : 0,
      record.qualificationObservedSequence ?? null,
      record.qualificationCompleteSnapshots ?? 0,
    ));
    for (let offset = 0; offset < statements.length; offset += chunkSize) {
      await this.db.batch(statements.slice(offset, offset + chunkSize));
    }
  }

  async applyOmissions(sourceId: string, updates: readonly SnapshotOmissionUpdate[], updatedAt: string): Promise<void> {
    if (!updates.length) return;
    // Retire missing work without erasing failure history or closure work.
    // An already-claimed effect keeps its lane until settlement and closure;
    // every other two-omission row becomes absent and rejects new claims.
    const statement = this.db.prepare(`
      UPDATE ingestion_rows SET consecutive_omissions = ?,
        state = CASE
          WHEN ? AND effect_claimed_at IS NULL THEN 'absent'
          WHEN state IN (${laneOwnedSqlList}) THEN state ELSE ? END, updated_at = ?,
        closure_pending = CASE WHEN ? THEN 1 ELSE closure_pending END
      WHERE source_id = ? AND external_id = ?
        AND last_observed_at <= ? AND updated_at <= ?
    `);
    const statements = updates.map((update) => statement.bind(
      update.consecutiveOmissions,
      update.becomesAbsent ? 1 : 0,
      update.becomesAbsent ? 'absent' : 'settled',
      updatedAt,
      update.becomesAbsent ? 1 : 0,
      sourceId,
      update.externalId,
      updatedAt,
      updatedAt,
    ));
    for (let offset = 0; offset < statements.length; offset += chunkSize) {
      await this.db.batch(statements.slice(offset, offset + chunkSize));
    }
  }

  async listPendingOmissionClosures(sourceId: string, limit: number): Promise<IngestionRowRecord[]> {
    const bounded = Math.min(25, Math.max(1, Math.floor(limit) || 25));
    const result = await this.db.prepare(`SELECT ${rowColumns} FROM ingestion_rows
      WHERE source_id = ? AND closure_pending = 1 AND effect_claimed_at IS NULL
        AND consecutive_omissions >= 2 ORDER BY external_id LIMIT ?`)
      .bind(sourceId, bounded).all<RowDbRow>();
    return result.results.map(rowFromDb);
  }

  async acknowledgeOmissionClosure(row: IngestionRowRecord): Promise<void> {
    await this.db.prepare(`UPDATE ingestion_rows SET closure_pending = 0, state = 'absent'
      WHERE source_id = ? AND external_id = ? AND snapshot_hash = ? AND material_hash = ?
        AND admission_version = ? AND updated_at = ? AND effect_claimed_at IS NULL
        AND consecutive_omissions >= 2 AND closure_pending = 1`)
      .bind(row.sourceId, row.externalId, row.snapshotHash, row.materialHash,
        row.admissionVersion, row.updatedAt).run();
  }

  async hasPendingOmissionClosures(sourceId: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 AS present FROM ingestion_rows
      WHERE source_id = ? AND closure_pending = 1 AND consecutive_omissions >= 2 LIMIT 1`)
      .bind(sourceId).first();
    return Boolean(row);
  }

  async getRow(sourceId: string, externalId: string): Promise<IngestionRowRecord | undefined> {
    const row = await this.db.prepare(
      `SELECT ${rowColumns} FROM ingestion_rows WHERE source_id = ? AND external_id = ?`,
    ).bind(sourceId, externalId).first<RowDbRow>();
    return row ? rowFromDb(row) : undefined;
  }

  async getLedgerRow(sourceId: string, externalId: string): Promise<IngestionRowRecord | undefined> {
    return this.getRow(sourceId, externalId);
  }

  async listLedger(sourceId: string): Promise<CompactIngestionRow[]> {
    const { results } = await this.db.prepare(
      `SELECT ${rowColumns} FROM ingestion_rows WHERE source_id = ? ORDER BY external_id LIMIT 100000`,
    ).bind(sourceId).all<RowDbRow>();
    return results.map(compactFromDb);
  }

  async listRowsPage(sourceId: string, options: { state?: IngestionRowState; cursor?: string; limit?: number } = {}): Promise<{ rows: IngestionRowRecord[]; cursor?: string }> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const cursor = decodeCursor(options.cursor);
    const filters = ['source_id = ?'];
    const values: unknown[] = [sourceId];
    if (options.state) {
      filters.push('state = ?');
      values.push(options.state);
    }
    if (cursor) {
      filters.push('(last_observed_at > ? OR (last_observed_at = ? AND external_id > ?))');
      values.push(cursor.lastObservedAt, cursor.lastObservedAt, cursor.externalId);
    }
    const { results } = await this.db.prepare(
      `SELECT ${rowColumns} FROM ingestion_rows WHERE ${filters.join(' AND ')}
        ORDER BY last_observed_at, external_id LIMIT ?`,
    ).bind(...values, limit + 1).all<RowDbRow>();
    const page = results.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = results.length > limit && last ? encodeCursor(last.last_observed_at, last.external_id) : undefined;
    return {
      rows: page.map(rowFromDb),
      ...(nextCursor ? { cursor: nextCursor } : {}),
    };
  }

  async listDueWork(sourceId: string, now: string, limit: number): Promise<CompactIngestionRow[]> {
    const { results } = await this.db.prepare(
      `SELECT ${rowColumns} FROM ingestion_rows
        WHERE source_id = ? AND state IN ('pending', 'queued', 'processing')
          AND consecutive_omissions < 2 AND (retry_at IS NULL OR retry_at <= ?)
        ORDER BY retry_at, external_id LIMIT ?`,
    ).bind(sourceId, now, limit).all<RowDbRow>();
    return results.map(compactFromDb);
  }

  async listStalePolicyRows(sourceId: string, admissionVersion: string, limit: number): Promise<CompactIngestionRow[]> {
    const { results } = await this.db.prepare(
      `SELECT ${rowColumns} FROM ingestion_rows
        WHERE source_id = ? AND state = 'settled' AND admission_version <> ?
        ORDER BY external_id LIMIT ?`,
    ).bind(sourceId, admissionVersion, limit).all<RowDbRow>();
    return results.map(compactFromDb);
  }

  async listExpiredLeases(now: string, limit: number): Promise<IngestionRowRecord[]> {
    const { results } = await this.db.prepare(
      `SELECT ${rowColumns} FROM ingestion_rows
        WHERE state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        ORDER BY lease_expires_at LIMIT ?`,
    ).bind(now, limit).all<RowDbRow>();
    return results.map(rowFromDb);
  }

  async listRowsForSnapshot(sourceId: string, snapshotHash: string, limit: number): Promise<CompactIngestionRow[]> {
    const { results } = await this.db.prepare(
      `SELECT ${rowColumns} FROM ingestion_rows WHERE source_id = ? AND snapshot_hash = ? ORDER BY external_id LIMIT ?`,
    ).bind(sourceId, snapshotHash, limit).all<RowDbRow>();
    return results.map(compactFromDb);
  }

  async putShadowComparison(metrics: ShadowComparisonMetrics): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.db.prepare(`
      INSERT INTO ingestion_v2_shadow_comparisons
        (source_id, snapshot_hash, admission_version, complete, metrics_json, observed_at, updated_at, run_count,
         window_started_at, window_run_count, window_d1_rows_written)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        snapshot_hash = excluded.snapshot_hash,
        admission_version = excluded.admission_version,
        complete = excluded.complete,
        metrics_json = excluded.metrics_json,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at,
        run_count = ingestion_v2_shadow_comparisons.run_count + 1,
        window_started_at = CASE
          WHEN ingestion_v2_shadow_comparisons.window_started_at IS NULL
            OR unixepoch(excluded.updated_at) - unixepoch(ingestion_v2_shadow_comparisons.window_started_at) >= 3600
          THEN excluded.updated_at ELSE ingestion_v2_shadow_comparisons.window_started_at END,
        window_run_count = CASE
          WHEN ingestion_v2_shadow_comparisons.window_started_at IS NULL
            OR unixepoch(excluded.updated_at) - unixepoch(ingestion_v2_shadow_comparisons.window_started_at) >= 3600
          THEN 1 ELSE ingestion_v2_shadow_comparisons.window_run_count + 1 END,
        window_d1_rows_written = CASE
          WHEN ingestion_v2_shadow_comparisons.window_started_at IS NULL
            OR unixepoch(excluded.updated_at) - unixepoch(ingestion_v2_shadow_comparisons.window_started_at) >= 3600
          THEN excluded.window_d1_rows_written
          ELSE ingestion_v2_shadow_comparisons.window_d1_rows_written + excluded.window_d1_rows_written END
    `).bind(
      metrics.sourceId,
      metrics.snapshotHash,
      metrics.admissionVersion,
      metrics.complete ? 1 : 0,
      JSON.stringify(metrics),
      metrics.observedAt,
      updatedAt,
      updatedAt,
      metrics.d1RowsWritten,
    ).run();
  }

  async listShadowComparisons(): Promise<ShadowComparisonMetrics[]> {
    const { results } = await this.db.prepare(
      'SELECT metrics_json FROM ingestion_v2_shadow_comparisons ORDER BY source_id',
    ).all<{ metrics_json: string }>();
    return results.map((row) => JSON.parse(row.metrics_json) as ShadowComparisonMetrics);
  }

  async getShadowComparison(sourceId: string): Promise<ShadowComparisonMetrics | undefined> {
    const row = await this.db.prepare(
      'SELECT metrics_json FROM ingestion_v2_shadow_comparisons WHERE source_id = ?',
    ).bind(sourceId).first<{ metrics_json: string }>();
    return row ? JSON.parse(row.metrics_json) as ShadowComparisonMetrics : undefined;
  }

  // --- Admission lane (Stage 2) -------------------------------------------------

  async markQueued(rows: readonly MarkQueuedInput[]): Promise<MarkQueuedInput[]> {
    const marked: MarkQueuedInput[] = [];
    const statement = this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
        effect_claimed_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state IN ('pending', 'queued')
        AND snapshot_hash = ? AND material_hash = ? AND admission_version = ?
        AND consecutive_omissions < 2
        AND (retry_at IS NULL OR retry_at <= ?)
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `);
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      const results = await this.db.batch(chunk.map((row) => statement.bind(
        row.now, row.sourceId, row.externalId,
        row.snapshotHash, row.materialHash, row.admissionVersion, row.now, row.now,
      )));
      for (let index = 0; index < chunk.length; index += 1) {
        if (results[index]?.meta.changes > 0) marked.push(chunk[index]!);
      }
    }
    return marked;
  }

  async acquireLease(input: AcquireLeaseInput): Promise<AdmissionLeaseResult> {
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'processing', lease_owner = ?, lease_expires_at = ?, effect_claimed_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ?
        AND snapshot_hash = ? AND material_hash = ? AND admission_version = ?
        AND state IN ('pending', 'queued', 'processing')
        AND consecutive_omissions < 2
        AND (retry_at IS NULL OR retry_at <= ?)
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).bind(
      input.owner, leaseExpiresAt, input.now,
      input.sourceId, input.externalId,
      input.expectedSnapshotHash, input.expectedMaterialHash, input.expectedAdmissionVersion,
      input.now,
      input.now,
    ).run();
    if (result.meta.changes > 0) {
      const row = await this.getRow(input.sourceId, input.externalId);
      return row ? { outcome: 'acquired', row } : { outcome: 'no-op', reason: 'absent' };
    }
    const row = await this.getRow(input.sourceId, input.externalId);
    if (!row) return { outcome: 'no-op', reason: 'absent' };
    if (row.state === 'settled') return { outcome: 'settled', row };
    if (row.state === 'quarantined') return { outcome: 'quarantined', row };
    if (row.state === 'processing' && row.leaseExpiresAt && row.leaseExpiresAt > input.now) {
      return { outcome: 'no-op', reason: 'leased' };
    }
    if (row.retryAt && row.retryAt > input.now) return { outcome: 'no-op', reason: 'retry-not-due' };
    return { outcome: 'no-op', reason: 'stale' };
  }

  async claimRowEffect(input: {
    sourceId: string; externalId: string; owner: string; now: string;
    expectedSnapshotHash: string; expectedMaterialHash: string; expectedAdmissionVersion: string;
    expectedNotificationBaseline?: boolean; expectedLeaseExpiresAt?: string;
  }): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET effect_claimed_at = ?, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
        AND snapshot_hash = ? AND material_hash = ? AND admission_version = ?
        AND consecutive_omissions < 2
        AND notification_baseline = COALESCE(?, notification_baseline)
        AND (? IS NULL OR lease_expires_at = ?)
    `).bind(
      input.now, input.now, input.sourceId, input.externalId, input.owner,
      input.expectedSnapshotHash, input.expectedMaterialHash, input.expectedAdmissionVersion,
      input.expectedNotificationBaseline === undefined ? null : input.expectedNotificationBaseline ? 1 : 0,
      input.expectedLeaseExpiresAt ?? null,
      input.expectedLeaseExpiresAt ?? null,
    ).run();
    return result.meta.changes > 0;
  }

  async releaseLease(sourceId: string, externalId: string, owner: string, now: string, expected?: AdmissionLeaseReleaseGuard): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, effect_claimed_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
        AND snapshot_hash = COALESCE(?, snapshot_hash)
        AND material_hash = COALESCE(?, material_hash)
        AND admission_version = COALESCE(?, admission_version)
        AND (? IS NULL OR lease_expires_at = ?)
    `).bind(now, sourceId, externalId, owner,
      expected?.expectedSnapshotHash ?? null, expected?.expectedMaterialHash ?? null,
      expected?.expectedAdmissionVersion ?? null,
      expected?.expectedLeaseExpiresAt ?? null, expected?.expectedLeaseExpiresAt ?? null).run();
    return result.meta.changes > 0;
  }

  async settleRow(input: {
    sourceId: string; externalId: string; owner: string; now: string;
    expectedSnapshotHash: string; expectedMaterialHash: string; expectedAdmissionVersion: string;
    expectedNotificationBaseline?: boolean; expectedLeaseExpiresAt?: string;
    decision: IngestionDecision; jobId?: string; reason?: string; effectClaimed?: boolean;
    completeFetchSequence?: number; qualificationPending?: boolean;
  }): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = CASE WHEN ? = 1 AND qualification_observed_sequence > COALESCE(?, 0) THEN 'queued' ELSE 'settled' END,
        decision = ?, job_id = COALESCE(?, job_id), settled_at = ?,
        attempt_count = CASE WHEN ? = 1 AND qualification_observed_sequence > COALESCE(?, 0) THEN 0 ELSE attempt_count + 1 END,
        retry_at = NULL,
        complete_fetch_sequence = ?, qualification_pending = ?,
        failure_class = ?, failure_detail = ?,
        lease_owner = NULL, lease_expires_at = NULL, effect_claimed_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
        AND snapshot_hash = ? AND material_hash = ? AND admission_version = ?
        AND (? = 0 OR effect_claimed_at IS NOT NULL)
        AND notification_baseline = COALESCE(?, notification_baseline)
        AND (? IS NULL OR lease_expires_at = ?)
    `).bind(
      input.qualificationPending ? 1 : 0, input.completeFetchSequence ?? null,
      input.decision, input.jobId ?? null, input.now,
      input.qualificationPending ? 1 : 0, input.completeFetchSequence ?? null,
      input.completeFetchSequence ?? null, input.qualificationPending ? 1 : 0,
      input.decision === 'blocked' ? 'blocked' : input.decision === 'shelved' ? 'shelved' : null,
      input.reason ?? null,
      input.now, input.sourceId, input.externalId, input.owner,
      input.expectedSnapshotHash, input.expectedMaterialHash, input.expectedAdmissionVersion, input.effectClaimed ? 1 : 0,
      input.expectedNotificationBaseline === undefined ? null : input.expectedNotificationBaseline ? 1 : 0,
      input.expectedLeaseExpiresAt ?? null,
      input.expectedLeaseExpiresAt ?? null,
    ).run();
    return result.meta.changes > 0;
  }

  async scheduleRowRetry(input: {
    sourceId: string; externalId: string; owner: string; now: string;
    expectedSnapshotHash: string; expectedMaterialHash: string; expectedAdmissionVersion: string;
    expectedNotificationBaseline?: boolean; expectedLeaseExpiresAt?: string;
    attemptCount: number; retryAt: string; failure: AdmissionFailure;
  }): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', attempt_count = ?, retry_at = ?, failure_class = ?, failure_detail = ?,
        lease_owner = NULL, lease_expires_at = NULL, effect_claimed_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
        AND snapshot_hash = ? AND material_hash = ? AND admission_version = ?
        AND notification_baseline = COALESCE(?, notification_baseline)
        AND (? IS NULL OR lease_expires_at = ?)
    `).bind(
      input.attemptCount, input.retryAt, input.failure.classification, input.failure.detail,
      input.now, input.sourceId, input.externalId, input.owner,
      input.expectedSnapshotHash, input.expectedMaterialHash, input.expectedAdmissionVersion,
      input.expectedNotificationBaseline === undefined ? null : input.expectedNotificationBaseline ? 1 : 0,
      input.expectedLeaseExpiresAt ?? null, input.expectedLeaseExpiresAt ?? null,
    ).run();
    return result.meta.changes > 0;
  }

  async quarantineRow(input: {
    sourceId: string; externalId: string; owner: string; now: string;
    expectedSnapshotHash: string; expectedMaterialHash: string; expectedAdmissionVersion: string;
    expectedNotificationBaseline?: boolean; expectedLeaseExpiresAt?: string;
    attemptCount: number; failure: AdmissionFailure;
  }): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'quarantined', attempt_count = ?, retry_at = NULL, failure_class = ?, failure_detail = ?,
        lease_owner = NULL, lease_expires_at = NULL, effect_claimed_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
        AND snapshot_hash = ? AND material_hash = ? AND admission_version = ?
        AND notification_baseline = COALESCE(?, notification_baseline)
        AND (? IS NULL OR lease_expires_at = ?)
    `).bind(
      input.attemptCount, input.failure.classification, input.failure.detail,
      input.now, input.sourceId, input.externalId, input.owner,
      input.expectedSnapshotHash, input.expectedMaterialHash, input.expectedAdmissionVersion,
      input.expectedNotificationBaseline === undefined ? null : input.expectedNotificationBaseline ? 1 : 0,
      input.expectedLeaseExpiresAt ?? null, input.expectedLeaseExpiresAt ?? null,
    ).run();
    return result.meta.changes > 0;
  }

  async reopenRows(sourceId: string, externalIds: readonly string[], now: string, options: {
    admissionVersion?: string;
    notificationBaseline?: boolean;
  } = {}): Promise<number> {
    const ids = [...new Set(externalIds)];
    if (!ids.length) return 0;
    let changed = 0;
    for (let offset = 0; offset < ids.length; offset += reopenRowsChunkSize) {
      const chunk = ids.slice(offset, offset + reopenRowsChunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.db.prepare(`
        UPDATE ingestion_rows
        SET state = 'queued', attempt_count = 0, retry_at = NULL,
        lease_owner = NULL, lease_expires_at = NULL, effect_claimed_at = NULL,
          failure_class = NULL, failure_detail = NULL, settled_at = NULL, decision = NULL,
          admission_version = COALESCE(?, admission_version),
          notification_baseline = COALESCE(?, notification_baseline), updated_at = ?
        WHERE source_id = ? AND external_id IN (${placeholders}) AND state IN ('settled', 'quarantined', 'absent')
      `).bind(
        options.admissionVersion ?? null,
        options.notificationBaseline === undefined ? null : options.notificationBaseline ? 1 : 0,
        now, sourceId, ...chunk,
      ).run();
      changed += result.meta.changes;
    }
    return changed;
  }

  async reopenUnprocessedRows(
    sourceId: string,
    snapshotHash: string,
    admissionVersion: string,
    now: string,
    limit: number,
  ): Promise<number> {
    const bounded = Math.max(1, Math.min(limit, 500));
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
        effect_claimed_at = NULL,
        failure_class = NULL, failure_detail = NULL, settled_at = NULL, decision = NULL, updated_at = ?
      WHERE rowid IN (
        SELECT rowid FROM ingestion_rows
        WHERE source_id = ? AND snapshot_hash = ? AND admission_version = ?
          AND state = 'settled' AND attempt_count = 0
        ORDER BY external_id LIMIT ?
      )
    `).bind(now, sourceId, snapshotHash, admissionVersion, bounded).run();
    return result.meta.changes;
  }

  async reclaimExpiredLeases(now: string, limit: number): Promise<IngestionRowRecord[]> {
    const expired = await this.listExpiredLeases(now, limit);
    if (!expired.length) return [];
    const statement = this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
        effect_claimed_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing'
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `);
    const statements = expired.map((row) => statement.bind(now, row.sourceId, row.externalId, now));
    await this.batch(statements);
    return expired;
  }

  async listDispatchableRows(sourceId: string, now: string, limit: number): Promise<IngestionRowRecord[]> {
    const bounded = Math.max(1, Math.min(limit, 1000));
    const { results } = await this.db.prepare(`
      SELECT ${rowColumns} FROM ingestion_rows
      WHERE source_id = ? AND consecutive_omissions < 2 AND (
        (state IN ('pending', 'queued') AND (retry_at IS NULL OR retry_at <= ?))
        OR (state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
      ORDER BY COALESCE(retry_at, updated_at), external_id LIMIT ?
    `).bind(sourceId, now, now, bounded).all<RowDbRow>();
    return results.map(rowFromDb);
  }

  async listRowsByState(sourceId: string, state: IngestionRowState, limit: number): Promise<IngestionRowRecord[]> {
    const bounded = Math.max(1, Math.min(limit, 1000));
    const { results } = await this.db.prepare(`
      SELECT ${rowColumns} FROM ingestion_rows
      WHERE source_id = ? AND state = ? ORDER BY external_id LIMIT ?
    `).bind(sourceId, state, bounded).all<RowDbRow>();
    return results.map(rowFromDb);
  }

  async recordHandoff(handoff: AdmissionV2Handoff): Promise<void> {
    await this.db.prepare(`
      INSERT INTO ingestion_admission_handoffs
        (batch_id, source_id, snapshot_hash, admission_version, baseline, external_ids, dispatched_at, acknowledged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO NOTHING
    `).bind(
      handoff.batchId, handoff.sourceId, handoff.snapshotHash, handoff.admissionVersion,
      handoff.baseline ? 1 : 0, JSON.stringify(handoff.externalIds), handoff.dispatchedAt,
      handoff.acknowledgedAt ?? null,
    ).run();
  }

  async acknowledgeHandoff(batchId: string, now: string): Promise<void> {
    const expiresAt = new Date(Date.parse(now) + SNAPSHOT_RETENTION_MS).toISOString();
    await this.db.batch([
      this.db.prepare(
        'UPDATE ingestion_admission_handoffs SET acknowledged_at = ? WHERE batch_id = ? AND acknowledged_at IS NULL',
      ).bind(now, batchId),
      // An older active snapshot can stay retained while one of its rows retries.
      // Re-check lifecycle at each completed handoff so it becomes terminal as
      // soon as no pending, queued, or processing row still needs the object.
      this.db.prepare(`
        UPDATE ingestion_snapshots
        SET state = 'terminal', terminal_at = ?, expires_at = ?
        WHERE source_id = (
            SELECT source_id FROM ingestion_admission_handoffs WHERE batch_id = ?
          )
          AND state = 'active'
          AND snapshot_hash <> (
            SELECT snapshot_hash FROM ingestion_snapshots AS current
            WHERE current.source_id = ingestion_snapshots.source_id AND current.state = 'active'
            ORDER BY activated_at DESC, snapshot_hash DESC LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM ingestion_rows
            WHERE ingestion_rows.source_id = ingestion_snapshots.source_id
              AND ingestion_rows.snapshot_hash = ingestion_snapshots.snapshot_hash
              AND ingestion_rows.state IN ('pending', 'queued', 'processing')
          )
      `).bind(now, expiresAt, batchId),
    ]);
  }

  async listActiveHandoffs(sourceId: string, staleBefore: string): Promise<AdmissionV2Handoff[]> {
    const { results } = await this.db.prepare(`
      SELECT batch_id, source_id, snapshot_hash, admission_version, baseline, external_ids, dispatched_at, acknowledged_at
      FROM ingestion_admission_handoffs
      WHERE source_id = ? AND acknowledged_at IS NULL AND dispatched_at > ?
      ORDER BY dispatched_at LIMIT 200
    `).bind(sourceId, staleBefore).all<HandoffDbRow>();
    return results.map((row) => ({
      batchId: row.batch_id,
      sourceId: row.source_id,
      snapshotHash: row.snapshot_hash,
      admissionVersion: row.admission_version,
      externalIds: JSON.parse(row.external_ids) as string[],
      baseline: row.baseline === 1,
      dispatchedAt: row.dispatched_at,
      ...(row.acknowledged_at ? { acknowledgedAt: row.acknowledged_at } : {}),
    }));
  }

  async listActiveSourceIds(limit: number, afterSourceId?: string): Promise<string[]> {
    const bounded = Math.max(1, Math.min(limit, 500));
    const { results } = await this.db.prepare(`
      SELECT DISTINCT source_id FROM ingestion_snapshots
      WHERE state = 'active' AND (? IS NULL OR source_id > ?) ORDER BY source_id LIMIT ?
    `).bind(afterSourceId ?? null, afterSourceId ?? null, bounded).all<{ source_id: string }>();
    return results.map((row) => row.source_id);
  }

  async getDispatchSourceCursor(): Promise<string | undefined> {
    const row = await this.db.prepare(
      "SELECT source_cursor FROM ingestion_v2_dispatch_state WHERE singleton = 1",
    ).first<{ source_cursor: string | null }>();
    return row?.source_cursor ?? undefined;
  }

  async setDispatchSourceCursor(sourceId: string | undefined, updatedAt: string): Promise<void> {
    await this.db.prepare(`
      INSERT INTO ingestion_v2_dispatch_state (singleton, source_cursor, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET source_cursor = excluded.source_cursor, updated_at = excluded.updated_at
    `).bind(sourceId ?? null, updatedAt).run();
  }

  async overview(sourceId: string): Promise<AdmissionV2SourceOverview> {
    const counts: AdmissionV2SourceOverview = {
      sourceId, pending: 0, queued: 0, processing: 0, settled: 0, quarantined: 0, absent: 0,
    };
    const { results } = await this.db.prepare(`
      SELECT state, COUNT(*) AS state_count, MIN(COALESCE(retry_at, updated_at)) AS oldest
      FROM ingestion_rows WHERE source_id = ? GROUP BY state
    `).bind(sourceId).all<{ state: IngestionRowState; state_count: number; oldest: string | null }>();
    let oldestWorkAt: string | undefined;
    for (const row of results) {
      counts[row.state] = row.state_count;
      if ((row.state === 'pending' || row.state === 'queued' || row.state === 'processing') && row.oldest) {
        if (!oldestWorkAt || row.oldest < oldestWorkAt) oldestWorkAt = row.oldest;
      }
    }
    const active = await this.db.prepare(`
      SELECT snapshot_hash FROM ingestion_snapshots
      WHERE source_id = ? AND state = 'active' ORDER BY activated_at DESC LIMIT 1
    `).bind(sourceId).first<{ snapshot_hash: string }>();
    const verification = await this.db.prepare(`
      SELECT COUNT(*) AS decisions, COALESCE(SUM(notify), 0) AS notifications
      FROM ingestion_v2_admission_decisions WHERE source_id = ?
    `).bind(sourceId).first<{ decisions: number; notifications: number }>();
    return {
      ...counts,
      verificationDecisions: verification?.decisions ?? 0,
      notificationEligibleDecisions: verification?.notifications ?? 0,
      ...(oldestWorkAt ? { oldestWorkAt } : {}),
      ...(active ? { currentSnapshotHash: active.snapshot_hash } : {}),
    };
  }

  async getBootstrapReceipt(
    sourceId: string,
    snapshotHash: string,
    admissionVersion: string,
  ): Promise<IngestionV2BootstrapReceipt | undefined> {
    const row = await this.db.prepare(`
      SELECT receipt_json FROM ingestion_v2_bootstrap_receipts
      WHERE source_id = ? AND snapshot_hash = ? AND admission_version = ?
    `).bind(sourceId, snapshotHash, admissionVersion).first<{ receipt_json: string }>();
    return row ? JSON.parse(row.receipt_json) as IngestionV2BootstrapReceipt : undefined;
  }

  /**
   * Atomically fence every row in the active snapshot as a silent baseline,
   * retire the legacy migration cursor, and write the immutable operator
   * receipt. Every statement repeats the active-snapshot predicate, so a
   * concurrent discovery activation makes the batch a no-op instead of mixing
   * two snapshots.
   */
  async applyBootstrap(input: {
    sourceId: string;
    snapshotHash: string;
    admissionVersion: string;
    activeRows: number;
    actionableRows: number;
    checkpoint: SourceCheckpoint;
    actor: string;
    appliedAt: string;
    receipt: IngestionV2BootstrapReceipt;
  }): Promise<IngestionV2BootstrapReceipt> {
    const activeSnapshotGuard = `EXISTS (
      SELECT 1 FROM ingestion_snapshots
      WHERE source_id = ? AND snapshot_hash = ? AND admission_version = ?
        AND state = 'active' AND is_complete = 1 AND row_count = ?
    ) AND (
      SELECT COUNT(*) FROM ingestion_rows WHERE source_id = ? AND snapshot_hash = ?
    ) = ? AND NOT EXISTS (
      SELECT 1 FROM ingestion_rows
      WHERE source_id = ? AND snapshot_hash = ? AND state IN ('queued', 'processing')
    )`;
    const guardValues = [
      input.sourceId,
      input.snapshotHash,
      input.admissionVersion,
      input.activeRows,
      input.sourceId,
      input.snapshotHash,
      input.activeRows,
      input.sourceId,
      input.snapshotHash,
    ] as const;
    await this.db.batch([
      this.db.prepare(`
        UPDATE ingestion_rows SET
          state = 'pending', decision = NULL, attempt_count = 0, retry_at = NULL,
          lease_owner = NULL, lease_expires_at = NULL,
          failure_class = NULL, failure_detail = NULL, settled_at = NULL,
          notification_baseline = 1, effect_claimed_at = NULL,
          admission_version = ?, updated_at = ?
        WHERE source_id = ? AND snapshot_hash = ? AND ${activeSnapshotGuard}
      `).bind(
        input.admissionVersion,
        input.appliedAt,
        input.sourceId,
        input.snapshotHash,
        ...guardValues,
      ),
      this.db.prepare(`
        INSERT INTO catalog_items (pk, sk, kind, value)
        SELECT ?, 'CHECKPOINT', 'checkpoint', ? WHERE ${activeSnapshotGuard}
        ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value
      `).bind(
        `SOURCE#${input.sourceId}`,
        JSON.stringify(input.checkpoint),
        ...guardValues,
      ),
      this.db.prepare(`
        INSERT OR IGNORE INTO ingestion_v2_bootstrap_receipts
          (source_id, snapshot_hash, admission_version, active_rows, actionable_rows,
           checkpoint_json, actor, applied_at, receipt_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${activeSnapshotGuard}
      `).bind(
        input.sourceId,
        input.snapshotHash,
        input.admissionVersion,
        input.activeRows,
        input.actionableRows,
        JSON.stringify(input.checkpoint),
        input.actor,
        input.appliedAt,
        JSON.stringify(input.receipt),
        ...guardValues,
      ),
    ]);
    const receipt = await this.getBootstrapReceipt(input.sourceId, input.snapshotHash, input.admissionVersion);
    if (!receipt) throw new Error('Bootstrap active snapshot drifted during apply');
    return receipt;
  }

  private async batch(statements: ReturnType<D1Database['prepare']>[]): Promise<void> {
    for (let offset = 0; offset < statements.length; offset += chunkSize) {
      await this.db.batch(statements.slice(offset, offset + chunkSize));
    }
  }
}

function encodeCursor(lastObservedAt: string, externalId: string): string {
  return `${lastObservedAt}\u0000${externalId}`;
}

function decodeCursor(cursor: string | undefined): { lastObservedAt: string; externalId: string } | undefined {
  if (!cursor) return undefined;
  const index = cursor.indexOf('\u0000');
  if (index <= 0) return undefined;
  return { lastObservedAt: cursor.slice(0, index), externalId: cursor.slice(index + 1) };
}

/** R2-backed, content-addressed normalized snapshot store. */
export class R2IngestionSnapshotStore implements IngestionSnapshotObjectStore {
  private readonly encoder = new TextEncoder();

  constructor(private readonly bucket: R2Bucket) {}

  put(key: string, body: string): Promise<void> {
    const bytes = this.encoder.encode(body);
    return this.bucket.put(key, bytes.buffer as ArrayBuffer).then(() => undefined);
  }

  async get(key: string): Promise<string | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return new Response(object.body).text();
  }

  delete(key: string): Promise<void> {
    return this.bucket.delete(key);
  }

  /**
   * Write a normalized snapshot before its D1 record is inserted. An existing
   * identical object is success; a different body at the same content-addressed
   * key is refused so a hash collision or corruption can never overwrite it.
   */
  async putSnapshot(envelope: NormalizedSnapshotEnvelope): Promise<{ key: string; bytes: number; existed: boolean }> {
    const key = snapshotObjectKey(envelope.sourceId, envelope.snapshotHash);
    const existing = await this.bucket.get(key);
    if (existing !== null) {
      // The key is the content hash, so an existing object can only differ in
      // volatile fetch metadata. Validate it and keep the original bytes rather
      // than rewriting; a corrupt or mismatched body fails closed.
      const validated = await readSnapshotRows(existing.body, { sourceId: envelope.sourceId, snapshotHash: envelope.snapshotHash }, []);
      return { key, bytes: validated.bytes, existed: true };
    }
    const body = serializeEnvelope(envelope);
    const bytes = this.encoder.encode(body);
    await this.bucket.put(key, bytes.buffer as ArrayBuffer);
    return { key, bytes: bytes.byteLength, existed: false };
  }

  async getSnapshot(sourceId: string, snapshotHash: string): Promise<NormalizedSnapshotEnvelope> {
    const key = snapshotObjectKey(sourceId, snapshotHash);
    const raw = await this.get(key);
    if (raw === null) throw new Error(`Ingestion snapshot object missing at ${key}`);
    return parseEnvelope(raw, { sourceId, snapshotHash });
  }

  async getSnapshotRows(sourceId: string, snapshotHash: string, externalIds: readonly string[]) {
    const key = snapshotObjectKey(sourceId, snapshotHash);
    const object = await this.bucket.get(key);
    if (!object) throw new Error(`Ingestion snapshot object missing at ${key}`);
    return (await readSnapshotRows(object.body, { sourceId, snapshotHash }, externalIds)).rows;
  }
}
