import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { isPastSeason } from './core/early-career.js';
import { employerCategory } from './core/employers.js';
import { canonicalCatalogRecency, catalogRecency, catalogVisibleAt, compareCatalogRecency, openCatalogSortKey } from './catalog-recency.js';
import { catalogSearchText, catalogSourceClasses, type CatalogSource } from './catalog-fields.js';
import type { ApplicantProfile, ApplicationRecord, DeliveryReceipt, DeviceToken, EvidenceSource, Internship, MetadataConflict, MonitoringChecklist, NotificationEvent, PostingIdentity, PostingIdentityDecision, PostingIdentityIncident, RoleMetadataEvidence, SourceCheckpoint, SourceHealth, SourceOccurrence, SourceOccurrenceState, UserDocument, UserPreferences } from './types.js';
import { preferredJobIdentityConflicts, resolvePostingAliases, type AliasResolution } from './identity/posting.js';
import type { ApplicationSession } from './application-automation.js';
import type { ReviewedLeverSource } from './sources/lever-config.js';
import type { LeverOwnershipEvidence } from './sources/lever-evidence.js';
import type { LeverCandidateProbeResult } from './sources/lever-probe.js';
import { filterCatalogGroupDetails, type CatalogGroupDetails, type CatalogGroupFilter, type CatalogProjectionPage, type CatalogRelease } from './catalog-groups.js';
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

/** Optional listing/profile fields are omitted rather than rejected by DynamoDB. */
export function createDynamoDocumentClient(client = new DynamoDBClient({})): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
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

type JobItem = { pk: string; sk: 'META'; urlPk: string; fingerprintPk: string; smsPk?: string; digestPk?: string; openPk?: string; openSk?: string; closedPk?: string; closedSk?: string; catalogSearchText?: string; catalogSourceClasses?: CatalogSource[]; job: Internship };

function internshipItem(job: Internship): JobItem {
  const canonical = canonicalCatalogRecency(job);
  const item: JobItem = { pk: `JOB#${canonical.jobId}`, sk: 'META', urlPk: `URL#${canonical.normalizedUrl}`, fingerprintPk: `FP#${canonical.fingerprint}`, job: canonical };
  if (canonical.notification.smsPending && alertEligible(canonical)) item.smsPk = 'PENDING#SMS';
  if (canonical.notification.digestPending && alertEligible(canonical)) item.digestPk = 'PENDING#DIGEST';
  if (canonical.technical !== false && catalogEligible(canonical)) {
    item.catalogSearchText = catalogSearchText(canonical); item.catalogSourceClasses = catalogSourceClasses(canonical);
    if (canonical.open) { item.openPk = 'OPEN'; item.openSk = openCatalogSortKey(canonical); }
    else { item.closedPk = 'CLOSED'; item.closedSk = `${canonical.lastSeenAt}#${canonical.jobId}`; }
  }
  return item;
}

export class DynamoInternshipStore implements InternshipStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) { this.client = client ?? createDynamoDocumentClient(); }
  private async queryAll(command: ConstructorParameters<typeof QueryCommand>[0]) {
    const items: Record<string, unknown>[] = []; let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new QueryCommand({ ...command, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      items.push(...(response.Items ?? []) as Record<string, unknown>[]); cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async getCheckpoint(sourceId: string): Promise<SourceCheckpoint | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `SOURCE#${sourceId}`, sk: 'CHECKPOINT' } }));
    return result.Item?.checkpoint as SourceCheckpoint | undefined;
  }
  async getCheckpointsMany(sourceIds: string[]): Promise<SourceCheckpoint[]> {
    const checkpoints: SourceCheckpoint[] = [];
    for (let offset = 0; offset < sourceIds.length; offset += 100) {
      let keys = sourceIds.slice(offset, offset + 100).map((sourceId) => ({ pk: `SOURCE#${sourceId}`, sk: 'CHECKPOINT' }));
      do {
        const result = await this.client.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys } } }));
        checkpoints.push(...((result.Responses?.[this.tableName] ?? []).map((item) => item.checkpoint as SourceCheckpoint)));
        keys = result.UnprocessedKeys?.[this.tableName]?.Keys as typeof keys ?? [];
      } while (keys.length);
    }
    return checkpoints;
  }
  async putCheckpoint(checkpoint: SourceCheckpoint): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { pk: `SOURCE#${checkpoint.sourceId}`, sk: 'CHECKPOINT', checkpoint } }));
  }
  async getSourceOccurrences(sourceId: string): Promise<SourceOccurrenceState[]> {
    return (await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `SOURCE#${sourceId}`, ':prefix': 'OCCURRENCE#' },
    })).map((item) => item.occurrence as SourceOccurrenceState);
  }
  async getSourceOccurrence(sourceId: string, externalId: string): Promise<SourceOccurrenceState | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: { pk: `SOURCE#${sourceId}`, sk: `OCCURRENCE#${externalId}` },
    }));
    return result.Item?.occurrence as SourceOccurrenceState | undefined;
  }
  async putSourceOccurrence(occurrence: SourceOccurrenceState): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: `SOURCE#${occurrence.sourceId}`, sk: `OCCURRENCE#${occurrence.externalId}`, occurrence },
    }));
  }
  async getSourceHealth(sourceId: string): Promise<SourceHealth | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `SOURCE#${sourceId}`, sk: 'HEALTH' } }));
    return result.Item?.health as SourceHealth | undefined;
  }
  async putInternshipWithNotificationEvent(job: Internship, event: NotificationEvent): Promise<boolean> {
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: internshipItem(job) } },
          {
            Put: {
              TableName: this.tableName,
              Item: { pk: `OUTBOX#${event.eventId}`, sk: 'EVENT', event },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name !== 'TransactionCanceledException') throw error;
      const existing = await this.client.send(new GetCommand({
        TableName: this.tableName,
        Key: { pk: `OUTBOX#${event.eventId}`, sk: 'EVENT' },
        ConsistentRead: true,
      }));
      if (existing.Item) return false;
      throw error;
    }
  }
  async getSourceHealthMany(sourceIds: string[]): Promise<SourceHealth[]> {
    const health: SourceHealth[] = [];
    for (let offset = 0; offset < sourceIds.length; offset += 100) {
      let keys = sourceIds.slice(offset, offset + 100).map((sourceId) => ({ pk: `SOURCE#${sourceId}`, sk: 'HEALTH' }));
      do {
        const result = await this.client.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys } } }));
        health.push(...((result.Responses?.[this.tableName] ?? []).map((item) => item.health as SourceHealth)));
        keys = result.UnprocessedKeys?.[this.tableName]?.Keys as typeof keys ?? [];
      } while (keys.length);
    }
    return health;
  }
  async putSourceHealth(health: SourceHealth): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { pk: `SOURCE#${health.sourceId}`, sk: 'HEALTH', health } }));
  }
  async getMonitoringChecklist(period: string): Promise<MonitoringChecklist | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: 'OPERATIONS#MONITORING', sk: `CHECKLIST#${period}` },
    }));
    return result.Item?.checklist as MonitoringChecklist | undefined;
  }
  async putMonitoringChecklist(checklist: MonitoringChecklist): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: 'OPERATIONS#MONITORING', sk: `CHECKLIST#${checklist.period}`, checklist },
    }));
  }
  private async find(index: 'urlIndex' | 'fingerprintIndex', attribute: 'urlPk' | 'fingerprintPk', value: string) {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: index, KeyConditionExpression: '#key = :value', ExpressionAttributeNames: { '#key': attribute }, ExpressionAttributeValues: { ':value': value }, Limit: 1 }));
    const job = result.Items?.[0]?.job as Internship | undefined;
    return job && withEmployerCategory(job);
  }
  findByUrl(url: string) { return this.find('urlIndex', 'urlPk', `URL#${url}`); }
  findByFingerprint(fingerprint: string) { return this.find('fingerprintIndex', 'fingerprintPk', `FP#${fingerprint}`); }
  private postingAliasKey(alias: string) {
    return { pk: `POSTING_ALIAS#${createHash('sha256').update(alias).digest('hex')}`, sk: 'CLAIM' as const };
  }
  private async postingAliasClaims(aliases: string[]) {
    if (!aliases.length) return new Map<string, string>();
    const claims = new Map<string, string>();
    let keys = aliases.map((alias) => this.postingAliasKey(alias));
    do {
      const result = await this.client.send(new BatchGetCommand({
        RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } },
      }));
      for (const item of result.Responses?.[this.tableName] ?? []) {
        if (typeof item.alias === 'string' && typeof item.canonicalJobId === 'string') claims.set(item.alias, item.canonicalJobId);
      }
      keys = (result.UnprocessedKeys?.[this.tableName]?.Keys as typeof keys | undefined) ?? [];
    } while (keys.length);
    return claims;
  }
  private async postingIdentityGuardJob(jobId: string) {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: { pk: `JOB#${jobId}`, sk: 'META' }, ConsistentRead: true,
    }));
    return result.Item?.job as Internship | undefined;
  }
  async resolvePostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution> {
    const aliases = [...new Set(identity.aliases.map((item) => item.value))].sort();
    const resolution = resolvePostingAliases(identity, await this.postingAliasClaims(aliases));
    if (resolution.outcome === 'quarantine') return resolution;
    if (preferredJobId && preferredJobIdentityConflicts(identity, await this.postingIdentityGuardJob(preferredJobId))) {
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
    return { ...resolution, canonicalJobId: resolution.outcome === 'create' && preferredJobId ? preferredJobId : resolution.canonicalJobId };
  }
  async claimPostingIdentity(identity: PostingIdentity, preferredJobId?: string): Promise<AliasResolution> {
    const aliases = [...new Set(identity.aliases.map((item) => item.value))].sort();
    if (preferredJobId && preferredJobIdentityConflicts(identity, await this.postingIdentityGuardJob(preferredJobId))) {
      return {
        outcome: 'quarantine', aliases,
        conflictingCanonicalJobIds: [identity.canonicalJobId, preferredJobId].sort(),
        reason: 'aliases-resolve-to-different-jobs',
      };
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const claims = await this.postingAliasClaims(aliases);
      const resolution = resolvePostingAliases(identity, claims);
      if (resolution.outcome === 'quarantine') return resolution;
      if (preferredJobId && resolution.outcome === 'merge' && resolution.canonicalJobId !== preferredJobId) {
        return {
          outcome: 'quarantine', aliases: resolution.aliases,
          conflictingCanonicalJobIds: [resolution.canonicalJobId, preferredJobId].sort(),
          reason: 'aliases-resolve-to-different-jobs',
        };
      }
      const canonicalJobId = resolution.outcome === 'create' && preferredJobId ? preferredJobId : resolution.canonicalJobId;
      const unclaimed = resolution.aliases.filter((alias) => !claims.has(alias));
      if (!unclaimed.length) return { ...resolution, canonicalJobId };
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: unclaimed.map((alias) => ({ Put: {
            TableName: this.tableName,
            Item: { ...this.postingAliasKey(alias), alias, canonicalJobId, claimedAt: new Date().toISOString() },
            ConditionExpression: 'attribute_not_exists(pk)',
          } })),
        }));
        return { ...resolution, canonicalJobId };
      } catch (error) {
        if ((error as { name?: string }).name !== 'TransactionCanceledException' || attempt === 3) throw error;
      }
    }
    throw new Error('Unable to claim posting identity aliases');
  }
  async commitPostingObservation(input: PostingObservationCommit): Promise<PostingObservationCommitResult> {
    if ('sourceId' in input) {
      const incident: PostingIdentityIncident = {
        incidentId: createHash('sha256').update(`identity-incident-v1:${input.sourceId}\0${input.externalId}\0${JSON.stringify(input.decision)}`).digest('hex'),
        sourceId: input.sourceId, externalId: input.externalId, decision: input.decision,
        occurrence: input.occurrence, recordedAt: input.decision.observedAt,
      };
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { pk: `IDENTITY_INCIDENT#${incident.incidentId}`, sk: 'INCIDENT', kind: 'posting-identity-incident', incident },
        ConditionExpression: 'attribute_not_exists(pk)',
      })).catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      });
      return { outcome: 'quarantined', incident };
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const aliases = input.identity ? [...new Set(input.identity.aliases.map((item) => item.value))].sort() : [];
      const claims = await this.postingAliasClaims(aliases);
      const resolution = input.identity
        ? resolvePostingAliases(input.identity, claims)
        : { outcome: 'create' as const, canonicalJobId: input.job.jobId, aliases: [] };
      if (resolution.outcome === 'quarantine' || (resolution.outcome === 'merge' && resolution.canonicalJobId !== input.job.jobId)) {
        const conflicting = resolution.outcome === 'quarantine' ? resolution.conflictingCanonicalJobIds : [resolution.canonicalJobId, input.job.jobId];
        const decision: Extract<PostingIdentityDecision, { status: 'quarantined' }> = {
          status: 'quarantined', reason: resolution.outcome === 'quarantine' ? resolution.reason : 'aliases-resolve-to-different-jobs',
          contradictoryEvidence: [...new Set(conflicting)].sort(),
          reviewFamilyKey: input.decision.status === 'confirmed' ? input.decision.exactKey : input.decision.reviewFamilyKey,
          observedAt: input.decision.observedAt,
        };
        return this.commitPostingObservation({ decision, sourceId: input.occurrence.sourceId, externalId: input.occurrence.externalId, occurrence: input.occurrence.occurrence });
      }
      const storedJobResult = await this.client.send(new GetCommand({
        TableName: this.tableName, Key: { pk: `JOB#${input.job.jobId}`, sk: 'META' }, ConsistentRead: true,
      }));
      const storedJob = storedJobResult.Item?.job as Internship | undefined;
      if (input.identity && preferredJobIdentityConflicts(input.identity, storedJob)) {
        const decision: Extract<PostingIdentityDecision, { status: 'quarantined' }> = {
          status: 'quarantined', reason: 'aliases-resolve-to-different-jobs',
          contradictoryEvidence: [input.identity.canonicalJobId, input.job.jobId].sort(),
          reviewFamilyKey: input.decision.status === 'confirmed' ? input.decision.exactKey : input.decision.reviewFamilyKey,
          observedAt: input.decision.observedAt,
        };
        return this.commitPostingObservation({ decision, sourceId: input.occurrence.sourceId, externalId: input.occurrence.externalId, occurrence: input.occurrence.occurrence });
      }
      const projectedJob = postingObservationProjection(storedJob, input.job, input.occurrence);
      const finalized = postingObservationNotificationProjection(storedJob, projectedJob, input.notificationEvent);
      const eventExists = finalized.notificationEvent ? Boolean((await this.client.send(new GetCommand({
        TableName: this.tableName, Key: { pk: `OUTBOX#${finalized.notificationEvent.eventId}`, sk: 'EVENT' }, ConsistentRead: true,
      }))).Item) : false;
      const reviewCandidate = input.decision.status === 'unconfirmed' ? {
        candidateId: createHash('sha256').update(`posting-review-family-v1:${input.decision.reviewFamilyKey}`).digest('hex'),
        reviewFamilyKey: input.decision.reviewFamilyKey,
        evidenceHash: createHash('sha256').update(JSON.stringify({
          reviewFamilyKey: input.decision.reviewFamilyKey,
          reason: input.decision.reason,
        })).digest('hex'),
      } : undefined;
      const transaction = [
        ...aliases.map((alias) => claims.has(alias)
          ? { ConditionCheck: {
              TableName: this.tableName, Key: this.postingAliasKey(alias),
              ConditionExpression: 'canonicalJobId = :canonicalJobId', ExpressionAttributeValues: { ':canonicalJobId': input.job.jobId },
            } }
          : { Put: {
              TableName: this.tableName, Item: { ...this.postingAliasKey(alias), alias, canonicalJobId: input.job.jobId, claimedAt: input.decision.observedAt },
              ConditionExpression: 'attribute_not_exists(pk)',
            } }),
        { Put: {
          TableName: this.tableName, Item: internshipItem(finalized.job),
          ConditionExpression: storedJob ? 'job = :expectedJob' : 'attribute_not_exists(pk)',
          ...(storedJob ? { ExpressionAttributeValues: { ':expectedJob': storedJob } } : {}),
        } },
        { Put: { TableName: this.tableName, Item: { pk: `SOURCE#${input.occurrence.sourceId}`, sk: `OCCURRENCE#${input.occurrence.externalId}`, occurrence: input.occurrence } } },
        ...(reviewCandidate ? [{ Update: {
          TableName: this.tableName,
          Key: { pk: `IDENTITY_REVIEW#${reviewCandidate.candidateId}`, sk: 'CANDIDATE' },
          UpdateExpression: 'SET #kind = :kind, reviewFamilyKey = :family, evidenceHash = :evidenceHash, firstObservedAt = if_not_exists(firstObservedAt, :observedAt), lastObservedAt = :observedAt ADD occurrenceKeys :occurrenceKeys',
          ExpressionAttributeNames: { '#kind': 'kind' },
          ExpressionAttributeValues: {
            ':kind': 'posting-identity-review-candidate',
            ':family': reviewCandidate.reviewFamilyKey,
            ':evidenceHash': reviewCandidate.evidenceHash,
            ':observedAt': input.decision.observedAt,
            ':occurrenceKeys': new Set([`${input.occurrence.sourceId}\0${input.occurrence.externalId}`]),
          },
        } }] : []),
        ...(finalized.notificationEvent && !eventExists ? [{ Put: {
          TableName: this.tableName, Item: { pk: `OUTBOX#${finalized.notificationEvent.eventId}`, sk: 'EVENT', event: finalized.notificationEvent },
          ConditionExpression: 'attribute_not_exists(pk)',
        } }] : []),
      ];
      if (transaction.length > 100) throw new Error('Posting observation exceeds the DynamoDB transaction limit');
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: transaction }));
        return { outcome: 'committed', canonicalJobId: input.job.jobId, notificationInserted: Boolean(finalized.notificationEvent && !eventExists) };
      } catch (error) {
        if ((error as { name?: string }).name !== 'TransactionCanceledException' || attempt === 3) throw error;
      }
    }
    throw new Error('Unable to commit posting observation');
  }
  async putInternship(job: Internship): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: internshipItem(job) }));
  }
  async migrateInternship(job: Internship, expected: Internship): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: internshipItem(job),
        ConditionExpression: 'job = :expectedJob',
        ExpressionAttributeValues: { ':expectedJob': expected },
      }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  private async pending(index: 'pendingSmsIndex' | 'pendingDigestIndex', attribute: 'smsPk' | 'digestPk', value: string): Promise<Internship[]> {
    return (await this.queryAll({ TableName: this.tableName, IndexName: index, KeyConditionExpression: '#key = :value', ExpressionAttributeNames: { '#key': attribute }, ExpressionAttributeValues: { ':value': value } }))
      .map((item) => item.job as Internship).filter((job) => alertEligible(job));
  }
  pendingSms() { return this.pending('pendingSmsIndex', 'smsPk', 'PENDING#SMS'); }
  pendingDigest() { return this.pending('pendingDigestIndex', 'digestPk', 'PENDING#DIGEST'); }
  async markSmsSent(jobId: string, sentAt: string) { const job = await this.getJob(jobId); if (job) { job.notification.smsPending = false; job.notification.smsSentAt = sentAt; await this.putInternship(job); } }
  async markDigested(jobIds: string[], sentAt: string) { for (const jobId of jobIds) { const job = await this.getJob(jobId); if (job) { job.notification.digestPending = false; job.notification.digestedAt = sentAt; await this.putInternship(job); } } }
  async getJob(jobId: string): Promise<Internship | undefined> { const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `JOB#${jobId}`, sk: 'META' } })); return result.Item?.job ? withEmployerCategory(result.Item.job as Internship) : undefined; }
  async listOpen(cursor?: string, limit = 25, status: 'open' | 'closed' = 'open', query: CatalogQuery = {}): Promise<{ jobs: Internship[]; cursor?: string }> {
    const open = status === 'open';
    const needle = query.query?.trim().toLowerCase();
    const source = query.source && query.source !== 'all' ? query.source : undefined;
    // This stays on the chronological GSI and only advances until it can fill
    // the requested page or reaches the end. It never falls back to Scan.
    const jobs: Internship[] = [];
    let eligibilityFiltered = false;
    let startKey: Record<string, unknown> | undefined = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) : undefined;
    do {
      const filters = [needle ? 'contains(catalogSearchText, :query)' : undefined, source ? 'contains(catalogSourceClasses, :source)' : undefined].filter(Boolean);
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName, IndexName: open ? 'openJobsIndex' : 'closedJobsIndex',
        KeyConditionExpression: open ? 'openPk = :status' : 'closedPk = :status',
        ExpressionAttributeValues: { ':status': open ? 'OPEN' : 'CLOSED', ...(needle ? { ':query': needle } : {}), ...(source ? { ':source': source } : {}) },
        ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
        ScanIndexForward: false, Limit: limit - jobs.length, ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      for (const item of result.Items ?? []) {
        const job = item.job as Internship;
        if (catalogEligible(job) && !isPastSeason(job.season)) jobs.push(withEmployerCategory(job));
        else eligibilityFiltered = true;
      }
      startKey = result.LastEvaluatedKey;
    } while (startKey && (jobs.length === 0 || (jobs.length < limit && Boolean(needle || source || eligibilityFiltered))));
    return { jobs, ...(startKey ? { cursor: Buffer.from(JSON.stringify(startKey)).toString('base64url') } : {}) };
  }
  async listOpenSince(after: string, before: string): Promise<Internship[]> {
    const normal = await this.queryAll({
      TableName: this.tableName,
      IndexName: 'openJobsIndex',
      KeyConditionExpression: 'openPk = :open AND openSk BETWEEN :after AND :before',
      ExpressionAttributeValues: {
        ':open': 'OPEN',
        ':after': `3#${after}\uffff`,
        ':before': `3#${before}\uffff`,
      },
      ScanIndexForward: false,
    });
    // Include legacy normal rows until the catalog-index audit canonicalizes
    // their unprefixed firstSeenAt sort keys. Baseline rows only use rank 1.
    const legacy = await this.queryAll({
      TableName: this.tableName,
      IndexName: 'openJobsIndex',
      KeyConditionExpression: 'openPk = :open AND openSk BETWEEN :after AND :before',
      ExpressionAttributeValues: { ':open': 'OPEN', ':after': `${after}\uffff`, ':before': `${before}\uffff` },
      ScanIndexForward: false,
    });
    return [...normal, ...legacy]
      .map((item) => item.job as Internship)
      .filter((job) => catalogEligible(job) && catalogRecency(job) === 'normal'
        && catalogVisibleAt(job) > after && catalogVisibleAt(job) <= before && !isPastSeason(job.season))
      .sort(compareCatalogRecency)
      .map(withEmployerCategory);
  }
  async listCatalog(): Promise<Internship[]> {
    const [open, closed] = await Promise.all([this.queryAll({
      TableName: this.tableName,
      IndexName: 'openJobsIndex',
      KeyConditionExpression: 'openPk = :open',
      ExpressionAttributeValues: { ':open': 'OPEN' },
      ScanIndexForward: false,
    }), this.queryAll({
      TableName: this.tableName,
      IndexName: 'closedJobsIndex',
      KeyConditionExpression: 'closedPk = :closed',
      ExpressionAttributeValues: { ':closed': 'CLOSED' },
      ScanIndexForward: false,
    })]);
    return [...open, ...closed]
      .map((item) => item.job as Internship)
      .filter((job) => job.technical !== false && catalogEligible(job) && !isPastSeason(job.season))
      .sort(compareCatalogRecency)
      .map(withEmployerCategory);
  }
  async putCatalogProjection(groups: CatalogGroupDetails[], generatedAt: string): Promise<void> {
    const version = createHash('sha256').update(`${generatedAt}\0${groups.map((group) => group.group.groupId).join('\0')}`).digest('hex').slice(0, 20);
    const projectionPk = `CATALOG_PROJECTION#${version}`;
    const expiresAtEpoch = Math.floor(Date.parse(generatedAt) / 1_000) + 2 * 24 * 60 * 60;
    type ProjectionWrite = NonNullable<NonNullable<ConstructorParameters<typeof BatchWriteCommand>[0]>['RequestItems']>[string][number];
    const requests: ProjectionWrite[] = groups.flatMap((details) => {
      const order = `${String(9_999_999_999_999 - Date.parse(details.group.updatedAt)).padStart(13, '0')}#${details.group.groupId}`;
      return [
        { PutRequest: { Item: { pk: projectionPk, sk: `ORDER#${order}`, details, expiresAtEpoch } } },
        { PutRequest: { Item: { pk: projectionPk, sk: `GROUP#${details.group.groupId}`, details, expiresAtEpoch } } },
      ];
    });
    while (requests.length) {
      const batch = requests.splice(0, 25);
      let pending: ProjectionWrite[] = batch;
      do {
        const result = await this.client.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: pending } }));
        pending = result.UnprocessedItems?.[this.tableName] ?? [];
      } while (pending.length);
    }
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: 'CATALOG_PROJECTION', sk: 'CURRENT', schemaVersion: 5, version, generatedAt, groupCount: groups.length },
    }));
  }
  async listCatalogProjection(cursor?: string, limit = 25): Promise<CatalogProjectionPage | undefined> {
    const decoded = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { schemaVersion?: number; version: string; generatedAt?: string; key?: Record<string, unknown> } : undefined;
    const pointer = decoded ? undefined : await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: 'CATALOG_PROJECTION', sk: 'CURRENT' }, ConsistentRead: true }));
    const version = decoded?.version ?? pointer?.Item?.version as string | undefined;
    const schemaVersion = decoded?.schemaVersion ?? pointer?.Item?.schemaVersion as number | undefined;
    if (!version || schemaVersion !== 5) return undefined;
    const generatedAt = decoded?.generatedAt ?? pointer?.Item?.generatedAt as string | undefined;
    if (generatedAt && Date.now() - Date.parse(generatedAt) > 24 * 60 * 60 * 1_000) return undefined;
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `CATALOG_PROJECTION#${version}`, ':prefix': 'ORDER#' },
      ScanIndexForward: true,
      ConsistentRead: true,
      Limit: limit,
      ...(decoded?.key ? { ExclusiveStartKey: decoded.key } : {}),
    }));
    if (!decoded && Number(pointer?.Item?.groupCount ?? 0) > 0 && !(result.Items?.length)) return undefined;
    return {
      groups: (result.Items ?? []).map((item) => item.details as CatalogGroupDetails),
      ...(result.LastEvaluatedKey ? { cursor: Buffer.from(JSON.stringify({ schemaVersion, version, generatedAt, key: result.LastEvaluatedKey })).toString('base64url') } : {}),
    };
  }
  async getCatalogProjectionGroup(groupId: string): Promise<CatalogGroupDetails | undefined> {
    const pointer = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: 'CATALOG_PROJECTION', sk: 'CURRENT' }, ConsistentRead: true }));
    const version = pointer.Item?.version as string | undefined;
    const generatedAt = pointer.Item?.generatedAt as string | undefined;
    if (!version || pointer.Item?.schemaVersion !== 5 || !generatedAt || Date.now() - Date.parse(generatedAt) > 24 * 60 * 60 * 1_000) return undefined;
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `CATALOG_PROJECTION#${version}`, sk: `GROUP#${groupId}` },
      ConsistentRead: true,
    }));
    return result.Item?.details as CatalogGroupDetails | undefined;
  }
  async listLeverAdmissions(): Promise<LeverAdmission[]> {
    return (await this.queryAll({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': 'REGISTRY#LEVER', ':prefix': 'SOURCE#' },
    })).map((item) => item.admission as LeverAdmission);
  }
  async putLeverAdmission(admission: LeverAdmission): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { pk: 'REGISTRY#LEVER', sk: `SOURCE#${admission.source.site}`, admission },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new Error(`Lever site ${admission.source.site} is already admitted`);
      }
      throw error;
    }
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
export class DynamoReleaseStore implements ReleaseStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) { this.client = client ?? createDynamoDocumentClient(); }
  async getRelease(userId: string, releaseId: string) {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk: `RELEASE#${releaseId}` }, ConsistentRead: true }));
    return result.Item?.release as CatalogRelease | undefined;
  }
  async putRelease(release: CatalogRelease) {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { pk: `USER#${release.userId}`, sk: `RELEASE#${release.releaseId}`, kind: 'release', release },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      const existing = await this.getRelease(release.userId, release.releaseId);
      if (JSON.stringify(existing) !== JSON.stringify(release)) throw new Error(`Release identity conflict for ${release.releaseId}`);
    }
  }
}

export class MemoryUserStore implements UserStore {
  readonly preferences = new Map<string, UserPreferences>(); readonly devices = new Map<string, DeviceToken>(); readonly profiles = new Map<string, ApplicantProfile>(); readonly applications = new Map<string, ApplicationRecord>(); readonly sessions = new Map<string, ApplicationSession>(); readonly documents = new Map<string, UserDocument>(); readonly receipts = new Map<string, DeliveryReceipt>();
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
  async deleteUser(userId: string) { await this.beginUserDeletion(userId); const docs = await this.listDocuments(userId); for (const map of [this.preferences, this.profiles]) map.delete(userId); for (const [key] of this.devices) if (key.startsWith(`${userId}#`)) this.devices.delete(key); for (const [key] of this.applications) if (key.startsWith(`${userId}#`)) this.applications.delete(key); for (const [key] of this.sessions) if (key.startsWith(`${userId}#`)) this.sessions.delete(key); for (const [key] of this.documents) if (key.startsWith(`${userId}#`)) this.documents.delete(key); for (const [key] of this.receipts) if (key.startsWith(`${userId}#`)) this.receipts.delete(key); return docs; }
}

type UserItem = { pk: string; sk: string; kind: string; value: unknown; activePk?: string; tokenPk?: string; receiptPk?: string; alertPk?: string; activeSessionPk?: string; expiresAtEpoch?: number };
export class DynamoUserStore implements UserStore {
  private readonly client: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) { this.client = client ?? createDynamoDocumentClient(); }
  private async queryAll(command: ConstructorParameters<typeof QueryCommand>[0]) {
    const items: Record<string, unknown>[] = []; let cursor: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new QueryCommand({ ...command, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
      items.push(...(response.Items ?? []) as Record<string, unknown>[]); cursor = response.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  private async get<T>(userId: string, sk: string) { return (await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk } }))).Item?.value as T | undefined; }
  async beginUserDeletion(userId: string) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { ...deletedUserTombstoneKey(userId), kind: 'deleted-user-tombstone' } })); }
  async isUserDeletionPending(userId: string) { return Boolean((await this.client.send(new GetCommand({ TableName: this.tableName, Key: deletedUserTombstoneKey(userId), ConsistentRead: true }))).Item); }
  async hasActiveDocumentUploads() { return false; }
  private async put(userId: string, sk: string, kind: string, value: unknown, extra: Partial<UserItem> = {}) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { pk: `USER#${userId}`, sk, kind, value, ...extra } })); }
  getPreferences(userId: string) { return this.get<UserPreferences>(userId, 'PREFERENCES'); }
  putPreferences(value: UserPreferences) { return this.put(value.userId, 'PREFERENCES', 'preferences', value, value.alertsEnabled && value.onboardingComplete ? { alertPk: 'ACTIVE' } : {}); }
  async activePreferences() { return (await this.queryAll({ TableName: this.tableName, IndexName: 'activeAlertsIndex', KeyConditionExpression: 'alertPk = :active', ExpressionAttributeValues: { ':active': 'ACTIVE' } })).map((item) => item.value as UserPreferences); }
  async activeDevices() { return (await this.queryAll({ TableName: this.tableName, IndexName: 'activeDevicesIndex', KeyConditionExpression: 'activePk = :active', ExpressionAttributeValues: { ':active': 'ACTIVE' } })).map((item) => item.value as DeviceToken); }
  putDevice(value: DeviceToken) { return this.put(value.userId, `DEVICE#${value.token}`, 'device', value, value.active ? { activePk: 'ACTIVE', tokenPk: `TOKEN#${value.token}` } : { tokenPk: `TOKEN#${value.token}` }); } async deleteDevice(userId: string, token: string) { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk: `DEVICE#${token}` } })); }
  getProfile(userId: string) { return this.get<ApplicantProfile>(userId, 'PROFILE'); } putProfile(value: ApplicantProfile) { return this.put(value.userId, 'PROFILE', 'profile', value); }
  async listApplications(userId: string) { return (await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'APPLICATION#' } })).map((item) => item.value as ApplicationRecord).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  getApplication(userId: string, applicationId: string) { return this.get<ApplicationRecord>(userId, `APPLICATION#${applicationId}`); } putApplication(userId: string, value: ApplicationRecord) { return this.put(userId, `APPLICATION#${value.applicationId}`, 'application', value); } async deleteApplication(userId: string, applicationId: string) { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk: `APPLICATION#${applicationId}` } })); }
  getApplicationSession(userId: string, sessionId: string) { return this.get<ApplicationSession>(userId, `APPLICATION_SESSION#${sessionId}`); }
  async getApplicationSessionById(sessionId: string) {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: 'activeSessionsIndex', KeyConditionExpression: 'activeSessionPk = :pk', ExpressionAttributeValues: { ':pk': `SESSION#${sessionId}` }, Limit: 1 }));
    return response.Items?.[0]?.value as ApplicationSession | undefined;
  }
  async putApplicationSession(userId: string, value: ApplicationSession, expectedVersion?: number) {
    const active = !['submitted', 'failed', 'cancelled'].includes(value.status);
    const input = {
      TableName: this.tableName,
      Item: {
        pk: `USER#${userId}`,
        sk: `APPLICATION_SESSION#${value.sessionId}`,
        kind: 'application-session',
        value,
        ...(active ? { activeSessionPk: `SESSION#${value.sessionId}` } : {}),
        expiresAtEpoch: Math.floor(new Date(value.metadataExpiresAt).getTime() / 1000),
      } satisfies UserItem,
      ...(expectedVersion === undefined
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: '#value.#version = :expectedVersion', ExpressionAttributeNames: { '#value': 'value', '#version': 'version' }, ExpressionAttributeValues: { ':expectedVersion': expectedVersion } }),
    };
    try { await this.client.send(new PutCommand(input)); return true; } catch (error) { if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false; throw error; }
  }
  async listApplicationSessions(userId: string, applicationId?: string) { return (await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'APPLICATION_SESSION#' } })).map((item) => item.value as ApplicationSession).filter((session) => !applicationId || session.applicationId === applicationId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async listDocuments(userId: string) { return (await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'DOCUMENT#' } })).map((item) => item.value as UserDocument); } putDocument(value: UserDocument) { return this.put(value.userId, `DOCUMENT#${value.documentId}`, 'document', value); } async deleteDocument(userId: string, documentId: string) { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `USER#${userId}`, sk: `DOCUMENT#${documentId}` } })); }
  getReceipt(userId: string, dedupeKey: string, token: string) { return this.get<DeliveryReceipt>(userId, `RECEIPT#${dedupeKey}#${token}`); }
  async claimReceipt(value: DeliveryReceipt) {
    const item: UserItem = { pk: `USER#${value.userId}`, sk: `RECEIPT#${value.dedupeKey ?? value.jobId}#${value.token}`, kind: 'receipt', value, receiptPk: value.status === 'deferred' ? 'DEFERRED' : 'PENDING' };
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) OR #value.#status = :error',
        ExpressionAttributeNames: { '#value': 'value', '#status': 'status' },
        ExpressionAttributeValues: { ':error': 'error' },
      }));
      return true;
    } catch (error) { if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false; throw error; }
  }
  putReceipt(value: DeliveryReceipt) { return this.put(value.userId, `RECEIPT#${value.dedupeKey ?? value.jobId}#${value.token}`, 'receipt', value, value.status === 'pending' ? { receiptPk: 'PENDING' } : value.status === 'retryable' ? { receiptPk: 'RETRYABLE' } : value.status === 'deferred' ? { receiptPk: 'DEFERRED' } : {}); }
  async migrateReceipt(value: DeliveryReceipt, dedupeKey: string) {
    const migrated = { ...value, dedupeKey };
    const item: UserItem = {
      pk: `USER#${value.userId}`, sk: `RECEIPT#${dedupeKey}#${value.token}`, kind: 'receipt', value: migrated,
      ...(value.status === 'pending' ? { receiptPk: 'PENDING' } : value.status === 'retryable' ? { receiptPk: 'RETRYABLE' } : {}),
    };
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  async pendingReceipts() { return (await this.queryAll({ TableName: this.tableName, IndexName: 'pendingReceiptsIndex', KeyConditionExpression: 'receiptPk = :pending', ExpressionAttributeValues: { ':pending': 'PENDING' } })).map((item) => item.value as DeliveryReceipt); }
  async retryableReceipts() { return (await this.queryAll({ TableName: this.tableName, IndexName: 'pendingReceiptsIndex', KeyConditionExpression: 'receiptPk = :retryable', ExpressionAttributeValues: { ':retryable': 'RETRYABLE' } })).map((item) => item.value as DeliveryReceipt); }
  async deferredReceipts() { return (await this.queryAll({ TableName: this.tableName, IndexName: 'pendingReceiptsIndex', KeyConditionExpression: 'receiptPk = :deferred', ExpressionAttributeValues: { ':deferred': 'DEFERRED' } })).map((item) => item.value as DeliveryReceipt); }
  async deleteUser(userId: string) {
    await this.beginUserDeletion(userId);
    const documents = await this.listDocuments(userId);
    const items = await this.queryAll({ TableName: this.tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `USER#${userId}` } });
    await Promise.all(items.map((item) => this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: item.pk, sk: item.sk } }))));
    return documents;
  }
}
