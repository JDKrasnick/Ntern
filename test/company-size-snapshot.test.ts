import { describe, expect, it } from 'vitest';
import snapshot from '../src/config/company-size-snapshot.json' with { type: 'json' };
import { companySizeKey, companySizeScore, companyWebsiteDomain } from '../src/company-size.js';
import { snapshotCompanySizeScore } from '../src/company-size-snapshot.js';
import { companyRating, companyTierScore } from '../src/company-ratings.js';
import { scoreOpportunity } from '../src/opportunity-score.js';

const input = { title: 'Software Engineer Intern', compensation: { raw: '' } };

describe('offline company-size snapshot', () => {
  it('ships unique, traceable exact matches with supported size bands', () => {
    expect(snapshot.metadata.license).toBe('CC BY 4.0');
    expect(snapshot.metadata.sha256).toBe('2d529f107b1b592d942c01dfbf696061fc33e646fcbfe92db547ae930706cfc2');
    expect(snapshot.records).toHaveLength(474);
    expect(new Set(snapshot.records.map(row => row.company)).size).toBe(snapshot.records.length);
    for (const row of snapshot.records) {
      expect(companySizeKey(row.company)).toBe(row.company);
      expect(companyWebsiteDomain(row.domain)).toBe(row.domain);
      expect(row.providerId).not.toBe('');
      expect(['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+']).toContain(row.size);
      const expected = companySizeScore(Number(row.size.split('-')[0]!.replace('+', '')));
      expect(snapshotCompanySizeScore(row.company)).toBe(expected);
      const rating = companyRating(row.company);
      const tier = companyTierScore(row.company);
      const score = scoreOpportunity({ ...input, company: row.company });
      expect(score.company).toBe(rating ? Math.round((rating.career * .7 + rating.business * .3) * 10) / 10 : tier ?? expected);
      expect(score.pay).toBe(50);
      expect(score.role).toBe(90);
    }
  });

  it('keeps ambiguous, conflicting and known false matches out of the lookup', () => {
    for (const company of ['Klaviyo', 'F5', 'Johnson & Johnson', 'Rocket Lab', 'Waymo', 'Atomic Semi', 'Unknown Labs']) {
      expect(snapshotCompanySizeScore(company)).toBeUndefined();
      expect(scoreOpportunity({ ...input, company })).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    }
    expect(scoreOpportunity({ ...input, company: 'TikTok' })).toMatchObject({ company: 80, companyEvidence: 'lookup' });
  });

  it('normalizes exact names, rejects substrings, and prefers a valid newer cache', () => {
    expect(scoreOpportunity({ ...input, company: '🔥 Dell Technologies, Inc.' })).toMatchObject({ company: 85, companyEvidence: 'size' });
    expect(scoreOpportunity({ ...input, company: 'Dell Technologies Partners' })).toMatchObject({ company: 50, companyEvidence: 'unrated' });
    expect(scoreOpportunity({ ...input, company: 'Dell Technologies' }, new Map([['dell technologies', 75]]))).toMatchObject({ company: 75, companyEvidence: 'size' });
    expect(scoreOpportunity({ ...input, company: 'Dell Technologies' }, new Map([['dell technologies', NaN]]))).toMatchObject({ company: 85, companyEvidence: 'size' });
  });
});
