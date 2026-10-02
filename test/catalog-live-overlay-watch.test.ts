import { describe, expect, it } from 'vitest';
import { newestPublishableUnprojected } from '../scripts/catalog-live-overlay-watch.js';
import { openCatalogSortKey } from '../src/catalog-recency.js';
import type { Internship } from '../src/types.js';

function job(jobId: string, visibleAt: string, overrides: Partial<Internship> = {}): Internship {
  return {
    jobId, company: 'Acme', title: `Software Intern ${jobId}`, location: 'Remote', season: 'summer-2027',
    applyUrl: `https://careers.example.test/${jobId}`, normalizedUrl: `https://careers.example.test/${jobId}`,
    fingerprint: jobId, compensation: { raw: '' }, sourceReferences: [], technical: true, open: true,
    firstSeenAt: visibleAt, catalogVisibleAt: visibleAt, lastSeenAt: visibleAt,
    notification: { smsPending: false, digestPending: false },
    ...overrides,
  };
}

const row = (value: Internship) => ({ value: JSON.stringify(value) });

describe('catalog live overlay watch', () => {
  it('selects the newest publishable role above the watermark and ignores the rest', () => {
    const watermark = openCatalogSortKey(job('watermark', '2026-10-01T00:00:00.000Z'));
    const rows = [
      row(job('below', '2026-09-30T23:59:59.000Z')),
      row(job('newest', '2026-10-01T00:00:02.000Z')),
      row(job('older', '2026-10-01T00:00:01.000Z')),
      row(job('not-technical', '2026-10-01T00:00:03.000Z', { technical: false })),
      row(job('closed', '2026-10-01T00:00:04.000Z', { open: false })),
    ];
    expect(newestPublishableUnprojected(rows, watermark)?.jobId).toBe('newest');
  });

  it('returns undefined when every role is at or below the watermark', () => {
    const watermark = openCatalogSortKey(job('watermark', '2026-10-01T00:00:00.000Z'));
    const rows = [
      row(job('below', '2026-09-30T12:00:00.000Z')),
      row(job('watermark', '2026-10-01T00:00:00.000Z')),
    ];
    expect(newestPublishableUnprojected(rows, watermark)).toBeUndefined();
  });
});
