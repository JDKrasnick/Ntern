import { createHash } from 'node:crypto';
import type { ApplicationSession } from './application-automation.js';
import { catalogSearchText, catalogSourceClasses } from './catalog-fields.js';
import { openCatalogSortKey } from './catalog-recency.js';
import { inferSeason } from './core/early-career.js';
import { canonicalCompanyKey, fingerprint, normalizeUrl } from './core/normalize.js';
import { alertEligible, catalogEligible, deriveCanonicalAdmission } from './catalog-admission.js';
import { canonicalizePostingUrl, providerPostingReference } from './identity/posting.js';
import { postingIdentityStatusForOccurrences } from './identity/projection.js';
import { resolvePostingIdentityDecision, type PostingIdentityRegistryResult } from './identity/registry.js';
import { mergeSourceOccurrenceReferences, sourceOccurrenceKey } from './identity/source-occurrence.js';
import {
  providerEvidenceForOccurrence,
  reviewedProviderEvidenceError,
  reviewedProviderUrlReference,
  uniqueGreenhouseEvidenceForSources,
  unscopedGreenhouseEmbedPostingId,
} from './identity/reviewed-provider.js';
import { notificationDedupeKey } from './notifications.js';
import type { CatalogRelease } from './catalog-groups.js';
import { isOfficialOccurrence } from './sources/provenance.js';
import type { ApplicationRecord, DeliveryReceipt, Internship, PostingIdentity, PostingProvider, ProviderPostingEvidence, SourceCheckpoint, SourceOccurrence } from './types.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

type CatalogRow = {
  pk: string; sk: string; kind: string; value: string;
  url_key?: string | null; fingerprint_key?: string | null; sms_pending?: number; digest_pending?: number;
  catalog_state?: string | null; catalog_sort_key?: string | null; search_text?: string | null;
  source_classes?: string | null; source_id?: string | null; external_id?: string | null;
};
type UserRow = { user_id: string; item_key: string; kind: string; value: string; session_id?: string | null; receipt_state?: string | null; expires_at?: number | null };
type ProposalRow = { id: string; job_id: string };
type EmployerMappingRow = { provider: string; scope: string; canonical_employer_id: string };
type PresentationReviewRow = {
  id: string; provider: string; tenant: string; posting_id: string;
  company: string; title: string; location: string; locations_json: string;
  apply_url: string; evidence_url: string; evidence_hash: string;
  reviewed_at: string; reviewed_by: string;
};
type CatalogWrite = { before?: CatalogRow; pk: string; sk: string; kind: string; value: string; columns?: Partial<CatalogRow> };
type UserWrite = { before?: UserRow; userId: string; itemKey: string; kind: string; value: string; columns?: Partial<UserRow> };

export interface PostingIdentityRepairPlan {
  schemaVersion: 3;
  scope: PostingIdentityRepairScope;
  snapshotDigest: string;
  repairToken: string;
  occurrenceCounts: {
    confirmed: number;
    unconfirmed: number;
    legacy: number;
    quarantined: number;
    /** Legacy-unclassified rows are excluded from this denominator. */
    confirmedCoverage: number | null;
  };
  duplicateAlertGroups: number;
  unknownUrlFamilyCandidates: Array<{ reviewFamilyKey: string; occurrences: number }>;
  gate: {
    passed: boolean;
    exactDuplicateGroups: number;
    aliasConflicts: number;
    untrackedQuarantines: number;
    presentationBlockers: number;
    legacyOccurrences: number;
    projectionMismatches: number;
    duplicateOccurrenceReferences: number;
    danglingOccurrenceReferences: number;
  };
  providerGroups: number;
  duplicateGroups: number;
  duplicateJobs: number;
  eligibleDuplicateGroups: number;
  eligibleDuplicateJobs: number;
  unresolvedDuplicateGroups: number;
  jobUpdates: number;
  jobDeletes: number;
  aliasWrites: number;
  occurrenceRemaps: number;
  notificationTombstoneRemaps: number;
  applicationRemaps: number;
  applicationMerges: number;
  sessionRemaps: number;
  receiptRemaps: number;
  receiptMerges: number;
  releaseRemaps: number;
  proposalRemaps: number;
  outboxRows: number;
  conflicts: string[];
  presentationDisagreements: PresentationDisagreement[];
  samples: Array<{
    canonicalJobId: string;
    duplicateJobIds: string[];
    providerIdentity: string;
    applyEligible: boolean;
    disagreementFields: PresentationField[];
  }>;
  expectedChanges: number;
  applied: boolean;
  projectionRefreshRequired: boolean;
}

export type PostingIdentityRepairScope = 'all' | 'identity' | 'occurrences';

export type PresentationField =
  | 'employerIdentity'
  | 'employerName'
  | 'title'
  | 'location'
  | 'destinationUrl'
  | 'admissionState'
  | 'admissionReasons';

export interface PresentationDisagreement {
  providerIdentity: string;
  canonicalJobId: string;
  duplicateJobIds: string[];
  fields: PresentationField[];
  values: Partial<Record<PresentationField, Array<{ jobId: string; value: unknown }>>>;
}

type InternalPlan = PostingIdentityRepairPlan & {
  catalogWrites: CatalogWrite[]; catalogDeletes: CatalogRow[];
  userWrites: UserWrite[]; userDeletes: UserRow[]; proposalUpdates: ProposalRow[];
  scan: PostingIdentityScan;
};

/**
 * Compact, merge-safe outputs of one plan pass. The paged identity audit runs
 * this same plan over catalog slices and merges these values instead of the
 * whole catalog, so an audit never holds every row in Worker memory.
 */
export type PostingIdentityScan = {
  /** Durable occurrence keys with the identity decision the plan counted. */
  occurrenceDecisions: Array<[string, string | null]>;
  /** Unconfirmed review family per classified occurrence key. */
  unconfirmedFamilies: Array<[string, string]>;
  /** Reviewed provider identity groups: key, member job ID, first-seen stamp. */
  groupMembers: Array<[string, string, string]>;
  /** Provider aliases each reviewed group claims: group key, alias value. */
  groupAliases: Array<[string, string]>;
};

export type PostingIdentityRepairReviewContext = {
  /** Active, immutable reviewer mappings. They are part of the guarded repair
   * facts so historical jobs can use the same employer decision as ingestion. */
  employerMappings?: EmployerMappingRow[];
  /** Append-only reviewer choices from employer-owned posting pages. */
  presentationReviews?: PresentationReviewRow[];
};

const parse = <T>(value: string): T => JSON.parse(value) as T;
const earliest = (values: string[]) => [...values].sort()[0]!;
const latest = (values: string[]) => [...values].sort().at(-1)!;
const firstSeen = (job: Internship) => job.firstSeenAt || job.catalogVisibleAt || job.lastSeenAt;
function normalizedOccurrenceSeason(occurrence: SourceOccurrence): SourceOccurrence {
  const multiSeason = /\b(?:winter|spring|summer|fall)\s*[/-]\s*(?:winter|spring|summer|fall)\s*(?:intern(?:ship)?\s*)?20\d{2}\b/i.test(occurrence.title);
  return multiSeason
    ? { ...occurrence, season: inferSeason(occurrence.title, '', new Date(0)) }
    : occurrence;
}

function withProviderEvidence(occurrence: SourceOccurrence): SourceOccurrence {
  const normalized = normalizedOccurrenceSeason(occurrence);
  if (normalized.providerEvidence || !normalized.externalId) return normalized;
  const evidence = providerEvidenceForOccurrence(normalized.sourceId, normalized.externalId, [normalized.applyUrl]);
  return evidence ? { ...normalized, providerEvidence: evidence } : normalized;
}

function mergedOccurrenceEvidence(values: SourceOccurrence[]): SourceOccurrence[] {
  return mergeSourceOccurrenceReferences(values).map(withProviderEvidence);
}

function jobColumns(job: Internship): Partial<CatalogRow> {
  const publishable = job.technical !== false && catalogEligible(job);
  return {
    url_key: job.normalizedUrl,
    fingerprint_key: job.fingerprint,
    sms_pending: job.notification.smsPending && alertEligible(job) ? 1 : 0,
    digest_pending: job.notification.digestPending && alertEligible(job) ? 1 : 0,
    catalog_state: publishable ? job.open ? 'OPEN' : 'CLOSED' : null,
    catalog_sort_key: publishable ? job.open ? openCatalogSortKey(job) : `${job.lastSeenAt}#${job.jobId}` : null,
    search_text: publishable ? catalogSearchText(job) : null,
    source_classes: publishable ? JSON.stringify(catalogSourceClasses(job)) : null,
  };
}

function mergeJob(
  canonical: Internship,
  members: Internship[],
  identity: PostingIdentity,
  official: (SourceOccurrence & { preserveCanonicalSeason?: boolean }) | undefined,
  classify: (reference: SourceOccurrence, fallbackObservedAt: string) => SourceOccurrence,
): Internship {
  const sourceReferences = mergedOccurrenceEvidence(members.flatMap((job) => job.sourceReferences))
    .map((reference) => classify(reference, canonical.firstSeenAt));
  const smsSentAt = members.map((job) => job.notification.smsSentAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const digestedAt = members.map((job) => job.notification.digestedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const company = official?.company ?? canonical.company;
  const title = official?.title ?? canonical.title;
  const location = official?.location ?? canonical.location;
  const evidenceDateValue = official?.providerTimestamp?.value ?? canonical.lastSeenAt;
  const parsedEvidenceDate = Date.parse(evidenceDateValue);
  const evidenceDate = new Date(Number.isNaN(parsedEvidenceDate) ? 0 : parsedEvidenceDate);
  const season = official && !official.preserveCanonicalSeason
    ? inferSeason(official.title, '', evidenceDate)
    : canonical.season;
  const applyUrl = official ? canonicalizePostingUrl(official.applyUrl) : canonical.applyUrl;
  const compensation = [...members]
    .sort((a, b) => (b.compensation.maxHourlyUSD ?? b.compensation.minHourlyUSD ?? 0)
      - (a.compensation.maxHourlyUSD ?? a.compensation.minHourlyUSD ?? 0))
    .find((job) => job.compensation.raw || job.compensation.maxHourlyUSD || job.compensation.minHourlyUSD)?.compensation
    ?? canonical.compensation;
  const lastSeenAt = latest(members.map((job) => job.lastSeenAt));
  const admission = deriveCanonicalAdmission(sourceReferences, lastSeenAt);
  return {
    ...canonical,
    company,
    title,
    location,
    ...(official?.locations ? { locations: official.locations } : {}),
    season,
    applyUrl,
    normalizedUrl: normalizeUrl(applyUrl),
    fingerprint: fingerprint(company, title, location, season),
    compensation,
    requirements: {
      requiresUsCitizenship: members.some((job) => job.requirements?.requiresUsCitizenship),
      advancedDegreeRequired: members.some((job) => job.requirements?.advancedDegreeRequired),
    },
    postingIdentity: identity,
    postingIdentityStatus: 'confirmed',
    sourceReferences,
    ...(admission ? { admission } : {}),
    open: members.some((job) => job.open),
    technical: members.some((job) => job.technical !== false),
    firstSeenAt: earliest(members.map(firstSeen)),
    catalogVisibleAt: earliest(members.map((job) => job.catalogVisibleAt ?? firstSeen(job))),
    lastSeenAt,
    notification: {
      smsPending: !smsSentAt && members.some((job) => job.notification.smsPending),
      digestPending: !digestedAt && members.some((job) => job.notification.digestPending),
      ...(smsSentAt ? { smsSentAt } : {}), ...(digestedAt ? { digestedAt } : {}),
    },
  };
}

function statusRank(status: ApplicationRecord['status']) {
  return ({ saved: 0, applied: 1, assessment: 2, interview: 3, rejected: 4, withdrawn: 4, offer: 5 })[status];
}

function receiptRank(receipt: DeliveryReceipt) {
  if (receipt.status === 'ok' || receipt.deliveryState === 'delivered') return 5;
  if (receipt.deliveryState === 'accepted' || receipt.deliveryState === 'unknown' || receipt.status === 'pending') return 4;
  if (receipt.deliveryState === 'definitive-failure') return 3;
  return receipt.status === 'retryable' ? 2 : 1;
}

function uniqueNotes(records: ApplicationRecord[]): string | undefined {
  const notes = [...new Set([...records].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.applicationId.localeCompare(b.applicationId))
    .map((item) => item.notes?.trim()).filter((value): value is string => Boolean(value)))];
  return notes.length ? notes.join('\n\n') : undefined;
}

type HistoricalProviderEvidence = {
  provider: Exclude<PostingProvider, 'unknown'>;
  tenant?: string;
  postingId: string;
  sourceId: string;
  identity: PostingIdentity;
};

function providerKey(evidence: Pick<HistoricalProviderEvidence, 'provider' | 'tenant' | 'postingId'>) {
  return `${evidence.provider}:${evidence.tenant?.toLowerCase() ?? '-'}:${evidence.postingId.toLowerCase()}`;
}

function presentationReviewEvidenceHash(row: PresentationReviewRow, locations: string[]): string {
  return createHash('sha256').update(JSON.stringify({
    provider: row.provider,
    tenant: row.tenant,
    postingId: row.posting_id,
    company: row.company,
    title: row.title,
    location: row.location,
    locations,
    applyUrl: row.apply_url,
    evidenceUrl: row.evidence_url,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  })).digest('hex');
}

function reviewedPresentation(
  row: PresentationReviewRow,
): { key: string; occurrence: SourceOccurrence & { preserveCanonicalSeason: true } } {
  const locations = parse<unknown>(row.locations_json);
  if (!Array.isArray(locations) || !locations.length || locations.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${row.id}: reviewed presentation locations are invalid`);
  }
  const reference = providerPostingReference(row.apply_url);
  const evidenceReference = providerPostingReference(row.evidence_url);
  if (reference.provider === 'unknown' || !reference.postingId
    || reference.provider !== row.provider || reference.tenant !== row.tenant || reference.postingId !== row.posting_id
    || evidenceReference.provider !== row.provider || evidenceReference.tenant !== row.tenant
    || evidenceReference.postingId !== row.posting_id) {
    throw new Error(`${row.id}: reviewed presentation URL does not match its exact provider identity`);
  }
  if (presentationReviewEvidenceHash(row, locations) !== row.evidence_hash) {
    throw new Error(`${row.id}: reviewed presentation evidence hash does not match`);
  }
  return {
    key: providerKey({ provider: reference.provider as Exclude<PostingProvider, 'unknown'>,
      tenant: reference.tenant, postingId: reference.postingId }),
    occurrence: {
      sourceId: `presentation-review:${row.id}`,
      externalId: row.posting_id,
      provenance: 'official-ats',
      document: 'official-page-review',
      sourceUrl: row.evidence_url,
      row: 0,
      company: row.company,
      title: row.title,
      location: row.location,
      locations,
      season: 'reviewed-presentation',
      applyUrl: row.apply_url,
      compensation: { raw: '' },
      state: 'open',
      preserveCanonicalSeason: true,
    },
  };
}

function checkpointEvidenceForUnscopedGreenhouseEmbed(
  input: string,
  checkpoints: Map<string, SourceCheckpoint>,
): ProviderPostingEvidence | undefined {
  const postingId = unscopedGreenhouseEmbedPostingId(input);
  if (!postingId) return undefined;
  const activeSources = [...checkpoints.entries()]
    .filter(([, checkpoint]) => checkpoint.activeExternalIds?.includes(postingId))
    .map(([sourceId]) => sourceId);
  return uniqueGreenhouseEvidenceForSources(postingId, activeSources, [input]);
}

function historicalOccurrenceDecision(
  occurrence: SourceOccurrence,
  checkpoints: Map<string, SourceCheckpoint>,
  fallbackObservedAt: string,
): { occurrence: SourceOccurrence; result: PostingIdentityRegistryResult; evidenceSourceId?: string } {
  const normalized = withProviderEvidence(occurrence);
  const embedded = checkpointEvidenceForUnscopedGreenhouseEmbed(normalized.applyUrl, checkpoints);
  const providerEvidence = normalized.providerEvidence ?? embedded;
  const parsed = reviewedProviderUrlReference(normalized.applyUrl);
  const reviewedProviderReferences = parsed.outcome === 'match'
    && checkpoints.get(parsed.reference.sourceId)?.activeExternalIds?.includes(parsed.reference.postingId)
    ? [{ provider: parsed.reference.provider, tenant: parsed.reference.tenant, postingId: parsed.reference.postingId }]
    : [];
  const result = resolvePostingIdentityDecision({
    sourceId: normalized.sourceId,
    externalId: normalized.externalId ?? '',
    applicationUrl: normalized.applyUrl,
    observedAt: normalized.postingIdentityDecision?.observedAt ?? normalized.firstAttachedAt ?? fallbackObservedAt,
    ...(providerEvidence ? { providerEvidence } : {}),
    ...(reviewedProviderReferences.length ? { reviewedProviderReferences } : {}),
    ...(normalized.postingIdentityDecision ? { previousDecision: normalized.postingIdentityDecision } : {}),
  });
  return {
    occurrence: providerEvidence ? { ...normalized, providerEvidence } : normalized,
    result,
    ...(providerEvidence?.sourceId
      ? { evidenceSourceId: providerEvidence.sourceId }
      : parsed.outcome === 'match' && reviewedProviderReferences.length
        ? { evidenceSourceId: parsed.reference.sourceId }
        : {}),
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function structuredDigest(sections: Array<[string, unknown[]]>): string {
  const hash = createHash('sha256');
  for (const [name, values] of sections) {
    hash.update(`${name.length}:${name}:${values.length}:`);
    for (const value of values) {
      const encoded = JSON.stringify(stable(value));
      hash.update(`${encoded.length}:`);
      hash.update(encoded);
    }
  }
  return hash.digest('hex');
}

type FutureAdmissionJob = Internship & {
  employerId?: string;
  admissionState?: unknown;
  admissionReasons?: unknown;
  admission?: { state?: unknown; reasons?: unknown };
  catalogAdmission?: { state?: unknown; reasons?: unknown };
};

function reviewedEmployerIdentity(
  job: Internship,
  mappings: Map<string, string>,
): string | string[] | undefined {
  if (job.admission?.canonicalEmployer?.id) return job.admission.canonicalEmployer.id;
  const identities = new Set<string>();
  for (const reference of job.sourceReferences) {
    const confirmed = reference.postingIdentityDecision?.status === 'confirmed'
      ? reference.postingIdentityDecision
      : undefined;
    const employerScope = `employer:${canonicalCompanyKey(reference.company)}`;
    const provider = reference.providerEvidence?.provider
      ?? (reference.sourceId.startsWith('greenhouse-') ? 'greenhouse'
        : reference.sourceId.startsWith('lever-') ? 'lever'
          : reference.sourceId.startsWith('ashby-') ? 'ashby' : undefined);
    const contexts: Array<{ provider: string; scopes: Array<string | undefined> }> = [];
    if (confirmed?.provider) contexts.push({
      provider: confirmed.provider,
      scopes: [reference.sourceId, confirmed.tenant,
        confirmed.tenant ? `${confirmed.provider}-${confirmed.tenant}` : undefined, employerScope],
    });
    if (reference.provenance === 'reviewed-community') {
      contexts.push({ provider: 'github', scopes: [employerScope] });
    } else if (provider) {
      contexts.push({ provider, scopes: [reference.sourceId, reference.providerEvidence?.tenant, employerScope] });
    }
    for (const context of contexts) {
      for (const scope of context.scopes.filter((value): value is string => Boolean(value))) {
        const variants = scope.startsWith('employer:')
          ? [scope, `employer:${scope.slice('employer:'.length).replace(/[\s_]+/gu, '-')}`]
          : [scope];
        for (const variant of variants) {
          const canonicalEmployerId = mappings.get(`${context.provider}\0${variant}`);
          if (canonicalEmployerId) identities.add(canonicalEmployerId);
        }
      }
    }
  }
  const values = [...identities].sort();
  return values.length <= 1 ? values[0] : values;
}

function presentation(job: Internship, employerMappings: Map<string, string>): Record<PresentationField, unknown> {
  const future = job as FutureAdmissionJob;
  const identity = (job.internshipIdentity as { company?: { canonicalId?: string } } | undefined)?.company?.canonicalId;
  return {
    employerIdentity: reviewedEmployerIdentity(job, employerMappings) ?? future.employerId ?? identity,
    employerName: job.company,
    title: job.title,
    location: { location: job.location, locations: job.locations ?? [] },
    destinationUrl: job.applyUrl,
    admissionState: future.catalogAdmission?.state ?? future.admission?.state ?? future.admissionState,
    admissionReasons: future.catalogAdmission?.reasons ?? future.admission?.reasons ?? future.admissionReasons,
  };
}

function comparablePresentationValue(field: PresentationField, value: unknown): unknown {
  if (field !== 'destinationUrl' || typeof value !== 'string') return value;
  try { return canonicalizePostingUrl(value); } catch { return value; }
}

function presentationDisagreement(
  providerIdentity: string,
  canonicalJobId: string,
  members: Internship[],
  employerMappings: Map<string, string>,
  official?: SourceOccurrence,
): PresentationDisagreement | undefined {
  const values = {} as PresentationDisagreement['values'];
  const fields: PresentationField[] = [];
  for (const field of Object.keys(presentation(members[0]!, employerMappings)) as PresentationField[]) {
    if (official && ['employerName', 'title', 'location', 'destinationUrl'].includes(field)) continue;
    const observed = members.map((job) => ({ jobId: job.jobId, value: presentation(job, employerMappings)[field] }));
    if (new Set(observed.map((item) => JSON.stringify(stable(comparablePresentationValue(field, item.value))))).size <= 1) continue;
    fields.push(field);
    values[field] = observed;
  }
  if (!fields.length) return undefined;
  return {
    providerIdentity,
    canonicalJobId,
    duplicateJobIds: members.slice(1).map((job) => job.jobId),
    fields,
    values,
  };
}

/** A directly attached official connector occurrence is reviewed presentation
 * evidence only when it matches the exact provider tenant and immutable ID. */
function officialPresentation(members: Internship[], evidence: HistoricalProviderEvidence): SourceOccurrence | undefined {
  const matches = members.flatMap((job) => job.sourceReferences).filter((reference) =>
    reference.provenance === 'official-ats'
    && reference.sourceId === evidence.sourceId
    && reference.externalId?.toLowerCase() === evidence.postingId.toLowerCase());
  if (!matches.length) return undefined;
  const presentations = new Set(matches.map((reference) => JSON.stringify(stable({
    company: reference.company,
    title: reference.title,
    location: reference.location,
    locations: reference.locations ?? [],
    applyUrl: canonicalizePostingUrl(reference.applyUrl),
  }))));
  if (presentations.size !== 1) return undefined;
  return [...matches].sort((a, b) => (b.providerTimestamp?.value ?? '').localeCompare(a.providerTimestamp?.value ?? ''))[0];
}

/**
 * `audit` computes every gate, coverage, and conflict fact the plan reports and
 * skips write materialisation: the canonical merge, alias and job-ID claims,
 * the occurrence and season synchronisation sweep, tombstones, and user-item
 * remaps. The paged audit discards writes, so spending Worker memory and CPU on
 * them would make the slice passable for no gain.
 */
export type PostingIdentityPlanMode = 'repair' | 'audit';

export function postingIdentityRepairPlan(
  catalogRows: CatalogRow[],
  userRows: UserRow[],
  proposalRows: ProposalRow[] = [],
  scope: PostingIdentityRepairScope = 'all',
  reviewContext: PostingIdentityRepairReviewContext = {},
  mode: PostingIdentityPlanMode = 'repair',
): InternalPlan {
  const audit = mode === 'audit';
  const conflicts: string[] = [];
  const employerMappings = new Map<string, string>();
  for (const mapping of reviewContext.employerMappings ?? []) {
    const key = `${mapping.provider}\0${mapping.scope}`;
    const existing = employerMappings.get(key);
    if (existing && existing !== mapping.canonical_employer_id) {
      conflicts.push(`reviewed employer mapping ${mapping.provider}:${mapping.scope} resolves to multiple canonical employers`);
      continue;
    }
    employerMappings.set(key, mapping.canonical_employer_id);
  }
  const presentationReviews = new Map<string, SourceOccurrence & { preserveCanonicalSeason: true }>();
  for (const row of reviewContext.presentationReviews ?? []) {
    try {
      const reviewed = reviewedPresentation(row);
      if (presentationReviews.has(reviewed.key)) {
        conflicts.push(`${reviewed.key}: multiple reviewed presentation decisions`);
      } else presentationReviews.set(reviewed.key, reviewed.occurrence);
    } catch (error) {
      conflicts.push(error instanceof Error ? error.message : String(error));
    }
  }
  const snapshotDigest = structuredDigest([
    ['catalog', catalogRows.map((row) => [row.pk, row.sk, row.kind, row.value])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1])))],
    ['users', userRows.map((row) => [row.user_id, row.item_key, row.kind, row.value])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1])))],
    ['proposals', proposalRows.map((row) => [row.id, row.job_id])
      .sort((left, right) => left[0].localeCompare(right[0]))],
    ['employerMappings', [...employerMappings.entries()].sort(([left], [right]) => left.localeCompare(right))],
    ['presentationReviews', [...(reviewContext.presentationReviews ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id))],
  ]);
  const occurrenceDecisions = new Map<string, SourceOccurrence['postingIdentityDecision']>();
  const jobRows = catalogRows.filter((row) => row.kind === 'internship');
  const catalogByKey = new Map(catalogRows.map((row) => [`${row.pk}\0${row.sk}`, row]));
  const currentJobIds = new Set(jobRows.flatMap((row) => {
    try { return [parse<Internship>(row.value).jobId]; } catch { return []; }
  }));
  const rawJobAliases = new Map<string, string>();
  for (const row of catalogRows.filter((item) => item.kind === 'job-id-alias')) {
    try {
      const value = parse<{ oldJobId?: string; canonicalJobId?: string }>(row.value);
      const keyJobId = row.pk.startsWith('JOB_ID_ALIAS#') ? row.pk.slice('JOB_ID_ALIAS#'.length) : undefined;
      if (row.sk !== 'TARGET' || !keyJobId || !value.oldJobId || !value.canonicalJobId || value.oldJobId !== keyJobId) {
        conflicts.push(`${row.pk}:${row.sk}: malformed job ID alias`);
        continue;
      }
      if (value.oldJobId === value.canonicalJobId) {
        conflicts.push(`${value.oldJobId}: job ID alias cannot target itself`);
        continue;
      }
      const existing = rawJobAliases.get(value.oldJobId);
      if (existing && existing !== value.canonicalJobId) {
        conflicts.push(`${value.oldJobId}: job ID alias resolves to multiple canonical jobs`);
        continue;
      }
      rawJobAliases.set(value.oldJobId, value.canonicalJobId);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed job ID alias JSON`); }
  }
  const existingCanonicalByJobId = new Map<string, string>();
  for (const [oldJobId, canonicalJobId] of rawJobAliases) {
    if (currentJobIds.has(oldJobId)) {
      conflicts.push(`${oldJobId}: job ID alias source still has an internship row`);
    } else if (rawJobAliases.has(canonicalJobId)) {
      conflicts.push(`${oldJobId}: job ID alias must be one hop`);
    } else if (!currentJobIds.has(canonicalJobId)) {
      conflicts.push(`${oldJobId}: job ID alias target ${canonicalJobId} is missing`);
    } else {
      existingCanonicalByJobId.set(oldJobId, canonicalJobId);
    }
  }
  let untrackedQuarantines = 0;
  let danglingOccurrenceReferences = 0;
  for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const state = parse<{ sourceId: string; externalId: string; jobId: string; occurrence: SourceOccurrence }>(row.value);
      occurrenceDecisions.set(sourceOccurrenceKey(state.occurrence), state.occurrence.postingIdentityDecision);
      if (state.occurrence.postingIdentityDecision?.status === 'quarantined') untrackedQuarantines += 1;
      if (!currentJobIds.has(state.jobId)) danglingOccurrenceReferences += 1;
    } catch { /* The existing occurrence parser reports malformed rows below. */ }
  }
  for (const row of catalogRows.filter((item) => item.kind === 'internship')) {
    try {
      const job = parse<Internship>(row.value);
      for (const occurrence of job.sourceReferences) {
        occurrenceDecisions.set(sourceOccurrenceKey(occurrence), occurrenceDecisions.get(sourceOccurrenceKey(occurrence)) ?? occurrence.postingIdentityDecision);
      }
    } catch { /* The primary job scan reports malformed rows below. */ }
  }
  const decisionValues = [...occurrenceDecisions.values()];
  const confirmedOccurrences = decisionValues.filter((decision) => decision?.status === 'confirmed').length;
  const unconfirmedOccurrences = decisionValues.filter((decision) => decision?.status === 'unconfirmed').length;
  const incidentCount = catalogRows.filter((row) => row.kind === 'posting-identity-incident').length;
  const legacyOccurrences = decisionValues.filter((decision) => !decision).length;
  const classifiedOccurrences = confirmedOccurrences + unconfirmedOccurrences;
  let projectionMismatches = 0;
  let duplicateOccurrenceReferences = 0;
  for (const row of catalogRows.filter((item) => item.kind === 'internship')) {
    try {
      const job = parse<Internship>(row.value);
      if (job.postingIdentityStatus !== postingIdentityStatusForOccurrences(job.sourceReferences)) projectionMismatches += 1;
      const occurrenceKeys = job.sourceReferences.map(sourceOccurrenceKey);
      duplicateOccurrenceReferences += occurrenceKeys.length - new Set(occurrenceKeys).size;
    } catch { /* The primary job scan reports malformed rows below. */ }
  }
  const checkpoints = new Map(catalogRows.filter((row) => row.kind === 'checkpoint').flatMap((row) => {
    try { const value = parse<SourceCheckpoint>(row.value); return [[value.sourceId, value] as const]; } catch { return []; }
  }));
  const occurrencesByJob = new Map<string, SourceOccurrence[]>();
  for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const state = parse<{ jobId: string; occurrence: SourceOccurrence; firstObservedAt?: string; firstObservedAtPrecision?: 'exact' | 'unknown'; changedAt?: string }>(row.value);
      const attachedAt = state.firstObservedAt ?? state.changedAt;
      const occurrence = attachedAt && !state.occurrence.firstAttachedAt
        ? { ...state.occurrence, firstAttachedAt: attachedAt, firstAttachedAtPrecision: state.firstObservedAt ? state.firstObservedAtPrecision ?? 'exact' as const : 'unknown' as const }
        : state.occurrence;
      const jobId = existingCanonicalByJobId.get(state.jobId) ?? state.jobId;
      occurrencesByJob.set(jobId, [...(occurrencesByJob.get(jobId) ?? []), occurrence]);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed source occurrence JSON`); }
  }
  const classificationByOccurrence = new Map<string, { occurrence: SourceOccurrence; result: PostingIdentityRegistryResult; evidenceSourceId?: string }>();
  const classifyResult = (occurrence: SourceOccurrence, fallbackObservedAt: string) => {
    const key = sourceOccurrenceKey(occurrence);
    const existing = classificationByOccurrence.get(key);
    if (existing) return existing;
    const classified = historicalOccurrenceDecision(occurrence, checkpoints, fallbackObservedAt);
    classificationByOccurrence.set(key, classified);
    return classified;
  };
  const classifiedOccurrence = (occurrence: SourceOccurrence, fallbackObservedAt: string) => {
    const classified = classifyResult(occurrence, fallbackObservedAt);
    return { ...classified.occurrence, postingIdentityDecision: classified.result.decision };
  };
  const groups = new Map<string, Array<{ row: CatalogRow; evidence: HistoricalProviderEvidence }>>();
  for (const row of jobRows) {
    let job: Internship;
    try {
      job = parse<Internship>(row.value);
      job = { ...job, sourceReferences: mergedOccurrenceEvidence([
        ...job.sourceReferences, ...(occurrencesByJob.get(job.jobId) ?? []),
      ]) };
    } catch { conflicts.push(`${row.pk}: malformed internship JSON`); continue; }
    const invalidEvidence = job.sourceReferences.flatMap((reference) => {
      if (!reference.providerEvidence) return [];
      const error = reviewedProviderEvidenceError(reference.providerEvidence);
      return error ? [`${job.jobId}:${reference.sourceId}: ${error}`] : [];
    });
    if (invalidEvidence.length) { conflicts.push(...invalidEvidence); continue; }
    const evidence = job.sourceReferences.flatMap((reference): HistoricalProviderEvidence[] => {
      const classified = classifyResult(reference, job.firstSeenAt);
      if (classified.result.decision.status === 'quarantined') {
        conflicts.push(`${job.jobId}:${reference.sourceId}: ${classified.result.decision.reason}`);
        return [];
      }
      const identity = classified.result.identity;
      if (classified.result.decision.status !== 'confirmed' || !identity
        || identity.provider === 'unknown' || !identity.providerPostingId) return [];
      return [{
        provider: identity.provider,
        ...(identity.tenant ? { tenant: identity.tenant } : {}),
        postingId: identity.providerPostingId,
        sourceId: classified.evidenceSourceId ?? reference.sourceId,
        identity,
      }];
    });
    const uniqueEvidence = [...new Map(evidence.map((item) => [providerKey(item), item])).values()];
    if (uniqueEvidence.length > 1) { conflicts.push(`${job.jobId}: reviewed provider evidence disagrees (${uniqueEvidence.map(providerKey).sort().join(', ')})`); continue; }
    if (!uniqueEvidence.length) continue;
    const key = providerKey(uniqueEvidence[0]!);
    groups.set(key, [...(groups.get(key) ?? []), { row, evidence: uniqueEvidence[0]! }]);
  }

  const postingAliasesByCanonicalJobId = new Map<string, Array<{ row: CatalogRow; claim: { alias: string; canonicalJobId: string } }>>();
  for (const row of catalogRows.filter((item) => item.kind === 'posting-alias')) {
    try {
      const claim = parse<{ alias: string; canonicalJobId: string }>(row.value);
      postingAliasesByCanonicalJobId.set(claim.canonicalJobId, [
        ...(postingAliasesByCanonicalJobId.get(claim.canonicalJobId) ?? []), { row, claim },
      ]);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed posting alias JSON`); }
  }

  const canonicalByJobId = new Map(existingCanonicalByJobId);
  const identityCanonicalByJobId = new Map<string, string>();
  const canonicalJobs = new Map<string, Internship>();
  const scanGroupMembers: PostingIdentityScan['groupMembers'] = [];
  const scanGroupAliases: PostingIdentityScan['groupAliases'] = [];
  const catalogWrites: CatalogWrite[] = [];
  const catalogDeletes: CatalogRow[] = [];
  const samples: PostingIdentityRepairPlan['samples'] = [];
  const presentationDisagreements: PresentationDisagreement[] = [];
  let duplicateGroups = 0;
  let duplicateJobs = 0;
  let eligibleDuplicateGroups = 0;
  let eligibleDuplicateJobs = 0;
  for (const [key, values] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const hydrated = values.flatMap((item) => {
      try {
        const stored = parse<Internship>(item.row.value);
        return [{ ...item, job: { ...stored, sourceReferences: mergedOccurrenceEvidence([
          ...stored.sourceReferences, ...(occurrencesByJob.get(stored.jobId) ?? []),
        ]) } }];
      } catch { return []; }
    });
    const ordered = hydrated.sort((a, b) => firstSeen(a.job).localeCompare(firstSeen(b.job)) || a.job.jobId.localeCompare(b.job.jobId));
    if (!ordered.length) continue;
    for (const item of ordered) scanGroupMembers.push([key, item.job.jobId, firstSeen(item.job)]);
    const canonical = ordered[0]!;
    const presentationMembers = ordered.map((item) => ({ ...item.job, sourceReferences: item.job.sourceReferences
      .map((reference) => classifiedOccurrence(reference, firstSeen(item.job))) }));
    const official = officialPresentation(presentationMembers, canonical.evidence)
      ?? presentationReviews.get(key);
    const disagreement = ordered.length > 1
      ? presentationDisagreement(key, canonical.job.jobId, presentationMembers, employerMappings, official)
      : undefined;
    if (ordered.length > 1) {
      duplicateGroups += 1;
      duplicateJobs += ordered.length - 1;
      if (disagreement) presentationDisagreements.push(disagreement);
      else {
        eligibleDuplicateGroups += 1;
        eligibleDuplicateJobs += ordered.length - 1;
      }
      samples.push({
        canonicalJobId: canonical.job.jobId,
        duplicateJobIds: ordered.slice(1).map((item) => item.job.jobId),
        providerIdentity: key,
        applyEligible: !disagreement,
        disagreementFields: disagreement?.fields ?? [],
      });
    }
    // Provider identity alone does not authorize a presentation choice. An
    // exact official connector occurrence may resolve presentation fields;
    // every remaining disagreement still waits for a reviewed #120 decision.
    if (disagreement) continue;
    const retainedIdentity = ordered.length === 1
      && canonical.job.postingIdentity?.provider === canonical.evidence.provider
      && canonical.job.postingIdentity.tenant?.toLowerCase() === canonical.evidence.tenant?.toLowerCase()
      && canonical.job.postingIdentity.providerPostingId?.toLowerCase() === canonical.evidence.postingId.toLowerCase()
      ? canonical.job.postingIdentity
      : undefined;
    const identity = retainedIdentity
      ? { ...retainedIdentity }
      : {
          ...canonical.evidence.identity,
          canonicalApplicationUrl: canonicalizePostingUrl(canonical.job.applyUrl),
          aliases: [...canonical.evidence.identity.aliases],
        };
    identity.canonicalJobId = canonical.job.jobId;
    const classifyReference = scope === 'identity'
      ? (reference: SourceOccurrence) => reference
      : classifiedOccurrence;
    const merged = audit ? canonical.job : retainedIdentity
      ? { ...canonical.job, postingIdentityStatus: 'confirmed' as const,
          sourceReferences: canonical.job.sourceReferences.map((reference) => classifyReference(reference, canonical.job.firstSeenAt)) }
      : mergeJob(canonical.job, ordered.map((item) => item.job), identity, official, classifyReference);
    if (!audit) canonicalJobs.set(canonical.job.jobId, merged);
    for (const item of ordered) {
      canonicalByJobId.set(item.job.jobId, canonical.job.jobId);
      identityCanonicalByJobId.set(item.job.jobId, canonical.job.jobId);
    }
    if (scope === 'occurrences') continue;
    if (!audit) {
      if (JSON.stringify(stable(merged)) !== JSON.stringify(stable(parse<Internship>(canonical.row.value)))) {
        catalogWrites.push({ before: canonical.row, pk: canonical.row.pk, sk: canonical.row.sk, kind: 'internship', value: JSON.stringify(merged), columns: jobColumns(merged) });
      }
      catalogDeletes.push(...ordered.slice(1).map((item) => item.row));
    }
    const duplicateIds = new Set(ordered.slice(1).map((item) => item.job.jobId));
    const remappedAliasKeys = new Set<string>();
    for (const duplicateId of duplicateIds) {
      for (const { row, claim } of postingAliasesByCanonicalJobId.get(duplicateId) ?? []) {
        remappedAliasKeys.add(`${row.pk}\0${row.sk}`);
        if (!audit) catalogWrites.push({ before: row, pk: row.pk, sk: row.sk, kind: row.kind,
          value: JSON.stringify({ ...claim, canonicalJobId: canonical.job.jobId }) });
      }
    }
    const aliasValues = new Set(identity.aliases.filter((item) => item.value.startsWith('provider:')).map((item) => item.value));
    aliasValues.add(`provider:${key}`);
    for (const alias of [...aliasValues].sort()) {
      scanGroupAliases.push([key, alias]);
      const pk = `POSTING_ALIAS#${alias}`; const existing = catalogByKey.get(`${pk}\0CLAIM`);
      if (existing) {
        const claim = parse<{ canonicalJobId?: string }>(existing.value);
        if (remappedAliasKeys.has(`${pk}\0CLAIM`)) continue;
        if (claim.canonicalJobId !== canonical.job.jobId) conflicts.push(`${alias}: already claimed by ${claim.canonicalJobId ?? 'an invalid row'}`);
        continue;
      }
      if (!audit) catalogWrites.push({ pk, sk: 'CLAIM', kind: 'posting-alias', value: JSON.stringify({ alias, canonicalJobId: canonical.job.jobId, claimedAt: 'identity-repair' }) });
    }
    for (const duplicate of ordered.slice(1)) {
      const pk = `JOB_ID_ALIAS#${duplicate.job.jobId}`; const existing = catalogByKey.get(`${pk}\0TARGET`);
      if (existing) {
        const claim = parse<{ canonicalJobId?: string }>(existing.value);
        if (claim.canonicalJobId !== canonical.job.jobId) conflicts.push(`${duplicate.job.jobId}: legacy alias already targets ${claim.canonicalJobId ?? 'an invalid row'}`);
        continue;
      }
      if (!audit) catalogWrites.push({ pk, sk: 'TARGET', kind: 'job-id-alias', value: JSON.stringify({ oldJobId: duplicate.job.jobId, canonicalJobId: canonical.job.jobId, createdBy: 'posting-identity-repair' }) });
    }
  }

  // Identity aliases can attach occurrences that older catalog rows never
  // received. Materialize the authoritative occurrence set before applying
  // the repair so a replay is a no-op rather than reopening or reclassifying
  // the same canonical posting on its next poll.
  const memberIdsByCanonical = new Map<string, string[]>();
  for (const row of jobRows) {
    try {
      const job = parse<Internship>(row.value);
      const canonical = canonicalByJobId.get(job.jobId) ?? job.jobId;
      memberIdsByCanonical.set(canonical, [...(memberIdsByCanonical.get(canonical) ?? []), job.jobId]);
    } catch { /* Malformed internship JSON was reported above. */ }
  }
  if (!audit && scope !== 'identity') for (const row of jobRows) {
    let stored: Internship;
    try { stored = parse<Internship>(row.value); } catch { continue; }
    const canonicalId = canonicalByJobId.get(stored.jobId) ?? stored.jobId;
    if (canonicalId !== stored.jobId) continue;
    const base = canonicalJobs.get(canonicalId) ?? stored;
    const occurrenceReferences = (memberIdsByCanonical.get(canonicalId) ?? [canonicalId])
      .flatMap((jobId) => occurrencesByJob.get(jobId) ?? []);
    const sourceReferences = mergedOccurrenceEvidence([...base.sourceReferences, ...occurrenceReferences])
      .map((reference) => classifiedOccurrence(reference, base.firstSeenAt));
    const synchronizedAdmission = deriveCanonicalAdmission(sourceReferences, base.lastSeenAt);
    const officialSeason = sourceReferences.find((reference) => isOfficialOccurrence(reference)
      && /\b(?:winter|spring|summer|fall)\s*[/-]\s*(?:winter|spring|summer|fall)\s*(?:intern(?:ship)?\s*)?20\d{2}\b/i.test(reference.title))?.season;
    const season = officialSeason ?? base.season;
    const synchronized: Internship = {
      ...base,
      sourceReferences,
      postingIdentityStatus: postingIdentityStatusForOccurrences(sourceReferences),
      ...(synchronizedAdmission ? { admission: synchronizedAdmission } : {}),
      season,
      fingerprint: fingerprint(base.company, base.title, base.location, season),
    };
    canonicalJobs.set(canonicalId, synchronized);
    const changed = JSON.stringify(stable(synchronized)) !== JSON.stringify(stable(stored));
    const priorWrite = catalogWrites.findIndex((write) => write.pk === row.pk && write.sk === row.sk && write.kind === 'internship');
    if (!changed) {
      if (priorWrite >= 0) catalogWrites.splice(priorWrite, 1);
    } else {
      const write = { before: row, pk: row.pk, sk: row.sk, kind: 'internship', value: JSON.stringify(synchronized), columns: jobColumns(synchronized) };
      if (priorWrite >= 0) catalogWrites[priorWrite] = write;
      else catalogWrites.push(write);
    }

  }

  let occurrenceRemaps = 0;
  if (!audit && scope !== 'identity') for (const row of catalogRows.filter((item) => item.kind === 'source-occurrence')) {
    try {
      const value = parse<{ jobId: string; occurrence: SourceOccurrence; firstObservedAt?: string; changedAt?: string }>(row.value);
      const canonical = canonicalByJobId.get(value.jobId) ?? value.jobId;
      const remapped = canonical !== value.jobId;
      const normalizedOccurrence = remapped ? withProviderEvidence(value.occurrence) : normalizedOccurrenceSeason(value.occurrence);
      const occurrence = classifiedOccurrence(
        normalizedOccurrence,
        value.firstObservedAt ?? value.changedAt ?? canonicalJobs.get(canonical)?.firstSeenAt ?? '1970-01-01T00:00:00.000Z',
      );
      const normalized = JSON.stringify(stable(occurrence)) !== JSON.stringify(stable(value.occurrence));
      if (!remapped && !normalized) continue;
      if (remapped) occurrenceRemaps += 1;
      catalogWrites.push({ before: row, pk: row.pk, sk: row.sk, kind: row.kind, value: JSON.stringify({
        ...value, jobId: canonical, occurrence,
      }) });
    } catch { /* Malformed occurrence JSON was reported while building reviewed evidence. */ }
  }

  let notificationTombstoneRemaps = 0;
  const notificationTombstoneGroups = new Map<string, CatalogRow[]>();
  for (const row of catalogRows.filter((item) => item.kind === 'notification-tombstone')) {
    try {
      const value = parse<{ jobId?: string }>(row.value);
      if (!value.jobId) continue;
      const canonical = identityCanonicalByJobId.get(value.jobId);
      if (!canonical || canonical === value.jobId) continue;
      const target = `${row.pk}\0ROLE#${canonical}`;
      notificationTombstoneGroups.set(target, [...(notificationTombstoneGroups.get(target) ?? []), row]);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed notification tombstone JSON`); }
  }
  for (const [target, rows] of audit ? [] : notificationTombstoneGroups) {
    const [pk, sk] = target.split('\0');
    const canonicalJobId = sk!.slice('ROLE#'.length);
    const existing = catalogByKey.get(target);
    const candidates = [...rows, ...(existing && !rows.includes(existing) ? [existing] : [])];
    const retained = [...candidates].sort((left, right) => {
      const leftAt = (() => { try { return parse<{ deletedAt?: string }>(left.value).deletedAt ?? ''; } catch { return ''; } })();
      const rightAt = (() => { try { return parse<{ deletedAt?: string }>(right.value).deletedAt ?? ''; } catch { return ''; } })();
      return leftAt.localeCompare(rightAt) || left.sk.localeCompare(right.sk);
    })[0]!;
    const value = JSON.stringify({ ...parse<Record<string, unknown>>(retained.value), jobId: canonicalJobId });
    if (!existing || existing.value !== value) catalogWrites.push({ before: existing, pk: pk!, sk: sk!, kind: 'notification-tombstone', value });
    for (const row of rows) if (row.pk !== pk || row.sk !== sk) catalogDeletes.push(row);
    notificationTombstoneRemaps += rows.filter((row) => row.pk !== pk || row.sk !== sk).length;
  }

  // User history is only ever written back by the repair; the audit reports
  // its conflicts and counts without materialising any of it.
  const remappableUsers = audit ? [] : userRows;
  const userWrites: UserWrite[] = [];
  const userDeletes: UserRow[] = [];
  const applicationIdAliases = new Map<string, string>();
  let applicationRemaps = 0; let applicationMerges = 0;
  const applicationGroups = new Map<string, Array<{ row: UserRow; value: ApplicationRecord }>>();
  for (const row of remappableUsers.filter((item) => item.kind === 'application')) {
    const value = parse<ApplicationRecord>(row.value); const canonical = identityCanonicalByJobId.get(value.jobId);
    if (!canonical) continue;
    const group = `${row.user_id}\0${canonical}`;
    applicationGroups.set(group, [...(applicationGroups.get(group) ?? []), { row, value }]);
  }
  for (const [group, records] of applicationGroups) {
    const canonicalJobId = group.split('\0')[1]!;
    if (records.every((item) => item.value.jobId === canonicalJobId)) continue;
    const ordered = [...records].sort((a, b) => b.value.updatedAt.localeCompare(a.value.updatedAt) || a.value.applicationId.localeCompare(b.value.applicationId));
    const keeper = ordered[0]!;
    const strongest = [...ordered].sort((a, b) => statusRank(b.value.status) - statusRank(a.value.status) || b.value.updatedAt.localeCompare(a.value.updatedAt))[0]!.value;
    const appliedAt = ordered.map((item) => item.value.appliedAt).filter((value): value is string => Boolean(value)).sort()[0];
    const queuedAt = ordered.map((item) => item.value.queuedAt).filter((value): value is string => Boolean(value)).sort()[0];
    const detection = ordered.map((item) => item.value.detection).filter((value): value is NonNullable<ApplicationRecord['detection']> => Boolean(value))
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))[0];
    const applyMode = strongest.applyMode ?? ordered.map((item) => item.value.applyMode).find((value) => value !== undefined);
    const notes = uniqueNotes(ordered.map((item) => item.value));
    const keeperRest = { ...keeper.value }; delete keeperRest.queuedAt;
    const value: ApplicationRecord = {
      ...keeperRest,
      jobId: canonicalJobId,
      status: strongest.status,
      createdAt: earliest(ordered.map((item) => item.value.createdAt)),
      updatedAt: latest(ordered.map((item) => item.value.updatedAt)),
      ...(appliedAt ? { appliedAt } : {}),
      ...(strongest.status === 'saved' && queuedAt ? { queuedAt } : {}),
      ...(detection ? { detection } : {}),
      ...(applyMode ? { applyMode } : {}),
      ...(notes ? { notes } : {}),
    };
    userWrites.push({ before: keeper.row, userId: keeper.row.user_id, itemKey: keeper.row.item_key, kind: keeper.row.kind, value: JSON.stringify(value) });
    applicationRemaps += 1; applicationMerges += ordered.length - 1;
    for (const item of ordered) applicationIdAliases.set(`${item.row.user_id}\0${item.value.applicationId}`, value.applicationId);
    userDeletes.push(...ordered.slice(1).map((item) => item.row));
  }

  let sessionRemaps = 0;
  for (const row of remappableUsers.filter((item) => item.kind === 'application-session')) {
    const value = parse<ApplicationSession>(row.value);
    const jobId = identityCanonicalByJobId.get(value.jobId) ?? value.jobId;
    const applicationId = applicationIdAliases.get(`${row.user_id}\0${value.applicationId}`) ?? value.applicationId;
    if (jobId === value.jobId && applicationId === value.applicationId) continue;
    sessionRemaps += 1;
    userWrites.push({ before: row, userId: row.user_id, itemKey: row.item_key, kind: row.kind, value: JSON.stringify({ ...value, jobId, applicationId }) });
  }

  let receiptRemaps = 0; let receiptMerges = 0;
  const receiptGroups = new Map<string, Array<{ row: UserRow; value: DeliveryReceipt; itemKey: string }>>();
  for (const row of remappableUsers.filter((item) => item.kind === 'receipt')) {
    const value = parse<DeliveryReceipt>(row.value); const canonical = identityCanonicalByJobId.get(value.jobId);
    const job = canonical && canonicalJobs.get(canonical); if (!canonical || !job) continue;
    const dedupeKey = notificationDedupeKey(job); const itemKey = `RECEIPT#${dedupeKey}#${value.token}`;
    const group = `${row.user_id}\0${itemKey}`;
    receiptGroups.set(group, [...(receiptGroups.get(group) ?? []), { row, value: { ...value, jobId: canonical, dedupeKey }, itemKey }]);
  }
  for (const records of receiptGroups.values()) {
    const ordered = [...records].sort((a, b) => receiptRank(b.value) - receiptRank(a.value) || b.value.updatedAt.localeCompare(a.value.updatedAt));
    const keeper = ordered[0]!; const existingTarget = remappableUsers.find((row) => row.user_id === keeper.row.user_id && row.item_key === keeper.itemKey);
    if (existingTarget && !records.some((item) => item.row === existingTarget)) {
      ordered.push({ row: existingTarget, value: parse<DeliveryReceipt>(existingTarget.value), itemKey: keeper.itemKey });
      ordered.sort((a, b) => receiptRank(b.value) - receiptRank(a.value) || b.value.updatedAt.localeCompare(a.value.updatedAt));
    }
    const strongest = ordered[0]!;
    const strongestJson = JSON.stringify(strongest.value);
    if (!existingTarget || existingTarget.value !== strongestJson) userWrites.push({ before: existingTarget, userId: keeper.row.user_id, itemKey: keeper.itemKey, kind: 'receipt', value: strongestJson, columns: {
      receipt_state: strongest.value.status === 'pending' ? 'PENDING' : strongest.value.status === 'retryable' ? 'RETRYABLE' : null,
      expires_at: keeper.row.expires_at ?? null,
    } });
    const deleted = new Set<string>();
    for (const item of records) if (item.row.item_key !== keeper.itemKey && !deleted.has(item.row.item_key)) { userDeletes.push(item.row); deleted.add(item.row.item_key); }
    if (!existingTarget || existingTarget.value !== strongestJson || deleted.size) receiptRemaps += 1;
    receiptMerges += Math.max(0, ordered.length - 1);
  }

  let releaseRemaps = 0;
  for (const row of remappableUsers.filter((item) => item.kind === 'catalog-release')) {
    const value = parse<CatalogRelease>(row.value);
    const mapIds = (ids: string[]) => [...new Set(ids.map((id) => identityCanonicalByJobId.get(id) ?? id))];
    const next = { ...value, jobIds: mapIds(value.jobIds), newJobIds: mapIds(value.newJobIds) };
    if (JSON.stringify(next) === row.value) continue;
    releaseRemaps += 1; userWrites.push({ before: row, userId: row.user_id, itemKey: row.item_key, kind: row.kind, value: JSON.stringify(next) });
  }

  const proposalUpdates = (audit ? [] : proposalRows).filter((row) => identityCanonicalByJobId.has(row.job_id)
    && identityCanonicalByJobId.get(row.job_id) !== row.job_id);
  const uniqueCatalogWrites = new Map<string, CatalogWrite>();
  for (const write of catalogWrites) {
    const key = `${write.pk}\0${write.sk}`;
    const previous = uniqueCatalogWrites.get(key);
    uniqueCatalogWrites.set(key, previous
      ? { ...write, before: previous.before ?? write.before }
      : write);
  }
  catalogWrites.splice(0, catalogWrites.length, ...uniqueCatalogWrites.values());
  const expectedChanges = catalogWrites.length + catalogDeletes.length + userWrites.length + userDeletes.length + proposalUpdates.length;
  const repairToken = structuredDigest([
    ['catalogWrites', catalogWrites.map((item) => [item.pk, item.sk, item.before?.value ?? null, item.value])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1])))],
    ['catalogDeletes', catalogDeletes.map((item) => [item.pk, item.sk, item.value])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1])))],
    ['userWrites', userWrites.map((item) => [item.userId, item.itemKey, item.before?.value ?? null, item.value])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1])))],
    ['userDeletes', userDeletes.map((item) => [item.user_id, item.item_key, item.value])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])) || String(left[1]).localeCompare(String(right[1])))],
    ['proposals', proposalUpdates.map((item) => [item.id, item.job_id, identityCanonicalByJobId.get(item.job_id)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))],
    ['presentationDisagreements', [...presentationDisagreements]
      .sort((left, right) => left.providerIdentity.localeCompare(right.providerIdentity) || left.canonicalJobId.localeCompare(right.canonicalJobId))],
    ['conflicts', [...conflicts].sort()],
  ]);
  const notificationGroups = new Map<string, number>();
  for (const row of catalogRows.filter((item) => item.kind === 'notification-event')) {
    try {
      const event = parse<{ jobId: string }>(row.value);
      const canonicalId = canonicalByJobId.get(event.jobId) ?? event.jobId;
      notificationGroups.set(canonicalId, (notificationGroups.get(canonicalId) ?? 0) + 1);
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed notification event JSON`); }
  }
  const duplicateAlertGroups = [...notificationGroups.values()].filter((count) => count > 1).length;
  for (const occurrences of occurrencesByJob.values()) for (const occurrence of occurrences) {
    classifyResult(occurrence, occurrence.firstAttachedAt ?? '1970-01-01T00:00:00.000Z');
  }
  const plannedFamilyCounts = new Map<string, number>();
  const scanUnconfirmedFamilies: PostingIdentityScan['unconfirmedFamilies'] = [];
  for (const [occurrenceKey, { result }] of classificationByOccurrence) if (result.decision.status === 'unconfirmed') {
    const key = result.decision.reviewFamilyKey;
    plannedFamilyCounts.set(key, (plannedFamilyCounts.get(key) ?? 0) + 1);
    scanUnconfirmedFamilies.push([occurrenceKey, key]);
  }
  const sortedConflicts = [...conflicts].sort();
  const gate = {
    passed: eligibleDuplicateGroups === 0 && sortedConflicts.length === 0 && untrackedQuarantines === 0
      && presentationDisagreements.length === 0 && duplicateAlertGroups === 0 && legacyOccurrences === 0
      && projectionMismatches === 0 && duplicateOccurrenceReferences === 0 && danglingOccurrenceReferences === 0,
    exactDuplicateGroups: eligibleDuplicateGroups,
    aliasConflicts: sortedConflicts.length,
    untrackedQuarantines,
    presentationBlockers: presentationDisagreements.length,
    legacyOccurrences,
    projectionMismatches,
    duplicateOccurrenceReferences,
    danglingOccurrenceReferences,
  };
  return {
    schemaVersion: 3, scope, snapshotDigest, repairToken,
    occurrenceCounts: {
      confirmed: confirmedOccurrences, unconfirmed: unconfirmedOccurrences, legacy: legacyOccurrences,
      quarantined: incidentCount,
      confirmedCoverage: classifiedOccurrences ? confirmedOccurrences / classifiedOccurrences : null,
    },
    duplicateAlertGroups,
    unknownUrlFamilyCandidates: [...plannedFamilyCounts.entries()].filter(([, count]) => count > 1)
      .map(([reviewFamilyKey, occurrences]) => ({ reviewFamilyKey, occurrences }))
      .sort((left, right) => right.occurrences - left.occurrences || left.reviewFamilyKey.localeCompare(right.reviewFamilyKey)),
    gate,
    providerGroups: groups.size, duplicateGroups, duplicateJobs,
    eligibleDuplicateGroups, eligibleDuplicateJobs,
    unresolvedDuplicateGroups: presentationDisagreements.length,
    jobUpdates: catalogWrites.filter((item) => item.kind === 'internship').length, jobDeletes: catalogDeletes.length,
    aliasWrites: catalogWrites.filter((item) => item.kind === 'posting-alias' || item.kind === 'job-id-alias').length,
    occurrenceRemaps, notificationTombstoneRemaps, applicationRemaps, applicationMerges, sessionRemaps, receiptRemaps, receiptMerges,
    releaseRemaps, proposalRemaps: proposalUpdates.length,
    outboxRows: catalogRows.filter((row) => row.kind === 'notification-event').length,
    conflicts: sortedConflicts, presentationDisagreements, samples: samples.slice(0, 20), expectedChanges,
    applied: false, projectionRefreshRequired: false,
    catalogWrites, catalogDeletes, userWrites, userDeletes, proposalUpdates,
    scan: {
      occurrenceDecisions: [...occurrenceDecisions].map(([key, decision]) => [key, decision?.status ?? null]),
      unconfirmedFamilies: scanUnconfirmedFamilies,
      groupMembers: scanGroupMembers,
      groupAliases: scanGroupAliases,
    },
  };
}

const STAGE_KIND = 'posting-identity-repair-stage';
const STAGE_ROWS_PER_STATEMENT = 20;
const STAGE_STATEMENTS_PER_BATCH = 25;
const D1_PAID_QUERY_LIMIT = 1_000;
const POST_REPAIR_QUERY_RESERVE = 100;
function operationId(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/**
 * Conservative statement budget for the repair itself. Twenty staged rows use
 * D1's full 100-bound-parameter allowance. Mutations are then applied with
 * seven guarded set-based statements rather than one statement per row.
 */
export function postingIdentityRepairQueryCount(expectedChanges: number) {
  return Math.ceil(expectedChanges / STAGE_ROWS_PER_STATEMENT) + 14;
}

async function stage(db: D1Database, plan: InternalPlan) {
  const pk = `POSTING_IDENTITY_REPAIR#${plan.repairToken}`;
  await db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}'`).bind(pk).run();
  const values = [
    ...plan.catalogWrites.map((item) => ({
      table: 'catalog', action: 'write', key1: item.pk, key2: item.sk,
      old: item.before?.value ?? null, kind: item.kind, new: item.value,
      columns: {
        url_key: item.columns?.url_key ?? item.before?.url_key ?? null,
        fingerprint_key: item.columns?.fingerprint_key ?? item.before?.fingerprint_key ?? null,
        sms_pending: item.columns?.sms_pending ?? item.before?.sms_pending ?? 0,
        digest_pending: item.columns?.digest_pending ?? item.before?.digest_pending ?? 0,
        catalog_state: item.columns?.catalog_state ?? item.before?.catalog_state ?? null,
        catalog_sort_key: item.columns?.catalog_sort_key ?? item.before?.catalog_sort_key ?? null,
        search_text: item.columns?.search_text ?? item.before?.search_text ?? null,
        source_classes: item.columns?.source_classes ?? item.before?.source_classes ?? null,
      },
    })),
    ...plan.catalogDeletes.map((item) => ({ table: 'catalog', action: 'delete', key1: item.pk, key2: item.sk, old: item.value })),
    ...plan.userWrites.map((item) => ({
      table: 'user', action: 'write', key1: item.userId, key2: item.itemKey,
      old: item.before?.value ?? null, kind: item.kind, new: item.value,
      columns: {
        receipt_state: item.columns?.receipt_state ?? item.before?.receipt_state ?? null,
        expires_at: item.columns?.expires_at ?? item.before?.expires_at ?? null,
      },
    })),
    ...plan.userDeletes.map((item) => ({ table: 'user', action: 'delete', key1: item.user_id, key2: item.item_key, old: item.value })),
    ...plan.proposalUpdates.map((item) => ({
      table: 'proposal', action: 'write', key1: item.id, key2: '', old: item.job_id,
      new: canonicalJobId(plan, item.job_id),
    })),
  ];
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < values.length; offset += STAGE_ROWS_PER_STATEMENT) {
    const chunk = values.slice(offset, offset + STAGE_ROWS_PER_STATEMENT);
    const placeholders = chunk.map(() => `(?, ?, '${STAGE_KIND}', ?, ?, ?)`).join(', ');
    statements.push(db.prepare(
      `INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id) VALUES ${placeholders}`,
    ).bind(...chunk.flatMap((item) => [pk, operationId(item), JSON.stringify(item), item.key1, item.key2])));
  }
  for (let offset = 0; offset < statements.length; offset += STAGE_STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(offset, offset + STAGE_STATEMENTS_PER_BATCH));
  }
  return pk;
}

function guardClause() { return "EXISTS (SELECT 1 FROM catalog_items WHERE pk = ? AND sk = 'GUARD' AND kind = 'posting-identity-repair-guard')"; }

function repairReport(plan: InternalPlan): PostingIdentityRepairPlan {
  return {
    schemaVersion: plan.schemaVersion, scope: plan.scope, snapshotDigest: plan.snapshotDigest,
    repairToken: plan.repairToken, occurrenceCounts: plan.occurrenceCounts,
    duplicateAlertGroups: plan.duplicateAlertGroups, unknownUrlFamilyCandidates: plan.unknownUrlFamilyCandidates, gate: plan.gate,
    providerGroups: plan.providerGroups, duplicateGroups: plan.duplicateGroups,
    duplicateJobs: plan.duplicateJobs, eligibleDuplicateGroups: plan.eligibleDuplicateGroups,
    eligibleDuplicateJobs: plan.eligibleDuplicateJobs, unresolvedDuplicateGroups: plan.unresolvedDuplicateGroups,
    jobUpdates: plan.jobUpdates, jobDeletes: plan.jobDeletes,
    aliasWrites: plan.aliasWrites, occurrenceRemaps: plan.occurrenceRemaps,
    notificationTombstoneRemaps: plan.notificationTombstoneRemaps, applicationRemaps: plan.applicationRemaps,
    applicationMerges: plan.applicationMerges, sessionRemaps: plan.sessionRemaps, receiptRemaps: plan.receiptRemaps,
    receiptMerges: plan.receiptMerges, releaseRemaps: plan.releaseRemaps, proposalRemaps: plan.proposalRemaps,
    outboxRows: plan.outboxRows, conflicts: plan.conflicts, presentationDisagreements: plan.presentationDisagreements,
    samples: plan.samples, expectedChanges: plan.expectedChanges,
    applied: plan.applied, projectionRefreshRequired: plan.projectionRefreshRequired,
  };
}

export async function runPostingIdentityRepair(db: D1Database, options: {
  apply?: boolean;
  repairToken?: string;
  expectedChanges?: number;
  expectedDuplicateJobs?: number;
  scope?: PostingIdentityRepairScope;
} = {}): Promise<PostingIdentityRepairPlan> {
  const [catalog, users, proposals, employerMappings, presentationReviews] = await Promise.all([
    db.prepare(`SELECT * FROM catalog_items
      WHERE kind IN ('internship', 'job-id-alias', 'source-occurrence', 'posting-identity-incident',
        'checkpoint', 'posting-alias', 'notification-tombstone', 'notification-event')
      ORDER BY pk, sk`).all<CatalogRow>(),
    db.prepare(`SELECT * FROM user_items
      WHERE kind IN ('application', 'application-session', 'receipt', 'catalog-release')
      ORDER BY user_id, item_key`).all<UserRow>(),
    db.prepare('SELECT id, job_id FROM employer_field_proposals ORDER BY id').all<ProposalRow>(),
    db.prepare(`SELECT provider, scope, canonical_employer_id FROM employer_mappings
      WHERE superseded_at IS NULL ORDER BY provider, scope`).all<EmployerMappingRow>(),
    db.prepare(`SELECT id, provider, tenant, posting_id, company, title, location,
        locations_json, apply_url, evidence_url, evidence_hash, reviewed_at, reviewed_by
      FROM posting_identity_presentation_reviews ORDER BY id`).all<PresentationReviewRow>(),
  ]);
  const scope = options.scope ?? 'all';
  if (!['all', 'identity', 'occurrences'].includes(scope)) throw new Error('Posting identity repair scope must be all, identity, or occurrences');
  const plan = postingIdentityRepairPlan(catalog.results, users.results, proposals.results, scope, {
    employerMappings: employerMappings.results,
    presentationReviews: presentationReviews.results,
  });
  const report = repairReport(plan);
  if (scope === 'occurrences' && plan.duplicateJobs > 0) {
    return { ...report, conflicts: [...report.conflicts, 'Apply and verify the identity scope before occurrence synchronization'] };
  }
  if (!options.apply) return report;
  if (plan.conflicts.length) throw new Error('Refusing apply while posting identity conflicts remain');
  if (plan.presentationDisagreements.length) {
    throw new Error('Refusing apply while duplicate groups have unresolved presentation disagreements');
  }
  if (options.repairToken !== plan.repairToken || options.expectedChanges !== plan.expectedChanges || options.expectedDuplicateJobs !== plan.duplicateJobs) {
    throw new Error('Catalog changed after dry run; use its exact repair token, changed-record count, and duplicate-job count');
  }
  if (!plan.expectedChanges) return { ...report, applied: true };
  if (postingIdentityRepairQueryCount(plan.expectedChanges) > D1_PAID_QUERY_LIMIT - POST_REPAIR_QUERY_RESERVE) {
    throw new Error('Posting identity repair exceeds the guarded D1 query budget; split the reviewed repair plan');
  }
  const stagePk = await stage(db, plan);
  const guard = db.prepare(`
    INSERT INTO catalog_items (pk, sk, kind, value)
    SELECT ?, 'GUARD', 'posting-identity-repair-guard', ?
    WHERE (SELECT COUNT(*) FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}') = ?
      AND (SELECT COUNT(*) FROM catalog_items AS staged LEFT JOIN catalog_items AS current
        ON json_extract(staged.value, '$.table') = 'catalog' AND current.pk = staged.source_id AND current.sk = staged.external_id
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}' AND json_extract(staged.value, '$.table') = 'catalog'
          AND ((json_extract(staged.value, '$.old') IS NULL AND current.pk IS NULL) OR current.value = json_extract(staged.value, '$.old'))) =
          (SELECT COUNT(*) FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}' AND json_extract(value, '$.table') = 'catalog')
      AND (SELECT COUNT(*) FROM catalog_items AS staged LEFT JOIN user_items AS current
        ON json_extract(staged.value, '$.table') = 'user' AND current.user_id = staged.source_id AND current.item_key = staged.external_id
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}' AND json_extract(staged.value, '$.table') = 'user'
          AND ((json_extract(staged.value, '$.old') IS NULL AND current.user_id IS NULL) OR current.value = json_extract(staged.value, '$.old'))) =
          (SELECT COUNT(*) FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}' AND json_extract(value, '$.table') = 'user')
      AND (SELECT COUNT(*) FROM catalog_items AS staged JOIN employer_field_proposals AS current ON current.id = staged.source_id
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}' AND json_extract(staged.value, '$.table') = 'proposal' AND current.job_id = json_extract(staged.value, '$.old')) =
          (SELECT COUNT(*) FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}' AND json_extract(value, '$.table') = 'proposal')
  `).bind(stagePk, JSON.stringify({ repairToken: plan.repairToken }), stagePk, plan.expectedChanges, stagePk, stagePk, stagePk, stagePk, stagePk, stagePk);
  const statements: D1PreparedStatement[] = [
    guard,
    db.prepare(`
      UPDATE catalog_items AS current SET
        kind = json_extract(staged.value, '$.kind'), value = json_extract(staged.value, '$.new'),
        url_key = json_extract(staged.value, '$.columns.url_key'),
        fingerprint_key = json_extract(staged.value, '$.columns.fingerprint_key'),
        sms_pending = json_extract(staged.value, '$.columns.sms_pending'),
        digest_pending = json_extract(staged.value, '$.columns.digest_pending'),
        catalog_state = json_extract(staged.value, '$.columns.catalog_state'),
        catalog_sort_key = json_extract(staged.value, '$.columns.catalog_sort_key'),
        search_text = json_extract(staged.value, '$.columns.search_text'),
        source_classes = json_extract(staged.value, '$.columns.source_classes')
      FROM catalog_items AS staged
      WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
        AND json_extract(staged.value, '$.table') = 'catalog'
        AND json_extract(staged.value, '$.action') = 'write'
        AND json_extract(staged.value, '$.old') IS NOT NULL
        AND current.pk = staged.source_id AND current.sk = staged.external_id
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      INSERT INTO catalog_items (
        pk, sk, kind, value, url_key, fingerprint_key, sms_pending, digest_pending,
        catalog_state, catalog_sort_key, search_text, source_classes
      )
      SELECT source_id, external_id, json_extract(value, '$.kind'), json_extract(value, '$.new'),
        json_extract(value, '$.columns.url_key'), json_extract(value, '$.columns.fingerprint_key'),
        json_extract(value, '$.columns.sms_pending'), json_extract(value, '$.columns.digest_pending'),
        json_extract(value, '$.columns.catalog_state'), json_extract(value, '$.columns.catalog_sort_key'),
        json_extract(value, '$.columns.search_text'), json_extract(value, '$.columns.source_classes')
      FROM catalog_items
      WHERE pk = ? AND kind = '${STAGE_KIND}'
        AND json_extract(value, '$.table') = 'catalog'
        AND json_extract(value, '$.action') = 'write'
        AND json_extract(value, '$.old') IS NULL
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      DELETE FROM catalog_items AS current
      WHERE EXISTS (
        SELECT 1 FROM catalog_items AS staged
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
          AND json_extract(staged.value, '$.table') = 'catalog'
          AND json_extract(staged.value, '$.action') = 'delete'
          AND current.pk = staged.source_id AND current.sk = staged.external_id
      ) AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      UPDATE user_items AS current SET
        kind = json_extract(staged.value, '$.kind'), value = json_extract(staged.value, '$.new'),
        receipt_state = json_extract(staged.value, '$.columns.receipt_state'),
        expires_at = json_extract(staged.value, '$.columns.expires_at')
      FROM catalog_items AS staged
      WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
        AND json_extract(staged.value, '$.table') = 'user'
        AND json_extract(staged.value, '$.action') = 'write'
        AND json_extract(staged.value, '$.old') IS NOT NULL
        AND current.user_id = staged.source_id AND current.item_key = staged.external_id
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      INSERT INTO user_items (user_id, item_key, kind, value, receipt_state, expires_at)
      SELECT source_id, external_id, json_extract(value, '$.kind'), json_extract(value, '$.new'),
        json_extract(value, '$.columns.receipt_state'), json_extract(value, '$.columns.expires_at')
      FROM catalog_items
      WHERE pk = ? AND kind = '${STAGE_KIND}'
        AND json_extract(value, '$.table') = 'user'
        AND json_extract(value, '$.action') = 'write'
        AND json_extract(value, '$.old') IS NULL
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      DELETE FROM user_items AS current
      WHERE EXISTS (
        SELECT 1 FROM catalog_items AS staged
        WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
          AND json_extract(staged.value, '$.table') = 'user'
          AND json_extract(staged.value, '$.action') = 'delete'
          AND current.user_id = staged.source_id AND current.item_key = staged.external_id
      ) AND ${guardClause()}
    `).bind(stagePk, stagePk),
    db.prepare(`
      UPDATE employer_field_proposals AS current
      SET job_id = json_extract(staged.value, '$.new')
      FROM catalog_items AS staged
      WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
        AND json_extract(staged.value, '$.table') = 'proposal'
        AND current.id = staged.source_id
        AND ${guardClause()}
    `).bind(stagePk, stagePk),
  ];
  const results = await db.batch(statements);
  const guarded = results[0]?.meta.changes === 1;
  const changed = results.slice(1).reduce((total, item) => total + item.meta.changes, 0);
  await db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND kind IN ('${STAGE_KIND}', 'posting-identity-repair-guard')`).bind(stagePk).run();
  if (!guarded || changed !== plan.expectedChanges) throw new Error('Posting identity repair conflict; no guarded changes were accepted');
  return { ...report, applied: true, projectionRefreshRequired: true };
}

function canonicalJobId(plan: InternalPlan, oldJobId: string) {
  const alias = plan.catalogWrites.find((item) => item.kind === 'job-id-alias' && item.pk === `JOB_ID_ALIAS#${oldJobId}`);
  return alias ? parse<{ canonicalJobId: string }>(alias.value).canonicalJobId : oldJobId;
}
