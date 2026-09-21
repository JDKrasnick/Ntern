import { createHash } from 'node:crypto';
import type { D1Database } from '../cloudflare/types.js';
import { postingIdentityRepairPlan, type PostingIdentityRepairPlan } from './posting-identity-repair.js';

/**
 * Paged, memory-bounded posting-identity integrity audit.
 *
 * The authoritative repair plan needs the whole catalog in one pass, which does
 * not fit a Worker invocation at production size (measured 787 MB peak resident
 * set against the 2026-09-14 production snapshot). This audit runs that same
 * plan over catalog slices and merges the compact facts it returns, then
 * resolves multi-member identity groups once with their exact rows.
 *
 * Fidelity is deliberate. Every counter is per-row (additive), keyed (merged
 * first-value-wins, matching the single-pass insertion order), or re-derived by
 * the final group pass. `test/posting-identity-audit.test.ts` pins equality
 * against a single-pass plan over the same catalog, and `docs/DEPLOYMENT.md`
 * records the production comparison.
 */

export type PostingIdentityAuditRow = { pk: string; sk: string; kind: string; value: string };
type Row = PostingIdentityAuditRow;
type Plan = ReturnType<typeof postingIdentityRepairPlan>;

/** Catalog rows per D1 read. Bounds one result set; it does not cap the audit. */
const IDENTITY_AUDIT_READ_LIMIT = 500;
/** Jobs per plan pass. Sized so one pass stays far below the Worker limit. */
const IDENTITY_AUDIT_JOB_BATCH = 500;

/** Slice context. Alias claims and notification history are group- and
 * catalog-wide comparisons: they belong to the final group pass, where the
 * whole membership is present, not to a slice that sees one member at a time. */
const SLICE_KINDS = ['job-id-alias', 'checkpoint'];
const FINALIZE_KINDS = [...SLICE_KINDS, 'posting-alias', 'notification-tombstone', 'notification-event'];
/** Audit mode never materialises writes, so a job head only has to keep
 * `currentJobIds` and occurrence keying global across slices. */
const JOB_HEAD_KEYS = ['jobId'];

/**
 * Read-only projection for the paged audit. It drops or summarises the fields
 * the identity plan never reads by name: `roleMetadata`, `internshipIdentity`
 * beyond the reviewed company ID, occurrence metadata evidence beyond its slot
 * and digest, the write-only metadata extraction envelope, and reference-level
 * admission, which only ever reaches a repair write payload. Everything the
 * audit reports is kept verbatim. The guarded repair keeps using full rows.
 */
export function compactIdentityValue(kind: string, value: string): string {
  if (kind !== 'internship' && kind !== 'source-occurrence') return value;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(value) as Record<string, unknown>; } catch { return value; }
  if (kind === 'internship') {
    delete parsed.roleMetadata;
    const identity = parsed.internshipIdentity as { company?: { canonicalId?: string } } | undefined;
    if (identity) parsed.internshipIdentity = { company: { canonicalId: identity.company?.canonicalId } };
    else delete parsed.internshipIdentity;
    if (Array.isArray(parsed.sourceReferences)) parsed.sourceReferences = parsed.sourceReferences.map(compactReference);
  } else if (parsed.occurrence) parsed.occurrence = compactReference(parsed.occurrence);
  return JSON.stringify(parsed);
}

function compactReference(reference: unknown): unknown {
  if (!reference || typeof reference !== 'object') return reference;
  const record = { ...(reference as Record<string, unknown>) };
  delete record.sourceMetadataProcessing;
  delete record.requirements;
  delete record.compensation;
  delete record.metadataExtraction;
  delete record.admission;
  if (Array.isArray(record.metadataEvidence)) {
    record.metadataEvidence = record.metadataEvidence.map((item) => {
      const evidence = item as Record<string, unknown>;
      return { sourceClass: evidence.sourceClass, sourceId: evidence.sourceId, digest: digest(item) };
    });
  }
  return record;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function identityJobHead(value: string): string {
  let job: Record<string, unknown>;
  try { job = JSON.parse(value) as Record<string, unknown>; } catch { return '{"sourceReferences":[]}'; }
  const head: Record<string, unknown> = { sourceReferences: [] };
  for (const key of JOB_HEAD_KEYS) if (job[key] !== undefined) head[key] = job[key];
  return JSON.stringify(head);
}

export interface PostingIdentityAuditReport {
  schemaVersion: 1;
  pages: number;
  jobsScanned: number;
  occurrenceCounts: PostingIdentityRepairPlan['occurrenceCounts'];
  gate: PostingIdentityRepairPlan['gate'];
  duplicateAlertGroups: number;
  unknownUrlFamilyCandidates: PostingIdentityRepairPlan['unknownUrlFamilyCandidates'];
  /** Aggregate source patterns for operational follow-up; role identifiers stay private. */
  unconfirmedSources: Array<{ sourceId: string; occurrences: number }>;
  providerGroups: number;
  duplicateGroups: number;
  duplicateJobs: number;
  eligibleDuplicateGroups: number;
  eligibleDuplicateJobs: number;
  unresolvedDuplicateGroups: number;
  presentationDisagreements: PostingIdentityRepairPlan['presentationDisagreements'];
  samples: PostingIdentityRepairPlan['samples'];
  conflicts: string[];
  outboxRows: number;
}

export type PostingIdentityGroupMember = { jobId: string; firstSeenAt: string };
type GroupMember = PostingIdentityGroupMember;

export type PostingIdentityRepairIndex = {
  /** Every reviewed provider group, including singletons. Groups are complete
   * across catalog pages, so a repair batch never splits one identity. */
  groups: Array<{ providerIdentity: string; members: PostingIdentityGroupMember[] }>;
  /** Minimal job rows keep current-job and alias validation global without
   * retaining every full internship document. */
  jobHeads: PostingIdentityAuditRow[];
  /** Durable occurrence locators by the job ID stored on the occurrence row.
   * The repair fetches full values only for the groups in its current batch. */
  occurrenceKeysByJob: Array<{ jobId: string; keys: Array<[string, string]> }>;
};

export type PostingIdentityAuditScan = {
  report: PostingIdentityAuditReport;
  repairIndex: PostingIdentityRepairIndex;
};

type AuditFacts = {
  pages: number;
  jobsScanned: number;
  occurrenceDecisions: Map<string, string | null>;
  unconfirmedFamilies: Map<string, string>;
  unconfirmedSources: Map<string, number>;
  groupMembers: Map<string, GroupMember[]>;
  groupAliases: Array<[string, string]>;
  conflicts: Set<string>;
  projectionMismatches: number;
  duplicateOccurrenceReferences: number;
  danglingOccurrenceReferences: number;
};

function mergeScan(facts: AuditFacts, plan: Plan): void {
  for (const [key, status] of plan.scan.occurrenceDecisions) {
    if (!facts.occurrenceDecisions.has(key)) facts.occurrenceDecisions.set(key, status);
  }
  for (const [occurrenceKey, family] of plan.scan.unconfirmedFamilies) {
    if (!facts.unconfirmedFamilies.has(occurrenceKey)) {
      facts.unconfirmedFamilies.set(occurrenceKey, family);
      const sourceId = occurrenceKey.split('\0', 1)[0];
      if (sourceId) facts.unconfirmedSources.set(sourceId, (facts.unconfirmedSources.get(sourceId) ?? 0) + 1);
    }
  }
  for (const [key, jobId, firstSeenAt] of plan.scan.groupMembers) {
    const members = facts.groupMembers.get(key) ?? [];
    if (!members.some((member) => member.jobId === jobId)) members.push({ jobId, firstSeenAt });
    facts.groupMembers.set(key, members);
  }
  facts.groupAliases.push(...plan.scan.groupAliases);
  for (const conflict of plan.conflicts) facts.conflicts.add(conflict);
  facts.projectionMismatches += plan.gate.projectionMismatches;
  facts.duplicateOccurrenceReferences += plan.gate.duplicateOccurrenceReferences;
  facts.danglingOccurrenceReferences += plan.gate.danglingOccurrenceReferences;
}

/** Earliest first sighting wins, then job ID, matching the plan's ordering. */
function canonicalGroupJobId(members: GroupMember[]): string {
  return [...members].sort((left, right) => left.firstSeenAt.localeCompare(right.firstSeenAt)
    || left.jobId.localeCompare(right.jobId))[0]!.jobId;
}

async function scanPostingIdentityAudit(db: D1Database, options: {
  jobBatch?: number;
  log?: (event: string) => void;
} = {}): Promise<PostingIdentityAuditScan> {
  const jobBatch = Math.max(1, Math.min(options.jobBatch ?? IDENTITY_AUDIT_JOB_BATCH, 2_000));
  const sliceRows = await readSmallRows(db, SLICE_KINDS);
  const finalizeRows = sliceRows.concat(await readSmallRows(db, FINALIZE_KINDS.slice(SLICE_KINDS.length)));
  const [employerMappings, presentationReviews, incidents] = await Promise.all([
    db.prepare(`SELECT provider, scope, canonical_employer_id FROM employer_mappings
      WHERE superseded_at IS NULL ORDER BY provider, scope`).all(),
    db.prepare(`SELECT id, provider, tenant, posting_id, company, title, location,
        locations_json, apply_url, evidence_url, evidence_hash, reviewed_at, reviewed_by
      FROM posting_identity_presentation_reviews ORDER BY id`).all(),
    db.prepare("SELECT COUNT(*) AS count FROM catalog_items WHERE kind = 'posting-identity-incident'").first<{ count: number }>(),
  ]);

  // Occurrence rows are indexed before the job walk so each slice receives its
  // own occurrences and no slice holds the whole occurrence catalog.
  const occurrenceKeysByJob = new Map<string, Array<[string, string]>>();
  const orphanOccurrences: Row[] = [];
  const heads: Array<{ row: Row; pk: string }> = [];
  {
    let after: [string, string] | undefined;
    for (;;) {
      const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
        WHERE kind = 'source-occurrence' AND (pk > ? OR (pk = ? AND sk > ?)) ORDER BY pk, sk LIMIT ?`)
        .bind(after?.[0] ?? '', after?.[0] ?? '', after?.[1] ?? '', IDENTITY_AUDIT_READ_LIMIT).all<Row>();
      for (const row of page.results) {
        let jobId: unknown;
        try { jobId = (JSON.parse(row.value) as { jobId?: unknown }).jobId; } catch { jobId = undefined; }
        if (typeof jobId === 'string' && jobId) {
          occurrenceKeysByJob.set(jobId, [...(occurrenceKeysByJob.get(jobId) ?? []), [row.pk, row.sk]]);
        }
        else orphanOccurrences.push({ ...row, value: compactIdentityValue('source-occurrence', row.value) });
      }
      if (page.results.length < IDENTITY_AUDIT_READ_LIMIT) break;
      const last = page.results[page.results.length - 1]!;
      after = [last.pk, last.sk];
    }
    for (const row of await readKindRows(db, 'internship', (job) => ({ ...job, value: identityJobHead(job.value) }))) {
      heads.push({ row, pk: row.pk });
    }
  }

  const facts: AuditFacts = {
    pages: 0, jobsScanned: 0, occurrenceDecisions: new Map(), unconfirmedFamilies: new Map(), unconfirmedSources: new Map(),
    groupMembers: new Map(), groupAliases: [], conflicts: new Set(),
    projectionMismatches: 0, duplicateOccurrenceReferences: 0, danglingOccurrenceReferences: 0,
  };
  const planOf = (catalog: Row[]) => postingIdentityRepairPlan(catalog as never, [], [],
    'all',
    { employerMappings: employerMappings.results, presentationReviews: presentationReviews.results } as never, 'audit');

  const jobAlias = new Map<string, string>();
  const aliasClaims = new Map<string, string>();
  for (const row of finalizeRows) {
    if (row.kind === 'job-id-alias') {
      try {
        const alias = JSON.parse(row.value) as { oldJobId?: string; canonicalJobId?: string };
        if (alias.oldJobId && alias.canonicalJobId) jobAlias.set(alias.oldJobId, alias.canonicalJobId);
      } catch { /* The plan reports malformed alias rows. */ }
    }
    if (row.kind !== 'posting-alias') continue;
    try {
      const claim = JSON.parse(row.value) as { alias?: string; canonicalJobId?: string };
      if (claim.alias && claim.canonicalJobId) aliasClaims.set(claim.alias, claim.canonicalJobId);
    } catch { /* The final group pass reports malformed claim rows. */ }
  }

  let after: [string, string] | undefined;
  for (;;) {
    const jobs = await readJobBatch(db, after, jobBatch);
    if (!jobs.length) break;
    const last = jobs[jobs.length - 1]!;
    after = [last.pk, last.sk];
    const jobIds = new Set<string>();
    for (const row of jobs) {
      try {
        const jobId = (JSON.parse(row.value) as { jobId?: unknown }).jobId;
        if (typeof jobId === 'string' && jobId) jobIds.add(jobId);
      } catch { /* Malformed rows are reported by the plan. */ }
    }
    const slice = jobs.map((row) => ({ ...row, value: compactIdentityValue('internship', row.value) }));
    // A retired job ID resolves to its canonical job, and the plan attaches the
    // occurrence to that job, so the slice has to carry those rows too.
    for (const [oldJobId, canonicalJobId] of jobAlias) if (jobIds.has(canonicalJobId)) jobIds.add(oldJobId);
    const occurrences = await readOccurrenceRowsByKey(db,
      [...jobIds].flatMap((jobId) => occurrenceKeysByJob.get(jobId) ?? []));
    const pageContext = sliceRows.filter((row) => {
      if (row.kind !== 'job-id-alias') return true;
      try {
        const alias = JSON.parse(row.value) as { oldJobId?: string; canonicalJobId?: string };
        return Boolean((alias.oldJobId && jobIds.has(alias.oldJobId))
          || (alias.canonicalJobId && jobIds.has(alias.canonicalJobId)));
      } catch { return true; }
    });
    const plan = planOf([...slice, ...occurrences, ...pageContext]);
    mergeScan(facts, plan);
    facts.pages += 1;
    facts.jobsScanned += jobs.length;
    options.log?.(JSON.stringify({ event: 'posting_identity_audit_page', page: facts.pages, jobs: jobs.length }));
    if (jobs.length < jobBatch) break;
  }

  // Occurrences whose job row is gone still carry coverage and family facts.
  const survivors = new Set(heads.map((head) => head.pk.slice('JOB#'.length)));
  const leftover = [...orphanOccurrences, ...await readOccurrenceRowsByKey(db, [...occurrenceKeysByJob]
    .filter(([jobId]) => !survivors.has(jobAlias.get(jobId) ?? jobId)).flatMap(([, keys]) => keys))];
  if (leftover.length || facts.pages === 0) {
    mergeScan(facts, planOf([...heads.map((head) => head.row), ...leftover, ...sliceRows]));
    facts.pages += 1;
  }

  // Multi-member groups need their whole membership in one pass to certify
  // duplicates, presentation disagreements, and their alias claims.
  const duplicateJobIds = [...facts.groupMembers.values()].filter((members) => members.length > 1)
    .flatMap((members) => members.map((member) => member.jobId));
  const detailRows = duplicateJobIds.length ? await readJobsByJobId(db, duplicateJobIds) : [];
  const detailPks = new Set(detailRows.map((row) => row.pk));
  const detail = planOf([...detailRows,
    ...heads.filter((head) => !detailPks.has(head.pk)).map((head) => head.row),
    ...await readOccurrenceRowsByKey(db,
      duplicateJobIds.flatMap((jobId) => occurrenceKeysByJob.get(jobId) ?? [])), ...finalizeRows]);
  for (const conflict of detail.conflicts) facts.conflicts.add(conflict);

  // Group claims are certified outside the group pass so the check stays global:
  // the group pass only sees multi-member groups, and a claim row is remapped
  // rather than reported when its job is a duplicate member of its own group.
  const groupKeyByAlias = new Map<string, string>();
  for (const [key, alias] of facts.groupAliases) groupKeyByAlias.set(alias, key);
  const disagreeing = new Set(detail.presentationDisagreements.flatMap((disagreement) => disagreement.duplicateJobIds));
  for (const [alias, key] of groupKeyByAlias) {
    const claimed = aliasClaims.get(alias);
    const members = facts.groupMembers.get(key);
    if (!claimed || !members) continue;
    const canonical = canonicalGroupJobId(members);
    if (members.some((member) => member.jobId !== canonical && disagreeing.has(member.jobId))) continue;
    if (claimed !== canonical && members.some((member) => member.jobId === claimed)) continue;
    if (claimed !== canonical) facts.conflicts.add(`${alias}: already claimed by ${claimed}`);
  }

  const statuses = [...facts.occurrenceDecisions.values()];
  const confirmed = statuses.filter((status) => status === 'confirmed').length;
  const unconfirmed = statuses.filter((status) => status === 'unconfirmed').length;
  const legacy = statuses.filter((status) => status === null).length;
  const untrackedQuarantines = statuses.filter((status) => status === 'quarantined').length;
  const classified = confirmed + unconfirmed;
  const sortedConflicts = [...facts.conflicts].sort();
  const { presentationDisagreements, eligibleDuplicateGroups, eligibleDuplicateJobs, duplicateAlertGroups } = detail;
  const familyCounts = new Map<string, number>();
  for (const family of facts.unconfirmedFamilies.values()) familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  const report: PostingIdentityAuditReport = {
    schemaVersion: 1,
    pages: facts.pages,
    jobsScanned: facts.jobsScanned,
    occurrenceCounts: {
      confirmed, unconfirmed, legacy,
      quarantined: Number(incidents?.count ?? 0),
      confirmedCoverage: classified ? confirmed / classified : null,
    },
    gate: {
      passed: eligibleDuplicateGroups === 0 && sortedConflicts.length === 0 && untrackedQuarantines === 0
        && presentationDisagreements.length === 0 && duplicateAlertGroups === 0 && legacy === 0
        && facts.projectionMismatches === 0 && facts.duplicateOccurrenceReferences === 0
        && facts.danglingOccurrenceReferences === 0,
      exactDuplicateGroups: eligibleDuplicateGroups,
      aliasConflicts: sortedConflicts.length,
      untrackedQuarantines,
      presentationBlockers: presentationDisagreements.length,
      legacyOccurrences: legacy,
      projectionMismatches: facts.projectionMismatches,
      duplicateOccurrenceReferences: facts.duplicateOccurrenceReferences,
      danglingOccurrenceReferences: facts.danglingOccurrenceReferences,
    },
    duplicateAlertGroups,
    unknownUrlFamilyCandidates: [...familyCounts.entries()].filter(([, count]) => count > 1)
      .map(([reviewFamilyKey, occurrences]) => ({ reviewFamilyKey, occurrences }))
      .sort((left, right) => right.occurrences - left.occurrences || left.reviewFamilyKey.localeCompare(right.reviewFamilyKey)),
    unconfirmedSources: [...facts.unconfirmedSources.entries()]
      .map(([sourceId, occurrences]) => ({ sourceId, occurrences }))
      .sort((left, right) => right.occurrences - left.occurrences || left.sourceId.localeCompare(right.sourceId)),
    providerGroups: facts.groupMembers.size,
    duplicateGroups: detail.duplicateGroups,
    duplicateJobs: detail.duplicateJobs,
    eligibleDuplicateGroups,
    eligibleDuplicateJobs,
    unresolvedDuplicateGroups: presentationDisagreements.length,
    presentationDisagreements,
    samples: detail.samples,
    conflicts: sortedConflicts,
    outboxRows: detail.outboxRows,
  };
  return {
    report,
    repairIndex: {
      groups: [...facts.groupMembers.entries()]
        .map(([providerIdentity, members]) => ({ providerIdentity, members: [...members] }))
        .sort((left, right) => left.providerIdentity.localeCompare(right.providerIdentity)),
      jobHeads: heads.map((head) => head.row),
      occurrenceKeysByJob: [...occurrenceKeysByJob.entries()]
        .map(([jobId, keys]) => ({ jobId, keys }))
        .sort((left, right) => left.jobId.localeCompare(right.jobId)),
    },
  };
}

export async function runPostingIdentityAudit(db: D1Database, options: {
  jobBatch?: number;
  log?: (event: string) => void;
} = {}): Promise<PostingIdentityAuditReport> {
  return (await scanPostingIdentityAudit(db, options)).report;
}

/** Internal repair preflight. It exposes only compact locators and complete
 * identity membership; full catalog and occurrence values remain paged. */
export async function runPostingIdentityAuditScan(db: D1Database, options: {
  jobBatch?: number;
  log?: (event: string) => void;
} = {}): Promise<PostingIdentityAuditScan> {
  return scanPostingIdentityAudit(db, options);
}

/**
 * One page walk per catalog kind. Every audit read is a bounded keyset page, so
 * no single query ever materialises a production-sized result set.
 */
async function readKindRows(db: D1Database, kind: string, project?: (row: Row) => Row): Promise<Row[]> {
  const rows: Row[] = [];
  let after: [string, string] | undefined;
  for (;;) {
    const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
      WHERE kind = ? AND (pk > ? OR (pk = ? AND sk > ?)) ORDER BY pk, sk LIMIT ?`)
      .bind(kind, after?.[0] ?? '', after?.[0] ?? '', after?.[1] ?? '', IDENTITY_AUDIT_READ_LIMIT).all<Row>();
    for (const row of page.results) rows.push(project ? project(row) : row);
    if (page.results.length < IDENTITY_AUDIT_READ_LIMIT) return rows;
    const last = page.results[page.results.length - 1]!;
    after = [last.pk, last.sk];
  }
}

async function readSmallRows(db: D1Database, kinds: readonly string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const kind of kinds) rows.push(...await readKindRows(db, kind));
  return rows;
}

async function readJobBatch(db: D1Database, after: [string, string] | undefined, limit: number): Promise<Row[]> {
  const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
    WHERE kind = 'internship' AND (pk > ? OR (pk = ? AND sk > ?))
    ORDER BY pk, sk LIMIT ?`)
    .bind(after?.[0] ?? '', after?.[0] ?? '', after?.[1] ?? '', limit).all<Row>();
  return page.results;
}

async function readOccurrenceRowsByKey(db: D1Database, keys: Array<[string, string]>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < keys.length; offset += 40) {
    const chunk = keys.slice(offset, offset + 40);
    const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
      WHERE kind = 'source-occurrence' AND (${chunk.map(() => '(pk = ? AND sk = ?)').join(' OR ')})
      ORDER BY pk, sk`).bind(...chunk.flat()).all<Row>();
    rows.push(...page.results.map((row) => ({ ...row, value: compactIdentityValue('source-occurrence', row.value) })));
  }
  return rows;
}

async function readJobsByJobId(db: D1Database, jobIds: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < jobIds.length; offset += 50) {
    const pks = jobIds.slice(offset, offset + 50).map((jobId) => `JOB#${jobId}`);
    const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
      WHERE kind = 'internship' AND pk IN (${pks.map(() => '?').join(', ')})`).bind(...pks).all<Row>();
    rows.push(...page.results.map((row) => ({ ...row, value: compactIdentityValue('internship', row.value) })));
  }
  return rows;
}
