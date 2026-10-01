import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

/**
 * The deck's web keyboard shortcuts. Arrow keys always work and are never
 * remapped; a reader can set one extra key per action (A and D by default).
 * These are input preferences for one device, so they stay on the device.
 */
export type DeckKeybindAction = 'pass' | 'queue' | 'undo' | 'open';

export type DeckKeybinds = Record<DeckKeybindAction, string>;

export const deckKeybindStorageKey = 'internnotifs.deck-keybinds.v1';

/** The two arrow keys that always work and are always shown in the legend. */
export const fixedDeckKeys: Record<DeckKeybindAction, string | undefined> = {
  pass: 'arrowleft',
  queue: 'arrowright',
  undo: undefined,
  open: undefined,
};

export const deckKeybindActions: Array<{ id: DeckKeybindAction; label: string; description: string }> = [
  { id: 'pass', label: 'Pass', description: 'Swipe left to the next role. The left arrow always does this too.' },
  { id: 'queue', label: 'Queue', description: 'Swipe right into the apply queue. The right arrow always does this too.' },
  { id: 'undo', label: 'Undo last pass', description: 'Bring back the role you just passed.' },
  { id: 'open', label: 'Open role', description: 'Open the role on top for details.' },
];

export const defaultDeckKeybinds: DeckKeybinds = { pass: 'a', queue: 'd', undo: 'u', open: 'o' };

const displayNames: Record<string, string> = {
  ' ': 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  escape: 'Esc',
  enter: 'Enter',
  backspace: '⌫',
  tab: 'Tab',
};

/** A human label for a stored key, e.g. "a" -> "A", "arrowleft" -> "←". */
export function keybindLabel(key: string | undefined): string {
  if (!key) return 'Unset';
  return displayNames[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** One printable key, space, or a named arrow/escape. Modifiers and chords are rejected. */
export function normalizeKeybind(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.toLowerCase();
  if (raw === ' ' || raw === 'spacebar') return ' ';
  const key = raw.trim();
  if (!key || key.length > 12) return '';
  if (/^(arrow(left|right|up|down)|escape|enter|backspace|tab)$/.test(key)) return key;
  if (/^[a-z0-9]$/.test(key)) return key;
  return '';
}

/** A stored map is untrusted: keep only keys this surface can actually act on. */
export function parseDeckKeybinds(value: unknown): DeckKeybinds {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    pass: normalizeKeybind(record.pass),
    queue: normalizeKeybind(record.queue),
    undo: normalizeKeybind(record.undo),
    open: normalizeKeybind(record.open),
  };
}

/**
 * Actions whose key is empty, reserved (an arrow key), or shared with another
 * action. The settings surface warns on these rather than silently misbinding.
 */
export function keybindConflicts(binds: DeckKeybinds): DeckKeybindAction[] {
  const conflicts: DeckKeybindAction[] = [];
  const seen = new Map<string, DeckKeybindAction>();
  for (const action of Object.keys(binds) as DeckKeybindAction[]) {
    const key = binds[action];
    if (!key) continue;
    if (key === 'arrowleft' || key === 'arrowright' || seen.has(key)) conflicts.push(action);
    else seen.set(key, action);
  }
  return conflicts;
}

/** The keys the deck listens for, in priority order, for the legend and tests. */
export function deckShortcutKeys(binds: DeckKeybinds, action: DeckKeybindAction): string[] {
  const keys = [fixedDeckKeys[action], binds[action]].filter((key): key is string => Boolean(key));
  return [...new Set(keys)];
}

let current: DeckKeybinds = { ...defaultDeckKeybinds };
let hydrated = false;
const listeners = new Set<(value: DeckKeybinds) => void>();

export function deckKeybinds(): DeckKeybinds {
  return current;
}

function emit(next: DeckKeybinds): void {
  current = next;
  for (const listener of listeners) listener(current);
}

export function subscribeDeckKeybinds(listener: (value: DeckKeybinds) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Reads the device store once per app run; later calls reuse the live value. */
export async function hydrateDeckKeybinds(): Promise<DeckKeybinds> {
  if (hydrated) return current;
  hydrated = true;
  try {
    const stored = await AsyncStorage.getItem(deckKeybindStorageKey);
    if (stored) emit(parseDeckKeybinds(JSON.parse(stored)));
  } catch {
    // The defaults keep the surface working when the device store is unavailable.
  }
  return current;
}

export async function saveDeckKeybinds(next: DeckKeybinds): Promise<void> {
  const normalized = parseDeckKeybinds(next);
  emit(normalized);
  try {
    await AsyncStorage.setItem(deckKeybindStorageKey, JSON.stringify(normalized));
  } catch {
    // In-memory value still applies for this run.
  }
}

/** Shared by the deck (to listen) and settings (to edit); both stay in sync. */
export function useDeckKeybinds(): [DeckKeybinds, (next: DeckKeybinds) => void] {
  const [value, setValue] = useState<DeckKeybinds>(current);
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeDeckKeybinds((next) => { if (active) setValue(next); });
    void hydrateDeckKeybinds().then((loaded) => { if (active) setValue(loaded); });
    return () => { active = false; unsubscribe(); };
  }, []);
  return [value, (next: DeckKeybinds) => { void saveDeckKeybinds(next); }];
}
