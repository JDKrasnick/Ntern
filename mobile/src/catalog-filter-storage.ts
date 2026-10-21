import AsyncStorage from '@react-native-async-storage/async-storage';
import { defaultCatalogFilters, parseCatalogFilters, refreshCatalogDateWindow, type CatalogFilterValues } from './catalog-filters';

const catalogFilterStorageKey = 'internnotifs.catalog-filters.v2';
const nativeCatalogFilterStorageKey = 'internnotifs.catalog-filters.v1';

/**
 * Browse filters are a device preference, not an account one: the catalog needs
 * no account, and a reader who studies at one level should not have to say so
 * again on every launch.
 */
export async function loadCatalogFilters(native = false): Promise<CatalogFilterValues | undefined> {
  try {
    if (native) {
      const stored = await AsyncStorage.getItem(nativeCatalogFilterStorageKey);
      const filters = stored ? parseCatalogFilters(JSON.parse(stored)) : undefined;
      return filters ? { ...filters, sort: 'newest', addedSince: undefined, addedBefore: undefined } : undefined;
    }
    const stored = await AsyncStorage.getItem(catalogFilterStorageKey);
    const filters = stored ? parseCatalogFilters(JSON.parse(stored)) : undefined;
    if (filters) return refreshCatalogDateWindow(filters);
    const legacy = await AsyncStorage.getItem('internnotifs.catalog-filters.v1');
    const previous = legacy ? parseCatalogFilters(JSON.parse(legacy)) : undefined;
    const defaults = defaultCatalogFilters();
    return previous ? { ...previous, sort: defaults.sort, addedSince: defaults.addedSince, addedBefore: defaults.addedBefore } : defaults;
  } catch {
    return undefined;
  }
}

export async function saveCatalogFilters(filters: CatalogFilterValues, native = false): Promise<void> {
  try {
    await AsyncStorage.setItem(native ? nativeCatalogFilterStorageKey : catalogFilterStorageKey, JSON.stringify(filters));
  } catch {
    // Filtering still works for this session when device storage is unavailable.
  }
}
