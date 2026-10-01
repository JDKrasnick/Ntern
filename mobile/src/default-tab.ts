import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Which surface the app opens on. The catalog has always been the landing tab,
 * so that stays the default; a reader who prefers the deck can make it theirs.
 *
 * The choice lives on the device for an instant, flash-free boot and is also
 * carried in the installation preferences so it survives a reinstall.
 */
export type LandingTab = 'roles' | 'swipe';

export const landingTabStorageKey = 'internnotifs.landing-tab.v1';

export function isLandingTab(value: unknown): value is LandingTab {
  return value === 'roles' || value === 'swipe';
}

export async function loadLandingTab(): Promise<LandingTab> {
  try {
    const stored = await AsyncStorage.getItem(landingTabStorageKey);
    return isLandingTab(stored) ? stored : 'roles';
  } catch {
    return 'roles';
  }
}

export async function saveLandingTab(value: LandingTab): Promise<void> {
  try {
    await AsyncStorage.setItem(landingTabStorageKey, value);
  } catch {
    // The preference is a convenience; boot falls back to the catalog.
  }
}
