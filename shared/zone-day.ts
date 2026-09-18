/**
 * Calendar days for the catalog.
 *
 * A role's release day is a calendar day, and a calendar day only exists inside a
 * time zone: 2026-09-18T02:00:00Z is September 18 in UTC and September 17 in Los
 * Angeles. The catalog defaults to UTC so a role's day never depends on who is
 * reading, and a reader can ask for their own zone instead.
 */

export const DEFAULT_DAY_ZONE = 'UTC';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Resolves a requested zone to a usable one; anything unknown falls back to UTC. */
export function dayZone(requested?: string): string {
  if (!requested || requested === DEFAULT_DAY_ZONE) return DEFAULT_DAY_ZONE;
  if (formatters.has(requested)) return requested;
  try {
    // A zone is usable only if the runtime can format an instant in it.
    new Intl.DateTimeFormat('en-US', { timeZone: requested }).format(0);
  } catch {
    return DEFAULT_DAY_ZONE;
  }
  return requested;
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  const existing = formatters.get(zone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  formatters.set(zone, formatter);
  return formatter;
}

/** The calendar day an instant falls on, as `YYYY-MM-DD`, in the requested zone. */
export function zoneDay(instant: string | Date, zone = DEFAULT_DAY_ZONE): string | undefined {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.valueOf())) return undefined;
  const parts = formatterFor(dayZone(zone)).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  return year && month && day ? `${year}-${month}-${day}` : undefined;
}

/** True for a well-formed `YYYY-MM-DD` day that exists on the calendar. */
export function isCalendarDay(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
