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

import {
  deckKeybindStorageKey,
  deckKeybinds,
  deckShortcutKeys,
  defaultDeckKeybinds,
  hydrateDeckKeybinds,
  keybindConflicts,
  keybindLabel,
  normalizeKeybind,
  parseDeckKeybinds,
  saveDeckKeybinds,
  subscribeDeckKeybinds,
} from '../src/keybinds';

beforeEach(() => {
  storage.values.clear();
  vi.clearAllMocks();
});

describe('normalizeKeybind', () => {
  it('accepts single printable keys, space, and named keys', () => {
    expect(normalizeKeybind('A')).toBe('a');
    expect(normalizeKeybind('arrowLeft')).toBe('arrowleft');
    expect(normalizeKeybind(' ')).toBe(' ');
    expect(normalizeKeybind('Spacebar')).toBe(' ');
    expect(normalizeKeybind('Enter')).toBe('enter');
  });

  it('rejects modifiers, chords, function keys, and junk', () => {
    expect(normalizeKeybind('Shift')).toBe('');
    expect(normalizeKeybind('Control')).toBe('');
    expect(normalizeKeybind('F1')).toBe('');
    expect(normalizeKeybind('ab')).toBe('');
    expect(normalizeKeybind(undefined)).toBe('');
    expect(normalizeKeybind(7)).toBe('');
  });
});

describe('parseDeckKeybinds', () => {
  it('normalizes and unsets anything unusable', () => {
    expect(parseDeckKeybinds({ pass: 'A', queue: 'arrowright', undo: 'bogus' }))
      .toEqual({ pass: 'a', queue: 'arrowright', undo: '', open: '' });
    expect(parseDeckKeybinds(null)).toEqual({ pass: '', queue: '', undo: '', open: '' });
  });
});

describe('keybindConflicts', () => {
  it('flags reserved arrows and duplicate keys', () => {
    expect(keybindConflicts({ pass: 'a', queue: 'd', undo: 'u', open: 'o' })).toEqual([]);
    expect(keybindConflicts({ pass: 'a', queue: 'a', undo: '', open: '' })).toEqual(['queue']);
    expect(keybindConflicts({ pass: 'arrowleft', queue: 'd', undo: '', open: '' })).toEqual(['pass']);
  });
});

describe('deckShortcutKeys', () => {
  it('keeps the fixed arrow alongside a custom key', () => {
    expect(deckShortcutKeys(defaultDeckKeybinds, 'pass')).toEqual(['arrowleft', 'a']);
    expect(deckShortcutKeys(defaultDeckKeybinds, 'queue')).toEqual(['arrowright', 'd']);
    expect(deckShortcutKeys(defaultDeckKeybinds, 'undo')).toEqual(['u']);
  });
});

describe('keybind store', () => {
  it('round-trips through the device store and notifies subscribers', async () => {
    await hydrateDeckKeybinds();
    const seen: string[] = [];
    const unsubscribe = subscribeDeckKeybinds((value) => seen.push(value.pass));
    await saveDeckKeybinds({ ...defaultDeckKeybinds, pass: 'j' });
    expect(deckKeybinds().pass).toBe('j');
    expect(JSON.parse(storage.values.get(deckKeybindStorageKey)!).pass).toBe('j');
    expect(seen).toEqual(['j']);
    unsubscribe();
  });
});

describe('keybindLabel', () => {
  it('renders friendly labels', () => {
    expect(keybindLabel('a')).toBe('A');
    expect(keybindLabel('arrowleft')).toBe('←');
    expect(keybindLabel(' ')).toBe('Space');
    expect(keybindLabel('')).toBe('Unset');
  });
});
