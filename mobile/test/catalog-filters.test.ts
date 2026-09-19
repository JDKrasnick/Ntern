import { describe, expect, it } from 'vitest';
import { catalogGroupAvailabilityLabel, catalogRequestState, emptyCatalogFilters, groupedCatalogParameters, parseCatalogFilters } from '../src/catalog-filters';

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
