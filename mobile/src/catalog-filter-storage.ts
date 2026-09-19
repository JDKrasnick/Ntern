import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseCatalogFilters, type CatalogFilterValues } from './catalog-filters';

const catalogFilterStorageKey = 'internnotifs.catalog-filters.v1';

/**
 * Browse filters are a device preference, not an account one: the catalog needs
 * no account, and a reader who studies at one level should not have to say so
 * again on every launch.
 */
export async function loadCatalogFilters(): Promise<CatalogFilterValues | undefined> {
  try {
    const stored = await AsyncStorage.getItem(catalogFilterStorageKey);
    return stored ? parseCatalogFilters(JSON.parse(stored)) : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCatalogFilters(filters: CatalogFilterValues): Promise<void> {
  try {
    await AsyncStorage.setItem(catalogFilterStorageKey, JSON.stringify(filters));
  } catch {
    // Filtering still works for this session when device storage is unavailable.
  }
}
