import { createHash } from 'node:crypto';
import { canonicalCatalogRecency, catalogRecency, catalogVisibleAt, compareCatalogRecency, openCatalogSortKey } from '../src/catalog-recency.js';
import { catalogSearchText, catalogSourceClasses } from '../src/catalog-fields.js';
import { isPastSeason } from '../src/core/early-career.js';
import { employerCategory } from '../src/core/employers.js';
import type { ApplicationSession } from '../src/application-automation.js';
import { preferredJobIdentityConflicts, resolvePostingAliases, type AliasResolution } from '../src/identity/posting.js';
import { deletedUserTombstoneKey, type InternshipStore, type LeverAdmission, type PostingObservationCommit, type PostingObservationCommitResult, type ReleaseStore, type UserStore, type CatalogQuery } from '../src/store.js';
import { disciplineSearchVariants, filterCatalogGroupDetails, type CatalogGroupDetails, type CatalogGroupFilter, type CatalogProjectionPage, type CatalogRelease } from '../src/catalog-groups.js';
import type { ApplicantProfile, ApplicationRecord, DeliveryReceipt, DeviceToken, EvidenceSource, Internship, MetadataConflict, MonitoringChecklist, NotificationEvent, PostingIdentity, PostingIdentityDecision, PostingIdentityIncident, RoleMetadataEvidence, SourceCheckpoint, SourceDispatch, SourceHealth, SourceOccurrence, SourceOccurrenceState, UserDocument, UserPreferences } from '../src/types.js';
import type { D1Database, D1PreparedStatement } from './types.js';
import { alertEligible, catalogEligible } from '../src/catalog-admission.js';
import { postingObservationNotificationProjection, postingObservationProjection } from '../src/identity/projection.js';
import { mergeSourceOccurrence } from '../src/identity/source-occurrence.js';
import { D1CatalogAdmissionStore } from './catalog-admission-store.js';

type JsonRow = { value: string };
const deliveryReceiptLifetimeSeconds = 90 * 24 * 60 * 60;
// A projection is a rebuildable read cache, not an admission decision.  The
// public handler re-applies admission and handoff-url checks to every role it
// returns.  Keep the last complete version available through a missed
// maintenance run instead of falling back to a whole-catalog materialization.
const catalogProjectionMaxAgeMs = 7 * 24 * 60 * 60 * 1_000;
// D1 caps one RPC argument at 32 MiB, and a `batch()` sends every statement's
// bound values inside a single argument. The projection is a copy of the whole
// catalog, so its write is budgeted in bytes rather than statements: a quarter
// of the ceiling leaves room for the RPC envelope, which inflates the JSON it
// carries (a measured 40 MB batch crossed the wire as 70 MB).
export const CATALOG_PROJECTION_BATCH_BYTES = 8 * 1024 * 1024;
// One statement is also one RPC argument once it is sent, and a single group can
// serialize to megabytes, so the per-statement payload needs its own budget.
const CATALOG_PROJECTION_STATEMENT_BYTES = 4 * 1024 * 1024;
const documentUploadLeaseSeconds = 15 * 60;
// Occurrence rows are retained for every posting a source has ever listed, so a
// per-source partition grows without bound. Reading it in one statement lets the
// result set exceed D1's per-query memory ceiling ("Memory limit exceeded before
// EOF"), which rotates/overloads the instance mid-poll and dead-letters valid
// work. Page the read so no single statement streams the whole partition.
// See issues #203 and #241.
const sourceOccurrencePageSize = 500;

function receiptExpiry(value: Pick<DeliveryReceipt, 'updatedAt'>): number {
  return Math.floor(new Date(value.updatedAt).getTime() / 1_000) + deliveryReceiptLifetimeSeconds;
}

/** Applies the published retention schedule to installation-scoped records. */
export async function cleanupExpiredUserData(db: D1Database, now = new Date()): Promise<void> {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const installationLifetimeSeconds = 365 * 24 * 60 * 60;
  await db.batch([
    // Existing installations predate explicit expiry. Start their retention
    // clock at rollout so the migration never surprises an active tester.
    db.prepare("UPDATE user_items SET expires_at = ? WHERE kind = 'installation' AND expires_at IS NULL")
      .bind(nowSeconds + installationLifetimeSeconds),
    db.prepare(`
      UPDATE user_items
      SET expires_at = CAST(strftime('%s', json_extract(value, '$.updatedAt')) AS INTEGER) + ?
      WHERE kind = 'receipt' AND expires_at IS NULL
        AND json_extract(value, '$.updatedAt') IS NOT NULL
    `).bind(deliveryReceiptLifetimeSeconds),
    db.prepare("UPDATE user_items SET expires_at = ? WHERE kind = 'receipt' AND expires_at IS NULL")
      .bind(nowSeconds + deliveryReceiptLifetimeSeconds),
    db.prepare(`
      DELETE FROM user_items
      WHERE user_id IN (
        SELECT user_id FROM user_items
        WHERE kind = 'installation' AND expires_at <= ?
      )
    `).bind(nowSeconds),
    db.prepare("DELETE FROM user_items WHERE kind <> 'installation' AND expires_at IS NOT NULL AND expires_at <= ?")
      .bind(nowSeconds),
  ]);
}

function parse<T>(row: JsonRow | null): T | undefined {
  return row ? JSON.parse(row.value) as T : undefined;
}

function withEmployerCategory(job: Internship): Internship {
  const canonical = canonicalCatalogRecency(job);
  return { ...canonical, employerCategory: canonical.employerCategory ?? employerCategory(canonical.company) };
}

function cursorOffset(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function likePattern(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export class D1InternshipStore implements InternshipStore {
  constructor(private readonly db: D1Database) {}

  private async get<T>(pk: string, sk: string): Promise<T | undefined> {
    return parse<T>(await this.db.prepare('SELECT value FROM catalog_items WHERE pk = ? AND sk = ?').bind(pk, sk).first<JsonRow>());
  }

  private async getPostingObservationState(jobId: string, sourceId: string, externalId: string): Promise<{
    stored?: Internship;
    storedOccurrence?: SourceOccurrenceState;
  }> {
    const jobPk = `JOB#${jobId}`;
    const occurrencePk = `SOURCE#${sourceId}`;
    const occurrenceSk = `OCCURRENCE#${externalId}`;
    const rows = await this.db.prepare(`SELECT pk, sk, value FROM catalog_items
      WHERE (pk = ? AND sk = 'META') OR (pk = ? AND sk = ?)`)
      .bind(jobPk, occurrencePk, occurrenceSk)
      .all<{ pk: string; sk: string; value: string }>();
    const job = rows.results.find((row) => row.pk === jobPk && row.sk === 'META');
    const occurrence = rows.results.find((row) => row.pk === occurrencePk && row.sk === occurrenceSk);
    return {
      ...(job ? { stored: JSON.parse(job.value) as Internship } : {}),
      ...(occurrence ? { storedOccurrence: JSON.parse(occurrence.value) as SourceOccurrenceState } : {}),
    };
  }

  private async put(pk: string, sk: string, kind: string, value: unknown, columns: Record<string, string | number | null> = {}): Promise<void> {
    const names = Object.keys(columns);
    const placeholders = Array.from({ length: 4 + names.length }, () => '?').join(', ');
    const updates = ['kind = excluded.kind', 'value = excluded.value', ...names.map((name) => `${name} = excluded.${name}`)].join(', ');
    await this.db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value${names.length ? `, ${names.join(', ')}` : ''}) VALUES (${placeholders}) ON CONFLICT(pk, sk) DO UPDATE SET ${updates}`)
      .bind(pk, sk, kind, JSON.stringify(value), ...names.map((name) => columns[name])).run();
  }

  private internshipStatement(job: Internship) {
    const canonical = canonicalCatalogRecency(job);
    return this.db.prepare(`
      INSERT INTO catalog_items (
        pk, sk, kind, value, url_key, fingerprint_key, sms_pending, digest_pending,
        catalog_state, catalog_sort_key, search_text, source_classes
      ) VALUES (?, 'META', 'internship', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value,
        url_key = excluded.url_key, fingerprint_key = excluded.fingerprint_key,
        sms_pending = excluded.sms_pending, digest_pending = excluded.digest_pending,
        catalog_state = excluded.catalog_state, catalog_sort_key = excluded.catalog_sort_key,
        search_text = excluded.search_text, source_classes = excluded.source_classes
    `).bind(
      `JOB#${canonical.jobId}`,
      JSON.stringify(canonical),
      canonical.normalizedUrl,
      canonical.fingerprint,
      canonical.notification.smsPending && alertEligible(canonical) ? 1 : 0,
      canonical.notification.digestPending && alertEligible(canonical) ? 1 : 0,
      canonical.technical === false || !catalogEligible(canonical) ? null : canonical.open ? 'OPEN' : 'CLOSED',
      canonical.technical === false || !catalogEligible(canonical) ? null : canonical.open ? openCatalogSortKey(canonical) : `${canonical.lastSeenAt}#${canonical.jobId}`,
      canonical.technical === false || !catalogEligible(canonical) ? null : catalogSearchText(canonical),
      canonical.technical === false || !catalogEligible(canonical) ? null : JSON.stringify(catalogSourceClasses(canonical)),
    );
  }

  private sourceOccurrenceStatement(occurrence: SourceOccurrenceState) {
    return this.db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id)
      VALUES (?, ?, 'source-occurrence', ?, ?, ?)
      ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value,
        source_id = excluded.source_id, external_id = excluded.external_id`)
      .bind(`SOURCE#${occurrence.sourceId}`, `OCCURRENCE#${occurrence.externalId}`, JSON.stringify(occurrence), occurrence.sourceId, occurrence.externalId);
  }

  getCheckpoint(sourceId: string) { return this.get<SourceCheckpoint>(`SOURCE#${sourceId}`, 'CHECKPOINT'); }
  putCheckpoint(checkpoint: SourceCheckpoint) { return this.put(`SOURCE#${checkpoint.sourceId}`, 'CHECKPOINT', 'checkpoint', checkpoint); }
  async getCheckpointsMany(sourceIds: string[]): Promise<SourceCheckpoint[]> {
    if (!sourceIds.length) return [];
    const checkpoints: SourceCheckpoint[] = [];
    for (let offset = 0; offset < sourceIds.length; offset += 100) {
      const chunk = sourceIds.slice(offset, offset + 100);
      const rows = await this.db.prepare(`SELECT value FROM catalog_items WHERE sk = 'CHECKPOINT' AND pk IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk.map((id) => `SOURCE#${id}`)).all<JsonRow>();
      checkpoints.push(...rows.results.map((row) => JSON.parse(row.value) as SourceCheckpoint));
    }
    return checkpoints;
  }
  getSourceHealth(sourceId: string) { return this.get<SourceHealth>(`SOURCE#${sourceId}`, 'HEALTH'); }
  putSourceHealth(health: SourceHealth) { return this.put(`SOURCE#${health.sourceId}`, 'HEALTH', 'source-health', health); }
  async getSourceHealthMany(sourceIds: string[]): Promise<SourceHealth[]> {
    if (!sourceIds.length) return [];
    const health: SourceHealth[] = [];
    for (let offset = 0; offset < sourceIds.length; offset += 100) {
      const chunk = sourceIds.slice(offset, offset + 100);
      const rows = await this.db.prepare(`SELECT value FROM catalog_items WHERE sk = 'HEALTH' AND pk IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk.map((id) => `SOURCE#${id}`)).all<JsonRow>();
      health.push(...rows.results.map((row) => JSON.parse(row.value) as SourceHealth));
    }
    return health;
  }
  async getSourceDispatchesMany(sourceIds: string[]): Promise<SourceDispatch[]> {
    if (!sourceIds.length) return [];
    const dispatches: SourceDispatch[] = [];
    for (let offset = 0; offset < sourceIds.length; offset += 100) {
      const chunk = sourceIds.slice(offset, offset + 100);
      const rows = await this.db.prepare(`SELECT value FROM catalog_items WHERE sk = 'DISPATCH' AND pk IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk.map((id) => `SOURCE#${id}`)).all<JsonRow>();
      dispatches.push(...rows.results.map((row) => JSON.parse(row.value) as SourceDispatch));
    }
    return dispatches;
  }
  async putSourceDispatches(dispatches: SourceDispatch[]): Promise<void> {
    if (!dispatches.length) return;
    const statements = dispatches.map((dispatch) => this.db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value)
      VALUES (?, 'DISPATCH', 'source-dispatch', ?)
      ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value`)
      .bind(`SOURCE#${dispatch.sourceId}`, JSON.stringify(dispatch)));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
  }
  getMonitoringChecklist(period: string) { return this.get<MonitoringChecklist>('OPERATIONS#MONITORING', `CHECKLIST#${period}`); }
  putMonitoringChecklist(checklist: MonitoringChecklist) { return this.put('OPERATIONS#MONITORING', `CHECKLIST#${checklist.period}`, 'monitoring-checklist', checklist); }

  async findByUrl(url: string): Promise<Internship | undefined> {
    const job = parse<Internship>(await this.db.prepare('SELECT value FROM catalog_items WHERE url_key = ? LIMIT 1').bind(url).first<JsonRow>());
    return job && withEmployerCategory(job);
  }
  async findByFingerprint(fingerprint: string): Promise<Internship | undefined> {
    const job = parse<Internship>(await this.db.prepare('SELECT value FROM catalog_items WHERE fingerprint_key = ? LIMIT 1').bind(fingerprint).first<JsonRow>());
    return job && withEmployerCategory(job);
  }
  private async postingAliasClaims(aliases: string[]): Promise<Map<string, string>> {
    const claims = new Map<string, string>();
    for (let offset = 0; offset < aliases.length; offset += 100) {
      const chunk = aliases.slice(offset, offset + 100);
      const rows = await this.db.prepare(`SELECT value FROM catalog_items WHERE kind = 'posting-alias' AND pk IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk.map((alias) => `POSTING_ALIAS#${alias}`)).all<JsonRow>();
      for (const row of rows.results) {
        const claim = JSON.parse(row.value) as { alias: string; canonicalJobId: string };
        claims.set(claim.alias, claim.canonicalJobId);
      }
    }
    return claims;
  }
  async resolvePostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution> {
    const aliases = [...new Set(identity.aliases.map((item) => item.value))].sort();
    const resolution = resolvePostingAliases(identity, await this.postingAliasClaims(aliases));
    if (resolution.outcome === 'quarantine') return resolution;
    if (preferredJobId && preferredJobIdentityConflicts(identity, await this.getJob(preferredJobId))) {
      return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [identity.canonicalJobId, preferredJobId].sort(), reason: 'aliases-resolve-to-different-jobs' };
    }
    if (preferredJobId && resolution.outcome === 'merge' && resolution.canonicalJobId !== preferredJobId) {
      return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [resolution.canonicalJobId, preferredJobId].sort(), reason: 'aliases-resolve-to-different-jobs' };
    }
    return { ...resolution, canonicalJobId: resolution.outcome === 'create' && preferredJobId ? preferredJobId : resolution.canonicalJobId };
  }
  async claimPostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution> {
    const aliases = [...new Set(identity.aliases.map((item) => item.value))].sort();
    if (preferredJobId && preferredJobIdentityConflicts(identity, await this.getJob(preferredJobId))) {
      return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [identity.canonicalJobId, preferredJobId].sort(), reason: 'aliases-resolve-to-different-jobs' };
    }
    const initial = resolvePostingAliases(identity, await this.postingAliasClaims(aliases));
    if (initial.outcome === 'quarantine') return initial;
    if (preferredJobId && initial.outcome === 'merge' && initial.canonicalJobId !== preferredJobId) {
      return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: [initial.canonicalJobId, preferredJobId].sort(), reason: 'aliases-resolve-to-different-jobs' };
    }
    const canonicalJobId = initial.outcome === 'create' && preferredJobId ? preferredJobId : initial.canonicalJobId;
    const aliasKeys = aliases.map((alias) => `POSTING_ALIAS#${alias}`);
    const conflictingClaim = `NOT EXISTS (
      SELECT 1 FROM catalog_items
      WHERE kind = 'posting-alias'
        AND pk IN (${aliasKeys.map(() => '?').join(', ')})
        AND json_extract(value, '$.canonicalJobId') <> ?
    )`;
    // D1 batches are transactional. Every insert checks the complete alias set,
    // so a competing canonical claim prevents partial claims from poisoning the
    // remaining aliases before the verification read.
    const statements = aliases.map((alias) => this.db.prepare(`
      INSERT INTO catalog_items (pk, sk, kind, value)
      SELECT ?, 'CLAIM', 'posting-alias', ? WHERE ${conflictingClaim}
      ON CONFLICT(pk, sk) DO NOTHING
    `).bind(
      `POSTING_ALIAS#${alias}`,
      JSON.stringify({ alias, canonicalJobId, claimedAt: new Date().toISOString() }),
      ...aliasKeys,
      canonicalJobId,
    ));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    const verified = resolvePostingAliases(identity, await this.postingAliasClaims(aliases));
    if (verified.outcome === 'quarantine' || verified.canonicalJobId !== canonicalJobId) {
      const conflicts = verified.outcome === 'quarantine' ? verified.conflictingCanonicalJobIds : [verified.canonicalJobId, canonicalJobId].sort();
      return { outcome: 'quarantine', aliases, conflictingCanonicalJobIds: conflicts, reason: 'aliases-resolve-to-different-jobs' };
    }
    return { ...initial, canonicalJobId };
  }
  async commitPostingObservation(input: PostingObservationCommit): Promise<PostingObservationCommitResult> {
    if ('sourceId' in input) {
      const incident: PostingIdentityIncident = {
        incidentId: createHash('sha256').update(`identity-incident-v1:${input.sourceId}\0${input.externalId}\0${JSON.stringify(input.decision)}`).digest('hex'),
        sourceId: input.sourceId, externalId: input.externalId, decision: input.decision,
        occurrence: input.occurrence, recordedAt: input.decision.observedAt,
      };
      await this.db.prepare("INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id) VALUES (?, 'INCIDENT', 'posting-identity-incident', ?, ?, ?) ON CONFLICT(pk, sk) DO NOTHING")
        .bind(`IDENTITY_INCIDENT#${incident.incidentId}`, JSON.stringify(incident), incident.sourceId, incident.externalId).run();
      return { outcome: 'quarantined', incident };
    }
    const aliases = input.identity ? [...new Set(input.identity.aliases.map((item) => item.value))].sort() : [];
    const preview = input.identity
      ? await this.resolvePostingIdentity(input.identity, input.job.jobId)
      : { outcome: 'create' as const, aliases: [], canonicalJobId: input.job.jobId };
    if (preview.outcome === 'quarantine' || preview.canonicalJobId !== input.job.jobId) {
      const conflicts = preview.outcome === 'quarantine' ? preview.conflictingCanonicalJobIds : [preview.canonicalJobId, input.job.jobId];
      const decision: Extract<PostingIdentityDecision, { status: 'quarantined' }> = {
        status: 'quarantined', reason: preview.outcome === 'quarantine' ? preview.reason : 'aliases-resolve-to-different-jobs',
        contradictoryEvidence: [...new Set(conflicts)].sort(),
        reviewFamilyKey: input.decision.status === 'confirmed' ? input.decision.exactKey : input.decision.reviewFamilyKey,
        observedAt: input.decision.observedAt,
      };
      return this.commitPostingObservation({ decision, sourceId: input.occurrence.sourceId, externalId: input.occurrence.externalId, occurrence: input.occurrence.occurrence });
    }
    const aliasKeys = aliases.map((alias) => `POSTING_ALIAS#${alias}`);
    const conflictGuard = aliasKeys.length ? `NOT EXISTS (
      SELECT 1 FROM catalog_items WHERE kind = 'posting-alias'
        AND pk IN (${aliasKeys.map(() => '?').join(', ')})
        AND json_extract(value, '$.canonicalJobId') <> ?
    )` : '1 = 1';
    const guardValues = aliasKeys.length ? [...aliasKeys, input.job.jobId] : [];
    let results: Awaited<ReturnType<D1Database['batch']>> = [];
    let notificationInserted = false;
    let projectionCommitted = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { stored, storedOccurrence } = await this.getPostingObservationState(
        input.job.jobId,
        input.occurrence.sourceId,
        input.occurrence.externalId,
      );
      const occurrence = storedOccurrence
        ? { ...input.occurrence, occurrence: mergeSourceOccurrence(storedOccurrence.occurrence, input.occurrence.occurrence) }
        : input.occurrence;
      if (input.identity && preferredJobIdentityConflicts(input.identity, stored)) {
        const decision: Extract<PostingIdentityDecision, { status: 'quarantined' }> = {
          status: 'quarantined', reason: 'aliases-resolve-to-different-jobs',
          contradictoryEvidence: [input.identity.canonicalJobId, input.job.jobId].sort(),
          reviewFamilyKey: input.decision.status === 'confirmed' ? input.decision.exactKey : input.decision.reviewFamilyKey,
          observedAt: input.decision.observedAt,
        };
        return this.commitPostingObservation({
          decision, sourceId: input.occurrence.sourceId, externalId: input.occurrence.externalId,
          occurrence: input.occurrence.occurrence,
        });
      }
      const projected = postingObservationProjection(stored, input.job, occurrence);
      const finalized = postingObservationNotificationProjection(stored, projected, input.notificationEvent);
      const canonical = finalized.job;
      const canonicalJson = JSON.stringify(canonical);
      const expectedJson = stored ? JSON.stringify(stored) : '__posting_observation_absent__';
      const projectionGuard = "EXISTS (SELECT 1 FROM catalog_items WHERE pk = ? AND sk = 'META' AND value = ?)";
      const statements = [this.db.prepare(`
        INSERT INTO catalog_items (
          pk, sk, kind, value, url_key, fingerprint_key, sms_pending, digest_pending,
          catalog_state, catalog_sort_key, search_text, source_classes
        ) SELECT ?, 'META', 'internship', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${conflictGuard}
        ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value,
          url_key = excluded.url_key, fingerprint_key = excluded.fingerprint_key,
          sms_pending = excluded.sms_pending, digest_pending = excluded.digest_pending,
          catalog_state = excluded.catalog_state, catalog_sort_key = excluded.catalog_sort_key,
          search_text = excluded.search_text, source_classes = excluded.source_classes
        WHERE catalog_items.value = ?
      `).bind(
        `JOB#${canonical.jobId}`, canonicalJson, canonical.normalizedUrl, canonical.fingerprint,
        canonical.notification.smsPending && alertEligible(canonical) ? 1 : 0,
        canonical.notification.digestPending && alertEligible(canonical) ? 1 : 0,
        canonical.technical === false || !catalogEligible(canonical) ? null : canonical.open ? 'OPEN' : 'CLOSED',
        canonical.technical === false || !catalogEligible(canonical) ? null : canonical.open ? openCatalogSortKey(canonical) : `${canonical.lastSeenAt}#${canonical.jobId}`,
        canonical.technical === false || !catalogEligible(canonical) ? null : catalogSearchText(canonical),
        canonical.technical === false || !catalogEligible(canonical) ? null : JSON.stringify(catalogSourceClasses(canonical)),
        ...guardValues, expectedJson,
      )];
      statements.push(...aliases.map((alias) => this.db.prepare(`
        INSERT INTO catalog_items (pk, sk, kind, value)
        SELECT ?, 'CLAIM', 'posting-alias', ? WHERE ${conflictGuard} AND ${projectionGuard}
        ON CONFLICT(pk, sk) DO NOTHING
      `).bind(
        `POSTING_ALIAS#${alias}`,
        JSON.stringify({ alias, canonicalJobId: input.job.jobId, claimedAt: input.decision.observedAt }),
        ...guardValues, `JOB#${canonical.jobId}`, canonicalJson,
      )));
      statements.push(this.db.prepare(`
        INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id)
        SELECT ?, ?, 'source-occurrence', ?, ?, ? WHERE ${conflictGuard} AND ${projectionGuard}
        ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value,
          source_id = excluded.source_id, external_id = excluded.external_id
      `).bind(
        `SOURCE#${input.occurrence.sourceId}`, `OCCURRENCE#${input.occurrence.externalId}`,
        JSON.stringify(occurrence), input.occurrence.sourceId, input.occurrence.externalId,
        ...guardValues, `JOB#${canonical.jobId}`, canonicalJson,
      ));
      const shadowVerification = input.providerShadowVerification;
      if (shadowVerification?.idempotencyKey) statements.push(this.db.prepare(`
        INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id)
        SELECT ?, 'PENDING', 'provider-shadow-verification', ?, ?, ? WHERE ${conflictGuard} AND ${projectionGuard}
        ON CONFLICT(pk, sk) DO NOTHING
      `).bind(`SHADOW_HANDOFF#${shadowVerification.idempotencyKey}`, JSON.stringify(shadowVerification),
        shadowVerification.sourceId, shadowVerification.externalId,
        ...guardValues, `JOB#${canonical.jobId}`, canonicalJson));
      if (input.decision.status === 'unconfirmed') {
        const candidateId = createHash('sha256').update(`posting-review-family-v1:${input.decision.reviewFamilyKey}`).digest('hex');
        const evidenceHash = createHash('sha256').update(JSON.stringify({
          reviewFamilyKey: input.decision.reviewFamilyKey,
          reason: input.decision.reason,
        })).digest('hex');
        const candidateGuardValues = [...guardValues, `JOB#${canonical.jobId}`, canonicalJson];
        statements.push(this.db.prepare(`
          INSERT INTO posting_identity_review_candidates (
            id, review_family_key, sanitized_signature, occurrence_count, evidence_hash,
            first_observed_at, last_observed_at, state
          ) SELECT ?, ?, ?, 0, ?, ?, ?, 'open' WHERE ${conflictGuard} AND ${projectionGuard}
          ON CONFLICT(id) DO UPDATE SET
            last_observed_at = MAX(posting_identity_review_candidates.last_observed_at, excluded.last_observed_at),
            evidence_hash = excluded.evidence_hash
          WHERE posting_identity_review_candidates.state = 'open'
        `).bind(
          candidateId, input.decision.reviewFamilyKey, input.decision.reviewFamilyKey, evidenceHash,
          input.decision.observedAt, input.decision.observedAt, ...candidateGuardValues,
        ));
        statements.push(this.db.prepare(`
          INSERT INTO posting_identity_review_candidate_occurrences (
            candidate_id, source_id, external_id, first_observed_at
          ) SELECT ?, ?, ?, ? WHERE ${conflictGuard} AND ${projectionGuard}
          ON CONFLICT(candidate_id, source_id, external_id) DO NOTHING
        `).bind(
          candidateId, input.occurrence.sourceId, input.occurrence.externalId, input.decision.observedAt,
          ...candidateGuardValues,
        ));
        statements.push(this.db.prepare(`
          UPDATE posting_identity_review_candidates
          SET occurrence_count = (
            SELECT COUNT(*) FROM posting_identity_review_candidate_occurrences WHERE candidate_id = ?
          )
          WHERE id = ? AND ${conflictGuard} AND ${projectionGuard}
        `).bind(candidateId, candidateId, ...candidateGuardValues));
      }
      const notificationIndex = finalized.notificationEvent ? statements.length : -1;
      if (finalized.notificationEvent) statements.push(this.db.prepare(`
        INSERT INTO catalog_items (pk, sk, kind, value)
        SELECT ?, 'EVENT', 'notification-event', ? WHERE ${conflictGuard} AND ${projectionGuard}
        ON CONFLICT(pk, sk) DO NOTHING
      `).bind(
        `OUTBOX#${finalized.notificationEvent.eventId}`, JSON.stringify(finalized.notificationEvent),
        ...guardValues, `JOB#${canonical.jobId}`, canonicalJson,
      ));
      results = await this.db.batch(statements);
      projectionCommitted = Boolean(results[0]?.meta.changes);
      notificationInserted = Boolean(notificationIndex >= 0 && results[notificationIndex]?.meta.changes);
      if (projectionCommitted) break;
    }
    if (!projectionCommitted) throw new Error('Unable to commit posting observation projection');
    const verified = input.identity ? await this.resolvePostingIdentity(input.identity, input.job.jobId) : preview;
    if (verified.outcome === 'quarantine' || verified.canonicalJobId !== input.job.jobId) {
      const conflicts = verified.outcome === 'quarantine' ? verified.conflictingCanonicalJobIds : [verified.canonicalJobId, input.job.jobId];
      const decision: Extract<PostingIdentityDecision, { status: 'quarantined' }> = {
        status: 'quarantined', reason: verified.outcome === 'quarantine' ? verified.reason : 'aliases-resolve-to-different-jobs',
        contradictoryEvidence: [...new Set(conflicts)].sort(),
        reviewFamilyKey: input.decision.status === 'confirmed' ? input.decision.exactKey : input.decision.reviewFamilyKey,
        observedAt: input.decision.observedAt,
      };
      return this.commitPostingObservation({ decision, sourceId: input.occurrence.sourceId, externalId: input.occurrence.externalId, occurrence: input.occurrence.occurrence });
    }
    return {
      outcome: 'committed', canonicalJobId: input.job.jobId,
      notificationInserted,
    };
  }
  async putInternship(job: Internship): Promise<void> {
    await this.internshipStatement(job).run();
  }
  async getJob(jobId: string) {
    const direct = await this.get<Internship>(`JOB#${jobId}`, 'META');
    if (direct) return withEmployerCategory(direct);
    const alias = await this.get<{ canonicalJobId: string }>(`JOB_ID_ALIAS#${jobId}`, 'TARGET');
    if (!alias?.canonicalJobId || alias.canonicalJobId === jobId) return undefined;
    const canonical = await this.get<Internship>(`JOB#${alias.canonicalJobId}`, 'META');
    return canonical && withEmployerCategory(canonical);
  }
  async getSourceOccurrences(sourceId: string): Promise<SourceOccurrenceState[]> {
    // Paged by `sk` (the primary key's second column) so each statement is
    // bounded. The returned set is unchanged; only the transport is chunked.
    const occurrences: SourceOccurrenceState[] = [];
    let cursor = 'OCCURRENCE#';
    for (;;) {
      const result = await this.db.prepare(`SELECT sk, value FROM catalog_items
        WHERE pk = ? AND sk > ? AND sk LIKE 'OCCURRENCE#%'
        ORDER BY sk LIMIT ?`).bind(`SOURCE#${sourceId}`, cursor, sourceOccurrencePageSize).all<{ sk: string; value: string }>();
      for (const row of result.results) occurrences.push(JSON.parse(row.value) as SourceOccurrenceState);
      if (result.results.length < sourceOccurrencePageSize) return occurrences;
      cursor = result.results[result.results.length - 1]!.sk;
    }
  }
  /** One occurrence by key, for readers that need a single row of a large source. */
  getSourceOccurrence(sourceId: string, externalId: string): Promise<SourceOccurrenceState | undefined> {
    return this.get<SourceOccurrenceState>(`SOURCE#${sourceId}`, `OCCURRENCE#${externalId}`);
  }
  putSourceOccurrence(occurrence: SourceOccurrenceState) {
    return this.sourceOccurrenceStatement(occurrence).run().then(() => undefined);
  }
  async listPendingProviderShadowVerifications(limit = 100) {
    const result = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'provider-shadow-verification' AND sk = 'PENDING' LIMIT ?")
      .bind(Math.min(100, Math.max(1, limit)))
      .all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as NonNullable<Extract<PostingObservationCommit, { job: Internship }>['providerShadowVerification']>);
  }
  async markProviderShadowVerificationEnqueued(idempotencyKey: string) {
    await this.db.prepare("DELETE FROM catalog_items WHERE pk = ? AND sk = 'PENDING' AND kind = 'provider-shadow-verification'")
      .bind(`SHADOW_HANDOFF#${idempotencyKey}`).run();
  }
  recordRoleMetadataEvidence(jobId: string, evidence: readonly RoleMetadataEvidence[], conflicts: readonly MetadataConflict[], recordedAt: string,
    replace?: { sourceId: string; sourceClasses: readonly EvidenceSource[] }) {
    return new D1CatalogAdmissionStore(this.db).recordRoleMetadataEvidence(jobId, evidence, conflicts, recordedAt, replace);
  }
  async putAdmissionState(
    job: Internship,
    expectedReference: SourceOccurrence,
    occurrence?: SourceOccurrenceState,
    expectedOccurrence?: SourceOccurrenceState,
    notificationEvent?: NotificationEvent,
  ): Promise<boolean> {
    const canonical = canonicalCatalogRecency(job);
    const canonicalJson = JSON.stringify(canonical);
    const jobUpdate = this.db.prepare(`UPDATE catalog_items SET kind = 'internship', value = ?, url_key = ?, fingerprint_key = ?,
      sms_pending = ?, digest_pending = ?, catalog_state = ?, catalog_sort_key = ?, search_text = ?, source_classes = ?
      WHERE pk = ? AND sk = 'META' AND kind = 'internship' AND EXISTS (
        SELECT 1 FROM json_each(catalog_items.value, '$.sourceReferences') AS reference
        WHERE json_extract(reference.value, '$.sourceId') = ?
          AND json_extract(reference.value, '$.externalId') = ?
          AND json(reference.value) = json(?)
      ) AND (? IS NULL OR EXISTS (
        SELECT 1 FROM catalog_items AS expected_occurrence
        WHERE expected_occurrence.pk = ? AND expected_occurrence.sk = ? AND expected_occurrence.value = ?
      ))`).bind(
      canonicalJson,
      canonical.normalizedUrl,
      canonical.fingerprint,
      canonical.notification.smsPending && alertEligible(canonical) ? 1 : 0,
      canonical.notification.digestPending && alertEligible(canonical) ? 1 : 0,
      canonical.technical === false || !catalogEligible(canonical) ? null : canonical.open ? 'OPEN' : 'CLOSED',
      canonical.technical === false || !catalogEligible(canonical) ? null
        : canonical.open ? openCatalogSortKey(canonical) : `${canonical.lastSeenAt}#${canonical.jobId}`,
      canonical.technical === false || !catalogEligible(canonical) ? null : catalogSearchText(canonical),
      canonical.technical === false || !catalogEligible(canonical) ? null : JSON.stringify(catalogSourceClasses(canonical)),
      `JOB#${canonical.jobId}`,
      expectedReference.sourceId,
      expectedReference.externalId ?? null,
      JSON.stringify(expectedReference),
      expectedOccurrence ? JSON.stringify(expectedOccurrence) : null,
      expectedOccurrence ? `SOURCE#${expectedOccurrence.sourceId}` : '',
      expectedOccurrence ? `OCCURRENCE#${expectedOccurrence.externalId}` : '',
      expectedOccurrence ? JSON.stringify(expectedOccurrence) : '',
    );
    const statements = [jobUpdate];
    if (occurrence && expectedOccurrence) {
      statements.push(this.db.prepare(`UPDATE catalog_items SET kind = 'source-occurrence', value = ?, source_id = ?, external_id = ?
        WHERE pk = ? AND sk = ? AND kind = 'source-occurrence' AND value = ?
          AND EXISTS (SELECT 1 FROM catalog_items AS job WHERE job.pk = ? AND job.sk = 'META' AND job.value = ?)`)
        .bind(JSON.stringify(occurrence), occurrence.sourceId, occurrence.externalId,
          `SOURCE#${occurrence.sourceId}`, `OCCURRENCE#${occurrence.externalId}`, JSON.stringify(expectedOccurrence),
          `JOB#${canonical.jobId}`, canonicalJson));
    }
    if (notificationEvent) {
      statements.push(this.db.prepare(`INSERT INTO catalog_items (pk, sk, kind, value)
        SELECT ?, 'EVENT', 'notification-event', ?
        WHERE EXISTS (SELECT 1 FROM catalog_items WHERE pk = ? AND sk = 'META' AND value = ?)
        ON CONFLICT(pk, sk) DO NOTHING`)
        .bind(`OUTBOX#${notificationEvent.eventId}`, JSON.stringify(notificationEvent),
          `JOB#${canonical.jobId}`, canonicalJson));
    }
    const [result] = await this.db.batch(statements);
    return result?.meta.changes === 1;
  }
  async putInternshipWithNotificationEvent(job: Internship, event: NotificationEvent): Promise<boolean> {
    const eventStatement = this.db.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, 'EVENT', 'notification-event', ?) ON CONFLICT(pk, sk) DO NOTHING")
      .bind(`OUTBOX#${event.eventId}`, JSON.stringify(event));
    const [eventResult] = await this.db.batch([eventStatement, this.internshipStatement(job)]);
    return eventResult.meta.changes > 0;
  }
  private async pending(column: 'sms_pending' | 'digest_pending'): Promise<Internship[]> {
    const result = await this.db.prepare(`SELECT value FROM catalog_items WHERE ${column} = 1 AND catalog_state = 'OPEN'`).all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as Internship).filter((job) => alertEligible(job));
  }
  pendingSms() { return this.pending('sms_pending'); }
  pendingDigest() { return this.pending('digest_pending'); }
  async markSmsSent(jobId: string, sentAt: string) { const job = await this.getJob(jobId); if (job) { job.notification.smsPending = false; job.notification.smsSentAt = sentAt; await this.putInternship(job); } }
  async markDigested(jobIds: string[], sentAt: string) { for (const jobId of jobIds) { const job = await this.getJob(jobId); if (job) { job.notification.digestPending = false; job.notification.digestedAt = sentAt; await this.putInternship(job); } } }

  /**
   * Guarded recovery for notification events consumed while no Expo recipient
   * existed. Existing per-device receipts always win, so accepted or failed
   * deliveries are never replayed by this operation.
   */
  async recoverUndeliveredNotifications(input: {
    since: string;
    limit: number;
    apply: boolean;
    expectedCandidateJobIds?: string[];
  }): Promise<{ candidates: number; candidateJobIds: string[]; requeued: number }> {
    const result = await this.db.prepare(`
      SELECT COALESCE(
        json_extract(alias.value, '$.canonicalJobId'),
        json_extract(event.value, '$.jobId')
      ) AS jobId
      FROM catalog_items AS event
      LEFT JOIN catalog_items AS alias
        ON alias.pk = 'JOB_ID_ALIAS#' || json_extract(event.value, '$.jobId')
        AND alias.sk = 'TARGET'
        AND alias.kind = 'job-id-alias'
      JOIN catalog_items AS job
        ON job.pk = 'JOB#' || COALESCE(
          json_extract(alias.value, '$.canonicalJobId'),
          json_extract(event.value, '$.jobId')
        )
        AND job.sk = 'META'
      WHERE event.kind = 'notification-event'
        AND json_extract(event.value, '$.createdAt') >= ?
        AND job.kind = 'internship'
        AND job.catalog_state = 'OPEN'
        AND job.sms_pending = 0
        AND NOT EXISTS (
          SELECT 1 FROM user_items AS receipt
          WHERE receipt.kind = 'receipt'
            AND json_extract(receipt.value, '$.jobId') = COALESCE(
              json_extract(alias.value, '$.canonicalJobId'),
              json_extract(event.value, '$.jobId')
            )
        )
      GROUP BY job.pk
      ORDER BY MAX(json_extract(event.value, '$.createdAt')) DESC, job.pk ASC
      LIMIT ?
    `).bind(input.since, input.limit).all<{ jobId: string }>();
    const candidates = result.results.map(({ jobId }) => jobId);
    if (!input.apply) return { candidates: candidates.length, candidateJobIds: candidates, requeued: 0 };
    if (!input.expectedCandidateJobIds
      || input.expectedCandidateJobIds.length !== candidates.length
      || input.expectedCandidateJobIds.some((jobId, index) => jobId !== candidates[index])) {
      throw new Error('Notification recovery candidate set changed; preview again before applying');
    }
    const statements = candidates.map((jobId) => this.db.prepare(`
      UPDATE catalog_items
      SET value = json_set(json_remove(value, '$.notification.smsSentAt'), '$.notification.smsPending', json('true')),
          sms_pending = 1
      WHERE pk = ? AND sk = 'META' AND kind = 'internship' AND catalog_state = 'OPEN' AND sms_pending = 0
        AND NOT EXISTS (
          SELECT 1 FROM user_items AS receipt
          WHERE receipt.kind = 'receipt' AND json_extract(receipt.value, '$.jobId') = ?
        )
    `).bind(`JOB#${jobId}`, jobId));
    const updates = statements.length ? await this.db.batch(statements) : [];
    return {
      candidates: candidates.length,
      candidateJobIds: candidates,
      requeued: updates.reduce((total, update) => total + update.meta.changes, 0),
    };
  }

  async listOpen(cursor?: string, limit = 25, status: 'open' | 'closed' = 'open', query: CatalogQuery = {}): Promise<{ jobs: Internship[]; cursor?: string }> {
    const offset = cursorOffset(cursor);
    const clauses = ['catalog_state = ?'];
    const values: unknown[] = [status === 'open' ? 'OPEN' : 'CLOSED'];
    const needle = query.query?.trim().toLowerCase();
    if (needle) { clauses.push('search_text LIKE ?'); values.push(`%${needle}%`); }
    if (query.source && query.source !== 'all') { clauses.push('source_classes LIKE ?'); values.push(`%"${query.source}"%`); }
    const jobs: Internship[] = [];
    const batchSize = Math.max(50, limit * 2);
    let scanned = offset;
    while (true) {
      const result = await this.db.prepare(`SELECT value FROM catalog_items WHERE ${clauses.join(' AND ')} ORDER BY catalog_sort_key DESC LIMIT ? OFFSET ?`)
        .bind(...values, batchSize, scanned).all<JsonRow>();
      for (const row of result.results) {
        const rowOffset = scanned;
        scanned += 1;
        const job = withEmployerCategory(JSON.parse(row.value) as Internship);
        if (!catalogEligible(job) || isPastSeason(job.season)) continue;
        if (jobs.length === limit) return { jobs, cursor: String(rowOffset) };
        jobs.push(job);
      }
      if (result.results.length < batchSize) return { jobs };
    }
  }
  async listOpenSince(after: string, before: string): Promise<Internship[]> {
    const result = await this.db.prepare("SELECT value FROM catalog_items WHERE catalog_state = 'OPEN' AND catalog_sort_key > ? AND catalog_sort_key <= ? ORDER BY catalog_sort_key DESC")
      .bind(`3#${after}`, `3#${before}\uffff`).all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as Internship)
      .filter((job) => catalogEligible(job) && catalogRecency(job) === 'normal'
        && catalogVisibleAt(job) > after && catalogVisibleAt(job) <= before && !isPastSeason(job.season))
      .sort(compareCatalogRecency).map(withEmployerCategory);
  }
  async listCatalog(): Promise<Internship[]> {
    const jobs: Internship[] = [];
    let cursor: { pk: string; sk: string } | undefined;
    while (true) {
      const query = cursor
        ? this.db.prepare(`SELECT pk, sk, value FROM catalog_items
            WHERE kind = 'internship' AND (pk > ? OR (pk = ? AND sk > ?))
            ORDER BY pk, sk LIMIT 100`).bind(cursor.pk, cursor.pk, cursor.sk)
        : this.db.prepare("SELECT pk, sk, value FROM catalog_items WHERE kind = 'internship' ORDER BY pk, sk LIMIT 100");
      const page = await query.all<{ pk: string; sk: string; value: string }>();
      for (const row of page.results) {
        const job = JSON.parse(row.value) as Internship;
        if (job.technical !== false && catalogEligible(job) && !isPastSeason(job.season)) jobs.push(job);
      }
      if (page.results.length < 100) break;
      const last = page.results.at(-1)!;
      cursor = { pk: last.pk, sk: last.sk };
    }
    return jobs
      .sort(compareCatalogRecency).map(withEmployerCategory);
  }
  async putCatalogProjection(groups: CatalogGroupDetails[], generatedAt: string): Promise<void> {
    const previous = await this.get<{ version: string }>('CATALOG_PROJECTION', 'CURRENT');
    const version = createHash('sha256').update(`${generatedAt}\0${groups.map((group) => group.group.groupId).join('\0')}`).digest('hex').slice(0, 20);
    // One `batch()` is a single RPC call carrying every statement's bound value,
    // and Cloudflare refuses a serialized argument over 32 MiB. The projection is
    // a copy of the whole catalog, so neither a row count nor a statement count
    // bounds the write: it crossed the ceiling in production and every refresh
    // failed here, freezing the feed on the last good version. Rows are grouped
    // into statements and statements into one `batch()` by payload bytes instead,
    // budgeted well below the ceiling because the RPC envelope can inflate the
    // JSON it carries. See docs/197-ingestion-resource-bounds.md.
    const pending: D1PreparedStatement[] = [];
    let pendingBytes = 0;
    let rows: Array<{ sk: string; value: string; sortKey: string }> = [];
    let rowsBytes = 0;
    const flush = async () => {
      if (!pending.length) return;
      await this.db.batch(pending.splice(0, pending.length));
      pendingBytes = 0;
    };
    const writeRows = async () => {
      if (!rows.length) return;
      const written = rows; const writtenBytes = rowsBytes;
      rows = []; rowsBytes = 0;
      if (pending.length && pendingBytes + writtenBytes > CATALOG_PROJECTION_BATCH_BYTES) await flush();
      const placeholders = written.map(() => `(?, ?, 'catalog-projection', ?, ?)`).join(', ');
      pending.push(this.db.prepare(`
        INSERT INTO catalog_items (pk, sk, kind, value, catalog_sort_key) VALUES ${placeholders}
        ON CONFLICT(pk, sk) DO UPDATE SET value = excluded.value, catalog_sort_key = excluded.catalog_sort_key
      `).bind(...written.flatMap((row) => [`CATALOG_PROJECTION#${version}`, row.sk, row.value, row.sortKey])));
      pendingBytes += writtenBytes;
    };
    for (let index = 0; index < groups.length; index += 1) {
      const value = JSON.stringify(groups[index]);
      const row = { sk: `GROUP#${groups[index]!.group.groupId}`, value, sortKey: String(index).padStart(8, '0') };
      const rowBytes = value.length + row.sk.length + 96;
      // A statement binds four parameters per row, so D1's 100-parameter
      // allowance caps the row count as well as the payload.
      if (rows.length && (rows.length >= 25 || rowsBytes + rowBytes > CATALOG_PROJECTION_STATEMENT_BYTES)) await writeRows();
      rows.push(row); rowsBytes += rowBytes;
    }
    await writeRows();
    await flush();
    await this.put('CATALOG_PROJECTION', 'CURRENT', 'catalog-projection-pointer', { version, generatedAt, schemaVersion: 4 });
    // Projection versions are rebuildable caches. Deleting only the version
    // observed before this refresh keeps overlapping refreshes from deleting
    // whichever version wins the pointer race.
    if (previous?.version && previous.version !== version) {
      await this.db.prepare("DELETE FROM catalog_items WHERE kind = 'catalog-projection' AND pk = ?")
        .bind(`CATALOG_PROJECTION#${previous.version}`).run();
    }
  }
  async listCatalogProjection(cursor?: string, limit = 25): Promise<CatalogProjectionPage | undefined> {
    const pointer = await this.get<{ version: string; generatedAt: string; schemaVersion: number }>('CATALOG_PROJECTION', 'CURRENT');
    if (!pointer || pointer.schemaVersion !== 4 || Date.now() - Date.parse(pointer.generatedAt) > catalogProjectionMaxAgeMs) return undefined;
    const offset = cursorOffset(cursor);
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND kind = 'catalog-projection' ORDER BY catalog_sort_key ASC LIMIT ? OFFSET ?")
      .bind(`CATALOG_PROJECTION#${pointer.version}`, limit + 1, offset).all<JsonRow>();
    const groups = rows.results.slice(0, limit).map((row) => JSON.parse(row.value) as CatalogGroupDetails);
    return { groups, ...(rows.results.length > limit ? { cursor: String(offset + limit) } : {}) };
  }
  async listCatalogProjectionFiltered(cursor: string | undefined, limit: number, filter: CatalogGroupFilter): Promise<CatalogProjectionPage | undefined> {
    const pointer = await this.get<{ version: string; generatedAt: string; schemaVersion: number }>('CATALOG_PROJECTION', 'CURRENT');
    if (!pointer || pointer.schemaVersion !== 4 || Date.now() - Date.parse(pointer.generatedAt) > catalogProjectionMaxAgeMs) return undefined;
    const offset = cursorOffset(cursor);
    const roleClauses = ["json_extract(role.value, '$.open') = ?"];
    const values: unknown[] = [filter.status === 'closed' ? 0 : 1];
    if (filter.query?.trim()) {
      roleClauses.push(`lower(
        coalesce(json_extract(role.value, '$.company'), '') || ' ' ||
        coalesce(json_extract(role.value, '$.title'), '') || ' ' ||
        coalesce(json_extract(role.value, '$.location'), '') || ' ' ||
        coalesce(json_extract(role.value, '$.season'), '')
      ) LIKE ? ESCAPE '\\'`);
      values.push(likePattern(filter.query.trim()));
    }
    if (filter.source && filter.source !== 'all') {
      const credibility = filter.source === 'direct'
        ? ['official', 'corroborated']
        : filter.source === 'community'
          ? ['community', 'corroborated']
          : ['corroborated'];
      roleClauses.push(`json_extract(role.value, '$.sourceCredibility') IN (${placeholders(credibility)})`);
      values.push(...credibility);
    }
    if (filter.employerCategories?.length) {
      roleClauses.push(`json_extract(role.value, '$.employerCategory') IN (${placeholders(filter.employerCategories)})`);
      values.push(...filter.employerCategories);
    }
    if (filter.hideUsCitizenshipRequired) roleClauses.push("coalesce(json_extract(role.value, '$.requiresUsCitizenship'), 0) = 0");
    if (filter.hideAdvancedDegreeRequired) roleClauses.push("coalesce(json_extract(role.value, '$.advancedDegreeRequired'), 0) = 0");
    if (filter.postingIdentityConfirmedOnly) roleClauses.push("coalesce(json_extract(role.value, '$.postingIdentityStatus'), 'legacy') <> 'unconfirmed'");
    if (filter.hasCompensation) roleClauses.push("trim(coalesce(json_extract(role.value, '$.compensation.raw'), '')) <> ''");
    const exactArrayFilter = (path: string, requested: string[]) => {
      const normalized = requested.map((value) => value.toLowerCase());
      roleClauses.push(`EXISTS (SELECT 1 FROM json_each(role.value, '${path}') AS item WHERE lower(item.value) IN (${placeholders(normalized)}))`);
      values.push(...normalized);
    };
    if (filter.disciplines?.length) {
      const expanded = [...new Set(filter.disciplines.flatMap(disciplineSearchVariants).map((value) => value.toLowerCase()))];
      exactArrayFilter('$.disciplines', expanded);
    }
    if (filter.seasons?.length) {
      const normalized = filter.seasons.map((value) => value.toLowerCase());
      roleClauses.push(`lower(json_extract(role.value, '$.season')) IN (${placeholders(normalized)})`);
      values.push(...normalized);
    }
    if (filter.educationLevels?.length) {
      const normalized = filter.educationLevels.map((value) => value.toLowerCase());
      roleClauses.push(`(
        json_extract(role.value, '$.education.evidence') = 'unspecified'
        OR EXISTS (SELECT 1 FROM json_each(role.value, '$.education.levels') AS level WHERE lower(level.value) IN (${placeholders(normalized)}))
      )`);
      values.push(...normalized);
    }
    if (filter.workModes?.length) exactArrayFilter('$.workModes', filter.workModes);
    if (filter.locations?.length) {
      const patterns = filter.locations.map(likePattern);
      const searchableLocations = `CASE
        WHEN json_type(role.value, '$.locations') = 'array' THEN coalesce((
          SELECT group_concat(location.value, ' ')
          FROM json_each(role.value, '$.locations') AS location
        ), '')
        ELSE coalesce(json_extract(role.value, '$.location'), '')
      END`;
      roleClauses.push(`(${patterns.map(() => `lower(${searchableLocations}) LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      values.push(...patterns);
    }
    const rows = await this.db.prepare(`
      SELECT projection.value
      FROM catalog_items AS projection
      WHERE projection.pk = ?
        AND projection.kind = 'catalog-projection'
        AND EXISTS (
          SELECT 1 FROM json_each(projection.value, '$.roles') AS role
          WHERE ${roleClauses.join('\n            AND ')}
        )
      ORDER BY projection.catalog_sort_key ASC
      LIMIT ? OFFSET ?
    `).bind(`CATALOG_PROJECTION#${pointer.version}`, ...values, limit + 1, offset).all<JsonRow>();
    const candidates = rows.results.slice(0, limit).map((row) => JSON.parse(row.value) as CatalogGroupDetails);
    const groups = filterCatalogGroupDetails(candidates, filter);
    return { groups, ...(rows.results.length > limit ? { cursor: String(offset + limit) } : {}) };
  }
  async getCatalogProjectionGroup(groupId: string): Promise<CatalogGroupDetails | undefined> {
    const pointer = await this.get<{ version: string; generatedAt: string; schemaVersion: number }>('CATALOG_PROJECTION', 'CURRENT');
    if (!pointer || pointer.schemaVersion !== 4 || Date.now() - Date.parse(pointer.generatedAt) > catalogProjectionMaxAgeMs) return undefined;
    return this.get<CatalogGroupDetails>(`CATALOG_PROJECTION#${pointer.version}`, `GROUP#${groupId}`);
  }
  async listLeverAdmissions(): Promise<LeverAdmission[]> {
    const result = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = 'REGISTRY#LEVER' AND sk LIKE 'SOURCE#%'").all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as LeverAdmission);
  }
  async putLeverAdmission(admission: LeverAdmission): Promise<void> {
    const result = await this.db.prepare("INSERT INTO catalog_items (pk, sk, kind, value) VALUES ('REGISTRY#LEVER', ?, 'lever-admission', ?) ON CONFLICT(pk, sk) DO NOTHING")
      .bind(`SOURCE#${admission.source.site}`, JSON.stringify(admission)).run();
    if (result.meta.changes === 0) throw new Error(`Lever site ${admission.source.site} is already admitted`);
  }
}

export class D1UserStore implements UserStore {
  constructor(private readonly db: D1Database) {}

  private deletionOwner(userId: string) { return deletedUserTombstoneKey(userId).pk; }
  async beginUserDeletion(userId: string): Promise<void> {
    await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value)
      VALUES (?, 'TOMBSTONE', 'deleted-user-tombstone', '{}')
      ON CONFLICT(user_id, item_key) DO NOTHING
    `).bind(this.deletionOwner(userId)).run();
  }
  async isUserDeletionPending(userId: string): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 AS present FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE'")
      .bind(this.deletionOwner(userId)).first<{ present: number }>());
  }
  async beginDocumentUpload(userId: string, documentId: string, leaseId: string, now = new Date()): Promise<boolean> {
    const expires = Math.floor(now.getTime() / 1_000) + documentUploadLeaseSeconds;
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, expires_at)
      SELECT ?, ?, 'document-upload', ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
      WHERE user_items.expires_at <= ?
    `).bind(userId, `DOCUMENT_UPLOAD#${documentId}`, JSON.stringify(leaseId), expires, this.deletionOwner(userId), Math.floor(now.getTime() / 1_000)).run();
    return result.meta.changes > 0;
  }
  async finishDocumentUpload(userId: string, documentId: string, leaseId: string): Promise<void> {
    await this.db.prepare('DELETE FROM user_items WHERE user_id = ? AND item_key = ? AND value = ?')
      .bind(userId, `DOCUMENT_UPLOAD#${documentId}`, JSON.stringify(leaseId)).run();
  }
  async hasActiveDocumentUploads(userId: string, now = new Date()): Promise<boolean> {
    return Boolean(await this.db.prepare("SELECT 1 AS present FROM user_items WHERE user_id = ? AND kind = 'document-upload' AND expires_at > ? LIMIT 1")
      .bind(userId, Math.floor(now.getTime() / 1_000)).first<{ present: number }>());
  }

  private async get<T>(userId: string, key: string): Promise<T | undefined> {
    return parse<T>(await this.db.prepare('SELECT value FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, key).first<JsonRow>());
  }
  private async put(userId: string, key: string, kind: string, value: unknown, columns: Record<string, string | number | null> = {}): Promise<void> {
    const names = Object.keys(columns);
    const updates = ['kind = excluded.kind', 'value = excluded.value', ...names.map((name) => `${name} = excluded.${name}`)].join(', ');
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value${names.length ? `, ${names.join(', ')}` : ''})
      SELECT ${Array.from({ length: 4 + names.length }, () => '?').join(', ')}
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO UPDATE SET ${updates}
    `).bind(userId, key, kind, JSON.stringify(value), ...names.map((name) => columns[name]), this.deletionOwner(userId)).run();
    if (result.meta.changes === 0) throw new Error('Account deletion is in progress');
  }
  private async list<T>(userId: string, prefix: string): Promise<T[]> {
    const result = await this.db.prepare('SELECT value FROM user_items WHERE user_id = ? AND item_key LIKE ?').bind(userId, `${prefix}%`).all<JsonRow>();
    return result.results.map((row) => JSON.parse(row.value) as T);
  }
  getPreferences(userId: string) { return this.get<UserPreferences>(userId, 'PREFERENCES'); }
  putPreferences(value: UserPreferences) { return this.put(value.userId, 'PREFERENCES', 'preferences', value); }
  async activePreferences(): Promise<UserPreferences[]> {
    const rows = await this.db.prepare("SELECT value FROM user_items WHERE kind = 'preferences' AND json_extract(value, '$.alertsEnabled') = 1 AND json_extract(value, '$.onboardingComplete') = 1").all<JsonRow>();
    return rows.results.map((row) => JSON.parse(row.value) as UserPreferences);
  }
  async activeDevices(): Promise<DeviceToken[]> { const rows = await this.db.prepare('SELECT value FROM user_items WHERE active_device = 1').all<JsonRow>(); return rows.results.map((row) => JSON.parse(row.value) as DeviceToken); }
  async putDevice(value: DeviceToken) {
    // One Expo token represents one physical installation. Transfer a token
    // away from any legacy account owner before assigning it to the anonymous
    // installation so the same phone cannot receive duplicate alerts.
    const results = await this.db.batch([
      this.db.prepare(`
        DELETE FROM user_items WHERE kind = 'device' AND device_token = ? AND user_id <> ?
          AND NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      `).bind(value.token, value.userId, this.deletionOwner(value.userId)),
      this.db.prepare(`
        INSERT INTO user_items (user_id, item_key, kind, value, active_device, device_token)
        SELECT ?, ?, 'device', ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
        ON CONFLICT(user_id, item_key) DO UPDATE SET
          kind = excluded.kind,
          value = excluded.value,
          active_device = excluded.active_device,
          device_token = excluded.device_token
      `).bind(value.userId, `DEVICE#${value.token}`, JSON.stringify(value), value.active ? 1 : 0, value.token, this.deletionOwner(value.userId)),
    ]);
    if (results[1]?.meta.changes === 0) throw new Error('Account deletion is in progress');
  }
  async deleteDevice(userId: string, token: string) { await this.db.prepare('DELETE FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, `DEVICE#${token}`).run(); }
  getProfile(userId: string) { return this.get<ApplicantProfile>(userId, 'PROFILE'); }
  putProfile(value: ApplicantProfile) { return this.put(value.userId, 'PROFILE', 'profile', value); }
  async listApplications(userId: string) { return (await this.list<ApplicationRecord>(userId, 'APPLICATION#')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  getApplication(userId: string, applicationId: string) { return this.get<ApplicationRecord>(userId, `APPLICATION#${applicationId}`); }
  putApplication(userId: string, value: ApplicationRecord) { return this.put(userId, `APPLICATION#${value.applicationId}`, 'application', value); }
  async deleteApplication(userId: string, applicationId: string) { await this.db.prepare('DELETE FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, `APPLICATION#${applicationId}`).run(); }
  getApplicationSession(userId: string, sessionId: string) { return this.get<ApplicationSession>(userId, `APPLICATION_SESSION#${sessionId}`); }
  async getApplicationSessionById(sessionId: string) { return parse<ApplicationSession>(await this.db.prepare('SELECT value FROM user_items WHERE session_id = ? LIMIT 1').bind(sessionId).first<JsonRow>()); }
  async putApplicationSession(userId: string, value: ApplicationSession, expectedVersion?: number): Promise<boolean> {
    const key = `APPLICATION_SESSION#${value.sessionId}`;
    const active = !['submitted', 'failed', 'cancelled'].includes(value.status) ? value.sessionId : null;
    const expires = Math.floor(new Date(value.metadataExpiresAt).getTime() / 1000);
    if (expectedVersion === undefined) {
      const result = await this.db.prepare(`
        INSERT INTO user_items (user_id, item_key, kind, value, session_id, expires_at)
        SELECT ?, ?, 'application-session', ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
        ON CONFLICT(user_id, item_key) DO NOTHING
      `).bind(userId, key, JSON.stringify(value), active, expires, this.deletionOwner(userId)).run();
      return result.meta.changes > 0;
    }
    const result = await this.db.prepare(`
      UPDATE user_items SET value = ?, session_id = ?, expires_at = ?
      WHERE user_id = ? AND item_key = ? AND CAST(json_extract(value, '$.version') AS INTEGER) = ?
        AND NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
    `).bind(JSON.stringify(value), active, expires, userId, key, expectedVersion, this.deletionOwner(userId)).run();
    return result.meta.changes > 0;
  }
  async listApplicationSessions(userId: string, applicationId?: string) { return (await this.list<ApplicationSession>(userId, 'APPLICATION_SESSION#')).filter((session) => !applicationId || session.applicationId === applicationId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  listDocuments(userId: string) { return this.list<UserDocument>(userId, 'DOCUMENT#'); }
  async putDocument(value: UserDocument): Promise<void> {
    const key = `DOCUMENT#${value.documentId}`;
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value)
      SELECT ?, ?, 'document', ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
        AND (EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = ?)
         OR ((SELECT COUNT(*) FROM user_items WHERE kind = 'document') < 100
         AND (SELECT COUNT(*) FROM user_items WHERE kind = 'document' AND user_id = ?) < 5))
      ON CONFLICT(user_id, item_key) DO UPDATE SET value = excluded.value
    `).bind(value.userId, key, JSON.stringify(value), this.deletionOwner(value.userId), value.userId, key, value.userId).run();
    if (result.meta.changes === 0) throw new Error(await this.isUserDeletionPending(value.userId) ? 'Account deletion is in progress' : 'Document storage quota reached');
  }
  async claimDocumentUpload(period: string): Promise<boolean> {
    const result = await this.db.prepare(`
      INSERT INTO usage_counters (period, metric, count) VALUES (?, 'r2_upload', 1)
      ON CONFLICT(period, metric) DO UPDATE SET count = count + 1 WHERE count < 1000
    `).bind(period).run();
    return result.meta.changes > 0;
  }
  async deleteDocument(userId: string, documentId: string) { await this.db.prepare('DELETE FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, `DOCUMENT#${documentId}`).run(); }
  getReceipt(userId: string, dedupeKey: string, token: string) { return this.get<DeliveryReceipt>(userId, `RECEIPT#${dedupeKey}#${token}`); }
  async claimReceipt(value: DeliveryReceipt): Promise<boolean> {
    const key = `RECEIPT#${value.dedupeKey ?? value.jobId}#${value.token}`;
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, receipt_state, expires_at)
      SELECT ?, ?, 'receipt', ?, 'PENDING', ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO UPDATE SET value = excluded.value, receipt_state = excluded.receipt_state, expires_at = excluded.expires_at
      WHERE json_extract(user_items.value, '$.status') = 'error'
    `).bind(value.userId, key, JSON.stringify(value), receiptExpiry(value), this.deletionOwner(value.userId)).run();
    return result.meta.changes > 0;
  }
  putReceipt(value: DeliveryReceipt) { return this.put(value.userId, `RECEIPT#${value.dedupeKey ?? value.jobId}#${value.token}`, 'receipt', value, { receipt_state: value.status === 'pending' ? 'PENDING' : value.status === 'retryable' ? 'RETRYABLE' : null, expires_at: receiptExpiry(value) }); }
  async migrateReceipt(value: DeliveryReceipt, dedupeKey: string): Promise<boolean> {
    const migrated = { ...value, dedupeKey };
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, receipt_state, expires_at)
      SELECT ?, ?, 'receipt', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO NOTHING
    `).bind(value.userId, `RECEIPT#${dedupeKey}#${value.token}`, JSON.stringify(migrated), value.status === 'pending' ? 'PENDING' : value.status === 'retryable' ? 'RETRYABLE' : null, receiptExpiry(migrated), this.deletionOwner(value.userId)).run();
    return result.meta.changes > 0;
  }
  async pendingReceipts() { const rows = await this.db.prepare("SELECT value FROM user_items WHERE receipt_state = 'PENDING'").all<JsonRow>(); return rows.results.map((row) => JSON.parse(row.value) as DeliveryReceipt); }
  async retryableReceipts() { const rows = await this.db.prepare("SELECT value FROM user_items WHERE receipt_state = 'RETRYABLE'").all<JsonRow>(); return rows.results.map((row) => JSON.parse(row.value) as DeliveryReceipt); }
  async deleteUser(userId: string): Promise<UserDocument[]> { await this.beginUserDeletion(userId); const documents = await this.listDocuments(userId); await this.db.prepare('DELETE FROM user_items WHERE user_id = ?').bind(userId).run(); return documents; }
}

export class D1ReleaseStore implements ReleaseStore {
  constructor(private readonly db: D1Database) {}

  async getRelease(userId: string, releaseId: string): Promise<CatalogRelease | undefined> {
    return parse<CatalogRelease>(await this.db.prepare('SELECT value FROM user_items WHERE user_id = ? AND item_key = ?').bind(userId, `RELEASE#${releaseId}`).first<JsonRow>());
  }

  async putRelease(release: CatalogRelease): Promise<void> {
    const deletionOwner = deletedUserTombstoneKey(release.userId).pk;
    const result = await this.db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value)
      SELECT ?, ?, 'catalog-release', ?
      WHERE NOT EXISTS (SELECT 1 FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE')
      ON CONFLICT(user_id, item_key) DO NOTHING
    `).bind(release.userId, `RELEASE#${release.releaseId}`, JSON.stringify(release), deletionOwner).run();
    if (result.meta.changes > 0) return;
    const existing = await this.getRelease(release.userId, release.releaseId);
    if (!existing && await this.db.prepare("SELECT 1 AS present FROM user_items WHERE user_id = ? AND item_key = 'TOMBSTONE'").bind(deletionOwner).first()) return;
    if (JSON.stringify(existing) !== JSON.stringify(release)) throw new Error(`Release identity conflict for ${release.releaseId}`);
  }
}
