import { createHash, randomUUID } from 'node:crypto';
import { safeDiagnostic, sourceFailureCategory } from '../src/source-health.js';
import type { SourceHealth } from '../src/types.js';
import type { D1Database, Queue } from './types.js';

export const dlqNames = ['greenhouse', 'lever', 'ashby', 'github', 'gmail', 'destination-verification'] as const;
export type DlqName = typeof dlqNames[number];
export interface PeekedMessage {
  id: string;
  attempts: number;
  body: unknown;
  ref: string;
  timestampMs?: number;
}

export interface DlqApi {
  resolveQueueId(exactName: string): Promise<string>;
  peek(queueId: string, limit: number): Promise<PeekedMessage[]>;
  purge(queueId: string, refs: string[]): Promise<{ failedRefs: string[] }>;
}

export interface DlqDependencies {
  db: D1Database;
  api: DlqApi;
  workQueues: Record<DlqName, Queue>;
  sourceHealth(sourceId: string): Promise<SourceHealth | undefined>;
  now?: () => Date;
}

type FailureProvenance = 'ledgered' | 'missing-ledger' | 'not-applicable';

interface ParsedMessage {
  body: Record<string, unknown>;
  serialized: string;
  payloadHash: string;
  logicalKey: string;
  sourceId?: string;
  jobId?: string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const queueName = (name: DlqName, dlq: boolean) => `intern-notifs-${name}${dlq ? '-dlq' : ''}`;

function freshCatalogMessage(name: Extract<DlqName, 'greenhouse' | 'lever' | 'ashby' | 'github'>, sourceId: string, now: Date) {
  if (name === 'github') return { sourceId };
  return {
    version: 1,
    sourceId,
    scheduledAt: now.toISOString(),
    ...(name === 'greenhouse' ? {} : { runId: `dlq-${randomUUID()}` }),
  };
}

function parseBody(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('DLQ message body is not a JSON object');
  return parsed as Record<string, unknown>;
}

function parseMessage(name: DlqName, value: unknown): ParsedMessage {
  const body = parseBody(value);
  const serialized = JSON.stringify(body);
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : undefined;
  const jobId = typeof body.jobId === 'string' ? body.jobId : undefined;
  const userId = typeof body.userId === 'string' ? body.userId : undefined;
  if (['greenhouse', 'lever', 'ashby', 'github'].includes(name) && !sourceId) throw new Error('Catalog DLQ message has no source ID');
  if (name === 'gmail' && (!userId || body.version !== 1 || !['initial', 'history'].includes(String(body.mode))
    || typeof body.requestedAt !== 'string'
    || (body.pageToken !== undefined && typeof body.pageToken !== 'string')
    || (body.startHistoryId !== undefined && typeof body.startHistoryId !== 'string')
    || (body.advanceChecks !== undefined && typeof body.advanceChecks !== 'boolean'))) {
    throw new Error('Gmail DLQ message is invalid');
  }
  if (name === 'destination-verification' && (!jobId || !sourceId || body.version !== 1
    || typeof body.externalId !== 'string' || typeof body.candidateUrl !== 'string'
    || !body.providerIdentity || typeof body.providerIdentity !== 'object'
    || typeof body.reason !== 'string' || typeof body.queuedAt !== 'string')) {
    throw new Error('Destination verification DLQ message is invalid');
  }
  const logicalKey = sourceId ?? userId ?? jobId!;
  return { body, serialized, payloadHash: hash(serialized), logicalKey, ...(sourceId ? { sourceId } : {}), ...(jobId ? { jobId } : {}) };
}

function discardableMessage(name: DlqName, message: PeekedMessage): ParsedMessage {
  try {
    return parseMessage(name, message.body);
  } catch {
    const serialized = JSON.stringify(message.body) ?? 'null';
    return { body: {}, serialized, payloadHash: hash(serialized), logicalKey: `unattributed:${message.id}` };
  }
}

function assertQueue(value: unknown): asserts value is DlqName {
  if (!dlqNames.includes(value as DlqName)) throw new Error('Queue is not allowlisted');
}

function isCatalogDlq(name: DlqName): name is Extract<DlqName, 'greenhouse' | 'lever' | 'ashby' | 'github'> {
  return name === 'greenhouse' || name === 'lever' || name === 'ashby' || name === 'github';
}

async function summary(name: DlqName, message: PeekedMessage, dependencies: DlqDependencies) {
  const parsed = discardableMessage(name, message);
  const health = parsed.sourceId ? await dependencies.sourceHealth(parsed.sourceId) : undefined;
  const failure = isCatalogDlq(name)
    ? await dependencies.db.prepare(`SELECT category, diagnostic FROM queue_failure_events
        WHERE queue_name = ? AND message_id = ? ORDER BY last_failed_at DESC LIMIT 1`)
      .bind(queueName(name, false), message.id).first<{ category: string; diagnostic: string }>()
    : null;
  // A missing event is meaningful for catalog work: the operator must treat it
  // as unclassified rather than inferring a transient from current source health.
  const failureProvenance: FailureProvenance = !isCatalogDlq(name)
    ? 'not-applicable'
    : failure ? 'ledgered' : 'missing-ledger';
  return {
    messageId: message.id,
    attempts: message.attempts,
    ...(message.timestampMs ? { timestamp: new Date(message.timestampMs).toISOString() } : {}),
    logicalWorkKey: parsed.logicalKey,
    payloadHash: parsed.payloadHash,
    ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}),
    ...(parsed.jobId ? { jobId: parsed.jobId } : {}),
    ...(health ? { currentHealth: health.state, sourceStatus: health.sourceStatus, latestDiagnostic: health.lastSafeDiagnostic,
      // The failure ledger also lives in D1, so a D1 outage leaves no per-message
      // category. Source health is written on a best-effort path and is the
      // durable category signal for that failure mode (see #203).
      ...(health.diagnosticCategory ?? health.lastFailureCategory
        ? { currentHealthCategory: health.diagnosticCategory ?? health.lastFailureCategory } : {}) } : {}),
    // failure.diagnostic deliberately overwrites health.lastSafeDiagnostic above:
    // for a dead-lettered message the per-message failure reason is more useful
    // than the source's current health diagnostic (still surfaced via sourceStatus).
    ...(failure ? { failureCategory: failure.category, latestDiagnostic: failure.diagnostic } : {}),
    failureProvenance,
  };
}

export async function inspectDlq(input: { queue: unknown; limit?: unknown }, dependencies: DlqDependencies) {
  assertQueue(input.queue);
  const name = input.queue;
  const limit = input.limit === undefined ? 25 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Inspection limit must be between 1 and 100');
  const id = await dependencies.api.resolveQueueId(queueName(name, true));
  const messages = await dependencies.api.peek(id, limit);
  const summaries = await Promise.all(messages.map((message) => summary(name, message, dependencies)));
  const classificationCounts = summaries.reduce((counts, message) => {
    counts[message.failureProvenance] += 1;
    return counts;
  }, { ledgered: 0, 'missing-ledger': 0, 'not-applicable': 0 } satisfies Record<FailureProvenance, number>);
  return { queue: name, count: summaries.length, classificationCounts, messages: summaries };
}

/**
 * A plan's own peek is the only view of its selection that is ever
 * authoritative. Peeking leases what it returns, so a second peek hands back a
 * different subset and can only reject a selection that was valid when it was
 * planned. `plan` therefore stages every peeked message under a plan-scoped
 * `catalog_items` key — the same staging surface `trusted-admission-backfill`
 * uses for its repair targets — and `apply` replays that staged set verbatim.
 */
const SELECTION_KIND = 'dlq-repair-selection';
const SELECTION_PK_PREFIX = 'DLQ_REPAIR_SELECTION#';

interface StagedSelection extends PeekedMessage {
  /** Position in the planned selection; `apply` replays in this order. */
  ordinal: number;
  /** Recorded so a staged payload identifies its queue on its own. */
  queue: DlqName;
}

const selectionPk = (planId: string) => `${SELECTION_PK_PREFIX}${planId}`;

async function stageSelection(db: D1Database, planId: string, selection: StagedSelection): Promise<void> {
  await db.prepare('INSERT INTO catalog_items (pk, sk, kind, value) VALUES (?, ?, ?, ?)')
    .bind(selectionPk(planId), selection.id, SELECTION_KIND, JSON.stringify(selection)).run();
}

async function stagedSelections(db: D1Database, planId: string): Promise<StagedSelection[]> {
  const rows = (await db.prepare('SELECT value FROM catalog_items WHERE pk = ? AND kind = ?')
    .bind(selectionPk(planId), SELECTION_KIND).all<{ value: string }>()).results;
  // The planned order lives inside the staged value, not in the key: the plan
  // replays what it was asked for, in the order it was asked to replay it.
  return rows.map((row) => JSON.parse(row.value) as StagedSelection).sort((left, right) => left.ordinal - right.ordinal);
}

async function clearStagedSelections(db: D1Database, planId: string): Promise<void> {
  await db.prepare('DELETE FROM catalog_items WHERE pk = ? AND kind = ?').bind(selectionPk(planId), SELECTION_KIND).run();
}

export async function planDlq(input: {
  queue: unknown; action?: unknown; messageIds?: unknown; reason?: unknown; expectedCount?: unknown;
}, dependencies: DlqDependencies) {
  assertQueue(input.queue);
  if (input.action !== 'replay' && input.action !== 'discard') throw new Error('Action must be replay or discard');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 500) throw new Error('An operator reason between 1 and 500 characters is required');
  const ids = Array.isArray(input.messageIds) ? [...new Set(input.messageIds.filter((id): id is string => typeof id === 'string' && id.length > 0))] : [];
  const expectedCount = Number(input.expectedCount);
  if (!ids.length || ids.length > 100 || expectedCount !== ids.length) throw new Error('Selected message IDs must match expectedCount');
  const queueId = await dependencies.api.resolveQueueId(queueName(input.queue, true));
  const peeked = await dependencies.api.peek(queueId, 100);
  const byId = new Map(peeked.map((message) => [message.id, message]));
  if (ids.some((id) => !byId.has(id))) throw new Error('Selection drift: one or more messages are no longer visible');
  const parsed = ids.map((id) => {
    const message = byId.get(id)!;
    return {
      message,
      parsed: input.action === 'discard'
        ? discardableMessage(input.queue as DlqName, message)
        : parseMessage(input.queue as DlqName, message.body),
    };
  });
  // The source health gate is intentionally catalog-only. Catalog replay
  // resumes a full source poll, which must not run for a paused/quarantined
  // source. Destination-verification replay re-enqueues a single per-job link
  // check whose consumer guards settle it safely, so it stays replayable even
  // while the owning source is paused.
  if (input.action === 'replay' && ['greenhouse', 'lever', 'ashby', 'github'].includes(input.queue as string)) {
    for (const item of parsed) {
      const health = await dependencies.sourceHealth(item.parsed.sourceId!);
      if (health?.state === 'quarantined' || health?.sourceStatus === 'paused') {
        throw new Error(`Source ${item.parsed.sourceId} is paused or quarantined; recover, verify, and resume it before replay`);
      }
    }
  }
  const now = (dependencies.now ?? (() => new Date()))();
  const planId = randomUUID();
  const repairToken = randomUUID();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  await dependencies.db.prepare(`INSERT INTO dlq_repair_plans
    (plan_id, repair_token_hash, queue_name, operation, reason, expected_count, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(planId, hash(repairToken), input.queue, input.action, reason, ids.length, now.toISOString(), expiresAt).run();
  for (const [ordinal, item] of parsed.entries()) {
    await dependencies.db.prepare(`INSERT INTO dlq_repair_plan_items
      (plan_id, message_id, payload_hash, message_body, logical_key, source_id, job_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(planId, item.message.id, item.parsed.payloadHash, item.parsed.serialized, item.parsed.logicalKey,
        item.parsed.sourceId ?? null, item.parsed.jobId ?? null).run();
    await stageSelection(dependencies.db, planId, { ...item.message, ordinal, queue: input.queue });
  }
  return { planId, repairToken, queue: input.queue, action: input.action, expectedCount: ids.length,
    stagedCount: parsed.length, expiresAt, irreversible: input.action === 'discard' };
}

interface PlanRow {
  plan_id: string; repair_token_hash: string; queue_name: DlqName; operation: 'replay' | 'discard'; reason: string;
  expected_count: number; expires_at: string; applying_at: string | null; applied_at: string | null;
}
interface ItemRow {
  message_id: string; payload_hash: string; message_body: string; logical_key: string; source_id: string | null;
  job_id: string | null; replayed_at: string | null; purged_at: string | null;
}

interface ApplyReport {
  planId: string;
  queue: DlqName;
  action: 'replay' | 'discard';
  /** Messages this apply disposed of (purged and audited); 0 for a repeated apply. */
  appliedCount: number;
  /**
   * Planned messages that could not be purged because they are no longer in the
   * DLQ. A non-empty report leaves the plan retryable and records no disposition
   * for the conflicting messages, so nothing is claimed that did not happen.
   */
  conflicts: string[];
  appliedAt: string | null;
}

export async function applyDlq(input: { planId?: unknown; repairToken?: unknown; expectedCount?: unknown; actor?: string }, dependencies: DlqDependencies): Promise<ApplyReport> {
  if (typeof input.planId !== 'string' || typeof input.repairToken !== 'string') throw new Error('Plan ID and repair token are required');
  const plan = await dependencies.db.prepare('SELECT * FROM dlq_repair_plans WHERE plan_id = ?').bind(input.planId).first<PlanRow>();
  if (!plan || plan.repair_token_hash !== hash(input.repairToken)) throw new Error('Repair plan or token is invalid');
  if (Number(input.expectedCount) !== plan.expected_count) throw new Error('Expected count does not match the repair plan');
  const now = (dependencies.now ?? (() => new Date()))();
  // A repeated apply is a no-op rather than an error: the plan already disposed
  // of its messages and the caller may be retrying a response it never read.
  if (plan.applied_at) {
    return { planId: plan.plan_id, queue: plan.queue_name, action: plan.operation, appliedCount: 0, conflicts: [], appliedAt: plan.applied_at };
  }
  if (plan.applying_at) throw new Error('Repair plan is already being applied');
  if (Date.parse(plan.expires_at) <= now.getTime()) throw new Error('Repair plan has expired');
  const items = (await dependencies.db.prepare('SELECT * FROM dlq_repair_plan_items WHERE plan_id = ? ORDER BY message_id')
    .bind(plan.plan_id).all<ItemRow>()).results;
  if (items.length !== plan.expected_count) throw new Error('Repair plan item count drifted');
  // Nothing below re-peeks: a peek only holds a lease on what it returned, so a
  // fresh peek is not a statement about the planned selection. The staged rows
  // are, and each must still reproduce the hash the plan recorded, so a
  // partially written selection fails before anything is sent or purged.
  const staged = await stagedSelections(dependencies.db, plan.plan_id);
  if (staged.length !== plan.expected_count) throw new Error('Repair plan selection is incomplete');
  const itemsById = new Map(items.map((item) => [item.message_id, item]));
  const selected = staged.map((selection) => {
    const item = itemsById.get(selection.id);
    if (!item) throw new Error('Repair plan selection does not match its items');
    const planned = plan.operation === 'discard'
      ? discardableMessage(plan.queue_name, selection)
      : parseMessage(plan.queue_name, selection.body);
    if (planned.payloadHash !== item.payload_hash) throw new Error('Repair plan selection no longer matches its recorded payload');
    return { selection, item };
  });
  const dlqId = await dependencies.api.resolveQueueId(queueName(plan.queue_name, true));

  const lock = await dependencies.db.prepare(`UPDATE dlq_repair_plans SET applying_at = ?
    WHERE plan_id = ? AND applying_at IS NULL AND applied_at IS NULL`)
    .bind(now.toISOString(), plan.plan_id).run();
  if (lock.meta.changes !== 1) throw new Error('Repair plan is already being applied or was applied');

  try {
    if (plan.operation === 'replay') {
      if (isCatalogDlq(plan.queue_name)) {
        const groups = new Map<string, ItemRow[]>();
        for (const entry of selected.filter((candidate) => !candidate.item.replayed_at)) {
          const group = groups.get(entry.item.source_id!) ?? []; group.push(entry.item); groups.set(entry.item.source_id!, group);
        }
        for (const [sourceId, group] of groups) {
          const health = await dependencies.sourceHealth(sourceId);
          if (health?.state === 'quarantined' || health?.sourceStatus === 'paused') {
            throw new Error(`Source ${sourceId} became paused or quarantined; recovery must use source controls`);
          }
          await dependencies.workQueues[plan.queue_name].send(freshCatalogMessage(plan.queue_name, sourceId, now));
          for (const item of group) await dependencies.db.prepare('UPDATE dlq_repair_plan_items SET replayed_at = ? WHERE plan_id = ? AND message_id = ?')
            .bind(now.toISOString(), plan.plan_id, item.message_id).run();
        }
      } else {
        for (const entry of selected.filter((candidate) => !candidate.item.replayed_at)) {
          await dependencies.workQueues[plan.queue_name].send(parseBody(entry.selection.body));
          await dependencies.db.prepare('UPDATE dlq_repair_plan_items SET replayed_at = ? WHERE plan_id = ? AND message_id = ?')
          .bind(now.toISOString(), plan.plan_id, entry.item.message_id).run();
        }
      }
    }

    const pending = selected.filter((entry) => !entry.item.purged_at);
    const failedRefs = pending.length
      ? (await dependencies.api.purge(dlqId, pending.map((entry) => entry.selection.ref))).failedRefs
      : [];
    const failed = new Set(failedRefs);
    const purged = pending.filter((entry) => !failed.has(entry.selection.ref));
    const actor = input.actor?.trim() || 'operations-owner';
    for (const { item } of purged) {
      const recordedFailure = plan.queue_name === 'github' && plan.operation === 'replay'
        ? await dependencies.db.prepare(`SELECT id FROM queue_failure_events
            WHERE queue_name = ? AND message_id = ? LIMIT 1`)
          .bind(queueName(plan.queue_name, false), item.message_id).first<{ id: string }>()
        : null;
      const classification = plan.operation === 'discard'
        ? 'discarded'
        : plan.queue_name !== 'github' ? 'replayed'
          : recordedFailure ? 'recorded-failure-replayed' : 'historical-transient';
      const diagnostic = classification === 'historical-transient'
        ? 'Original failure predates instrumentation and cannot be reconstructed.'
        : null;
      await dependencies.db.batch([
        dependencies.db.prepare('UPDATE dlq_repair_plan_items SET purged_at = ? WHERE plan_id = ? AND message_id = ?')
          .bind(now.toISOString(), plan.plan_id, item.message_id),
        dependencies.db.prepare(`INSERT INTO dlq_disposition_audit
          (id, plan_id, queue_name, message_id, payload_hash, logical_key, operation, classification, diagnostic, reason, actor, disposed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(randomUUID(), plan.plan_id, plan.queue_name, item.message_id, item.payload_hash, item.logical_key,
            plan.operation, classification, diagnostic, plan.reason, actor, now.toISOString()),
        // The message has left the DLQ, so its failure-ledger row is no longer
        // pending: resolve it with the disposition. Otherwise a reconciled DLQ
        // leaves rows unresolved until the 30-day cleanup and the operator
        // "unresolved" signal keeps counting work a human already handled.
        dependencies.db.prepare(`UPDATE queue_failure_events SET resolved_at = ?
          WHERE queue_name = ? AND message_id = ? AND resolved_at IS NULL`)
          .bind(now.toISOString(), queueName(plan.queue_name, false), item.message_id),
      ]);
    }
    const conflicts = pending.filter((entry) => failed.has(entry.selection.ref)).map((entry) => entry.item.message_id);
    if (conflicts.length) {
      // A message that left the DLQ cannot be purged. It has already been
      // replayed — a replay is pushed before the DLQ copy is purged, so the
      // purge is the first point at which its absence is observable — and a
      // retry does not push it again. Reporting it and carrying on keeps one
      // vanished message from failing the messages that were disposed, while
      // leaving the plan retryable: a retry only touches what is still pending.
      await dependencies.db.prepare('UPDATE dlq_repair_plans SET applying_at = NULL WHERE plan_id = ? AND applied_at IS NULL')
        .bind(plan.plan_id).run();
      return { planId: plan.plan_id, queue: plan.queue_name, action: plan.operation,
        appliedCount: purged.length, conflicts, appliedAt: null };
    }
    await dependencies.db.prepare(`UPDATE dlq_repair_plans SET applying_at = NULL, applied_at = ?
      WHERE plan_id = ? AND applied_at IS NULL`)
      .bind(now.toISOString(), plan.plan_id).run();
    try { await clearStagedSelections(dependencies.db, plan.plan_id); }
    catch { /* Staged selections are inert once the plan is applied; a cleanup failure must not hide a completed apply. */ }
    return { planId: plan.plan_id, queue: plan.queue_name, action: plan.operation,
      appliedCount: purged.length, conflicts: [], appliedAt: now.toISOString() };
  } catch (error) {
    await dependencies.db.prepare('UPDATE dlq_repair_plans SET applying_at = NULL WHERE plan_id = ? AND applied_at IS NULL')
      .bind(plan.plan_id).run();
    throw error;
  }
}

export async function handleDlqOperations(request: Request, dependencies: DlqDependencies): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ message: 'Method not allowed' }, { status: 405 });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input) return Response.json({ message: 'Request body must be valid JSON' }, { status: 400 });
  try {
    const operation = input.operation;
    const result = operation === 'inspect' ? await inspectDlq({ queue: input.queue, limit: input.limit }, dependencies)
      : operation === 'plan' ? await planDlq({ queue: input.queue, action: input.action, messageIds: input.messageIds,
        reason: input.reason, expectedCount: input.expectedCount }, dependencies)
        : operation === 'apply' ? await applyDlq({ ...input, actor: request.headers.get('X-Operations-Actor') ?? undefined }, dependencies)
          : undefined;
    return result ? Response.json(result) : Response.json({ message: 'Operation must be inspect, plan, or apply' }, { status: 400 });
  } catch (error) {
    return Response.json({ message: safeDiagnostic(error) }, { status: 409 });
  }
}

export interface QueueFailureInput {
  db: D1Database; queueName: string; messageId: string; attempts?: number; timestamp?: Date; sourceId?: string;
  sourceKind?: string; body: unknown; error: unknown; now?: Date;
}

export async function recordQueueFailure(input: QueueFailureInput): Promise<void> {
  const now = (input.now ?? new Date()).toISOString();
  const serialized = JSON.stringify(input.body);
  const payloadHash = hash(serialized);
  const id = hash(`${input.queueName}\0${input.messageId}\0${input.attempts ?? 0}`);
  await input.db.prepare(`INSERT INTO queue_failure_events
    (id, queue_name, message_id, delivery_attempt, message_timestamp, source_id, source_kind, payload_hash,
     category, diagnostic, first_failed_at, last_failed_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET category = excluded.category, diagnostic = excluded.diagnostic,
      last_failed_at = excluded.last_failed_at, resolved_at = NULL`)
    .bind(id, input.queueName, input.messageId, input.attempts ?? 0, input.timestamp?.toISOString() ?? null,
      input.sourceId ?? null, input.sourceKind ?? null, payloadHash, sourceFailureCategory(input.error),
      safeDiagnostic(input.error), now, now).run();
}

export async function recordQueueFailureBestEffort(input: QueueFailureInput): Promise<boolean> {
  try {
    await recordQueueFailure(input);
    return true;
  } catch (error) {
    console.error(JSON.stringify({ command: 'queue-failure-ledger', messageId: input.messageId, error: safeDiagnostic(error) }));
    return false;
  }
}

export async function resolveQueueFailures(db: D1Database, queueNameValue: string, messageId: string, resolvedAt = new Date()): Promise<void> {
  await db.prepare('UPDATE queue_failure_events SET resolved_at = ? WHERE queue_name = ? AND message_id = ? AND resolved_at IS NULL')
    .bind(resolvedAt.toISOString(), queueNameValue, messageId).run();
}

export async function cleanupDlqRecords(db: D1Database, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  // A plan keeps its staged selection while it can still be applied or retried;
  // clearing it together with the plan that owns it keeps an abandoned plan from
  // leaving selection rows behind in the catalog table.
  await db.prepare(`DELETE FROM catalog_items WHERE kind = ? AND pk IN (
    SELECT ? || plan_id FROM dlq_repair_plans WHERE expires_at < ?)`)
    .bind(SELECTION_KIND, SELECTION_PK_PREFIX, now.toISOString()).run();
  await db.prepare('DELETE FROM dlq_repair_plans WHERE expires_at < ?').bind(now.toISOString()).run();
  await db.prepare('DELETE FROM dlq_disposition_audit WHERE disposed_at < ?').bind(cutoff).run();
  await db.prepare('DELETE FROM queue_failure_events WHERE last_failed_at < ?').bind(cutoff).run();
}
