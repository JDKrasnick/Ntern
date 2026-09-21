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
  type InternalPostingIdentityRepairPlan,
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

const READ_PAGE = 500;
const GROUP_JOBS_PER_BATCH = 100;
const KEY_PAIRS_PER_READ = 40;
const JOB_IDS_PER_READ = 50;
const CONTEXT_KINDS = ['job-id-alias', 'checkpoint', 'posting-alias', 'notification-tombstone'] as const;

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

function coalesceWrites<T extends { before?: unknown }>(target: Map<string, T>, key: string, write: T): void {
  const previous = target.get(key);
  target.set(key, previous ? { ...write, before: previous.before ?? write.before } : write);
}

export async function runBoundedPostingIdentityRepair(db: D1Database, options: {
  apply?: boolean;
  repairToken?: string;
  expectedChanges?: number;
  expectedDuplicateJobs?: number;
  jobBatch?: number;
  log?: (event: string) => void;
} = {}): Promise<PostingIdentityRepairPlan> {
  const scan = await runPostingIdentityAuditScan(db, { jobBatch: options.jobBatch, log: options.log });
  const contextRows = await readContextRows(db);
  const users = await readUserRows(db);
  const proposals = (await db.prepare('SELECT id, job_id FROM employer_field_proposals ORDER BY id').all<ProposalRow>()).results;
  const employerMappings = (await db.prepare(`SELECT provider, scope, canonical_employer_id FROM employer_mappings
    WHERE superseded_at IS NULL ORDER BY provider, scope`).all<EmployerMappingRow>()).results;
  const presentationReviews = (await db.prepare(`SELECT id, provider, tenant, posting_id, company, title, location,
      locations_json, apply_url, evidence_url, evidence_hash, reviewed_at, reviewed_by
    FROM posting_identity_presentation_reviews ORDER BY id`).all<PresentationReviewRow>()).results;

  const occurrenceKeys = new Map(scan.repairIndex.occurrenceKeysByJob.map((item) => [item.jobId, item.keys]));
  const jobAliases = new Map<string, string>();
  for (const row of contextRows.filter((item) => item.kind === 'job-id-alias')) {
    try {
      const value = JSON.parse(row.value) as { oldJobId?: string; canonicalJobId?: string };
      if (value.oldJobId && value.canonicalJobId) jobAliases.set(value.oldJobId, value.canonicalJobId);
    } catch { /* The audit and batch planner report malformed rows. */ }
  }

  const catalogWrites = new Map<string, InternalPostingIdentityRepairPlan['catalogWrites'][number]>();
  const catalogDeletes = new Map<string, InternalPostingIdentityRepairPlan['catalogDeletes'][number]>();
  const userWrites = new Map<string, InternalPostingIdentityRepairPlan['userWrites'][number]>();
  const userDeletes = new Map<string, InternalPostingIdentityRepairPlan['userDeletes'][number]>();
  const proposalUpdates = new Map<string, ProposalRow>();
  const batchDigests: string[] = [];
  const batchConflicts = new Set<string>();
  let simulatedUsers = users;
  let notificationTombstoneRemaps = 0;
  let receiptRemaps = 0;
  let receiptMerges = 0;

  const groupLimit = Math.max(1, Math.min(options.jobBatch ?? GROUP_JOBS_PER_BATCH, 500));
  const groupBatches = batches(scan.repairIndex.groups, groupLimit);
  for (let batchIndex = 0; batchIndex < groupBatches.length; batchIndex += 1) {
    const groupBatch = groupBatches[batchIndex]!;
    const jobIds = new Set(groupBatch.flatMap((group) => group.members.map((member) => member.jobId)));
    const occurrenceJobIds = new Set(jobIds);
    for (const [oldJobId, canonicalJobId] of jobAliases) if (jobIds.has(canonicalJobId)) occurrenceJobIds.add(oldJobId);
    const fullJobs = await readJobs(db, [...jobIds].sort());
    const keys = [...occurrenceJobIds].flatMap((jobId) => occurrenceKeys.get(jobId) ?? []);
    const occurrences = await readOccurrenceRows(db, keys);
    const plan = postingIdentityRepairPlan([
      ...fullJobs,
      ...occurrences,
      ...contextRows,
    ] as never, simulatedUsers as never, proposals, 'identity', { employerMappings, presentationReviews }) as InternalPostingIdentityRepairPlan;

    batchDigests.push(plan.snapshotDigest, plan.repairToken);
    for (const conflict of plan.conflicts) batchConflicts.add(conflict);
    for (const write of plan.catalogWrites) coalesceWrites(catalogWrites, `${write.pk}\0${write.sk}`, write);
    for (const row of plan.catalogDeletes) catalogDeletes.set(`${row.pk}\0${row.sk}`, row);
    for (const write of plan.userWrites) coalesceWrites(userWrites, `${write.userId}\0${write.itemKey}`, write);
    for (const row of plan.userDeletes) userDeletes.set(`${row.user_id}\0${row.item_key}`, row);
    for (const row of plan.proposalUpdates) proposalUpdates.set(row.id, row);
    simulatedUsers = simulateUserRows(simulatedUsers, plan);
    notificationTombstoneRemaps += plan.notificationTombstoneRemaps;
    receiptRemaps += plan.receiptRemaps;
    receiptMerges += plan.receiptMerges;
    options.log?.(JSON.stringify({ event: 'posting_identity_repair_batch', batch: batchIndex + 1,
      batches: groupBatches.length, groups: groupBatch.length, jobs: jobIds.size }));
  }

  const catalogWriteValues = [...catalogWrites.values()];
  const catalogDeleteValues = [...catalogDeletes.values()];
  const userWriteValues = [...userWrites.values()];
  const userDeleteValues = [...userDeletes.values()];
  const proposalUpdateValues = [...proposalUpdates.values()];
  const conflicts = [...new Set([...scan.report.conflicts, ...batchConflicts])].sort();
  const expectedChanges = catalogWriteValues.length + catalogDeleteValues.length
    + userWriteValues.length + userDeleteValues.length + proposalUpdateValues.length;
  const repairFacts = {
    audit: scan.report,
    batches: batchDigests,
    catalogWrites: catalogWriteValues.map((item) => [item.pk, item.sk, item.before?.value ?? null, item.value]),
    catalogDeletes: catalogDeleteValues.map((item) => [item.pk, item.sk, item.value]),
    userWrites: userWriteValues.map((item) => [item.userId, item.itemKey, item.before?.value ?? null, item.value]),
    userDeletes: userDeleteValues.map((item) => [item.user_id, item.item_key, item.value]),
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
    catalogWrites: catalogWriteValues,
    catalogDeletes: catalogDeleteValues,
    userWrites: userWriteValues,
    userDeletes: userDeleteValues,
    proposalUpdates: proposalUpdateValues,
    scan: { occurrenceDecisions: [], unconfirmedFamilies: [], groupMembers: [], groupAliases: [] },
  };
  if (!options.apply) return plan;
  return applyPostingIdentityRepairPlan(db, plan, options);
}
