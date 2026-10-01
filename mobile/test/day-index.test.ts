import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

import {
  clearDayIndexCache,
  dayIndexCacheKey,
  isDayIndexFresh,
  loadDayIndex,
  prefetchDayIndex,
  readDayIndexCached,
} from '../src/day-index';

const params = (query: string) => new URLSearchParams(query);

beforeEach(() => {
  clearDayIndexCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the release-day index cache', () => {
  it('keys a request by its full scope, so filters, month and zone never collide', () => {
    expect(dayIndexCacheKey(params('from=2026-09-01&to=2026-09-30&dayZone=UTC')))
      .toContain('from=2026-09-01&to=2026-09-30&dayZone=UTC');
    expect(dayIndexCacheKey(params('dayZone=UTC')))
      .not.toBe(dayIndexCacheKey(params('dayZone=America/New_York')));
  });

  it('keeps a loaded month warm in memory', async () => {
    const day = { day: '2026-09-07', roles: 2, employers: 1 };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ days: [day] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const key = dayIndexCacheKey(params('from=2026-09-01&to=2026-09-30&dayZone=UTC'));

    await expect(loadDayIndex(key, params('from=2026-09-01&to=2026-09-30&dayZone=UTC'))).resolves.toEqual([day]);
    expect(readDayIndexCached(key)).toEqual([day]);
    expect(isDayIndexFresh(key)).toBe(true);
  });

  it('does not refetch a fresh month when prefetching', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ days: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const key = dayIndexCacheKey(params('dayZone=UTC'));

    await loadDayIndex(key, params('dayZone=UTC'));
    expect(fetcher).toHaveBeenCalledTimes(1);

    prefetchDayIndex(key, params('dayZone=UTC'));
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
