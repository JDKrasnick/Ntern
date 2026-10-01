import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    api: {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage.api }));

import { isLandingTab, loadLandingTab, landingTabStorageKey, saveLandingTab } from '../src/default-tab';

beforeEach(() => {
  storage.values.clear();
  vi.clearAllMocks();
});

describe('landing tab preference', () => {
  it('accepts only the two known surfaces', () => {
    expect(isLandingTab('roles')).toBe(true);
    expect(isLandingTab('swipe')).toBe(true);
    expect(isLandingTab('catalog')).toBe(false);
    expect(isLandingTab(undefined)).toBe(false);
    expect(isLandingTab(1)).toBe(false);
  });

  it('defaults to the catalog when nothing is stored', async () => {
    expect(await loadLandingTab()).toBe('roles');
  });

  it('round-trips a saved choice and ignores a corrupt value', async () => {
    await saveLandingTab('swipe');
    expect(storage.values.get(landingTabStorageKey)).toBe('swipe');
    expect(await loadLandingTab()).toBe('swipe');

    storage.values.set(landingTabStorageKey, 'somewhere-else');
    expect(await loadLandingTab()).toBe('roles');
  });
});
