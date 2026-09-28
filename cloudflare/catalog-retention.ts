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
/** The daily cron keeps draining full pages, but yields before monopolizing maintenance. */
export const CATALOG_RETENTION_CRON_MAX_PASSES = 100;
export const CATALOG_RETENTION_CRON_MAX_DURATION_MS = 20_000;

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
  maxPasses?: number;
  maxDurationMs?: number;
}

export interface CatalogRetentionRemaining {
  notificationEvents: boolean;
  closedJobs: boolean;
  closedOccurrences: boolean;
  metadataEvidenceHistory: boolean;
  metadataExtractionAttempts: boolean;
  metadataResolvedConflicts: boolean;
}

export interface CatalogRetentionReport {
  applied: boolean;
  passes: number;
  timeBudgetReached: boolean;
  remaining: CatalogRetentionRemaining;
  /** Rows eligible this run (or deleted this run when `applied`). */
  notificationEvents: number;
  closedJobs: number;
  closedJobOccurrences: number;
  closedJobApplicationSnapshots: number;
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
  closedJobApplicationSnapshots: number;
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

/** Earliest notification event the operator recovery API can still inspect. */
export function notificationEventRetentionCutoff(now: Date): string {
  return isoDaysBefore(now, NOTIFICATION_EVENT_RETENTION_DAYS);
}

function emptyCounts(): CatalogRetentionCounts {
  return {
    notificationEvents: 0,
    closedJobs: 0,
    closedJobOccurrences: 0,
    closedJobApplicationSnapshots: 0,
    closedJobMetadataRows: 0,
    closedOccurrences: 0,
    metadataEvidenceHistory: 0,
    metadataExtractionAttempts: 0,
    metadataResolvedConflicts: 0,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
}

async function limitedCount(db: D1Database, query: string, bindings: unknown[], limit: number): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM (${query} LIMIT ?)`)
    .bind(...bindings, limit).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function exists(db: D1Database, query: string, bindings: unknown[]): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 AS present FROM (${query} LIMIT 1)`).bind(...bindings).first<{ present: number }>());
}

/** Notification outbox rows past the retention window (malformed rows included). */
async function sweepNotificationEvents(db: D1Database, cutoff: string, limit: number, apply: boolean): Promise<number> {
  const selection = `SELECT rowid FROM catalog_items
    WHERE kind = 'notification-event' AND coalesce(json_extract(value, '$.createdAt'), '') < ?
    ORDER BY coalesce(json_extract(value, '$.createdAt'), '')`;
  if (!apply) return limitedCount(db, selection, [cutoff], limit);
  const result = await db.prepare(`DELETE FROM catalog_items WHERE rowid IN (${selection} LIMIT ?)`)
    .bind(cutoff, limit).run();
  return result.meta.changes;
}

/**
 * A source's own record that it dropped a posting. Closed for long enough that
 * a re-listing is a fresh observation, not a continuation.
 */
async function sweepClosedOccurrences(db: D1Database, cutoff: string, limit: number, apply: boolean): Promise<number> {
  const selection = `SELECT rowid FROM catalog_items
    WHERE kind = 'source-occurrence'
      AND json_extract(value, '$.occurrence.state') = 'closed'
      AND coalesce(json_extract(value, '$.changedAt'), '') < ?
    ORDER BY coalesce(json_extract(value, '$.changedAt'), '')`;
  if (!apply) return limitedCount(db, selection, [cutoff], limit);
  // Eligibility is selected and deleted in one SQLite statement, so an
  // occurrence that reopens or is remapped cannot be deleted from a stale page.
  const result = await db.prepare(`DELETE FROM catalog_items WHERE rowid IN (${selection} LIMIT ?)`)
    .bind(cutoff, limit).run();
  return result.meta.changes;
}

type ClosedJobRow = { pk: string; sk: string; value: string; catalogSortKey: string };

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
): Promise<{ jobs: number; occurrences: number; applicationSnapshots: number; metadataRows: number; selected: number }> {
  const page = await db.prepare(`SELECT pk, sk, value, catalog_sort_key AS catalogSortKey FROM catalog_items
    WHERE kind = 'internship' AND catalog_state = 'CLOSED'
      AND catalog_sort_key IS NOT NULL AND catalog_sort_key < ?
    ORDER BY catalog_sort_key LIMIT ?`).bind(cutoff, limit).all<ClosedJobRow>();
  if (!apply || !page.results.length) {
    return { jobs: page.results.length, occurrences: 0, applicationSnapshots: 0, metadataRows: 0, selected: page.results.length };
  }
  let jobs = 0;
  let occurrences = 0;
  let applicationSnapshots = 0;
  let metadataRows = 0;
  for (const row of page.results) {
    const jobId = row.pk.startsWith('JOB#') ? row.pk.slice('JOB#'.length) : row.pk;
    let references: Array<{ sourceId?: unknown; externalId?: unknown }> = [];
    let applicationSnapshot: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(row.value) as {
        jobId?: unknown; company?: unknown; title?: unknown; location?: unknown; season?: unknown;
        postingIdentityStatus?: unknown; sourceReferences?: unknown;
      };
      if (typeof parsed.jobId === 'string' && parsed.jobId !== jobId) {
        console.error(JSON.stringify({ command: 'catalog-retention-job-id-mismatch', pk: row.pk, embeddedJobId: parsed.jobId }));
      } else if (Array.isArray(parsed.sourceReferences)) {
        references = parsed.sourceReferences as typeof references;
      }
      if (typeof parsed.company === 'string' && typeof parsed.title === 'string'
        && typeof parsed.location === 'string' && typeof parsed.season === 'string') {
        applicationSnapshot = {
          jobId,
          company: parsed.company,
          title: parsed.title,
          location: parsed.location,
          season: parsed.season,
          ...(['confirmed', 'unconfirmed'].includes(String(parsed.postingIdentityStatus))
            ? { postingIdentityStatus: parsed.postingIdentityStatus }
            : {}),
          sourceReferences: references.flatMap((reference) => {
            if (!reference || typeof reference.sourceId !== 'string' || typeof (reference as { sourceUrl?: unknown }).sourceUrl !== 'string') return [];
            const source = reference as { sourceId: string; sourceUrl: string; provenance?: unknown; state?: unknown };
            return [{ sourceId: source.sourceId, sourceUrl: source.sourceUrl,
              ...(['official-employer', 'official-provider', 'reviewed-community'].includes(String(source.provenance)) ? { provenance: source.provenance } : {}),
              ...(['open', 'closed'].includes(String(source.state)) ? { state: source.state } : {}) }];
          }),
        };
      }
    } catch { /* A malformed row is still expired by its own key. */ }
    const selectedParentGuard = `EXISTS (SELECT 1 FROM catalog_items AS job
      WHERE job.pk = ? AND job.sk = ? AND job.kind = 'internship' AND job.value = ?
        AND job.catalog_state = 'CLOSED' AND job.catalog_sort_key = ?)`;
    const parentBindings = [row.pk, row.sk, row.value, row.catalogSortKey];
    // Every application must hold a compact presentation before the catalog row
    // can disappear. This check composes with the exact-parent guard so a save
    // or parent rewrite racing the selected page cannot produce a blank role.
    const parentGuard = `${selectedParentGuard} AND NOT EXISTS (
      SELECT 1 FROM user_items AS saved
      WHERE saved.kind = 'application' AND json_extract(saved.value, '$.jobId') = ?
        AND (coalesce(json_type(saved.value, '$.jobSnapshot'), '') <> 'object'
          OR coalesce(json_type(saved.value, '$.jobSnapshot.company'), '') <> 'text'
          OR coalesce(json_type(saved.value, '$.jobSnapshot.title'), '') <> 'text'
          OR coalesce(json_type(saved.value, '$.jobSnapshot.location'), '') <> 'text'
          OR coalesce(json_type(saved.value, '$.jobSnapshot.season'), '') <> 'text'))`;
    const guardedBindings = [...parentBindings, jobId];
    const statements: D1PreparedStatement[] = [];
    let applicationSnapshotIndex: number | undefined;
    const occurrenceIndexes: number[] = [];
    const metadataIndexes: number[] = [];
    if (applicationSnapshot) {
      applicationSnapshotIndex = statements.length;
      statements.push(db.prepare(`UPDATE user_items SET value = json_set(value, '$.jobSnapshot', json(?))
        WHERE kind = 'application' AND json_extract(value, '$.jobId') = ? AND ${selectedParentGuard}`)
        .bind(JSON.stringify(applicationSnapshot), jobId, ...parentBindings));
    }
    for (const reference of references) {
      if (!reference || typeof reference.sourceId !== 'string' || typeof reference.externalId !== 'string') continue;
      occurrenceIndexes.push(statements.length);
      statements.push(db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND sk = ? AND kind = 'source-occurrence'
        AND json_extract(value, '$.jobId') = ? AND json_extract(value, '$.occurrence.state') = 'closed'
        AND ${parentGuard}`)
        .bind(`SOURCE#${reference.sourceId}`, `OCCURRENCE#${reference.externalId}`, jobId, ...guardedBindings));
    }
    const metadataDelete = (query: string, bindings: unknown[]) => {
      metadataIndexes.push(statements.length);
      statements.push(db.prepare(query).bind(...bindings));
    };
    // A catalog-wide repair plan becomes unusable as soon as one staged job is
    // removed. Clear the whole token before its job-keyed stage row disappears.
    for (const table of ['role_metadata_repair_guards', 'role_metadata_repair_review_stage', 'role_metadata_repair_plans'] as const) {
      metadataDelete(`DELETE FROM ${table} WHERE token IN (
        SELECT token FROM role_metadata_repair_stage WHERE job_id = ?) AND ${parentGuard}`, [jobId, ...guardedBindings]);
    }
    metadataDelete(`DELETE FROM role_metadata_repair_stage WHERE token IN (
      SELECT token FROM role_metadata_repair_stage WHERE job_id = ?) AND ${parentGuard}`, [jobId, ...guardedBindings]);
    metadataDelete(`DELETE FROM role_metadata_repair_review_stage WHERE job_id = ? AND ${parentGuard}`, [jobId, ...guardedBindings]);
    metadataDelete(`DELETE FROM role_metadata_review_guards WHERE token IN (
      SELECT token FROM role_metadata_review_plans WHERE job_id = ?
      UNION SELECT token FROM role_metadata_review_decisions WHERE job_id = ?) AND ${parentGuard}`,
    [jobId, jobId, ...guardedBindings]);
    for (const table of ['role_metadata_review_plans', 'role_metadata_review_decisions', 'role_metadata_acquisition',
      'role_metadata_evidence', 'role_metadata_extraction_attempts', 'role_metadata_conflicts'] as const) {
      metadataDelete(`DELETE FROM ${table} WHERE job_id = ? AND ${parentGuard}`, [jobId, ...guardedBindings]);
    }
    // D1 batch is one transaction, and every child delete rechecks the exact
    // selected parent plus the saved-application snapshot contract. A concurrent
    // reopen, rewrite, or unsnapshotted save makes the parent ineligible.
    const parentIndex = statements.length;
    statements.push(db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND sk = ? AND kind = 'internship'
      AND value = ? AND catalog_state = 'CLOSED' AND catalog_sort_key = ?
      AND NOT EXISTS (SELECT 1 FROM user_items AS saved
        WHERE saved.kind = 'application' AND json_extract(saved.value, '$.jobId') = ?
          AND (coalesce(json_type(saved.value, '$.jobSnapshot'), '') <> 'object'
            OR coalesce(json_type(saved.value, '$.jobSnapshot.company'), '') <> 'text'
            OR coalesce(json_type(saved.value, '$.jobSnapshot.title'), '') <> 'text'
            OR coalesce(json_type(saved.value, '$.jobSnapshot.location'), '') <> 'text'
            OR coalesce(json_type(saved.value, '$.jobSnapshot.season'), '') <> 'text'))`)
      .bind(row.pk, row.sk, row.value, row.catalogSortKey, jobId));
    // Evidence and catalog DELETE triggers both increment this row. Remove the
    // final trigger-created revision only when the exact parent is now absent.
    const revisionIndex = statements.length;
    statements.push(db.prepare(`DELETE FROM role_metadata_job_revision WHERE job_id = ?
      AND NOT EXISTS (SELECT 1 FROM catalog_items WHERE pk = ? AND sk = ? AND kind = 'internship')`)
      .bind(jobId, row.pk, row.sk));
    const results = await db.batch(statements);
    if (applicationSnapshotIndex !== undefined) applicationSnapshots += results[applicationSnapshotIndex]?.meta.changes ?? 0;
    for (const index of occurrenceIndexes) occurrences += results[index]?.meta.changes ?? 0;
    for (const index of [...metadataIndexes, revisionIndex]) metadataRows += results[index]?.meta.changes ?? 0;
    jobs += results[parentIndex]?.meta.changes ?? 0;
  }
  return { jobs, occurrences, applicationSnapshots, metadataRows, selected: page.results.length };
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
  const evidenceSelection = `SELECT rowid FROM role_metadata_evidence
    WHERE is_current = 0 AND observed_at < ?`;
  const attemptSelection = `SELECT attempt.rowid AS rowid FROM role_metadata_extraction_attempts AS attempt
    WHERE attempt.observed_at < ?
      AND EXISTS (SELECT 1 FROM role_metadata_extraction_attempts AS newer
        WHERE newer.job_id = attempt.job_id AND newer.source_id = attempt.source_id
          AND (newer.observed_at > attempt.observed_at
            OR (newer.observed_at = attempt.observed_at AND newer.rowid > attempt.rowid)))`;
  const conflictSelection = `SELECT rowid FROM role_metadata_conflicts
    WHERE state = 'resolved' AND updated_at < ?`;
  if (!apply) {
    return {
      evidence: await limitedCount(db, evidenceSelection, [cutoff], limit),
      attempts: await limitedCount(db, attemptSelection, [cutoff], limit),
      conflicts: await limitedCount(db, conflictSelection, [cutoff], limit),
    };
  }
  // Each statement re-evaluates eligibility while deleting. An evidence row
  // made current or a conflict reopened before this statement begins survives.
  const [evidence, attempts, conflicts] = await db.batch([
    db.prepare(`DELETE FROM role_metadata_evidence WHERE rowid IN (${evidenceSelection} LIMIT ?)`).bind(cutoff, limit),
    db.prepare(`DELETE FROM role_metadata_extraction_attempts WHERE rowid IN (${attemptSelection} LIMIT ?)`).bind(cutoff, limit),
    db.prepare(`DELETE FROM role_metadata_conflicts WHERE rowid IN (${conflictSelection} LIMIT ?)`).bind(cutoff, limit),
  ]);
  return {
    evidence: evidence?.meta.changes ?? 0,
    attempts: attempts?.meta.changes ?? 0,
    conflicts: conflicts?.meta.changes ?? 0,
  };
}

async function retentionRemaining(db: D1Database, cutoffs: {
  notification: string; jobs: string; occurrences: string; metadata: string;
}): Promise<CatalogRetentionRemaining> {
  const remaining: CatalogRetentionRemaining = {
    notificationEvents: await exists(db, `SELECT rowid FROM catalog_items
      WHERE kind = 'notification-event' AND coalesce(json_extract(value, '$.createdAt'), '') < ?`, [cutoffs.notification]),
    closedJobs: await exists(db, `SELECT rowid FROM catalog_items
      WHERE kind = 'internship' AND catalog_state = 'CLOSED'
        AND catalog_sort_key IS NOT NULL AND catalog_sort_key < ?`, [cutoffs.jobs]),
    closedOccurrences: await exists(db, `SELECT rowid FROM catalog_items
      WHERE kind = 'source-occurrence' AND json_extract(value, '$.occurrence.state') = 'closed'
        AND coalesce(json_extract(value, '$.changedAt'), '') < ?`, [cutoffs.occurrences]),
    metadataEvidenceHistory: false,
    metadataExtractionAttempts: false,
    metadataResolvedConflicts: false,
  };
  try {
    remaining.metadataEvidenceHistory = await exists(db,
      'SELECT rowid FROM role_metadata_evidence WHERE is_current = 0 AND observed_at < ?', [cutoffs.metadata]);
    remaining.metadataExtractionAttempts = await exists(db, `SELECT attempt.rowid FROM role_metadata_extraction_attempts AS attempt
      WHERE attempt.observed_at < ? AND EXISTS (SELECT 1 FROM role_metadata_extraction_attempts AS newer
        WHERE newer.job_id = attempt.job_id AND newer.source_id = attempt.source_id
          AND (newer.observed_at > attempt.observed_at
            OR (newer.observed_at = attempt.observed_at AND newer.rowid > attempt.rowid)))`, [cutoffs.metadata]);
    remaining.metadataResolvedConflicts = await exists(db,
      "SELECT rowid FROM role_metadata_conflicts WHERE state = 'resolved' AND updated_at < ?", [cutoffs.metadata]);
  } catch (error) {
    console.error(JSON.stringify({ command: 'catalog-retention-metadata-backlog', error: error instanceof Error ? error.message : String(error) }));
  }
  return remaining;
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
  const rowBatch = positiveInteger(options.rowBatchSize, CATALOG_RETENTION_ROW_BATCH);
  const jobBatch = positiveInteger(options.jobBatchSize, CATALOG_RETENTION_JOB_BATCH);
  const maxPasses = apply ? positiveInteger(options.maxPasses, 1) : 1;
  const maxDurationMs = positiveInteger(options.maxDurationMs, Number.MAX_SAFE_INTEGER);
  const startedAt = Date.now();
  const cutoffs = {
    notification: notificationEventRetentionCutoff(now),
    jobs: isoDaysBefore(now, CLOSED_JOB_RETENTION_DAYS),
    occurrences: isoDaysBefore(now, CLOSED_OCCURRENCE_RETENTION_DAYS),
    metadata: isoDaysBefore(now, METADATA_HISTORY_RETENTION_DAYS),
  };
  const counts = emptyCounts();
  let passes = 0;
  let timeBudgetReached = false;
  for (; passes < maxPasses; passes += 1) {
    const notificationEvents = await sweepNotificationEvents(db, cutoffs.notification, rowBatch, apply);
    counts.notificationEvents += notificationEvents;
    // Closed jobs run before closed occurrences so a job's own occurrence rows
    // are counted with the job that owned them; the occurrence sweep then handles
    // rows whose job is still retained.
    const jobs = await sweepClosedJobs(db, cutoffs.jobs, jobBatch, apply);
    counts.closedJobs += jobs.jobs;
    counts.closedJobOccurrences += jobs.occurrences;
    counts.closedJobApplicationSnapshots += jobs.applicationSnapshots;
    counts.closedJobMetadataRows += jobs.metadataRows;
    const closedOccurrences = await sweepClosedOccurrences(db, cutoffs.occurrences, rowBatch, apply);
    counts.closedOccurrences += closedOccurrences;

    let metadataPageFull = false;
    try {
      const metadata = await sweepMetadataHistory(db, cutoffs.metadata, rowBatch, apply);
      counts.metadataEvidenceHistory += metadata.evidence;
      counts.metadataExtractionAttempts += metadata.attempts;
      counts.metadataResolvedConflicts += metadata.conflicts;
      metadataPageFull = metadata.evidence >= rowBatch || metadata.attempts >= rowBatch || metadata.conflicts >= rowBatch;
    } catch (error) {
      console.error(JSON.stringify({ command: 'catalog-retention-metadata', error: error instanceof Error ? error.message : String(error) }));
    }
    const pageFull = notificationEvents >= rowBatch || jobs.selected >= jobBatch
      || closedOccurrences >= rowBatch || metadataPageFull;
    if (!apply || !pageFull) { passes += 1; break; }
    if (Date.now() - startedAt >= maxDurationMs) {
      timeBudgetReached = true;
      passes += 1;
      break;
    }
  }
  const remaining = await retentionRemaining(db, cutoffs);
  return { applied: apply, passes, timeBudgetReached, remaining, ...counts };
}
