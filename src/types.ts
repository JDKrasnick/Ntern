import type { JobFilter } from './core/filters.js';
import type { EmployerCategory } from './core/employers.js';

export type ApplicationStatus =
  | 'saved' | 'applied' | 'assessment' | 'interview' | 'offer' | 'rejected' | 'withdrawn';

export interface ApplicationRecord {
  applicationId: string;
  jobId: string;
  status: ApplicationStatus;
  updatedAt: string;
  createdAt: string;
  /** Submission timestamp, whether manually confirmed or detected from mail metadata. */
  appliedAt?: string;
  /** Queue membership timestamp; only set while status is 'saved'. */
  queuedAt?: string;
  /** Mail-derived provenance is removed on Gmail disconnect without changing status. */
  detection?: { source: 'gmail'; detectedAt: string };
  notes?: string;
  /** `partner` is only set after an employer has granted direct-submit access. */
  applyMode?: 'official-form' | 'partner';
}

export type AlertDelivery = 'immediate' | 'daily-digest';
export type ApplicationHandoff = 'window' | 'tab';

/** Delivery preferences are stored separately from the role filter so they can evolve independently. */
export interface AlertSettings {
  delivery: AlertDelivery;
  quietHours?: { start: string; end: string; timezone: string };
  applicationReminders: boolean;
  followUpDays: number;
}

export interface UserPreferences {
  userId: string;
  filter: JobFilter;
  alertsEnabled: boolean;
  /** Email is a separate channel and is never inferred from push opt-in. */
  emailAlertsEnabled?: boolean;
  onboardingComplete: boolean;
  /** Web-only preference for opening the employer's official form. */
  applicationHandoff?: ApplicationHandoff;
  /**
   * The bounded timestamp used by the signed-in launch inbox. A missing value
   * means this is the user's first launch after the feature was introduced.
   */
  lastCatalogOpenedAt?: string;
  alertSettings?: AlertSettings;
  /** Uses the same safe placeholders as the legacy compact ntfy notification. */
  push?: { titleTemplate?: string; descriptionTemplate?: string; roleAbbreviations?: Record<string, string> };
  updatedAt: string;
}

export interface DeviceToken {
  userId: string;
  token: string;
  platform: 'ios' | 'android';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Core details are deliberately separate from optional sensitive application answers. */
export interface ApplicantProfile {
  userId: string;
  contact: {
    name: string;
    /** Explicit parts prevent unsafe guessing from an international full name. */
    firstName?: string;
    lastName?: string;
    email: string;
    phone?: string;
  };
  location: string;
  workAuthorization: string;
  links: Record<string, string>;
  education: Array<{ school: string; degree?: string; field?: string; graduationDate?: string }>;
  reusableAnswers: Record<string, string>;
  resumeDocumentId?: string;
  /** Stored encrypted by the user store and returned only to the profile owner. */
  sensitive?: Record<string, unknown>;
  updatedAt: string;
}

export interface UserDocument {
  userId: string;
  documentId: string;
  fileName: string;
  contentType: string;
  objectKey: string;
  createdAt: string;
}

export const ACCOUNT_EXPORT_SCHEMA_VERSION = 1 as const;

export interface AccountDataExport {
  schemaVersion: typeof ACCOUNT_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  account: {
    profile: ApplicantProfile | null;
    applications: ApplicationRecord[];
    documents: Array<Pick<UserDocument, 'documentId' | 'fileName' | 'contentType' | 'createdAt'>>;
  };
}

export interface DeliveryReceipt {
  userId: string;
  jobId: string;
  /** Hash of the strong provider posting identity; absent on legacy receipts. */
  dedupeKey?: string;
  token: string;
  ticketId?: string;
  status: 'pending' | 'retryable' | 'ok' | 'error';
  attempts?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  lastErrorAt?: string;
  /** Provider-aware state; `status` remains during the legacy receipt migration. */
  deliveryState?: 'claimed' | 'accepted' | 'delivered' | 'definitive-failure' | 'unknown';
  createdAt: string;
  updatedAt: string;
}

/** Reason a source fetch or snapshot did not produce a trusted result. */
export type SourceFailureCategory = 'http' | 'json' | 'transport' | 'identity' | 'link' | 'empty' | 'quality' | 'persistence' | 'capacity';

export interface SourceCheckpoint {
  /** Forces continuation and gate rollback until all admission slices finish. */
  pendingAdmissionConfigurationVersion?: string;
  sourceId: string;
  etag?: string;
  documentEtags?: Record<string, string>;
  contentHash?: string;
  /** Algorithm used to calculate contentHash; missing values are legacy v1. */
  contentHashAlgorithmVersion?: number;
  /** Version of the reviewed admission configuration applied to this snapshot. */
  admissionConfigurationVersion?: string;
  /** Parser version applied after a successful full source reconciliation. */
  metadataExtractionVersion?: number;
  /** Source preprocessing revision, separate from API/page extraction. */
  metadataProcessingRevision?: number;
  /** Successfully processed current rows while a bounded parser refresh is incomplete. */
  pendingMetadataProcessedRows?: Array<{
    externalId: string;
    sourceMaterialHash: string;
    extractionVersion: number;
    processingRevision: number;
  }>;
  /** Missing occurrences whose one lifecycle step was durably applied during this refresh. */
  pendingMetadataOmissions?: Array<{
    externalId: string;
    extractionVersion: number;
    processingRevision: number;
  }>;
  /**
   * Listings still owed a resolution pass while a bounded delivery slice is
   * open. Present only while the pass is incomplete; the delivery that empties
   * it also reconciles omissions and closures.
   */
  pendingResolutionRows?: string[];
  lastSuccessAt?: string;
  successfulFetches: number;
  lastRowCount?: number;
  lastRawCount?: number;
  /** Stable posting IDs in the last trusted complete snapshot. */
  activeExternalIds?: string[];
  lastRawRowCount?: number;
  lastWithheldRowCount?: number;
}

export type TrustedCommunityAlertMode = 'disabled' | 'exact-identity-or-two-complete-snapshots';

export interface TrustedCommunityAlertQualification {
  /** Raw source facts inspected under the occurrence's admission version. */
  sourceMaterialHash?: string;
  /** Canonicalized source candidate used to detect source-side destination changes. */
  candidateKey: string;
  /** Set only after a posting-specific destination has been validated. */
  validatedDestinationKey?: string;
  consecutiveCompleteSnapshots: number;
  lastCountedSuccessfulFetchSequence?: number;
  status: 'disabled' | 'pending' | 'eligible' | 'ineligible';
  basis?: 'exact-identity' | 'two-complete-snapshots';
  /** Permanent for the occurrence: activating a policy can never alert its backlog. */
  baselineSuppressed: boolean;
  /** Temporary fail-closed state while a complete source-policy migration is pending. */
  catalogPublicationSuppressed?: boolean;
}

export interface TrustedCommunitySourceMetrics {
  rawRows: number;
  eligibleRows: number;
  rejectedAggregatorRows: number;
  survivingAggregatorRows: number;
  duplicateOccurrenceIds: number;
  inspectedCandidates: number;
  browserInspectionCandidates: number;
  destinationFailures: number;
  destinationFailuresByReason: Partial<Record<CatalogAdmissionReason, number>>;
  inspectionCoverage: number;
  browserInspectionShare: number;
  destinationFailureRate: number;
  catalogYield: number;
  alertYield: number;
}

export type SourceHealthState = 'healthy' | 'degraded' | 'quarantined' | 'never-succeeded';
export type SourceIncidentState = 'open' | 'acknowledged' | 'resolved';
export type SourcePollTier = 'active' | 'quiet';
export type SourceOperationalStatus = 'active' | 'paused';
export type SourceOutcome =
  | 'changed'
  | 'unchanged'
  | 'failed'
  | 'success_changed'
  | 'success_unchanged_304'
  | 'success_unchanged_hash'
  | 'temporary_provider_error'
  | 'rate_limited'
  | 'invalid_configuration'
  | 'not_found'
  | 'invalid_schema'
  | 'incomplete_pagination'
  | 'unexpected_raw_zero'
  | 'application_host_mismatch'
  | 'catalog_write_failed'
  | 'resource_limit';

/** One scheduled dispatch of a source. A source stays suppressed while this
 * marker is unexpired and the source has not attempted a poll since. */
export interface SourceDispatch {
  sourceId: string;
  provider: string;
  dispatchedAt: string;
}

export interface SourceHealth {
  sourceId: string;
  employerId?: string;
  /** Persisted identifiers remain open strings so retired and future providers stay readable. */
  provider?: string;
  /** Provider-declared region identifier; historical unregistered values remain readable. */
  region?: string;
  state?: SourceHealthState;
  sourceStatus?: SourceOperationalStatus;
  pollTier?: SourcePollTier;
  pollTierMode?: 'automatic' | 'operator';
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastChangedAt?: string;
  freshnessMinutes?: number;
  outcome?: SourceOutcome;
  lastOutcome?: SourceOutcome;
  consecutiveFailures: number;
  etag?: string;
  contentHash?: string;
  snapshotHash?: string;
  counts?: ProcessedSnapshot['counts'];
  rawRows?: number;
  rawCount?: number;
  validRows?: number;
  validCount?: number;
  eligibleRows?: number;
  eligibleCount?: number;
  filteredRows?: number;
  filteredCount?: number;
  withheldRows?: number;
  withheldCount?: number;
  applicationLinksChecked?: number;
  applicationLinkFailures?: number;
  applicationLinkFailureSamples?: Array<{ category: SourceFailureCategory; diagnostic: string }>;
  durationMs: number;
  failureCategory?: SourceFailureCategory;
  lastFailureCategory?: SourceFailureCategory;
  diagnosticCategory?: SourceFailureCategory | 'persistence' | 'quality';
  diagnostic?: string;
  lastSafeDiagnostic?: string;
  backoffUntil?: string;
  incidentState?: SourceIncidentState;
  incidentSeverity?: 'warning' | 'high';
  incidentOpenedAt?: string;
  incidentUpdatedAt?: string;
  incidentAcknowledgedAt?: string;
  incidentResolvedAt?: string;
  configVersion?: number;
  changedAt?: string;
  changedBy?: string;
  quarantinedAt?: string;
  quarantineReason?: string;
  recentRuns?: SourceRun[];
  trustedCommunity?: TrustedCommunitySourceMetrics;
}

export interface SourceRun {
  runId: string;
  sourceId: string;
  provider?: SourceHealth['provider'];
  region?: SourceHealth['region'];
  outcome?: SourceOutcome;
  state: 'succeeded' | 'failed' | 'quarantined';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  rawRows?: number;
  eligibleRows?: number;
  withheldRows?: number;
  failureCategory?: SourceFailureCategory;
  diagnostic?: string;
}

export type MonitoringChecklistItemId =
  | 'review-fleet-health'
  | 'inspect-failed-extractions'
  | 'confirm-dead-letter-queues'
  | 'exercise-greenhouse-recovery'
  | 'exercise-lever-recovery'
  | 'exercise-ashby-recovery'
  | 'verify-reminder-delivery'
  | 'confirm-nightly-contract';

export interface MonitoringChecklistCompletion {
  completedAt: string;
  completedBy: string;
}

export interface MonitoringChecklist {
  period: string;
  completions: Partial<Record<MonitoringChecklistItemId, MonitoringChecklistCompletion>>;
  updatedAt?: string;
  updatedBy?: string;
  version: number;
}

export interface SourceReference {
  sourceId: string;
  /** Reviewed provenance attached at ingestion; legacy rows are resolved through the reviewed registry. */
  provenance?: OccurrenceProvenance;
  document: string;
  sourceUrl: string;
  row: number;
  postedAt?: string;
  /** Provider timestamp kept separate from when InternNotifs observed the row. */
  providerTimestamp?: ProviderTimestamp;
  /** Source-declared workplace arrangement; absent when the source does not declare one. */
  workMode?: 'remote' | 'hybrid' | 'onsite';
  /** Compact normalized facts extracted from this occurrence's already-fetched artifacts. */
  metadataEvidence?: RoleMetadataEvidence[];
  metadataExtraction?: {
    version: number;
    artifactHash: string;
    observedAt: string;
    outcome: 'extracted' | 'no-explicit-metadata';
  };
}

export type OccurrenceProvenance =
  | 'official-ats'
  | 'official-structured'
  | 'employer-submitted'
  | 'reviewed-community';

export interface CanonicalEmployer {
  id: string;
  displayName: string;
  reviewedAt: string;
  reviewedBy: string;
  parentEmployerId?: string;
  brandOfEmployerId?: string;
}

export interface ProviderIdentity {
  provider: PostingProvider | 'github' | 'structured' | 'employer-submission';
  sourceId: string;
  /** Per-employer reviewed-mapping scope for multi-employer sources. */
  employerScope?: string;
  tenant?: string;
  postingId?: string;
  sourceUrl: string;
}

export interface EmployerMapping {
  id: string;
  provider: ProviderIdentity['provider'];
  scope: string;
  canonicalEmployerId: string;
  reviewedAt: string;
  reviewedBy: string;
  supersedesMappingId?: string;
  supersededAt?: string;
}

export type DestinationClassification =
  | 'posting-detail'
  | 'application-form'
  | 'aggregate-board'
  | 'blocked-uninspectable'
  | 'gone'
  | 'unresolved';

export interface DestinationEvidence {
  classification: DestinationClassification;
  candidateUrl: string;
  finalUrl?: string;
  provider: ProviderIdentity['provider'];
  tenant?: string;
  expectedPostingId?: string;
  inspectedAt: string;
  /** Structured conclusion from the destination artifact, evaluated before generic live-page evidence. */
  closureState?: 'open' | 'gone' | 'unknown';
  closureSignal?: 'http-gone' | 'explicit-language' | 'valid-through-expired';
  /** Publisher-declared JobPosting.validThrough, normalized to UTC when usable. */
  validThrough?: string;
  /** Admission evidence is never trusted for more than seven days. */
  freshUntil?: string;
  /** Scheduler target, intentionally before freshUntil so a transient retry does not immediately pause alerts. */
  nextCheckAt?: string;
  inspectionTruncated?: boolean;
  inspectedBytes?: number;
  evidenceHash?: string;
  postingIdPresent?: boolean;
  jobPostingCount?: number;
  distinctJobLinkCount?: number;
  applicationFormPresent?: boolean;
  browserVisible?: boolean;
  evidenceFrameUrl?: string;
  evidenceFrameKind?: 'main' | 'child';
  renderedFrameCount?: number;
  failedFrameCount?: number;
  selfReferentialFrame?: boolean;
  renderedEvidenceHash?: string;
  identicalEvidenceForDifferentPosting?: boolean;
  lastKnownGoodAt?: string;
}

export interface MetadataCompleteness {
  complete: boolean;
  title: 'complete' | 'missing' | 'truncated' | 'malformed' | 'approximate-repair';
  location: 'complete' | 'not-specified' | 'truncated' | 'malformed';
}

export type CatalogAdmissionReason =
  | 'employer-unresolved'
  | 'employer-generic-label'
  | 'employer-conflict'
  | 'posting-unattributed'
  | 'destination-aggregate-board'
  | 'destination-blocked-uninspectable'
  | 'destination-gone'
  | 'destination-unresolved'
  | 'destination-grace'
  | 'destination-stale'
  | 'metadata-title-missing'
  | 'metadata-title-truncated'
  | 'metadata-title-malformed'
  | 'metadata-title-approximate-repair'
  | 'metadata-conflict'
  | 'metadata-location-truncated'
  | 'metadata-location-malformed';

export type CatalogAdmissionEvidence = 'trusted-community-source';

export interface CatalogAdmission {
  canonicalEmployer?: Pick<CanonicalEmployer, 'id' | 'displayName'>;
  employerResolution: 'resolved' | 'source-reported' | 'unresolved' | 'conflict';
  postingAttribution: 'attributed' | 'unattributed';
  destination: DestinationEvidence;
  metadata: MetadataCompleteness;
  catalogEligible: boolean;
  alertEligible: boolean;
  reasonCodes: CatalogAdmissionReason[];
  evidenceCodes?: CatalogAdmissionEvidence[];
  evaluatedAt: string;
  evidenceObservedAt: string;
  /** Last successful verification of this exact role's official destination. Public during temporary unreadability. */
  lastVerifiedAt?: string;
  graceDeadline?: string;
}

export interface AdmissionIncident {
  id: string;
  jobId: string;
  sourceId: string;
  host: string;
  reasonCode: CatalogAdmissionReason;
  state: 'open' | 'resolved' | 'quarantined';
  openedAt: string;
  updatedAt: string;
  graceDeadline?: string;
  warningSentAt?: string;
  quarantineSentAt?: string;
}

export interface DestinationReviewRule {
  id: string;
  host: string;
  provider: ProviderIdentity['provider'];
  tenant?: string;
  decision: 'standard-provider-route' | 'browser-required' | 'aggregate-board' | 'blocked-accepted';
  reviewedAt: string;
  reviewedBy: string;
  sampleDueAt?: string;
}

export type WorkAuthorizationStatus =
  | 'sponsorship-available'
  | 'no-sponsorship'
  | 'existing-authorization-required'
  | 'citizenship-required'
  | 'unknown';

export interface ApplicationDeadline {
  kind: 'date' | 'rolling';
  /** Required for `date`; the role closes at the end of this date in `timezone`. */
  date?: string;
  timezone?: string;
}

/** The meaning the provider assigns to a timestamp; it is never an InternNotifs observation time. */
export interface ProviderTimestamp {
  value: string;
  semantics: 'published' | 'updated';
}

/** Ordered from most to least authoritative for provider-neutral enrichment. */
export type EvidenceSource =
  | 'official-api'
  | 'official-ats'
  /** Reviewer-approved extraction from an exact official posting revision. */
  | 'reviewed-shadow'
  | 'official-json-ld'
  | 'official-page'
  | 'reviewed-community'
  | 'deterministic-inference';

/** A compact reference to why a field has its current value. Full descriptions are never stored here. */
export interface FieldProvenance {
  source: EvidenceSource;
  sourceId: string;
  sourceUrl?: string;
  evidenceCode: string;
  contentHash?: string;
  observedAt?: string;
}

export interface ProvenancedValue<T> {
  value: T;
  provenance: FieldProvenance[];
}

export type InternshipProgramType = 'internship' | 'co-op' | 'apprenticeship' | 'new-grad' | 'entry-level';
export type SeasonTerm = 'spring' | 'summer' | 'fall' | 'winter';
export type SeasonEvidenceStatus = 'explicit' | 'inferred' | 'unspecified';

export interface SeasonIdentity {
  term?: SeasonTerm;
  year?: number;
  evidenceStatus: SeasonEvidenceStatus;
  provenance: FieldProvenance[];
}

export type EducationLevel = 'undergraduate' | 'masters' | 'mba' | 'doctoral';
export type MinimumDegree = 'none' | 'high-school' | 'associates' | 'bachelors' | 'masters' | 'doctoral';
export type EducationEvidenceStatus = 'explicit' | 'unspecified' | 'conflicting';

export interface GraduationDateWindow {
  /** Inclusive ISO-8601 year-month (`YYYY-MM`) or date (`YYYY-MM-DD`). */
  start?: string;
  /** Inclusive ISO-8601 year-month (`YYYY-MM`) or date (`YYYY-MM-DD`). */
  end?: string;
}

/**
 * Audience and minimum qualification are deliberately separate. An empty
 * `levels` list with `unspecified` matches every user and must be shown as
 * "Education level not specified by employer."
 */
export interface EducationAudience {
  levels: EducationLevel[];
  graduationDateWindow?: GraduationDateWindow;
  minimumDegree?: MinimumDegree;
  evidenceStatus: EducationEvidenceStatus;
  provenance: FieldProvenance[];
}

export type DisciplineTag = 'software' | 'ai-ml' | 'data' | 'infrastructure-cloud' | 'security' | 'quant' | 'product' | 'technical-design';
export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unspecified';

export interface InternshipLocation {
  name: string;
  workMode: WorkMode;
  provenance: FieldProvenance[];
}

/** Descriptive grouping identity. None of these fields alone proves an exact duplicate. */
export interface InternshipIdentity {
  company: {
    canonicalId: string;
    displayName: ProvenancedValue<string>;
  };
  programType: ProvenancedValue<InternshipProgramType>;
  season: SeasonIdentity;
  education: EducationAudience;
  title: {
    official: ProvenancedValue<string>;
    display: ProvenancedValue<string>;
    search: ProvenancedValue<string>;
  };
  disciplines: Array<ProvenancedValue<DisciplineTag>>;
  locations: InternshipLocation[];
}

export const POSTING_PROVIDERS = [
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'bytedance',
  'tesla',
  'meta',
  'janestreet',
  'goldman-sachs',
  'imc',
  'icims',
  'smartrecruiters',
  'unknown',
] as const;
export type PostingProvider = typeof POSTING_PROVIDERS[number];
export type PostingAliasKind = 'provider-posting' | 'employer-requisition' | 'provider-route' | 'official-url' | 'application-url';

export interface PostingAlias {
  kind: PostingAliasKind;
  value: string;
  sourceUrl?: string;
}

/** Immutable provider facts carried from a reviewed connector or checkpoint. */
export interface ProviderPostingEvidence {
  provider: Extract<PostingProvider, 'greenhouse' | 'lever'>;
  tenant: string;
  postingId: string;
  sourceId: string;
  /** Every provider-issued presentation URL observed in the same API row. */
  urls: string[];
  /** Registry contract that validated this observation. Older evidence omits rollout metadata. */
  contractId?: string;
  contractVersion?: number;
  approvalReference?: string;
  evidenceHash?: string;
  observedAt?: string;
  expiresAt?: string;
}

export type PostingIdentityEvidenceKind =
  | 'immutable-provider-id'
  | 'authoritative-employer-requisition'
  | 'reviewed-canonical-url';

export type PostingIdentityUnconfirmedReason =
  | 'unrecognized-url-family'
  | 'under-scoped-id'
  | 'stale-evidence'
  | 'insufficient-exact-evidence';

export type PostingIdentityConflictReason =
  | 'aliases-resolve-to-different-jobs'
  | 'multiple-immutable-provider-postings'
  | 'provider-scope-mismatch'
  | 'employer-scope-mismatch'
  | 'multiple-authoritative-requisitions'
  | 'evidence-contract-mismatch';

/** Durable occurrence-level decision; posting attribution remains a separate admission fact. */
export type PostingIdentityDecision =
  | {
      status: 'confirmed';
      exactKey: string;
      evidenceKind: PostingIdentityEvidenceKind;
      provider?: Exclude<PostingProvider, 'unknown'>;
      tenant?: string;
      employerId?: string;
      contractId: string;
      contractVersion: number;
      approvalReference: string;
      evidenceHash: string;
      observedAt: string;
    }
  | {
      status: 'unconfirmed';
      reason: PostingIdentityUnconfirmedReason;
      reviewFamilyKey: string;
      observedAt: string;
    }
  | {
      status: 'quarantined';
      reason: PostingIdentityConflictReason;
      contradictoryEvidence: string[];
      reviewFamilyKey: string;
      observedAt: string;
    };

export interface PostingIdentityIncident {
  incidentId: string;
  sourceId: string;
  externalId: string;
  decision: Extract<PostingIdentityDecision, { status: 'quarantined' }>;
  occurrence: SourceOccurrence;
  recordedAt: string;
}

/** Exact requisition identity. It is intentionally independent from `InternshipIdentity`. */
export interface PostingIdentity {
  provider: PostingProvider;
  tenant?: string;
  providerPostingId?: string;
  employerRequisitionId?: string;
  employerRequisitionAuthoritative?: boolean;
  canonicalApplicationUrl: string;
  aliases: PostingAlias[];
  canonicalJobId: string;
}

export interface Compensation {
  raw: string;
  minHourlyUSD?: number;
  maxHourlyUSD?: number;
  minAnnualUSD?: number;
  maxAnnualUSD?: number;
  /** Distinct disclosed ranges; applicability is never collapsed into global extrema. */
  ranges?: CompensationRange[];
}

export type CompensationPeriod = 'hourly' | 'annual' | 'daily' | 'weekly' | 'monthly' | 'unknown' | 'other';

export interface CompensationRange {
  minAmount: number;
  maxAmount: number;
  currency: string;
  period: CompensationPeriod;
  /** Publisher-supplied range label, not an inferred location or degree. */
  applicabilityLabel?: string;
  /** Explicit nonstandard pay interval, retained without annualization. */
  periodLabel?: string;
  applicableLocations?: string[];
  applicableEducationLevels?: EducationLevel[];
  /** Pay-only, whitespace-bounded excerpt; never a job-description excerpt. */
  sourceText: string;
  provenance: FieldProvenance[];
}

export type RoleMetadataField =
  | 'compensation'
  | 'housing'
  | 'education'
  | 'graduation-window'
  | 'locations'
  | 'work-mode'
  | 'application-deadline'
  | 'employer-published-at'
  | 'employer-updated-at';

/** Employer-disclosed housing support or employee expense, never base salary. */
export interface HousingDetail {
  kind: 'stipend' | 'employer-paid' | 'employee-cost' | 'available';
  minAmount?: number;
  maxAmount?: number;
  currency?: string;
  period?: CompensationPeriod;
  periodLabel?: string;
  conditional?: boolean;
  sourceText: string;
  provenance: FieldProvenance[];
}

/** Versioned, provider-neutral evidence extracted from one exact posting artifact. */
export interface RoleMetadataEvidence {
  schemaVersion: 1;
  extractionVersion: number;
  artifactHash: string;
  sourceClass: EvidenceSource;
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
  exactPosting: true;
  compensationRanges?: CompensationRange[];
  housing?: HousingDetail[];
  education?: EducationAudience;
  locations?: InternshipLocation[];
  workMode?: ProvenancedValue<Exclude<WorkMode, 'unspecified'>>;
  applicationDeadline?: ProvenancedValue<ApplicationDeadline>;
  employerPublishedAt?: ProvenancedValue<string>;
  employerUpdatedAt?: ProvenancedValue<string>;
  /** Bounded field excerpts only. Full posting text is intentionally excluded. */
  excerpts?: Partial<Record<RoleMetadataField, string>>;
}

export interface MetadataConflict {
  field: RoleMetadataField;
  applicabilityKey?: string;
  evidenceHashes: string[];
  values: string[];
}

/** Operations-approved omission, activated only by the guarded repair path. */
export interface RoleMetadataOmission {
  field: 'compensation';
  action: 'omit';
  reason: 'publisher-inconsistent';
  evidenceFingerprint: string;
  reviewToken: string;
}

/** Compact canonical result. Evidence history and conflicts live in operations tables. */
export interface ReconciledRoleMetadata {
  schemaVersion: 1;
  extractionVersion: number;
  evidenceHashes: string[];
  compensationRanges?: CompensationRange[];
  housing?: HousingDetail[];
  education?: EducationAudience;
  locations?: InternshipLocation[];
  workMode?: ProvenancedValue<Exclude<WorkMode, 'unspecified'>>;
  applicationDeadline?: ProvenancedValue<ApplicationDeadline>;
  graduationWindow?: ProvenancedValue<GraduationDateWindow>;
  employerPublishedAt?: ProvenancedValue<string>;
  employerUpdatedAt?: ProvenancedValue<string>;
}

/** Source-declared constraints; absence never implies that a constraint does not exist. */
export interface JobRequirements {
  requiresUsCitizenship: boolean;
  advancedDegreeRequired: boolean;
}

export interface SourceOccurrence extends SourceReference {
  externalId?: string;
  /** Admission rules applied to this row, so interrupted source migrations can resume safely. */
  admissionConfigurationVersion?: string;
  /** Source-row parser work applied to this exact raw material. */
  sourceMetadataProcessing?: {
    extractionVersion: number;
    processingRevision: number;
    sourceMaterialHash: string;
  };
  /** Hash of the exact normalized title and provider description used by shadow extraction. */
  shadowContentHash?: string;
  /** Reviewed provider facts retained for identity repair and audit. */
  providerEvidence?: ProviderPostingEvidence;
  /** Durable identity decision for this occurrence. Missing means legacy-unclassified. */
  postingIdentityDecision?: PostingIdentityDecision;
  /** Durable evidence for delayed alerts from an explicitly trusted community source. */
  trustedCommunityAlertQualification?: TrustedCommunityAlertQualification;
  /** Source-local classification retained so job eligibility is independent of poll order. */
  technical?: boolean;
  company: string;
  title: string;
  location: string;
  locations?: string[];
  season: string;
  applyUrl: string;
  compensation: Compensation;
  requirements?: JobRequirements;
  state: 'open' | 'closed';
  /** Record-level evidence; missing values identify legacy rows awaiting backfill. */
  admission?: CatalogAdmission;
  employerLabelOrigin?: 'explicit' | 'inherited';
  employerInheritance?: 'same-tenant' | 'unresolved' | 'conflict';
  /** Exact time this source was first linked to this catalog job, when known. */
  firstAttachedAt?: string;
  /** Legacy references predate attribution tracking and must not imply precision. */
  firstAttachedAtPrecision?: 'exact' | 'unknown';
}

export interface SourceOccurrenceState {
  sourceId: string;
  externalId: string;
  jobId: string;
  occurrence: SourceOccurrence;
  present: boolean;
  consecutiveOmissions: number;
  /** Snapshot in which this occurrence last changed. */
  changedSnapshotHash: string;
  changedAt: string;
  /** Immutable InternNotifs observation time, never a provider timestamp. */
  firstObservedAt?: string;
  /** `unknown` explicitly identifies legacy/backfilled records. */
  firstObservedAtPrecision?: 'exact' | 'unknown';
}

/**
 * Read-time view of one occurrence. Change facts are durable per occurrence;
 * confirmation is derived from the source checkpoint, which already records the
 * active ID set, so confirming a snapshot costs no per-occurrence write.
 */
export interface SourceOccurrenceStatus extends SourceOccurrenceState {
  confirmedSnapshotHash?: string;
  confirmedAt?: string;
  /** Alias for operator reports: confirmation comes from the durable source checkpoint. */
  lastConfirmedAt?: string;
}

export interface NotificationEvent {
  eventId: string;
  sourceId: string;
  externalId: string;
  jobId: string;
  kind: 'new-job';
  createdAt: string;
}

export interface ProcessedListing extends SourceOccurrence {
  /** Stable within one source; row numbers are diagnostics only. */
  externalId?: string;
  fetchedAt: string;
  /** Classification is decided before persistence and never recomputed by the store. */
  technical?: boolean;
  /** The source truncated this title and it was reconstructed, so it may be approximate. */
  titleRepaired?: boolean;
  /** Whether the season came from this posting or a list-wide default. */
  seasonSource?: 'posting' | 'source-default';
  /** Exact provider-aware identity resolved before reconciliation. */
  postingIdentity?: PostingIdentity;
  /** Identity certainty is independent from publication admission. */
  postingIdentityDecision?: PostingIdentityDecision;
  /** Reviewed evidence used to build `postingIdentity`; never inferred from display fields. */
  providerEvidence?: ProviderPostingEvidence;
  /** Descriptive identity used for program grouping and audience filtering. */
  internshipIdentity?: InternshipIdentity;
  providerIdentity?: ProviderIdentity;
  employerEvidence?: {
    authority: SourcedPosting['employer']['authority'];
    canonicalEmployer?: Pick<CanonicalEmployer, 'id' | 'displayName'>;
  };
  metadataCompleteness?: MetadataCompleteness;
}

/** @deprecated Use `ProcessedListing`; retained only while callers migrate. */
export type RawListing = ProcessedListing;

export interface SourcedPosting {
  sourceId: string;
  provenance?: OccurrenceProvenance;
  externalId: string;
  sourceUrl: string;
  document?: string;
  row?: number;
  fetchedAt: string;
  employer: {
    id?: string;
    name: string;
    authority: 'reviewed-registry' | 'source-row';
    labelOrigin?: 'explicit' | 'inherited';
    inheritance?: 'same-tenant' | 'unresolved' | 'conflict';
  };
  providerIdentity?: Omit<ProviderIdentity, 'sourceId' | 'sourceUrl' | 'postingId'>;
  title: string;
  content: Array<{
    kind: 'description' | 'requirements' | 'additional';
    format: 'plain' | 'html' | 'markdown';
    value: string;
  }>;
  locations: string[];
  applyUrl: string;
  hostedUrl?: string;
  providerEvidence?: ProviderPostingEvidence;
  sourceState: 'open' | 'closed' | 'prospect';
  /**
   * `title` requires an explicit early-career signal in the posting title.
   * `posting` trusts a provider field that explicitly identifies this row as an
   * internship. `source` marks a reviewed early-career-only document.
   */
  lifecycleAuthority?: 'title' | 'posting' | 'source';
  publishedAt?: string;
  providerTimestamp?: ProviderTimestamp;
  seasonHint?: string;
  seasonHintAuthority?: 'posting' | 'source-default';
  classificationTags?: string[];
  declaredWorkMode?: string;
  compensationText?: string;
  compensationBands?: Array<{
    minAmount: number;
    maxAmount: number;
    currency: string;
    period?: CompensationPeriod;
    label?: string;
    sourceText: string;
  }>;
  declaredRequirements?: Partial<JobRequirements>;
}

export interface SourceSnapshot {
  sourceId: string;
  outcome: 'changed' | 'unchanged';
  complete: true;
  postings: SourcedPosting[];
  rawCount: number;
  contentHash: string;
  checkpoint: SourceCheckpoint;
}

export interface PostingDecision {
  externalId: string;
  /** `shelved` is stored but kept out of every catalog index and alert. */
  outcome: 'included' | 'shelved' | 'filtered' | 'withheld';
  reason:
    | 'prospect'
    | 'not-early-career'
    | 'nontechnical'
    | 'invalid-application-url'
    | 'aggregator-destination'
    | 'source-policy';
}

export interface ProcessedSnapshot {
  listings: ProcessedListing[];
  decisions: PostingDecision[];
  counts: {
    raw: number;
    valid: number;
    eligible: number;
    shelved: number;
    filtered: number;
    withheld: number;
  };
}

export interface NotificationState {
  smsPending: boolean;
  smsSentAt?: string;
  digestPending: boolean;
  digestedAt?: string;
}

export interface Internship {
  jobId: string;
  company: string;
  title: string;
  location: string;
  locations?: string[];
  housing?: HousingDetail[];
  /** Trusted operations receipt; source parsers must never create this. */
  metadataOmission?: RoleMetadataOmission;
  season: string;
  applyUrl: string;
  normalizedUrl: string;
  /** Lazily attached exact identity; absent on legacy rows. */
  postingIdentity?: PostingIdentity;
  /** Derived from classified occurrences. Missing is intentionally legacy-unclassified. */
  postingIdentityStatus?: 'confirmed' | 'unconfirmed';
  /** Legacy/rollout rows may retain the earlier loose enrichment document until observed again. */
  internshipIdentity?: InternshipIdentity | Record<string, unknown>;
  /** Present only after the official destination has resolved successfully. */
  applicationUrlValidatedAt?: string;
  /** Version of employer-page metadata extraction applied to this role. */
  applicationPageMetadataVersion?: number;
  /** A confirmed broken URL remains hidden until a source supplies a different destination. */
  invalidApplicationUrl?: string;
  fingerprint: string;
  compensation: Compensation;
  /** Reconciled employer-disclosed metadata; full evidence history is stored separately. */
  roleMetadata?: ReconciledRoleMetadata;
  /** Provider-neutral status. Missing legacy values are rendered as `unknown`. */
  workAuthorizationStatus?: WorkAuthorizationStatus;
  applicationDeadline?: ApplicationDeadline;
  graduationWindow?: GraduationDateWindow;
  programType?: InternshipProgramType;
  workMode?: WorkMode;
  employerPublishedAt?: string;
  employerUpdatedAt?: string;
  /** Employer co-attribution for accepted field-level evidence; history remains in proposal/audit tables. */
  employerMetadataAttribution?: Record<string, Array<{ organizationId: string; proposalId: string; evidenceAt: string }>>;
  requirements?: JobRequirements;
  /** Set at ingest time; older stored records are classified from company name when read. */
  employerCategory?: EmployerCategory;
  sourceReferences: SourceOccurrence[];
  /** Persisted preprocessing result used by indexes and queries. */
  technical?: boolean;
  open: boolean;
  /** Admission is independent from source lifecycle. Missing means legacy/unclassified. */
  admission?: CatalogAdmission;
  /** Immutable time InternNotifs first observed this canonical catalog role. */
  firstSeenAt: string;
  /** Immutable time this canonical role first became visible; absent only on legacy rows. */
  catalogVisibleAt?: string;
  /** Baseline roles remain public but rank after normal roles; legacy rows imply normal. */
  catalogRecency?: 'normal' | 'baseline';
  lastSeenAt: string;
  notification: NotificationState;
}

export interface SourceAdapter {
  readonly id: string;
  fetch(checkpoint?: SourceCheckpoint): Promise<SourceFetchResult>;
}

export interface SourceConnector {
  readonly id: string;
  fetch(checkpoint?: SourceCheckpoint): Promise<SourceSnapshot>;
}

export interface SourceFetchResult {
  sourceId: string;
  /** Total source rows before lifecycle/technical/link withholding filters. */
  rawRowCount?: number;
  listings: RawListing[];
  /** Rows withheld before publication because their application URL violates baseline policy. */
  rejectedApplicationUrls?: Array<{ row: number; url: string; reason: string }>;
  /** Processing a migrated connector already performed, so the runner never repeats it. */
  processed?: ProcessedSnapshot;
  checkpoint: SourceCheckpoint;
  notModified: boolean;
  unchangedReason?: 'not_modified' | 'content_hash';
  /** Sanitized conditional-request diagnostics; validator values are never exposed. */
  conditionalRequest?: {
    attempted: boolean;
    notModified: boolean;
    validatorChanged?: boolean;
  };
  /** Count-only connector diagnostics; URLs and row contents are never emitted. */
  trustedCommunityDiagnostics?: {
    rejectedAggregatorRows: number;
    survivingAggregatorRows: number;
    duplicateOccurrenceIds: number;
  };
}
