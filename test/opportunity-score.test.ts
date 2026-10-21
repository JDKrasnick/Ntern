import { describe, expect, it } from 'vitest';
import { scoreOpportunity } from '../src/opportunity-score.js';
import { companyRating, companyRatings } from '../src/company-ratings.js';
import type { CompensationRange } from '../src/types.js';

const input = { company: 'Unknown Labs', title: 'Software Engineer Intern', compensation: { raw: '' } };
const band = (extra: Partial<CompensationRange> = {}): CompensationRange => ({ minAmount: 60, maxAmount: 100,
  currency: 'USD', period: 'hourly', sourceText: '$60–100/hr', provenance: [], ...extra });

describe('opportunity score', () => {
  it('uses the agreed weights and neutral missing evidence', () => {
    expect(scoreOpportunity(input)).toMatchObject({ total: 60, company: 50, pay: 50, role: 90,
      companyEvidence: 'unrated', payEvidence: 'unknown' });
    expect(scoreOpportunity({ ...input, company: 'Microsoft' }, new Map([['name:microsoft', 95]]))).toMatchObject({ total: 80.3, company: 95 });
    expect(scoreOpportunity({ ...input, company: 'Microsoft' })).toMatchObject({ company: 50, companyEvidence: 'unrated' });
  });
  it('does not mistake unknown for poor, match employer substrings, or use an ATS name', () => {
    for (const company of ['Workday customer', 'Microsoft Consulting Partners', 'Appleton', 'Unknown Labs']) {
      expect(scoreOpportunity({ ...input, company }).company).toBe(50);
    }
    expect(companyRating('Microsoft Corporation')?.company).toBe('Microsoft');
    expect(companyRating('Amazon.com Services LLC')?.company).toBe('Amazon');
    expect(companyRating('Amazon Data Services, Inc.')?.company).toBe('Amazon');
  });
  it('lets a well-paying unknown employer outrank a known employer with low listed pay', () => {
    expect(scoreOpportunity({ ...input, compensation: { raw: '$100/hr', minHourlyUSD: 100 } }).total)
      .toBeGreaterThan(scoreOpportunity({ ...input, company: 'Cloudflare', compensation: { raw: '$15/hr', minHourlyUSD: 15 } }).total);
  });
  it('uses the lower bound, and handles annual/hourly consistently', () => {
    const hourly = scoreOpportunity({ ...input, compensation: { raw: '$60–100/hr', ranges: [band()] } });
    const annual = scoreOpportunity({ ...input, compensation: { raw: '$124,800/year', ranges: [band({ minAmount: 124800, maxAmount: 208000, period: 'annual' })] } });
    expect(hourly.pay).toBe(annual.pay);
    expect(hourly.pay).toBeCloseTo(72.7);
    expect(scoreOpportunity({ ...input, compensation: { raw: '$60–1000/hr', ranges: [band({ maxAmount: 1000 })] } }).pay).toBe(hourly.pay);
  });
  it.each([
    [band(), band({ currency: 'CAD' })], [band({ applicableLocations: ['New York'] })],
    [band({ applicableEducationLevels: ['masters'] })], [band({ applicabilityLabel: 'PhD' })],
    [band({ period: 'monthly' })], [band({ currency: 'XXX' })], [band({ minAmount: -10 })],
    [band({ minAmount: 100, maxAmount: 60 })], [band({ minAmount: Number.NaN })],
  ])('keeps ambiguous or invalid pay neutral: %j', (...ranges) => {
    const score = scoreOpportunity({ ...input, compensation: { raw: 'Pay disclosed', minHourlyUSD: 500, ranges } });
    expect(score).toMatchObject({ pay: 50, payEvidence: 'unknown' });
  });
  it('compares currencies with independent anchors and bounds scores', () => {
    expect(scoreOpportunity({ ...input, compensation: { raw: 'CAD 30/hour', ranges: [band({ currency: 'CAD', minAmount: 30 })] } }).pay).toBe(50);
    for (const amount of [0, 15, 35, 90, 100000]) {
      const score = scoreOpportunity({ ...input, compensation: { raw: 'Listed', minHourlyUSD: amount } });
      expect(score.total).toBeGreaterThanOrEqual(0); expect(score.total).toBeLessThanOrEqual(100);
    }
  });
  it('treats supported fields equally and does not favor a longer title', () => {
    const a = scoreOpportunity({ ...input, title: 'Product Design Intern' });
    const b = scoreOpportunity({ ...input, title: 'Security Engineering Intern, Cloud Infrastructure Distributed Systems' });
    expect(a.role).toBe(b.role);
    expect(scoreOpportunity({ ...input, title: 'Senior Software Engineer' }).role).toBe(20);
  });
  it('requires traceable, bounded editorial employer ratings', () => {
    for (const rating of companyRatings) {
      expect(rating.sources.length).toBeGreaterThan(0);
      expect(rating.sources.every(source => source.startsWith('https://'))).toBe(true);
      expect(rating.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rating.career).toBeGreaterThanOrEqual(0); expect(rating.career).toBeLessThanOrEqual(100);
      expect(rating.business).toBeGreaterThanOrEqual(0); expect(rating.business).toBeLessThanOrEqual(100);
    }
  });
});
