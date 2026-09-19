import { describe, expect, it } from 'vitest';
import { catalogDayIndexParameters, catalogFilterTokens, catalogGroupAvailabilityLabel, catalogRequestState, catalogViewNarrowed, countActiveCatalogFilters, emptyCatalogFilters, groupedCatalogParameters, parseCatalogFilters } from '../src/catalog-filters';

describe('catalog filter tokens', () => {
  it('names every active facet and clears only its own value', () => {
    const filters = {
      ...emptyCatalogFilters,
      seasons: ['summer-2027', 'fall-2026'],
      disciplines: ['SWE', 'Quant/Fintech'],
      employerFilter: 'startup' as const,
      hasCompensation: true,
      hideUsCitizenshipRequired: true,
    };
    const tokens = catalogFilterTokens(filters);

    expect(tokens.map((token) => token.label)).toEqual([
      'Summer 2027', 'Fall 2026', 'SWE', 'Quant', 'Startups', 'Pay listed', 'No U.S. citizenship requirement',
    ]);
    expect(tokens[0].patch).toEqual({ seasons: ['fall-2026'] });
    expect(tokens[2].patch).toEqual({ disciplines: ['Quant/Fintech'] });
    expect(tokens[4].patch).toEqual({ employerFilter: 'all' });
    expect(tokens[5].patch).toEqual({ hasCompensation: false });

    const afterClearingOneSeason = { ...filters, ...tokens[0].patch };
    expect(afterClearingOneSeason.seasons).toEqual(['fall-2026']);
    expect(afterClearingOneSeason.disciplines).toEqual(['SWE', 'Quant/Fintech']);
    expect(afterClearingOneSeason.employerFilter).toBe('startup');
  });

  it('lists nothing for the default filters', () => {
    expect(catalogFilterTokens(emptyCatalogFilters)).toEqual([]);
    expect(countActiveCatalogFilters(emptyCatalogFilters)).toBe(0);
  });
});

describe('release day requests', () => {
  it('sends the chosen day and the zone it was read in', () => {
    const filters = { ...emptyCatalogFilters, day: '2026-09-18' };
    const params = groupedCatalogParameters(catalogRequestState(filters, { dayZone: 'America/Los_Angeles' }));
    expect(params.get('day')).toBe('2026-09-18');
    expect(params.get('dayZone')).toBe('America/Los_Angeles');
    // Client facet names become the request's names.
    const named = groupedCatalogParameters(catalogRequestState({ ...filters, employerFilter: 'startup', sourceFilter: 'direct', jobStatus: 'closed' }));
    expect(named.get('status')).toBe('closed');
    expect(named.get('source')).toBe('direct');
    expect(named.get('employerCategory')).toBe('startup');
    // No day, no zone parameter.
    const plain = groupedCatalogParameters(catalogRequestState(emptyCatalogFilters, { dayZone: 'UTC' }));
    expect(plain.get('day')).toBeNull();
    expect(plain.get('dayZone')).toBeNull();
  });

  it('defaults a day to UTC when the reader has not chosen a zone', () => {
    const params = groupedCatalogParameters(catalogRequestState({ ...emptyCatalogFilters, day: '2026-09-18' }));
    expect(params.get('dayZone')).toBe('UTC');
  });

  it('asks for a month of release days without the day it would filter by', () => {
    const params = catalogDayIndexParameters(
      { ...emptyCatalogFilters, day: '2026-09-18', disciplines: ['SWE'] },
      { from: '2026-09-01', to: '2026-09-30', dayZone: 'Asia/Tokyo' },
    );
    expect(params.get('day')).toBeNull();
    expect(params.get('dayZone')).toBe('Asia/Tokyo');
    expect(params.get('from')).toBe('2026-09-01');
    expect(params.get('to')).toBe('2026-09-30');
    expect(params.get('limit')).toBeNull();
    // Every other facet still narrows the days that get counted.
    expect(params.get('disciplines')).toBe('SWE');
  });

  it('shows the day as a removable token and counts it once', () => {
    const filters = { ...emptyCatalogFilters, day: '2026-09-18', seasons: ['summer-2027'] };
    const tokens = catalogFilterTokens(filters);
    expect(tokens[0]?.key).toBe('day:2026-09-18');
    expect(tokens[0]?.label).toMatch(/Sep/);
    expect(tokens[0]?.label).toMatch(/18/);
    expect(countActiveCatalogFilters(filters)).toBe(2);
    // Clearing the day keeps every other facet.
    expect({ ...filters, ...tokens[0]?.patch }).toMatchObject({ day: undefined, seasons: ['summer-2027'] });
    expect(countActiveCatalogFilters({ ...filters, ...tokens[0]?.patch })).toBe(1);
  });
});

describe('grouped catalog request filters', () => {
  it('carries the same filters from a catalog row into group details', () => {
    const state = {
      query: 'machine learning', source: 'direct' as const, status: 'closed' as const,
      employerCategory: 'startup' as const, hideUsCitizenshipRequired: true, educationLevel: 'masters' as const,
    };
    const params = groupedCatalogParameters(state);
    expect(Object.fromEntries(params)).toEqual({
      limit: '25', status: 'closed', q: 'machine learning', source: 'direct', employerCategory: 'startup',
      hideUsCitizenshipRequired: 'true', educationLevel: 'masters',
    });
  });
  it('serializes discipline, season, work mode, and pay filters', () => {
    const params = groupedCatalogParameters({
      source: 'all', status: 'open', employerCategory: 'all',
      disciplines: ['SWE', 'Quant/Fintech'], seasons: ['summer-2027'], workModes: ['remote'],
      hasCompensation: true,
      hideUsCitizenshipRequired: false, educationLevel: 'undergraduate',
    });
    expect(Object.fromEntries(params)).toEqual({
      limit: '25', status: 'open', disciplines: 'SWE,Quant/Fintech', seasons: 'summer-2027',
      workModes: 'remote', hasCompensation: 'true', educationLevel: 'undergraduate',
    });
  });
  it('counts every active filter section exactly once', () => {
    expect(countActiveCatalogFilters(emptyCatalogFilters)).toBe(0);
    expect(countActiveCatalogFilters({
      ...emptyCatalogFilters, disciplines: ['SWE'], seasons: ['summer-2027', 'fall-2026'],
      hasCompensation: true, jobStatus: 'closed',
    })).toBe(4);
    // The level browse starts at is not a filter the reader chose.
    expect(countActiveCatalogFilters({ ...emptyCatalogFilters, educationLevel: 'masters' })).toBe(1);
  });
  it('keeps a reader studying at another level after a relaunch', () => {
    const roundTripped = parseCatalogFilters(JSON.parse(JSON.stringify({ ...emptyCatalogFilters, educationLevel: 'masters', disciplines: ['SWE'] })));
    expect(roundTripped).toMatchObject({ educationLevel: 'masters', disciplines: ['SWE'], employerFilter: 'all', jobStatus: 'open' });
  });
  it('falls back instead of breaking browse on a stored filter it cannot read', () => {
    expect(parseCatalogFilters(undefined)).toBeUndefined();
    expect(parseCatalogFilters('nonsense')).toBeUndefined();
    expect(parseCatalogFilters({ educationLevel: 'postdoc', employerFilter: 'unicorn', disciplines: 'SWE', hasCompensation: 'yes' }))
      .toEqual({ ...emptyCatalogFilters });
  });
  it('offers a way back whenever the catalog is narrowed by anything', () => {
    expect(catalogViewNarrowed('', emptyCatalogFilters)).toBe(false);
    expect(catalogViewNarrowed('   ', emptyCatalogFilters)).toBe(false);
    // A typed search narrows the catalog as surely as a facet does, so it needs
    // the same way out; counting facets alone would leave a query with no Reset.
    expect(catalogViewNarrowed('quant', emptyCatalogFilters)).toBe(true);
    expect(catalogViewNarrowed('', { ...emptyCatalogFilters, disciplines: ['SWE'] })).toBe(true);
    expect(catalogViewNarrowed('', { ...emptyCatalogFilters, day: '2026-09-18' })).toBe(true);
    expect(catalogViewNarrowed('', { ...emptyCatalogFilters, jobStatus: 'closed' })).toBe(true);
  });
  it('labels closed cards as closed for both visible and accessibility copy', () => {
    expect(catalogGroupAvailabilityLabel({ kind: 'individual', roleCount: 1 }, 'closed')).toBe('1 closed role');
    expect(catalogGroupAvailabilityLabel({ kind: 'program-group', roleCount: 2 }, 'closed')).toBe('2 closed roles');
  });
  it('uses grammatical singular and plural availability copy for open groups', () => {
    expect(catalogGroupAvailabilityLabel({ kind: 'program-group', roleCount: 1 }, 'open')).toBe('Open role');
    expect(catalogGroupAvailabilityLabel({ kind: 'program-group', roleCount: 2 }, 'open')).toBe('2 roles in this program');
    expect(catalogGroupAvailabilityLabel({ kind: 'employer-release', roleCount: 1 }, 'open')).toBe('Open role');
    expect(catalogGroupAvailabilityLabel({ kind: 'employer-release', roleCount: 2 }, 'open')).toBe('2 new roles');
  });
});
