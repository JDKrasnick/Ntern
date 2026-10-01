/**
 * The swipe deck's decisions, kept pure and testable.
 *
 * A deck card is one open role, newest first. The view owns the drag animation;
 * this module owns what a released drag means, which roles are still in play,
 * and how the device remembers a role the reader passed on. "Not now" is a
 * browsing gesture, not an account record, so it stays on the device the same
 * way a locally hidden role does.
 */

/** The roles a reader has passed on, kept on this device only. */
export const swipeSkipCacheKey = "internnotifs.swipe-skips.v1";

/**
 * Every role the deck has already presented to this reader. A role that has
 * been seen is never served again, whether it was passed, queued, opened, or
 * simply left on screen. Kept on this device only.
 */
export const swipeSeenCacheKey = "internnotifs.swipe-seen.v1";

/** The last deck a reader saw, so the surface paints instantly on return. */
export const swipeDeckCacheKey = "internnotifs.swipe-deck.v1";

/** How many roles one page of the public feed carries. */
export const swipeDeckPageSize = 25;

/**
 * Keep two full pages ready so a slow refill finishes while the reader is still
 * working through already-rendered cards.
 */
export const swipeDeckPrefetchFloor = swipeDeckPageSize * 2;

/** Bound the on-device skip list so storage cannot grow without limit. */
export const swipeSkipLimit = 2_000;

/** Bound the on-device seen list the same way. */
export const swipeSeenLimit = 2_000;

/** Fraction of the card's width a drag must cross to commit. */
const commitDistanceRatio = 0.26;
/** A phone swipe never has to travel farther than this to commit. */
const commitDistanceCap = 132;
/** The farthest a drag can require before it is treated as a slow drag. */
const commitDistanceFloor = 64;
/** A quick flick commits even when it did not travel far. */
const commitVelocity = 0.62;

export type SwipeOutcome = "queue" | "skip" | "none";

/**
 * Which way a released drag commits. Right is the affirmative action — the role
 * joins the apply queue — and left is "not now". Below the threshold the card
 * returns to the deck. Velocity lets a short flick commit on its own, which is
 * what makes the deck feel responsive rather than rubbery.
 */
export function resolveSwipe(input: { dx: number; vx: number; width: number }): SwipeOutcome {
  const threshold = Math.min(
    commitDistanceCap,
    Math.max(commitDistanceFloor, input.width * commitDistanceRatio),
  );
  if (input.dx >= threshold || (input.dx > 0 && input.vx >= commitVelocity)) return "queue";
  if (input.dx <= -threshold || (input.dx < 0 && input.vx <= -commitVelocity)) return "skip";
  return "none";
}

/**
 * The roles still in play: deduplicated, and never one already queued, hidden,
 * or passed on. The deck keeps this list authoritative instead of pruning the
 * fetched pages, so an undo can put a role back without another request.
 */
export function deckCandidates<T extends { jobId: string }>(
  jobs: readonly T[],
  excluded: {
    queued?: ReadonlySet<string>;
    hidden?: ReadonlySet<string>;
    skipped?: ReadonlySet<string>;
  } = {},
): T[] {
  const queued = excluded.queued ?? new Set<string>();
  const hidden = excluded.hidden ?? new Set<string>();
  const skipped = excluded.skipped ?? new Set<string>();
  const seen = new Set<string>();
  const result: T[] = [];
  for (const job of jobs) {
    if (!job?.jobId || seen.has(job.jobId)) continue;
    seen.add(job.jobId);
    if (queued.has(job.jobId) || hidden.has(job.jobId) || skipped.has(job.jobId)) continue;
    result.push(job);
  }
  return result;
}

/**
 * Add cached, seeded, or freshly fetched roles behind the deck already on
 * screen. Preserving the visible order prevents a background refresh from
 * replacing the card under the reader's finger.
 */
export function mergeDeckJobs<T extends { jobId: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const known = new Set(current.map((job) => job.jobId));
  return [...current, ...incoming.filter((job) => job?.jobId && !known.has(job.jobId))];
}

/** Remember the most recent "not now" first, de-duplicated and bounded. */
export function rememberSkip(
  previous: readonly string[],
  jobId: string,
  limit = swipeSkipLimit,
): string[] {
  const bounded = Math.max(1, limit);
  return [jobId, ...previous.filter((id) => id !== jobId)].slice(0, bounded);
}

export function forgetSkip(previous: readonly string[], jobId: string): string[] {
  return previous.filter((id) => id !== jobId);
}

/**
 * A stored list is untrusted: keep only short, unique, non-empty role ids.
 */
export function parseSkipList(value: unknown, limit = swipeSkipLimit): string[] {
  if (!Array.isArray(value)) return [];
  const bounded = Math.max(1, limit);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item || item.length > 512 || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= bounded) break;
  }
  return result;
}

/**
 * A cached deck is untrusted too: keep only role-shaped rows and a short
 * cursor, so a hand-edited or stale store can never break the surface.
 */
export function parseDeckCache<T extends { jobId: string }>(
  value: unknown,
): { jobs: T[]; cursor?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { jobs?: unknown; cursor?: unknown };
  if (!Array.isArray(record.jobs)) return undefined;
  const jobs = record.jobs.filter((job): job is T => {
    if (!job || typeof job !== "object" || Array.isArray(job)) return false;
    const jobId = (job as { jobId?: unknown }).jobId;
    return typeof jobId === "string" && jobId.length > 0 && jobId.length <= 512;
  });
  if (!jobs.length) return undefined;
  const cursor = typeof record.cursor === "string" && record.cursor.length > 0 && record.cursor.length <= 128
    ? record.cursor
    : undefined;
  return { jobs, ...(cursor ? { cursor } : {}) };
}

/**
 * Ask for another page before the ready buffer runs dry, so the stack never
 * pauses on the network mid-swipe. A load that errored waits for an explicit
 * retry instead of hammering the endpoint.
 */
export function shouldLoadMoreDeck(input: {
  remaining: number;
  cursor?: string;
  loading: boolean;
  errored: boolean;
  minimum?: number;
}): boolean {
  if (!input.cursor || input.loading || input.errored) return false;
  return input.remaining <= (input.minimum ?? swipeDeckPrefetchFloor);
}

/**
 * The seen record shares the skip list's shape and limits, but means something
 * different: a seen role may never have been decided on at all. Presented roles
 * are remembered most-recent-first so the cap drops the oldest first.
 */
export function rememberSeen(
  previous: readonly string[],
  jobId: string,
  limit = swipeSeenLimit,
): string[] {
  return rememberSkip(previous, jobId, limit);
}

export function forgetSeen(previous: readonly string[], jobId: string): string[] {
  return forgetSkip(previous, jobId);
}

export function parseSeenList(value: unknown, limit = swipeSeenLimit): string[] {
  return parseSkipList(value, limit);
}
