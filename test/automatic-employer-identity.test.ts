import { describe, expect, it } from 'vitest';
import { automaticEmployerIdentityCandidate, automaticEmployerIdentityObservationSlice, groupAutomaticEmployerIdentityCandidates } from '../src/employer/automatic-identity.js';
import type { ProcessedListing } from '../src/types.js';

function listing(overrides: Partial<ProcessedListing> = {}): ProcessedListing {
  return {
    sourceId: 'simplify-summer-2026', provenance: 'reviewed-community',
    sourceUrl: 'https://github.com/SimplifyJobs/Summer2027-Internships', document: 'README.md', row: 1,
    externalId: 'row-1', fetchedAt: '2026-09-27T00:00:00Z', company: '🔥 AMD',
    title: 'Software Engineering Intern', location: 'Austin, TX', season: 'summer-2027',
    applyUrl: 'https://careers.amd.com/jobs/92358?icims=1', compensation: { raw: '' },
    state: 'open', employerLabelOrigin: 'explicit',
    ...overrides,
  };
}

describe('automatic employer identity evidence', () => {
  it('derives a clean employer candidate from an exact employer-specific ATS route', () => {
    expect(automaticEmployerIdentityCandidate(listing(), 8, '2026-09-27T01:00:00Z')).toEqual({
      provider: 'icims', scope: 'amd', sourceId: 'simplify-summer-2026', fetchSequence: 8,
      labelKey: 'amd', displayName: 'AMD', postingId: '92358',
      applicationUrl: 'https://careers.amd.com/jobs/92358?icims=1', observedAt: '2026-09-27T01:00:00Z',
    });
  });

  it('rejects shared ATS scopes, generic labels, and unresolved inherited labels', () => {
    expect(automaticEmployerIdentityCandidate(listing({ company: 'ABEC',
      applyUrl: 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4500637' }), 8,
    '2026-09-27T01:00:00Z')).toBeUndefined();
    expect(automaticEmployerIdentityCandidate(listing({ company: 'External Careers' }), 8,
      '2026-09-27T01:00:00Z')).toBeUndefined();
    expect(automaticEmployerIdentityCandidate(listing({ employerLabelOrigin: 'inherited',
      employerInheritance: 'conflict' }), 8, '2026-09-27T01:00:00Z')).toBeUndefined();
  });

  it('groups roles by tenant and normalized label while retaining distinct posting IDs', () => {
    const first = automaticEmployerIdentityCandidate(listing(), 8, '2026-09-27T01:00:00Z')!;
    const second = automaticEmployerIdentityCandidate(listing({
      externalId: 'row-2', applyUrl: 'https://careers.amd.com/jobs/92359?icims=1',
    }), 8, '2026-09-27T01:00:00Z')!;
    expect(groupAutomaticEmployerIdentityCandidates([first, first, second])).toEqual([
      expect.objectContaining({ provider: 'icims', scope: 'amd', labelKey: 'amd', postingIds: ['92358', '92359'] }),
    ]);
  });

  it('rotates a bounded identity-enrichment window across successful fetches', () => {
    const observations = Array.from({ length: 8 }, (_, index) => ({
      provider: 'ashby' as const, scope: `tenant-${index}`, sourceId: 'community', fetchSequence: 1,
      labelKey: `company-${index}`, displayName: `Company ${index}`, postingIds: [`posting-${index}`],
      applicationUrl: `https://jobs.ashbyhq.com/tenant-${index}/posting-${index}`,
      observedAt: '2026-09-27T01:00:00Z',
    }));

    const first = automaticEmployerIdentityObservationSlice(observations, 1);
    const second = automaticEmployerIdentityObservationSlice(observations, 2);
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second].map((observation) => observation.scope)).size).toBe(8);
  });
});
