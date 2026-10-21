import { describe, expect, it } from 'vitest';
import {
  appendCatalogPage,
  createCatalogPageReader,
  catalogQueryPreview,
  catalogCardKind,
  filterGroupedCatalogPage,
  nextMatchingGroupedCatalogPage,
  refreshCacheFirst,
} from '../src/catalog.js';

describe('mobile catalog pagination', () => {
  it('shares concurrent reads across surfaces and reuses a recent exact query', async () => {
    let calls = 0;
    let finish!: (page: { groups: string[]; cursor: string }) => void;
    let clock = 0;
    const read = createCatalogPageReader(() => {
      calls++;
      return new Promise<{ groups: string[]; cursor: string }>(resolve => { finish = resolve; });
    }, () => clock);
    const first = read('q=nvi&educationLevel=undergraduate');
    const second = read('q=nvi&educationLevel=undergraduate');
    await Promise.resolve();
    expect(calls).toBe(1);
    finish({ groups: ['NVIDIA'], cursor: '50' });
    expect(await first).toEqual(await second);
    expect((await read('q=nvi&educationLevel=undergraduate')).cursor).toBe('50');
    expect(calls).toBe(1);
    clock = 15_000;
    const expired = read('q=nvi&educationLevel=undergraduate');
    await Promise.resolve();
    expect(calls).toBe(2);
    finish({ groups: ['new listing'], cursor: '100' });
    expect((await expired).groups).toEqual(['new listing']);
  });

  it('isolates query, facet, and cursor responses and bounds retained pages', async () => {
    let calls = 0;
    const read = createCatalogPageReader(async parameters => { calls++; return { groups: [parameters] }; });
    for (const parameters of ['q=nvi', 'q=nvi&educationLevel=masters', 'q=nvi&cursor=50', 'q=google']) {
      expect((await read(parameters)).groups).toEqual([parameters]);
    }
    expect(calls).toBe(4);
    for (let i = 0; i < 8; i++) await read(`q=other${i}`);
    await read('q=nvi');
    expect(calls).toBe(13);
  });

  it('retries failed shared reads rather than caching the failure', async () => {
    let calls = 0;
    const read = createCatalogPageReader(async () => {
      if (++calls === 1) throw new Error('offline');
      return { groups: ['recovered'] };
    });
    await expect(read('q=nvi')).rejects.toThrow('offline');
    expect((await read('q=nvi')).groups).toEqual(['recovered']);
  });

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

  it('does not invent a local preview when facets need authoritative results', () => {
    const preview = catalogQueryPreview(
      [group('old', 'Acme', 'Software Engineering Intern')],
      'data',
      true,
    );

    expect(preview).toBeUndefined();
  });

  it('prefix-filters the cached browse page immediately while typing', () => {
    const preview = catalogQueryPreview(
      [
        group('avid', 'Avid', 'AI/ML Engineering Intern'),
        group('other', 'Priceline', 'Software Engineering Intern'),
      ],
      'av ai',
      false,
    );

    expect(preview?.map((item) => item.groupId)).toEqual(['avid']);
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
