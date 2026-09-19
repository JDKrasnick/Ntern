import { describe, expect, it } from 'vitest';
import { calendarToday, monthCells, monthLabel, monthOf, monthRange, shiftMonth, weekdayInitials } from '../src/release-calendar';

describe('release calendar months', () => {
  it('reads a month out of a day and steps months across year boundaries', () => {
    expect(monthOf('2026-09-18')).toBe('2026-09');
    expect(monthOf('nonsense')).toMatch(/^\d{4}-\d{2}$/);
    expect(shiftMonth('2026-09', 1)).toBe('2026-10');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('asks for the whole month, month lengths included', () => {
    expect(monthRange('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthRange('2027-02')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('pads the grid so every month starts on its own weekday', () => {
    const cells = monthCells('2026-09');
    // 2026-09-01 is a Tuesday, so two leading blanks precede day 1.
    expect(cells.slice(0, 2)).toEqual([null, null]);
    expect(cells[2]).toEqual({ day: '2026-09-01', dayOfMonth: 1 });
    expect(cells.at(-1)).toEqual({ day: '2026-09-30', dayOfMonth: 30 });
    expect(cells.filter(Boolean)).toHaveLength(30);
    expect(weekdayInitials).toHaveLength(7);
  });

  it('reads a day as UTC so the label never shifts', () => {
    expect(calendarToday(new Date('2026-09-18T23:30:00.000Z'))).toBe('2026-09-18');
    expect(monthLabel('2026-09')).toMatch(/September/);
    expect(monthLabel('2026-09')).toMatch(/2026/);
  });
});
