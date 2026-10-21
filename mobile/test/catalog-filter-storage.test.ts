import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCatalogFilters, emptyCatalogFilters } from '../src/catalog-filters';
import { loadCatalogFilters, saveCatalogFilters } from '../src/catalog-filter-storage';

const values = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => values.get(key) ?? null,
  setItem: async (key: string, value: string) => { values.set(key, value); },
} }));

describe('web catalog preferences stay separate from native', () => {
  beforeEach(() => values.clear());
  it('leaves a new native install on its existing defaults', async () => {
    expect(await loadCatalogFilters(true)).toBeUndefined();
    expect(await loadCatalogFilters()).toMatchObject({ sort: 'best', addedSince: expect.any(String) });
  });
  it('preserves native facets without adopting the web time window', async () => {
    values.set('internnotifs.catalog-filters.v1', JSON.stringify({ ...emptyCatalogFilters, disciplines: ['software'] }));
    expect(await loadCatalogFilters(true)).toMatchObject({ disciplines: ['software'], sort: 'newest', addedSince: undefined, addedBefore: undefined });
    expect(await loadCatalogFilters()).toMatchObject({ disciplines: ['software'], sort: 'best', addedSince: expect.any(String) });
  });
  it('does not overwrite native preferences when saving a web selection', async () => {
    await saveCatalogFilters({ ...emptyCatalogFilters, sort: 'newest' }, true);
    const original = values.get('internnotifs.catalog-filters.v1');
    await saveCatalogFilters(defaultCatalogFilters());
    expect(values.get('internnotifs.catalog-filters.v1')).toBe(original);
    expect(values.has('internnotifs.catalog-filters.v2')).toBe(true);
  });
});
