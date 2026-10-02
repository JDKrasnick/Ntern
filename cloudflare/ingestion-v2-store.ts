import type { D1Database, R2Bucket } from './types.js';
import {
  parseEnvelope,
  serializeEnvelope,
  snapshotObjectKey,
} from '../src/ingestion-v2/normalize.js';
import type { AcquireLeaseInput, AdmissionV2Ledger, MarkQueuedInput } from '../src/ingestion-v2/admission/ledger.js';
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

interface SnapshotDbRow {
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
  source_id: string;
  external_id: string;
  snapshot_hash: string;
  material_hash: string;
  admission_version: string;
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
    sourceId: row.source_id,
    externalId: row.external_id,
    snapshotHash: row.snapshot_hash,
    materialHash: row.material_hash,
    admissionVersion: row.admission_version,
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
  state, is_complete, baseline, created_at, activated_at, terminal_at, expires_at`;

const rowColumns = `source_id, external_id, snapshot_hash, material_hash, admission_version, state, decision,
  attempt_count, retry_at, lease_owner, lease_expires_at, consecutive_omissions, job_id, failure_class,
  failure_detail, first_observed_at, last_observed_at, updated_at, settled_at`;

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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, snapshot_hash) DO UPDATE SET
        object_key = excluded.object_key,
        admission_version = excluded.admission_version,
        document_count = excluded.document_count,
        row_count = excluded.row_count,
        is_complete = excluded.is_complete,
        baseline = ingestion_snapshots.baseline OR excluded.baseline,
        state = CASE
          WHEN ingestion_snapshots.state IN ('terminal', 'expired') THEN ingestion_snapshots.state
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
    ).run();
  }

  async getSnapshot(sourceId: string, snapshotHash: string): Promise<IngestionSnapshotRecord | undefined> {
    const row = await this.db.prepare(
      `SELECT ${snapshotColumns} FROM ingestion_snapshots WHERE source_id = ? AND snapshot_hash = ?`,
    ).bind(sourceId, snapshotHash).first<SnapshotDbRow>();
    return row ? snapshotFromRow(row) : undefined;
  }

  async activateSnapshot(sourceId: string, snapshotHash: string, activatedAt: string): Promise<void> {
    await this.db.prepare(`
      UPDATE ingestion_snapshots SET state = 'active', activated_at = ?
      WHERE source_id = ? AND snapshot_hash = ? AND state = 'staged'
    `).bind(activatedAt, sourceId, snapshotHash).run();
  }

  async putRows(records: readonly IngestionRowRecord[]): Promise<void> {
    if (!records.length) return;
    const statement = this.db.prepare(`
      INSERT INTO ingestion_rows (${rowColumns})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, external_id) DO UPDATE SET
        snapshot_hash = excluded.snapshot_hash,
        material_hash = excluded.material_hash,
        admission_version = excluded.admission_version,
        state = excluded.state,
        decision = COALESCE(excluded.decision, ingestion_rows.decision),
        attempt_count = excluded.attempt_count,
        retry_at = excluded.retry_at,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        consecutive_omissions = excluded.consecutive_omissions,
        job_id = COALESCE(excluded.job_id, ingestion_rows.job_id),
        failure_class = excluded.failure_class,
        failure_detail = excluded.failure_detail,
        last_observed_at = excluded.last_observed_at,
        updated_at = excluded.updated_at,
        settled_at = COALESCE(excluded.settled_at, ingestion_rows.settled_at)
    `);
    const statements = records.map((record) => statement.bind(
      record.sourceId,
      record.externalId,
      record.snapshotHash,
      record.materialHash,
      record.admissionVersion,
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
    ));
    for (let offset = 0; offset < statements.length; offset += chunkSize) {
      await this.db.batch(statements.slice(offset, offset + chunkSize));
    }
  }

  async applyOmissions(sourceId: string, updates: readonly SnapshotOmissionUpdate[], updatedAt: string): Promise<void> {
    if (!updates.length) return;
    const statement = this.db.prepare(`
      UPDATE ingestion_rows SET consecutive_omissions = ?, state = ?, updated_at = ?
      WHERE source_id = ? AND external_id = ?
    `);
    const statements = updates.map((update) => statement.bind(
      update.consecutiveOmissions,
      update.becomesAbsent ? 'absent' : 'settled',
      updatedAt,
      sourceId,
      update.externalId,
    ));
    for (let offset = 0; offset < statements.length; offset += chunkSize) {
      await this.db.batch(statements.slice(offset, offset + chunkSize));
    }
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
        WHERE source_id = ? AND state IN ('pending', 'queued', 'processing') AND (retry_at IS NULL OR retry_at <= ?)
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

  async listRowsForSnapshot(snapshotHash: string, limit: number): Promise<CompactIngestionRow[]> {
    const { results } = await this.db.prepare(
      `SELECT ${rowColumns} FROM ingestion_rows WHERE snapshot_hash = ? ORDER BY external_id LIMIT ?`,
    ).bind(snapshotHash, limit).all<RowDbRow>();
    return results.map(compactFromDb);
  }

  async putShadowComparison(metrics: ShadowComparisonMetrics): Promise<void> {
    await this.db.prepare(`
      INSERT INTO ingestion_v2_shadow_comparisons
        (source_id, snapshot_hash, admission_version, complete, metrics_json, observed_at, updated_at, run_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(source_id) DO UPDATE SET
        snapshot_hash = excluded.snapshot_hash,
        admission_version = excluded.admission_version,
        complete = excluded.complete,
        metrics_json = excluded.metrics_json,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at,
        run_count = ingestion_v2_shadow_comparisons.run_count + 1
    `).bind(
      metrics.sourceId,
      metrics.snapshotHash,
      metrics.admissionVersion,
      metrics.complete ? 1 : 0,
      JSON.stringify(metrics),
      metrics.observedAt,
      new Date().toISOString(),
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

  async markQueued(rows: readonly MarkQueuedInput[]): Promise<void> {
    if (!rows.length) return;
    const statement = this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', retry_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state IN ('pending', 'queued', 'processing')
    `);
    const statements = rows.map((row) => statement.bind(row.now, row.sourceId, row.externalId));
    await this.batch(statements);
  }

  async acquireLease(input: AcquireLeaseInput): Promise<AdmissionLeaseResult> {
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'processing', lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE source_id = ? AND external_id = ?
        AND snapshot_hash = ? AND material_hash = ? AND admission_version = ?
        AND state IN ('pending', 'queued', 'processing')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).bind(
      input.owner, leaseExpiresAt, input.now,
      input.sourceId, input.externalId,
      input.expectedSnapshotHash, input.expectedMaterialHash, input.expectedAdmissionVersion,
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
    return { outcome: 'no-op', reason: 'stale' };
  }

  async releaseLease(sourceId: string, externalId: string, owner: string, now: string): Promise<void> {
    await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
    `).bind(now, sourceId, externalId, owner).run();
  }

  async settleRow(input: {
    sourceId: string; externalId: string; owner: string; now: string;
    decision: IngestionDecision; jobId?: string; reason?: string;
  }): Promise<void> {
    await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'settled', decision = ?, job_id = COALESCE(?, job_id), settled_at = ?,
        attempt_count = attempt_count + 1, retry_at = NULL,
        failure_class = ?, failure_detail = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
    `).bind(
      input.decision, input.jobId ?? null, input.now,
      input.decision === 'blocked' ? 'blocked' : input.decision === 'shelved' ? 'shelved' : null,
      input.reason ?? null,
      input.now, input.sourceId, input.externalId, input.owner,
    ).run();
  }

  async scheduleRowRetry(input: {
    sourceId: string; externalId: string; owner: string; now: string;
    attemptCount: number; retryAt: string; failure: AdmissionFailure;
  }): Promise<void> {
    await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', attempt_count = ?, retry_at = ?, failure_class = ?, failure_detail = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
    `).bind(
      input.attemptCount, input.retryAt, input.failure.classification, input.failure.detail,
      input.now, input.sourceId, input.externalId, input.owner,
    ).run();
  }

  async quarantineRow(input: {
    sourceId: string; externalId: string; owner: string; now: string;
    attemptCount: number; failure: AdmissionFailure;
  }): Promise<void> {
    await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'quarantined', attempt_count = ?, retry_at = NULL, failure_class = ?, failure_detail = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE source_id = ? AND external_id = ? AND state = 'processing' AND lease_owner = ?
    `).bind(
      input.attemptCount, input.failure.classification, input.failure.detail,
      input.now, input.sourceId, input.externalId, input.owner,
    ).run();
  }

  async reopenRows(sourceId: string, externalIds: readonly string[], now: string, options: { admissionVersion?: string } = {}): Promise<number> {
    const ids = [...new Set(externalIds)];
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const result = await this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', attempt_count = 0, retry_at = NULL,
        lease_owner = NULL, lease_expires_at = NULL,
        failure_class = NULL, failure_detail = NULL, settled_at = NULL, decision = NULL,
        admission_version = COALESCE(?, admission_version), updated_at = ?
      WHERE source_id = ? AND external_id IN (${placeholders}) AND state IN ('settled', 'quarantined', 'absent')
    `).bind(options.admissionVersion ?? null, now, sourceId, ...ids).run();
    return result.meta.changes;
  }

  async reclaimExpiredLeases(now: string, limit: number): Promise<IngestionRowRecord[]> {
    const expired = await this.listExpiredLeases(now, limit);
    if (!expired.length) return [];
    const statement = this.db.prepare(`
      UPDATE ingestion_rows
      SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
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
      WHERE source_id = ? AND (
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
    await this.db.prepare(
      'UPDATE ingestion_admission_handoffs SET acknowledged_at = ? WHERE batch_id = ? AND acknowledged_at IS NULL',
    ).bind(now, batchId).run();
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

  async listActiveSourceIds(limit: number): Promise<string[]> {
    const bounded = Math.max(1, Math.min(limit, 500));
    const { results } = await this.db.prepare(`
      SELECT DISTINCT source_id FROM ingestion_snapshots
      WHERE state = 'active' ORDER BY source_id LIMIT ?
    `).bind(bounded).all<{ source_id: string }>();
    return results.map((row) => row.source_id);
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
    return {
      ...counts,
      ...(oldestWorkAt ? { oldestWorkAt } : {}),
      ...(active ? { currentSnapshotHash: active.snapshot_hash } : {}),
    };
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
  private readonly decoder = new TextDecoder();

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
    const body = serializeEnvelope(envelope);
    const existing = await this.get(key);
    if (existing !== null) {
      // The key is the content hash, so an existing object can only differ in
      // volatile fetch metadata. Validate it and keep the original bytes rather
      // than rewriting; a corrupt or mismatched body fails closed.
      parseEnvelope(existing, { sourceId: envelope.sourceId, snapshotHash: envelope.snapshotHash });
      return { key, bytes: existing.length, existed: true };
    }
    await this.put(key, body);
    return { key, bytes: body.length, existed: false };
  }

  async getSnapshot(sourceId: string, snapshotHash: string): Promise<NormalizedSnapshotEnvelope> {
    const key = snapshotObjectKey(sourceId, snapshotHash);
    const raw = await this.get(key);
    if (raw === null) throw new Error(`Ingestion snapshot object missing at ${key}`);
    return parseEnvelope(raw, { sourceId, snapshotHash });
  }
}
