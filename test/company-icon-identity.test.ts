import { describe, expect, it } from 'vitest';
import { companyIconIdentity } from '../shared/company-icon.js';

describe('independent company icon identity', () => {
  it('shares a brand across postings, tracking parameters, and Greenhouse hosts', () => {
    const first = companyIconIdentity('Acme, Inc.', 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x');
    expect(first).toEqual(companyIconIdentity('ACME', 'https://job-boards.greenhouse.io/acme/jobs/2'));
    expect(first?.id).toMatch(/^icon-v1-[a-f0-9]{32}$/u);
  });

  it('separates brands, employers with the same name on different boards, and Workday sites', () => {
    const urls = [
      ['RTX', 'https://globalhr.wd5.myworkdayjobs.com/en-US/RTX/job/A/123'],
      ['Raytheon', 'https://globalhr.wd5.myworkdayjobs.com/en-US/RTX/job/A/123'],
      ['RTX', 'https://globalhr.wd5.myworkdayjobs.com/en-US/Raytheon/job/A/123'],
      ['Acme', 'https://jobs.ashbyhq.com/acme-one/123'],
      ['Acme', 'https://jobs.ashbyhq.com/acme-two/123'],
    ];
    expect(new Set(urls.map(([company, url]) => companyIconIdentity(company!, url!)?.id)).size).toBe(5);
    expect(companyIconIdentity('RTX', urls[0]![1]!)?.id)
      .toBe(companyIconIdentity('RTX', 'https://globalhr.wd5.myworkdayjobs.com/RTX/job/B/456')?.id);
  });

  it.each(['http://example.com/job', 'https://user:password@example.com/job', 'garbage'])('refuses unsupported URL %s', (url) => {
    expect(companyIconIdentity('Acme', url)).toBeUndefined();
  });
});
