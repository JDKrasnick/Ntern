import { describe, expect, it } from 'vitest';
import { postingFactSummaries } from '../../shared/posting-fact-display';
import type { PostingFact, PostingFactField } from '../../shared/posting-facts';

const fact = (field: PostingFactField, statements: string[], qualifiers: string[] = []): PostingFact =>
  ({ field, statements, qualifiers, sourceUrl: 'https://example.com/job', contentHash: 'a'.repeat(64) });

describe('brief metadata disclosures', () => {
  it('caps pay options at three, retains scope, and never shows Pay disclosed', () => {
    const ranges = [37, 42, 50, 60].map((amount, i) => ({ minAmount: amount, maxAmount: amount, currency: 'USD', period: 'hourly',
      applicableEducationLevels: [['undergraduate'], ['masters'], ['doctoral'], ['mba']][i] }));
    const result = postingFactSummaries([fact('compensation', ['USD 37/hour', 'USD 42/hour', 'USD 50/hour', 'USD 60/hour'], ['If eligible'])],
      { compensation: { ranges } })[0]!;
    expect(result.tags).toEqual(['Pay varies']);
    expect(result.payOptions).toEqual(['USD 37/hour (undergraduate)', 'USD 42/hour (masters)', 'USD 50/hour (doctoral)']);
    expect(result.morePayOptions).toBe(true);
    expect(result.details).toEqual(['If eligible']);
    expect(postingFactSummaries(undefined, { compensation: { raw: 'A long employer pay disclosure that needs an expanded detail view' } })[0]?.tags).toEqual(['Pay details']);
  });

  it('keeps a single matching pay disclosure brief without falsely showing Pay varies', () => {
    const pay = { minAmount: 37, maxAmount: 37, currency: 'USD', period: 'hourly', sourceText: 'Hourly Rate: $37' };
    const result = postingFactSummaries(undefined, { compensation: { ranges: [pay, { ...pay, currency: 'XXX' }] } })[0]!;
    expect(result.tags).toEqual(['$37/hr']);
    expect(result.payOptions).toEqual(['USD 37/hour']);
  });

  it('distinguishes no housing, unspecified stipends, conditional amounts and costs', () => {
    expect(postingFactSummaries([fact('housing', ['No housing or relocation assistance'])])[0]?.tags).toEqual(['None']);
    const statements = ['Housing stipend for interns relocating to the area', 'Relocation support up to $4,000 gross up, if eligible'];
    const result = postingFactSummaries([fact('housing', statements)])[0]!;
    expect(result.tags).toEqual(['Stipend: amount unstated', 'Up to $4,000', 'Depends']);
    expect(result.details).toEqual(statements);
    expect(postingFactSummaries([fact('housing', ['Housing cost to you: $300 per month'])])[0]?.tags).toEqual(['Cost $300']);
    expect(postingFactSummaries([fact('housing', ['Housing stipend of $2,000–$4,000 if eligible'])])[0]?.tags).toEqual(['$2,000–$4,000', 'Depends']);
    expect(postingFactSummaries([fact('housing', ['No housing provided unless approved'])])[0]?.tags).toContain('Depends');
    expect(postingFactSummaries([fact('housing', ['No housing provided; relocation support up to $4,000'])])[0]?.tags).not.toContain('None');
    expect(postingFactSummaries([fact('housing', ['Housing stipend of 5000 PLN'])])[0]?.tags).toEqual(['5000 PLN']);
    expect(postingFactSummaries([fact('housing', ['Housing stipend of five thousand dollars'])])[0]?.tags).toEqual(['Stipend details']);
  });

  it('keeps every field brief and retains complete conditions for expansion', () => {
    const facts = [
      fact('locations', ['El Segundo, California, United States', 'London, United Kingdom', 'Paris, France']),
      fact('workMode', ['Onsite']),
      fact('timing', ['May–August; dates depend on university schedule', 'Full-time · 40 hours per week']),
      fact('education', ['Required: actively enrolled in an accredited undergraduate or graduate degree program']),
      fact('eligibility', ['U.S. person required for export-controlled access', 'May also qualify with required export authorization', 'No security clearance required']),
    ];
    const results = postingFactSummaries(facts);
    for (const result of results) {
      expect(result.tags.length).toBeLessThanOrEqual(3);
      expect(result.tags.every(tag => tag.length <= 24)).toBe(true);
      expect(result.details).toEqual(facts.find(item => item.field === result.field)!.statements);
    }
    expect(results.find(item => item.field === 'eligibility')?.details).toContain('May also qualify with required export authorization');
    expect(results.find(item => item.field === 'education')?.tags).toEqual(['Undergrad / Grad']);
    expect(postingFactSummaries(undefined)).toEqual([]);
    expect(postingFactSummaries([fact('eligibility', ['No visa sponsorship; security clearance required'])])[0]?.tags).toContain('Clearance required');
  });
});
