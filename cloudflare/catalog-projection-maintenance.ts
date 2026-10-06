import { catalogGroupDetails, compareCatalogProjectionGroups, groupCatalogJobs } from '../src/catalog-groups.js';
import { catalogRecency, openCatalogSortKey } from '../src/catalog-recency.js';
import type { D1InternshipStore } from './d1-store.js';
import { R2CatalogProjection } from './r2-catalog-projection.js';
import type { R2Bucket } from './types.js';
import { recordPhase, type MaintenancePhaseRecorder } from './maintenance-phases.js';
export { recordPhase } from './maintenance-phases.js';

/** Runs one scheduled responsibility in isolation. Several of them share the
 * maintenance cron, and a thrown error used to abort the handler — which is how
 * one failing step held the catalog projection on a day-old snapshot. The
 * failure stays visible as an error-level event instead.
 *
 * A durable marker brackets each step when a recorder is supplied. A Worker that
 * dies on the memory limit cannot flush its console, so the marker rows are the
 * only surviving record of which phase was entered and which one finished. A
 * caller may also pass a collector so the same failure reaches the scheduled
 * ingestion-health alert. */
export async function runScheduledStep<T>(
  step: string,
  run: () => Promise<T>,
  phases?: MaintenancePhaseRecorder,
  failures?: string[],
): Promise<T | undefined> {
  await recordPhase(phases, step, 'started');
  try {
    const result = await run();
    await recordPhase(phases, step, 'complete');
    return result;
  } catch (error) {
    await recordPhase(phases, step, 'failed');
    // A step failure is already logged; when a caller passes a collector it is
    // also surfaced through the scheduled ingestion-health alert.
    failures?.push(step);
    console.error(JSON.stringify({ event: 'scheduled_step_failed', step, error: error instanceof Error ? error.message : String(error) }));
    return undefined;
  }
}

export async function runCatalogProjectionMaintenance<T>(
  publishShadow: (refreshProjection: () => Promise<T>) => Promise<unknown>,
  refreshProjection: () => Promise<T>,
  phases?: MaintenancePhaseRecorder,
): Promise<{ prospectiveShadowMetadata: unknown; projection: T | undefined }> {
  let projectionPromise: Promise<T> | undefined;
  const refreshProjectionOnce = () => projectionPromise ??= refreshProjection();
  const prospectiveShadowMetadata = await runScheduledStep('prospective_shadow_metadata', () => publishShadow(refreshProjectionOnce), phases);
  const projection = await runScheduledStep('catalog_projection', refreshProjectionOnce, phases);
  return { prospectiveShadowMetadata, projection };
}

export async function refreshCatalogProjection(store: D1InternshipStore, bucket?: R2Bucket, phases?: MaintenancePhaseRecorder, revalidateOnly = false) {
  // One order for both read models: the card's own `updatedAt` (with its group id
  // breaking ties) is stored on each D1 row as its sort key, and R2 pages are
  // written in the same order, so a reader of either sees the same sequence.
  // The newest open role this publish can see becomes the readers' watermark: a
  // role published after it is grouped live until the next tick, so an alert and
  // the catalog never disagree about a role that already exists.
  const jobs = await store.listCatalog();
  const liveWatermark = jobs.reduce<string | undefined>((newest, job) => {
    if (!job.open || catalogRecency(job) !== 'normal') return newest;
    const key = openCatalogSortKey(job);
    return !newest || key > newest ? key : newest;
  }, undefined);
  const groups = groupCatalogJobs(jobs, { includeClosed: true })
    .map(catalogGroupDetails).sort(compareCatalogProjectionGroups);
  const generatedAt = new Date().toISOString();
  await recordPhase(phases, 'catalog_projection_d1', 'started');
  try {
    await store.putCatalogProjection(groups, generatedAt, liveWatermark);
    await recordPhase(phases, 'catalog_projection_d1', 'complete');
  } catch (error) {
    await recordPhase(phases, 'catalog_projection_d1', 'failed');
    throw error;
  }
  if (bucket && revalidateOnly) {
    try {
      await new R2CatalogProjection(bucket).revalidate(groups, generatedAt, liveWatermark);
    } catch (error) {
      // A newly committed D1 generation must never leave an unverified old R2 view live.
      await new R2CatalogProjection(bucket).invalidate(generatedAt);
      throw error;
    }
  } else if (bucket) {
    await recordPhase(phases, 'catalog_projection_r2', 'started');
    try {
      await new R2CatalogProjection(bucket).publish(groups, generatedAt, liveWatermark);
      await recordPhase(phases, 'catalog_projection_r2', 'complete');
    }
    catch (error) {
      await recordPhase(phases, 'catalog_projection_r2', 'failed');
      console.error(JSON.stringify({ event: 'r2_catalog_projection_publish_failed', error: String(error) }));
      // D1 already points at the new projection. Hide an older R2 pointer so
      // readers fall back to D1 instead of serving stale admission decisions.
      try { await new R2CatalogProjection(bucket).invalidate(generatedAt); }
      catch (invalidationError) {
        console.error(JSON.stringify({ event: 'r2_catalog_projection_invalidation_failed', error: String(invalidationError) }));
      }
    }
  }
  return {
    generatedAt,
    groups: groups.length,
    roles: groups.reduce((total, group) => total + group.roles.length, 0),
  };
}

export async function refreshCatalogProjectionD1(
  store: D1InternshipStore,
  bucket: R2Bucket | undefined,
  phases?: MaintenancePhaseRecorder,
) {
  // Reuse complete pages only when their content hash matches this exact D1 view.
  // Changed admission decisions still invalidate R2 until its dedicated cron publishes.
  return refreshCatalogProjection(store, bucket, phases, true);
}

export async function refreshCatalogProjectionR2(store: D1InternshipStore, bucket: R2Bucket, phases?: MaintenancePhaseRecorder) {
  const snapshot = await store.catalogProjectionSnapshot();
  if (!snapshot) throw new Error('D1 catalog projection is unavailable for R2 publication');
  const { groups, generatedAt, liveWatermark } = snapshot;
  await recordPhase(phases, 'catalog_projection_r2', 'started');
  try {
    await new R2CatalogProjection(bucket).publish(groups, generatedAt, liveWatermark);
    await recordPhase(phases, 'catalog_projection_r2', 'complete');
  } catch (error) {
    await recordPhase(phases, 'catalog_projection_r2', 'failed');
    try { await new R2CatalogProjection(bucket).invalidate(generatedAt); } catch { /* D1 remains authoritative. */ }
    throw error;
  }
  return { generatedAt, groups: groups.length, roles: groups.reduce((total, group) => total + group.roles.length, 0) };
}
