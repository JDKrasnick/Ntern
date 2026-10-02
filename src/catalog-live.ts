import { catalogEligible } from './catalog-admission.js';
import { employerDropDay, employerDropGroupId, employerDropKey, catalogGroupDetails, compareCatalogProjectionGroups, groupCatalogJobs, programCatalogGroupId, type CatalogGroupDetails } from './catalog-groups.js';
import { isPastSeason } from './core/early-career.js';
import type { Internship } from './types.js';

/**
 * Cards for roles the published projection has not observed yet.
 *
 * The projection is a snapshot rebuilt on a ten-minute cadence, but a role is
 * alerts-eligible the moment its source occurrence is published. Reading the
 * two on different clocks made a fresh role notifiable before it was
 * browsable. The overlay closes that gap without a second write path: the
 * snapshot names the newest role it contains, and any open role published after
 * that watermark is grouped on the spot from live rows.
 *
 * `jobs` must be closed under the grouping relations — every role of each
 * affected employer day, plus the published release or program card of the delta
 * — so the cards an overlay produces are identical to the ones the next publish
 * will write.
 */
export interface LiveCatalogOverlay {
  groups: CatalogGroupDetails[];
  groupIds: Set<string>;
  roleIds: Set<string>;
}

/** The publishability rule the projection builder applies to catalog rows. */
export function catalogPublishable(job: Internship): boolean {
  return job.technical !== false && catalogEligible(job) && !isPastSeason(job.season);
}

function buildLiveCatalogOverlay(jobs: Internship[]): LiveCatalogOverlay {
  const groups = groupCatalogJobs(jobs, { includeClosed: true })
    .map(catalogGroupDetails)
    .sort(compareCatalogProjectionGroups);
  return {
    groups,
    groupIds: new Set(groups.map(({ group }) => group.groupId)),
    roleIds: new Set(groups.flatMap(({ roles }) => roles.map(({ jobId }) => jobId))),
  };
}

/**
 * A published card is superseded only when the overlay accounts for every role
 * it holds. Superseding on any overlap would drop a card whose remaining roles
 * the overlay never loaded, and a missing role is worse than a repeated one.
 */
export function overlaySupersedesGroup(overlay: LiveCatalogOverlay, details: CatalogGroupDetails): boolean {
  return details.roles.every(({ jobId }) => overlay.roleIds.has(jobId));
}

export interface LiveCatalogOverlaySource {
  listCatalogSince(sortKeyExclusive: string, limit: number): Promise<Internship[]>;
  listCatalogWindow(day: string): Promise<Internship[]>;
  getJobs(jobIds: readonly string[]): Promise<Internship[]>;
  /** The published card only; an overlay-aware reader must not call itself here. */
  getPublishedCatalogGroup(groupId: string): Promise<CatalogGroupDetails | undefined>;
}

/**
 * The most roles a read will group on the spot. A projection that has fallen
 * hours behind is an incident rather than a publication burst, and grouping
 * everything since then on a public read would put a 128 MB isolate at risk; past
 * these bounds the snapshot serves until the next tick catches up.
 */
export const MAX_LIVE_DELTA_ROLES = 200;
export const MAX_LIVE_OVERLAY_ROLES = 500;

/**
 * Loads the delta and closes it over the grouping relations before grouping:
 * every role of each affected employer day, plus the published program or
 * release card a delta role joins, so the overlay reproduces exactly the cards
 * the next publish will write.
 */
export async function liveCatalogOverlayFromStore(
  source: LiveCatalogOverlaySource,
  watermark: string,
): Promise<LiveCatalogOverlay | undefined> {
  // Newest first, and one row past the bound, so an oversized delta is refused
  // rather than silently truncated.
  const delta = (await source.listCatalogSince(watermark, MAX_LIVE_DELTA_ROLES + 1)).filter(catalogPublishable);
  if (!delta.length || delta.length > MAX_LIVE_DELTA_ROLES) return undefined;
  const jobs = new Map(delta.map((job) => [job.jobId, job]));
  // A release card is one employer's UTC day, so the delta is closed by adding
  // every role of each affected employer day — and only those, so an unrelated
  // employer's cards on the same day stay published.
  const days = new Set<string>();
  const employerDays = new Set<string>();
  for (const job of delta) {
    const day = employerDropDay(job);
    if (day) days.add(day);
    const key = employerDropKey(job);
    if (key) employerDays.add(key);
  }
  for (const day of days) {
    for (const job of await source.listCatalogWindow(day)) {
      if (catalogPublishable(job) && employerDays.has(employerDropKey(job) ?? '')) jobs.set(job.jobId, job);
    }
    if (jobs.size > MAX_LIVE_OVERLAY_ROLES) return undefined;
  }
  // A role's release card is keyed by employer and day, and its program card by
  // the role's own identity, so both can be looked up without a scan. Loading
  // them keeps the overlay authoritative over cards that reach past one day.
  for (const job of delta) {
    for (const groupId of [employerDropGroupId(job), programCatalogGroupId(job)]) {
      if (!groupId) continue;
      const published = await source.getPublishedCatalogGroup(groupId);
      if (!published) continue;
      const missing = published.roles.map((role) => role.jobId).filter((jobId) => !jobs.has(jobId));
      if (!missing.length) continue;
      for (const loaded of await source.getJobs(missing)) if (catalogPublishable(loaded)) jobs.set(loaded.jobId, loaded);
    }
  }
  return buildLiveCatalogOverlay([...jobs.values()]);
}
