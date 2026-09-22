import { createHash } from 'node:crypto';
import { isPastSeason } from './core/early-career.js';
import { employerCategory } from './core/employers.js';
import { canonicalCatalogRecency, catalogRecency, catalogVisibleAt, compareCatalogRecency } from './catalog-recency.js';
import { catalogSearchText, catalogSourceClasses, type CatalogSource } from './catalog-fields.js';
import type { ApplicantProfile, ApplicationRecord, DeliveryReceipt, DeviceToken, EvidenceSource, Internship, MetadataConflict, MonitoringChecklist, NotificationEvent, PostingIdentity, PostingIdentityDecision, PostingIdentityIncident, RoleMetadataEvidence, SourceCheckpoint, SourceHealth, SourceOccurrence, SourceOccurrenceState, UserDocument, UserPreferences } from './types.js';
import type { ImportedJob, ResumeBankItem, ResumeDraft, ResumeProfile } from './resume.js';
import { preferredJobIdentityConflicts, resolvePostingAliases, type AliasResolution } from './identity/posting.js';
import type { ApplicationSession } from './application-automation.js';
import type { ReviewedLeverSource } from './sources/lever-config.js';
import type { LeverOwnershipEvidence } from './sources/lever-evidence.js';
import type { LeverCandidateProbeResult } from './sources/lever-probe.js';
import { filterCatalogGroupDetails, type CatalogGroupDetails, type CatalogGroupFilter, type CatalogGroupRole, type CatalogProjectionPage, type CatalogRelease } from './catalog-groups.js';
import { alertEligible, catalogEligible } from './catalog-admission.js';
import { postingObservationNotificationProjection, postingObservationProjection } from './identity/projection.js';
import type { DestinationVerificationRequest } from './destination-verification.js';

export interface LeverAdmission {
  source: ReviewedLeverSource;
  evidence: LeverOwnershipEvidence;
  probe: LeverCandidateProbeResult & { state: 'ok' };
  acceptedAt: string;
  acceptedBy: string;
}

function withEmployerCategory(job: Internship): Internship {
  const canonical = canonicalCatalogRecency(structuredClone(job));
  return { ...canonical, employerCategory: canonical.employerCategory ?? employerCategory(canonical.company) };
}


/** Opaque marker that prevents queued delivery work from recreating a deleted account. */
export function deletedUserTombstoneKey(userId: string) {
  return { pk: `DELETED_USER#${createHash('sha256').update(userId).digest('hex')}`, sk: 'TOMBSTONE' } as const;
}

export type { CatalogSource } from './catalog-fields.js';
export type CatalogQuery = { query?: string; source?: CatalogSource };

export type PostingObservationCommit =
  | {
      decision: Exclude<PostingIdentityDecision, { status: 'quarantined' }>;
      identity?: PostingIdentity;
      job: Internship;
      occurrence: SourceOccurrenceState;
      notificationEvent?: NotificationEvent;
      providerShadowVerification?: DestinationVerificationRequest;
    }
  | {
      decision: Extract<PostingIdentityDecision, { status: 'quarantined' }>;
      sourceId: string;
      externalId: string;
      occurrence: SourceOccurrence;
    };

export type PostingObservationCommitResult =
  | { outcome: 'committed'; canonicalJobId: string; notificationInserted: boolean }
  | { outcome: 'quarantined'; incident: PostingIdentityIncident };

export interface InternshipStore {
  getCheckpoint(sourceId: string): Promise<SourceCheckpoint | undefined>;
  getCheckpointsMany(sourceIds: string[]): Promise<SourceCheckpoint[]>;
  putCheckpoint(checkpoint: SourceCheckpoint): Promise<void>;
  getSourceHealth(sourceId: string): Promise<SourceHealth | undefined>;
  getSourceHealthMany(sourceIds: string[]): Promise<SourceHealth[]>;
  putSourceHealth(health: SourceHealth): Promise<void>;
  getMonitoringChecklist(period: string): Promise<MonitoringChecklist | undefined>;
  putMonitoringChecklist(checklist: MonitoringChecklist): Promise<void>;
  findByUrl(url: string): Promise<Internship | undefined>;
  findByFingerprint(fingerprint: string): Promise<Internship | undefined>;
  /** Atomically claims every exact posting alias, converging concurrent sources on one job. */
  claimPostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution>;
  /** Read-only identity preview. The commit revalidates this decision at the transaction boundary. */
  resolvePostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution>;
  /** Atomically claims aliases and writes the occurrence projection plus deterministic outbox event. */
  commitPostingObservation(input: PostingObservationCommit): Promise<PostingObservationCommitResult>;
  listPendingProviderShadowVerifications?(limit?: number): Promise<DestinationVerificationRequest[]>;
  markProviderShadowVerificationEnqueued?(idempotencyKey: string): Promise<void>;
  putInternship(job: Internship): Promise<void>;
  getJob(jobId: string): Promise<Internship | undefined>;
  getSourceOccurrences(sourceId: string): Promise<SourceOccurrenceState[]>;
  /** One occurrence by key, for readers that need a single row of a large source. */
  getSourceOccurrence(sourceId: string, externalId: string): Promise<SourceOccurrenceState | undefined>;
  putSourceOccurrence(occurrence: SourceOccurrenceState): Promise<void>;
  /** Append-only audit history; current evidence is selected by source/artifact slot. */
  recordRoleMetadataEvidence?(jobId: string, evidence: readonly RoleMetadataEvidence[], conflicts: readonly MetadataConflict[], recordedAt: string,
    replace?: { sourceId: string; sourceClasses: readonly EvidenceSource[] }): Promise<void>;
  /** Atomically exposes a notification-pending job and records its deterministic outbox event. */
  putInternshipWithNotificationEvent(job: Internship, event: NotificationEvent): Promise<boolean>;
  pendingSms(): Promise<Internship[]>;
  pendingDigest(): Promise<Internship[]>;
  markSmsSent(jobIds: string, sentAt: string): Promise<void>;
  markDigested(jobIds: string[], sentAt: string): Promise<void>;
  listOpen?(cursor?: string, limit?: number, status?: 'open' | 'closed', query?: CatalogQuery): Promise<{ jobs: Internship[]; cursor?: string }>;
  /** Complete current-season catalog used to build stable grouped rows before role-level filters are applied. */
  listCatalog?(): Promise<Internship[]>;
  putCatalogProjection?(groups: CatalogGroupDetails[], generatedAt: string): Promise<void>;
  listCatalogProjection?(cursor?: string, limit?: number): Promise<CatalogProjectionPage | undefined>;
  /** Uses the backing store's query engine to avoid sequential projection scans for filtered catalog pages. */
  listCatalogProjectionFiltered?(cursor: string | undefined, limit: number, filter: CatalogGroupFilter): Promise<CatalogProjectionPage | undefined>;
  /** Reads only matching projected roles for release-day indexes, bounded to the requested calendar range. */
  listCatalogProjectionRoles?(filter: CatalogGroupFilter, range: { from?: string; to?: string }): Promise<CatalogGroupRole[] | undefined>;
  getCatalogProjectionGroup?(groupId: string): Promise<CatalogGroupDetails | undefined>;
  listLeverAdmissions?(): Promise<LeverAdmission[]>;
  putLeverAdmission?(admission: LeverAdmission): Promise<void>;
  /** Normal-recency open technical roles made catalog-visible in `(after, before]`. */
  listOpenSince(after: string, before: string): Promise<Internship[]>;
}

export class MemoryInternshipStore implements InternshipStore {
  readonly jobs = new Map<string, Internship>();
  readonly checkpoints = new Map<string, SourceCheckpoint>();
  readonly occurrences = new Map<string, SourceOccurrenceState>();
  readonly notificationEvents = new Map<string, NotificationEvent>();
  readonly sourceHealth = new Map<string, SourceHealth>();
  readonly monitoringChecklists = new Map<string, MonitoringChecklist>();
  readonly leverAdmissions = new Map<string, LeverAdmission>();
  readonly postingAliases = new Map<string, string>();
  readonly postingIdentityIncidents = new Map<string, PostingIdentityIncident>();
  readonly postingIdentityReviewCandidates = new Map<string, {
    reviewFamilyKey: string; occurrenceKeys: Set<string>; firstObservedAt: string; lastObservedAt: string;
  }>();
  readonly roleMetadataEvidence = new Map<string, RoleMetadataEvidence>();
  readonly roleMetadataConflicts = new Map<string, MetadataConflict[]>();
  readonly providerShadowVerifications = new Map<string, DestinationVerificationRequest>();
  catalogProjection?: { generatedAt: string; groups: CatalogGroupDetails[] };
  async getCheckpoint(sourceId: string) { return this.checkpoints.get(sourceId); }
  async getCheckpointsMany(sourceIds: string[]) { return sourceIds.map((id) => this.checkpoints.get(id)).filter((value): value is SourceCheckpoint => Boolean(value)); }
  async putCheckpoint(checkpoint: SourceCheckpoint) { this.checkpoints.set(checkpoint.sourceId, checkpoint); }
  async getSourceHealth(sourceId: string) { return this.sourceHealth.get(sourceId); }
  async getSourceHealthMany(sourceIds: string[]) { return sourceIds.map((id) => this.sourceHealth.get(id)).filter((value): value is SourceHealth => Boolean(value)); }
  async putSourceHealth(health: SourceHealth) { this.sourceHealth.set(health.sourceId, structuredClone(health)); }
  async getMonitoringChecklist(period: string) { return structuredClone(this.monitoringChecklists.get(period)); }
  async putMonitoringChecklist(checklist: MonitoringChecklist) { this.monitoringChecklists.set(checklist.period, structuredClone(checklist)); }
  async findByUrl(url: string) { const job = [...this.jobs.values()].find((item) => item.normalizedUrl === url); return job && withEmployerCategory(job); }
  async findByFingerprint(fingerprint: string) { const job = [...this.jobs.values()].find((item) => item.fingerprint === fingerprint); return job && withEmployerCategory(job); }
  async resolvePostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution> {
    const resolution = resolvePostingAliases(identity, this.postingAliases);
    if (resolution.outcome === 'quarantine') return resolution;
    if (preferredJobId && preferredJobIdentityConflicts(identity, this.jobs.get(preferredJobId))) {
      return {
        outcome: 'quarantine', aliases: resolution.aliases,
        conflictingCanonicalJobIds: [identity.canonicalJobId, preferredJobId].sort(),
        reason: 'aliases-resolve-to-different-jobs',
      };
    }
    if (preferredJobId && resolution.outcome === 'merge' && resolution.canonicalJobId !== preferredJobId) {
      return {
        outcome: 'quarantine', aliases: resolution.aliases,
        conflictingCanonicalJobIds: [resolution.canonicalJobId, preferredJobId].sort(),
        reason: 'aliases-resolve-to-different-jobs',
      };
    }
    const canonicalJobId = resolution.outcome === 'create' && preferredJobId ? preferredJobId : resolution.canonicalJobId;
    return { ...resolution, canonicalJobId };
  }
  async claimPostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution> {
    const resolution = await this.resolvePostingIdentity(identity, preferredJobId);
    if (resolution.outcome !== 'quarantine') for (const alias of resolution.aliases) this.postingAliases.set(alias, resolution.canonicalJobId);
    return resolution;
  }
  async commitPostingObservation(input: PostingObservationCommit): Promise<PostingObservationCommitResult> {
    if ('sourceId' in input) {
      const incident: PostingIdentityIncident = {
        incidentId: createHash('sha256').update(`identity-incident-v1:${input.sourceId}\0${input.externalId}\0${JSON.stringify(input.decision)}`).digest('hex'),
        sourceId: input.sourceId, externalId: input.externalId, decision: input.decision,
        occurrence: structuredClone(input.occurrence), recordedAt: input.decision.observedAt,
      };
      this.postingIdentityIncidents.set(incident.incidentId, incident);
      return { outcome: 'quarantined', incident };
    }
    const resolution = input.identity
      ? resolvePostingAliases(input.identity, this.postingAliases)
      : { outcome: 'create' as const, canonicalJobId: input.job.jobId, aliases: [] };
    const preferredConflict = input.identity && preferredJobIdentityConflicts(input.identity, this.jobs.get(input.job.jobId));
    if (resolution.outcome === 'quarantine' || resolution.canonicalJobId !== input.job.jobId || preferredConflict) {
      const decision: Extract<PostingIdentityDecision, { status: 'quarantined' }> = {
        status: 'quarantined', reason: resolution.outcome === 'quarantine' ? resolution.reason : 'aliases-resolve-to-different-jobs',
        contradictoryEvidence: resolution.outcome === 'quarantine' ? resolution.conflictingCanonicalJobIds : [resolution.canonicalJobId, input.job.jobId].sort(),
        reviewFamilyKey: input.decision.status === 'unconfirmed' ? input.decision.reviewFamilyKey : input.decision.exactKey,
        observedAt: input.decision.observedAt,
      };
      return this.commitPostingObservation({ decision, sourceId: input.occurrence.sourceId, externalId: input.occurrence.externalId, occurrence: input.occurrence.occurrence });
    }
    for (const alias of resolution.aliases) this.postingAliases.set(alias, resolution.canonicalJobId);
    const storedJob = this.jobs.get(input.job.jobId);
    const projected = postingObservationProjection(storedJob, input.job, input.occurrence);
    const finalized = postingObservationNotificationProjection(storedJob, projected, input.notificationEvent);
    this.jobs.set(input.job.jobId, structuredClone(finalized.job));
    this.occurrences.set(`${input.occurrence.sourceId}#${input.occurrence.externalId}`, structuredClone(input.occurrence));
    if (input.decision.status === 'unconfirmed') {
      const candidateId = createHash('sha256').update(`posting-review-family-v1:${input.decision.reviewFamilyKey}`).digest('hex');
      const prior = this.postingIdentityReviewCandidates.get(candidateId);
      this.postingIdentityReviewCandidates.set(candidateId, {
        reviewFamilyKey: input.decision.reviewFamilyKey,
        occurrenceKeys: new Set([...(prior?.occurrenceKeys ?? []), `${input.occurrence.sourceId}\0${input.occurrence.externalId}`]),
        firstObservedAt: prior?.firstObservedAt && prior.firstObservedAt < input.decision.observedAt
          ? prior.firstObservedAt : input.decision.observedAt,
        lastObservedAt: prior?.lastObservedAt && prior.lastObservedAt > input.decision.observedAt
          ? prior.lastObservedAt : input.decision.observedAt,
      });
    }
    const notificationInserted = Boolean(finalized.notificationEvent && !this.notificationEvents.has(finalized.notificationEvent.eventId));
    if (notificationInserted) {
      this.notificationEvents.set(finalized.notificationEvent!.eventId, structuredClone(finalized.notificationEvent!));
    }
    if (input.providerShadowVerification?.idempotencyKey) {
      this.providerShadowVerifications.set(input.providerShadowVerification.idempotencyKey,
        structuredClone(input.providerShadowVerification));
    }
    return { outcome: 'committed', canonicalJobId: input.job.jobId, notificationInserted };
  }
  async listPendingProviderShadowVerifications(limit = 100) { return [...this.providerShadowVerifications.values()].slice(0, limit).map((value) => structuredClone(value)); }
  async markProviderShadowVerificationEnqueued(idempotencyKey: string) { this.providerShadowVerifications.delete(idempotencyKey); }
  async putInternship(job: Internship) { const canonical = canonicalCatalogRecency(job); this.jobs.set(canonical.jobId, structuredClone(canonical)); }
  async getSourceOccurrences(sourceId: string) { return [...this.occurrences.values()].filter((value) => value.sourceId === sourceId).map((value) => structuredClone(value)); }
  async getSourceOccurrence(sourceId: string, externalId: string) {
    const value = this.occurrences.get(`${sourceId}#${externalId}`);
    return value ? structuredClone(value) : undefined;
  }
  async putSourceOccurrence(occurrence: SourceOccurrenceState) { this.occurrences.set(`${occurrence.sourceId}#${occurrence.externalId}`, structuredClone(occurrence)); }
  async recordRoleMetadataEvidence(jobId: string, evidence: readonly RoleMetadataEvidence[], conflicts: readonly MetadataConflict[], _recordedAt: string,
    replace?: { sourceId: string; sourceClasses: readonly EvidenceSource[] }) {
    if (replace) {
      const sourceClasses = new Set(replace.sourceClasses);
      for (const [key, item] of this.roleMetadataEvidence) {
        if (key.startsWith(`${jobId}\0`) && item.sourceId === replace.sourceId && sourceClasses.has(item.sourceClass)) {
          this.roleMetadataEvidence.delete(key);
        }
      }
    }
    for (const item of evidence) this.roleMetadataEvidence.set(`${jobId}\0${item.sourceClass}\0${item.sourceId}\0${item.sourceUrl}\0${item.artifactHash}`, structuredClone(item));
    this.roleMetadataConflicts.set(jobId, structuredClone([...conflicts]));
  }
  async putInternshipWithNotificationEvent(job: Internship, event: NotificationEvent) {
    if (this.notificationEvents.has(event.eventId)) return false;
    const canonical = canonicalCatalogRecency(job);
    this.jobs.set(canonical.jobId, structuredClone(canonical));
    this.notificationEvents.set(event.eventId, structuredClone(event));
    return true;
  }
  async pendingSms() { return [...this.jobs.values()].filter((job) => job.notification.smsPending && job.open && alertEligible(job)); }
  async pendingDigest() { return [...this.jobs.values()].filter((job) => job.notification.digestPending && job.open && alertEligible(job)); }
  async markSmsSent(jobId: string, sentAt: string) { const job = this.jobs.get(jobId); if (job) { job.notification.smsPending = false; job.notification.smsSentAt = sentAt; } }
  async markDigested(jobIds: string[], sentAt: string) { for (const jobId of jobIds) { const job = this.jobs.get(jobId); if (job) { job.notification.digestPending = false; job.notification.digestedAt = sentAt; } } }
  async getJob(jobId: string) { const job = this.jobs.get(jobId); return job && withEmployerCategory(job); }
  async listOpen(cursor?: string, limit = 25, status: 'open' | 'closed' = 'open', query: CatalogQuery = {}) {
    const needle = query.query?.trim().toLowerCase();
    const jobs = [...this.jobs.values()]
      .filter((job) => job.open === (status === 'open') && job.technical !== false && catalogEligible(job) && !isPastSeason(job.season))
      .filter((job) => !query.source || query.source === 'all' || catalogSourceClasses(job).includes(query.source))
      .filter((job) => !needle || catalogSearchText(job).includes(needle))
      .sort(status === 'open' ? compareCatalogRecency : (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    const offset = cursor ? Number(cursor) : 0;
    const page = jobs.slice(offset, offset + limit).map(withEmployerCategory);
    return { jobs: page, cursor: offset + page.length < jobs.length ? String(offset + page.length) : undefined };
  }
  async listOpenSince(after: string, before: string) {
    return [...this.jobs.values()]
      .filter((job) => job.open && job.technical !== false && catalogEligible(job) && catalogRecency(job) === 'normal' && !isPastSeason(job.season) && catalogVisibleAt(job) > after && catalogVisibleAt(job) <= before)
      .sort(compareCatalogRecency)
      .map(withEmployerCategory);
  }
  async listCatalog() {
    return [...this.jobs.values()]
      .filter((job) => job.technical !== false && catalogEligible(job) && !isPastSeason(job.season))
      .sort(compareCatalogRecency)
      .map(withEmployerCategory);
  }
  async putCatalogProjection(groups: CatalogGroupDetails[], generatedAt: string) {
    this.catalogProjection = { generatedAt, groups: structuredClone(groups) };
  }
  async listCatalogProjection(cursor?: string, limit = 25) {
    if (!this.catalogProjection) return undefined;
    const offset = cursor ? Number(cursor) : 0;
    const groups = this.catalogProjection.groups.slice(offset, offset + limit);
    return { groups: structuredClone(groups), ...(offset + groups.length < this.catalogProjection.groups.length ? { cursor: String(offset + groups.length) } : {}) };
  }
  async listCatalogProjectionFiltered(cursor: string | undefined, limit: number, filter: CatalogGroupFilter) {
    if (!this.catalogProjection) return undefined;
    const offset = cursor ? Number(cursor) : 0;
    const matching = filterCatalogGroupDetails(this.catalogProjection.groups, filter);
    const groups = matching.slice(offset, offset + limit);
    return { groups: structuredClone(groups), ...(offset + groups.length < matching.length ? { cursor: String(offset + groups.length) } : {}) };
  }
  async listCatalogProjectionRoles(filter: CatalogGroupFilter) {
    if (!this.catalogProjection) return undefined;
    return structuredClone(filterCatalogGroupDetails(this.catalogProjection.groups, filter).flatMap((details) => details.roles));
  }
  async getCatalogProjectionGroup(groupId: string) {
    const value = this.catalogProjection?.groups.find((group) => group.group.groupId === groupId);
    return value ? structuredClone(value) : undefined;
  }
  async listLeverAdmissions() { return [...this.leverAdmissions.values()].map((value) => structuredClone(value)); }
  async putLeverAdmission(admission: LeverAdmission) {
    if (this.leverAdmissions.has(admission.source.site)) throw new Error(`Lever site ${admission.source.site} is already admitted`);
    this.leverAdmissions.set(admission.source.site, structuredClone(admission));
  }
}

export interface UserStore {
  /** Permanently blocks new writes before account deletion starts. */
  beginUserDeletion(userId: string): Promise<void>;
  isUserDeletionPending(userId: string): Promise<boolean>;
  hasActiveDocumentUploads(userId: string): Promise<boolean>;
  getPreferences(userId: string): Promise<UserPreferences | undefined>;
  putPreferences(value: UserPreferences): Promise<void>;
  activePreferences(): Promise<UserPreferences[]>;
  activeDevices(): Promise<DeviceToken[]>;
  putDevice(value: DeviceToken): Promise<void>;
  deleteDevice(userId: string, token: string): Promise<void>;
  getProfile(userId: string): Promise<ApplicantProfile | undefined>;
  putProfile(value: ApplicantProfile): Promise<void>;
  listApplications(userId: string): Promise<ApplicationRecord[]>;
  getApplication(userId: string, applicationId: string): Promise<ApplicationRecord | undefined>;
  putApplication(userId: string, value: ApplicationRecord): Promise<void>;
  deleteApplication(userId: string, applicationId: string): Promise<void>;
  getApplicationSession(userId: string, sessionId: string): Promise<ApplicationSession | undefined>;
  getApplicationSessionById(sessionId: string): Promise<ApplicationSession | undefined>;
  putApplicationSession(userId: string, value: ApplicationSession, expectedVersion?: number): Promise<boolean>;
  listApplicationSessions(userId: string, applicationId?: string): Promise<ApplicationSession[]>;
  listDocuments(userId: string): Promise<UserDocument[]>;
  putDocument(value: UserDocument): Promise<void>;
  deleteDocument(userId: string, documentId: string): Promise<void>;
  listResumeBank(userId: string): Promise<ResumeBankItem[]>;
  getResumeBankItem(userId: string, bankItemId: string): Promise<ResumeBankItem | undefined>;
  putResumeBankItem(value: ResumeBankItem, expectedRevision?: number): Promise<boolean>;
  listResumeProfiles(userId: string): Promise<ResumeProfile[]>;
  getResumeProfile(userId: string, profileId: string): Promise<ResumeProfile | undefined>;
  putResumeProfile(value: ResumeProfile, expectedRevision?: number): Promise<boolean>;
  deleteResumeProfile(userId: string, profileId: string, expectedRevision: number): Promise<boolean>;
  getResumeDraft(userId: string, draftId: string): Promise<ResumeDraft | undefined>;
  listResumeDrafts(userId: string): Promise<ResumeDraft[]>;
  putResumeDraft(value: ResumeDraft, expectedRevision?: number): Promise<boolean>;
  listImportedResumeJobs(userId: string): Promise<ImportedJob[]>;
  getImportedResumeJob(userId: string, importId: string): Promise<ImportedJob | undefined>;
  putImportedResumeJob(userId: string, value: ImportedJob, expectedRevision?: number): Promise<boolean>;
  getReceipt(userId: string, dedupeKey: string, token: string): Promise<DeliveryReceipt | undefined>;
  /** Atomically claims a delivery key. Existing pending/ok receipts win; error receipts may be retried once. */
  claimReceipt(value: DeliveryReceipt): Promise<boolean>;
  putReceipt(value: DeliveryReceipt): Promise<void>;
  /** Copies a legacy receipt to a hardened key without overwriting any existing claim. */
  migrateReceipt(value: DeliveryReceipt, dedupeKey: string): Promise<boolean>;
  pendingReceipts(): Promise<DeliveryReceipt[]>;
  retryableReceipts(): Promise<DeliveryReceipt[]>;
  deferredReceipts(): Promise<DeliveryReceipt[]>;
  deleteUser(userId: string): Promise<UserDocument[]>;
}

export interface ReleaseStore {
  getRelease(userId: string, releaseId: string): Promise<CatalogRelease | undefined>;
  putRelease(release: CatalogRelease): Promise<void>;
}

export class MemoryReleaseStore implements ReleaseStore {
  readonly releases = new Map<string, CatalogRelease>();
  async getRelease(userId: string, releaseId: string) {
    const release = this.releases.get(`${userId}#${releaseId}`);
    return release && structuredClone(release);
  }
  async putRelease(release: CatalogRelease) {
    this.releases.set(`${release.userId}#${release.releaseId}`, structuredClone(release));
  }
}

/** Durable personalized release rows share the encrypted user-data table. */

export class MemoryUserStore implements UserStore {
  readonly preferences = new Map<string, UserPreferences>(); readonly devices = new Map<string, DeviceToken>(); readonly profiles = new Map<string, ApplicantProfile>(); readonly applications = new Map<string, ApplicationRecord>(); readonly sessions = new Map<string, ApplicationSession>(); readonly documents = new Map<string, UserDocument>(); readonly resumeBank = new Map<string, ResumeBankItem>(); readonly resumeProfiles = new Map<string, ResumeProfile>(); readonly resumeDrafts = new Map<string, ResumeDraft>(); readonly resumeImports = new Map<string, ImportedJob>(); readonly receipts = new Map<string, DeliveryReceipt>();
  readonly deletedUsers = new Set<string>();
  private writable(userId: string) { if (this.deletedUsers.has(deletedUserTombstoneKey(userId).pk)) throw new Error('Account deletion is in progress'); }
  async beginUserDeletion(userId: string) { this.deletedUsers.add(deletedUserTombstoneKey(userId).pk); }
  async isUserDeletionPending(userId: string) { return this.deletedUsers.has(deletedUserTombstoneKey(userId).pk); }
  async hasActiveDocumentUploads() { return false; }
  async getPreferences(userId: string) { return this.preferences.get(userId); } async putPreferences(value: UserPreferences) { this.writable(value.userId); this.preferences.set(value.userId, structuredClone(value)); }
  async activePreferences() { return [...this.preferences.values()].filter((value) => value.alertsEnabled && value.onboardingComplete).map((value) => structuredClone(value)); }
  async activeDevices() { return [...this.devices.values()].filter((d) => d.active).map((d) => structuredClone(d)); }
  async putDevice(value: DeviceToken) { this.writable(value.userId); this.devices.set(`${value.userId}#${value.token}`, structuredClone(value)); } async deleteDevice(userId: string, token: string) { this.devices.delete(`${userId}#${token}`); }
  async getProfile(userId: string) { return this.profiles.get(userId); } async putProfile(value: ApplicantProfile) { this.writable(value.userId); this.profiles.set(value.userId, structuredClone(value)); }
  async listApplications(userId: string) { return [...this.applications.entries()].filter(([key]) => key.startsWith(`${userId}#`)).map(([, value]) => value).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((a) => structuredClone(a)); } async getApplication(userId: string, applicationId: string) { const value = this.applications.get(`${userId}#${applicationId}`); return value && structuredClone(value); } async putApplication(userId: string, value: ApplicationRecord) { this.writable(userId); this.applications.set(`${userId}#${value.applicationId}`, structuredClone(value)); } async deleteApplication(userId: string, applicationId: string) { this.applications.delete(`${userId}#${applicationId}`); }
  async getApplicationSession(userId: string, sessionId: string) { const value = this.sessions.get(`${userId}#${sessionId}`); return value && structuredClone(value); }
  async getApplicationSessionById(sessionId: string) { const value = [...this.sessions.values()].find((session) => session.sessionId === sessionId); return value && structuredClone(value); }
  async putApplicationSession(userId: string, value: ApplicationSession, expectedVersion?: number) { if (await this.isUserDeletionPending(userId)) return false; const key = `${userId}#${value.sessionId}`; const current = this.sessions.get(key); if (expectedVersion !== undefined && current?.version !== expectedVersion) return false; if (expectedVersion === undefined && current) return false; this.sessions.set(key, structuredClone(value)); return true; }
  async listApplicationSessions(userId: string, applicationId?: string) { return [...this.sessions.entries()].filter(([key, value]) => key.startsWith(`${userId}#`) && (!applicationId || value.applicationId === applicationId)).map(([, value]) => structuredClone(value)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async listDocuments(userId: string) { return [...this.documents.values()].filter((d) => d.userId === userId).map((d) => structuredClone(d)); } async putDocument(value: UserDocument) { this.writable(value.userId); this.documents.set(`${value.userId}#${value.documentId}`, structuredClone(value)); } async deleteDocument(userId: string, documentId: string) { this.documents.delete(`${userId}#${documentId}`); }
  async listResumeBank(userId: string) { return [...this.resumeBank.values()].filter((item) => item.userId === userId).map((item) => structuredClone(item)); }
  async getResumeBankItem(userId: string, bankItemId: string) { const item = this.resumeBank.get(`${userId}#${bankItemId}`); return item && structuredClone(item); }
  async putResumeBankItem(value: ResumeBankItem, expectedRevision?: number) { if (this.deletedUsers.has(deletedUserTombstoneKey(value.userId).pk)) return false; const key = `${value.userId}#${value.bankItemId}`; const previous = this.resumeBank.get(key); if ((expectedRevision === undefined && previous) || (expectedRevision !== undefined && previous?.revision !== expectedRevision)) return false; this.resumeBank.set(key, structuredClone(value)); return true; }
  async listResumeProfiles(userId: string) { return [...this.resumeProfiles.values()].filter((item) => item.userId === userId).map((item) => structuredClone(item)); }
  async getResumeProfile(userId: string, profileId: string) { const item = this.resumeProfiles.get(`${userId}#${profileId}`); return item && structuredClone(item); }
  async putResumeProfile(value: ResumeProfile, expectedRevision?: number) { if (this.deletedUsers.has(deletedUserTombstoneKey(value.userId).pk)) return false; const key = `${value.userId}#${value.profileId}`; const previous = this.resumeProfiles.get(key); if ((expectedRevision === undefined && previous) || (expectedRevision !== undefined && previous?.revision !== expectedRevision)) return false; this.resumeProfiles.set(key, structuredClone(value)); return true; }
  async deleteResumeProfile(userId: string, profileId: string, expectedRevision: number) { const key = `${userId}#${profileId}`; const previous = this.resumeProfiles.get(key); if (!previous || previous.revision !== expectedRevision) return false; this.resumeProfiles.delete(key); return true; }
  async getResumeDraft(userId: string, draftId: string) { const item = this.resumeDrafts.get(`${userId}#${draftId}`); return item && structuredClone(item); }
  async listResumeDrafts(userId: string) { return [...this.resumeDrafts.values()].filter((item) => item.userId === userId).map((item) => structuredClone(item)); }
  async putResumeDraft(value: ResumeDraft, expectedRevision?: number) { if (this.deletedUsers.has(deletedUserTombstoneKey(value.userId).pk)) return false; const key = `${value.userId}#${value.draftId}`; const previous = this.resumeDrafts.get(key); if ((expectedRevision === undefined && previous) || (expectedRevision !== undefined && previous?.revision !== expectedRevision)) return false; this.resumeDrafts.set(key, structuredClone(value)); return true; }
  async listImportedResumeJobs(userId: string) { return [...this.resumeImports.entries()].filter(([key]) => key.startsWith(`${userId}#`)).map(([, item]) => structuredClone(item)); }
  async getImportedResumeJob(userId: string, importId: string) { const item = this.resumeImports.get(`${userId}#${importId}`); return item && structuredClone(item); }
  async putImportedResumeJob(userId: string, value: ImportedJob, expectedRevision?: number) { if (this.deletedUsers.has(deletedUserTombstoneKey(userId).pk)) return false; const key = `${userId}#${value.importId}`; const previous = this.resumeImports.get(key); if ((expectedRevision === undefined && previous) || (expectedRevision !== undefined && previous?.revision !== expectedRevision)) return false; this.resumeImports.set(key, structuredClone(value)); return true; }
  async getReceipt(userId: string, dedupeKey: string, token: string) { return this.receipts.get(`${userId}#${dedupeKey}#${token}`); }
  async claimReceipt(value: DeliveryReceipt) { if (await this.isUserDeletionPending(value.userId)) return false; const key = `${value.userId}#${value.dedupeKey ?? value.jobId}#${value.token}`; const existing = this.receipts.get(key); if (existing && existing.status !== 'error') return false; this.receipts.set(key, structuredClone(value)); return true; }
  async putReceipt(value: DeliveryReceipt) { this.writable(value.userId); this.receipts.set(`${value.userId}#${value.dedupeKey ?? value.jobId}#${value.token}`, structuredClone(value)); }
  async migrateReceipt(value: DeliveryReceipt, dedupeKey: string) {
    if (await this.isUserDeletionPending(value.userId)) return false;
    const key = `${value.userId}#${dedupeKey}#${value.token}`;
    if (this.receipts.has(key)) return false;
    this.receipts.set(key, structuredClone({ ...value, dedupeKey }));
    return true;
  }
  async pendingReceipts() { return [...this.receipts.values()].filter((receipt) => receipt.status === 'pending' && receipt.ticketId).map((receipt) => structuredClone(receipt)); }
  async retryableReceipts() { return [...this.receipts.values()].filter((receipt) => receipt.status === 'retryable').map((receipt) => structuredClone(receipt)); }
  async deferredReceipts() { return [...this.receipts.values()].filter((receipt) => receipt.status === 'deferred').map((receipt) => structuredClone(receipt)); }
  async deleteUser(userId: string) { await this.beginUserDeletion(userId); const docs = await this.listDocuments(userId); for (const map of [this.preferences, this.profiles]) map.delete(userId); for (const map of [this.devices, this.applications, this.sessions, this.documents, this.resumeBank, this.resumeProfiles, this.resumeDrafts, this.resumeImports, this.receipts]) for (const [key] of map) if (key.startsWith(`${userId}#`)) map.delete(key); return docs; }
}
