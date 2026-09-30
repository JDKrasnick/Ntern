import { describe, expect, it } from 'vitest';
import {
  appendCatalogPage,
  beginCatalogQueryChange,
  catalogCardKind,
  filterGroupedCatalogPage,
  nextMatchingGroupedCatalogPage,
  refreshCacheFirst,
} from '../src/catalog.js';

describe('mobile catalog pagination', () => {
  it('appends later pages in order without duplicating a refreshed role', () => {
    const jobs = appendCatalogPage(
      [{ jobId: 'newest' }, { jobId: 'already-loaded' }],
      { jobs: [{ jobId: 'already-loaded' }, { jobId: 'machine-learning' }], cursor: 'next-page' },
    );

    expect(jobs.map((job) => job.jobId)).toEqual(['newest', 'already-loaded', 'machine-learning']);
  });

  it('renders any group filtered down to one role as the original role card', () => {
    expect(catalogCardKind({ roleCount: 1, featuredRole: { jobId: 'only-match' } })).toBe('role');
    expect(catalogCardKind({ roleCount: 2, featuredRole: { jobId: 'newest' } })).toBe('group');
  });

  const group = (groupId: string, company: string, title: string) => ({
    groupId,
    company,
    titles: [title],
    featuredRole: { company, title },
  });

  it('filters every compatibility page and advances past location-only matches', async () => {
    const fetchPage = async (cursor: string) => cursor === 'location-only'
      ? { groups: [group('wrong', 'Priceline', 'Software Engineering Intern')], cursor: 'role-match' }
      : { groups: [group('right', 'Avid', 'AI/ML Engineering Intern')] };

    expect(filterGroupedCatalogPage(await fetchPage('location-only'), 'av').groups).toEqual([]);
    const page = await nextMatchingGroupedCatalogPage('location-only', 'av', fetchPage);
    expect(page.groups.map((item) => item.groupId)).toEqual(['right']);
    expect(page.cursor).toBeUndefined();
  });

  it('invalidates an obsolete request even when facets prevent a local preview', () => {
    const generation = { current: 7 };
    const preview = beginCatalogQueryChange(
      generation,
      [group('old', 'Acme', 'Software Engineering Intern')],
      'data',
      true,
    );

    expect(generation.current).toBe(8);
    expect(preview).toBeUndefined();
  });

  it('does not let a delayed cache response replace a fresh catalog page', async () => {
    let resolveCache!: (value: string) => void;
    const cache = new Promise<string>((resolve) => { resolveCache = resolve; });
    const painted: string[] = [];

    await refreshCacheFirst({
      readCache: () => cache,
      fetchFresh: async () => 'fresh',
      onCached: (value) => painted.push(value),
      onFresh: (value) => painted.push(value),
    });
    resolveCache('stale');
    await Promise.resolve();

    expect(painted).toEqual(['fresh']);
  });

  it('still paints a cache response that arrives before the refresh', async () => {
    let resolveFresh!: (value: string) => void;
    const fresh = new Promise<string>((resolve) => { resolveFresh = resolve; });
    const painted: string[] = [];

    const refresh = refreshCacheFirst({
      readCache: async () => 'cached',
      fetchFresh: () => fresh,
      onCached: (value) => painted.push(value),
      onFresh: (value) => painted.push(value),
    });
    await Promise.resolve();
    resolveFresh('fresh');
    await refresh;

    expect(painted).toEqual(['cached', 'fresh']);
  });
});
