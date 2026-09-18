import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Which calendar the catalog's release days belong to.
 *
 * `utc` is the default so a role's release day is the same day for everyone and
 * matches what alerts and release cards call it. `device` follows the reader's own
 * clock, which moves a role that landed after local midnight onto the next day.
 */
export type DayZoneSetting = 'utc' | 'device';

export const UTC_ZONE = 'UTC';
const storageKey = 'internnotifs.calendar-day-zone.v1';

const listeners = new Set<(setting: DayZoneSetting) => void>();
let current: DayZoneSetting = 'utc';
let hydrated = false;

/** The reader's own IANA zone, or UTC when the platform cannot name one. */
export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC_ZONE;
  } catch {
    return UTC_ZONE;
  }
}

/** The IANA zone a setting resolves to, as the API wants it. */
export function dayZoneName(setting: DayZoneSetting) {
  return setting === 'device' ? deviceTimeZone() : UTC_ZONE;
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = await AsyncStorage.getItem(storageKey);
    if (stored === 'device' || stored === 'utc') {
      current = stored;
      listeners.forEach((listener) => listener(current));
    }
  } catch {
    // A preference that cannot be read is a preference that has not been set.
  }
}

export async function setDayZoneSetting(setting: DayZoneSetting) {
  current = setting;
  listeners.forEach((listener) => listener(current));
  try {
    await AsyncStorage.setItem(storageKey, setting);
  } catch {
    // Keep the in-memory choice; the next launch falls back to UTC.
  }
}

export function dayZoneSetting() {
  return current;
}

/** The setting plus the zone it resolves to, shared by the calendar and settings. */
export function useDayZone() {
  const [setting, setSetting] = useState<DayZoneSetting>(current);
  useEffect(() => {
    void hydrate();
    const listener = (value: DayZoneSetting) => setSetting(value);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    setting,
    zone: dayZoneName(setting),
    setSetting: (value: DayZoneSetting) => void setDayZoneSetting(value),
  };
}
