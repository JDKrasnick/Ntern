/**
 * The new-roles belt.
 *
 * The lane slides continuously, like a conveyor: it never stops at a tile and
 * never rewinds. Wrapping is what makes that possible — the belt renders the
 * release twice, so the moment its offset passes one full copy the offset can drop
 * by exactly that length and the pixels on screen are identical.
 */

/** Points per second. Unhurried: a card takes the better part of a minute to cross
 * the lane, so the belt reads as drift rather than as a carousel in a hurry. */
export const BELT_SPEED = 10;

/** The longest frame a stalled belt will honour, so a backgrounded app does not
 * lurch forward by however long it was away. */
const MAX_FRAME_SECONDS = 0.12;

export type BeltItem<T> = { key: string; group: T; decorative: boolean };

/** The release twice over: the second copy is what the belt wraps onto. It is
 * decoration, so assistive technology is told to ignore it. */
export function beltItems<T extends { groupId: string }>(groups: T[]): Array<BeltItem<T>> {
  if (groups.length < 2) return groups.map((group) => ({ key: group.groupId, group, decorative: false }));
  return [
    ...groups.map((group) => ({ key: group.groupId, group, decorative: false })),
    ...groups.map((group) => ({ key: `${group.groupId}#loop`, group, decorative: true })),
  ];
}

/** One frame of belt travel: advance, and wrap by exactly one copy when the
 * offset passes it. Returns the offset to render. */
export function advanceBelt(offset: number, elapsedMs: number, cycleLength: number, speed = BELT_SPEED) {
  if (cycleLength <= 0) return 0;
  const seconds = Math.max(0, Math.min(MAX_FRAME_SECONDS, elapsedMs / 1000));
  const next = offset + speed * seconds;
  return next >= cycleLength ? next - cycleLength : next;
}
