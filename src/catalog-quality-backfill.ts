import { catalogSearchText, catalogSourceClasses } from './catalog-fields.js';
import { catalogEligible } from './catalog-admission.js';
import { openCatalogSortKey } from './catalog-recency.js';
import { normalizeInternship, normalizeListing, catalogQualityHash } from './catalog-quality.js';
import { isPastSeason } from './core/early-career.js';
import type { Internship, SourceCheckpoint, SourceOccurrenceState } from './types.js';
import type { D1Database } from '../cloudflare/types.js';
import { catalogProviderForSourceId, isOfficialProviderSourceId } from './integration-registry.js';

export type CatalogQualityRow = { pk: string; sk: string; kind: string; value: string };
type Category = 'changed' | 'closed' | 'unchanged' | 'unrepairable';
type Field = 'company' | 'title' | 'location' | 'compensation';
type Counts = Record<string, Record<Field, number>>;

export interface CatalogQualityBackfillReport {
  dryRun: boolean;
  before: Counts;
  after: Counts;
  totals: Record<Category, number>;
  samples: Record<Category, string[]>;
  repairToken: string;
  expectedChanged: number;
  conflicts: string[];
  projectionRefreshRequired: boolean;
}

type Repair = { row: CatalogQualityRow; value: Internship | SourceOccurrenceState; category: Category; id: string };
type StagedRepair = {
  id: string;
  oldValue: string;
  value: string;
  urlKey?: string;
  fingerprintKey?: string;
  smsPending?: number;
  digestPending?: number;
  catalogState?: string | null;
  catalogSortKey?: string | null;
  searchText?: string | null;
  sourceClasses?: string | null;
};

const provider = (sourceId: string) => catalogProviderForSourceId(sourceId) ?? 'community';
const emptyCounts = (): Counts => ({});

function qualityFlags(value: Internship | SourceOccurrenceState): Record<Field, boolean> {
  const item = 'occurrence' in value ? value.occurrence : value;
  const normalized = 'occurrence' in value ? normalizeListing(value.occurrence) : normalizeInternship(value);
  return {
    company: item.company !== normalized.company,
    title: item.title !== normalized.title,
    location: item.location !== normalized.location || !item.locations?.length,
    compensation: item.compensation.raw !== normalized.compensation.raw || item.compensation.raw.length > 160,
  };
}

function increment(counts: Counts, source: string, flags: Record<Field, boolean>) {
  const bucket = counts[source] ??= { company: 0, title: 0, location: 0, compensation: 0 };
  for (const key of Object.keys(flags) as Field[]) if (flags[key]) bucket[key] += 1;
}

function explicitElapsedRole(job: Internship, checkpoints: Map<string, SourceCheckpoint>): boolean {
  if (!isPastSeason(job.season)) return true;
  const identity = job.internshipIdentity as { season?: { evidence?: string; evidenceStatus?: string } } | undefined;
  const explicit = identity?.season?.evidence === 'explicit' || identity?.season?.evidenceStatus === 'explicit';
  return Boolean(explicit && job.sourceReferences.some((reference) => {
    if (reference.state !== 'open' || !reference.externalId || !isOfficialProviderSourceId(reference.sourceId)) return false;
    return checkpoints.get(reference.sourceId)?.activeExternalIds?.includes(reference.externalId);
  }));
}

function repairRows(rows: CatalogQualityRow[]) {
  const checkpoints = new Map<string, SourceCheckpoint>();
  for (const row of rows.filter((item) => item.kind === 'checkpoint')) {
    try {
      const checkpoint = JSON.parse(row.value) as SourceCheckpoint;
      checkpoints.set(checkpoint.sourceId, checkpoint);
    } catch { /* A malformed checkpoint cannot verify an elapsed role. */ }
  }
  const repairs: Repair[] = [];
  const before = emptyCounts(); const after = emptyCounts();
  const totals: Record<Category, number> = { changed: 0, closed: 0, unchanged: 0, unrepairable: 0 };
  const samples: Record<Category, string[]> = { changed: [], closed: [], unchanged: [], unrepairable: [] };
  const sample = (category: Category, id: string) => { if (samples[category].length < 10) samples[category].push(id); };
  for (const row of rows.filter((item) => item.kind === 'internship' || item.kind === 'source-occurrence')) {
    try {
      const current = JSON.parse(row.value) as Internship | SourceOccurrenceState;
      const sourceIds = 'occurrence' in current ? [current.sourceId] : current.sourceReferences.map((item) => item.sourceId);
      const providers = [...new Set(sourceIds.map(provider))];
      for (const name of providers) increment(before, name, qualityFlags(current));
      let proposed: Internship | SourceOccurrenceState;
      let category: Category = 'unchanged';
      const id = 'occurrence' in current ? `${current.sourceId}:${current.externalId}` : current.jobId;
      if ('occurrence' in current) {
        proposed = { ...current, occurrence: normalizeListing(current.occurrence) };
      } else {
        proposed = normalizeInternship(current);
        if (proposed.open && !explicitElapsedRole(proposed, checkpoints)) { proposed = { ...proposed, open: false }; category = 'closed'; }
      }
      for (const name of providers) increment(after, name, qualityFlags(proposed));
      if (category !== 'closed') category = JSON.stringify(proposed) === row.value ? 'unchanged' : 'changed';
      totals[category] += 1; sample(category, id);
      repairs.push({ row, value: proposed, category, id });
    } catch {
      totals.unrepairable += 1;
      sample('unrepairable', `${row.pk}:${row.sk}`);
    }
  }
  return { repairs, before, after, totals, samples };
}

export function catalogQualityBackfillPlan(rows: CatalogQualityRow[]) {
  const plan = repairRows(rows);
  const changed = plan.repairs.filter((item) => item.category === 'changed' || item.category === 'closed');
  const repairToken = catalogQualityHash(changed.map((item) => ({ pk: item.row.pk, sk: item.row.sk, before: catalogQualityHash(item.row.value), after: catalogQualityHash(item.value) })));
  return { ...plan, changed, repairToken };
}

const REPAIR_STAGE_KIND = 'catalog-quality-repair';
const STAGE_ROWS_PER_STATEMENT = 20;
const STAGE_STATEMENTS_PER_BATCH = 25;

function stagedRepair(repair: Repair): StagedRepair {
  const staged: StagedRepair = {
    id: repair.id,
    oldValue: repair.row.value,
    value: JSON.stringify(repair.value),
  };
  if (repair.row.kind !== 'internship') return staged;
  const job = repair.value as Internship;
  // A visible row is one the catalog admits: deriving `catalog_state` from
  // `open` alone would mark rows the directory gate rejected as OPEN, and the
  // browse query trusts this column.
  const visible = job.technical !== false && catalogEligible(job);
  return {
    ...staged,
    urlKey: job.normalizedUrl,
    fingerprintKey: job.fingerprint,
    smsPending: job.notification.smsPending && visible ? 1 : 0,
    digestPending: job.notification.digestPending && visible ? 1 : 0,
    catalogState: visible ? (job.open ? 'OPEN' : 'CLOSED') : null,
    catalogSortKey: visible ? (job.open ? openCatalogSortKey(job) : `${job.lastSeenAt}#${job.jobId}`) : null,
    searchText: visible ? catalogSearchText(job) : null,
    sourceClasses: visible ? JSON.stringify(catalogSourceClasses(job)) : null,
  };
}

async function stageRepairs(db: D1Database, token: string, repairs: Repair[]): Promise<void> {
  const stagePk = `CATALOG_QUALITY_REPAIR#${token}`;
  const repairsPerBatch = STAGE_ROWS_PER_STATEMENT * STAGE_STATEMENTS_PER_BATCH;
  for (let batchOffset = 0; batchOffset < repairs.length; batchOffset += repairsPerBatch) {
    const batch = repairs.slice(batchOffset, batchOffset + repairsPerBatch);
    const statements = [];
    for (let offset = 0; offset < batch.length; offset += STAGE_ROWS_PER_STATEMENT) {
      const chunk = batch.slice(offset, offset + STAGE_ROWS_PER_STATEMENT);
      const values = chunk.map(() => `(?, ?, '${REPAIR_STAGE_KIND}', ?, ?, ?)`).join(', ');
      statements.push(db.prepare(`
        INSERT INTO catalog_items (pk, sk, kind, value, source_id, external_id)
        VALUES ${values}
        ON CONFLICT(pk, sk) DO UPDATE SET kind = excluded.kind, value = excluded.value,
          source_id = excluded.source_id, external_id = excluded.external_id
      `).bind(...chunk.flatMap((repair) => [
        stagePk,
        catalogQualityHash([repair.row.pk, repair.row.sk]),
        JSON.stringify(stagedRepair(repair)),
        repair.row.pk,
        repair.row.sk,
      ])));
    }
    await db.batch(statements);
  }
}

async function clearStagedRepairs(db: D1Database, stagePk: string): Promise<void> {
  await db.prepare(`DELETE FROM catalog_items WHERE pk = ? AND kind = '${REPAIR_STAGE_KIND}'`).bind(stagePk).run();
}

/**
 * The plan needs every row, but one `SELECT` over the whole catalog exceeds the
 * D1 result limit at production size (40,940 rows on 2026-09-17). Read it in
 * keyset pages and keep the mapping work unchanged.
 */
const CATALOG_QUALITY_PAGE_ROWS = 500;

async function catalogQualityRows(db: D1Database): Promise<CatalogQualityRow[]> {
  const rows: CatalogQualityRow[] = [];
  let afterPk = '';
  let afterSk = '';
  for (;;) {
    const page = await db.prepare(`SELECT pk, sk, kind, value FROM catalog_items
      WHERE kind IN ('internship', 'source-occurrence', 'checkpoint')
        AND (pk > ? OR (pk = ? AND sk > ?))
      ORDER BY pk, sk LIMIT ?`)
      .bind(afterPk, afterPk, afterSk, CATALOG_QUALITY_PAGE_ROWS).all<CatalogQualityRow>();
    rows.push(...page.results);
    if (page.results.length < CATALOG_QUALITY_PAGE_ROWS) break;
    const last = page.results[page.results.length - 1]!;
    // A store that ignores the keyset predicate would repeat the same page
    // forever, so stop as soon as the cursor stops advancing.
    if (last.pk === afterPk && last.sk === afterSk) break;
    afterPk = last.pk;
    afterSk = last.sk;
  }
  return rows;
}

export async function runCatalogQualityBackfill(
  db: D1Database,
  options: { apply?: boolean; repairToken?: string; expectedChanged?: number } = {},
): Promise<CatalogQualityBackfillReport> {
  const plan = catalogQualityBackfillPlan(await catalogQualityRows(db));
  const report: CatalogQualityBackfillReport = {
    dryRun: !options.apply,
    before: plan.before,
    after: plan.after,
    totals: plan.totals,
    samples: plan.samples,
    repairToken: plan.repairToken,
    expectedChanged: plan.changed.length,
    conflicts: [],
    projectionRefreshRequired: false,
  };
  if (!options.apply) return report;
  if (options.repairToken !== plan.repairToken || options.expectedChanged !== plan.changed.length) {
    throw new Error('Catalog changed after dry run; use the latest repair token and exact changed-record count');
  }
  if (!plan.changed.length) return report;
  const stagePk = `CATALOG_QUALITY_REPAIR#${plan.repairToken}`;
  await stageRepairs(db, plan.repairToken, plan.changed);
  const applied = await db.prepare(`
    WITH staged AS MATERIALIZED (
      SELECT source_id AS target_pk, external_id AS target_sk, value AS repair
      FROM catalog_items WHERE pk = ? AND kind = '${REPAIR_STAGE_KIND}'
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
  `).bind(stagePk, plan.changed.length, plan.changed.length).run();
  if (applied.meta.changes !== plan.changed.length) {
    const conflicts = await db.prepare(`
      SELECT json_extract(staged.value, '$.id') AS id
      FROM catalog_items AS staged
      LEFT JOIN catalog_items AS current
        ON current.pk = staged.source_id AND current.sk = staged.external_id
      WHERE staged.pk = ? AND staged.kind = '${REPAIR_STAGE_KIND}'
        AND (current.value IS NULL OR current.value <> json_extract(staged.value, '$.oldValue'))
      ORDER BY staged.sk
    `).bind(stagePk).all<{ id: string }>();
    report.conflicts = conflicts.results.map((item) => item.id);
    if (!report.conflicts.length) report.conflicts = ['catalog changed after staging'];
  }
  try { await clearStagedRepairs(db, stagePk); }
  catch { /* Staging rows are inert and a cleanup failure must not hide a successful atomic apply. */ }
  report.projectionRefreshRequired = applied.meta.changes === plan.changed.length;
  return report;
}
