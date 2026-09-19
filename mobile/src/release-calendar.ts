/**
 * The month grid behind the release calendar. Every value here is a UTC calendar
 * day, formatted the way the API filters them, so the grid never disagrees with
 * the day it asks for.
 */

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const monthPattern = /^\d{4}-\d{2}$/u;

function utcParts(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) return undefined;
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
    weekday: parsed.getUTCDay(),
  };
}

function stamp(year: number, month: number, day: number) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Today as the calendar counts days, which is UTC unless the reader says otherwise. */
export function calendarToday(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function monthOf(value: string) {
  return dayPattern.test(value) ? value.slice(0, 7) : calendarToday().slice(0, 7);
}

export function shiftMonth(month: string, delta: number) {
  const parts = monthPattern.test(month) ? month.split('-').map(Number) : calendarToday().slice(0, 7).split('-').map(Number);
  const [year, monthNumber] = parts as [number, number];
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The inclusive first and last day of a month, for the index request. */
export function monthRange(month: string) {
  const [year, monthNumber] = (monthPattern.test(month) ? month : calendarToday().slice(0, 7)).split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: stamp(year, monthNumber, 1), to: stamp(year, monthNumber, lastDay) };
}

export function monthLabel(month: string) {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

export const weekdayInitials = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

/** The month's days as a 7-wide grid, padded with empty leading cells. */
export function monthCells(month: string) {
  const [year, monthNumber] = (monthPattern.test(month) ? month : calendarToday().slice(0, 7)).split('-').map(Number) as [number, number];
  const first = utcParts(`${month}-01`);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells: Array<{ day: string; dayOfMonth: number } | null> = Array.from(
    { length: first?.weekday ?? 0 },
    () => null,
  );
  for (let dayOfMonth = 1; dayOfMonth <= lastDay; dayOfMonth += 1) {
    cells.push({ day: stamp(year, monthNumber, dayOfMonth), dayOfMonth });
  }
  return cells;
}
