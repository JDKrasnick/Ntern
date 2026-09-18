import { describe, expect, it } from 'vitest';
import { advanceBelt, beltCopies, beltItems, beltYields, isReaderScroll, laneSelection, BELT_QUIET_MS, BELT_SPEED } from '../src/newness-belt';

const groups = [{ groupId: 'a' }, { groupId: 'b' }, { groupId: 'c' }];
const laneStep = 332;
const cycleLength = groups.length * laneStep;

describe('the new-roles belt', () => {
  it('slides at a constant speed while a frame lasts', () => {
    // Frames shorter than the stall clamp: a hundred milliseconds moves a tenth
    // of a second's worth of belt.
    expect(advanceBelt(0, 100, cycleLength)).toBeCloseTo(BELT_SPEED * 0.1, 6);
    expect(advanceBelt(100, 50, cycleLength)).toBeCloseTo(100 + BELT_SPEED * 0.05, 6);
    expect(advanceBelt(100, 0, cycleLength)).toBe(100);
  });

  it('wraps by exactly one copy, keeping the leftover', () => {
    // A frame short enough to be honoured: 100 ms of travel from one point below
    // the end crosses the cycle, so the belt continues from the leftover rather
    // than restarting at 0 — that is what makes the loop look endless.
    expect(advanceBelt(cycleLength - 1, 100, cycleLength)).toBeCloseTo(BELT_SPEED * 0.1 - 1, 6);
    expect(advanceBelt(cycleLength - 0.5, 100, cycleLength)).toBeCloseTo(BELT_SPEED * 0.1 - 0.5, 6);
    // Starting a whole copy lower lands on the same pixel, which is why the
    // second copy exists.
    expect(advanceBelt(1658, 100, cycleLength)).toBeCloseTo(advanceBelt(1658 - cycleLength, 100, cycleLength) + 0, 6);
  });

  it('never drifts across thousands of wraps', () => {
    let offset = 0;
    let travelled = 0;
    for (let frame = 0; frame < 20000; frame += 1) {
      const before = offset;
      offset = advanceBelt(offset, 1000 / 60, cycleLength);
      travelled += offset >= before ? offset - before : cycleLength - before + offset;
    }
    const elapsedSeconds = 20000 / 60;
    expect(travelled).toBeCloseTo(BELT_SPEED * elapsedSeconds, 3);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(cycleLength);
  });

  it('ignores a frame that lasted longer than a stall', () => {
    // The app was away: resume where it left off instead of jumping the length
    // the wall clock says it missed.
    expect(advanceBelt(0, 5000, cycleLength)).toBeCloseTo(BELT_SPEED * 0.12, 6);
  });

  it('stands still when there is nothing to cycle through', () => {
    expect(advanceBelt(0, 1000, 0)).toBe(0);
  });
});

describe('belt copies', () => {
  it('always leaves a full cycle to travel plus a window to fill', () => {
    const cases = [[390, 5], [1440, 5], [1440, 2], [2160, 3], [390, 12], [390, 1]] as const;
    for (const [viewport, groupCount] of cases) {
      const cycle = groupCount * 312;
      const copies = beltCopies(viewport, cycle);
      expect(copies).toBeGreaterThanOrEqual(2);
      expect(copies * cycle).toBeGreaterThanOrEqual(cycle + viewport);
    }
  });

  it('asks for more copies when a couple would run out mid-cycle', () => {
    // Two copies of a short release on a wide screen leave 1328 pt for a belt that
    // needs to travel 664 and fill 1440 more: it would stall against the end, which
    // is exactly what reads as slowing down.
    expect(beltCopies(1440, 664)).toBe(5);
    expect(beltCopies(390, 1560)).toBe(3);
  });

  it('keeps a spare copy for the cells a list has not laid out yet', () => {
    // The minimum for the window, plus one: a virtualized list measures only what
    // it has rendered, so the travel must fit inside the copies the list shows.
    const viewport = 1080;
    const cycle = 1660;
    const minimum = Math.ceil((cycle + viewport) / cycle);
    expect(beltCopies(viewport, cycle)).toBe(minimum + 1);
    expect(beltCopies(viewport, cycle) * cycle - viewport).toBeGreaterThan(cycle);
  });

  it('stands down when there is nothing to cycle through', () => {
    expect(beltCopies(1440, 0)).toBe(1);
  });

  it('keeps every copy after the first out of the accessibility tree', () => {
    const belt = beltItems(groups, 3);
    expect(belt).toHaveLength(groups.length * 3);
    expect(new Set(belt.map((item) => item.key)).size).toBe(belt.length);
    expect(belt.map((item) => item.decorative)).toEqual([false, false, false, true, true, true, true, true, true]);
  });
});

describe('telling the reader from the belt', () => {
  const base = { writing: false, mountedAt: 0, now: 60000 };
  it('ignores the belt\'s own writes', () => {
    expect(isReaderScroll({ ...base, actual: 412, expected: 412 })).toBe(false);
    // a frame-landing late still reports a position we just wrote
    expect(isReaderScroll({ ...base, actual: 415.5, expected: 412 })).toBe(false);
  });

  it('ignores the list settling its layout after mount', () => {
    expect(isReaderScroll({ ...base, now: 800, actual: 900, expected: 0 })).toBe(false);
  });

  it('ignores events while a write is in flight', () => {
    expect(isReaderScroll({ ...base, writing: true, actual: 900, expected: 0 })).toBe(false);
  });

  it('sees a reader taking the wheel', () => {
    expect(isReaderScroll({ ...base, actual: 700, expected: 412 })).toBe(true);
    expect(isReaderScroll({ ...base, actual: 100, expected: 412 })).toBe(true);
  });
});

describe('the belt yielding to the reader', () => {
  it('holds for as long as they are dragging it', () => {
    expect(beltYields(60000, 0, true)).toBe(true);
    // even a drag that has lasted far longer than the quiet window
    expect(beltYields(600000, 1000, true)).toBe(true);
  });

  it('holds just after a scroll and picks up once they stop', () => {
    expect(beltYields(60000, 60000, false)).toBe(true);
    expect(beltYields(60000, 60000 - BELT_QUIET_MS + 1, false)).toBe(true);
    expect(beltYields(60000, 60000 - BELT_QUIET_MS, false)).toBe(false);
  });

  it('never holds a reader who has not touched it', () => {
    expect(beltYields(60000, 0, false)).toBe(false);
  });
});

describe('what the lane leads with', () => {
  const groups = [
    { groupId: 'a', roleIds: ['a1', 'a2'] },
    { groupId: 'b', roleIds: ['b1'] },
    { groupId: 'c', roleIds: ['c1'], featuredRole: { jobId: 'c1' } },
  ];

  it('leads with what is genuinely new when the lens has news', () => {
    const lane = laneSelection(groups, new Set(['b1']));
    expect(lane.groups.map((group) => group.groupId)).toEqual(['b']);
    expect(lane.latest).toBe(false);
  });

  it('counts a group whose featured role is new', () => {
    expect(laneSelection(groups, new Set(['c1'])).groups.map((group) => group.groupId)).toEqual(['c']);
  });

  it('still leads somewhere when the lens has nothing new', () => {
    // The lens empties the moment a reader opens the catalog, and a first-time
    // reader has no lens at all. Leading with the lens alone is what made the
    // belt vanish on the second visit and never come back.
    for (const lens of [undefined, new Set<string>()]) {
      const lane = laneSelection(groups, lens);
      expect(lane.groups.map((group) => group.groupId)).toEqual(['a', 'b', 'c']);
      expect(lane.latest).toBe(true);
    }
  });

  it('falls back when the lens names roles the catalog does not show', () => {
    const lane = laneSelection(groups, new Set(['not-in-the-catalog']));
    expect(lane.groups.map((group) => group.groupId)).toEqual(['a', 'b', 'c']);
    expect(lane.latest).toBe(true);
  });

  it('leads with nothing when there is nothing to lead with', () => {
    expect(laneSelection([], new Set(['b1']))).toEqual({ groups: [], latest: true });
  });

  it('keeps the fallback to the newest few', () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ groupId: `g${index}` }));
    expect(laneSelection(many, undefined, 4).groups.map((group) => group.groupId)).toEqual(['g0', 'g1', 'g2', 'g3']);
  });
});

describe('belt content', () => {
  it('renders the release twice so a wrap lands on identical pixels', () => {
    const belt = beltItems(groups);
    expect(belt).toHaveLength(groups.length * 2);
    expect(belt.map((item) => item.key)).toEqual(['a', 'b', 'c', 'a#loop1', 'b#loop1', 'c#loop1']);
    expect(belt.map((item) => item.decorative)).toEqual([false, false, false, true, true, true]);
    // The second copy is the same content, one full copy along.
    expect(belt.slice(groups.length).map((item) => item.group)).toEqual(groups);
  });

  it('does not duplicate a release that cannot cycle', () => {
    expect(beltItems([{ groupId: 'solo' }])).toEqual([{ key: 'solo', group: { groupId: 'solo' }, decorative: false }]);
    expect(beltItems([])).toEqual([]);
  });
});
