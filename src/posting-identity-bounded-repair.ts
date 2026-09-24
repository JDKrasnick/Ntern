import { createHash } from 'node:crypto';
import type { D1Database } from '../cloudflare/types.js';
import {
  runPostingIdentityAuditScan,
  type PostingIdentityAuditRow,
  type PostingIdentityGroupMember,
} from './posting-identity-audit.js';
import {
  applyPostingIdentityRepairPlan,
  postingIdentityRepairPlan,
  validatePostingIdentityRepairApply,
  type InternalPostingIdentityRepairPlan,
  type PostingIdentityApplyBatch,
  type PostingIdentityRepairPlan,
} from './posting-identity-repair.js';

type UserRow = {
  user_id: string;
  item_key: string;
  kind: string;
  value: string;
  session_id?: string | null;
  receipt_state?: string | null;
  expires_at?: number | null;
};
type ProposalRow = { id: string; job_id: string };
type EmployerMappingRow = { provider: string; scope: string; canonical_employer_id: string };
type PresentationReviewRow = {
  id: string;
  provider: string;
  tenant: string;
  posting_id: string;
  company: string;
  title: string;
  location: string;
  locations_json: string;
  apply_url: string;
  evidence_url: string;
  evidence_hash: string;
  reviewed_at: string;
  reviewed_by: string;
};
type PostingUrlCorrectionRow = {
  id: string;
  provider: string;
  tenant: string;
  posting_id: string;
  observed_url: string;
  canonical_url: string;
  evidence_url: string;
  evidence_hash: string;
  reviewed_at: string;
  reviewed_by: string;
};
type PostingWithdrawalRow = {
  id: string;
  provider: string;
  tenant: string;
  posting_id: string;
  evidence_url: string;
  evidence_hash: string;
  reviewed_at: string;
  reviewed_by: string;
};

const READ_PAGE = 500;
const GROUP_JOBS_PER_BATCH = 100;
const KEY_PAIRS_PER_READ = 40;
const JOB_IDS_PER_READ = 50;
const CONTEXT_KINDS = ['job-id-alias', 'checkpoint', 'posting-alias', 'notification-tombstone', 'notification-event'] as const;
/** One keyset page of the durable occurrence index. Only the owning job ID is
 * projected; the multi-kilobyte occurrence bodies are read per repaired group. */
const OCCURRENCE_INDEX_PAGE = 500;
/** Queue-tolerant occurrence batch envelope. It mirrors the reviewed low-impact
 * identity batch limits enforced by the Worker bulk-window gate. */
const OCCURRENCE_BATCH_JOBS = 100;
const OCCURRENCE_BATCH_REFERENCES = 125;
const OCCURRENCE_BATCH_CONTEXT = 125;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stable(item)]));
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function batches(groups: Array<{ providerIdentity: string; members: PostingIdentityGroupMember[] }>, limit: number) {
  const result: typeof groups[] = [];
  let current: typeof groups = [];
  let jobs = 0;
  for (const group of groups) {
    if (current.length && jobs + group.members.length > limit) {
      result.push(current);
      current = [];
      jobs = 0;
    }
    current.push(group);
    jobs += group.members.length;
  }
  if (current.length) result.push(current);
  return result;
}

async function readKindRows(db: D1Database, kind: string): Promise<PostingIdentityAuditRow[]> {
  const rows: PostingIdentityAuditRow[] = [];
  let afterPk = '';
  let afterSk = '';
  for (;;) {
    const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
      WHERE kind = ? AND (pk > ? OR (pk = ? AND sk > ?))
      ORDER BY pk, sk LIMIT ?`).bind(kind, afterPk, afterPk, afterSk, READ_PAGE).all<PostingIdentityAuditRow>();
    rows.push(...page.results);
    if (page.results.length < READ_PAGE) return rows;
    const last = page.results.at(-1)!;
    if (last.pk === afterPk && last.sk === afterSk) throw new Error(`Posting identity ${kind} scan did not advance`);
    afterPk = last.pk;
    afterSk = last.sk;
  }
}

async function readContextRows(db: D1Database): Promise<PostingIdentityAuditRow[]> {
  const rows: PostingIdentityAuditRow[] = [];
  for (const kind of CONTEXT_KINDS) rows.push(...await readKindRows(db, kind));
  return rows;
}

async function readJobs(db: D1Database, jobIds: string[]): Promise<PostingIdentityAuditRow[]> {
  const rows: PostingIdentityAuditRow[] = [];
  for (let offset = 0; offset < jobIds.length; offset += JOB_IDS_PER_READ) {
    const pks = jobIds.slice(offset, offset + JOB_IDS_PER_READ).map((jobId) => `JOB#${jobId}`);
    const page = await db.prepare(`SELECT * FROM catalog_items
      WHERE kind = 'internship' AND pk IN (${pks.map(() => '?').join(', ')}) ORDER BY pk, sk`)
      .bind(...pks).all<PostingIdentityAuditRow>();
    rows.push(...page.results);
  }
  return rows;
}

async function readOccurrenceRows(db: D1Database, keys: Array<[string, string]>): Promise<PostingIdentityAuditRow[]> {
  const rows: PostingIdentityAuditRow[] = [];
  for (let offset = 0; offset < keys.length; offset += KEY_PAIRS_PER_READ) {
    const chunk = keys.slice(offset, offset + KEY_PAIRS_PER_READ);
    const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
      WHERE kind = 'source-occurrence' AND (${chunk.map(() => '(pk = ? AND sk = ?)').join(' OR ')})
      ORDER BY pk, sk`).bind(...chunk.flat()).all<PostingIdentityAuditRow>();
    rows.push(...page.results);
  }
  return rows;
}

async function readUserRows(db: D1Database): Promise<UserRow[]> {
  const rows: UserRow[] = [];
  let afterUserId = '';
  let afterItemKey = '';
  for (;;) {
    const page = await db.prepare(`SELECT * FROM user_items
      WHERE kind IN ('application', 'application-session', 'receipt', 'catalog-release')
        AND (user_id > ? OR (user_id = ? AND item_key > ?))
      ORDER BY user_id, item_key LIMIT ?`)
      .bind(afterUserId, afterUserId, afterItemKey, READ_PAGE).all<UserRow>();
    rows.push(...page.results);
    if (page.results.length < READ_PAGE) return rows;
    const last = page.results.at(-1)!;
    if (last.user_id === afterUserId && last.item_key === afterItemKey) throw new Error('Posting identity user scan did not advance');
    afterUserId = last.user_id;
    afterItemKey = last.item_key;
  }
}

/**
 * A duplicate-only repair can touch user history only for a member of one of
 * its selected provider groups. Reading every saved application and release
 * turns a small, guarded duplicate repair into an unbounded request at
 * production scale. The JSON predicates inspect job-ID fields and release
 * arrays exactly, and the repair planner parses every candidate again before
 * it can be written.
 */
async function readUserRowsForJobs(db: D1Database, jobIds: Iterable<string>): Promise<UserRow[]> {
  const ids = [...new Set(jobIds)].sort();
  if (!ids.length) return [];
  const rows = new Map<string, UserRow>();
  for (let offset = 0; offset < ids.length; offset += 20) {
    const chunk = ids.slice(offset, offset + 20);
    const placeholders = chunk.map(() => '?').join(', ');
    const page = await db.prepare(`SELECT * FROM user_items
      WHERE (kind IN ('application', 'application-session', 'receipt')
        AND json_extract(value, '$.jobId') IN (${placeholders}))
        OR (kind = 'catalog-release' AND (
          EXISTS (SELECT 1 FROM json_each(user_items.value, '$.jobIds') WHERE value IN (${placeholders}))
          OR EXISTS (SELECT 1 FROM json_each(user_items.value, '$.newJobIds') WHERE value IN (${placeholders}))
        ))
      ORDER BY user_id, item_key`)
      .bind(...chunk, ...chunk, ...chunk).all<UserRow>();
    for (const row of page.results) rows.set(`${row.user_id}\0${row.item_key}`, row);
  }
  return [...rows.values()].sort((left, right) => left.user_id.localeCompare(right.user_id)
    || left.item_key.localeCompare(right.item_key));
}

async function readContextRowsForJobs(db: D1Database, jobIds: Iterable<string>): Promise<PostingIdentityAuditRow[]> {
  const ids = [...new Set(jobIds)].sort();
  const rows = await readKindRows(db, 'checkpoint');
  if (!ids.length) return rows;
  const byKey = new Map(rows.map((row) => [`${row.pk}\0${row.sk}`, row]));
  for (let offset = 0; offset < ids.length; offset += 25) {
    const chunk = ids.slice(offset, offset + 25);
    const placeholders = chunk.map(() => '?').join(', ');
    const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
      WHERE kind IN ('job-id-alias', 'posting-alias', 'notification-tombstone', 'notification-event')
        AND (json_extract(value, '$.jobId') IN (${placeholders})
          OR json_extract(value, '$.oldJobId') IN (${placeholders})
          OR json_extract(value, '$.canonicalJobId') IN (${placeholders}))
      ORDER BY pk, sk`).bind(...chunk, ...chunk, ...chunk).all<PostingIdentityAuditRow>();
    for (const row of page.results) byKey.set(`${row.pk}\0${row.sk}`, row);
  }
  return [...byKey.values()].sort((left, right) => left.pk.localeCompare(right.pk) || left.sk.localeCompare(right.sk));
}

function simulateUserRows(rows: UserRow[], plan: InternalPostingIdentityRepairPlan): UserRow[] {
  const byKey = new Map(rows.map((row) => [`${row.user_id}\0${row.item_key}`, row]));
  for (const row of plan.userDeletes) byKey.delete(`${row.user_id}\0${row.item_key}`);
  for (const write of plan.userWrites) {
    const before = byKey.get(`${write.userId}\0${write.itemKey}`);
    byKey.set(`${write.userId}\0${write.itemKey}`, {
      ...(before ?? { user_id: write.userId, item_key: write.itemKey }),
      kind: write.kind,
      value: write.value,
      ...(write.columns?.receipt_state !== undefined ? { receipt_state: write.columns.receipt_state } : {}),
      ...(write.columns?.expires_at !== undefined ? { expires_at: write.columns.expires_at } : {}),
    });
  }
  return [...byKey.values()].sort((left, right) => left.user_id.localeCompare(right.user_id)
    || left.item_key.localeCompare(right.item_key));
}

type WriteFact = { kind: string; before: string | null; value: string };
type DeleteFact = { kind: string; value: string };

function hashed(value: string | null | undefined): string | null {
  return value == null ? null : digest(value);
}

function coalesceWriteFacts(target: Map<string, WriteFact>, key: string, fact: WriteFact): void {
  const previous = target.get(key);
  target.set(key, previous ? { ...fact, before: previous.before ?? fact.before } : fact);
}

function contextForJobs(rows: PostingIdentityAuditRow[], jobIds: Set<string>): PostingIdentityAuditRow[] {
  return rows.filter((row) => {
    if (row.kind === 'checkpoint') return true;
    try {
      const value = JSON.parse(row.value) as { jobId?: unknown; oldJobId?: unknown; canonicalJobId?: unknown };
      const ids = [value.jobId, value.oldJobId, value.canonicalJobId].filter((item): item is string => typeof item === 'string');
      return ids.length === 0 || ids.some((jobId) => jobIds.has(jobId));
    } catch { return true; }
  });
}

export async function runBoundedPostingIdentityRepair(db: D1Database, options: {
  apply?: boolean;
  repairToken?: string;
  expectedChanges?: number;
  expectedDuplicateJobs?: number;
  acceptCurrentSnapshot?: boolean;
  expectedEligibleDuplicateGroups?: number;
  expectedUnresolvedDuplicateGroups?: number;
  jobBatch?: number;
  duplicateGroupsOnly?: boolean;
  log?: (event: string) => void;
} = {}): Promise<PostingIdentityRepairPlan> {
  // Repair atomicity and audit read efficiency are separate controls. A
  // one-group repair must not degrade the full-catalog audit into one-job
  // queries, which can exceed the request wall-time before planning starts.
  const auditJobBatch = Math.max(GROUP_JOBS_PER_BATCH, options.jobBatch ?? GROUP_JOBS_PER_BATCH);
  const scan = await runPostingIdentityAuditScan(db, { jobBatch: auditJobBatch, log: options.log });
  const selectedGroups = options.duplicateGroupsOnly
    ? scan.repairIndex.groups.filter((group) => group.members.length > 1)
    : scan.repairIndex.groups;
  const selectedJobIds = selectedGroups.flatMap((group) => group.members.map((member) => member.jobId));
  const [contextRows, users] = options.duplicateGroupsOnly
    ? await Promise.all([readContextRowsForJobs(db, selectedJobIds), readUserRowsForJobs(db, selectedJobIds)])
    : await Promise.all([readContextRows(db), readUserRows(db)]);
  const proposals = (await db.prepare('SELECT id, job_id FROM employer_field_proposals ORDER BY id').all<ProposalRow>()).results;
  const employerMappings = (await db.prepare(`SELECT provider, scope, canonical_employer_id FROM employer_mappings
    WHERE superseded_at IS NULL ORDER BY provider, scope`).all<EmployerMappingRow>()).results;
  const presentationReviews = (await db.prepare(`SELECT id, provider, tenant, posting_id, company, title, location,
      locations_json, apply_url, evidence_url, evidence_hash, reviewed_at, reviewed_by
    FROM posting_identity_presentation_reviews ORDER BY id`).all<PresentationReviewRow>()).results;
  const urlCorrections = (await db.prepare(`SELECT id, provider, tenant, posting_id, observed_url, canonical_url,
      evidence_url, evidence_hash, reviewed_at, reviewed_by
    FROM posting_url_corrections ORDER BY id`).all<PostingUrlCorrectionRow>()).results;
  const withdrawals = (await db.prepare(`SELECT id, provider, tenant, posting_id, evidence_url, evidence_hash,
      reviewed_at, reviewed_by FROM posting_withdrawal_reviews ORDER BY id`).all<PostingWithdrawalRow>()).results;

  const occurrenceKeys = new Map(scan.repairIndex.occurrenceKeysByJob.map((item) => [item.jobId, item.keys]));
  const jobAliases = new Map<string, string>();
  for (const row of contextRows.filter((item) => item.kind === 'job-id-alias')) {
    try {
      const value = JSON.parse(row.value) as { oldJobId?: string; canonicalJobId?: string };
      if (value.oldJobId && value.canonicalJobId) jobAliases.set(value.oldJobId, value.canonicalJobId);
    } catch { /* The audit and batch planner report malformed rows. */ }
  }

  const catalogWriteFacts = new Map<string, WriteFact>();
  const catalogDeleteFacts = new Map<string, DeleteFact>();
  const userWriteFacts = new Map<string, WriteFact>();
  const userDeleteFacts = new Map<string, DeleteFact>();
  const proposalUpdateFacts = new Map<string, ProposalRow>();
  const batchDigests: string[] = [];
  const applyBatches: PostingIdentityApplyBatch[] = [];
  const batchConflicts = new Set<string>();
  let simulatedUsers = users;
  let notificationTombstoneRemaps = 0;
  let notificationEventMerges = 0;
  let receiptRemaps = 0;
  let receiptMerges = 0;

  const groupLimit = Math.max(1, Math.min(options.jobBatch ?? GROUP_JOBS_PER_BATCH, 500));
  const groupBatches = batches(selectedGroups, groupLimit);
  for (let batchIndex = 0; batchIndex < groupBatches.length; batchIndex += 1) {
    const groupBatch = groupBatches[batchIndex]!;
    const jobIds = new Set(groupBatch.flatMap((group) => group.members.map((member) => member.jobId)));
    const occurrenceJobIds = new Set(jobIds);
    for (const [oldJobId, canonicalJobId] of jobAliases) if (jobIds.has(canonicalJobId)) occurrenceJobIds.add(oldJobId);
    const fullJobs = await readJobs(db, [...jobIds].sort());
    const keys = [...occurrenceJobIds].flatMap((jobId) => occurrenceKeys.get(jobId) ?? []);
    const occurrences = await readOccurrenceRows(db, keys);
    const batchContextRows = contextForJobs(contextRows, occurrenceJobIds);
    const plan = postingIdentityRepairPlan([
      ...fullJobs,
      ...occurrences,
      ...batchContextRows,
    ] as never, simulatedUsers as never, proposals, 'identity', { employerMappings, presentationReviews, urlCorrections, withdrawals }) as InternalPostingIdentityRepairPlan;

    batchDigests.push(plan.snapshotDigest, plan.repairToken);
    applyBatches.push({
      // Checkpoints can contain multi-megabyte active-id snapshots. Repeating
      // them in every response batch can exceed the Worker string limit, so
      // the apply request re-reads that small row set and the repair token
      // detects any drift. The much larger alias set stays signed inline.
      jobIds: [...jobIds].sort(), contextRows: batchContextRows.filter((row) => row.kind !== 'checkpoint'), occurrenceKeys: keys,
      repairToken: plan.repairToken, expectedChanges: plan.expectedChanges,
      expectedDuplicateJobs: plan.duplicateJobs,
      eligibleDuplicateGroups: plan.eligibleDuplicateGroups,
      unresolvedDuplicateGroups: plan.unresolvedDuplicateGroups,
    });
    for (const conflict of plan.conflicts) batchConflicts.add(conflict);
    for (const write of plan.catalogWrites) coalesceWriteFacts(catalogWriteFacts, `${write.pk}\0${write.sk}`, {
      kind: write.kind, before: hashed(write.before?.value), value: digest(write.value),
    });
    for (const row of plan.catalogDeletes) catalogDeleteFacts.set(`${row.pk}\0${row.sk}`, { kind: row.kind, value: digest(row.value) });
    for (const write of plan.userWrites) coalesceWriteFacts(userWriteFacts, `${write.userId}\0${write.itemKey}`, {
      kind: write.kind, before: hashed(write.before?.value), value: digest(write.value),
    });
    for (const row of plan.userDeletes) userDeleteFacts.set(`${row.user_id}\0${row.item_key}`, { kind: row.kind, value: digest(row.value) });
    for (const row of plan.proposalUpdates) proposalUpdateFacts.set(row.id, row);
    simulatedUsers = simulateUserRows(simulatedUsers, plan);
    notificationTombstoneRemaps += plan.notificationTombstoneRemaps;
    notificationEventMerges += plan.notificationEventMerges;
    receiptRemaps += plan.receiptRemaps;
    receiptMerges += plan.receiptMerges;
    options.log?.(JSON.stringify({ event: 'posting_identity_repair_batch', batch: batchIndex + 1,
      batches: groupBatches.length, groups: groupBatch.length, jobs: jobIds.size }));
  }

  const catalogWriteValues = [...catalogWriteFacts.values()];
  const catalogDeleteValues = [...catalogDeleteFacts.values()];
  const userWriteValues = [...userWriteFacts.values()];
  const userDeleteValues = [...userDeleteFacts.values()];
  const proposalUpdateValues = [...proposalUpdateFacts.values()];
  const conflicts = [...new Set([...scan.report.conflicts, ...batchConflicts])].sort();
  const expectedChanges = catalogWriteValues.length + catalogDeleteValues.length
    + userWriteValues.length + userDeleteValues.length + proposalUpdateValues.length;
  const repairFacts = {
    audit: scan.report,
    batches: batchDigests,
    catalogWrites: [...catalogWriteFacts.entries()],
    catalogDeletes: [...catalogDeleteFacts.entries()],
    userWrites: [...userWriteFacts.entries()],
    userDeletes: [...userDeleteFacts.entries()],
    proposalUpdates: proposalUpdateValues.map((item) => [item.id, item.job_id]),
  };
  const plan: InternalPostingIdentityRepairPlan = {
    schemaVersion: 3,
    scope: 'identity',
    snapshotDigest: digest({ audit: scan.report, batches: batchDigests }),
    repairToken: digest(repairFacts),
    occurrenceCounts: scan.report.occurrenceCounts,
    duplicateAlertGroups: scan.report.duplicateAlertGroups,
    unknownUrlFamilyCandidates: scan.report.unknownUrlFamilyCandidates,
    gate: {
      ...scan.report.gate,
      passed: scan.report.gate.passed && conflicts.length === 0,
      aliasConflicts: conflicts.length,
    },
    providerGroups: scan.report.providerGroups,
    duplicateGroups: scan.report.duplicateGroups,
    duplicateJobs: scan.report.duplicateJobs,
    eligibleDuplicateGroups: scan.report.eligibleDuplicateGroups,
    eligibleDuplicateJobs: scan.report.eligibleDuplicateJobs,
    unresolvedDuplicateGroups: scan.report.unresolvedDuplicateGroups,
    jobUpdates: catalogWriteValues.filter((item) => item.kind === 'internship').length,
    jobDeletes: catalogDeleteValues.filter((item) => item.kind === 'internship').length,
    aliasWrites: catalogWriteValues.filter((item) => item.kind === 'posting-alias' || item.kind === 'job-id-alias').length,
    occurrenceRemaps: 0,
    notificationTombstoneRemaps,
    notificationEventMerges,
    applicationRemaps: userWriteValues.filter((item) => item.kind === 'application').length,
    applicationMerges: userDeleteValues.filter((item) => item.kind === 'application').length,
    sessionRemaps: userWriteValues.filter((item) => item.kind === 'application-session').length,
    receiptRemaps,
    receiptMerges,
    releaseRemaps: userWriteValues.filter((item) => item.kind === 'catalog-release').length,
    proposalRemaps: proposalUpdateValues.length,
    outboxRows: scan.report.outboxRows,
    conflicts,
    presentationDisagreements: scan.report.presentationDisagreements,
    samples: scan.report.samples,
    expectedChanges,
    applied: false,
    projectionRefreshRequired: false,
    applyBatches,
    catalogWrites: [],
    catalogDeletes: [],
    userWrites: [],
    userDeletes: [],
    proposalUpdates: [],
    scan: { occurrenceDecisions: [], unconfirmedFamilies: [], groupMembers: [], groupAliases: [] },
  };
  if (!options.apply) return plan;

  // Validate the compact dry-run facts before materializing any full before/after
  // values. Large repairs that cannot fit inside D1's guarded query budget fail
  // here instead of consuming the Worker's entire 128 MB heap first.
  validatePostingIdentityRepairApply(plan, options);
  if (!plan.expectedChanges) return { ...plan, applied: true };

  simulatedUsers = users;
  for (let batchIndex = 0; batchIndex < groupBatches.length; batchIndex += 1) {
    const groupBatch = groupBatches[batchIndex]!;
    const jobIds = new Set(groupBatch.flatMap((group) => group.members.map((member) => member.jobId)));
    const occurrenceJobIds = new Set(jobIds);
    for (const [oldJobId, canonicalJobId] of jobAliases) if (jobIds.has(canonicalJobId)) occurrenceJobIds.add(oldJobId);
    const fullJobs = await readJobs(db, [...jobIds].sort());
    const keys = [...occurrenceJobIds].flatMap((jobId) => occurrenceKeys.get(jobId) ?? []);
    const occurrences = await readOccurrenceRows(db, keys);
    const batchPlan = postingIdentityRepairPlan([
      ...fullJobs, ...occurrences, ...contextForJobs(contextRows, occurrenceJobIds),
    ] as never, simulatedUsers as never, proposals, 'identity', { employerMappings, presentationReviews, urlCorrections, withdrawals }) as InternalPostingIdentityRepairPlan;
    await applyPostingIdentityRepairPlan(db, batchPlan, {
      repairToken: batchPlan.repairToken,
      expectedChanges: batchPlan.expectedChanges,
      expectedDuplicateJobs: batchPlan.duplicateJobs,
    });
    simulatedUsers = simulateUserRows(simulatedUsers, batchPlan);
    options.log?.(JSON.stringify({ event: 'posting_identity_repair_apply_batch', batch: batchIndex + 1,
      batches: groupBatches.length, groups: groupBatch.length, jobs: jobIds.size,
      changes: batchPlan.expectedChanges }));
  }
  return { ...plan, applied: true, projectionRefreshRequired: true };
}

/**
 * Plan one bounded repair slice from durable rows. The identity and occurrence
 * planners must read the same rows for the same batch so the signed repair
 * token computed here is reproduced when the batch is applied. Occurrence
 * repair never rewrites user history: the identity batches already remapped it,
 * and an occurrence batch only reconciles catalog occurrence pointers.
 */
async function boundedRepairSlicePlan(db: D1Database, options: {
  scope: 'identity' | 'occurrences';
  jobIds: string[];
  contextRows: PostingIdentityAuditRow[];
  occurrenceKeys: Array<[string, string]>;
}): Promise<InternalPostingIdentityRepairPlan> {
  const occurrenceScope = options.scope === 'occurrences';
  const [checkpoints, users, proposals, employerMappings, presentationReviews, urlCorrections, withdrawals, fullJobs, occurrences] = await Promise.all([
    readKindRows(db, 'checkpoint'),
    occurrenceScope ? Promise.resolve([] as UserRow[]) : readUserRowsForJobs(db, options.jobIds),
    db.prepare('SELECT id, job_id FROM employer_field_proposals ORDER BY id').all<ProposalRow>().then((result) => result.results),
    db.prepare(`SELECT provider, scope, canonical_employer_id FROM employer_mappings
      WHERE superseded_at IS NULL ORDER BY provider, scope`).all<EmployerMappingRow>().then((result) => result.results),
    db.prepare(`SELECT id, provider, tenant, posting_id, company, title, location,
        locations_json, apply_url, evidence_url, evidence_hash, reviewed_at, reviewed_by
      FROM posting_identity_presentation_reviews ORDER BY id`).all<PresentationReviewRow>().then((result) => result.results),
    db.prepare(`SELECT id, provider, tenant, posting_id, observed_url, canonical_url, evidence_url,
        evidence_hash, reviewed_at, reviewed_by
      FROM posting_url_corrections ORDER BY id`).all<PostingUrlCorrectionRow>().then((result) => result.results),
    db.prepare(`SELECT id, provider, tenant, posting_id, evidence_url, evidence_hash, reviewed_at, reviewed_by
      FROM posting_withdrawal_reviews ORDER BY id`).all<PostingWithdrawalRow>().then((result) => result.results),
    readJobs(db, [...new Set(options.jobIds)].sort()),
    readOccurrenceRows(db, options.occurrenceKeys),
  ]);
  return postingIdentityRepairPlan([
    ...fullJobs, ...occurrences, ...checkpoints, ...options.contextRows,
  ] as never, users as never, proposals, options.scope, { employerMappings, presentationReviews, urlCorrections, withdrawals }) as InternalPostingIdentityRepairPlan;
}

export async function runBoundedPostingIdentityRepairBatch(db: D1Database, options: {
  scope?: 'identity' | 'occurrences';
  jobIds: string[];
  contextRows: PostingIdentityAuditRow[];
  occurrenceKeys: Array<[string, string]>;
  repairToken: string;
  expectedChanges: number;
  expectedDuplicateJobs: number;
  acceptCurrentSnapshot?: boolean;
  expectedEligibleDuplicateGroups?: number;
  expectedUnresolvedDuplicateGroups?: number;
}): Promise<PostingIdentityRepairPlan> {
  if (!options.jobIds.length || options.jobIds.length > 500) throw new Error('Identity repair batch must contain 1 to 500 jobs');
  if (options.occurrenceKeys.length > 5_000) throw new Error('Identity repair batch contains too many occurrence keys');
  if (options.contextRows.length > 5_000) throw new Error('Identity repair batch contains too many context rows');
  const plan = await boundedRepairSlicePlan(db, {
    scope: options.scope ?? 'identity',
    jobIds: options.jobIds,
    contextRows: options.contextRows,
    occurrenceKeys: options.occurrenceKeys,
  });
  return applyPostingIdentityRepairPlan(db, plan, options);
}

type OccurrenceAlias = { row: PostingIdentityAuditRow; canonicalJobId: string };

/** Durable occurrence rows by owning job ID. The projection keeps every
 * occurrence body out of memory until a repaired group asks for its own. */
async function readOccurrenceIndex(db: D1Database): Promise<Map<string, Array<[string, string]>>> {
  const index = new Map<string, Array<[string, string]>>();
  let afterPk = '';
  let afterSk = '';
  for (;;) {
    const page = await db.prepare(`SELECT pk, sk, json_extract(value, '$.jobId') AS job_id FROM catalog_items
      WHERE kind = 'source-occurrence' AND (pk > ? OR (pk = ? AND sk > ?))
      ORDER BY pk, sk LIMIT ?`)
      .bind(afterPk, afterPk, afterSk, OCCURRENCE_INDEX_PAGE).all<{ pk: string; sk: string; job_id: string | null }>();
    for (const row of page.results) if (row.job_id) {
      index.set(row.job_id, [...(index.get(row.job_id) ?? []), [row.pk, row.sk]]);
    }
    if (page.results.length < OCCURRENCE_INDEX_PAGE) return index;
    const last = page.results.at(-1)!;
    if (last.pk === afterPk && last.sk === afterSk) throw new Error('Posting identity occurrence index did not advance');
    afterPk = last.pk;
    afterSk = last.sk;
  }
}

/** Internship PKs that exist for the given job IDs, read by primary key only. */
async function readExistingJobIds(db: D1Database, jobIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...new Set(jobIds)].sort();
  const existing = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += JOB_IDS_PER_READ) {
    const pks = ids.slice(offset, offset + JOB_IDS_PER_READ).map((jobId) => `JOB#${jobId}`);
    const page = await db.prepare(`SELECT pk FROM catalog_items
      WHERE kind = 'internship' AND pk IN (${pks.map(() => '?').join(', ')})`).bind(...pks).all<{ pk: string }>();
    for (const row of page.results) existing.add(row.pk.slice('JOB#'.length));
  }
  return existing;
}

/**
 * Jobs whose stored identity projection disagrees with the decision derived
 * from their retained references. This is the paged audit's
 * `projectionMismatches` predicate evaluated in one projected page walk, so the
 * repair targets the exact jobs the integrity gate counts without reading an
 * occurrence body or running the audit's per-slice plan.
 */
async function readProjectionMismatchJobIds(db: D1Database): Promise<Set<string>> {
  const mismatched = new Set<string>();
  let afterPk = '';
  let afterSk = '';
  for (;;) {
    const page = await db.prepare(`SELECT pk, sk, json_extract(value, '$.jobId') AS job_id,
        json_extract(value, '$.postingIdentityStatus') AS stored,
        (SELECT CASE
           WHEN MAX(json_extract(reference.value, '$.postingIdentityDecision.status') = 'confirmed') = 1 THEN 'confirmed'
           WHEN MAX(json_extract(reference.value, '$.postingIdentityDecision.status') = 'unconfirmed') = 1 THEN 'unconfirmed'
           END
         FROM json_each(json_extract(catalog_items.value, '$.sourceReferences')) AS reference) AS derived
      FROM catalog_items
      WHERE kind = 'internship' AND (pk > ? OR (pk = ? AND sk > ?))
      ORDER BY pk, sk LIMIT ?`)
      .bind(afterPk, afterPk, afterSk, OCCURRENCE_INDEX_PAGE)
      .all<{ pk: string; sk: string; job_id: string | null; stored: string | null; derived: string | null }>();
    for (const row of page.results) {
      if (row.job_id && (row.derived ?? null) !== (row.stored ?? null)) mismatched.add(row.job_id);
    }
    if (page.results.length < OCCURRENCE_INDEX_PAGE) return mismatched;
    const last = page.results.at(-1)!;
    if (last.pk === afterPk && last.sk === afterSk) throw new Error('Posting identity projection scan did not advance');
    afterPk = last.pk;
    afterSk = last.sk;
  }
}

export type OccurrenceRepairBatch = {
  jobIds: string[];
  contextRows: PostingIdentityAuditRow[];
  occurrenceKeys: Array<[string, string]>;
  repairToken: string;
  expectedChanges: number;
  expectedDuplicateJobs: number;
  /** Per-batch bounds that permit a revalidated apply after unrelated catalog
   * writes, exactly like the identity batch guard. */
  eligibleDuplicateGroups: number;
  unresolvedDuplicateGroups: number;
  occurrenceRemaps: number;
  jobUpdates: number;
  projectionMismatches: number;
};

export type OccurrenceRepairPlan = {
  schemaVersion: 1;
  scope: 'occurrences';
  aliasesScanned: number;
  danglingOccurrences: number;
  canonicalJobs: number;
  expectedChanges: number;
  occurrenceRemaps: number;
  jobUpdates: number;
  projectionMismatches: number;
  conflicts: string[];
  batches: OccurrenceRepairBatch[];
  applied: false;
  projectionRefreshRequired: false;
};

/**
 * Paged occurrence repair. A completed identity merge retires job IDs while
 * their durable `source-occurrence` rows still point at the old ID, and it
 * rewrites jobs with an identity projection their retained references may not
 * support. Planning that from the whole catalog exceeds D1's CPU limit, so this
 * planner reads the job-ID alias table, a job-ID-projected occurrence index,
 * and the internship projection predicate, then plans only the jobs those three
 * reach. Each returned batch is applied with its own signed token, revalidated
 * against the batch's current change count exactly like an identity batch.
 */
export async function runBoundedPostingIdentityOccurrenceRepair(db: D1Database, options: {
  jobBatch?: number;
  log?: (event: string) => void;
} = {}): Promise<OccurrenceRepairPlan> {
  const jobLimit = Math.max(1, Math.min(options.jobBatch ?? OCCURRENCE_BATCH_JOBS, OCCURRENCE_BATCH_JOBS));
  const [aliasRows, occurrenceIndex, mismatchJobIds] = await Promise.all([
    readKindRows(db, 'job-id-alias'),
    readOccurrenceIndex(db),
    readProjectionMismatchJobIds(db),
  ]);
  const conflicts: string[] = [];
  const aliasByOldJobId = new Map<string, OccurrenceAlias>();
  for (const row of aliasRows) {
    try {
      const value = JSON.parse(row.value) as { oldJobId?: unknown; canonicalJobId?: unknown };
      const keyJobId = row.pk.startsWith('JOB_ID_ALIAS#') ? row.pk.slice('JOB_ID_ALIAS#'.length) : undefined;
      const oldJobId = typeof value.oldJobId === 'string' ? value.oldJobId : undefined;
      const canonicalJobId = typeof value.canonicalJobId === 'string' ? value.canonicalJobId : undefined;
      if (row.sk !== 'TARGET' || !keyJobId || !oldJobId || !canonicalJobId || oldJobId !== keyJobId) {
        conflicts.push(`${row.pk}:${row.sk}: malformed job ID alias`);
        continue;
      }
      if (oldJobId === canonicalJobId) {
        conflicts.push(`${oldJobId}: job ID alias cannot target itself`);
        continue;
      }
      const existing = aliasByOldJobId.get(oldJobId);
      if (existing && existing.canonicalJobId !== canonicalJobId) {
        conflicts.push(`${oldJobId}: job ID alias resolves to multiple canonical jobs`);
        continue;
      }
      aliasByOldJobId.set(oldJobId, { row, canonicalJobId });
    } catch { conflicts.push(`${row.pk}:${row.sk}: malformed job ID alias JSON`); }
  }
  for (const [oldJobId, alias] of aliasByOldJobId) {
    if (aliasByOldJobId.has(alias.canonicalJobId)) conflicts.push(`${oldJobId}: job ID alias must be one hop`);
  }
  // Every alias names a canonical job an identity merge rewrote. The merge
  // stamps a confirmed projection status that the retained references may not
  // support, and the durable occurrence row that still names the retired ID has
  // to move with it. A retired ID whose occurrence row is already gone still
  // leaves that stale status behind, so both are part of this scope; a durable
  // row only adds reference keys to the group.
  const candidates = [...aliasByOldJobId];
  const existingJobs = await readExistingJobIds(db, candidates.flatMap(([oldJobId, alias]) => [oldJobId, alias.canonicalJobId]));
  const groups = new Map<string, { canonicalJobId: string; retiredJobIds: string[]; contextRows: PostingIdentityAuditRow[] }>();
  let danglingOccurrences = 0;
  for (const [oldJobId, alias] of candidates.sort(([left], [right]) => left.localeCompare(right))) {
    if (!existingJobs.has(alias.canonicalJobId)) {
      conflicts.push(`${oldJobId}: job ID alias target ${alias.canonicalJobId} is missing`);
      continue;
    }
    if (existingJobs.has(oldJobId)) {
      conflicts.push(`${oldJobId}: job ID alias source still has an internship row`);
      continue;
    }
    const group = groups.get(alias.canonicalJobId)
      ?? { canonicalJobId: alias.canonicalJobId, retiredJobIds: [], contextRows: [] };
    group.retiredJobIds.push(oldJobId);
    group.contextRows.push(alias.row);
    groups.set(alias.canonicalJobId, group);
    danglingOccurrences += occurrenceIndex.get(oldJobId)?.length ?? 0;
  }
  // Every alias covers a canonical job the merge rewrote, but not every job the
  // merge rewrote got an alias: a single-member identity group only stamps the
  // confirmed projection onto its own row. Those jobs are stale by the exact
  // predicate the audit counts, so the projection scan adds them as one-job
  // groups and the synchronizer re-derives them from their retained references.
  for (const jobId of [...mismatchJobIds].sort()) {
    if (!groups.has(jobId)) groups.set(jobId, { canonicalJobId: jobId, retiredJobIds: [], contextRows: [] });
  }

  const batches: OccurrenceRepairBatch[] = [];
  const queue: Array<{ jobIds: string[]; contextRows: PostingIdentityAuditRow[]; occurrenceKeys: Array<[string, string]> }> = [];
  for (const group of [...groups.values()].sort((left, right) => left.canonicalJobId.localeCompare(right.canonicalJobId))) {
    const jobIds = [group.canonicalJobId, ...group.retiredJobIds];
    const occurrenceKeys = [...new Map([...occurrenceIndex.get(group.canonicalJobId) ?? [],
      ...group.retiredJobIds.flatMap((jobId) => occurrenceIndex.get(jobId) ?? [])]
      .map((key) => [`${key[0]}\0${key[1]}`, key] as const)).values()].sort();
    const contextRows = [...new Map(group.contextRows.map((row) => [`${row.pk}\0${row.sk}`, row] as const)).values()]
      .sort((left, right) => left.pk.localeCompare(right.pk) || left.sk.localeCompare(right.sk));
    // A canonical job's synchronization must see all of its retired IDs in one
    // slice; splitting a group would make a later batch overwrite the first
    // batch's source-reference merge with a partial one.
    if (jobIds.length > jobLimit || occurrenceKeys.length > OCCURRENCE_BATCH_REFERENCES
      || contextRows.length > OCCURRENCE_BATCH_CONTEXT) {
      conflicts.push(`${group.canonicalJobId}: occurrence group exceeds the queue-tolerant repair envelope`);
      continue;
    }
    const current = queue.at(-1);
    if (!current || current.jobIds.length + jobIds.length > jobLimit
      || current.occurrenceKeys.length + occurrenceKeys.length > OCCURRENCE_BATCH_REFERENCES
      || current.contextRows.length + contextRows.length > OCCURRENCE_BATCH_CONTEXT) {
      queue.push({ jobIds, contextRows, occurrenceKeys });
      continue;
    }
    current.jobIds.push(...jobIds);
    current.contextRows.push(...contextRows);
    current.occurrenceKeys.push(...occurrenceKeys);
  }

  let expectedChanges = 0;
  let occurrenceRemaps = 0;
  let jobUpdates = 0;
  let projectionMismatches = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const slice = queue[index]!;
    const plan = await boundedRepairSlicePlan(db, { scope: 'occurrences', ...slice });
    conflicts.push(...plan.conflicts);
    expectedChanges += plan.expectedChanges;
    occurrenceRemaps += plan.occurrenceRemaps;
    jobUpdates += plan.jobUpdates;
    projectionMismatches += plan.gate.projectionMismatches;
    batches.push({
      jobIds: slice.jobIds,
      contextRows: slice.contextRows,
      occurrenceKeys: slice.occurrenceKeys,
      repairToken: plan.repairToken,
      expectedChanges: plan.expectedChanges,
      expectedDuplicateJobs: plan.duplicateJobs,
      eligibleDuplicateGroups: plan.eligibleDuplicateGroups,
      unresolvedDuplicateGroups: plan.unresolvedDuplicateGroups,
      occurrenceRemaps: plan.occurrenceRemaps,
      jobUpdates: plan.jobUpdates,
      projectionMismatches: plan.gate.projectionMismatches,
    });
    options.log?.(JSON.stringify({ event: 'posting_identity_occurrence_repair_batch', batch: index + 1,
      batches: queue.length, jobs: slice.jobIds.length, occurrences: slice.occurrenceKeys.length,
      changes: plan.expectedChanges }));
  }
  return {
    schemaVersion: 1,
    scope: 'occurrences',
    aliasesScanned: aliasRows.length,
    danglingOccurrences,
    canonicalJobs: groups.size,
    expectedChanges,
    occurrenceRemaps,
    jobUpdates,
    projectionMismatches,
    conflicts: [...new Set(conflicts)].sort(),
    batches,
    applied: false,
    projectionRefreshRequired: false,
  };
}
