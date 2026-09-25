/**
 * Durable state for automatic company-icon resolution.
 *
 * The resolution task list lives in D1 rather than a queue: the catalog already
 * depends on this database, the work is idempotent by fingerprint, and a queue
 * binding is not needed to make progress. A sweep claims due rows with a lease,
 * so a duplicate or overlapping pass can never resolve the same employer twice.
 *
 * `canonical_employers` remains the owner of the durable icon reference. The
 * columns added by migration 0034 record what the resolver decided and why.
 */

import type { D1Database } from './types.js';

export type EmployerIconResolutionStatus = 'resolved' | 'unresolved' | 'retryable' | 'invalidated';

/** `off` does nothing; `observe` records decisions without rendering them; `resolve` renders them. */
export type EmployerIconMode = 'off' | 'observe' | 'resolve';

export const employerIconSettingsKey = 'company_icon_resolution';
export const employerIconDefaultMaxPerSweep = 5;
/** Wrong-icon reports sort ahead of every other review item. */
export const employerIconWrongMatchPriority = 100;
/**
 * Ranked below a wrong-icon report but above a fresh miss: an employer the resolver has
 * tried several times is where a human is now the cheaper path.
 */
export const employerIconExhaustedPriority = 10;
/** Attempts before an unresolved employer is ranked for review rather than retried quietly. */
export const employerIconReviewAfterAttempts = 3;
/** One tie-breaker per employer per retry window. */
export const employerIconTieBreakWindowMs = 30 * 24 * 60 * 60 * 1_000;

export interface EmployerIconSettings {
  mode: EmployerIconMode;
  maxPerSweep: number;
  /** Recorded only after an operator confirmed Logo.dev self-hosting rights. */
  logoDevRetentionLicensedAt?: string;
}

export interface EmployerIconContext {
  id: string;
  displayName: string;
  iconKey?: string;
  iconSource?: string;
  resolutionStatus?: string;
  websiteDomain?: string;
  tieBreakAt?: string;
  tieBreakFingerprint?: string;
  tieBreakInputTokens?: number;
  tieBreakOutputTokens?: number;
}

export interface EmployerIconTask {
  id: string;
  canonicalEmployerId: string;
  evidenceFingerprint: string;
  evidenceJson: string;
  attempts: number;
}

export interface EmployerIconReviewItem {
  canonicalEmployerId: string;
  status: EmployerIconResolutionStatus;
  selectedDomain?: string;
  selectedSource?: string;
  confidence?: number;
  reviewPriority: number;
  /** How many automatic attempts this employer has had, so a reviewer can triage. */
  attempts?: number;
  /** The compact reason the last decision ended where it did. */
  reasonCode?: string;
  invalidatedAt?: string;
  updatedAt: string;
}

export interface EmployerIconResolutionCounts {
  status: Record<string, number>;
  iconSource: Record<string, number>;
}

type Row = Record<string, string | number | null>;

export class D1EmployerIconStore {
  constructor(private readonly db: D1Database) {}

  async settings(): Promise<EmployerIconSettings> {
    const row = await this.db.prepare('SELECT value FROM system_state WHERE key = ?')
      .bind(employerIconSettingsKey).first<{ value: string }>();
    const fallback: EmployerIconSettings = { mode: 'off', maxPerSweep: employerIconDefaultMaxPerSweep };
    if (!row) return fallback;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value); } catch { return fallback; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
    const record = parsed as Record<string, unknown>;
    const mode = record.mode === 'observe' || record.mode === 'resolve' ? record.mode : 'off';
    const maxPerSweep = Number.isSafeInteger(record.maxPerSweep) && Number(record.maxPerSweep) > 0
      ? Math.min(Number(record.maxPerSweep), 25) : employerIconDefaultMaxPerSweep;
    return {
      mode, maxPerSweep,
      ...(typeof record.logoDevRetentionLicensedAt === 'string'
        && Number.isFinite(Date.parse(record.logoDevRetentionLicensedAt))
        ? { logoDevRetentionLicensedAt: new Date(record.logoDevRetentionLicensedAt).toISOString() } : {}),
    };
  }

  async putSettings(settings: EmployerIconSettings, now: string): Promise<void> {
    await this.db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(employerIconSettingsKey, JSON.stringify(settings), now).run();
  }

  /**
   * Records one resolution task. Returns true only when a new row was written, so
   * a caller can count genuine enqueues rather than redeliveries.
   *
   * The insert is skipped when the employer already has a reviewed icon or a
   * currently valid automatic decision, which is what keeps the task list from
   * growing for employers that need nothing.
   */
  async enqueue(input: {
    id: string;
    canonicalEmployerId: string;
    evidenceFingerprint: string;
    evidenceJson: string;
    nextRetryAt: string;
    now: string;
  }): Promise<boolean> {
    const result = await this.db.prepare(`INSERT INTO employer_icon_resolutions
      (id, canonical_employer_id, evidence_fingerprint, status, evidence_json, attempts, next_retry_at, created_at, updated_at)
      SELECT ?, ?, ?, 'retryable', ?, 0, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM canonical_employers WHERE id = ? AND (icon_key IS NULL OR icon_key = ''))
        AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions
          WHERE canonical_employer_id = ? AND status = 'resolved'
            AND (next_retry_at IS NULL OR next_retry_at > ?))
      ON CONFLICT(canonical_employer_id, evidence_fingerprint) DO NOTHING`)
      .bind(input.id, input.canonicalEmployerId, input.evidenceFingerprint, input.evidenceJson,
        input.nextRetryAt, input.now, input.now, input.canonicalEmployerId, input.canonicalEmployerId, input.now)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Claims due tasks best-first. Each claim is a conditional update, so two
   * overlapping sweeps can select the same row but only one can own it.
   */
  async claimDue(now: string, limit: number, leaseMs: number): Promise<EmployerIconTask[]> {
    const due = await this.db.prepare(`SELECT id, canonical_employer_id, evidence_fingerprint, evidence_json, attempts
      FROM employer_icon_resolutions AS task
      WHERE task.next_retry_at IS NOT NULL AND task.next_retry_at <= ?
        AND (task.lease_until IS NULL OR task.lease_until <= ?)
        AND task.status IN ('retryable', 'unresolved')
        AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions AS blocked
          WHERE blocked.canonical_employer_id = task.canonical_employer_id AND blocked.status = 'invalidated')
      ORDER BY task.next_retry_at, task.created_at LIMIT ?`).bind(now, now, limit).all<Row>();
    const claimed: EmployerIconTask[] = [];
    for (const row of due.results) {
      const leaseToken = crypto.randomUUID();
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      const result = await this.db.prepare(`UPDATE employer_icon_resolutions SET lease_token = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND status IN ('retryable', 'unresolved') AND (lease_until IS NULL OR lease_until <= ?)`)
        .bind(leaseToken, leaseUntil, now, row.id, now).run();
      if (result.meta.changes !== 1) continue;
      claimed.push({
        id: row.id as string, canonicalEmployerId: row.canonical_employer_id as string,
        evidenceFingerprint: row.evidence_fingerprint as string, evidenceJson: row.evidence_json as string,
        attempts: Number(row.attempts ?? 0),
      });
    }
    return claimed;
  }

  async context(employerId: string): Promise<EmployerIconContext | undefined> {
    const row = await this.db.prepare(`SELECT id, display_name, icon_key, icon_source, icon_resolution_status,
      website_domain, icon_tie_break_at, icon_tie_break_fingerprint, icon_tie_break_input_tokens, icon_tie_break_output_tokens
      FROM canonical_employers WHERE id = ?`).bind(employerId).first<Row>();
    if (!row) return undefined;
    return {
      id: row.id as string, displayName: row.display_name as string,
      ...(row.icon_key ? { iconKey: row.icon_key as string } : {}),
      ...(row.icon_source ? { iconSource: row.icon_source as string } : {}),
      ...(row.icon_resolution_status ? { resolutionStatus: row.icon_resolution_status as string } : {}),
      ...(row.website_domain ? { websiteDomain: row.website_domain as string } : {}),
      ...(row.icon_tie_break_at ? { tieBreakAt: row.icon_tie_break_at as string } : {}),
      ...(row.icon_tie_break_fingerprint ? { tieBreakFingerprint: row.icon_tie_break_fingerprint as string } : {}),
      ...(row.icon_tie_break_input_tokens === null ? {} : { tieBreakInputTokens: Number(row.icon_tie_break_input_tokens) }),
      ...(row.icon_tie_break_output_tokens === null ? {} : { tieBreakOutputTokens: Number(row.icon_tie_break_output_tokens) }),
    };
  }

  /**
   * Records a resolved decision. `iconKey` is set only when a licensed R2 write
   * already happened, and never overwrites a key that is already present, so a
   * reviewer upload and an automatic cache can never race.
   */
  async markResolved(input: {
    taskId: string;
    canonicalEmployerId: string;
    selectedDomain?: string;
    selectedSource: string;
    confidence: number;
    evidenceJson: string;
    revalidateAt: string;
    now: string;
    iconKey?: string;
  }): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE employer_icon_resolutions SET status = 'resolved', selected_domain = ?, selected_source = ?,
        confidence = ?, evidence_json = ?, attempts = attempts + 1, next_retry_at = ?,
        lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`)
        .bind(input.selectedDomain ?? null, input.selectedSource, input.confidence, input.evidenceJson,
          input.revalidateAt, input.now, input.taskId),
      this.db.prepare(`UPDATE canonical_employers SET
        icon_key = CASE WHEN icon_key IS NULL THEN ? ELSE icon_key END,
        icon_source = CASE WHEN icon_key IS NULL AND ? IS NOT NULL THEN 'logo-dev' ELSE icon_source END,
        website_domain = ?, icon_resolution_status = 'resolved', icon_resolved_at = ?, updated_at = ?
        WHERE id = ?`)
        .bind(input.iconKey ?? null, input.iconKey ?? null, input.selectedDomain ?? null, input.now, input.now,
          input.canonicalEmployerId),
    ]);
  }

  /**
   * Records a decision that will not change until new evidence arrives.
   *
   * The attempt count is what tells a reviewer which rows deserve attention: an
   * employer that has exhausted the automatic paths outranks one that has just become
   * unresolved and may still resolve itself on the next retry. `invalidated` rows (a
   * wrong-icon report) keep their own, higher, priority.
   */
  async markUnresolved(input: {
    taskId: string; canonicalEmployerId: string; evidenceJson: string; nextRetryAt: string; now: string;
  }): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE employer_icon_resolutions SET status = 'unresolved', evidence_json = ?, attempts = attempts + 1,
        review_priority = MAX(review_priority, CASE WHEN attempts + 1 >= ? THEN ? ELSE 0 END),
        next_retry_at = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`)
        .bind(input.evidenceJson, employerIconReviewAfterAttempts, employerIconExhaustedPriority,
          input.nextRetryAt, input.now, input.taskId),
      this.db.prepare(`UPDATE canonical_employers SET icon_resolution_status = 'unresolved', updated_at = ?
        WHERE id = ? AND icon_resolution_status IS NOT 'resolved'`)
        .bind(input.now, input.canonicalEmployerId),
    ]);
  }

  /** Records a transient failure and schedules the next attempt. */
  async markRetryable(input: {
    taskId: string; evidenceJson: string; nextRetryAt: string; now: string;
  }): Promise<void> {
    await this.db.prepare(`UPDATE employer_icon_resolutions SET status = 'retryable', evidence_json = ?,
      attempts = attempts + 1, next_retry_at = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ?`).bind(input.evidenceJson, input.nextRetryAt, input.now, input.taskId).run();
  }

  /** Releases a lease without consuming an attempt, e.g. when work was deferred. */
  async release(taskId: string, now: string): Promise<void> {
    await this.db.prepare(`UPDATE employer_icon_resolutions SET lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ?`).bind(now, taskId).run();
  }

  /** Records the bounded tie-breaker budget for one employer and evidence set. */
  async recordTieBreak(input: {
    canonicalEmployerId: string; at: string; evidenceFingerprint: string; inputTokens: number; outputTokens: number;
  }): Promise<void> {
    await this.db.prepare(`UPDATE canonical_employers SET icon_tie_break_at = ?, icon_tie_break_fingerprint = ?,
      icon_tie_break_input_tokens = ?, icon_tie_break_output_tokens = ?, updated_at = ? WHERE id = ?`)
      .bind(input.at, input.evidenceFingerprint, input.inputTokens, input.outputTokens, input.at, input.canonicalEmployerId).run();
  }

  /**
   * Invalidates every automatic decision for one employer and clears the icon the
   * resolver wrote. A reviewer-uploaded icon is preserved: only a key this
   * resolver owns (`icon_source = 'logo-dev'`) is withdrawn.
   */
  async invalidate(canonicalEmployerId: string, now: string, reason: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE employer_icon_resolutions SET status = 'invalidated', invalidated_at = ?,
        review_priority = ?, next_retry_at = NULL, lease_token = NULL, lease_until = NULL,
        evidence_json = CASE WHEN json_valid(evidence_json)
          THEN json_set(evidence_json, '$.invalidatedReason', ?) ELSE evidence_json END,
        updated_at = ? WHERE canonical_employer_id = ? AND status <> 'invalidated'`)
        .bind(now, employerIconWrongMatchPriority, reason.slice(0, 200), now, canonicalEmployerId),
      this.db.prepare(`UPDATE canonical_employers SET
        icon_key = CASE WHEN icon_source IN ('logo-dev', 'platform', 'domain-asset') THEN NULL ELSE icon_key END,
        icon_source = CASE WHEN icon_source IN ('logo-dev', 'platform', 'domain-asset') THEN NULL ELSE icon_source END,
        website_domain = NULL, icon_resolution_status = 'invalidated', icon_resolved_at = NULL,
        icon_tie_break_at = NULL, updated_at = ? WHERE id = ?`)
        .bind(now, canonicalEmployerId),
    ]);
  }

  /**
   * Records the employer's own uploaded logo, or an asset from its own site.
   *
   * The icon and the domain decision are separate facts, and this writes only the
   * icon: `icon_resolution_status` is left alone, so an employer can show its real
   * logo while its domain remains undecided. `icon_source` marks it as a machine
   * write — which is what keeps observe mode withholding it — and names where the
   * bytes came from, so a reviewer can tell a board-uploaded mark (`platform`) from
   * an asset read off the employer's own site (`domain-asset`) and withdraw either.
   */
  async markPlatformIcon(input: {
    canonicalEmployerId: string;
    iconKey: string;
    now: string;
    source?: 'platform' | 'domain-asset';
  }): Promise<void> {
    await this.db.prepare(`UPDATE canonical_employers SET
      icon_key = CASE WHEN icon_key IS NULL THEN ? ELSE icon_key END,
      icon_source = CASE WHEN icon_key IS NULL THEN ? ELSE icon_source END,
      icon_updated_at = CASE WHEN icon_key IS NULL THEN ? ELSE icon_updated_at END,
      updated_at = ? WHERE id = ?`)
      .bind(input.iconKey, input.source ?? 'platform', input.now, input.now, input.canonicalEmployerId).run();
  }

  /**
   * Records a domain a person confirmed, after an automatic decision could not
   * reach one. It sets the same read-path fields as an automatic resolution but
   * marks the source as reviewed, so the exception queue can distinguish a human
   * decision from a machine one.
   */
  async markConfirmed(input: {
    canonicalEmployerId: string; domain: string; evidenceJson: string; revalidateAt: string; now: string;
  }): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE employer_icon_resolutions SET status = 'resolved', selected_domain = ?,
        selected_source = 'reviewed', confidence = 1, evidence_json = ?, next_retry_at = ?,
        review_priority = 0, invalidated_at = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE canonical_employer_id = ? AND status <> 'resolved'`)
        .bind(input.domain, input.evidenceJson, input.revalidateAt, input.now, input.canonicalEmployerId),
      this.db.prepare(`UPDATE canonical_employers SET
        icon_source = CASE WHEN icon_key IS NULL THEN 'logo-dev' ELSE icon_source END,
        website_domain = ?, icon_resolution_status = 'resolved', icon_resolved_at = ?, updated_at = ?
        WHERE id = ?`).bind(input.domain, input.now, input.now, input.canonicalEmployerId),
    ]);
  }

  /** The exception queue: wrong-icon reports first, then the employers the resolver exhausted. */
  async reviewQueue(limit: number): Promise<EmployerIconReviewItem[]> {
    const rows = await this.db.prepare(`SELECT canonical_employer_id, status, selected_domain, selected_source,
      confidence, review_priority, attempts, invalidated_at, updated_at,
      json_extract(evidence_json, '$.reasonCode') AS reason_code
      FROM employer_icon_resolutions
      WHERE status IN ('invalidated', 'unresolved')
        AND COALESCE(json_extract(evidence_json, '$.droppedReason'), '') = ''
      ORDER BY review_priority DESC, updated_at ASC LIMIT ?`).bind(limit).all<Row>();
    return rows.results.map((row) => ({
      canonicalEmployerId: row.canonical_employer_id as string,
      status: row.status as EmployerIconResolutionStatus,
      ...(row.selected_domain ? { selectedDomain: row.selected_domain as string } : {}),
      ...(row.selected_source ? { selectedSource: row.selected_source as string } : {}),
      ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
      /** What to do about it: confirm a domain, upload a mark, or leave the monogram. */
      ...(row.reason_code ? { reasonCode: String(row.reason_code) } : {}),
      reviewPriority: Number(row.review_priority ?? 0),
      attempts: Number(row.attempts ?? 0),
      ...(row.invalidated_at ? { invalidatedAt: row.invalidated_at as string } : {}),
      updatedAt: row.updated_at as string,
    }));
  }

  /** The domain an automatically resolved icon is served from, when one exists. */
  async automaticDomain(canonicalEmployerId: string): Promise<string | undefined> {
    const row = await this.db.prepare(`SELECT website_domain FROM canonical_employers
      WHERE id = ? AND icon_resolution_status = 'resolved' AND website_domain IS NOT NULL LIMIT 1`)
      .bind(canonicalEmployerId).first<{ website_domain: string | null }>();
    return row?.website_domain ?? undefined;
  }

  /**
   * Re-arms every withdrawn decision for one employer, after a person has
   * finished reviewing the exception that caused the withdrawal. Without this the
   * invalidation would be permanent for an employer whose only task was dropped.
   *
   * Both halves are required: re-arming the task rows alone leaves the employer
   * flagged `invalidated` and its rows carrying the withdrawal marker, and the
   * resolver would send the reopened task straight back to review.
   */
  async reopen(canonicalEmployerId: string, now: string): Promise<number> {
    const [reopened] = await this.db.batch([
      this.db.prepare(`UPDATE employer_icon_resolutions SET status = 'unresolved', next_retry_at = ?,
        review_priority = 0, invalidated_at = NULL, lease_token = NULL, lease_until = NULL,
        evidence_json = CASE WHEN json_valid(evidence_json)
          THEN json_remove(evidence_json, '$.invalidatedReason') ELSE evidence_json END,
        updated_at = ? WHERE canonical_employer_id = ? AND status = 'invalidated'`)
        .bind(now, now, canonicalEmployerId),
      this.db.prepare(`UPDATE canonical_employers SET
        icon_resolution_status = CASE WHEN icon_resolution_status = 'invalidated' THEN NULL ELSE icon_resolution_status END,
        updated_at = ? WHERE id = ?`).bind(now, canonicalEmployerId),
    ]);
    return reopened?.meta.changes ?? 0;
  }

  /** Terminates a task whose employer no longer exists or is already covered. */
  async dropTask(taskId: string, now: string, reason: string): Promise<void> {
    await this.db.prepare(`UPDATE employer_icon_resolutions SET status = 'unresolved', next_retry_at = NULL,
      lease_token = NULL, lease_until = NULL, evidence_json = CASE WHEN json_valid(evidence_json)
        THEN json_set(evidence_json, '$.droppedReason', ?) ELSE evidence_json END,
      updated_at = ? WHERE id = ?`).bind(reason.slice(0, 200), now, taskId).run();
  }

  /**
   * Employers that have no icon and no outstanding task at all. This is what
   * lets the resolver reach employers that were admitted before it existed.
   */
  async employersNeedingResolution(limit: number): Promise<Array<{ id: string; displayName: string }>> {
    const rows = await this.db.prepare(`SELECT employer.id, employer.display_name FROM canonical_employers AS employer
      WHERE (employer.icon_key IS NULL OR employer.icon_key = '')
        AND NOT EXISTS (SELECT 1 FROM employer_icon_resolutions AS task
          WHERE task.canonical_employer_id = employer.id
            AND (task.status IN ('resolved', 'invalidated') OR task.next_retry_at IS NOT NULL))
      ORDER BY employer.display_name LIMIT ?`).bind(limit).all<Row>();
    return rows.results.map((row) => ({ id: row.id as string, displayName: row.display_name as string }));
  }

  /**
   * One live catalog posting for an employer, so a backfilled task carries the
   * employer's own application link instead of no evidence at all. Without a link the
   * sweep can only match the employer's name against a provider; with it, the posting
   * page supplies the same evidence — and the same declared site — a live admission
   * would.
   */
  async latestPostingForEmployer(canonicalEmployerId: string): Promise<{
    url: string;
    title?: string;
    provider?: string;
    sourceId?: string;
    provenance?: 'official-ats' | 'official-structured' | 'employer-submitted' | 'reviewed-community';
  } | undefined> {
    const row = await this.db.prepare(`SELECT
        json_extract(value, '$.normalizedUrl') AS url,
        json_extract(value, '$.title') AS title,
        json_extract(value, '$.admission.destination.provider') AS provider,
        json_extract(value, '$.sourceReferences[0].sourceId') AS source_id,
        json_extract(value, '$.sourceReferences[0].provenance') AS provenance
      FROM catalog_items
      WHERE kind = 'internship'
        AND json_extract(value, '$.internshipIdentity.company.canonicalId') = ?
      LIMIT 1`).bind(canonicalEmployerId).first<Row>();
    if (!row || typeof row.url !== 'string' || !row.url.startsWith('http')) return undefined;
    const provenance = row.provenance;
    return {
      url: row.url,
      ...(typeof row.title === 'string' && row.title ? { title: row.title } : {}),
      ...(typeof row.provider === 'string' && row.provider ? { provider: row.provider } : {}),
      ...(typeof row.source_id === 'string' && row.source_id ? { sourceId: row.source_id } : {}),
      ...(provenance === 'official-ats' || provenance === 'official-structured'
        || provenance === 'employer-submitted' || provenance === 'reviewed-community'
        ? { provenance } : {}),
    };
  }

  async counts(): Promise<EmployerIconResolutionCounts> {
    const [statuses, sources] = await Promise.all([
      this.db.prepare('SELECT status, COUNT(*) AS count FROM employer_icon_resolutions GROUP BY status').all<Row>(),
      this.db.prepare("SELECT COALESCE(icon_source, 'none') AS source, COUNT(*) AS count FROM canonical_employers GROUP BY source").all<Row>(),
    ]);
    return {
      status: Object.fromEntries(statuses.results.map((row) => [String(row.status), Number(row.count)])),
      iconSource: Object.fromEntries(sources.results.map((row) => [String(row.source), Number(row.count)])),
    };
  }
}
