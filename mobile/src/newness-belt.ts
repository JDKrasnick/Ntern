/**
 * The new-roles belt.
 *
 * The lane slides continuously, like a conveyor: it never stops at a tile and
 * never rewinds. Wrapping is what makes that possible — the belt renders the
 * release twice, so the moment its offset passes one full copy the offset can drop
 * by exactly that length and the pixels on screen are identical.
 */

/** Points per second. Unhurried but unmistakably moving: a card takes about half
 * a minute to cross the lane, so the belt reads as drift rather than as a
 * carousel in a hurry. */
export const BELT_SPEED = 16;

/** The longest frame a stalled belt will honour, so a backgrounded app does not
 * lurch forward by however long it was away. */
const MAX_FRAME_SECONDS = 0.12;

export type BeltItem<T> = { key: string; group: T; decorative: boolean };

/**
 * How many copies the belt needs so it can always travel one full cycle without
 * the scroller running out of content: one cycle to travel through, enough to fill
 * the window, and one spare — because a virtualized list measures only the cells it
 * has laid out, and a belt that runs out of content stalls at the end of the cycle
 * and reads as slowing down.
 */
export function beltCopies(viewportWidth: number, cycleLength: number) {
  if (cycleLength <= 0) return 1;
  return Math.max(2, Math.ceil((cycleLength + viewportWidth) / cycleLength)) + 1;
}

/** The release over and over: every copy after the first is what the belt wraps
 * onto, and is decoration, so assistive technology is told to ignore it. */
export function beltItems<T extends { groupId: string }>(groups: T[], copies = 2): Array<BeltItem<T>> {
  if (groups.length < 2) return groups.map((group) => ({ key: group.groupId, group, decorative: false }));
  return Array.from({ length: copies }, (_, copy) => groups.map((group) => ({
    key: copy === 0 ? group.groupId : `${group.groupId}#loop${copy}`,
    group,
    decorative: copy > 0,
  }))).flat();
}

/** One frame of belt travel: advance, and wrap by exactly one copy when the
 * offset passes it. Returns the offset to render. */
export function advanceBelt(offset: number, elapsedMs: number, cycleLength: number, speed = BELT_SPEED) {
  if (cycleLength <= 0) return 0;
  const seconds = Math.max(0, Math.min(MAX_FRAME_SECONDS, elapsedMs / 1000));
  const next = offset + speed * seconds;
  return next >= cycleLength ? next - cycleLength : next;
}

/** How close a reported scroll position has to be to the one the belt wrote to
 * count as the belt's own doing. A frame of travel is well under a point. */
const BELT_SCROLL_TOLERANCE = 4;

/**
 * Whether a scroll event came from the reader rather than from the belt.
 *
 * The belt's own writes raise scroll events, and the list also settles its layout
 * shortly after mount; neither is a reader taking the wheel. Getting this wrong in
 * the other direction is what made the belt look like it was slowing down: every
 * frame it wrote looked like a reader scroll, so it paused for eight seconds.
 */
export function isReaderScroll(input: {
  actual: number;
  expected: number;
  writing: boolean;
  mountedAt: number;
  now: number;
}) {
  const { actual, expected, writing, mountedAt, now } = input;
  if (writing) return false;
  if (now - mountedAt < 2000) return false;
  return Math.abs(actual - expected) > BELT_SCROLL_TOLERANCE;
}
