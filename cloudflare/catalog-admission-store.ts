import { createHash } from 'node:crypto';
import { alertEligible, catalogEligible, deriveCanonicalAdmission, evaluateCatalogAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { openCatalogSortKey } from '../src/catalog-recency.js';
import { catalogSearchText, catalogSourceClasses } from '../src/catalog-fields.js';
import { canonicalCompanyKey } from '../src/core/normalize.js';
import { providerPostingReference, providerPostingAlias } from '../src/identity/posting.js';
import type {
  AdmissionIncident,
  CanonicalEmployer,
  CatalogAdmission,
  DestinationReviewRule,
  EmployerMapping,
  EvidenceSource,
  Internship,
  ProcessedListing,
  ProviderIdentity,
  SourceOccurrence,
  SourceOccurrenceState,
  MetadataConflict,
  RoleMetadataEvidence,
  RoleMetadataOmission,
} from '../src/types.js';
import { projectRoleMetadata, reconcileRoleMetadata, replaceVerifiedPageMetadataEvidence, roleMetadataReviewFingerprint, ROLE_METADATA_EXTRACTION_VERSION, unsupportedMetadataCurrencies, unsupportedMetadataPeriods } from '../src/role-metadata.js';
import type { D1Database, D1PreparedStatement } from './types.js';

export const ATOMIC_REPAIR_RECORD_LIMIT = 900;
// Metadata apply performs bounded preflight scans before its atomic batch.
// Leave headroom under D1's 1,000-query invocation limit for those guards.
export const METADATA_REPAIR_RECORD_LIMIT = 250;
// Recurring admission work shares one D1 invocation. Keep each component
// bounded so scheduling, leasing, queue bookkeeping, and metadata reservation
// remain comfortably below the paid Workers 1,000-query ceiling.
export const DESTINATION_SCHEDULE_SYNC_LIMIT = 250;
export const DESTINATION_VERIFICATION_LEASE_LIMIT = 100;
// One completed occurrence can require four reviewed-mapping lookups before
// stageRepair performs its guarded reads and writes. Bound the composed stage
// request, not just the eventual atomic apply batch.
export const BACKFILL_REPAIR_RECORD_LIMIT = 120;
export const ATOMIC_REPAIR_BYTE_LIMIT = 8 * 1024 * 1024;
export const ROLE_METADATA_REVALIDATION_MS = 30 * 24 * 60 * 60_000;

export interface RoleMetadataCollectionCoverage {
  extractionVersion: number;
  eligible: number;
  current: number;
  pendingOrUnobserved: number;
  stale: number;
  complete: boolean;
  outcomes: Record<string, number>;
  backfillTokens: Record<string, number>;
}

type JsonRow = { value: string };
export type RepairChange = {
  jobId: string;
  admission: CatalogAdmission;
  company?: string;
  title?: string;
  location?: string;
  locations?: string[];
  applyUrl?: string;
  normalizedUrl?: string;
  sourceReferences?: SourceOccurrence[];
  /** `null` explicitly clears stale validation; omission preserves the durable value. */
  applicationUrlValidatedAt?: string | null;
};

export interface ScheduledDestinationVerification {
  occurrenceKey: string;
  jobId: string;
  sourceId: string;
  externalId: string;
  candidateUrl: string;
  providerIdentity: ProviderIdentity;
  nextCheckAt: string;
  leaseToken: string;
}

export interface AdmissionBackfillGeneration {
  id: string;
  state: 'previewed' | 'queued' | 'complete';
  total: number;
  queued: number;
  completed: number;
  createdAt: string;
  frozenAt: string;
  updatedAt: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function roleMetadataEvidenceDigest(row: { job_id: string; evidence: string }): string {
  return `${row.job_id}\0${hash(row.evidence)}`;
}

function roleMetadataEvidenceSnapshot(digests: Iterable<string>): string {
  return hash([...digests].sort().join('\n'));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function roleMetadataSchemaMissing(error: unknown): boolean {
  return error instanceof Error && /no such table:\s*role_metadata_/iu.test(error.message);
}

function metadataCollectionTarget(reference: SourceOccurrence): { candidateUrl: string; providerIdentity: ProviderIdentity } | undefined {
  if (!reference.externalId) return undefined;
  const destination = reference.admission?.destination;
  if (destination) {
    if (!['posting-detail', 'application-form'].includes(destination.classification)) return undefined;
    return { candidateUrl: destination.finalUrl ?? destination.candidateUrl, providerIdentity: {
      provider: destination.provider, sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
      tenant: destination.tenant, postingId: destination.expectedPostingId,
    } };
  }
  // Legacy public roles can have confirmed per-occurrence posting identity but
  // no admission snapshot. Reuse that exact identity, never a title/tenant guess.
  const decision = reference.postingIdentityDecision;
  if (decision?.status !== 'confirmed') return undefined;
  try {
    const route = providerPostingReference(reference.applyUrl);
    if (!route.postingId || decision.exactKey !== providerPostingAlias(route)) return undefined;
    return { candidateUrl: reference.applyUrl, providerIdentity: { ...route,
      sourceId: reference.sourceId, sourceUrl: reference.sourceUrl } };
  } catch { return undefined; }
}

function roleMetadataCollectionSnapshot(value: RoleMetadataCollectionCoverage): string {
  const sorted = (items: Record<string, number>) => Object.fromEntries(Object.entries(items).sort(([left], [right]) => left.localeCompare(right)));
  return hash(JSON.stringify({
    extractionVersion: value.extractionVersion,
    eligible: value.eligible,
    current: value.current,
    pendingOrUnobserved: value.pendingOrUnobserved,
    stale: value.stale,
    outcomes: sorted(value.outcomes),
    backfillTokens: sorted(value.backfillTokens),
  }));
}

function repairToken(
  rows: Array<{ jobId: string; original: string; proposed: string }>,
  occurrences: Array<{ sourceId: string; externalId: string; original: string; proposed: string }> = [],
): string {
  const values = [
    ...rows.map((row) => `job\0${row.jobId}\0${hash(row.original)}\0${hash(row.proposed)}`),
    ...occurrences.map((row) => `occurrence\0${row.sourceId}\0${row.externalId}\0${hash(row.original)}\0${hash(row.proposed)}`),
  ];
  return createHash('sha256').update(values.sort().join('\n')).digest('hex');
}

function sourceReferenceKey(reference: SourceOccurrence): string {
  return `${reference.sourceId}\0${reference.externalId ?? ''}`;
}

export function destinationOccurrenceKey(sourceId: string, externalId: string): string {
  return hash(`${sourceId}\0${externalId}`);
}

export function providerIdentityForReference(reference: SourceOccurrence, prior?: CatalogAdmission['destination']): ProviderIdentity {
  let route: ReturnType<typeof providerPostingReference> = { provider: 'unknown' };
  try { route = providerPostingReference(reference.applyUrl); } catch { /* Malformed destinations remain fail-closed candidates. */ }
  const source = /^(greenhouse|lever|ashby)-(.+)$/u.exec(reference.sourceId);
  let queryPostingId: string | undefined;
  try {
    const queryId = new URL(reference.applyUrl).searchParams.get('gh_jid');
    if (queryId && /^\d+$/u.test(queryId)) queryPostingId = queryId;
  } catch { /* Preserve malformed candidate evidence. */ }
  const provider = reference.providerEvidence?.provider
    ?? (route.provider !== 'unknown' ? route.provider : undefined)
    ?? (queryPostingId ? 'greenhouse' : undefined)
    ?? prior?.provider
    ?? source?.[1] as ProviderIdentity['provider'] | undefined
    ?? 'unknown';
  const tenant = reference.providerEvidence?.tenant ?? route.tenant ?? prior?.tenant ?? source?.[2];
  const postingId = reference.providerEvidence?.postingId ?? route.postingId ?? queryPostingId
    ?? (prior?.candidateUrl === reference.applyUrl ? prior.expectedPostingId : undefined)
    ?? reference.externalId;
  const mayUseEmployerScope = reference.provenance !== 'reviewed-community'
    || reference.employerLabelOrigin === 'explicit'
    || reference.employerInheritance === 'same-tenant';
  return {
    provider, sourceId: reference.sourceId, sourceUrl: reference.sourceUrl,
    ...(mayUseEmployerScope ? { employerScope: `employer:${canonicalCompanyKey(reference.company)}` } : {}),
    ...(tenant ? { tenant } : {}),
    ...(postingId ? { postingId } : {}),
  };
}

/** A live queue item may only mutate the occurrence generation that produced it. */
export function destinationVerificationMatchesReference(
  reference: SourceOccurrence,
  request: Pick<ScheduledDestinationVerification, 'candidateUrl' | 'providerIdentity'>,
): boolean {
  if (reference.applyUrl !== request.candidateUrl) return false;
  const current = providerIdentityForReference(reference, reference.admission?.destination);
  const equal = (left: string | undefined, right: string | undefined) => left?.toLowerCase() === right?.toLowerCase();
  return current.sourceId === request.providerIdentity.sourceId
    && current.sourceUrl === request.providerIdentity.sourceUrl
    && (current.provider === 'unknown' || current.provider === request.providerIdentity.provider)
    && (!current.tenant || equal(current.tenant, request.providerIdentity.tenant))
    && (!current.postingId || equal(current.postingId, request.providerIdentity.postingId));
}

function sameProviderIdentity(left: ProviderIdentity, right: ProviderIdentity): boolean {
  return left.provider === right.provider && left.sourceId === right.sourceId && left.sourceUrl === right.sourceUrl
    && left.tenant === right.tenant && left.postingId === right.postingId && left.employerScope === right.employerScope;
}

function occurrenceSnapshotHash(reference: SourceOccurrence): string {
  // Admission is the only repair-owned occurrence field. Excluding it keeps a
  // successful apply rerunnable at zero while every upstream/source field is frozen.
  const sourceOwned = { ...reference };
  delete sourceOwned.admission;
  return hash(JSON.stringify(sourceOwned));
}

function repairedSourceReferences(current: Internship, proposed: SourceOccurrence[] | undefined): SourceOccurrence[] {
  if (!proposed) return current.sourceReferences;
  const currentByKey = new Map(current.sourceReferences.map((reference) => [sourceReferenceKey(reference), reference]));
  if (currentByKey.size !== current.sourceReferences.length || proposed.length !== current.sourceReferences.length) {
    throw new Error('Admission repair cannot add, remove, or duplicate source occurrences');
  }
  for (const reference of proposed) {
    const original = currentByKey.get(sourceReferenceKey(reference));
    if (!original) throw new Error('Admission repair cannot change source occurrence identity');
    for (const field of ['sourceId', 'externalId', 'document', 'sourceUrl', 'row', 'provenance', 'state'] as const) {
      if (reference[field] !== original[field]) throw new Error(`Admission repair cannot change source occurrence ${field}`);
    }
  }
  return proposed;
}

function preserveDurableFields(current: Internship, change: RepairChange): Internship {
  const sourceReferences = repairedSourceReferences(current, change.sourceReferences);
  const repaired: Internship = {
    ...current,
    ...(change.company ? { company: change.company } : {}),
    ...(change.title ? { title: change.title } : {}),
    ...(change.location ? { location: change.location } : {}),
    ...(change.locations ? { locations: change.locations } : {}),
    ...(change.applyUrl ? { applyUrl: change.applyUrl } : {}),
    ...(change.normalizedUrl ? { normalizedUrl: change.normalizedUrl } : {}),
    admission: change.admission,
    // These fields are intentionally restated so a future expansion of the
    // editable set cannot silently reset identity or delivery history.
    jobId: current.jobId,
    firstSeenAt: current.firstSeenAt,
    catalogVisibleAt: current.catalogVisibleAt,
    catalogRecency: current.catalogRecency,
    sourceReferences,
    postingIdentity: current.postingIdentity,
    notification: current.notification,
  };
  if (change.applicationUrlValidatedAt === null) delete repaired.applicationUrlValidatedAt;
  else if (change.applicationUrlValidatedAt) repaired.applicationUrlValidatedAt = change.applicationUrlValidatedAt;
  return repaired;
}

export class D1CatalogAdmissionStore {
  constructor(private readonly db: D1Database) {}

  private async *catalogInternshipPages(limit = 100, openOnly = false): AsyncGenerator<Array<{ pk: string; sk: string; value: string }>> {
    let after = ['', ''];
    while (true) {
      const page = await this.db.prepare(`SELECT pk, sk, value FROM catalog_items
        WHERE kind = 'internship' ${openOnly ? "AND json_extract(value, '$.open') = 1" : ''}
          AND (pk, sk) > (?, ?) ORDER BY pk, sk LIMIT ?`)
        .bind(...after, limit).all<{ pk: string; sk: string; value: string }>();
      if (!page.results.length) return;
      const last = page.results[page.results.length - 1];
      after = [last.pk, last.sk];
      yield page.results;
    }
  }

  private async *currentRoleMetadataEvidencePages(limit = 100): AsyncGenerator<Array<{
    job_id: string; source_class: string; source_id: string; source_url: string; artifact_hash: string; evidence: string;
  }>> {
    let after = ['', '', '', '', ''];
    while (true) {
      const page = await this.db.prepare(`SELECT job_id, source_class, source_id, source_url, artifact_hash, evidence
        FROM role_metadata_evidence WHERE is_current = 1
          AND (job_id, source_class, source_id, source_url, artifact_hash) > (?, ?, ?, ?, ?)
        ORDER BY job_id, source_class, source_id, source_url, artifact_hash LIMIT ?`).bind(...after, limit)
        .all<{ job_id: string; source_class: string; source_id: string; source_url: string; artifact_hash: string; evidence: string }>();
      if (!page.results.length) return;
      const last = page.results[page.results.length - 1];
      after = [last.job_id, last.source_class, last.source_id, last.source_url, last.artifact_hash];
      yield page.results;
    }
  }

  private async roleMetadataCollectionCoverage(
    jobsOrEligible: readonly Internship[] | Set<string>,
    observedAfter: string,
  ): Promise<RoleMetadataCollectionCoverage> {
    const [attempts, evidence] = await Promise.all([
      this.db.prepare(`SELECT job_id, source_id, observed_at, outcome, backfill_token
        FROM role_metadata_extraction_attempts WHERE extraction_version = ?`)
        .bind(ROLE_METADATA_EXTRACTION_VERSION)
        .all<{ job_id: string; source_id: string; observed_at: string; outcome: string; backfill_token: string | null }>(),
      this.db.prepare(`SELECT job_id, source_id, observed_at,
          CASE WHEN coalesce(json_array_length(json_extract(evidence, '$.compensationRanges')), 0) > 0
            OR coalesce(json_array_length(json_extract(evidence, '$.housing')), 0) > 0
            OR coalesce(json_extract(evidence, '$.education'), '') NOT IN ('', 0)
            OR coalesce(json_array_length(json_extract(evidence, '$.locations')), 0) > 0
            OR coalesce(json_extract(evidence, '$.workMode'), '') NOT IN ('', 0)
            OR coalesce(json_extract(evidence, '$.applicationDeadline'), '') NOT IN ('', 0)
            OR coalesce(json_extract(evidence, '$.employerPublishedAt'), '') NOT IN ('', 0)
            OR coalesce(json_extract(evidence, '$.employerUpdatedAt'), '') NOT IN ('', 0)
          THEN 1 ELSE 0 END AS has_fields
        FROM role_metadata_evidence WHERE extraction_version = ? AND is_current = 1
          AND source_class IN ('official-page', 'official-json-ld')`)
        .bind(ROLE_METADATA_EXTRACTION_VERSION)
        .all<{ job_id: string; source_id: string; observed_at: string; has_fields: number }>(),
    ]);
    const latest = new Map<string, { observedAt: string; outcome: string; backfillToken?: string }>();
    const recordLatest = (key: string, value: { observedAt: string; outcome: string; backfillToken?: string }) => {
      const previous = latest.get(key);
      if (!previous || value.observedAt > previous.observedAt) latest.set(key, value);
    };
    for (const item of attempts.results) recordLatest(`${item.job_id}\0${item.source_id}`, {
      observedAt: item.observed_at,
      outcome: item.outcome,
      ...(item.backfill_token ? { backfillToken: item.backfill_token } : {}),
    });
    for (const item of evidence.results) {
      recordLatest(`${item.job_id}\0${item.source_id}`, {
        observedAt: item.observed_at,
        outcome: item.has_fields ? 'extracted' : 'no-explicit-metadata',
      });
    }
    const eligible = new Set<string>();
    if (jobsOrEligible instanceof Set) {
      for (const key of jobsOrEligible) eligible.add(key);
    } else {
      for (const job of jobsOrEligible) {
        if (!job.open) continue;
        for (const reference of job.sourceReferences) {
          if (metadataCollectionTarget(reference)) {
            eligible.add(`${job.jobId}\0${reference.sourceId}`);
          }
        }
      }
    }
    let current = 0; let pendingOrUnobserved = 0; let stale = 0;
    const outcomes: Record<string, number> = {}; const backfillTokens: Record<string, number> = {};
    for (const key of eligible) {
      const observation = latest.get(key);
      if (!observation) { pendingOrUnobserved += 1; continue; }
      outcomes[observation.outcome] = (outcomes[observation.outcome] ?? 0) + 1;
      if (observation.backfillToken) backfillTokens[observation.backfillToken] = (backfillTokens[observation.backfillToken] ?? 0) + 1;
      if (observation.observedAt <= observedAfter) stale += 1;
      else current += 1;
    }
    return {
      extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
      eligible: eligible.size,
      current,
      pendingOrUnobserved,
      stale,
      complete: pendingOrUnobserved === 0 && stale === 0,
      outcomes,
      backfillTokens,
    };
  }

  async recordRoleMetadataEvidence(
    jobId: string,
    evidence: readonly RoleMetadataEvidence[],
    conflicts: readonly MetadataConflict[],
    recordedAt: string,
    replace?: { sourceId: string; sourceClasses: readonly EvidenceSource[] },
  ): Promise<void> {
    const statements = [];
    if (replace?.sourceClasses.length) {
      statements.push(this.db.prepare(`UPDATE role_metadata_evidence SET is_current = 0
        WHERE job_id = ? AND source_id = ? AND source_class IN (${replace.sourceClasses.map(() => '?').join(', ')}) AND is_current = 1`)
        .bind(jobId, replace.sourceId, ...replace.sourceClasses));
    }
    for (const item of evidence) {
      statements.push(this.db.prepare(`UPDATE role_metadata_evidence SET is_current = 0
        WHERE job_id = ? AND source_class = ? AND source_id = ? AND artifact_hash <> ? AND is_current = 1`)
        .bind(jobId, item.sourceClass, item.sourceId, item.artifactHash));
      statements.push(this.db.prepare(`INSERT INTO role_metadata_evidence
        (job_id, source_class, source_id, source_url, artifact_hash, extraction_version, evidence, observed_at, is_current)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(job_id, source_class, source_id, source_url, artifact_hash) DO UPDATE SET
          extraction_version=excluded.extraction_version, evidence=excluded.evidence,
          observed_at=excluded.observed_at, is_current=1`)
        .bind(jobId, item.sourceClass, item.sourceId, item.sourceUrl, item.artifactHash,
          item.extractionVersion, JSON.stringify(item), item.observedAt));
    }
    statements.push(this.db.prepare("UPDATE role_metadata_conflicts SET state = 'resolved', updated_at = ? WHERE job_id = ? AND state = 'open'")
      .bind(recordedAt, jobId));
    for (const conflict of conflicts) {
      const id = createHash('sha256').update(`${jobId}\0${conflict.field}\0${conflict.applicabilityKey ?? ''}\0${JSON.stringify(conflict.values)}`).digest('hex');
      statements.push(this.db.prepare(`INSERT INTO role_metadata_conflicts
        (id, job_id, field, applicability_key, evidence_hashes, values_json, state, opened_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
        ON CONFLICT(id) DO UPDATE SET evidence_hashes=excluded.evidence_hashes,
          values_json=excluded.values_json, state='open', updated_at=excluded.updated_at`)
        .bind(id, jobId, conflict.field, conflict.applicabilityKey ?? null, JSON.stringify(conflict.evidenceHashes),
          JSON.stringify(conflict.values), recordedAt, recordedAt));
    }
    try {
      for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    } catch (error) {
      // Destination verification messages already in flight remain compatible
      // during the migration-before-deploy rollout window.
      if (!roleMetadataSchemaMissing(error)) throw error;
    }
  }

  async recordRoleMetadataExtraction(value: {
    jobId: string; sourceId: string; sourceUrl: string; artifactHash: string; extractionVersion: number;
    outcome: 'extracted' | 'no-explicit-metadata'; observedAt: string; backfillToken?: string;
  }): Promise<void> {
    const id = createHash('sha256').update(`${value.jobId}\0${value.sourceId}\0${value.artifactHash}\0${value.extractionVersion}`).digest('hex');
    try {
      await this.db.prepare(`INSERT INTO role_metadata_extraction_attempts
        (id, job_id, source_id, source_url, artifact_hash, extraction_version, outcome, observed_at, backfill_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome, observed_at=excluded.observed_at,
          backfill_token=coalesce(excluded.backfill_token, role_metadata_extraction_attempts.backfill_token)`)
        .bind(id, value.jobId, value.sourceId, value.sourceUrl, value.artifactHash, value.extractionVersion,
          value.outcome, value.observedAt, value.backfillToken ?? null).run();
    } catch (error) {
      if (!roleMetadataSchemaMissing(error)) throw error;
    }
  }

  async roleMetadataAudit(now = new Date()): Promise<{
    scanned: number;
    enriched: number;
    projectionOnlyOmissions: Array<{ jobId: string; fields: string[] }>;
    deferredProjections: Array<{ jobId: string; evidenceHashes: string[] }>;
    supportedRoleSpecificDisclosedMetadataMisses: null;
    currentEvidenceBySourceClass: Record<string, number>;
    unsupportedCurrencies: Record<string, number>;
    unsupportedPeriods: Record<string, number>;
    openConflicts: number;
    verificationOutcomes: Record<string, number>;
    collectionCoverage: RoleMetadataCollectionCoverage;
    fieldOutcomes: Record<string, Record<string, number>>;
    fieldOutcomeDenominator: { unit: 'source-occurrence'; count: number; scope: 'all-stored-roles' };
    acquisitionReports: Array<{ jobId: string; sourceId: string; report: unknown }>;
    disclosureRecall: null;
  }> {
    const acquisitionReports: Array<{ jobId: string; sourceId: string; report: unknown }> = [];
    const byReference = new Map<string, Record<string, unknown>>();
    let reportAfter = ['', ''];
    while (true) {
      const reports = await this.db.prepare(`SELECT job_id, source_id, report FROM role_metadata_acquisition
        WHERE report IS NOT NULL AND (job_id, source_id) > (?, ?) ORDER BY job_id, source_id LIMIT 100`)
        .bind(...reportAfter).all<{ job_id: string; source_id: string; report: string }>();
      if (!reports.results.length) break;
      for (const row of reports.results) {
        reportAfter = [row.job_id, row.source_id];
        const report = JSON.parse(row.report) as Record<string, unknown>;
        acquisitionReports.push({ jobId: row.job_id, sourceId: row.source_id, report });
        byReference.set(`${row.job_id}\0${row.source_id}`, report);
      }
    }
    const projectionOnlyOmissions: Array<{ jobId: string; fields: string[] }> = [];
    const deferredProjections: Array<{ jobId: string; evidenceHashes: string[] }> = [];
    const eligibleTargets = new Set<string>();
    const fieldOutcomes: Record<string, Record<string, number>> = {};
    let scanned = 0; let enriched = 0; let sourceOccurrenceCount = 0;
    for await (const page of this.catalogInternshipPages()) {
      const jobs = page.map((row) => JSON.parse(row.value) as Internship);
      const placeholders = jobs.map(() => '?').join(', ');
      const current = await this.db.prepare(`SELECT job_id, evidence FROM role_metadata_evidence
        WHERE is_current = 1 AND job_id IN (${placeholders})`).bind(...jobs.map((job) => job.jobId))
        .all<{ job_id: string; evidence: string }>();
      const evidenceByJob = new Map<string, RoleMetadataEvidence[]>();
      for (const row of current.results) evidenceByJob.set(row.job_id,
        [...(evidenceByJob.get(row.job_id) ?? []), JSON.parse(row.evidence) as RoleMetadataEvidence]);
      for (const job of jobs) {
        scanned += 1; if (job.roleMetadata) enriched += 1;
        const historical = evidenceByJob.get(job.jobId) ?? [];
        const sourceReferences = job.sourceReferences.map((reference) => {
          const matching = historical.filter((item) => item.sourceId === reference.sourceId);
          return { ...reference, metadataEvidence: replaceVerifiedPageMetadataEvidence(reference.metadataEvidence, matching, reference.sourceId) };
        });
        const result = projectRoleMetadata({ ...job, sourceReferences });
        if (result.deferredEvidenceHashes?.length) deferredProjections.push({ jobId: job.jobId, evidenceHashes: result.deferredEvidenceHashes });
        const projected = result.job;
        const fields = ['compensation', 'housing', 'programType', 'workMode', 'applicationDeadline', 'graduationWindow', 'locations', 'employerPublishedAt', 'employerUpdatedAt']
          .filter((field) => JSON.stringify(projected[field as keyof Internship]) !== JSON.stringify(job[field as keyof Internship]));
        if (fields.length) projectionOnlyOmissions.push({ jobId: job.jobId, fields });
        const missing = new Set(fields);
        for (const reference of job.sourceReferences) {
          sourceOccurrenceCount += 1;
          if (job.open && metadataCollectionTarget(reference)) eligibleTargets.add(`${job.jobId}\0${reference.sourceId}`);
          const report = byReference.get(`${job.jobId}\0${reference.sourceId}`);
          const reportedFields = report?.fields as Record<string, string> | undefined;
          for (const field of ['compensation', 'housing', 'education', 'graduation-window', 'locations', 'work-mode', 'application-deadline', 'employer-published-at', 'employer-updated-at']) {
            const key = `${reference.admission?.destination.provider ?? 'unknown'}/${String(report?.method ?? 'unobserved')}/${field}`;
            const counts = fieldOutcomes[key] ?? {};
            const projectionField = ({ 'graduation-window': 'graduationWindow', 'work-mode': 'workMode', 'application-deadline': 'applicationDeadline',
              'employer-published-at': 'employerPublishedAt', 'employer-updated-at': 'employerUpdatedAt' } as Record<string, string>)[field] ?? field;
            const outcome = reportedFields?.[field] === 'extracted' && missing.has(projectionField)
              ? 'projection-missing' : reportedFields?.[field] ?? 'inspection-pending';
            counts[outcome] = (counts[outcome] ?? 0) + 1; fieldOutcomes[key] = counts;
          }
        }
      }
    }
    const currentEvidenceBySourceClass: Record<string, number> = {};
    const unsupportedCurrencies: Record<string, number> = {};
    const unsupportedPeriods: Record<string, number> = {};
    for await (const current of this.currentRoleMetadataEvidencePages()) {
      for (const row of current) {
        currentEvidenceBySourceClass[row.source_class] = (currentEvidenceBySourceClass[row.source_class] ?? 0) + 1;
        const parsed = JSON.parse(row.evidence) as RoleMetadataEvidence;
        for (const currency of unsupportedMetadataCurrencies([parsed])) unsupportedCurrencies[currency] = (unsupportedCurrencies[currency] ?? 0) + 1;
        for (const period of unsupportedMetadataPeriods([parsed])) unsupportedPeriods[period] = (unsupportedPeriods[period] ?? 0) + 1;
      }
    }
    const conflicts = await this.db.prepare("SELECT count(*) AS count FROM role_metadata_conflicts WHERE state = 'open'").first<{ count: number }>();
    const outcomes = await this.db.prepare(`SELECT coalesce(classification, state) AS outcome, count(*) AS count
      FROM destination_verification_attempts GROUP BY coalesce(classification, state)`).all<{ outcome: string; count: number }>();
    const collectionCoverage = await this.roleMetadataCollectionCoverage(
      eligibleTargets,
      new Date(now.getTime() - ROLE_METADATA_REVALIDATION_MS).toISOString(),
    );
    return {
      scanned,
      enriched,
      projectionOnlyOmissions,
      deferredProjections,
      supportedRoleSpecificDisclosedMetadataMisses: null,
      currentEvidenceBySourceClass,
      unsupportedCurrencies,
      unsupportedPeriods,
      openConflicts: Number(conflicts?.count ?? 0),
      verificationOutcomes: Object.fromEntries(outcomes.results.map((row) => [row.outcome, Number(row.count)])),
      collectionCoverage,
      fieldOutcomes,
      fieldOutcomeDenominator: { unit: 'source-occurrence', count: sourceOccurrenceCount, scope: 'all-stored-roles' },
      acquisitionReports,
      // A projection delta is not an independently measured extraction recall.
      disclosureRecall: null,
    };
  }

  async metadataVerificationCandidates(limit = 100, options: {
    observedBefore?: string;
    includeUnobserved?: boolean;
    requireProjectedEvidence?: boolean;
    after?: string;
    reserveAt?: string;
  } = {}): Promise<Array<{
    jobId: string; sourceId: string; externalId: string; candidateUrl: string; providerIdentity: ProviderIdentity;
    metadataArtifactHash?: string;
  }>> {
    const [attempts, evidence, reservations] = await Promise.all([
      this.db.prepare(`SELECT job_id, source_id, observed_at, artifact_hash
        FROM role_metadata_extraction_attempts WHERE extraction_version = ?`)
        .bind(ROLE_METADATA_EXTRACTION_VERSION)
        .all<{ job_id: string; source_id: string; observed_at: string; artifact_hash: string }>(),
      this.db.prepare(`SELECT job_id, source_id, observed_at, artifact_hash
        FROM role_metadata_evidence WHERE extraction_version = ? AND is_current = 1
          AND source_class IN ('official-page', 'official-json-ld')`)
        .bind(ROLE_METADATA_EXTRACTION_VERSION)
        .all<{ job_id: string; source_id: string; observed_at: string; artifact_hash: string }>(),
      this.db.prepare("SELECT job_id, source_id, lease_until, retry_after, json_extract(report, '$.extractionVersion') AS version FROM role_metadata_acquisition")
        .all<{ job_id: string; source_id: string; lease_until: string; retry_after: string; version: number | null }>(),
    ]);
    const now = options.reserveAt ?? new Date().toISOString();
    const unavailable = new Set(reservations.results.filter((item) => item.lease_until > now
      || (item.retry_after > now && (item.version === null || item.version >= ROLE_METADATA_EXTRACTION_VERSION)))
      .map((item) => `${item.job_id}\0${item.source_id}`));
    const latest = new Map<string, { observedAt: string; artifactHash: string }>();
    for (const item of [...attempts.results, ...evidence.results]) {
      const key = `${item.job_id}\0${item.source_id}`;
      const previous = latest.get(key);
      if (!previous || item.observed_at > previous.observedAt) latest.set(key, { observedAt: item.observed_at, artifactHash: item.artifact_hash });
    }
    const candidates: Array<{ jobId: string; sourceId: string; externalId: string; candidateUrl: string;
      providerIdentity: ProviderIdentity; metadataArtifactHash?: string }> = [];
    // Match collectionCoverage's open-role cohort, including withheld roles.
    // Metadata collection must not require or grant catalog admission.
    for await (const page of this.catalogInternshipPages(100, true)) {
      for (const row of page) {
        const job = JSON.parse(row.value) as Internship;
        for (const reference of job.sourceReferences) {
          const key = `${job.jobId}\0${reference.sourceId}`;
          if (unavailable.has(key) || (options.after && key <= options.after)) continue;
          const target = metadataCollectionTarget(reference);
          if (!target || !reference.externalId) continue;
          const current = reference.metadataEvidence?.some((item) => ['official-page', 'official-json-ld'].includes(item.sourceClass)
            && item.extractionVersion === ROLE_METADATA_EXTRACTION_VERSION) === true;
          if (options.requireProjectedEvidence && !current) continue;
          const observation = latest.get(key);
          if (!observation && options.includeUnobserved === false) continue;
          if (observation && (!options.observedBefore || observation.observedAt > options.observedBefore)) continue;
          candidates.push({
            jobId: job.jobId, sourceId: reference.sourceId, externalId: reference.externalId,
            ...target,
            ...(observation ? { metadataArtifactHash: observation.artifactHash } : {}),
          });
        }
      }
    }
    // Lexicographic cursors support manual resumption. Automated batches
    // interleave hosts so a large board cannot monopolize each run.
    candidates.sort((a, b) => {
      const left = `${a.jobId}\0${a.sourceId}`; const right = `${b.jobId}\0${b.sourceId}`;
      if (options.after === undefined) {
        const first = latest.get(left)?.observedAt ?? '';
        const second = latest.get(right)?.observedAt ?? '';
        if (first !== second) return first < second ? -1 : 1;
      }
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const ordered = options.after !== undefined ? candidates : (() => {
      const hosts = new Map<string, typeof candidates>();
      for (const item of candidates) {
        let host: string;
        try { host = new URL(item.candidateUrl).hostname; } catch { continue; }
        const group = hosts.get(host) ?? []; group.push(item); hosts.set(host, group);
      }
      const result: typeof candidates = [];
      while ([...hosts.values()].some((group) => group.length)) for (const group of hosts.values()) {
        const item = group.shift(); if (item) result.push(item);
      }
      return result;
    })();
    const selected: typeof candidates = [];
    for (const candidate of ordered) {
      if (selected.length >= limit) break;
      if (options.reserveAt) {
        const lease = new Date(Date.parse(options.reserveAt) + 30 * 60_000).toISOString();
        const reserved = await this.db.prepare(`INSERT INTO role_metadata_acquisition(job_id, source_id, lease_until)
          VALUES (?, ?, ?) ON CONFLICT(job_id, source_id) DO UPDATE SET lease_until=excluded.lease_until
          WHERE role_metadata_acquisition.lease_until <= ? AND (role_metadata_acquisition.retry_after <= ?
            OR coalesce(json_extract(role_metadata_acquisition.report, '$.extractionVersion'), ?) < ?)`)
          .bind(candidate.jobId, candidate.sourceId, lease, options.reserveAt, options.reserveAt,
            ROLE_METADATA_EXTRACTION_VERSION, ROLE_METADATA_EXTRACTION_VERSION).run();
        if (reserved.meta?.changes !== 1) continue;
      }
      selected.push(candidate);
    }
    return selected;
  }

  async recordMetadataAcquisition(jobId: string, sourceId: string, observedAt: string, report: Record<string, unknown>, retryAfter: string): Promise<void> {
    await this.db.prepare(`INSERT INTO role_metadata_acquisition(job_id, source_id, lease_until, retry_after, observed_at, report)
      VALUES (?, ?, '', ?, ?, ?) ON CONFLICT(job_id, source_id) DO UPDATE SET
      lease_until='', retry_after=excluded.retry_after, observed_at=excluded.observed_at, report=excluded.report`)
      .bind(jobId, sourceId, retryAfter, observedAt, JSON.stringify(report)).run();
  }

  async recordShadowExtractionHandoff(jobId: string, sourceId: string, acquisitionObservedAt: string, input: {
    outcome: 'enqueued' | 'skipped-no-text' | 'skipped-no-binding' | 'skipped-oversized' | 'failed';
    method: string;
    descriptionBytes: number;
    observedAt: string;
  }): Promise<void> {
    await this.db.prepare(`UPDATE role_metadata_acquisition SET report = json_set(report,
      '$.shadowHandoff.outcome', ?, '$.shadowHandoff.method', ?, '$.shadowHandoff.descriptionBytes', ?,
      '$.shadowHandoff.observedAt', ?)
      WHERE job_id = ? AND source_id = ? AND observed_at = ?`)
      .bind(input.outcome, input.method, input.descriptionBytes, input.observedAt,
        jobId, sourceId, acquisitionObservedAt).run();
  }

  async metadataHostAvailable(host: string, now = new Date().toISOString()): Promise<boolean> {
    const row = await this.db.prepare('SELECT retry_after FROM role_metadata_api_backoff WHERE host = ?').bind(host).first<{ retry_after: string }>();
    return !row || row.retry_after <= now;
  }

  async deferMetadataHost(host: string, retryAfter: string): Promise<void> {
    await this.db.prepare(`INSERT INTO role_metadata_api_backoff(host, retry_after) VALUES (?, ?)
      ON CONFLICT(host) DO UPDATE SET retry_after=max(role_metadata_api_backoff.retry_after, excluded.retry_after)`)
      .bind(host, retryAfter).run();
  }

  private async metadataRevision(): Promise<number> {
    const row = await this.db.prepare('SELECT revision FROM role_metadata_revision WHERE id = 1').first<{ revision: number }>();
    if (!row) throw new Error('Metadata review migration is required');
    return Number(row.revision);
  }

  private async metadataReviewSubject(jobId: string) {
    const row = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'META' AND kind = 'internship'")
      .bind(`JOB#${jobId}`).first<JsonRow>();
    if (!row) throw new Error('Role not found');
    const historical = await this.db.prepare('SELECT evidence FROM role_metadata_evidence WHERE job_id = ? AND is_current = 1')
      .bind(jobId).all<{ evidence: string }>();
    const job = JSON.parse(row.value) as Internship;
    const all = historical.results.map(item => JSON.parse(item.evidence) as RoleMetadataEvidence);
    const evidence = job.sourceReferences.flatMap(reference => replaceVerifiedPageMetadataEvidence(reference.metadataEvidence,
      all.filter(item => item.sourceId === reference.sourceId), reference.sourceId));
    return { original: row.value, job, evidence };
  }

  private async metadataJobRevision(jobId: string): Promise<number> {
    const row = await this.db.prepare('SELECT revision FROM role_metadata_job_revision WHERE job_id = ?')
      .bind(jobId).first<{ revision: number }>();
    return Number(row?.revision ?? 0);
  }

  async stageRoleMetadataOmission(jobId: string, createdAt: string) {
    const revision = await this.metadataJobRevision(jobId);
    const subject = await this.metadataReviewSubject(jobId);
    const conflicts = reconcileRoleMetadata(subject.evidence, subject.job).conflicts.filter(item => item.field === 'compensation');
    if (!conflicts.length) throw new Error('Only currently conflicting compensation may be reviewed for omission');
    const evidenceFingerprint = roleMetadataReviewFingerprint(subject.evidence);
    const decision = { field: 'compensation' as const, action: 'omit' as const, reason: 'publisher-inconsistent' as const, evidenceFingerprint };
    const reviewToken = hash(`posting-review-v2\0${jobId}\0${subject.original}\0${JSON.stringify(decision)}\0${revision}`);
    if (await this.metadataJobRevision(jobId) !== revision) throw new Error('Posting metadata changed during review; preview again');
    const receipt: RoleMetadataOmission = { ...decision, reviewToken };
    await this.db.prepare(`INSERT INTO role_metadata_review_plans
      (token, job_id, original_value, decision, metadata_revision, job_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO NOTHING`).bind(reviewToken, jobId, subject.original, JSON.stringify(receipt), await this.metadataRevision(), revision, createdAt).run();
    return { reviewToken, expectedDecisions: 1, jobId, company: subject.job.company, title: subject.job.title,
      decision: receipt, conflicts, publicJobsChanged: 0, requiresSeparateRepairApproval: true };
  }

  async approveRoleMetadataOmission(token: string, expectedDecisions: number, approvedAt: string) {
    if (expectedDecisions !== 1) throw new Error('expectedDecisions must match the review preview exactly');
    const plan = await this.db.prepare('SELECT * FROM role_metadata_review_plans WHERE token = ?').bind(token)
      .first<{ job_id: string; original_value: string; decision: string; job_revision: number; approved_at: string | null }>();
    if (!plan || plan.approved_at) throw new Error('Review plan is missing or already approved; preview again');
    const guard = this.db.prepare(`INSERT INTO role_metadata_review_guards(token, ok, approved_at)
      SELECT ?, CASE WHEN coalesce((SELECT revision FROM role_metadata_job_revision WHERE job_id = ?), 0) = ?
        AND EXISTS (SELECT 1 FROM catalog_items WHERE pk = ? AND sk = 'META' AND kind = 'internship' AND value = ?)
        AND EXISTS (SELECT 1 FROM role_metadata_review_plans WHERE token = ? AND approved_at IS NULL)
      THEN 1 ELSE 0 END, ?`).bind(token, plan.job_id, plan.job_revision, `JOB#${plan.job_id}`, plan.original_value, token, approvedAt);
    await this.db.batch([guard,
      this.db.prepare(`INSERT INTO role_metadata_review_decisions(job_id, token, decision, approved_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET token=excluded.token, decision=excluded.decision, approved_at=excluded.approved_at`)
        .bind(plan.job_id, token, plan.decision, approvedAt),
      this.db.prepare('UPDATE role_metadata_review_plans SET approved_at = ? WHERE token = ?').bind(approvedAt, token),
    ]);
    return { approvedDecisions: 1, publicJobsChanged: 0, requiresSeparateRepairApproval: true };
  }

  async stageRoleMetadataRepair(createdAt: string): Promise<{
    repairToken: string;
    expectedJobs: number;
    remainingJobs: number;
    expectedOccurrences: 0;
    fillsByField: Record<string, number>;
    correctionsByField: Record<string, number>;
    changesBySourceClass: Record<string, number>;
    conflicts: MetadataConflict[];
    unsupportedCurrencies: Record<string, number>;
    unsupportedPeriods: Record<string, number>;
    reviewedOmissions: Array<{ jobId: string; reviewToken: string }>;
  }> {
    const revision = await this.metadataRevision();
    const reviewRows = await this.db.prepare('SELECT job_id, decision FROM role_metadata_review_decisions')
      .all<{ job_id: string; decision: string }>();
    const reviews = new Map(reviewRows.results.map(row => [row.job_id, JSON.parse(row.decision) as RoleMetadataOmission]));
    const reviewedOmissions: Array<{ jobId: string; reviewToken: string }> = [];
    const staged: Array<{ jobId: string; original: string; proposed: string }> = [];
    let remainingJobs = 0; let stagedBytes = 0; let stagingFull = false;
    const fillsByField: Record<string, number> = {}; const correctionsByField: Record<string, number> = {};
    const changesBySourceClass: Record<string, number> = {}; const unsupportedCurrencies: Record<string, number> = {};
    const unsupportedPeriods: Record<string, number> = {};
    const conflicts: MetadataConflict[] = [];
    const evidenceDigests: string[] = [];
    let statisticsJobId: string | undefined; let statisticsEvidence: RoleMetadataEvidence[] = [];
    const recordEvidenceStatistics = (evidence: RoleMetadataEvidence[]) => {
      for (const currency of unsupportedMetadataCurrencies(evidence)) {
        unsupportedCurrencies[currency] = (unsupportedCurrencies[currency] ?? 0) + 1;
      }
      for (const period of unsupportedMetadataPeriods(evidence)) {
        unsupportedPeriods[period] = (unsupportedPeriods[period] ?? 0) + 1;
      }
    };
    for await (const page of this.currentRoleMetadataEvidencePages()) {
      for (const row of page) {
        evidenceDigests.push(roleMetadataEvidenceDigest(row));
        if (statisticsJobId !== undefined && row.job_id !== statisticsJobId) {
          recordEvidenceStatistics(statisticsEvidence); statisticsEvidence = [];
        }
        statisticsJobId = row.job_id;
        statisticsEvidence.push(JSON.parse(row.evidence) as RoleMetadataEvidence);
      }
    }
    if (statisticsEvidence.length) recordEvidenceStatistics(statisticsEvidence);
    const fields: Array<keyof Internship> = ['compensation', 'housing', 'programType', 'workMode', 'applicationDeadline', 'graduationWindow', 'locations', 'employerPublishedAt', 'employerUpdatedAt'];
    const eligibleTargets = new Set<string>();
    for await (const page of this.catalogInternshipPages()) {
      const jobs = page.map(row => JSON.parse(row.value) as Internship);
      for (const job of jobs) if (job.open) for (const reference of job.sourceReferences) {
        if (metadataCollectionTarget(reference)) eligibleTargets.add(`${job.jobId}\0${reference.sourceId}`);
      }
      const placeholders = jobs.map(() => '?').join(', ');
      const current = await this.db.prepare(`SELECT job_id, evidence FROM role_metadata_evidence
        WHERE is_current = 1 AND job_id IN (${placeholders}) ORDER BY job_id, source_class`)
        .bind(...jobs.map(job => job.jobId)).all<{ job_id: string; evidence: string }>();
      const evidenceByJob = new Map<string, RoleMetadataEvidence[]>();
      for (const item of current.results) evidenceByJob.set(item.job_id,
        [...(evidenceByJob.get(item.job_id) ?? []), JSON.parse(item.evidence) as RoleMetadataEvidence]);
      for (let index = 0; index < jobs.length; index += 1) {
        const job = jobs[index]; const row = page[index];
        const historical = evidenceByJob.get(job.jobId) ?? [];
        if (!historical.length) continue;
        const sourceReferences = job.sourceReferences.map((reference) => {
          const matching = historical.filter((item) => item.sourceId === reference.sourceId);
          return { ...reference, metadataEvidence: replaceVerifiedPageMetadataEvidence(reference.metadataEvidence, matching, reference.sourceId) };
        });
        const evidence = sourceReferences.flatMap(reference => reference.metadataEvidence ?? []);
        const review = reviews.get(job.jobId);
        const validReview = review && review.evidenceFingerprint === roleMetadataReviewFingerprint(evidence) ? review : undefined;
        if (validReview) reviewedOmissions.push({ jobId: job.jobId, reviewToken: validReview.reviewToken });
        const result = projectRoleMetadata({ ...job, sourceReferences, metadataOmission: validReview });
        conflicts.push(...result.conflicts);
        const proposed = JSON.stringify(result.job);
        if (result.conflicts.length || proposed === row.value) continue;
        const jobBytes = utf8Bytes(row.value) + utf8Bytes(proposed);
        if (!staged.length && jobBytes > ATOMIC_REPAIR_BYTE_LIMIT) {
          throw new Error(`Role metadata repair job ${job.jobId} exceeds the atomic byte limit of ${ATOMIC_REPAIR_BYTE_LIMIT}`);
        }
        // Keep a contiguous stable prefix. Continue inspecting the full cohort
        // so conflicts outside the bounded transaction still block it.
        if (stagingFull || staged.length >= METADATA_REPAIR_RECORD_LIMIT || stagedBytes + jobBytes > ATOMIC_REPAIR_BYTE_LIMIT) {
          stagingFull = true; remainingJobs += 1; continue;
        }
        for (const field of fields) if (JSON.stringify(result.job[field]) !== JSON.stringify(job[field])) {
          const target = job[field] === undefined || field === 'compensation' && !job.compensation.raw ? fillsByField : correctionsByField;
          target[field] = (target[field] ?? 0) + 1;
        }
        for (const sourceClass of new Set(historical.map((item) => item.sourceClass))) changesBySourceClass[sourceClass] = (changesBySourceClass[sourceClass] ?? 0) + 1;
        staged.push({ jobId: job.jobId, original: row.value, proposed }); stagedBytes += jobBytes;
      }
    }
    const evidenceSnapshot = roleMetadataEvidenceSnapshot(evidenceDigests);
    const collectionCoverage = await this.roleMetadataCollectionCoverage(
      eligibleTargets,
      new Date(Date.parse(createdAt) - ROLE_METADATA_REVALIDATION_MS).toISOString(),
    );
    const collectionSnapshot = roleMetadataCollectionSnapshot(collectionCoverage);
    const conflictSnapshot = conflicts.map((conflict) => JSON.stringify(conflict)).sort().join('\n');
    const repairToken = createHash('sha256').update([
      ...staged.map((item) => `${item.jobId}\0${hash(item.original)}\0${hash(item.proposed)}`),
      `evidence\0${evidenceSnapshot}`,
      `collection\0${collectionSnapshot}`,
      `conflicts\0${hash(conflictSnapshot)}`,
      `revision\0${revision}`,
    ].sort().join('\n')).digest('hex');
    if (await this.metadataRevision() !== revision) throw new Error('Metadata changed during the dry-run; run it again');
    const statements = staged.map((item) => this.db.prepare(`INSERT INTO role_metadata_repair_stage
      (token, job_id, original_value, proposed_value, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token, job_id) DO UPDATE SET original_value=excluded.original_value,
        proposed_value=excluded.proposed_value, created_at=excluded.created_at`)
      .bind(repairToken, item.jobId, item.original, item.proposed, createdAt));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    const reviewed = reviewedOmissions.map(item => this.db.prepare(`INSERT INTO role_metadata_repair_review_stage(token, job_id, decision_token)
      VALUES (?, ?, ?) ON CONFLICT(token, job_id) DO NOTHING`).bind(repairToken, item.jobId, item.reviewToken));
    for (let offset = 0; offset < reviewed.length; offset += 50) await this.db.batch(reviewed.slice(offset, offset + 50));
    await this.db.prepare(`INSERT INTO role_metadata_repair_plans
      (token, expected_jobs, expected_occurrences, conflict_count, evidence_snapshot, collection_snapshot, collection_complete, created_at, metadata_revision)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET expected_jobs=excluded.expected_jobs,
        expected_occurrences=excluded.expected_occurrences, conflict_count=excluded.conflict_count,
        evidence_snapshot=excluded.evidence_snapshot, collection_snapshot=excluded.collection_snapshot,
        collection_complete=excluded.collection_complete, created_at=excluded.created_at, metadata_revision=excluded.metadata_revision`)
      .bind(repairToken, staged.length, conflicts.length, evidenceSnapshot, collectionSnapshot,
        collectionCoverage.complete ? 1 : 0, createdAt, revision).run();
    return { repairToken, expectedJobs: staged.length, remainingJobs, expectedOccurrences: 0, fillsByField, correctionsByField,
      changesBySourceClass, conflicts, unsupportedCurrencies, unsupportedPeriods, reviewedOmissions };
  }

  async applyRoleMetadataRepair(token: string, expectedJobs: number, expectedOccurrences: number, appliedAt: string): Promise<{
    changed: number; occurrencesChanged: 0; projectionRefreshRequired: boolean;
  }> {
    if (expectedOccurrences !== 0) throw new Error('Role metadata repair does not rewrite source occurrences');
    const plan = await this.db.prepare(`SELECT expected_jobs, expected_occurrences, conflict_count, evidence_snapshot,
        collection_snapshot, collection_complete, metadata_revision
      FROM role_metadata_repair_plans WHERE token = ?`).bind(token)
      .first<{ expected_jobs: number; expected_occurrences: number; conflict_count: number; evidence_snapshot: string;
        collection_snapshot: string; collection_complete: number; metadata_revision: number }>();
    if (!plan || Number(plan.expected_jobs) !== expectedJobs || Number(plan.expected_occurrences) !== expectedOccurrences) {
      throw new Error('Role metadata repair plan changed; run the dry-run again');
    }
    const stagedSize = await this.db.prepare(`SELECT count(*) AS count,
        coalesce(sum(length(CAST(original_value AS BLOB)) + length(CAST(proposed_value AS BLOB))), 0) AS bytes
      FROM role_metadata_repair_stage WHERE token = ?`).bind(token).first<{ count: number; bytes: number }>();
    if (Number(stagedSize?.bytes ?? 0) > ATOMIC_REPAIR_BYTE_LIMIT) {
      throw new Error(`Role metadata repair exceeds the atomic byte limit of ${ATOMIC_REPAIR_BYTE_LIMIT}; run the dry-run again`);
    }
    if (Number(stagedSize?.count ?? 0) !== expectedJobs) throw new Error('Role metadata repair count changed; run the dry-run again');
    if (expectedJobs > METADATA_REPAIR_RECORD_LIMIT) {
      throw new Error(`Role metadata repair exceeds the guarded metadata limit of ${METADATA_REPAIR_RECORD_LIMIT} records; run the dry-run again`);
    }
    const rows = await this.db.prepare('SELECT * FROM role_metadata_repair_stage WHERE token = ? ORDER BY job_id').bind(token)
      .all<{ job_id: string; original_value: string; proposed_value: string }>();
    if (Number(plan.conflict_count) > 0) throw new Error('Role metadata conflicts must be resolved before apply');
    if (Number(plan.collection_complete) !== 1) throw new Error('Role metadata collection was incomplete during the dry-run; collect and run the dry-run again');
    const audit = await this.roleMetadataAudit(new Date(appliedAt));
    if (audit.deferredProjections.length) throw new Error('Accepted metadata is awaiting source re-extraction; refresh deferred sources and run the dry-run again');
    const collection = audit.collectionCoverage;
    if (!collection.complete || roleMetadataCollectionSnapshot(collection) !== plan.collection_snapshot) {
      throw new Error('Role metadata collection changed or is incomplete; collect and run the dry-run again');
    }
    const evidenceDigests: string[] = [];
    for await (const page of this.currentRoleMetadataEvidencePages()) {
      for (const row of page) evidenceDigests.push(roleMetadataEvidenceDigest(row));
    }
    if (roleMetadataEvidenceSnapshot(evidenceDigests) !== plan.evidence_snapshot) {
      throw new Error('Role metadata evidence changed; run the dry-run again');
    }
    if (rows.results.length !== expectedJobs) throw new Error('Role metadata repair count changed; run the dry-run again');
    if (await this.metadataRevision() !== Number(plan.metadata_revision)) throw new Error('Metadata or reviews changed; run the dry-run again');
    // The only exception is an exact, approved field omission validated over
    // the full cohort during this plan. Unrelated jobs/fields still block all batches.
    const unreviewedConflictSql = `SELECT 1 FROM role_metadata_conflicts AS conflict WHERE state = 'open'
      AND NOT (field = 'compensation' AND EXISTS (
        SELECT 1 FROM role_metadata_repair_review_stage AS reviewed
        JOIN role_metadata_review_decisions AS decision ON decision.job_id = reviewed.job_id AND decision.token = reviewed.decision_token
        WHERE reviewed.token = ? AND reviewed.job_id = conflict.job_id))`;
    const conflicts = await this.db.prepare(`SELECT count(*) AS count FROM (${unreviewedConflictSql})`).bind(token).first<{ count: number }>();
    if (Number(conflicts?.count ?? 0) > 0) throw new Error('Role metadata conflicts must be resolved before apply');
    const guard = this.db.prepare(`INSERT INTO role_metadata_repair_guards (token, ok, applied_at)
      SELECT ?, CASE WHEN (SELECT count(*) FROM role_metadata_repair_stage WHERE token = ?) = ?
        AND (SELECT revision FROM role_metadata_revision WHERE id = 1) = ?
        AND NOT EXISTS (${unreviewedConflictSql})
        AND EXISTS (SELECT 1 FROM role_metadata_repair_plans WHERE token = ? AND conflict_count = 0
          AND expected_jobs = ? AND expected_occurrences = ? AND collection_complete = 1 AND collection_snapshot = ?)
        AND NOT EXISTS (
          SELECT 1 FROM role_metadata_repair_stage AS stage
          LEFT JOIN catalog_items AS item ON item.pk = 'JOB#' || stage.job_id AND item.sk = 'META' AND item.kind = 'internship'
          WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.original_value)
        ) THEN 1 ELSE 0 END, ?`)
      .bind(token, token, expectedJobs, plan.metadata_revision, token, token, expectedJobs, expectedOccurrences, plan.collection_snapshot, token, appliedAt);
    const updates = rows.results.map((row) => {
      const proposed = JSON.parse(row.proposed_value) as Internship;
      return this.db.prepare(`UPDATE catalog_items SET value = ?, search_text = ?
        WHERE pk = ? AND sk = 'META' AND kind = 'internship' AND value = ?
          AND EXISTS (SELECT 1 FROM role_metadata_repair_guards WHERE token = ? AND ok = 1)`)
        .bind(row.proposed_value, catalogSearchText(proposed), `JOB#${row.job_id}`, row.original_value, token);
    });
    const results = await this.db.batch([guard, ...updates]);
    if (!results[0]?.meta.changes || updates.some((_, index) => results[index + 1]?.meta.changes !== 1)) {
      throw new Error('Role metadata repair guard failed; run the dry-run again');
    }
    await this.db.prepare('DELETE FROM role_metadata_repair_stage WHERE token = ?').bind(token).run();
    await this.db.prepare('DELETE FROM role_metadata_repair_plans WHERE token = ?').bind(token).run();
    await this.db.prepare('DELETE FROM role_metadata_repair_review_stage WHERE token = ?').bind(token).run();
    return { changed: rows.results.length, occurrencesChanged: 0, projectionRefreshRequired: rows.results.length > 0 };
  }

  async audit(options: { recordLimit?: number; afterJobId?: string; afterUnresolvedEmployer?: string;
    includeRecords?: boolean; includeUnresolvedEmployers?: boolean; now?: Date } = {}): Promise<{
    scanned: number;
    eligible: number;
    review: number;
    legacyUnclassified: number;
    byReason: Record<string, number>;
    bySource: Record<string, number>;
    byDestination: Record<string, number>;
    withNotificationHistory: number;
    freshness: { fresh: number; due: number; stale: number; staleEligible: number; missing: number };
    validationCoverage: { validated: number; missing: number };
    continuationConflicts: number;
    closureSignals: Record<string, number>;
    operations: { scheduled: number; leased: number; backfillQueued: number; backfillCompleted: number;
      repairStaged: number; repairApplied: number };
    unresolvedEmployers: Array<{ provider: string; tenant?: string; labels: string[]; evidenceUrls: string[];
      occurrenceCount: number; continuationConflicts: number; withNotificationHistory: number }>;
    unresolvedEmployerOccurrences: number;
    unresolvedEmployersNextCursor?: string;
    records: Array<{ jobId: string; company: string; title: string; open: boolean; catalogEligible: boolean;
      reasonCodes: string[]; sourceIds: string[]; destinationClassification?: string; smsSent: boolean }>;
    recordsNextCursor?: string;
  }> {
    // Never deserialize the entire catalog in a Worker invocation. Production has
    // thousands of large JSON rows; these aggregates execute in D1 and samples
    // are explicitly bounded below.
    const limit = Math.min(Math.max(options.recordLimit ?? 100, 1), 250);
    const includeRecords = options.includeRecords !== false;
    const includeUnresolvedEmployers = options.includeUnresolvedEmployers !== false;
    const afterPk = options.afterJobId ? `JOB#${options.afterJobId}` : '';
    let unresolvedAfterPk = '';
    let unresolvedAfterReference = -1;
    if (options.afterUnresolvedEmployer) {
      try {
        const decoded = options.afterUnresolvedEmployer.startsWith('[')
          ? options.afterUnresolvedEmployer : decodeURIComponent(options.afterUnresolvedEmployer);
        const cursor = JSON.parse(decoded) as unknown;
        if (Array.isArray(cursor) && cursor.length === 2 && typeof cursor[0] === 'string' && typeof cursor[1] === 'number') {
          [unresolvedAfterPk, unresolvedAfterReference] = cursor;
        }
      } catch { /* Rejected below. */ }
      if (!unresolvedAfterPk.startsWith('JOB#') || !Number.isInteger(unresolvedAfterReference) || unresolvedAfterReference < 0) {
        throw new Error('afterUnresolvedEmployer is invalid');
      }
    }
    const now = options.now?.getTime() ?? Date.now();
    type CountRow = { key: string; count: number };
    const counts = async (sql: string, ...bindings: unknown[]) => Object.fromEntries((await this.db.prepare(sql).bind(...bindings).all<CountRow>()).results
      .map((row) => [row.key, Number(row.count)]));
    const [summary, byReason, bySource, byDestination, closureSignals, freshness, scheduled, leased, backfillQueued, backfillCompleted, repairStaged, repairApplied, unresolvedSummary,
      unresolvedRows, recordRows] = await Promise.all([
      this.db.prepare(`WITH jobs AS (SELECT value,
          unixepoch(coalesce(json_extract(value, '$.admission.lastVerifiedAt'), json_extract(value, '$.admission.destination.lastKnownGoodAt'), json_extract(value, '$.admission.destination.inspectedAt'), json_extract(value, '$.admission.evidenceObservedAt'))) AS observed_at,
          unixepoch(json_extract(value, '$.admission.destination.freshUntil')) AS stored_fresh_until,
          unixepoch(json_extract(value, '$.admission.graceDeadline')) AS stored_grace_deadline,
          unixepoch(json_extract(value, '$.admission.destination.validThrough')) AS valid_through
          FROM catalog_items WHERE kind = 'internship'), deadlines AS (SELECT *, CASE WHEN observed_at IS NULL THEN 0
          WHEN stored_fresh_until IS NOT NULL AND stored_fresh_until < observed_at + 604800 THEN stored_fresh_until ELSE observed_at + 604800 END AS fresh_until FROM jobs)
        SELECT count(*) AS scanned,
        sum(CASE WHEN json_extract(value, '$.admission') IS NULL THEN 1 WHEN json_extract(value, '$.admission.catalogEligible') = 1
          AND (valid_through IS NULL OR valid_through > ?)
          AND CASE WHEN stored_grace_deadline IS NOT NULL AND stored_grace_deadline < fresh_until THEN stored_grace_deadline ELSE fresh_until END > ? THEN 1 ELSE 0 END) AS eligible,
        sum(CASE WHEN json_extract(value, '$.admission.catalogEligible') = 0 THEN 1 ELSE 0 END) AS review,
        sum(CASE WHEN json_extract(value, '$.admission') IS NULL THEN 1 ELSE 0 END) AS legacyUnclassified,
        sum(CASE WHEN json_extract(value, '$.notification.smsSentAt') IS NOT NULL THEN 1 ELSE 0 END) AS withNotificationHistory,
        sum(CASE WHEN json_extract(value, '$.applicationUrlValidatedAt') IS NOT NULL THEN 1 ELSE 0 END) AS validated
        FROM deadlines`).bind(Math.floor(now / 1000), Math.floor(now / 1000)).first<{ scanned: number; eligible: number; review: number; legacyUnclassified: number; withNotificationHistory: number; validated: number }>(),
      counts(`SELECT reason.value AS key, count(*) AS count FROM catalog_items, json_each(catalog_items.value, '$.admission.reasonCodes') AS reason
        WHERE catalog_items.kind = 'internship' GROUP BY reason.value`),
      counts(`SELECT json_extract(reference.value, '$.sourceId') AS key, count(DISTINCT catalog_items.pk) AS count FROM catalog_items,
        json_each(catalog_items.value, '$.sourceReferences') AS reference WHERE catalog_items.kind = 'internship' GROUP BY key`),
      counts(`SELECT coalesce(json_extract(value, '$.admission.destination.classification'), 'legacy-unclassified') AS key, count(*) AS count
        FROM catalog_items WHERE kind = 'internship' GROUP BY key`),
      counts(`SELECT json_extract(value, '$.admission.destination.closureSignal') AS key, count(*) AS count FROM catalog_items
        WHERE kind = 'internship' AND key IS NOT NULL GROUP BY key`),
      this.db.prepare(`SELECT
        sum(CASE WHEN json_extract(value, '$.admission.destination') IS NULL THEN 1 ELSE 0 END) AS missing,
        sum(CASE WHEN json_extract(value, '$.admission.destination') IS NOT NULL AND unixepoch(coalesce(json_extract(value, '$.admission.destination.freshUntil'), datetime(json_extract(value, '$.admission.destination.inspectedAt'), '+7 days'))) <= ? THEN 1 ELSE 0 END) AS stale,
        sum(CASE WHEN json_extract(value, '$.admission.destination') IS NOT NULL AND unixepoch(coalesce(json_extract(value, '$.admission.destination.freshUntil'), datetime(json_extract(value, '$.admission.destination.inspectedAt'), '+7 days'))) <= ? AND json_extract(value, '$.open') = 1 AND json_extract(value, '$.admission.catalogEligible') = 1 THEN 1 ELSE 0 END) AS staleEligible,
        sum(CASE WHEN json_extract(value, '$.admission.destination') IS NOT NULL AND unixepoch(coalesce(json_extract(value, '$.admission.destination.freshUntil'), datetime(json_extract(value, '$.admission.destination.inspectedAt'), '+7 days'))) > ? AND unixepoch(coalesce(json_extract(value, '$.admission.destination.nextCheckAt'), coalesce(json_extract(value, '$.admission.destination.freshUntil'), datetime(json_extract(value, '$.admission.destination.inspectedAt'), '+7 days')))) <= ? THEN 1 ELSE 0 END) AS due
        FROM catalog_items WHERE kind = 'internship'`).bind(Math.floor(now / 1000), Math.floor(now / 1000), Math.floor(now / 1000), Math.floor(now / 1000)).first<{ missing: number; stale: number; staleEligible: number; due: number }>(),
      this.db.prepare('SELECT count(*) AS count FROM destination_verification_schedule').first<{ count: number }>(),
      this.db.prepare("SELECT count(*) AS count FROM destination_verification_schedule WHERE lease_until IS NOT NULL").first<{ count: number }>(),
      this.db.prepare("SELECT count(*) AS count FROM admission_backfill_items WHERE state = 'queued'").first<{ count: number }>(),
      this.db.prepare("SELECT count(*) AS count FROM admission_backfill_items WHERE state = 'completed'").first<{ count: number }>(),
      this.db.prepare('SELECT count(*) AS count FROM catalog_admission_repair_stage').first<{ count: number }>(),
      this.db.prepare('SELECT count(*) AS count FROM catalog_admission_repair_guards').first<{ count: number }>(),
      this.db.prepare(`SELECT count(*) AS count,
        sum(CASE WHEN json_extract(reference.value, '$.employerInheritance') = 'conflict' THEN 1 ELSE 0 END) AS continuationConflicts
        FROM catalog_items, json_each(catalog_items.value, '$.sourceReferences') AS reference WHERE catalog_items.kind = 'internship'
          AND (json_extract(reference.value, '$.admission.employerResolution') IS NULL OR json_extract(reference.value, '$.admission.employerResolution') <> 'resolved'
            OR json_extract(reference.value, '$.employerInheritance') = 'conflict')`).first<{ count: number; continuationConflicts: number | null }>(),
      includeUnresolvedEmployers ? this.db.prepare(`SELECT catalog_items.pk, CAST(reference.key AS INTEGER) AS referenceIndex, reference.value AS reference,
        CASE WHEN json_extract(catalog_items.value, '$.notification.smsSentAt') IS NOT NULL
          OR json_extract(catalog_items.value, '$.notification.digestedAt') IS NOT NULL THEN 1 ELSE 0 END AS notified
        FROM catalog_items, json_each(catalog_items.value, '$.sourceReferences') AS reference WHERE catalog_items.kind = 'internship'
          AND (json_extract(reference.value, '$.admission.employerResolution') IS NULL OR json_extract(reference.value, '$.admission.employerResolution') <> 'resolved'
            OR json_extract(reference.value, '$.employerInheritance') = 'conflict')
          AND (catalog_items.pk > ? OR (catalog_items.pk = ? AND CAST(reference.key AS INTEGER) > ?))
        ORDER BY catalog_items.pk, CAST(reference.key AS INTEGER) LIMIT ?`)
        .bind(unresolvedAfterPk, unresolvedAfterPk, unresolvedAfterReference, limit + 1)
        .all<{ pk: string; referenceIndex: number; reference: string; notified: number }>()
        : Promise.resolve({ results: [] as Array<{ pk: string; referenceIndex: number; reference: string; notified: number }> }),
      includeRecords ? this.db.prepare(`SELECT pk, value FROM catalog_items WHERE kind = 'internship' AND json_extract(value, '$.admission.catalogEligible') = 0
        AND pk > ? ORDER BY pk LIMIT ?`).bind(afterPk, limit + 1).all<{ pk: string; value: string }>()
        : Promise.resolve({ results: [] as Array<{ pk: string; value: string }> }),
    ]);
    const records = recordRows.results.slice(0, limit).map((row) => {
      const job = JSON.parse(row.value) as Internship;
      return { jobId: job.jobId, company: job.company, title: job.title, open: job.open, catalogEligible: false,
        reasonCodes: job.admission?.reasonCodes ?? [], sourceIds: [...new Set(job.sourceReferences.map((reference) => reference.sourceId))].sort(),
        ...(job.admission ? { destinationClassification: job.admission.destination.classification } : {}), smsSent: Boolean(job.notification.smsSentAt) };
    });
    const unresolved = new Map<string, { provider: string; tenant?: string; labels: Set<string>; evidenceUrls: Set<string>;
      occurrenceCount: number; continuationConflicts: number; notifiedJobs: Set<string> }>();
    const unresolvedPage = unresolvedRows.results.slice(0, limit);
    for (const row of unresolvedPage) {
      const reference = JSON.parse(row.reference) as SourceOccurrence;
      const destination = reference.admission?.destination;
      let route: ReturnType<typeof providerPostingReference> = { provider: 'unknown' };
      try { route = providerPostingReference(reference.applyUrl); } catch { /* Preserve malformed candidate evidence. */ }
      const provider = destination?.provider ?? route.provider;
      const tenant = destination?.tenant ?? route.tenant;
      const key = `${provider}\0${tenant ?? ''}`;
      const group = unresolved.get(key) ?? { provider, ...(tenant ? { tenant } : {}), labels: new Set<string>(),
        evidenceUrls: new Set<string>(), occurrenceCount: 0, continuationConflicts: 0, notifiedJobs: new Set<string>() };
      group.labels.add(reference.company); group.evidenceUrls.add(reference.applyUrl); group.occurrenceCount += 1;
      if (reference.employerInheritance === 'conflict') group.continuationConflicts += 1;
      if (row.notified) group.notifiedJobs.add(row.pk);
      unresolved.set(key, group);
    }
    const total = summary ?? { scanned: 0, eligible: 0, review: 0, legacyUnclassified: 0, withNotificationHistory: 0, validated: 0 };
    const fresh = Number(total.scanned) - Number(freshness?.missing ?? 0) - Number(freshness?.stale ?? 0) - Number(freshness?.due ?? 0);
    return {
      scanned: Number(total.scanned), eligible: Number(total.eligible), review: Number(total.review), legacyUnclassified: Number(total.legacyUnclassified),
      byReason,
      bySource,
      byDestination,
      withNotificationHistory: Number(total.withNotificationHistory),
      freshness: { fresh, due: Number(freshness?.due ?? 0), stale: Number(freshness?.stale ?? 0), staleEligible: Number(freshness?.staleEligible ?? 0), missing: Number(freshness?.missing ?? 0) },
      validationCoverage: { validated: Number(total.validated), missing: Number(total.scanned) - Number(total.validated) },
      continuationConflicts: Number(unresolvedSummary?.continuationConflicts ?? 0),
      closureSignals,
      operations: { scheduled: scheduled?.count ?? 0, leased: leased?.count ?? 0, backfillQueued: backfillQueued?.count ?? 0,
        backfillCompleted: backfillCompleted?.count ?? 0, repairStaged: repairStaged?.count ?? 0, repairApplied: repairApplied?.count ?? 0 },
      unresolvedEmployers: [...unresolved.values()].map((group) => ({ provider: group.provider, ...(group.tenant ? { tenant: group.tenant } : {}),
        labels: [...group.labels].sort(), evidenceUrls: [...group.evidenceUrls].sort(), occurrenceCount: group.occurrenceCount,
        continuationConflicts: group.continuationConflicts, withNotificationHistory: group.notifiedJobs.size }))
        .sort((left, right) => left.provider.localeCompare(right.provider) || (left.tenant ?? '').localeCompare(right.tenant ?? '')),
      unresolvedEmployerOccurrences: Number(unresolvedSummary?.count ?? 0),
      ...(unresolvedRows.results.length > limit && unresolvedPage.length ? {
        unresolvedEmployersNextCursor: encodeURIComponent(JSON.stringify([
          unresolvedPage.at(-1)!.pk, unresolvedPage.at(-1)!.referenceIndex,
        ])),
      } : {}),
      records,
      ...(recordRows.results.length > limit ? { recordsNextCursor: records.at(-1)!.jobId } : {}),
    };
  }

  async listCanonicalEmployers(): Promise<CanonicalEmployer[]> {
    const rows = await this.db.prepare('SELECT * FROM canonical_employers ORDER BY display_name').all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      id: row.id as string, displayName: row.display_name as string, reviewedAt: row.reviewed_at as string,
      reviewedBy: row.reviewed_by as string,
      ...(row.parent_employer_id ? { parentEmployerId: row.parent_employer_id as string } : {}),
      ...(row.brand_of_employer_id ? { brandOfEmployerId: row.brand_of_employer_id as string } : {}),
    }));
  }

  async putCanonicalEmployer(value: CanonicalEmployer, now: string): Promise<void> {
    await this.db.prepare(`INSERT INTO canonical_employers
      (id, display_name, reviewed_at, reviewed_by, parent_employer_id, brand_of_employer_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, reviewed_at=excluded.reviewed_at,
        reviewed_by=excluded.reviewed_by, parent_employer_id=excluded.parent_employer_id,
        brand_of_employer_id=excluded.brand_of_employer_id, updated_at=excluded.updated_at`)
      .bind(value.id, value.displayName, value.reviewedAt, value.reviewedBy, value.parentEmployerId ?? null, value.brandOfEmployerId ?? null, now, now).run();
  }

  async listEmployerMappings(): Promise<EmployerMapping[]> {
    const rows = await this.db.prepare('SELECT * FROM employer_mappings ORDER BY provider, scope, reviewed_at').all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      id: row.id as string, provider: row.provider as EmployerMapping['provider'], scope: row.scope as string,
      canonicalEmployerId: row.canonical_employer_id as string, reviewedAt: row.reviewed_at as string,
      reviewedBy: row.reviewed_by as string,
      ...(row.supersedes_mapping_id ? { supersedesMappingId: row.supersedes_mapping_id as string } : {}),
      ...(row.superseded_at ? { supersededAt: row.superseded_at as string } : {}),
    }));
  }

  async resolveCanonicalEmployer(identity: ProviderIdentity): Promise<Pick<CanonicalEmployer, 'id' | 'displayName'> | undefined> {
    // A GitHub document contains many employers, so its source ID can never be
    // an employer identity. Official single-employer feeds retain their broad
    // source/tenant mappings and can fall back to the row's employer scope.
    const rawScopes = (identity.provider === 'github'
      ? [identity.employerScope]
      : [identity.sourceId, identity.tenant, identity.employerScope])
      .filter((value): value is string => Boolean(value));
    // Community ingestion historically encoded the same conservative company
    // key with either spaces or hyphens. Try only that representation variant;
    // the reviewed mapping still defines every accepted employer identity.
    const scopes = [...new Set(rawScopes.flatMap((scope) => scope.startsWith('employer:')
      ? [scope, `employer:${scope.slice('employer:'.length).replace(/[\s_]+/gu, '-')}`]
      : [scope]))];
    for (const scope of scopes) {
      const row = await this.db.prepare(`SELECT employer.id, employer.display_name
        FROM employer_mappings AS mapping
        JOIN canonical_employers AS employer ON employer.id = mapping.canonical_employer_id
        WHERE mapping.provider = ? AND mapping.scope = ? AND mapping.superseded_at IS NULL`)
        .bind(identity.provider, scope).first<{ id: string; display_name: string }>();
      if (row) return { id: row.id, displayName: row.display_name };
    }
    return undefined;
  }

  async configurationVersion(): Promise<string> {
    const [employers, mappings, rules] = await Promise.all([
      this.listCanonicalEmployers(), this.listEmployerMappings(), this.listReviewRules(),
    ]);
    const stable = <T>(values: T[]) => values
      .map((value) => JSON.stringify(value))
      .sort()
      .map((value) => JSON.parse(value) as T);
    return hash(JSON.stringify({ employers: stable(employers), mappings: stable(mappings), rules: stable(rules) }));
  }

  async supersedeEmployerMapping(value: EmployerMapping): Promise<void> {
    const active = await this.db.prepare('SELECT id FROM employer_mappings WHERE provider = ? AND scope = ? AND superseded_at IS NULL')
      .bind(value.provider, value.scope).first<{ id: string }>();
    if (active?.id && value.supersedesMappingId !== active.id) throw new Error('The active employer mapping must be explicitly superseded');
    if (!active && value.supersedesMappingId) throw new Error('No active employer mapping exists to supersede');
    const statements = [];
    if (active) statements.push(this.db.prepare('UPDATE employer_mappings SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL').bind(value.reviewedAt, active.id));
    statements.push(this.db.prepare(`INSERT INTO employer_mappings
      (id, provider, scope, canonical_employer_id, reviewed_at, reviewed_by, supersedes_mapping_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.id, value.provider, value.scope, value.canonicalEmployerId, value.reviewedAt, value.reviewedBy, value.supersedesMappingId ?? null, value.reviewedAt));
    await this.db.batch(statements);
  }

  async listReviewRules(): Promise<DestinationReviewRule[]> {
    const rows = await this.db.prepare('SELECT * FROM destination_review_rules ORDER BY host, provider, tenant').all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      id: row.id as string, host: row.host as string, provider: row.provider as DestinationReviewRule['provider'],
      ...(row.tenant ? { tenant: row.tenant as string } : {}), decision: row.decision as DestinationReviewRule['decision'],
      reviewedAt: row.reviewed_at as string, reviewedBy: row.reviewed_by as string,
      ...(row.sample_due_at ? { sampleDueAt: row.sample_due_at as string } : {}),
    }));
  }

  async resolveReviewRule(identity: ProviderIdentity, candidateUrl: string): Promise<DestinationReviewRule | undefined> {
    let host: string;
    try { host = new URL(candidateUrl).hostname.toLowerCase(); } catch { return undefined; }
    const row = await this.db.prepare(`SELECT * FROM destination_review_rules
      WHERE host = ? AND provider = ? AND (tenant = ? OR tenant IS NULL)
      ORDER BY CASE WHEN tenant = ? THEN 0 ELSE 1 END LIMIT 1`)
      .bind(host, identity.provider, identity.tenant ?? null, identity.tenant ?? null).first<Record<string, unknown>>();
    return row ? {
      id: row.id as string, host: row.host as string, provider: row.provider as DestinationReviewRule['provider'],
      ...(row.tenant ? { tenant: row.tenant as string } : {}), decision: row.decision as DestinationReviewRule['decision'],
      reviewedAt: row.reviewed_at as string, reviewedBy: row.reviewed_by as string,
      ...(row.sample_due_at ? { sampleDueAt: row.sample_due_at as string } : {}),
    } : undefined;
  }

  async putReviewRule(value: DestinationReviewRule): Promise<void> {
    const removePrior = this.db.prepare(`DELETE FROM destination_review_rules
      WHERE host = ? AND provider = ? AND ((tenant IS NULL AND ? IS NULL) OR tenant = ?)`)
      .bind(value.host, value.provider, value.tenant ?? null, value.tenant ?? null);
    const insert = this.db.prepare(`INSERT INTO destination_review_rules
      (id, host, provider, tenant, decision, reviewed_at, reviewed_by, sample_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET host=excluded.host, provider=excluded.provider, tenant=excluded.tenant,
        decision=excluded.decision, reviewed_at=excluded.reviewed_at, reviewed_by=excluded.reviewed_by,
        sample_due_at=excluded.sample_due_at`)
      .bind(value.id, value.host, value.provider, value.tenant ?? null, value.decision, value.reviewedAt, value.reviewedBy, value.sampleDueAt ?? null);
    await this.db.batch([removePrior, insert]);
  }

  async recordReviewerDecision(value: {
    id: string;
    subjectType: 'canonical-employer' | 'employer-mapping' | 'destination-rule' | 'catalog-repair';
    subjectId: string;
    decision: string;
    reason: string;
    reviewedAt: string;
    reviewedBy: string;
  }): Promise<void> {
    await this.db.prepare(`INSERT INTO admission_reviewer_decisions
      (id, subject_type, subject_id, decision, reason, reviewed_at, reviewed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.id, value.subjectType, value.subjectId, value.decision, value.reason, value.reviewedAt, value.reviewedBy).run();
  }

  async reviewSampleCandidates(rule: DestinationReviewRule, limit = 3): Promise<Array<{
    jobId: string; sourceId: string; externalId: string; sourceUrl: string; candidateUrl: string; expectedPostingId?: string;
  }>> {
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'internship'").all<JsonRow>();
    const candidates: Array<{ jobId: string; sourceId: string; externalId: string; sourceUrl: string; candidateUrl: string; expectedPostingId?: string }> = [];
    for (const row of rows.results) {
      const job = JSON.parse(row.value) as Internship;
      for (const reference of job.sourceReferences) {
        if (!reference.externalId || !reference.admission) continue;
        const destination = reference.admission.destination;
        let host: string;
        try { host = new URL(destination.candidateUrl).hostname.toLowerCase(); } catch { continue; }
        if (host !== rule.host || destination.provider !== rule.provider || (rule.tenant && destination.tenant !== rule.tenant)) continue;
        candidates.push({ jobId: job.jobId, sourceId: reference.sourceId, externalId: reference.externalId,
          sourceUrl: reference.sourceUrl, candidateUrl: destination.candidateUrl,
          ...(destination.expectedPostingId ? { expectedPostingId: destination.expectedPostingId } : {}) });
        if (candidates.length === limit) return candidates;
      }
    }
    return candidates;
  }

  async legacyVerificationCandidates(limit = 100): Promise<Array<{
    jobId: string; sourceId: string; externalId: string; candidateUrl: string; providerIdentity: ProviderIdentity;
    occurrenceSnapshotHash: string;
  }>> {
    const rows = await this.db.prepare("SELECT value FROM catalog_items WHERE kind = 'internship' ORDER BY pk").all<JsonRow>();
    const candidates: Array<{ jobId: string; sourceId: string; externalId: string; candidateUrl: string;
      providerIdentity: ProviderIdentity; occurrenceSnapshotHash: string }> = [];
    for (const row of rows.results) {
      const job = JSON.parse(row.value) as Internship;
      for (const reference of job.sourceReferences) {
        if (!reference.externalId || reference.admission) continue;
        const providerIdentity = providerIdentityForReference(reference);
        candidates.push({ jobId: job.jobId, sourceId: reference.sourceId, externalId: reference.externalId,
          candidateUrl: reference.applyUrl, providerIdentity, occurrenceSnapshotHash: occurrenceSnapshotHash(reference) });
        if (candidates.length >= limit) return candidates;
      }
    }
    return candidates;
  }

  async syncVerificationSchedule(now: string, limit = DESTINATION_SCHEDULE_SYNC_LIMIT): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(limit, DESTINATION_SCHEDULE_SYNC_LIMIT));
    let state = await this.db.prepare('SELECT * FROM destination_verification_schedule_sync WHERE id = 1')
      .first<Record<string, unknown>>();
    if (!state) {
      const generationId = crypto.randomUUID();
      await this.db.prepare(`INSERT INTO destination_verification_schedule_sync
        (id, generation_id, after_pk, after_sk, reference_offset, updated_at) VALUES (1, ?, '', '', 0, ?)
        ON CONFLICT(id) DO NOTHING`).bind(generationId, now).run();
      state = await this.db.prepare('SELECT * FROM destination_verification_schedule_sync WHERE id = 1')
        .first<Record<string, unknown>>();
      if (!state) throw new Error('Destination schedule synchronization could not initialize');
    }
    const generationId = state.generation_id as string;
    const afterPk = state.after_pk as string;
    const afterSk = state.after_sk as string;
    const initialReferenceOffset = state.reference_offset as number;
    const rows = await this.db.prepare(`SELECT pk, sk, value FROM catalog_items
      WHERE kind = 'internship' AND (pk, sk) >= (?, ?)
        AND ((pk, sk) > (?, ?) OR ? > 0) ORDER BY pk, sk LIMIT 100`)
      .bind(afterPk, afterSk, afterPk, afterSk, initialReferenceOffset)
      .all<{ pk: string; sk: string; value: string }>();
    const statements: D1PreparedStatement[] = [];
    let lastCompletePk = afterPk;
    let lastCompleteSk = afterSk;
    let nextReferenceOffset = initialReferenceOffset;
    let pageComplete = true;
    for (let rowIndex = 0; rowIndex < rows.results.length; rowIndex += 1) {
      const row = rows.results[rowIndex]!;
      const job = JSON.parse(row.value) as Internship;
      const startAt = rowIndex === 0 && row.pk === afterPk && row.sk === afterSk ? initialReferenceOffset : 0;
      for (let referenceIndex = startAt; referenceIndex < job.sourceReferences.length; referenceIndex += 1) {
        const reference = job.sourceReferences[referenceIndex]!;
        // Legacy rows are frozen through admission_backfill_generations. They
        // must never enter the mutating recurring schedule before guarded repair.
        if (!reference.externalId || reference.state !== 'open' || !reference.admission) continue;
        if (statements.length === boundedLimit) {
          lastCompletePk = row.pk;
          lastCompleteSk = row.sk;
          nextReferenceOffset = referenceIndex;
          pageComplete = false;
          break;
        }
        const prior = reference.admission.destination;
        const providerIdentity = providerIdentityForReference(reference, prior);
        const nextCheckAt = prior?.nextCheckAt ?? (prior?.freshUntil
          ? new Date(Math.max(Date.parse(prior.inspectedAt), Date.parse(prior.freshUntil) - 86_400_000)).toISOString()
          : new Date(Date.parse(prior?.inspectedAt ?? reference.admission.evaluatedAt) + 6 * 86_400_000).toISOString());
        const occurrenceKey = destinationOccurrenceKey(reference.sourceId, reference.externalId);
        statements.push(this.db.prepare(`INSERT INTO destination_verification_schedule
          (occurrence_key, job_id, source_id, external_id, candidate_url, provider_identity, next_check_at, sync_generation, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(occurrence_key) DO UPDATE SET job_id=excluded.job_id, candidate_url=excluded.candidate_url,
            provider_identity=excluded.provider_identity,
            sync_generation=excluded.sync_generation,
            next_check_at=CASE WHEN destination_verification_schedule.candidate_url <> excluded.candidate_url
                OR destination_verification_schedule.provider_identity <> excluded.provider_identity
              THEN excluded.updated_at ELSE destination_verification_schedule.next_check_at END,
            lease_token=CASE WHEN destination_verification_schedule.candidate_url <> excluded.candidate_url
                OR destination_verification_schedule.provider_identity <> excluded.provider_identity
              THEN NULL ELSE destination_verification_schedule.lease_token END,
            lease_until=CASE WHEN destination_verification_schedule.candidate_url <> excluded.candidate_url
                OR destination_verification_schedule.provider_identity <> excluded.provider_identity
              THEN NULL ELSE destination_verification_schedule.lease_until END,
            last_enqueued_at=CASE WHEN destination_verification_schedule.candidate_url <> excluded.candidate_url
                OR destination_verification_schedule.provider_identity <> excluded.provider_identity
              THEN NULL ELSE destination_verification_schedule.last_enqueued_at END,
            updated_at=excluded.updated_at`)
          .bind(occurrenceKey, job.jobId, reference.sourceId, reference.externalId, reference.applyUrl,
            JSON.stringify(providerIdentity), nextCheckAt, generationId, now));
      }
      if (!pageComplete) break;
      lastCompletePk = row.pk;
      lastCompleteSk = row.sk;
      nextReferenceOffset = 0;
    }
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    const exhaustedCatalog = pageComplete && rows.results.length < 100;
    if (exhaustedCatalog) {
      await this.db.batch([
        this.db.prepare('DELETE FROM destination_verification_schedule WHERE sync_generation IS NOT ?').bind(generationId),
        this.db.prepare('DELETE FROM destination_verification_schedule_sync WHERE id = 1 AND generation_id = ?').bind(generationId),
      ]);
    } else {
      await this.db.prepare(`UPDATE destination_verification_schedule_sync
        SET after_pk = ?, after_sk = ?, reference_offset = ?, updated_at = ?
        WHERE id = 1 AND generation_id = ? AND after_pk = ? AND after_sk = ? AND reference_offset = ?`)
        .bind(lastCompletePk, lastCompleteSk, nextReferenceOffset, now, generationId,
          afterPk, afterSk, initialReferenceOffset).run();
    }
    return statements.length;
  }

  async leaseDueVerifications(now: string, limit = DESTINATION_VERIFICATION_LEASE_LIMIT, leaseMs = 15 * 60_000): Promise<ScheduledDestinationVerification[]> {
    const boundedLimit = Math.max(1, Math.min(limit, DESTINATION_VERIFICATION_LEASE_LIMIT));
    const rows = await this.db.prepare(`SELECT * FROM destination_verification_schedule
      WHERE next_check_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_check_at, occurrence_key LIMIT ?`).bind(now, now, boundedLimit).all<Record<string, unknown>>();
    const leased: ScheduledDestinationVerification[] = [];
    for (const row of rows.results) {
      const leaseToken = crypto.randomUUID();
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString();
      const result = await this.db.prepare(`UPDATE destination_verification_schedule SET lease_token = ?, lease_until = ?, updated_at = ?
        WHERE occurrence_key = ? AND (lease_until IS NULL OR lease_until <= ?)`).bind(leaseToken, leaseUntil, now, row.occurrence_key, now).run();
      if (!result.meta.changes) continue;
      leased.push({
        occurrenceKey: row.occurrence_key as string, jobId: row.job_id as string, sourceId: row.source_id as string,
        externalId: row.external_id as string, candidateUrl: row.candidate_url as string,
        providerIdentity: JSON.parse(row.provider_identity as string) as ProviderIdentity,
        nextCheckAt: row.next_check_at as string, leaseToken,
      });
    }
    return leased;
  }

  async markVerificationEnqueued(occurrenceKey: string, leaseToken: string, enqueuedAt: string): Promise<void> {
    await this.db.prepare(`UPDATE destination_verification_schedule SET last_enqueued_at = ?, updated_at = ?
      WHERE occurrence_key = ? AND lease_token = ?`).bind(enqueuedAt, enqueuedAt, occurrenceKey, leaseToken).run();
  }

  async deferScheduledVerificationRetry(input: {
    occurrenceKey: string;
    leaseToken: string;
    deferredUntil: string;
    updatedAt: string;
  }): Promise<void> {
    await this.db.prepare(`UPDATE destination_verification_schedule SET lease_until = ?, updated_at = ?
      WHERE occurrence_key = ? AND lease_token = ?`)
      .bind(input.deferredUntil, input.updatedAt, input.occurrenceKey, input.leaseToken).run();
  }

  async completeScheduledVerification(input: { occurrenceKey: string; leaseToken?: string; completedAt: string;
    classification: string; nextCheckAt: string }): Promise<void> {
    await this.db.prepare(`UPDATE destination_verification_schedule SET next_check_at = ?, lease_token = NULL, lease_until = NULL,
      last_completed_at = ?, last_classification = ?, updated_at = ?
      WHERE occurrence_key = ?${input.leaseToken ? ' AND lease_token = ?' : ''}`)
      .bind(input.nextCheckAt, input.completedAt, input.classification, input.completedAt, input.occurrenceKey,
        ...(input.leaseToken ? [input.leaseToken] : [])).run();
  }

  async verificationCompleted(idempotencyKey: string): Promise<boolean> {
    return Boolean(await this.db.prepare('SELECT idempotency_key FROM destination_verification_completions WHERE idempotency_key = ?')
      .bind(idempotencyKey).first());
  }

  async recordVerificationCompletion(idempotencyKey: string, completedAt: string): Promise<void> {
    await this.db.prepare(`INSERT INTO destination_verification_completions (idempotency_key, completed_at)
      VALUES (?, ?) ON CONFLICT(idempotency_key) DO NOTHING`).bind(idempotencyKey, completedAt).run();
  }

  async previewBackfill(frozenAt: string): Promise<AdmissionBackfillGeneration> {
    const id = hash(`${frozenAt}\0${crypto.randomUUID()}`);
    await this.db.batch([
      this.db.prepare(`INSERT INTO admission_backfill_generations
        (id, state, total, queued, completed, created_at, frozen_at, updated_at)
        VALUES (?, 'previewed', 0, 0, 0, ?, ?, ?)`).bind(id, frozenAt, frozenAt, frozenAt),
      this.db.prepare(`INSERT INTO admission_backfill_items
        (generation_id, ordinal, occurrence_key, job_id, source_id, external_id, candidate_url,
         occurrence_snapshot, state, updated_at)
        SELECT ?, row_number() OVER (ORDER BY json_array(
            json_extract(reference.value, '$.sourceId'), json_extract(reference.value, '$.externalId'))) - 1,
          json_array(json_extract(reference.value, '$.sourceId'), json_extract(reference.value, '$.externalId')),
          json_extract(catalog.value, '$.jobId'), json_extract(reference.value, '$.sourceId'),
          json_extract(reference.value, '$.externalId'), json_extract(reference.value, '$.applyUrl'),
          json(reference.value), 'pending', ?
        FROM catalog_items AS catalog, json_each(catalog.value, '$.sourceReferences') AS reference
        WHERE catalog.kind = 'internship'
          AND json_extract(reference.value, '$.externalId') IS NOT NULL
          AND json_extract(reference.value, '$.externalId') <> ''
          AND coalesce(json_type(reference.value, '$.admission'), 'null') = 'null'`).bind(id, frozenAt),
      this.db.prepare(`UPDATE admission_backfill_generations SET
        total = (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ?)
        WHERE id = ?`).bind(id, id),
    ]);
    return (await this.backfillProgress(id))!;
  }

  async backfillPage(generationId: string, cursor = 0, limit = 100, includeQueued = false): Promise<Array<{
    ordinal: number; occurrenceKey: string; jobId: string; sourceId: string; externalId: string;
    candidateUrl: string; providerIdentity: ProviderIdentity;
  }>> {
    const rows = await this.db.prepare(`SELECT * FROM admission_backfill_items
      WHERE generation_id = ? AND ordinal >= ? AND state ${includeQueued ? "IN ('pending','queued')" : "= 'pending'"}
      ORDER BY ordinal LIMIT ?`)
      .bind(generationId, cursor, limit).all<Record<string, unknown>>();
    return rows.results.map((row) => {
      const reference = JSON.parse(row.occurrence_snapshot as string) as SourceOccurrence;
      return { ordinal: row.ordinal as number, occurrenceKey: row.occurrence_key as string,
        jobId: row.job_id as string, sourceId: row.source_id as string, externalId: row.external_id as string,
        candidateUrl: row.candidate_url as string, providerIdentity: providerIdentityForReference(reference) };
    });
  }

  async markBackfillQueued(generationId: string, occurrenceKeys: string[], updatedAt: string): Promise<void> {
    if (!occurrenceKeys.length) return;
    const statements = occurrenceKeys.map((key) => this.db.prepare(`UPDATE admission_backfill_items SET state = 'queued', updated_at = ?
      WHERE generation_id = ? AND occurrence_key = ? AND state = 'pending'`).bind(updatedAt, generationId, key));
    await this.db.batch(statements);
    await this.refreshBackfillProgress(generationId, updatedAt);
  }

  async recordBackfillEvidence(input: { generationId: string; occurrenceKey: string; evidenceHash: string;
    classification: string; value: unknown; observedAt: string }): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT INTO admission_backfill_evidence
        (generation_id, occurrence_key, evidence_hash, classification, value, observed_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(generation_id, occurrence_key) DO NOTHING`)
        .bind(input.generationId, input.occurrenceKey, input.evidenceHash, input.classification, JSON.stringify(input.value), input.observedAt),
      this.db.prepare(`UPDATE admission_backfill_items SET state = 'completed',
        evidence_hash = (SELECT evidence_hash FROM admission_backfill_evidence
          WHERE generation_id = ? AND occurrence_key = ?), updated_at = ?
        WHERE generation_id = ? AND occurrence_key = ?`)
        .bind(input.generationId, input.occurrenceKey, input.observedAt, input.generationId, input.occurrenceKey),
    ]);
    await this.refreshBackfillProgress(input.generationId, input.observedAt);
  }

  private async refreshBackfillProgress(generationId: string, updatedAt: string): Promise<void> {
    await this.db.prepare(`UPDATE admission_backfill_generations SET
      queued = (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ? AND state IN ('queued','completed')),
      completed = (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ? AND state = 'completed'),
      state = CASE WHEN (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ? AND state = 'completed') = total
        THEN 'complete' WHEN (SELECT count(*) FROM admission_backfill_items WHERE generation_id = ? AND state IN ('queued','completed')) > 0
        THEN 'queued' ELSE 'previewed' END,
      updated_at = ? WHERE id = ?`).bind(generationId, generationId, generationId, generationId, updatedAt, generationId).run();
  }

  async backfillProgress(generationId: string): Promise<AdmissionBackfillGeneration | undefined> {
    const row = await this.db.prepare('SELECT * FROM admission_backfill_generations WHERE id = ?')
      .bind(generationId).first<Record<string, unknown>>();
    return row ? { id: row.id as string, state: row.state as AdmissionBackfillGeneration['state'], total: row.total as number,
      queued: row.queued as number, completed: row.completed as number, createdAt: row.created_at as string,
      frozenAt: row.frozen_at as string, updatedAt: row.updated_at as string } : undefined;
  }

  async deriveBackfillRepairBatch(generationId: string, sourceId: string, cursor = 0, recordLimit = BACKFILL_REPAIR_RECORD_LIMIT): Promise<{
    changes: RepairChange[]; records: number; nextCursor: number | null;
  }> {
    if (recordLimit < 1 || recordLimit > BACKFILL_REPAIR_RECORD_LIMIT) {
      throw new Error(`Backfill repair recordLimit must be between 1 and ${BACKFILL_REPAIR_RECORD_LIMIT}`);
    }
    const rows = await this.db.prepare(`SELECT item.*, evidence.value AS evidence_value, evidence.observed_at
      FROM admission_backfill_items AS item
      JOIN admission_backfill_evidence AS evidence
        ON evidence.generation_id = item.generation_id AND evidence.occurrence_key = item.occurrence_key
      WHERE item.generation_id = ? AND item.source_id = ? AND item.state = 'completed' AND item.ordinal >= ?
      ORDER BY item.ordinal LIMIT ?`).bind(generationId, sourceId, cursor, recordLimit + 1).all<Record<string, unknown>>();
    const changes = new Map<string, { job: Internship; references: SourceOccurrence[]; maxOrdinal: number; changedOccurrences: number }>();
    let records = 0;
    let nextCursor: number | null = null;
    for (const row of rows.results) {
      const ordinal = row.ordinal as number;
      const existing = changes.get(row.job_id as string);
      const jobRow = existing ? undefined : await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'META' AND kind = 'internship'")
        .bind(`JOB#${row.job_id as string}`).first<JsonRow>();
      if (!existing && !jobRow) throw new Error(`Backfill generation ${generationId} drifted: job ${row.job_id as string} was removed`);
      const job = existing?.job ?? JSON.parse(jobRow!.value) as Internship;
      const referenceAt = job.sourceReferences.findIndex((reference) => reference.sourceId === row.source_id && reference.externalId === row.external_id);
      if (referenceAt < 0) throw new Error(`Backfill generation ${generationId} drifted at ${row.source_id as string}:${row.external_id as string}; preview again`);
      const proposedRecordCost = existing ? 1 : 2;
      if (records + proposedRecordCost > recordLimit) { nextCursor = ordinal; break; }
      const references = existing?.references ?? [...job.sourceReferences];
      const reference = references[referenceAt]!;
      const frozenReference = JSON.parse(row.occurrence_snapshot as string) as SourceOccurrence;
      const providerIdentity = providerIdentityForReference(frozenReference);
      const currentIdentity = providerIdentityForReference(reference, reference.admission?.destination);
      if (occurrenceSnapshotHash(reference) !== occurrenceSnapshotHash(frozenReference)
        || reference.applyUrl !== row.candidate_url || !sameProviderIdentity(providerIdentity, currentIdentity)) {
        throw new Error(`Backfill generation ${generationId} drifted at ${row.source_id as string}:${row.external_id as string}; preview again`);
      }
      const mappedEmployer = await this.resolveCanonicalEmployer(providerIdentity);
      const mayReuseEmployer = reference.employerLabelOrigin !== 'inherited' || reference.employerInheritance === 'same-tenant';
      const listing: ProcessedListing = { ...reference, fetchedAt: row.observed_at as string, providerIdentity,
        postingIdentity: job.postingIdentity,
        employerEvidence: { authority: reference.provenance === 'reviewed-community' ? 'source-row' : 'reviewed-registry',
          ...(mappedEmployer ? { canonicalEmployer: mappedEmployer }
            : mayReuseEmployer && reference.admission?.canonicalEmployer ? { canonicalEmployer: reference.admission.canonicalEmployer } : {}) },
        metadataCompleteness: reference.admission?.metadata
          ?? metadataCompleteness({ title: reference.title, locations: reference.locations ?? [reference.location] }) };
      const destination = JSON.parse(row.evidence_value as string) as CatalogAdmission['destination'];
      const admission = evaluateCatalogAdmission({ listing, destination,
        postingAttributed: reference.provenance !== 'reviewed-community'
          || (destination.browserVisible === true && ['posting-detail', 'application-form'].includes(destination.classification)),
        evaluatedAt: row.observed_at as string, previous: reference.admission ?? job.admission });
      references[referenceAt] = { ...reference, admission };
      changes.set(job.jobId, { job, references, maxOrdinal: ordinal, changedOccurrences: (existing?.changedOccurrences ?? 0) + 1 });
      records += proposedRecordCost;
    }
    const repairChanges = [...changes.values()].map(({ job, references }) => {
      const admission = deriveCanonicalAdmission(references,
        references.map((reference) => reference.admission?.evaluatedAt ?? '').sort().at(-1)!)!;
      return { jobId: job.jobId, admission, sourceReferences: references,
        applicationUrlValidatedAt: admission.catalogEligible
          && ['posting-detail', 'application-form'].includes(admission.destination.classification)
          ? admission.destination.inspectedAt : null };
    });
    if (nextCursor === null && rows.results.length) nextCursor = null;
    return { changes: repairChanges, records, nextCursor };
  }

  async markReviewRuleSampled(id: string, sampleDueAt: string): Promise<void> {
    await this.db.prepare('UPDATE destination_review_rules SET sample_due_at = ? WHERE id = ?').bind(sampleDueAt, id).run();
  }

  async listActiveIncidents(): Promise<AdmissionIncident[]> {
    const rows = await this.db.prepare("SELECT * FROM admission_incidents WHERE state IN ('open','quarantined') ORDER BY grace_deadline, opened_at").all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      id: row.id as string, jobId: row.job_id as string, sourceId: row.source_id as string, host: row.host as string,
      reasonCode: row.reason_code as AdmissionIncident['reasonCode'], state: row.state as AdmissionIncident['state'],
      openedAt: row.opened_at as string, updatedAt: row.updated_at as string,
      ...(row.grace_deadline ? { graceDeadline: row.grace_deadline as string } : {}),
      ...(row.warning_sent_at ? { warningSentAt: row.warning_sent_at as string } : {}),
      ...(row.quarantine_sent_at ? { quarantineSentAt: row.quarantine_sent_at as string } : {}),
    }));
  }

  async resolveIncidents(jobId: string, sourceId: string, updatedAt: string, exceptReason?: AdmissionIncident['reasonCode']): Promise<void> {
    const condition = exceptReason ? ' AND reason_code <> ?' : '';
    await this.db.prepare(`UPDATE admission_incidents SET state = 'resolved', updated_at = ?
      WHERE job_id = ? AND source_id = ? AND state IN ('open','quarantined')${condition}`)
      .bind(updatedAt, jobId, sourceId, ...(exceptReason ? [exceptReason] : [])).run();
  }

  async recordVerificationAttempt(value: {
    id: string; jobId: string; sourceId: string; candidateUrl: string;
    state: 'succeeded' | 'failed'; classification?: string; error?: string;
    attemptedAt: string; completedAt: string;
  }, evidence?: { hash: string; classification: string; value: unknown; observedAt: string }): Promise<void> {
    const statements = [this.db.prepare(`INSERT INTO destination_verification_attempts
      (id, job_id, source_id, candidate_url, state, classification, error, attempted_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.id, value.jobId, value.sourceId, value.candidateUrl, value.state, value.classification ?? null, value.error ?? null, value.attemptedAt, value.completedAt)];
    if (evidence) statements.push(this.db.prepare(`INSERT INTO destination_verification_evidence
      (job_id, evidence_hash, classification, value, observed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id, evidence_hash) DO UPDATE SET classification=excluded.classification, value=excluded.value, observed_at=excluded.observed_at`)
      .bind(value.jobId, evidence.hash, evidence.classification, JSON.stringify(evidence.value), evidence.observedAt));
    await this.db.batch(statements);
  }

  async hasVerificationAttemptSince(jobId: string, sourceId: string, candidateUrl: string, since: string): Promise<boolean> {
    return Boolean(await this.db.prepare(`SELECT id FROM destination_verification_attempts
      WHERE job_id = ? AND source_id = ? AND candidate_url = ? AND completed_at >= ?
        AND id NOT LIKE 'historical-backfill:%'
      ORDER BY completed_at DESC LIMIT 1`)
      .bind(jobId, sourceId, candidateUrl, since).first<{ id: string }>());
  }

  async renderedEvidenceCollisionJobIds(jobId: string, renderedEvidenceHash: string, expectedPostingId: string): Promise<string[]> {
    const rows = await this.db.prepare(`SELECT DISTINCT job_id FROM destination_verification_evidence
      WHERE job_id <> ?
        AND json_extract(value, '$.renderedEvidenceHash') = ?
        AND coalesce(json_extract(value, '$.expectedPostingId'), '') <> ?
      ORDER BY job_id`).bind(jobId, renderedEvidenceHash, expectedPostingId).all<{ job_id: string }>();
    return rows.results.map((row) => row.job_id);
  }

  async hasRenderedEvidenceCollision(jobId: string, renderedEvidenceHash: string, expectedPostingId: string): Promise<boolean> {
    return (await this.renderedEvidenceCollisionJobIds(jobId, renderedEvidenceHash, expectedPostingId)).length > 0;
  }

  async upsertIncident(value: AdmissionIncident): Promise<void> {
    await this.db.prepare(`INSERT INTO admission_incidents
      (id, job_id, source_id, host, reason_code, state, opened_at, updated_at, grace_deadline, warning_sent_at, quarantine_sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, reason_code=excluded.reason_code,
        updated_at=excluded.updated_at, grace_deadline=excluded.grace_deadline,
        warning_sent_at=coalesce(excluded.warning_sent_at, admission_incidents.warning_sent_at),
        quarantine_sent_at=coalesce(excluded.quarantine_sent_at, admission_incidents.quarantine_sent_at)`)
      .bind(value.id, value.jobId, value.sourceId, value.host, value.reasonCode, value.state,
        value.openedAt, value.updatedAt, value.graceDeadline ?? null, value.warningSentAt ?? null, value.quarantineSentAt ?? null).run();
  }

  async emailDeliveryExists(dedupeKey: string): Promise<boolean> {
    return Boolean(await this.db.prepare('SELECT dedupe_key FROM admission_email_deliveries WHERE dedupe_key = ?').bind(dedupeKey).first());
  }

  async recordEmailDelivery(dedupeKey: string, incidentId: string, messageType: string, sentAt: string): Promise<void> {
    await this.db.prepare(`INSERT INTO admission_email_deliveries (dedupe_key, incident_id, message_type, sent_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`).bind(dedupeKey, incidentId, messageType, sentAt).run();
  }

  async markIncidentNotification(id: string, messageType: 'grace-warning' | 'quarantine', sentAt: string): Promise<void> {
    const column = messageType === 'grace-warning' ? 'warning_sent_at' : 'quarantine_sent_at';
    await this.db.prepare(`UPDATE admission_incidents SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .bind(sentAt, sentAt, id).run();
  }

  async stageRepair(changes: RepairChange[], createdAt: string): Promise<{
    repairToken: string; changed: number; candidates: string[]; occurrencesChanged: number; occurrenceCandidates: string[];
  }> {
    if (!changes.length) return { repairToken: repairToken([]), changed: 0, candidates: [], occurrencesChanged: 0, occurrenceCandidates: [] };
    if (new Set(changes.map((change) => change.jobId)).size !== changes.length) throw new Error('Repair job IDs must be unique');
    const rows: Array<{ jobId: string; original: string; proposed: string; job: Internship }> = [];
    const occurrences: Array<{ sourceId: string; externalId: string; original: string; proposed: string }> = [];
    for (const change of changes) {
      const row = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = 'META' AND kind = 'internship'")
        .bind(`JOB#${change.jobId}`).first<JsonRow>();
      if (!row) throw new Error(`Repair job ${change.jobId} was not found`);
      const current = JSON.parse(row.value) as Internship;
      const proposed = preserveDurableFields(current, change);
      const proposedValue = JSON.stringify(proposed);
      if (row.value !== proposedValue) rows.push({ jobId: change.jobId, original: row.value, proposed: proposedValue, job: proposed });
      if (change.sourceReferences) {
        const originalByKey = new Map(current.sourceReferences.map((reference) => [sourceReferenceKey(reference), reference]));
        for (const reference of change.sourceReferences) {
          if (!reference.externalId || JSON.stringify(originalByKey.get(sourceReferenceKey(reference))) === JSON.stringify(reference)) continue;
          const occurrenceRow = await this.db.prepare("SELECT value FROM catalog_items WHERE pk = ? AND sk = ? AND kind = 'source-occurrence'")
            .bind(`SOURCE#${reference.sourceId}`, `OCCURRENCE#${reference.externalId}`).first<JsonRow>();
          if (!occurrenceRow) throw new Error(`Source occurrence ${reference.sourceId}:${reference.externalId} was not found`);
          const state = JSON.parse(occurrenceRow.value) as SourceOccurrenceState;
          if (state.jobId !== current.jobId) throw new Error(`Source occurrence ${reference.sourceId}:${reference.externalId} belongs to another job`);
          occurrences.push({ sourceId: reference.sourceId, externalId: reference.externalId,
            original: occurrenceRow.value, proposed: JSON.stringify({ ...state, occurrence: reference }) });
        }
      }
    }
    if (new Set(occurrences.map((item) => `${item.sourceId}\0${item.externalId}`)).size !== occurrences.length) {
      throw new Error('Admission repair source occurrences must be unique');
    }
    if (rows.length + occurrences.length > ATOMIC_REPAIR_RECORD_LIMIT) {
      throw new Error(`Admission repair exceeds the atomic D1 limit of ${ATOMIC_REPAIR_RECORD_LIMIT} records`);
    }
    const token = repairToken(rows, occurrences);
    const statements = rows.map((row) => this.db.prepare(`INSERT INTO catalog_admission_repair_stage
      (token, job_id, original_value, proposed_value, url_key, fingerprint_key, sms_pending, digest_pending,
       catalog_state, catalog_sort_key, search_text, source_classes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token, job_id) DO UPDATE SET original_value=excluded.original_value, proposed_value=excluded.proposed_value,
        url_key=excluded.url_key, fingerprint_key=excluded.fingerprint_key, sms_pending=excluded.sms_pending,
        digest_pending=excluded.digest_pending, catalog_state=excluded.catalog_state, catalog_sort_key=excluded.catalog_sort_key,
        search_text=excluded.search_text, source_classes=excluded.source_classes, created_at=excluded.created_at`)
      .bind(token, row.jobId, row.original, row.proposed, row.job.normalizedUrl, row.job.fingerprint,
        Number(row.job.notification.smsPending && alertEligible(row.job)), Number(row.job.notification.digestPending && alertEligible(row.job)),
        catalogEligible(row.job) ? row.job.open ? 'OPEN' : 'CLOSED' : null,
        catalogEligible(row.job) ? row.job.open ? openCatalogSortKey(row.job) : `${row.job.lastSeenAt}#${row.job.jobId}` : null,
        catalogEligible(row.job) ? catalogSearchText(row.job) : null,
        catalogEligible(row.job) ? JSON.stringify(catalogSourceClasses(row.job)) : null, createdAt));
    for (let offset = 0; offset < statements.length; offset += 50) await this.db.batch(statements.slice(offset, offset + 50));
    const occurrenceStatements = occurrences.map((row) => this.db.prepare(`INSERT INTO catalog_admission_occurrence_repair_stage
      (token, source_id, external_id, original_value, proposed_value, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token, source_id, external_id) DO UPDATE SET original_value=excluded.original_value,
        proposed_value=excluded.proposed_value, created_at=excluded.created_at`)
      .bind(token, row.sourceId, row.externalId, row.original, row.proposed, createdAt));
    for (let offset = 0; offset < occurrenceStatements.length; offset += 50) await this.db.batch(occurrenceStatements.slice(offset, offset + 50));
    return { repairToken: token, changed: rows.length, candidates: rows.map((row) => row.jobId),
      occurrencesChanged: occurrences.length, occurrenceCandidates: occurrences.map((row) => `${row.sourceId}:${row.externalId}`) };
  }

  async applyRepair(token: string, expectedChanged: number, appliedAt: string, expectedOccurrencesChanged = 0): Promise<{
    changed: number; occurrencesChanged: number; projectionRefreshRequired: boolean; verificationMismatches: number;
  }> {
    const stage = await this.db.prepare('SELECT * FROM catalog_admission_repair_stage WHERE token = ? ORDER BY job_id')
      .bind(token).all<{ job_id: string; original_value: string; proposed_value: string; url_key: string; fingerprint_key: string; sms_pending: number; digest_pending: number; catalog_state: string | null; catalog_sort_key: string | null; search_text: string | null; source_classes: string | null }>();
    if (stage.results.length !== expectedChanged) throw new Error('Repair row count changed; run the dry-run again');
    const occurrenceStage = await this.db.prepare(`SELECT * FROM catalog_admission_occurrence_repair_stage
      WHERE token = ? ORDER BY source_id, external_id`).bind(token)
      .all<{ source_id: string; external_id: string; original_value: string; proposed_value: string }>();
    if (occurrenceStage.results.length !== expectedOccurrencesChanged) throw new Error('Repair occurrence count changed; run the dry-run again');
    if (stage.results.length + occurrenceStage.results.length > ATOMIC_REPAIR_RECORD_LIMIT) {
      throw new Error(`Admission repair exceeds the atomic D1 limit of ${ATOMIC_REPAIR_RECORD_LIMIT} records`);
    }
    const guard = this.db.prepare(`INSERT INTO catalog_admission_repair_guards (token, ok, applied_at)
      SELECT ?, CASE WHEN
        (SELECT count(*) FROM catalog_admission_repair_stage WHERE token = ?) = ?
        AND (SELECT count(*) FROM catalog_admission_occurrence_repair_stage WHERE token = ?) = ?
        AND NOT EXISTS (
          SELECT 1 FROM catalog_admission_repair_stage AS stage
          LEFT JOIN catalog_items AS item ON item.pk = 'JOB#' || stage.job_id AND item.sk = 'META' AND item.kind = 'internship'
          WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.original_value)
        )
        AND NOT EXISTS (
          SELECT 1 FROM catalog_admission_occurrence_repair_stage AS stage
          LEFT JOIN catalog_items AS item ON item.pk = 'SOURCE#' || stage.source_id
            AND item.sk = 'OCCURRENCE#' || stage.external_id AND item.kind = 'source-occurrence'
          WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.original_value)
        ) THEN 1 ELSE 0 END, ?`)
      .bind(token, token, expectedChanged, token, expectedOccurrencesChanged, token, token, appliedAt);
    const updates = stage.results.map((row) => this.db.prepare(`UPDATE catalog_items SET value = ?,
      url_key = ?, fingerprint_key = ?, sms_pending = ?, digest_pending = ?, catalog_state = ?,
      catalog_sort_key = ?, search_text = ?, source_classes = ?
      WHERE pk = ? AND sk = 'META' AND kind = 'internship' AND value = ?
        AND EXISTS (SELECT 1 FROM catalog_admission_repair_guards WHERE token = ? AND ok = 1)`)
      .bind(row.proposed_value, row.url_key, row.fingerprint_key, row.sms_pending, row.digest_pending,
        row.catalog_state, row.catalog_sort_key, row.search_text, row.source_classes,
        `JOB#${row.job_id}`, row.original_value, token));
    const occurrenceUpdates = occurrenceStage.results.map((row) => this.db.prepare(`UPDATE catalog_items SET value = ?
      WHERE pk = ? AND sk = ? AND kind = 'source-occurrence' AND value = ?
        AND EXISTS (SELECT 1 FROM catalog_admission_repair_guards WHERE token = ? AND ok = 1)`)
      .bind(row.proposed_value, `SOURCE#${row.source_id}`, `OCCURRENCE#${row.external_id}`, row.original_value, token));
    await this.db.batch([guard, ...updates, ...occurrenceUpdates]);
    const jobMismatches = await this.db.prepare(`SELECT count(*) AS count FROM catalog_admission_repair_stage AS stage
      LEFT JOIN catalog_items AS item ON item.pk = 'JOB#' || stage.job_id AND item.sk = 'META' AND item.kind = 'internship'
      WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.proposed_value)`).bind(token).first<{ count: number }>();
    const occurrenceMismatches = await this.db.prepare(`SELECT count(*) AS count FROM catalog_admission_occurrence_repair_stage AS stage
      LEFT JOIN catalog_items AS item ON item.pk = 'SOURCE#' || stage.source_id
        AND item.sk = 'OCCURRENCE#' || stage.external_id AND item.kind = 'source-occurrence'
      WHERE stage.token = ? AND (item.value IS NULL OR item.value <> stage.proposed_value)`).bind(token).first<{ count: number }>();
    const verificationMismatches = (jobMismatches?.count ?? 0) + (occurrenceMismatches?.count ?? 0);
    if (verificationMismatches) throw new Error(`Admission repair verification found ${verificationMismatches} mismatches`);
    await this.db.batch([
      this.db.prepare('DELETE FROM catalog_admission_repair_stage WHERE token = ?').bind(token),
      this.db.prepare('DELETE FROM catalog_admission_occurrence_repair_stage WHERE token = ?').bind(token),
    ]);
    return { changed: stage.results.length, occurrencesChanged: occurrenceStage.results.length,
      projectionRefreshRequired: stage.results.length > 0, verificationMismatches };
  }
}
