import { api, responseCache } from './api';

/**
 * The release-day index behind the calendar: one request per month, scoped by
 * the active facets and the reader's zone. The API has to scan the catalog
 * projection to build it, which costs a couple of seconds, so the client keeps
 * a warm copy. A memory layer makes re-opening instant; a persisted layer makes
 * a cold start instant too, then refreshes in the background.
 */
export type ReleaseDayCount = { day: string; roles: number; employers: number };

type DayIndexEntry = { days: ReleaseDayCount[]; at: number };

const memory = new Map<string, DayIndexEntry>();
const inFlight = new Map<string, Promise<ReleaseDayCount[]>>();
const storagePrefix = 'internnotifs.day-index.v1:';
/** Counts drift as roles publish, but a few minutes of staleness is invisible in a calendar. */
const freshForMs = 5 * 60 * 1000;

/** The request identity doubles as the cache key: same filters, month and zone, same index. */
export function dayIndexCacheKey(params: URLSearchParams) {
  return `${storagePrefix}${params.toString()}`;
}

/** A synchronous read for the first paint, before any async storage hop. */
export function readDayIndexCached(key: string): ReleaseDayCount[] | undefined {
  return memory.get(key)?.days;
}

export function isDayIndexFresh(key: string, now = Date.now()) {
  const entry = memory.get(key);
  return Boolean(entry && now - entry.at < freshForMs);
}

/** Memory first, then the persisted copy, promoting whatever it finds into memory. */
export async function readDayIndex(key: string): Promise<ReleaseDayCount[] | undefined> {
  const inMemory = memory.get(key);
  if (inMemory) return inMemory.days;
  const stored = await responseCache.get<DayIndexEntry>(key);
  if (stored?.days?.length) {
    memory.set(key, stored);
    return stored.days;
  }
  return undefined;
}

export function loadDayIndex(key: string, params: URLSearchParams): Promise<ReleaseDayCount[]> {
  // A prefetch and an open panel can ask for the same month at once; share one
  // request rather than racing two projection scans.
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = api<{ days: ReleaseDayCount[] }>(`/catalog/days?${params.toString()}`, '')
    .then((response) => {
      const entry: DayIndexEntry = { days: response.days, at: Date.now() };
      memory.set(key, entry);
      void responseCache.set(key, entry);
      return response.days;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/**
 * Warm one month's index without blocking anything. A fresh entry is skipped so
 * a burst of prefetches cannot hammer the endpoint.
 */
export function prefetchDayIndex(key: string, params: URLSearchParams, now = Date.now()) {
  if (isDayIndexFresh(key, now)) return;
  void loadDayIndex(key, params).catch(() => undefined);
}

/** Test seam: drop every warm copy so a suite starts clean. */
export function clearDayIndexCache() {
  memory.clear();
  inFlight.clear();
}
