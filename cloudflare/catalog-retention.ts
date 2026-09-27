import type { D1Database, D1PreparedStatement } from './types.js';

/**
 * Retention for the append-only parts of `catalog_items` and the role-metadata
 * history tables. `catalog_items` is a general JSON store whose historical rows
 * — notification outbox events, closed source occurrences, closed internships,
 * superseded metadata evidence — are never otherwise deleted, so the database
 * grows without bound toward D1's 10 GB ceiling.
 *
 * Every sweep deletes only rows a live reader no longer needs:
 *
 * - a notification event is consumed by the next notification drain, and the
 *   operator recovery path takes its own look-back window;
 * - a closed internship older than a year is past its season and no longer
 *   listed, and a saved application against it already renders the "role
 *   unavailable" state;
 * - a closed source occurrence is a source's own record that it dropped the
 *   posting, kept only for identity repair and audit;
 * - superseded (`is_current = 0`) evidence and older extraction attempts are
 *   history, while freshness always lives in the newest attempt per
 *   job/source and the current evidence set.
 *
 * Each sweep is bounded and returns counts, so the maintenance cron can log
 * what it reclaimed without holding a long write on a busy database.
 */

/** A notification event is dead once its delivery drain and recovery window pass. */
export const NOTIFICATION_EVENT_RETENTION_DAYS = 30;
/** Superseded evidence, old attempts and resolved conflicts kept for audit. */
export const METADATA_HISTORY_RETENTION_DAYS = 180;
/** A source-dropped occurrence kept for identity repair and audit. */
export const CLOSED_OCCURRENCE_RETENTION_DAYS = 180;
/** A closed, unlisted role kept so a late application can still resolve it. */
export const CLOSED_JOB_RETENTION_DAYS = 365;
export const CATALOG_RETENTION_ROW_BATCH = 200;
export const CATALOG_RETENTION_JOB_BATCH = 25;

export interface CatalogRetentionOptions {
  /** Clock for the cutoffs; defaults to now. */
  now?: Date;
  /**
   * When false the sweeps report what they would remove without writing.
   * Defaults to false so a misconfigured caller cannot delete by accident.
   */
  apply?: boolean;
  rowBatchSize?: number;
  jobBatchSize?: number;
}

export interface CatalogRetentionReport {
  applied: boolean;
  /** Rows eligible this run (or deleted this run when `applied`). */
  notificationEvents: number;
  closedJobs: number;
  closedJobOccurrences: number;
  closedJobMetadataRows: number;
  closedOccurrences: number;
  metadataEvidenceHistory: number;
  metadataExtractionAttempts: number;
  metadataResolvedConflicts: number;
}

export interface CatalogRetentionCounts {
  notificationEvents: number;
  closedJobs: number;
  closedJobOccurrences: number;
  closedJobMetadataRows: number;
  closedOccurrences: number;
  metadataEvidenceHistory: number;
  metadataExtractionAttempts: number;
  metadataResolvedConflicts: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function isoDaysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

function emptyCounts(): CatalogRetentionCounts {
  return {
    notificationEvents: 0,
    closedJobs: 0,
    closedJobOccurrences: 0,
    closedJobMetadataRows: 0,
    closedOccurrences: 0,
    metadataEvidenceHistory: 0,
    metadataExtractionAttempts: 0,
    metadataResolvedConflicts: 0,
  };
}

type CatalogKey = { pk: string; sk: string };

// D1 caps bound parameters per statement, and each catalog key binds two, so a
// delete chunk carries at most 50 keys regardless of how many were selected.
const CATALOG_KEY_BIND_LIMIT = 50;
const CATALOG_ROWID_BIND_LIMIT = 100;

async function deleteCatalogKeys(db: D1Database, keys: readonly CatalogKey[], batchSize: number): Promise<number> {
  let deleted = 0;
  const chunkSize = Math.min(batchSize, CATALOG_KEY_BIND_LIMIT);
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const chunk = keys.slice(offset, offset + chunkSize);
    const clause = chunk.map(() => '(pk = ? AND sk = ?)').join(' OR ');
    const result = await db.prepare(`DELETE FROM catalog_items WHERE ${clause}`)
      .bind(...chunk.flatMap((key) => [key.pk, key.sk])).run();
    deleted += result.meta.changes;
  }
  return deleted;
}

/**
 * Deletes by `rowid` so a sweep over a table with a natural primary key can
 * still bound each statement. `table` is always a literal from this module.
 */
async function deleteByRowid(db: D1Database, table: string, rowids: readonly number[], batchSize: number): Promise<number> {
  let deleted = 0;
  const chunkSize = Math.min(batchSize, CATALOG_ROWID_BIND_LIMIT);
  for (let offset = 0; offset < rowids.length; offset += chunkSize) {
    const chunk = rowids.slice(offset, offset + chunkSize);
    const result = await db.prepare(`DELETE FROM ${table} WHERE rowid IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk).run();
    deleted += result.meta.changes;
  }
  return deleted;
}

/** Notification outbox rows past the retention window (malformed rows included). */
async function sweepNotificationEvents(db: D1Database, cutoff: string, limit: number, apply: boolean): Promise<number> {
  const rows = await db.prepare(`SELECT pk, sk FROM catalog_items
    WHERE kind = 'notification-event' AND coalesce(json_extract(value, '$.createdAt'), '') < ?
    ORDER BY json_extract(value, '$.createdAt') LIMIT ?`).bind(cutoff, limit).all<CatalogKey>();
  if (!apply || !rows.results.length) return rows.results.length;
  return deleteCatalogKeys(db, rows.results, limit);
}

/**
 * A source's own record that it dropped a posting. Closed for long enough that
 * a re-listing is a fresh observation, not a continuation.
 */
async function sweepClosedOccurrences(db: D1Database, cutoff: string, limit: number, apply: boolean): Promise<number> {
  const rows = await db.prepare(`SELECT pk, sk FROM catalog_items
    WHERE kind = 'source-occurrence'
      AND json_extract(value, '$.occurrence.state') = 'closed'
      AND coalesce(json_extract(value, '$.changedAt'), '') < ?
    ORDER BY json_extract(value, '$.changedAt') LIMIT ?`).bind(cutoff, limit).all<CatalogKey>();
  if (!apply || !rows.results.length) return rows.results.length;
  return deleteCatalogKeys(db, rows.results, limit);
}

type ClosedJobRow = { pk: string; sk: string; value: string };

/**
 * Closed internships past the retention window, together with every row that
 * only existed to describe them: their per-source occurrences and the
 * role-metadata history keyed by job id. The job's own `sourceReferences`
 * names the occurrence keys, so this never scans the occurrence keyspace.
 */
async function sweepClosedJobs(
  db: D1Database,
  cutoff: string,
  limit: number,
  apply: boolean,
  statementBatch: number,
): Promise<{ jobs: number; occurrences: number; metadataRows: number }> {
  const page = await db.prepare(`SELECT pk, sk, value FROM catalog_items
    WHERE kind = 'internship' AND catalog_state = 'CLOSED'
      AND catalog_sort_key IS NOT NULL AND catalog_sort_key < ?
    ORDER BY catalog_sort_key LIMIT ?`).bind(cutoff, limit).all<ClosedJobRow>();
  if (!apply || !page.results.length) {
    return { jobs: page.results.length, occurrences: 0, metadataRows: 0 };
  }
  let jobs = 0;
  let occurrences = 0;
  let metadataRows = 0;
  for (const row of page.results) {
    let jobId = row.pk.startsWith('JOB#') ? row.pk.slice('JOB#'.length) : row.pk;
    let references: Array<{ sourceId?: unknown; externalId?: unknown }> = [];
    try {
      const parsed = JSON.parse(row.value) as { jobId?: unknown; sourceReferences?: unknown };
      if (typeof parsed.jobId === 'string') jobId = parsed.jobId;
      if (Array.isArray(parsed.sourceReferences)) references = parsed.sourceReferences as typeof references;
    } catch { /* A malformed row is still expired by its own key. */ }
    const statements: D1PreparedStatement[] = [];
    let occurrenceStatements = 0;
    for (const reference of references) {
      if (!reference || typeof reference.sourceId !== 'string' || typeof reference.externalId !== 'string') continue;
      statements.push(db.prepare('DELETE FROM catalog_items WHERE pk = ? AND sk = ?')
        .bind(`SOURCE#${reference.sourceId}`, `OCCURRENCE#${reference.externalId}`));
      occurrenceStatements += 1;
    }
    statements.push(db.prepare('DELETE FROM catalog_items WHERE pk = ? AND sk = ?').bind(`JOB#${jobId}`, 'META'));
    statements.push(db.prepare('DELETE FROM role_metadata_evidence WHERE job_id = ?').bind(jobId));
    statements.push(db.prepare('DELETE FROM role_metadata_extraction_attempts WHERE job_id = ?').bind(jobId));
    statements.push(db.prepare('DELETE FROM role_metadata_conflicts WHERE job_id = ?').bind(jobId));
    const results: Array<{ meta: { changes: number } }> = [];
    for (let offset = 0; offset < statements.length; offset += statementBatch) {
      results.push(...await db.batch(statements.slice(offset, offset + statementBatch)));
    }
    for (let index = 0; index < occurrenceStatements; index += 1) occurrences += results[index]?.meta.changes ?? 0;
    jobs += results[occurrenceStatements]?.meta.changes ?? 0;
    for (let index = occurrenceStatements + 1; index < results.length; index += 1) metadataRows += results[index]?.meta.changes ?? 0;
  }
  return { jobs, occurrences, metadataRows };
}

/**
 * Keeps the newest extraction attempt per job/source for freshness and deletes
 * older observations; deletes superseded evidence and resolved conflicts. These
 * tables are additive history: nothing but an audit reads a superseded row.
 */
async function sweepMetadataHistory(
  db: D1Database,
  cutoff: string,
  limit: number,
  apply: boolean,
): Promise<{ evidence: number; attempts: number; conflicts: number }> {
  const evidence = await db.prepare(`SELECT rowid FROM role_metadata_evidence
    WHERE is_current = 0 AND observed_at < ? LIMIT ?`).bind(cutoff, limit).all<{ rowid: number }>();
  const attempts = await db.prepare(`SELECT attempt.rowid AS rowid FROM role_metadata_extraction_attempts AS attempt
    WHERE attempt.observed_at < ?
      AND EXISTS (SELECT 1 FROM role_metadata_extraction_attempts AS newer
        WHERE newer.job_id = attempt.job_id AND newer.source_id = attempt.source_id
          AND (newer.observed_at > attempt.observed_at
            OR (newer.observed_at = attempt.observed_at AND newer.rowid > attempt.rowid)))
    LIMIT ?`).bind(cutoff, limit).all<{ rowid: number }>();
  const conflicts = await db.prepare(`SELECT rowid FROM role_metadata_conflicts
    WHERE state = 'resolved' AND updated_at < ? LIMIT ?`).bind(cutoff, limit).all<{ rowid: number }>();
  if (!apply) {
    return { evidence: evidence.results.length, attempts: attempts.results.length, conflicts: conflicts.results.length };
  }
  return {
    evidence: await deleteByRowid(db, 'role_metadata_evidence', evidence.results.map((row) => row.rowid), limit),
    attempts: await deleteByRowid(db, 'role_metadata_extraction_attempts', attempts.results.map((row) => row.rowid), limit),
    conflicts: await deleteByRowid(db, 'role_metadata_conflicts', conflicts.results.map((row) => row.rowid), limit),
  };
}

/**
 * One retention pass. Bounded per sweep, so the maintenance cron can run it on
 * every tick and drain a large backlog over successive runs. A sweep over a
 * table that is not yet migrated must not block the catalog sweeps, so the
 * metadata history is isolated from the rest.
 */
export async function runCatalogRetention(db: D1Database, options: CatalogRetentionOptions = {}): Promise<CatalogRetentionReport> {
  const now = options.now ?? new Date();
  const apply = options.apply === true;
  const rowBatch = Math.max(1, options.rowBatchSize ?? CATALOG_RETENTION_ROW_BATCH);
  const jobBatch = Math.max(1, options.jobBatchSize ?? CATALOG_RETENTION_JOB_BATCH);
  const counts = emptyCounts();

  counts.notificationEvents = await sweepNotificationEvents(
    db, isoDaysBefore(now, NOTIFICATION_EVENT_RETENTION_DAYS), rowBatch, apply);
  // Closed jobs run before closed occurrences so a job's own occurrence rows
  // are counted with the job that owned them; the occurrence sweep then handles
  // rows whose job is still retained.
  const jobs = await sweepClosedJobs(db, isoDaysBefore(now, CLOSED_JOB_RETENTION_DAYS), jobBatch, apply, rowBatch);
  counts.closedJobs = jobs.jobs;
  counts.closedJobOccurrences = jobs.occurrences;
  counts.closedJobMetadataRows = jobs.metadataRows;
  counts.closedOccurrences = await sweepClosedOccurrences(
    db, isoDaysBefore(now, CLOSED_OCCURRENCE_RETENTION_DAYS), rowBatch, apply);

  try {
    const metadata = await sweepMetadataHistory(db, isoDaysBefore(now, METADATA_HISTORY_RETENTION_DAYS), rowBatch, apply);
    counts.metadataEvidenceHistory = metadata.evidence;
    counts.metadataExtractionAttempts = metadata.attempts;
    counts.metadataResolvedConflicts = metadata.conflicts;
  } catch (error) {
    console.error(JSON.stringify({ command: 'catalog-retention-metadata', error: error instanceof Error ? error.message : String(error) }));
  }

  return { applied: apply, ...counts };
}
