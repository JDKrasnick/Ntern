import { describe, expect, it } from 'vitest';
import { advanceBelt, beltItems, BELT_SPEED } from '../src/newness-belt';

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

describe('belt content', () => {
  it('renders the release twice so a wrap lands on identical pixels', () => {
    const belt = beltItems(groups);
    expect(belt).toHaveLength(groups.length * 2);
    expect(belt.map((item) => item.key)).toEqual(['a', 'b', 'c', 'a#loop', 'b#loop', 'c#loop']);
    expect(belt.map((item) => item.decorative)).toEqual([false, false, false, true, true, true]);
    // The second copy is the same content, one full copy along.
    expect(belt.slice(groups.length).map((item) => item.group)).toEqual(groups);
  });

  it('does not duplicate a release that cannot cycle', () => {
    expect(beltItems([{ groupId: 'solo' }])).toEqual([{ key: 'solo', group: { groupId: 'solo' }, decorative: false }]);
    expect(beltItems([])).toEqual([]);
  });
});
