import puppeteer, { type BrowserWorker } from '@cloudflare/puppeteer';
import { createHash } from 'node:crypto';
import { evaluateCatalogAdmission, deriveCanonicalAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { classifyDestination, matchingBrowserDestination } from '../src/destination-verification.js';
import type { DestinationVerificationRequest } from '../src/destination-verification.js';
import type { ApplicationPageEvidence } from '../src/core/application-url.js';
import { reachabilityFromFailure, type Reachability } from '../src/core/application-verification.js';
import { normalizeUrl } from '../src/core/normalize.js';
import { combineRenderedFrameEvidence, exactPostingRecoveryUrl, renderedDescriptionReady, type RenderedFrameSnapshot } from '../src/rendered-destination-evidence.js';
import { newJobNotificationEvent, shouldPromoteDelayedNotification } from '../src/ingestion/catalog-reconciler.js';
import { activeTrustedCommunityPolicy, advanceTrustedCommunityQualification } from '../src/sources/trust-policy.js';
import type { CatalogAdmissionReason, Internship, ProcessedListing, ProviderIdentity, SourceOccurrence } from '../src/types.js';
import { D1CatalogAdmissionStore, destinationVerificationMatchesReference, ROLE_METADATA_REVALIDATION_MS } from './catalog-admission-store.js';
import { D1InternshipStore } from './d1-store.js';
import { extractPostingMetadataEvidence, extractVerifiedPageMetadataEvidence, projectRoleMetadata, replaceVerifiedPageMetadataEvidence, roleMetadataEvidenceHasFields, ROLE_METADATA_EXTRACTION_VERSION, VERIFIED_PAGE_METADATA_SOURCES } from '../src/role-metadata.js';
import { createMetadataAcquirer, metadataApiRoute, type MetadataAcquisition } from '../src/metadata-acquisition.js';
import { metadataFieldOutcomes, type MetadataAuditOutcome } from '../src/metadata-audit.js';
import type { D1Database, MessageBatch, Queue, R2Bucket } from './types.js';
import { enqueueShadowExtraction, type ShadowBaseline } from './shadow-extraction.js';
import { normalizeExactPostingDescription, type ShadowExtractionOrigin } from '../src/shadow-extraction.js';

export interface DestinationVerificationMessage {
  version: 1;
  jobId: string;
  sourceId: string;
  externalId: string;
  providerIdentity: ProviderIdentity;
  candidateUrl: string;
  reason: 'first-sight' | 'url-change' | 'content-change' | 'daily-retry' | 'weekly-sample' | 'historical-backfill';
  queuedAt: string;
  occurrenceKey?: string;
  leaseToken?: string;
  idempotencyKey?: string;
  generationId?: string;
  metadataExtractionVersion?: number;
  metadataArtifactHash?: string;
  shadowContentHash?: string;
  metadataBackfillToken?: string;
  shadowOrigin?: ShadowExtractionOrigin;
}

export interface DestinationVerificationEnvironment {
  DB: D1Database;
  DESTINATION_BROWSER: BrowserWorker;
  DESTINATION_VERIFICATION_QUEUE: Queue;
  SHADOW_EXTRACTION_QUEUE?: Queue;
  SHADOW_EXTRACTION_ARTIFACTS?: R2Bucket;
  RESEND_API_KEY?: string;
  ADMISSION_SUPPORT_RECIPIENT?: string;
  AUTH_FROM_EMAIL?: string;
  TRUSTED_COMMUNITY_CATALOG_ENABLED?: string;
  IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED?: string;
}

const DESTINATION_RETRY_DELAY_SECONDS = 86_400;
const DESTINATION_RETRY_LEASE_MARGIN_MS = 60 * 60_000;

function shadowBaselineStatus(outcome: MetadataAuditOutcome): ShadowBaseline[keyof ShadowBaseline] {
  if (outcome === 'extracted') return 'present';
  if (outcome === 'no-disclosure-found') return 'not-stated';
  if (outcome === 'ambiguous' || outcome === 'conflicting') return 'conflicting';
  return 'incomplete';
}

function shadowBaseline(fields: ReturnType<typeof metadataFieldOutcomes>): ShadowBaseline {
  return {
    compensation: shadowBaselineStatus(fields.compensation),
    housing: shadowBaselineStatus(fields.housing),
    education: shadowBaselineStatus(fields.education),
    locations: shadowBaselineStatus(fields.locations),
    workMode: shadowBaselineStatus(fields['work-mode']),
    timing: shadowBaselineStatus(fields['application-deadline']),
  };
}

async function handoffShadowExtraction(input: {
  env: DestinationVerificationEnvironment;
  operations: D1CatalogAdmissionStore;
  message: DestinationVerificationMessage;
  title: string;
  description?: string;
  structuredLocations?: readonly string[];
  sourceUrl: string;
  observedAt: string;
  incomplete: boolean;
  baseline?: ShadowBaseline;
  method: string;
}): Promise<void> {
  const description = input.description?.trim() ?? '';
  const descriptionBytes = new TextEncoder().encode(description).byteLength;
  const normalized = normalizeExactPostingDescription(input.title, description, input.incomplete, undefined, input.structuredLocations);
  let outcome: 'enqueued' | 'skipped-no-text' | 'skipped-no-binding' | 'skipped-oversized' | 'failed';
  try {
    if (!normalized.title || !normalized.description) outcome = 'skipped-no-text';
    else if (!input.env.SHADOW_EXTRACTION_QUEUE || !input.env.SHADOW_EXTRACTION_ARTIFACTS) outcome = 'skipped-no-binding';
    else {
      const enqueued = await enqueueShadowExtraction({ DB: input.env.DB, SHADOW_EXTRACTION_QUEUE: input.env.SHADOW_EXTRACTION_QUEUE,
        SHADOW_EXTRACTION_ARTIFACTS: input.env.SHADOW_EXTRACTION_ARTIFACTS }, {
        jobId: input.message.jobId, sourceId: input.message.sourceId, externalId: input.message.externalId,
        sourceUrl: input.sourceUrl, providerIdentity: input.message.providerIdentity, title: input.title,
        description, structuredLocations: input.structuredLocations, observedAt: input.observedAt, incomplete: input.incomplete,
        origin: input.message.shadowOrigin ?? (input.message.reason === 'historical-backfill' ? 'backfill' : 'scheduled-verification'),
        ...(input.baseline ? { baseline: input.baseline } : {}),
      });
      // enqueueShadowExtraction returns undefined when it declines to enqueue
      // (empty normalized text or an over-ceiling input). Record that skip
      // instead of a false 'enqueued' so the handoff denominator is accurate.
      outcome = enqueued ? 'enqueued' : 'skipped-oversized';
    }
  } catch {
    outcome = 'failed';
  }
  try {
    await input.operations.recordShadowExtractionHandoff(input.message.jobId, input.message.sourceId, input.observedAt, {
      outcome, method: input.method, descriptionBytes, observedAt: new Date().toISOString(),
    });
  } catch { /* Handoff telemetry must not change admission or queue settlement. */ }
  const event = JSON.stringify({ event: 'shadow_extraction_handoff', provider: input.message.providerIdentity.provider,
    method: input.method, outcome, descriptionBytes: descriptionBytes <= 0 ? 0 : descriptionBytes <= 4_096 ? 4_096
      : descriptionBytes <= 16_384 ? 16_384 : descriptionBytes <= 40_000 ? 40_000 : 40_001 });
  if (outcome === 'failed') console.error(event);
  else console.log(event);
  // Admission/evidence is already durable. Keep the destination message alive
  // when the downstream handoff is unavailable so a transient R2/D1/Queue
  // failure cannot silently lose the only immutable extraction input.
  if (outcome === 'failed' || outcome === 'skipped-no-binding') throw new Error('Shadow extraction handoff is unavailable');
}

export function destinationVerificationMessage(request: DestinationVerificationRequest, queuedAt = new Date().toISOString()): DestinationVerificationMessage {
  return { version: 1, ...request, queuedAt };
}

function incidentId(message: DestinationVerificationMessage, reason: string): string {
  return createHash('sha256').update(`${message.jobId}\0${message.sourceId}\0${reason}`).digest('hex').slice(0, 32);
}

function parseMessage(value: unknown): DestinationVerificationMessage {
  const message = value as Partial<DestinationVerificationMessage>;
  if (message?.version !== 1 || typeof message.jobId !== 'string' || typeof message.sourceId !== 'string'
    || typeof message.externalId !== 'string' || typeof message.candidateUrl !== 'string'
    || !message.providerIdentity || typeof message.providerIdentity !== 'object') throw new Error('Destination verification message is invalid');
  return message as DestinationVerificationMessage;
}

function metadataExtractionCurrent(reference: SourceOccurrence, message: DestinationVerificationMessage): boolean {
  if (!message.metadataExtractionVersion) return true;
  return reference.metadataExtraction?.version === message.metadataExtractionVersion
    && (!message.metadataArtifactHash || reference.metadataExtraction.artifactHash === message.metadataArtifactHash);
}

export function reachabilityFromHttpStatus(status: number | undefined): Reachability {
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403 || status === 429) return 'blocked';
  if (status !== undefined && status >= 500) return 'unreachable';
  return 'live';
}

function incidentState(reason: CatalogAdmissionReason): 'open' | 'quarantined' {
  return ['destination-grace', 'destination-unresolved', 'destination-blocked-uninspectable'].includes(reason)
    ? 'open'
    : 'quarantined';
}

async function classifyReferenceDestination(input: {
  operations: D1CatalogAdmissionStore;
  message: DestinationVerificationMessage;
  job: Internship;
  reference: SourceOccurrence;
  reachability: Reachability;
  inspectedAt: string;
  evidence?: ApplicationPageEvidence;
  browserVisible?: boolean;
}): Promise<{ listing: ProcessedListing; destination: ReturnType<typeof classifyDestination> }> {
  const { operations, message, job, reference, reachability, inspectedAt, evidence, browserVisible } = input;
  const mappedEmployer = await operations.resolveCanonicalEmployer(message.providerIdentity);
  const mayReuseEmployer = reference.employerLabelOrigin !== 'inherited' || reference.employerInheritance === 'same-tenant';
  const listing: ProcessedListing = {
    ...reference,
    externalId: message.externalId,
    fetchedAt: inspectedAt,
    providerIdentity: message.providerIdentity,
    postingIdentity: job.postingIdentity,
    employerEvidence: {
      authority: reference.provenance === 'reviewed-community' ? 'source-row' : 'reviewed-registry',
      ...(mappedEmployer ? { canonicalEmployer: mappedEmployer }
        : mayReuseEmployer && reference.admission?.canonicalEmployer ? { canonicalEmployer: reference.admission.canonicalEmployer }
          : mayReuseEmployer && job.admission?.canonicalEmployer ? { canonicalEmployer: job.admission.canonicalEmployer } : {}),
    },
    metadataCompleteness: reference.admission?.metadata ?? metadataCompleteness({ title: reference.title, locations: reference.locations ?? [reference.location] }),
  };
  const rule = await operations.resolveReviewRule(message.providerIdentity, message.candidateUrl);
  return { listing, destination: classifyDestination({ listing, reachability, ...(evidence ? { evidence } : {}), inspectedAt,
    ...(browserVisible !== undefined ? { browserVisible } : {}), ...(rule ? { rule } : {}) }) };
}

export async function persistDestinationAdmission(input: {
  jobs: D1InternshipStore;
  operations: D1CatalogAdmissionStore;
  message: DestinationVerificationMessage;
  job: Internship;
  reference: SourceOccurrence;
  reachability: Reachability;
  inspectedAt: string;
  evidence?: ApplicationPageEvidence;
  apiAcquisition?: MetadataAcquisition;
  durationMs?: number;
  browserVisible?: boolean;
  trustedCommunityCatalogEnabled?: boolean;
  identityUnconfirmedPublicationEnabled?: boolean;
}): Promise<{
  destination: ReturnType<typeof classifyDestination>;
  shadowBaseline: ShadowBaseline;
  obsolete?: true;
  incident?: { sourceId: string; host: string; reason: string; incidentId: string; messageType: 'incident-opened' | 'quarantine' };
}> {
  const { jobs, operations, message, job, reference, reachability, inspectedAt, evidence, browserVisible } = input;
  const occurrence = await jobs.getSourceOccurrence(message.sourceId, message.externalId);
  const { listing, destination } = await classifyReferenceDestination({ operations, message, job, reference, reachability,
    inspectedAt, ...(evidence ? { evidence } : {}), ...(browserVisible !== undefined ? { browserVisible } : {}) });
  const trustedCommunityPolicy = activeTrustedCommunityPolicy(message.sourceId, input.trustedCommunityCatalogEnabled ?? false);
  const trustedCommunityAlertQualification = trustedCommunityPolicy
    ? advanceTrustedCommunityQualification({
      previous: occurrence?.occurrence.trustedCommunityAlertQualification
        ?? reference.trustedCommunityAlertQualification,
      destination,
      postingIdentityDecision: reference.postingIdentityDecision,
      alertMode: trustedCommunityPolicy.alertMode,
    })
    : undefined;
  const admission = evaluateCatalogAdmission({
    listing, destination,
    postingAttributed: reference.provenance !== 'reviewed-community'
      || reference.admission?.postingAttribution === 'attributed'
      || (browserVisible === true && ['posting-detail', 'application-form'].includes(destination.classification)),
    evaluatedAt: inspectedAt, previous: reference.admission ?? job.admission,
    ...(trustedCommunityPolicy && trustedCommunityAlertQualification
      ? { trustedCommunity: { policy: trustedCommunityPolicy, qualification: trustedCommunityAlertQualification } }
      : {}),
  });
  const pageComplete = evidence && !evidence.inspectionTruncated && !evidence.failedFrameCount && !evidence.loadingShell
    && !evidence.metadataArtifacts?.some((artifact) => artifact.inspectionTruncated);
  const pageExtracted = evidence && ['posting-detail', 'application-form'].includes(destination.classification)
    ? extractVerifiedPageMetadataEvidence({
      expectedTitle: reference.title,
      expectedPostingId: message.providerIdentity.postingId,
      page: { title: evidence.title ?? reference.title,
        text: evidence.contentSource === 'json-ld' ? undefined : evidence.contentExcerpt,
        compensationSections: evidence.compensationSections },
      jsonLdArtifacts: evidence.metadataArtifacts,
      sourceId: message.sourceId,
      sourceUrl: evidence.url,
      observedAt: inspectedAt,
      exactPosting: true,
    }) : [];
  // Partial snapshots cannot withdraw previously supported fields. Retain
  // their diagnostic excerpts but wait for complete acquisition before replay.
  const extracted = pageComplete ? pageExtracted : [];
  const apiEvidence = input.apiAcquisition?.artifact ? extractPostingMetadataEvidence({
    artifact: input.apiAcquisition.artifact, sourceClass: 'official-api', sourceId: message.sourceId,
    sourceUrl: input.apiAcquisition.sourceUrl, observedAt: inspectedAt, exactPosting: true,
  }) : [];
  extracted.push(...apiEvidence);
  const metadataEvidence = pageComplete
    ? replaceVerifiedPageMetadataEvidence(reference.metadataEvidence, extracted, message.sourceId)
    : replaceVerifiedPageMetadataEvidence(reference.metadataEvidence, [
      ...(reference.metadataEvidence ?? []).filter((item) => VERIFIED_PAGE_METADATA_SOURCES.some((source) => source === item.sourceClass)),
      ...extracted,
    ], message.sourceId);
  const enrichedReference = { ...reference, admission,
    ...(trustedCommunityAlertQualification ? { trustedCommunityAlertQualification } : {}),
    metadataEvidence,
    ...(pageComplete || apiEvidence.length ? { metadataExtraction: {
      version: ROLE_METADATA_EXTRACTION_VERSION,
      artifactHash: apiEvidence[0]?.artifactHash ?? evidence?.contentHash ?? evidence?.renderedEvidenceHash ?? createHash('sha256').update(JSON.stringify({ url: evidence?.url, title: evidence?.title, description: evidence?.description })).digest('hex'),
      observedAt: inspectedAt,
      outcome: extracted.some(roleMetadataEvidenceHasFields) ? 'extracted' as const : 'no-explicit-metadata' as const,
    } } : {}),
  };
  const sourceReferences = job.sourceReferences.map((item) => item === reference ? enrichedReference : item);
  const projected = projectRoleMetadata({ ...job, sourceReferences, admission: deriveCanonicalAdmission(sourceReferences, inspectedAt) });
  const complete = Boolean(apiEvidence.length || (pageComplete && ['posting-detail', 'application-form'].includes(destination.classification)));
  // Reaching a page is not the same as finishing an acquisition. When the page
  // yielded no fields and the employer publishes an API we never read, the role
  // must come back on the short window: otherwise a provider route that would
  // have supplied the text stays unused for a month, which is how a role keeps a
  // blank field its own API states plainly.
  const providerApiUnused = !extracted.some(roleMetadataEvidenceHasFields)
    && Boolean(metadataApiRoute(message.providerIdentity, message.candidateUrl));
  const retryAfter = new Date(Date.parse(inspectedAt)
    + (complete && !providerApiUnused ? ROLE_METADATA_REVALIDATION_MS : 24 * 60 * 60_000)).toISOString();
  const baselineFields = metadataFieldOutcomes({ evidence: complete ? extracted : [], conflicts: projected.conflicts,
    acquired: Boolean(apiEvidence.length || (evidence && ['posting-detail', 'application-form'].includes(destination.classification))), complete });
  const baseline = shadowBaseline(baselineFields);
  await operations.recordMetadataAcquisition(job.jobId, message.sourceId, inspectedAt, {
    provider: message.providerIdentity.provider, postingId: message.providerIdentity.postingId ?? message.externalId,
    sourceUrl: input.apiAcquisition?.artifact ? input.apiAcquisition.sourceUrl : evidence?.url ?? message.candidateUrl,
    method: input.apiAcquisition?.artifact ? input.apiAcquisition.method : 'browser',
    apiOutcome: input.apiAcquisition?.outcome, apiStatus: input.apiAcquisition?.status,
    durationMs: input.durationMs, apiRouteAttempts: input.apiAcquisition ? 1 : 0, browserEvidenceSnapshots: browserVisible ? 1 : 0,
    artifactHash: apiEvidence[0]?.artifactHash ?? evidence?.contentHash ?? evidence?.renderedEvidenceHash,
    extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, observedAt: inspectedAt, complete,
    inspectionTruncated: Boolean(evidence?.inspectionTruncated), failedFrames: evidence?.failedFrameCount ?? 0,
    destination: destination.classification, retryAfter,
    fields: baselineFields,
    excerpts: [...pageExtracted, ...apiEvidence].flatMap((item) => item.compensationRanges?.map((range) => range.sourceText) ?? []).slice(0, 8),
  }, retryAfter);
  if (complete && enrichedReference.metadataExtraction) await operations.recordRoleMetadataExtraction({
    jobId: job.jobId, sourceId: message.sourceId, sourceUrl: input.apiAcquisition?.artifact ? input.apiAcquisition.sourceUrl : evidence!.url,
    artifactHash: enrichedReference.metadataExtraction.artifactHash,
    extractionVersion: enrichedReference.metadataExtraction.version,
    outcome: enrichedReference.metadataExtraction.outcome,
    observedAt: inspectedAt,
    ...(message.metadataBackfillToken ? { backfillToken: message.metadataBackfillToken } : {}),
  });
  if (evidence || apiEvidence.length) await operations.recordRoleMetadataEvidence(job.jobId, extracted, projected.conflicts, inspectedAt, {
    sourceId: message.sourceId,
    sourceClasses: [...(pageComplete ? VERIFIED_PAGE_METADATA_SOURCES : []), ...(apiEvidence.length ? ['official-api' as const] : [])],
  });
  // Historical collection is deliberately staging-only. The guarded repair
  // endpoint performs the public job write after exact token/count checks.
  if (message.metadataBackfillToken) return { destination, shadowBaseline: baseline };
  const canonicalAdmission = deriveCanonicalAdmission(sourceReferences, inspectedAt);
  const authoritativeClosure = destination.classification === 'gone';
  const verifiedOpen = ['posting-detail', 'application-form'].includes(destination.classification)
    && canonicalAdmission?.catalogEligible && sourceReferences.some((item) => item.state === 'open');
  let normalizedCandidate = message.candidateUrl;
  try { normalizedCandidate = normalizeUrl(message.candidateUrl); } catch { /* Preserve the reviewed candidate verbatim if normalization fails. */ }
  const reopeningFromClosure = verifiedOpen && Boolean(job.invalidApplicationUrl);
  const becomingCatalogVisible = !job.catalogVisibleAt && job.admission?.catalogEligible === false && canonicalAdmission?.catalogEligible === true;
  // Only the trusted policy supplies durable baseline/qualification evidence.
  // Preserve standard-source behavior when this rollout is inactive.
  const delayedPromotion = Boolean(trustedCommunityPolicy && trustedCommunityAlertQualification
    && job.open && job.technical !== false
    && (job.postingIdentityStatus !== 'unconfirmed' || input.identityUnconfirmedPublicationEnabled === true)
    && shouldPromoteDelayedNotification({
      previousOccurrenceAlertEligible: reference.admission?.alertEligible,
      occurrenceAlertEligible: admission.alertEligible,
      canonicalAlertEligible: canonicalAdmission?.alertEligible,
      baselineSuppressed: trustedCommunityAlertQualification?.baselineSuppressed,
    }));
  const nextJob: Internship = {
    ...projected.job,
    ...(authoritativeClosure ? { open: false, applicationUrlValidatedAt: undefined, invalidApplicationUrl: normalizedCandidate,
      notification: { ...job.notification, smsPending: false, digestPending: false } }
      : reopeningFromClosure ? { open: true, applicationUrlValidatedAt: inspectedAt, invalidApplicationUrl: undefined }
      : verifiedOpen ? { applicationUrlValidatedAt: inspectedAt } : { applicationUrlValidatedAt: undefined }),
    sourceReferences,
    ...(canonicalAdmission ? { admission: canonicalAdmission } : {}),
    ...(becomingCatalogVisible ? { catalogVisibleAt: inspectedAt,
      catalogRecency: trustedCommunityAlertQualification?.baselineSuppressed ? 'baseline' : 'normal' } : {}),
    ...(delayedPromotion ? { notification: { ...job.notification, smsPending: true, digestPending: true } } : {}),
  };
  const nextOccurrence = occurrence ? {
    ...occurrence,
    occurrence: { ...occurrence.occurrence, ...enrichedReference },
    changedAt: inspectedAt,
  } : undefined;
  // Verification updates an existing identity, never re-resolves it. Keep the
  // generation guard and any delayed notification in the same transaction.
  const persisted = await jobs.putAdmissionState(nextJob, reference, nextOccurrence, occurrence,
    delayedPromotion ? newJobNotificationEvent(message.sourceId, message.externalId, nextJob, inspectedAt) : undefined);
  if (!persisted) return { destination, shadowBaseline: baseline, obsolete: true };

  const reason = admission.reasonCodes[0];
  await operations.resolveIncidents(message.jobId, message.sourceId, inspectedAt, reason);
  if (!reason) return { destination, shadowBaseline: baseline };
  const id = incidentId(message, reason);
  const state = incidentState(reason);
  const host = new URL(message.candidateUrl).hostname;
  await operations.upsertIncident({ id, jobId: message.jobId, sourceId: message.sourceId, host, reasonCode: reason,
    state, openedAt: inspectedAt, updatedAt: inspectedAt, ...(admission.graceDeadline ? { graceDeadline: admission.graceDeadline } : {}) });
  return { destination, shadowBaseline: baseline, incident: { sourceId: message.sourceId, host, reason, incidentId: id,
    messageType: state === 'open' ? 'incident-opened' : 'quarantine' } };
}

async function sendIncidentEmail(
  store: D1CatalogAdmissionStore,
  env: Pick<DestinationVerificationEnvironment, 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT' | 'AUTH_FROM_EMAIL'>,
  group: { sourceId: string; host: string; reason: string; incidents: string[] },
  messageType: 'incident-opened' | 'grace-warning' | 'quarantine',
  sentAt: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.ADMISSION_SUPPORT_RECIPIENT || !env.AUTH_FROM_EMAIL) return false;
  const incidentIds = [...group.incidents].sort();
  const dedupeKey = createHash('sha256').update(`${messageType}\0${group.sourceId}\0${group.host}\0${group.reason}\0${incidentIds.join(',')}`).digest('hex');
  if (await store.emailDeliveryExists(dedupeKey)) return true;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': dedupeKey,
    },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to: [env.ADMISSION_SUPPORT_RECIPIENT],
      subject: `[InternNotifs] ${messageType}: ${group.host}`,
      text: `${group.incidents.length} catalog admission incident(s) for ${group.sourceId} on ${group.host}. Reason: ${group.reason}.`,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  await store.recordEmailDelivery(dedupeKey, incidentIds[0]!, messageType, sentAt);
  return true;
}

export async function sendAdmissionOperationalAlert(
  store: D1CatalogAdmissionStore,
  env: Pick<DestinationVerificationEnvironment, 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT' | 'AUTH_FROM_EMAIL'>,
  input: { signals: string[]; details: string; observedAt: string },
): Promise<boolean> {
  if (!input.signals.length || !env.RESEND_API_KEY || !env.ADMISSION_SUPPORT_RECIPIENT || !env.AUTH_FROM_EMAIL) return false;
  const signals = [...new Set(input.signals)].sort();
  const action = signals.includes('destination-verification-dlq')
    ? '\n\nAction required: inspect the destination-verification DLQ and, after review, use the authenticated DLQ operations replay flow. Do not purge messages.'
    : '';
  const day = input.observedAt.slice(0, 10);
  const dedupeKey = createHash('sha256').update(`operational-health\0${day}\0${signals.join(',')}`).digest('hex');
  if (await store.emailDeliveryExists(dedupeKey)) return true;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': dedupeKey },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to: [env.ADMISSION_SUPPORT_RECIPIENT],
      subject: `[InternNotifs] catalog admission health: ${signals.join(', ')}`,
      text: `${input.details}${action}`,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  await store.recordEmailDelivery(dedupeKey, `operational:${day}`, 'operational-health', input.observedAt);
  return true;
}

/** Alert once per month when another prospective shadow run cannot reserve
 * its full upper-bound cost. Resend and the delivery ledger share a stable key. */
export async function sendShadowBudgetAlert(
  store: D1CatalogAdmissionStore,
  env: Pick<DestinationVerificationEnvironment, 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT' | 'AUTH_FROM_EMAIL'>,
  input: { period: string; spentCents: number; allowanceCents: number; observedAt: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.ADMISSION_SUPPORT_RECIPIENT || !env.AUTH_FROM_EMAIL) {
    throw new Error('Shadow budget alert email is not configured');
  }
  const dedupeKey = createHash('sha256').update(`shadow-budget-exhausted\0${input.period}`).digest('hex');
  if (await store.emailDeliveryExists(dedupeKey)) return true;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': dedupeKey },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to: [env.ADMISSION_SUPPORT_RECIPIENT],
      subject: `[Ntern] shadow metadata budget reached (${input.period})`,
      text: `The ${input.period} shadow metadata ledger is at ${input.spentCents}¢ of its ${input.allowanceCents}¢ allowance. A new provider run cannot reserve its 20¢ maximum, so new AI metadata processing will pause until there is headroom or the monthly budget resets.`,
    }),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  await store.recordEmailDelivery(dedupeKey, `shadow-budget:${input.period}`, 'shadow-budget-exhausted', input.observedAt);
  return true;
}

export async function processDestinationVerificationBatch(
  batch: MessageBatch<unknown>,
  env: DestinationVerificationEnvironment,
  now = () => new Date(),
): Promise<void> {
  const jobs = new D1InternshipStore(env.DB);
  const operations = new D1CatalogAdmissionStore(env.DB);
  const settleWithoutVerification = async (
    queued: MessageBatch<unknown>['messages'][number],
    message: DestinationVerificationMessage,
    completedAt: string,
    classification: string,
    nextCheckAt = completedAt,
  ) => {
    if (message.occurrenceKey) await operations.completeScheduledVerification({ occurrenceKey: message.occurrenceKey,
      leaseToken: message.leaseToken, completedAt, classification, nextCheckAt });
    if (message.idempotencyKey) await operations.recordVerificationCompletion(message.idempotencyKey, completedAt);
    queued.ack();
  };
  const opened: Array<{ sourceId: string; host: string; reason: string; incidentId: string; messageType: 'incident-opened' | 'quarantine' }> = [];
  const pending: Array<{ queued: MessageBatch<unknown>['messages'][number]; message: DestinationVerificationMessage }> = [];
  const pendingAttemptKeys = new Set<string>();
  const batchStartedAt = now();
  const recentAttemptCutoff = new Date(batchStartedAt.getTime() - 24 * 60 * 60_000).toISOString();
  const nextAttemptAfterRecentDuplicate = new Date(batchStartedAt.getTime() + 24 * 60 * 60_000).toISOString();
  for (const queued of batch.messages) {
    try {
      const message = parseMessage(queued.body);
      if (message.idempotencyKey && await operations.verificationCompleted(message.idempotencyKey)) {
        queued.ack();
        continue;
      }
      const job = await jobs.getJob(message.jobId);
      if (!job) { queued.ack(); continue; }
      const reference = job.sourceReferences.find((item) => item.sourceId === message.sourceId && item.externalId === message.externalId);
      if (!reference) { queued.ack(); continue; }
      const candidateOnly = message.reason === 'historical-backfill' && !message.metadataBackfillToken;
      const naturalProviderShadow = message.shadowOrigin === 'provider-poll' && Boolean(message.shadowContentHash);
      if (!candidateOnly && !destinationVerificationMatchesReference(reference, message)) {
        await settleWithoutVerification(queued, message, now().toISOString(), 'obsolete');
        continue;
      }
      const existing = candidateOnly || message.metadataBackfillToken || naturalProviderShadow || !metadataExtractionCurrent(reference, message)
        ? undefined : matchingBrowserDestination(job, message, message.queuedAt);
      if (existing) {
        await settleWithoutVerification(queued, message, now().toISOString(), existing.classification, existing.nextCheckAt);
        continue;
      }
      const attemptKey = `${candidateOnly ? `backfill:${message.generationId ?? ''}:${message.occurrenceKey ?? ''}` : message.metadataBackfillToken ? `metadata:${message.metadataBackfillToken}` : 'live'}\0${message.jobId}\0${message.sourceId}\0${message.externalId}\0${message.candidateUrl}`;
      if (pendingAttemptKeys.has(attemptKey)) {
        queued.ack(); continue;
      }
      if (!candidateOnly && !message.metadataBackfillToken && !naturalProviderShadow && metadataExtractionCurrent(reference, message)
        && await operations.hasVerificationAttemptSince(message.jobId, message.sourceId, message.candidateUrl, recentAttemptCutoff)) {
        await settleWithoutVerification(queued, message, now().toISOString(),
          reference.admission?.destination.classification ?? 'recent-attempt', nextAttemptAfterRecentDuplicate);
        continue;
      }
      pendingAttemptKeys.add(attemptKey);
      pending.push({ queued, message });
    } catch (error) {
      queued.retry({ delaySeconds: 300 }, error);
    }
  }
  if (!pending.length) return;
  const acquireMetadata = createMetadataAcquirer(fetch, {
    canRequest: (host) => operations.metadataHostAvailable(host),
    deferHost: (host, until) => operations.deferMetadataHost(host, until),
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    for (const { queued, message } of pending) {
      const attemptedAt = now().toISOString();
      try {
        if (message.idempotencyKey && await operations.verificationCompleted(message.idempotencyKey)) {
          queued.ack();
          continue;
        }
        const job = await jobs.getJob(message.jobId);
        if (!job) { queued.ack(); continue; }
        const reference = job.sourceReferences.find((item) => item.sourceId === message.sourceId && item.externalId === message.externalId);
        if (!reference) { queued.ack(); continue; }
        const candidateOnly = message.reason === 'historical-backfill' && !message.metadataBackfillToken;
        const naturalProviderShadow = message.shadowOrigin === 'provider-poll' && Boolean(message.shadowContentHash);
        if (!candidateOnly && !destinationVerificationMatchesReference(reference, message)) {
          await settleWithoutVerification(queued, message, attemptedAt, 'obsolete');
          continue;
        }
        const existing = candidateOnly || message.metadataBackfillToken || naturalProviderShadow || !metadataExtractionCurrent(reference, message)
          ? undefined : matchingBrowserDestination(job, message, message.queuedAt);
        if (existing) {
          await settleWithoutVerification(queued, message, attemptedAt, existing.classification, existing.nextCheckAt);
          continue;
        }
        let apiAcquisition = candidateOnly ? undefined : await acquireMetadata(message.providerIdentity, message.candidateUrl);
        if (naturalProviderShadow) {
          if (!apiAcquisition?.artifact?.text) throw new Error('Natural provider shadow artifact is unavailable');
          // The producer hashes the canonical persisted title, which may be a
          // reviewed repair of the provider's raw title.
          const title = reference.title;
          const normalized = normalizeExactPostingDescription(title, apiAcquisition.artifact.text, false);
          if (normalized.contentHash !== message.shadowContentHash) {
            await settleWithoutVerification(queued, message, now().toISOString(), 'obsolete');
            continue;
          }
          const inspectedAt = now().toISOString();
          await handoffShadowExtraction({ env, operations, message, title, description: apiAcquisition.artifact.text,
          sourceUrl: apiAcquisition.sourceUrl, observedAt: inspectedAt, incomplete: false, structuredLocations: apiAcquisition.artifact.locations, method: apiAcquisition.method });
          if (message.idempotencyKey) await operations.recordVerificationCompletion(message.idempotencyKey, inspectedAt);
          queued.ack(); continue;
        }
        // Historical collection cannot change admission, URL or notifications.
        // An identity-checked full API artifact needs no browser for that task.
        if (message.metadataBackfillToken && apiAcquisition?.artifact) {
          const inspectedAt = now().toISOString();
          const result = await persistDestinationAdmission({ jobs, operations, message, job, reference,
            reachability: 'live', inspectedAt, apiAcquisition, durationMs: now().getTime() - Date.parse(attemptedAt) });
          await handoffShadowExtraction({ env, operations, message, title: apiAcquisition.artifact.title ?? reference.title,
            description: apiAcquisition.artifact.text, sourceUrl: apiAcquisition.sourceUrl, observedAt: inspectedAt, incomplete: false, structuredLocations: apiAcquisition.artifact.locations,
            baseline: result.shadowBaseline, method: apiAcquisition.method });
          queued.ack(); continue;
        }
        browser ??= await puppeteer.launch(env.DESTINATION_BROWSER);
        const page = await browser.newPage();
        let reachability: Reachability = 'live';
        let evidence: ApplicationPageEvidence | undefined;
        let collisionJobIds: string[] = [];
        let browserError: unknown;
        try {
          let response = await page.goto(message.candidateUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          reachability = reachabilityFromHttpStatus(response?.status());
          if (reachability === 'live') {
            const readyFrames = new Set<ReturnType<typeof page.frames>[number]>();
            // Analytics need not settle before the client-side description is ready.
            const awaitDescription = async () => {
              await Promise.all(page.frames().slice(0, 8).map(async (frame) => {
                try {
                  const ready = await frame.waitForFunction(renderedDescriptionReady, { timeout: 6_000, polling: 250 }, reference.title);
                  readyFrames.add(frame); await ready.dispose();
                } catch { /* A shell is reported explicitly below, never a negative disclosure. */ }
              }));
            };
            await awaitDescription();
            const recovery = exactPostingRecoveryUrl(page.url(), message.providerIdentity.postingId,
              await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].slice(0, 1000).map((link) => link.href)));
            if (recovery) {
              readyFrames.clear();
              response = await page.goto(recovery, { waitUntil: 'domcontentloaded', timeout: 15_000 });
              reachability = reachabilityFromHttpStatus(response?.status());
              if (reachability === 'live') await awaitDescription();
            }
            const renderedFrames: RenderedFrameSnapshot[] = [];
            const frames = page.frames();
            let failedFrameCount = Math.max(0, frames.length - 16);
            for (const frame of frames.slice(0, 16)) {
              try {
                const snapshot = await frame.evaluate((requestedPostingId) => {
                  const visible = (element: Element) => element.getClientRects().length > 0;
                  const structuredPostings: Record<string, unknown>[] = [];
                  let jobPostingCount = 0;
                  const structuredNodes = [...document.querySelectorAll('script[type="application/ld+json"]')];
                  for (const node of structuredNodes.slice(0, 20)) {
                    const text = node.textContent ?? '';
                    const matches = text.match(/["']@type["']\s*:\s*["']JobPosting["']/gi) ?? [];
                    jobPostingCount += matches.length;
                    if (matches.length) {
                      try {
                        const queue: unknown[] = [JSON.parse(text)];
                        while (queue.length) {
                          const value = queue.shift();
                          if (Array.isArray(value)) { queue.push(...value); continue; }
                          if (!value || typeof value !== 'object') continue;
                          const record = value as Record<string, unknown>;
                          if (record['@graph']) queue.push(record['@graph']);
                          const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
                          if (types.includes('JobPosting')) structuredPostings.push(record);
                        }
                      } catch { /* Malformed structured data remains ordinary visible evidence. */ }
                    }
                  }
                  const pageUrl = new URL(location.href); pageUrl.hash = '';
                  const jobRoute = /(?:^|\/)(?:careers?|jobs?|openings?|positions?|roles?|vacancies?)(?:\/|$)/i;
                  const distinctJobLinks = new Set([...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
                    .filter(visible)
                    .map((link) => { try { const value = new URL(link.href, location.href); value.hash = ''; return value; } catch { return undefined; } })
                    .filter((value): value is URL => Boolean(value && ['http:', 'https:'].includes(value.protocol)
                      && value.toString() !== pageUrl.toString() && jobRoute.test(value.pathname)))
                    .map((value) => value.toString()));
                  const actionableApply = [...document.querySelectorAll<HTMLElement>('a[href],button')].some((control) => {
                    if (!visible(control) || !/^apply(?:\s+now)?$/iu.test(control.innerText.trim())) return false;
                    if (control instanceof HTMLButtonElement) return Boolean(control.closest('form'));
                    try {
                      const target = new URL((control as HTMLAnchorElement).href, location.href); target.hash = '';
                      return target.toString() !== pageUrl.toString();
                    } catch { return false; }
                  });
                  const description = document.querySelector('meta[name="description"],meta[property="og:description"]')?.getAttribute('content') ?? undefined;
                  const escapedPostingId = requestedPostingId?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const matching = escapedPostingId ? structuredPostings.filter((record) => new RegExp(
                    `(?:^|[^a-z0-9])${escapedPostingId}(?:$|[^a-z0-9])`, 'i',
                  ).test(JSON.stringify(record))) : [];
                  const solePostingDeclaresIdentity = structuredPostings.length === 1
                    && ['identifier', '@id', 'url', 'jobId', 'postingId', 'requisitionId']
                      .some((key) => structuredPostings[0][key] !== undefined && structuredPostings[0][key] !== null);
                  const selectedPosting = matching.length === 1 ? matching[0]
                    : structuredPostings.length === 1 && (!requestedPostingId || !solePostingDeclaresIdentity)
                      ? structuredPostings[0] : undefined;
                  const selectedValidThrough = typeof selectedPosting?.validThrough === 'string'
                    && !Number.isNaN(Date.parse(selectedPosting.validThrough))
                    ? new Date(selectedPosting.validThrough).toISOString() : undefined;
                  const compensationRows = [...document.querySelectorAll<HTMLElement>('h2,h3')]
                    .filter((heading) => visible(heading) && /^(?:compensation|salary|pay range)$/iu.test(heading.innerText.trim()))
                    .flatMap((heading) => [...(heading.nextElementSibling?.matches('ul,ol') ? heading.nextElementSibling.children : [])])
                    .filter(visible).map((row) => (row as HTMLElement).innerText.trim());
                  const fullText = (document.querySelector('main')?.innerText ?? document.body?.innerText ?? '').split(/[\r\n]+/)
                    .map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
                  const main = fullText.slice(0, 40_000);
                  return {
                    url: location.href, title: document.title || undefined, description,
                    visibleText: main || undefined, structuredJobText: selectedPosting ? JSON.stringify(selectedPosting).slice(0, 40_000) : undefined,
                    validThrough: selectedValidThrough,
                    structuredJobDocuments: structuredNodes.slice(0, 20).map((node) => (node.textContent ?? '').slice(0, 20_000)),
                    compensationRows: compensationRows.slice(0, 20).map((row) => row.slice(0, 1000)),
                    inspectionTruncated: fullText.length > 40_000 || structuredNodes.length > 20 || structuredNodes.some((node) => (node.textContent?.length ?? 0) > 20_000)
                      || compensationRows.length > 20 || compensationRows.some((row) => row.length > 1000),
                    loadingShell: fullText.length < 500 || /^(?:loading[.…\s]*)$/i.test(fullText),
                    jobPostingCount, distinctJobLinkCount: distinctJobLinks.size,
                    applicationFormPresent: actionableApply || [...document.querySelectorAll<Element>(
                      'form[action*="apply" i],form[id*="apply" i],input[type="file"],input[name="resume" i],input[name="cv" i]',
                    )].some(visible),
                  };
                }, message.providerIdentity.postingId);
                renderedFrames.push({ ...snapshot, loadingShell: snapshot.loadingShell || !readyFrames.has(frame),
                  ...(frame.parentFrame() ? { parentUrl: frame.parentFrame()!.url() } : {}) });
              } catch {
                failedFrameCount += 1;
              }
            }
            evidence = combineRenderedFrameEvidence({ role: reference.title, expectedPostingId: message.providerIdentity.postingId,
              frames: renderedFrames, failedFrameCount });
            if (!candidateOnly && evidence?.renderedEvidenceHash && message.providerIdentity.postingId) {
              collisionJobIds = await operations.renderedEvidenceCollisionJobIds(
                message.jobId, evidence.renderedEvidenceHash, message.providerIdentity.postingId,
              );
              if (collisionJobIds.length) evidence = { ...evidence, identicalEvidenceForDifferentPosting: true };
            }
          }
        } catch (error) {
          browserError = error;
          reachability = reachabilityFromFailure(error);
        } finally {
          await page.close();
        }
        // An employer-hosted page may reveal its Greenhouse board only in a
        // rendered embed. Historical collection gets one fixed-host API attempt
        // using that observed URL; the route still requires the known posting
        // ID and rejects conflicting tenants/duplicate identity parameters.
        if (message.metadataBackfillToken && !apiAcquisition && reachability === 'live'
          && evidence && !evidence.identicalEvidenceForDifferentPosting
          && metadataApiRoute(message.providerIdentity, evidence.url)?.method === 'greenhouse-api') {
          apiAcquisition = await acquireMetadata(message.providerIdentity, evidence.url);
        }
        const inspectedAt = now().toISOString();
        let currentJob = job;
        let currentReference = reference;
        if (!candidateOnly) {
          const refreshedJob = await jobs.getJob(message.jobId);
          const refreshedReference = refreshedJob?.sourceReferences.find((item) => item.sourceId === message.sourceId
            && item.externalId === message.externalId);
          if (!refreshedJob || !refreshedReference || !destinationVerificationMatchesReference(refreshedReference, message)) {
            await settleWithoutVerification(queued, message, inspectedAt, 'obsolete');
            continue;
          }
          currentJob = refreshedJob;
          currentReference = refreshedReference;
        }
        for (const collisionJobId of (candidateOnly || message.metadataBackfillToken) ? [] : collisionJobIds) {
          const collisionJob = await jobs.getJob(collisionJobId);
          const collisionReference = collisionJob?.sourceReferences.find((item) => item.externalId
            && item.admission?.destination.renderedEvidenceHash === evidence?.renderedEvidenceHash);
          const prior = collisionReference?.admission?.destination;
          if (!collisionJob || !collisionReference?.externalId || !prior?.expectedPostingId) continue;
          const collisionMessage: DestinationVerificationMessage = {
            version: 1, jobId: collisionJob.jobId, sourceId: collisionReference.sourceId,
            externalId: collisionReference.externalId, candidateUrl: prior.candidateUrl, reason: 'weekly-sample', queuedAt: attemptedAt,
            metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
            providerIdentity: { provider: prior.provider, sourceId: collisionReference.sourceId, sourceUrl: collisionReference.sourceUrl,
              ...(prior.tenant ? { tenant: prior.tenant } : {}), postingId: prior.expectedPostingId },
          };
          const collisionResult = await persistDestinationAdmission({ jobs, operations, message: collisionMessage,
            job: collisionJob, reference: collisionReference, reachability: 'live', inspectedAt, browserVisible: true,
            trustedCommunityCatalogEnabled: env.TRUSTED_COMMUNITY_CATALOG_ENABLED === 'true',
            identityUnconfirmedPublicationEnabled: env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
            evidence: { url: prior.finalUrl ?? prior.candidateUrl, expectedPostingId: prior.expectedPostingId,
              renderedEvidenceHash: prior.renderedEvidenceHash, identicalEvidenceForDifferentPosting: true,
              confidence: { score: 0, level: 'low', recommendation: 'review', signals: ['identical rendered evidence for different posting IDs'] } } });
          if (collisionResult.incident) opened.push(collisionResult.incident);
        }
        const result = candidateOnly
          ? await classifyReferenceDestination({ operations, message, job: currentJob, reference: currentReference, reachability, inspectedAt,
            ...(evidence ? { evidence, browserVisible: true } : {}) })
          : await persistDestinationAdmission({ jobs, operations, message, job: currentJob, reference: currentReference, reachability, inspectedAt,
            apiAcquisition, durationMs: Date.parse(inspectedAt) - Date.parse(attemptedAt),
            trustedCommunityCatalogEnabled: env.TRUSTED_COMMUNITY_CATALOG_ENABLED === 'true',
            identityUnconfirmedPublicationEnabled: env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
            ...(evidence ? { evidence, browserVisible: true } : {}) });
        if ('obsolete' in result && result.obsolete) {
          await settleWithoutVerification(queued, message, inspectedAt, 'obsolete');
          continue;
        }
        if ('incident' in result && result.incident) opened.push(result.incident);
        // The shadow path receives an exact artifact revision only after the
        // canonical observation is durable. Its failures never block catalog
        // admission, publication, or notifications.
        const shadowArtifact = apiAcquisition?.artifact?.text
          ? { title: apiAcquisition.artifact.title, description: apiAcquisition.artifact.text, sourceUrl: apiAcquisition.sourceUrl,
            incomplete: false }
          : evidence?.contentExcerpt && !evidence.identicalEvidenceForDifferentPosting
            ? { title: evidence.title ?? currentReference.title, description: evidence.contentExcerpt, sourceUrl: evidence.url,
              incomplete: evidence.inspectionTruncated === true || evidence.loadingShell === true }
            : undefined;
        if (!candidateOnly) {
          await handoffShadowExtraction({ env, operations, message, title: shadowArtifact?.title ?? currentReference.title,
            description: shadowArtifact?.description, sourceUrl: shadowArtifact?.sourceUrl ?? message.candidateUrl,
            observedAt: inspectedAt, incomplete: shadowArtifact?.incomplete ?? true,
            ...('shadowBaseline' in result ? { baseline: result.shadowBaseline } : {}),
            method: apiAcquisition?.method ?? 'browser' });
        }
        const attemptId = candidateOnly
          ? `historical-backfill:${message.generationId ?? 'unknown'}:${crypto.randomUUID()}`
          : crypto.randomUUID();
        await operations.recordVerificationAttempt({ id: attemptId, jobId: message.jobId, sourceId: message.sourceId,
          candidateUrl: message.candidateUrl, state: browserError ? 'failed' : 'succeeded', classification: result.destination.classification,
          ...(browserError ? { error: browserError instanceof Error ? browserError.message.slice(0, 500) : String(browserError).slice(0, 500) } : {}),
          attemptedAt, completedAt: inspectedAt }, !candidateOnly && result.destination.evidenceHash ? { hash: result.destination.evidenceHash,
          classification: result.destination.classification, value: result.destination, observedAt: inspectedAt } : undefined);
        if (candidateOnly && message.generationId && message.occurrenceKey && !browserError) {
          await operations.recordBackfillEvidence({ generationId: message.generationId, occurrenceKey: message.occurrenceKey,
            evidenceHash: result.destination.evidenceHash ?? createHash('sha256').update(JSON.stringify(result.destination)).digest('hex'),
            classification: result.destination.classification, value: result.destination, observedAt: inspectedAt });
        }
        // A staged collection pass is best-effort. A host that refuses a headless
        // fetch must not consume the platform's retries and land in the dead-letter
        // queue: the acquisition's own retry window re-offers the role by itself,
        // and a transient refusal says nothing about the catalog's health.
        const retryTransientFailure = Boolean(browserError && reachability !== 'gone' && !message.metadataBackfillToken);
        if (!candidateOnly && message.occurrenceKey) {
          if (retryTransientFailure) {
            if (message.leaseToken) {
              await operations.deferScheduledVerificationRetry({ occurrenceKey: message.occurrenceKey,
                leaseToken: message.leaseToken, updatedAt: inspectedAt,
                deferredUntil: new Date(Date.parse(inspectedAt) + DESTINATION_RETRY_DELAY_SECONDS * 1_000
                  + DESTINATION_RETRY_LEASE_MARGIN_MS).toISOString() });
            }
          } else {
            await operations.completeScheduledVerification({ occurrenceKey: message.occurrenceKey, leaseToken: message.leaseToken,
              completedAt: inspectedAt, classification: result.destination.classification,
              nextCheckAt: result.destination.nextCheckAt ?? new Date(Date.parse(inspectedAt) + 6 * 86_400_000).toISOString() });
          }
        }
        if (retryTransientFailure) queued.retry({ delaySeconds: DESTINATION_RETRY_DELAY_SECONDS });
        else {
          if (message.idempotencyKey) await operations.recordVerificationCompletion(message.idempotencyKey, inspectedAt);
          queued.ack();
        }
      } catch (error) {
        queued.retry({ delaySeconds: 300 }, error);
      }
    }
  } catch (error) {
    for (const { queued } of pending) queued.retry({ delaySeconds: 300 }, error);
  } finally {
    if (browser) await browser.close();
  }
  const groups = new Map<string, { sourceId: string; host: string; reason: string; incidents: string[]; messageType: 'incident-opened' | 'quarantine' }>();
  for (const item of opened) {
    const key = `${item.messageType}\0${item.sourceId}\0${item.host}\0${item.reason}`;
    const group = groups.get(key) ?? { sourceId: item.sourceId, host: item.host, reason: item.reason, incidents: [], messageType: item.messageType };
    group.incidents.push(item.incidentId); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const sentAt = now().toISOString();
    if (await sendIncidentEmail(operations, env, group, group.messageType, sentAt) && group.messageType === 'quarantine') {
      for (const id of group.incidents) await operations.markIncidentNotification(id, 'quarantine', sentAt);
    }
  }
}

/**
 * Incident warnings only. Owner decision, 2026-09-17: nothing re-inspects a
 * destination after it is admitted — a stored decision is durable — so the
 * scheduled daily re-checks, the schedule-table sync that fed them, the weekly
 * review samples, and the metadata revalidation pass are all gone. Inspection at
 * admission time still runs, and the operations API can still enqueue a check by
 * hand. Returns the number of warning groups sent.
 */
export async function enqueueDueDestinationVerifications(
  env: Pick<DestinationVerificationEnvironment, 'DB' | 'DESTINATION_VERIFICATION_QUEUE' | 'RESEND_API_KEY' | 'ADMISSION_SUPPORT_RECIPIENT' | 'AUTH_FROM_EMAIL'>,
  now = new Date(),
): Promise<number> {
  const operations = new D1CatalogAdmissionStore(env.DB);
  const incidents = await operations.listActiveIncidents();
  const warnings = new Map<string, { sourceId: string; host: string; reason: string; incidents: string[] }>();
  for (const incident of incidents) {
    if (!incident.graceDeadline || incident.warningSentAt) continue;
    const remaining = Date.parse(incident.graceDeadline) - now.getTime();
    if (remaining <= 0 || remaining > 24 * 60 * 60_000) continue;
    const key = `${incident.sourceId}\0${incident.host}\0${incident.reasonCode}`;
    const group = warnings.get(key) ?? { sourceId: incident.sourceId, host: incident.host, reason: incident.reasonCode, incidents: [] };
    group.incidents.push(incident.id); warnings.set(key, group);
  }
  for (const group of warnings.values()) {
    const sentAt = now.toISOString();
    if (await sendIncidentEmail(operations, env, group, 'grace-warning', sentAt)) {
      for (const id of group.incidents) await operations.markIncidentNotification(id, 'grace-warning', sentAt);
    }
  }
  return warnings.size;
}
