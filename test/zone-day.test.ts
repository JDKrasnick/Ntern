import { describe, expect, it } from 'vitest';
import { DEFAULT_DAY_ZONE, dayZone, isCalendarDay, zoneDay } from '../shared/zone-day.js';
import { employerDropDay, employerDropKey, filterCatalogGroupDetails, filterCatalogGroups, groupCatalogJobs, catalogGroupDetails } from '../src/catalog-groups.js';
import type { Internship } from '../src/types.js';

function job(id: string, at: string, overrides: Partial<Internship> = {}): Internship {
  return {
    jobId: id, company: 'Acme', title: `Software Intern ${id}`, location: 'Remote', season: 'summer-2027',
    applyUrl: `https://careers.example.test/${id}`, normalizedUrl: `https://careers.example.test/${id}`, fingerprint: id,
    compensation: { raw: '$45/hour' }, sourceReferences: [], technical: true, open: true,
    firstSeenAt: at, catalogVisibleAt: at, lastSeenAt: at,
    notification: { smsPending: false, digestPending: false },
    ...overrides,
  };
}

describe('calendar days in a zone', () => {
  it('reads an instant as the day it is in the requested zone', () => {
    expect(zoneDay('2026-09-18T09:30:00.000Z')).toBe('2026-09-18');
    expect(zoneDay('2026-09-18T09:30:00.000Z', DEFAULT_DAY_ZONE)).toBe('2026-09-18');
    // 02:00 UTC is already September 18 in Kolkata and still September 17 in Los Angeles.
    expect(zoneDay('2026-09-18T02:00:00.000Z', 'Asia/Kolkata')).toBe('2026-09-18');
    expect(zoneDay('2026-09-18T02:00:00.000Z', 'America/Los_Angeles')).toBe('2026-09-17');
    // A half-hour offset is still a real offset.
    expect(zoneDay('2026-09-17T18:45:00.000Z', 'Asia/Kolkata')).toBe('2026-09-18');
  });

  it('falls back to UTC for a zone or instant it cannot read', () => {
    expect(dayZone('Not/AZone')).toBe(DEFAULT_DAY_ZONE);
    expect(dayZone()).toBe(DEFAULT_DAY_ZONE);
    expect(zoneDay('2026-09-18T02:00:00.000Z', 'Not/AZone')).toBe('2026-09-18');
    expect(zoneDay('not-a-date')).toBeUndefined();
  });

  it('accepts only days that exist on the calendar', () => {
    expect(isCalendarDay('2026-09-18')).toBe(true);
    expect(isCalendarDay('2026-02-30')).toBe(false);
    expect(isCalendarDay('2026-9-18')).toBe(false);
    expect(isCalendarDay(undefined)).toBe(false);
  });
});

describe('release days', () => {
  it('moves a live role with the reader and leaves a reported date alone', () => {
    const live = job('live', '2026-09-18T02:00:00.000Z');
    expect(employerDropDay(live)).toBe('2026-09-18');
    expect(employerDropDay(live, 'America/Los_Angeles')).toBe('2026-09-17');

    // A migrated row carries a reported posting date, which is a date rather than
    // an instant, so no zone moves it.
    const migrated = job('migrated', '2026-08-25T02:47:09.000Z', {
      catalogRecency: 'baseline',
      sourceReferences: [{
        sourceId: 'community-list', document: 'README.md', sourceUrl: 'https://example.test', row: 1, company: 'Acme',
        title: 'Software Intern', location: 'NYC', season: 'summer-2027', applyUrl: 'https://apply.example.test/migrated',
        compensation: { raw: '' }, state: 'open', postedAt: '2026-04-24',
      }],
    });
    expect(employerDropDay(migrated)).toBe('2026-04-24');
    expect(employerDropDay(migrated, 'America/Los_Angeles')).toBe('2026-04-24');
    expect(employerDropDay(migrated, 'Asia/Tokyo')).toBe('2026-04-24');
  });

  it('keeps release identity in UTC however the reader reads days', () => {
    const live = job('live', '2026-09-18T02:00:00.000Z');
    // The same card, the same deep link, whichever zone is being browsed.
    expect(employerDropKey(live)).toContain('2026-09-18');
    expect(employerDropKey(live)).toBe(employerDropKey(job('live', '2026-09-18T02:00:00.000Z')));
  });

  it('filters both the catalog and a materialized group to one day', () => {
    const jobs = [
      job('evening', '2026-09-17T20:00:00.000Z'),
      job('after-midnight', '2026-09-18T01:00:00.000Z'),
      job('morning', '2026-09-18T06:00:00.000Z'),
      job('afternoon', '2026-09-18T20:00:00.000Z'),
      job('next-utc-day', '2026-09-19T02:00:00.000Z'),
    ];
    const groups = groupCatalogJobs(jobs);
    const id = (items: Array<{ jobId: string }>) => items.map((item) => item.jobId);

    // UTC: the day the catalog calls September 18 is the 18th from 00:00Z to 23:59Z.
    const utc = filterCatalogGroups(groups, { day: '2026-09-18', dayZone: 'UTC' });
    expect(id(utc.flatMap((group) => group.jobs)).sort()).toEqual(['after-midnight', 'afternoon', 'morning']);
    const utcDetails = filterCatalogGroupDetails(groups.map(catalogGroupDetails), { day: '2026-09-18', dayZone: 'UTC' });
    expect(id(utcDetails.flatMap((group) => group.roles))).toEqual(id(utc.flatMap((group) => group.jobs)));
    expect(utcDetails.every((group) => group.group.roleCount === group.roles.length)).toBe(true);

    // Read in Los Angeles the same date is a different window: it holds the roles
    // that landed from 07:00Z onward, and the ones before it belong to the 17th.
    const pacific = filterCatalogGroups(groups, { day: '2026-09-18', dayZone: 'America/Los_Angeles' });
    expect(id(pacific.flatMap((group) => group.jobs)).sort()).toEqual(['afternoon', 'next-utc-day']);
    const pacificDetails = filterCatalogGroupDetails(groups.map(catalogGroupDetails), { day: '2026-09-18', dayZone: 'America/Los_Angeles' });
    expect(id(pacificDetails.flatMap((group) => group.roles))).toEqual(id(pacific.flatMap((group) => group.jobs)));

    // A role with no release day at all never appears in a day-filtered catalog.
    const undated = job('undated', '2026-08-25T02:47:09.000Z', { catalogRecency: 'baseline' });
    expect(filterCatalogGroups(groupCatalogJobs([undated]), { day: '2026-08-25', dayZone: 'UTC' })).toEqual([]);
  });
});
