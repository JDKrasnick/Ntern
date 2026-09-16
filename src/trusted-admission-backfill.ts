import { activeTrustedCommunityPolicy, effectiveAdmissionConfigurationVersion, sourceAdmissionPolicy } from './sources/trust-policy.js';
import type { TrustedCommunityAdmissionPolicy } from './sources/trust-policy.js';
import { alertEligible, catalogEligible, deriveCanonicalAdmission, evaluateCatalogAdmission } from './catalog-admission.js';
import { catalogSearchText, catalogSourceClasses } from './catalog-fields.js';
import { catalogQualityHash } from './catalog-quality.js';
import { canonicalCatalogRecency, openCatalogSortKey } from './catalog-recency.js';
import { defaultSources } from './sources/index.js';
import { sourceQualityPolicies } from './sources/quality.js';
import { D1CatalogAdmissionStore } from '../cloudflare/catalog-admission-store.js';
import type { D1Database } from '../cloudflare/types.js';
import type {
  CatalogAdmission,
  Internship,
  ProcessedListing,
  SourceCheckpoint,
  SourceOccurrence,
  SourceOccurrenceState,
} from './types.js';

/**
 * Operator repair for the trusted-community admission migration.
 *
 * A bounded policy migration stores freshly evaluated evidence but suppresses
 * publication until one complete healthy evaluation can clear the whole source
 * (`catalogPublicationSuppressed`), which releases the backlog about twenty
 * rows per cadence. This repair re-grades the stored occurrences offline —
 * every input comes from the row, so there is no network work and no new
 * evidence — and publishes exactly the rows the stored evidence already
 * supports. A row is only ever published by a real `evaluateCatalogAdmission`
 * decision under the reviewed trusted policy, and alerts stay off because every
 * trusted list runs `alertMode: 'disabled'`.
 *
 * The enabled catalog gate is a precondition: with the gate off the same
 * occurrences are graded under the dormant standard policy while the poller
 * revokes trusted admissions, so publishing here would thrash.
 */
const TRUSTED_COMMUNITY_CATALOG_ENABLED = true;

/** Rows per keyset page; mirrors `D1InternshipStore.OCCURRENCE_PAGE_ROWS`. */
const OCCURRENCE_PAGE_ROWS = 250;
// D1 rejects a statement that binds more than 100 parameters (the local sqlite
// harness allows far more), so every chunk here stays under that cap: the job
// lookup binds one id per row plus its LIMIT, and a staged row binds six values.
const D1_MAX_BOUND_PARAMETERS = 100;
const JOB_LOOKUP_CHUNK = D1_MAX_BOUND_PARAMETERS - 1;
/** Rows per guarded apply, under the catalog's atomic-repair record limit. */
const APPLY_TARGET_ROWS = 250;
const APPLY_TARGET_BYTES = 4 * 1024 * 1024;
const STAGE_KIND = 'trusted-admission-repair';
const STAGE_VALUES_PER_ROW = 6;
const STAGE_ROWS_PER_STATEMENT = Math.floor(D1_MAX_BOUND_PARAMETERS / STAGE_VALUES_PER_ROW);
const STAGE_STATEMENTS_PER_BATCH = 25;
const CONFLICT_LIMIT = 100;
const SAMPLE_LIMIT = 10;

export type TrustedAdmissionRowCategory = 'published' | 'regraded' | 'unchanged' | 'skipped';

export interface TrustedAdmissionCounts {
  /** Rows whose stored admission is catalog-eligible. */
  eligible: number;
  /** Rows whose admission blocks publication. */
  blocked: number;
  /** Rows published only after the pending migration flag is cleared. */
  suppressed: number;
}

export interface TrustedAdmissionBackfillReport {
  dryRun: boolean;
  /** Graded occurrence rows per trusted source, as stored. */
  before: Record<string, TrustedAdmissionCounts>;
  /** The same rows after this repair's decisions. */
  after: Record<string, TrustedAdmissionCounts>;
  totals: Record<TrustedAdmissionRowCategory, number>;
  changes: { occurrences: number; jobs: number; checkpoints: number };
  samples: Record<TrustedAdmissionRowCategory, string[]>;
  repairToken: string;
  expectedChanged: number;
  conflicts: string[];
  projectionRefreshRequired: boolean;
}

type CatalogRow = { pk: string; sk: string; value: string };
type Target = {
  pk: string;
  sk: string;
  label: string;
  oldValue: string;
  value: string;
  /** Derived catalog columns; only job rows carry them. */
  columns?: Record<string, string | number | null>;
};
type JobEntry = {
  targetPk: string;
  targetSk: string;
  label: string;
  oldValue: string;
  document: Internship;
  references: Map<string, SourceOccurrence>;
};
type Decision =
  | { category: 'skipped' }
  | { category: 'unchanged' }
  | { category: 'published' | 'regraded'; admission: CatalogAdmission; reference: SourceOccurrence };
type ScanResult = {
  before: Record<string, TrustedAdmissionCounts>;
  after: Record<string, TrustedAdmissionCounts>;
  totals: Record<TrustedAdmissionRowCategory, number>;
  samples: Record<TrustedAdmissionRowCategory, string[]>;
  descriptors: Array<{ pk: string; sk: string; before: string; after: string }>;
  jobs: Set<string>;
  checkpoints: number;
};

/**
 * Every reviewed source id the catalog can hold rows for. `defaultSources` is
 * the polled registry and `sourceQualityPolicies` is the reviewed id registry,
 * including lists retired while their occurrences stayed durable.
 */
const KNOWN_SOURCE_IDS = [...new Set([
  ...defaultSources.map((source) => source.id),
  ...sourceQualityPolicies.map((policy) => policy.id),
])];

/**
 * Lockstep key for matching a job's reference copy against an occurrence row.
 * The separator keeps source ids that differ only by a trailing segment apart.
 */
const occurrenceKey = (reference: Pick<SourceOccurrence, 'sourceId' | 'externalId'>) => `${reference.sourceId}\0${reference.externalId ?? ''}`;

function parse<T>(value?: string): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

/**
 * A target's identity for the repair token. Evaluation stamps are dropped: they
 * move on every run, so a dry-run token would otherwise never authorize the
 * apply it was computed for. Exact row drift is still caught by the guarded
 * apply, which compares the whole stored value.
 */
function planFingerprint(value: string): string {
  return catalogQualityHash(JSON.stringify(JSON.parse(value), (key, item) => (key === 'evaluatedAt' ? undefined : item)));
}

function trustedSourceIds(scope?: string[]): string[] {
  if (scope?.length) {
    const untrusted = [...new Set(scope)].filter((sourceId) => sourceAdmissionPolicy(sourceId).trust !== 'trusted-community');
    if (untrusted.length) throw new Error(`Not trusted-community sources: ${untrusted.sort().join(', ')}`);
    return [...new Set(scope)].sort();
  }
  return KNOWN_SOURCE_IDS.filter((sourceId) => sourceAdmissionPolicy(sourceId).trust === 'trusted-community').sort();
}

/** The version the poller stamps on this source's rows under the enabled gate. */
function admissionConfigurationVersion(sourceId: string, resolverVersion: string | undefined): string {
  const version = effectiveAdmissionConfigurationVersion({
    sourceId,
    resolverVersion,
    trustedCommunityCatalogEnabled: TRUSTED_COMMUNITY_CATALOG_ENABLED,
  });
  if (!version) throw new Error(`No admission configuration version for trusted-community source ${sourceId}`);
  return version;
}

function countRow(counts: TrustedAdmissionCounts, eligible: boolean, suppressed: boolean) {
  if (suppressed) counts.suppressed += 1;
  else if (eligible) counts.eligible += 1;
  else counts.blocked += 1;
}

/**
 * Derived catalog columns exactly as `D1InternshipStore.putInternship` writes
 * them: a raw JSON update would otherwise leave the role out of the projection.
 */
function derivedColumns(job: Internship): Record<string, string | number | null> {
  const visible = job.technical !== false && catalogEligible(job);
  return {
    urlKey: job.normalizedUrl,
    fingerprintKey: job.fingerprint,
    smsPending: job.notification.smsPending && alertEligible(job) ? 1 : 0,
    digestPending: job.notification.digestPending && alertEligible(job) ? 1 : 0,
    catalogState: visible ? (job.open ? 'OPEN' : 'CLOSED') : null,
    catalogSortKey: visible ? (job.open ? openCatalogSortKey(job) : `${job.lastSeenAt}#${job.jobId}`) : null,
    searchText: visible ? catalogSearchText(job) : null,
    sourceClasses: visible ? JSON.stringify(catalogSourceClasses(job)) : null,
  };
}

function decisionFor(input: {
  policy: TrustedCommunityAdmissionPolicy;
  version: string;
  now: string;
  reference: SourceOccurrence;
}): Decision {
  const { policy, reference, version, now } = input;
  const stored = reference.admission;
  const qualification = reference.trustedCommunityAlertQualification;
  if (!stored || !qualification) return { category: 'skipped' };
  // The stored decision is the evidence: rebuild the listing it graded, so a
  // repaired title or an already resolved employer is never re-read from the
  // row's raw columns. Only the suppression flag and the policy gate change.
  const listing = {
    ...reference,
    ...(stored.canonicalEmployer
      ? { employerEvidence: { authority: 'reviewed-registry' as const, canonicalEmployer: stored.canonicalEmployer } }
      : {}),
    ...(stored.metadata ? { metadataCompleteness: stored.metadata } : {}),
  } as ProcessedListing;
  const evaluate = (evaluatedAt: string) => evaluateCatalogAdmission({
    listing,
    destination: stored.destination,
    postingAttributed: stored.postingAttribution === 'attributed',
    previous: stored,
    evaluatedAt,
    trustedCommunity: { policy, qualification: { ...qualification, catalogPublicationSuppressed: false } },
  });
  const suppressed = qualification.catalogPublicationSuppressed === true;
  // Re-evaluating at the stored timestamp reproduces the stored decision, which
  // is what makes an already settled row a no-op instead of a rewrite on every
  // run. `evaluatedAt` is absent only on legacy rows.
  const settled = JSON.stringify(evaluate(stored.evaluatedAt ?? now)) === JSON.stringify(stored);
  if (settled && !suppressed && reference.admissionConfigurationVersion === version) return { category: 'unchanged' };
  const admission = evaluate(now);
  return {
    category: admission.catalogEligible && (stored.catalogEligible !== true || suppressed) ? 'published' : 'regraded',
    admission,
    reference: {
      ...reference,
      admission,
      admissionConfigurationVersion: version,
      trustedCommunityAlertQualification: { ...qualification, catalogPublicationSuppressed: false },
    },
  };
}

async function occurrencePage(db: D1Database, sourceId: string, after: string): Promise<CatalogRow[]> {
  const page = await db.prepare(`SELECT pk, sk, value FROM catalog_items
    WHERE pk = ? AND sk LIKE 'OCCURRENCE#%' AND sk > ?
    ORDER BY sk LIMIT ?`)
    .bind(`SOURCE#${sourceId}`, after, OCCURRENCE_PAGE_ROWS).all<CatalogRow>();
  return page.results;
}

/** One bounded lookup per page keeps the scan far below D1's query budget. */
async function loadJobs(db: D1Database, jobIds: string[]): Promise<Map<string, CatalogRow>> {
  const jobs = new Map<string, CatalogRow>();
  for (let offset = 0; offset < jobIds.length; offset += JOB_LOOKUP_CHUNK) {
    const chunk = [...new Set(jobIds.slice(offset, offset + JOB_LOOKUP_CHUNK))];
    const rows = await db.prepare(`SELECT pk, sk, value FROM catalog_items
      WHERE sk = 'META' AND pk IN (${chunk.map(() => '?').join(', ')}) LIMIT ?`)
      .bind(...chunk.map((jobId) => `JOB#${jobId}`), chunk.length).all<CatalogRow>();
    for (const row of rows.results) jobs.set(row.pk, row);
  }
  return jobs;
}

/**
 * Walks each trusted source's occurrences once, in keyset pages, and hands
 * bounded groups of writes to `flush`. Planning and applying share this scan, so
 * a refused token and an applied token can never disagree about a decision.
 */
async function scanTrustedSources(input: {
  db: D1Database;
  sourceIds: string[];
  versions: Map<string, string>;
  now: string;
  collectDescriptors: boolean;
  flush: (targets: Target[]) => Promise<void>;
}): Promise<ScanResult> {
  const { db, now } = input;
  const result: ScanResult = {
    before: {}, after: {},
    totals: { published: 0, regraded: 0, unchanged: 0, skipped: 0 },
    samples: { published: [], regraded: [], unchanged: [], skipped: [] },
    descriptors: [], jobs: new Set(), checkpoints: 0,
  };
  const record = (category: TrustedAdmissionRowCategory, label: string) => {
    result.totals[category] += 1;
    if (result.samples[category].length < SAMPLE_LIMIT) result.samples[category].push(label);
  };
  for (const sourceId of input.sourceIds) {
    const policy = activeTrustedCommunityPolicy(sourceId, TRUSTED_COMMUNITY_CATALOG_ENABLED);
    const version = input.versions.get(sourceId);
    if (!policy || !version) continue;
    const before = result.before[sourceId] ??= { eligible: 0, blocked: 0, suppressed: 0 };
    const after = result.after[sourceId] ??= { eligible: 0, blocked: 0, suppressed: 0 };
    const checkpointRow = await db.prepare('SELECT pk, sk, value FROM catalog_items WHERE pk = ? AND sk = ? LIMIT 1')
      .bind(`SOURCE#${sourceId}`, 'CHECKPOINT').first<CatalogRow>() ?? undefined;
    const buffer: Target[] = [];
    const jobEntries = new Map<string, JobEntry>();
    let bytes = 0;
    let skipped = 0;
    const flush = async () => {
      for (const entry of jobEntries.values()) {
        const references = entry.document.sourceReferences
          .map((reference) => entry.references.get(occurrenceKey(reference)) ?? reference);
        const admission = deriveCanonicalAdmission(references, now);
        // Keep the rest of the job document exactly as stored; only the
        // rewritten references, the canonical admission, and the visibility
        // metadata `putInternship` would synthesize change.
        const job = canonicalCatalogRecency({
          ...entry.document,
          sourceReferences: references,
          ...(admission ? { admission } : {}),
        });
        const value = JSON.stringify(job);
        if (value === entry.oldValue) continue;
        buffer.push({ pk: entry.targetPk, sk: entry.targetSk, label: entry.label, oldValue: entry.oldValue, value, columns: derivedColumns(job) });
      }
      jobEntries.clear();
      bytes = 0;
      if (!buffer.length) return;
      const targets = buffer.splice(0, buffer.length);
      if (input.collectDescriptors) {
        for (const target of targets) {
          result.descriptors.push({ pk: target.pk, sk: target.sk, before: planFingerprint(target.oldValue), after: planFingerprint(target.value) });
        }
      }
      await input.flush(targets);
    };
    let cursor = '';
    for (;;) {
      const rows = await occurrencePage(db, sourceId, cursor);
      if (!rows.length) break;
      cursor = rows[rows.length - 1]!.sk;
      const states: Array<{ row: CatalogRow; state: SourceOccurrenceState }> = [];
      for (const row of rows) {
        const state = parse<SourceOccurrenceState>(row.value);
        if (state) states.push({ row, state });
        else { skipped += 1; record('skipped', `${sourceId}:${row.sk}`); }
      }
      const jobs = await loadJobs(db, states.map(({ state }) => state.jobId));
      for (const { row, state } of states) {
        const label = `${sourceId}:${state.externalId ?? row.sk}`;
        const jobRow = jobs.get(`JOB#${state.jobId}`);
        const document = parse<Internship>(jobRow?.value);
        const attached = document?.sourceReferences.some((reference) => reference.sourceId === sourceId
          && reference.externalId === state.externalId) === true;
        const stored = state.occurrence;
        if (!jobRow || !document || !attached) { skipped += 1; record('skipped', label); continue; }
        const decision = decisionFor({ policy, version, now, reference: stored });
        if (decision.category === 'skipped') { skipped += 1; record('skipped', label); continue; }
        countRow(before, stored.admission?.catalogEligible === true,
          stored.trustedCommunityAlertQualification?.catalogPublicationSuppressed === true);
        if (decision.category === 'unchanged') {
          record('unchanged', label);
          countRow(after, stored.admission?.catalogEligible === true, false);
          continue;
        }
        record(decision.category, label);
        countRow(after, decision.admission.catalogEligible, false);
        const jobPk = `JOB#${state.jobId}`;
        let entry = jobEntries.get(jobPk);
        if (!entry) {
          entry = { targetPk: jobPk, targetSk: 'META', label: state.jobId, oldValue: jobRow.value, document, references: new Map() };
          jobEntries.set(jobPk, entry);
          result.jobs.add(jobPk);
          bytes += jobRow.value.length * 2;
        }
        entry.references.set(occurrenceKey(decision.reference), decision.reference);
        const value = JSON.stringify({ ...state, occurrence: decision.reference });
        buffer.push({ pk: row.pk, sk: row.sk, label, oldValue: row.value, value });
        bytes += row.value.length + value.length;
        if (buffer.length + jobEntries.size >= APPLY_TARGET_ROWS || bytes >= APPLY_TARGET_BYTES) await flush();
      }
      if (rows.length < OCCURRENCE_PAGE_ROWS) break;
    }
    // The migration's continuation obligation is a source-scoped flag. Clear it
    // only when every occurrence of this source reached a decision: an ungraded
    // row must keep the poller's obligation instead of being silently dropped.
    const checkpoint = parse<SourceCheckpoint>(checkpointRow?.value);
    if (checkpointRow && checkpoint && checkpoint.pendingAdmissionConfigurationVersion !== undefined && !skipped) {
      const remaining = { ...checkpoint };
      delete remaining.pendingAdmissionConfigurationVersion;
      buffer.push({
        pk: checkpointRow.pk, sk: checkpointRow.sk, label: `${sourceId}:checkpoint`,
        oldValue: checkpointRow.value, value: JSON.stringify(remaining),
      });
      result.checkpoints += 1;
    }
    await flush();
  }
  return result;
}

async function clearStagedTargets(db: D1Database, stagePk: string): Promise<void> {
  await db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}'`).bind(stagePk).run();
}

async function conflictingTargets(db: D1Database, stagePk: string): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT json_extract(staged.value, '$.label') AS label
    FROM catalog_items AS staged
    LEFT JOIN catalog_items AS current
      ON current.pk = staged.source_id AND current.sk = staged.external_id
    WHERE staged.pk = ? AND staged.kind = '${STAGE_KIND}'
      AND (current.value IS NULL OR current.value <> json_extract(staged.value, '$.oldValue'))
    ORDER BY staged.sk LIMIT ${CONFLICT_LIMIT}
  `).bind(stagePk).all<{ label: string }>();
  return rows.results.length ? rows.results.map((row) => row.label) : ['trusted admission rows changed during the guarded apply'];
}

/**
 * Stages one bounded group under the token and applies it in a single guarded
 * statement: every target must still hold the value this run read, otherwise
 * the whole group is a no-op. A stale token writes nothing at all, because the
 * staged-count guard only matches the rows the current plan staged.
 */
async function applyTargets(db: D1Database, token: string, targets: Target[]): Promise<{ applied: number; conflicts: string[] }> {
  const stagePk = `TRUSTED_ADMISSION_REPAIR#${token}`;
  const statements = [];
  for (let offset = 0; offset < targets.length; offset += STAGE_ROWS_PER_STATEMENT) {
    const chunk = targets.slice(offset, offset + STAGE_ROWS_PER_STATEMENT);
    const values = chunk.map(() => `(?, ?, '${STAGE_KIND}', ?, ?, ?)`).join(', ');
    statements.push(db.prepare(`
      INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id)
      VALUES ${values}
      ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value,
        source_id = excluded.source_id, external_id = excluded.external_id
    `).bind(...chunk.flatMap((target) => [
      stagePk,
      catalogQualityHash([target.pk, target.sk]),
      JSON.stringify({ label: target.label, oldValue: target.oldValue, value: target.value, ...target.columns }),
      target.pk,
      target.sk,
    ])));
  }
  for (let offset = 0; offset < statements.length; offset += STAGE_STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(offset, offset + STAGE_STATEMENTS_PER_BATCH));
  }
  const applied = await db.prepare(`
    WITH staged AS MATERIALIZED (
      SELECT source_id AS target_pk, external_id AS target_sk, value AS repair
      FROM catalog_items WHERE pk = ? AND kind = '${STAGE_KIND}'
    ), guards AS MATERIALIZED (
      SELECT
        (SELECT COUNT(*) FROM staged) AS staged_count,
        (SELECT COUNT(*) FROM staged
          JOIN catalog_items AS current
            ON current.pk = staged.target_pk AND current.sk = staged.target_sk
           AND current.value = json_extract(staged.repair, '$.oldValue')) AS matching_count
    )
    UPDATE catalog_items AS target SET
      value = json_extract(staged.repair, '$.value'),
      url_key = CASE WHEN target.kind = 'internship' THEN json_extract(staged.repair, '$.urlKey') ELSE target.url_key END,
      fingerprint_key = CASE WHEN target.kind = 'internship' THEN json_extract(staged.repair, '$.fingerprintKey') ELSE target.fingerprint_key END,
      sms_pending = CASE WHEN target.kind = 'internship' THEN json_extract(staged.repair, '$.smsPending') ELSE target.sms_pending END,
      digest_pending = CASE WHEN target.kind = 'internship' THEN json_extract(staged.repair, '$.digestPending') ELSE target.digest_pending END,
      catalog_state = CASE WHEN target.kind = 'internship' THEN json_extract(staged.repair, '$.catalogState') ELSE target.catalog_state END,
      catalog_sort_key = CASE WHEN target.kind = 'internship' THEN json_extract(staged.repair, '$.catalogSortKey') ELSE target.catalog_sort_key END,
      search_text = CASE WHEN target.kind = 'internship' THEN json_extract(staged.repair, '$.searchText') ELSE target.search_text END,
      source_classes = CASE WHEN target.kind = 'internship' THEN json_extract(staged.repair, '$.sourceClasses') ELSE target.source_classes END
    FROM staged, guards
    WHERE target.pk = staged.target_pk AND target.sk = staged.target_sk
      AND guards.staged_count = ? AND guards.matching_count = ?
  `).bind(stagePk, targets.length, targets.length).run();
  const conflicts = applied.meta.changes === targets.length ? [] : await conflictingTargets(db, stagePk);
  try { await clearStagedTargets(db, stagePk); }
  catch { /* Staging rows are inert and a cleanup failure must not hide a successful atomic apply. */ }
  return { applied: applied.meta.changes, conflicts };
}

export async function runTrustedAdmissionBackfill(
  db: D1Database,
  options: { apply?: boolean; repairToken?: string; expectedChanged?: number; sourceIds?: string[] } = {},
): Promise<TrustedAdmissionBackfillReport> {
  const sourceIds = trustedSourceIds(options.sourceIds);
  const now = new Date().toISOString();
  // The poller derives this from the resolver's `configurationVersion()`, which
  // hashes the reviewed admission configuration stored in D1.
  const resolverVersion = await new D1CatalogAdmissionStore(db).configurationVersion();
  const versions = new Map(sourceIds.map((sourceId) => [sourceId, admissionConfigurationVersion(sourceId, resolverVersion)]));
  const plan = await scanTrustedSources({
    db, sourceIds, versions, now, collectDescriptors: true,
    flush: async () => { /* The plan pass only reads; the token authorizes the writes. */ },
  });
  const repairToken = catalogQualityHash(plan.descriptors);
  const changed = plan.totals.published + plan.totals.regraded;
  const report: TrustedAdmissionBackfillReport = {
    dryRun: !options.apply,
    before: plan.before,
    after: plan.after,
    totals: plan.totals,
    changes: { occurrences: changed, jobs: plan.jobs.size, checkpoints: plan.checkpoints },
    samples: plan.samples,
    repairToken,
    expectedChanged: changed,
    conflicts: [],
    projectionRefreshRequired: false,
  };
  if (!options.apply) return report;
  if (options.repairToken !== repairToken || options.expectedChanged !== changed) {
    throw new Error('Trusted admission eligibility changed after dry run; use the latest repair token and exact changed-row count');
  }
  if (!changed) return report;
  const outcome = { occurrences: 0, conflicts: [] as string[] };
  const applied = await scanTrustedSources({
    db, sourceIds, versions, now, collectDescriptors: false,
    flush: async (targets) => {
      // A guard failure means a concurrent writer touched this cohort; stop
      // instead of stacking more groups on top of a catalog that moved.
      if (outcome.conflicts.length) return;
      const result = await applyTargets(db, repairToken, targets);
      // A rejected group writes nothing, so it must not be reported as applied.
      if (!result.conflicts.length) outcome.occurrences += targets.filter((target) => target.sk.startsWith('OCCURRENCE#')).length;
      outcome.conflicts.push(...result.conflicts);
    },
  });
  report.conflicts = outcome.conflicts;
  report.projectionRefreshRequired = outcome.occurrences > 0;
  if (!report.conflicts.length && (applied.totals.published + applied.totals.regraded !== changed || outcome.occurrences !== changed)) {
    report.conflicts = ['Trusted admission rows changed between planning and apply'];
  }
  return report;
}
