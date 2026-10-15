import { describe, expect, it } from 'vitest';
import { postingFactSummaries } from '../../shared/posting-fact-display';
import type { PostingFact, PostingFactField } from '../../shared/posting-facts';

const fact = (field: PostingFactField, statements: string[], qualifiers: string[] = []): PostingFact =>
  ({ field, statements, qualifiers, sourceUrl: 'https://example.com/job', contentHash: 'a'.repeat(64) });

describe('brief metadata disclosures', () => {
  it('puts legacy location in the same metadata flow without duplicating published location', () => {
    expect(postingFactSummaries(undefined, { locations: ['San Jose, CA'] })[0]?.tags).toEqual(['San Jose']);
    expect(postingFactSummaries([fact('locations', ['San Jose, CA'])], { locations: ['San Jose, California'] })).toHaveLength(1);
  });
  it.each([
    ['Pursuing a bachelor’s degree in Mechanical or Electrical Engineering', ['Pursuing bachelor’s']],
    ['Bachelors in Computer Science or related field', ['Bachelor’s']],
    ['Currently enrolled in an undergraduate B.S. program in Robotics', ['Pursuing bachelor’s']],
    ['Bachelor’s or Master’s in Mechatronics', ['Bachelor’s', 'Master’s']],
    ['Pursuing a bachelor’s or master’s in Computer Science', ['Pursuing bachelor’s', 'Pursuing master’s']],
    ['Pursuing a PhD in Robotics', ['Pursuing PhD']],
    ['Currently enrolled in an MBA program', ['Pursuing MBA']],
    ['Bachelor’s degree or equivalent experience', ['Bachelor’s', 'Or equivalent exp.']],
    ['Master’s degree in Computer Science preferred', ['Master’s preferred']],
    ['Pursuing degree · Mechanical, Electrical, Robotics, Mechatronics or related engineering; ≥2 years completed by internship start', ['Pursuing engineering degree', '2+ years completed']],
    ['Currently enrolled in an undergraduate program', ['Pursuing undergrad']],
  ])('shows a supported degree summary and keeps majors in the hint: %s', (statement, labels) => {
    const result = postingFactSummaries([fact('education', [statement])])[0]!;
    expect(result.tags).toEqual(labels);
    expect(result.details).toEqual([statement]);
  });

  it('retains duration ranges and weekly attendance at a glance', () => {
    expect(postingFactSummaries([fact('timing', ['8–12-month internship', 'In-office collaboration · 5 days/week'])])[0]?.tags)
      .toEqual(['8–12 months', '5 days/wk']);
  });

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
    expect(result.tags).toEqual(['Stipend may be available', 'Amount unstated', 'Up to $4,000 if eligible']);
    expect(result.details).toEqual(statements);
    expect(postingFactSummaries([fact('housing', ['Housing cost to you: $300 per month'])])[0]?.tags).toEqual(['Cost $300']);
    expect(postingFactSummaries([fact('housing', ['Housing stipend of $2,000–$4,000 if eligible'])])[0]?.tags).toEqual(['$2,000–$4,000 if eligible']);
    expect(postingFactSummaries([fact('housing', ['No housing provided unless approved'])])[0]?.tags).toEqual(['Housing not guaranteed']);
    expect(postingFactSummaries([fact('housing', ['No housing provided; relocation support up to $4,000'])])[0]?.tags).not.toContain('None');
    expect(postingFactSummaries([fact('housing', ['Housing stipend of 5000 PLN'])])[0]?.tags).toEqual(['5000 PLN']);
    expect(postingFactSummaries([fact('housing', ['Housing stipend of five thousand dollars'])])[0]?.tags).toEqual(['Stipend details']);
  });

  it('names the conditional benefit instead of showing a standalone Depends', () => {
    const statement = 'Relocation assistance may be provided for eligible roles';
    const summary = postingFactSummaries([fact('housing', [statement])])[0]!;
    expect(summary.tags).toEqual(['Relocation may be available', 'Amount unstated']);
    expect(summary.details).toEqual([statement]);
    expect(postingFactSummaries([fact('eligibility', ['Visa sponsorship may be available'])])[0]?.tags).toEqual(['May offer sponsorship']);
    expect(postingFactSummaries([fact('housing', ['Housing provided'], ['If eligible'])])[0]?.tags).toEqual(['May be provided']);
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
    expect(results.find(item => item.field === 'education')?.tags).toEqual(['Pursuing undergrad', 'Pursuing grad']);
    expect(postingFactSummaries(undefined)).toEqual([]);
    expect(postingFactSummaries([fact('eligibility', ['No visa sponsorship; security clearance required'])])[0]?.tags).toContain('Clearance required');
  });
});
