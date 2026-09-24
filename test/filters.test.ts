import { describe, expect, it } from 'vitest';
import { evaluateJobFilter, inferJobFocuses, isTechnicalJob, matchesJobFilter, parseJobFilter, technicalScopeFor } from '../src/core/filters.js';
import { employerCategory } from '../src/core/employers.js';
import { MemoryInternshipStore } from '../src/store.js';
import { Poller } from '../src/poll.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceFetchResult } from '../src/types.js';

const listing = (title: string, url: string, company = 'Example'): RawListing => ({ sourceId: 'fixture', document: 'README.md', sourceUrl: 'https://example.com', row: 1, company, title, location: 'Remote', season: 'summer-2027', applyUrl: url, compensation: { raw: '' }, state: 'open', fetchedAt: '2026-07-19T00:00:00Z' });
class Adapter implements SourceAdapter {
  readonly id = 'fixture';
  constructor(private readonly rows: RawListing[]) {}
  async fetch(previous?: SourceCheckpoint): Promise<SourceFetchResult> { return { sourceId: this.id, listings: this.rows, notModified: false, checkpoint: { sourceId: this.id, successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRowCount: this.rows.length } }; }
}

describe('job filters', () => {
  it('omits unset optional fields so a saved filter is DynamoDB-serializable', () => {
    expect(parseJobFilter({ includeCategories: ['swe'] })).toStrictEqual({
      includeCategories: ['swe']
    });
  });
  it('excludes graduate jobs without excluding undergraduate internships', () => {
    const filter = parseJobFilter({ excludeCategories: ['grad'] });
    expect(matchesJobFilter(listing('Graduate Software Engineer Intern', 'https://example.com/grad'), filter)).toBe(false);
    expect(matchesJobFilter(listing('Undergraduate Software Engineering Intern', 'https://example.com/undergrad'), filter)).toBe(true);
  });
  it('supports category and keyword inclusion with exclusions taking precedence', () => {
    const filter = parseJobFilter({ includeCategories: ['ai-ml'], includeKeywords: ['robotics'], excludeKeywords: ['senior'] });
    expect(matchesJobFilter(listing('Machine Learning Intern', 'https://example.com/ml'), filter)).toBe(true);
    expect(matchesJobFilter(listing('Robotics Intern', 'https://example.com/robotics'), filter)).toBe(true);
    expect(matchesJobFilter(listing('Senior Machine Learning Intern', 'https://example.com/senior'), filter)).toBe(false);
    expect(matchesJobFilter(listing('Finance Intern', 'https://example.com/finance'), filter)).toBe(false);
    expect(() => parseJobFilter({ excludeCategories: ['not-a-category'] })).toThrow('unsupported category');
  });
  it('returns distinct user-facing match reasons without diverging from eligibility', () => {
    const filter = parseJobFilter({ includeCategories: ['ai-ml', 'swe'], includeKeywords: ['machine', 'machine'], includeEmployerCategories: ['startup'], excludeKeywords: ['senior'] });
    const role = listing('Machine Learning Software Intern', 'https://example.com/ml', 'Vercel');
    const evaluation = evaluateJobFilter(role, filter);
    expect(evaluation).toEqual({
      matches: true,
      reasons: [
        { kind: 'category', label: 'AI/ML' },
        { kind: 'category', label: 'Software engineering' },
        { kind: 'keyword', label: 'machine' },
        { kind: 'company-type', label: 'Startups' },
      ],
      exclusionsApplied: true,
    });
    expect(matchesJobFilter(role, filter)).toBe(evaluation.matches);
    expect(evaluateJobFilter({ ...role, title: `Senior ${role.title}` }, filter)).toMatchObject({ matches: false, reasons: [], exclusionsApplied: true });
  });
  it('explains the default technical-role filter and company-only filters', () => {
    expect(evaluateJobFilter(listing('Software Engineering Intern', 'https://example.com/default'))).toEqual({
      matches: true,
      reasons: [{ kind: 'default-all-technical', label: 'All technical roles' }],
      exclusionsApplied: false,
    });
    expect(evaluateJobFilter(listing('Software Engineering Intern', 'https://example.com/google', 'Google'), { includeEmployerCategories: ['faang'] }).reasons).toEqual([
      { kind: 'default-all-technical', label: 'All technical roles' },
      { kind: 'company-type', label: 'FAANG' },
    ]);
  });
  it('classifies FAANG and reviewed YC startups while keeping every other employer normal', () => {
    expect(employerCategory('Google LLC')).toBe('faang');
    expect(employerCategory('Vercel, Inc.')).toBe('startup');
    expect(employerCategory('Example Manufacturing')).toBe('normal');
  });
  it('uses employer categories in the same include/exclude filter path as GitHub-sourced listings', () => {
    const filter = parseJobFilter({ includeCategories: ['swe'], includeEmployerCategories: ['faang', 'startup'] });
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/google', 'Google'), filter)).toBe(true);
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/vercel', 'Vercel'), filter)).toBe(true);
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/normal', 'Example'), filter)).toBe(false);
    expect(matchesJobFilter(listing('Product Intern', 'https://example.com/google-product', 'Google'), filter)).toBe(false);
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/excluded', 'Google'), parseJobFilter({ excludeEmployerCategories: ['faang'] }))).toBe(false);
    expect(() => parseJobFilter({ includeEmployerCategories: ['selective'] })).toThrow('unsupported employer category');
  });
  it('filters explicit U.S.-citizenship and stated-audience requirements without adding a sponsorship filter', () => {
    const citizenship = { ...listing('Software Engineering Intern', 'https://example.com/citizenship'), requirements: { requiresUsCitizenship: true, advancedDegreeRequired: false } };
    const filter = parseJobFilter({ excludeUsCitizenshipRequired: true, educationLevel: 'undergraduate' });
    expect(matchesJobFilter(citizenship, filter)).toBe(false);
    expect(matchesJobFilter(listing('Software Engineering Intern', 'https://example.com/eligible'), filter)).toBe(true);
    expect(() => parseJobFilter({ excludeUsCitizenshipRequired: 'yes' })).toThrow('must be a boolean');
    expect(() => parseJobFilter({ educationLevel: 'postdoc' })).toThrow('educationLevel must be one of');
  });
  it('withholds a role that states a different audience and keeps one that never said', () => {
    const audience = (levels: string[], evidenceStatus: 'explicit' | 'unspecified') => ({
      internshipIdentity: { education: { levels, evidenceStatus, provenance: [] } },
    });
    const filter = parseJobFilter({ educationLevel: 'undergraduate' });
    const graduateOnly = { ...listing('Research Intern', 'https://example.com/phd'), ...audience(['masters', 'doctoral'], 'explicit') };
    const openToBoth = { ...listing('Research Intern', 'https://example.com/bsms'), ...audience(['undergraduate', 'masters'], 'explicit') };
    const unstated = { ...listing('Software Engineering Intern', 'https://example.com/none'), ...audience([], 'unspecified') };
    expect(matchesJobFilter(graduateOnly, filter)).toBe(false);
    expect(matchesJobFilter(openToBoth, filter)).toBe(true);
    expect(matchesJobFilter(unstated, filter)).toBe(true);
    // A graduate reader is not turned away by the role an undergraduate cannot take.
    expect(matchesJobFilter(graduateOnly, parseJobFilter({ educationLevel: 'masters' }))).toBe(true);
  });
  it('treats the legacy badge as a graduate requirement that only rules out an undergraduate', () => {
    const badge = { ...listing('Firmware Intern', 'https://example.com/badge'), requirements: { requiresUsCitizenship: false, advancedDegreeRequired: true } };
    expect(matchesJobFilter(badge, parseJobFilter({ educationLevel: 'undergraduate' }))).toBe(false);
    expect(matchesJobFilter(badge, parseJobFilter({ educationLevel: 'masters' }))).toBe(true);
  });
  it('derives specific focus labels from role keywords without an LLM', () => {
    expect(inferJobFocuses(listing('Cloud Infrastructure Software Engineering Intern', 'https://example.com/cloud'))).toEqual(['Cloud/Infra']);
    expect(inferJobFocuses(listing('Machine Learning Platform Intern', 'https://example.com/ml'))).toEqual(['AI/ML', 'Cloud/Infra']);
    expect(inferJobFocuses(listing('Backend API Intern', 'https://example.com/backend'))).toEqual(['Backend/API']);
    expect(inferJobFocuses(listing('Software Engineering Intern', 'https://example.com/swe'))).toEqual(['SWE']);
  });
  it('keeps the initial catalog technical while retaining graduate filters as a preference', () => {
    expect(isTechnicalJob(listing('Software Engineering Intern', 'https://example.com/swe'))).toBe(true);
    expect(isTechnicalJob(listing('Human Resources Intern', 'https://example.com/hr'))).toBe(false);
  });
  it('classifies expanded engineering titles without widening legacy alerts', () => {
    const mechanical = listing('Mechanical Engineering Intern', 'https://example.com/mechanical');
    const sales = listing('Sales Engineer Intern', 'https://example.com/sales');
    expect(isTechnicalJob(mechanical)).toBe(true);
    expect(technicalScopeFor(mechanical)).toBe('expanded');
    expect(isTechnicalJob(sales)).toBe(false);
    expect(matchesJobFilter({ ...mechanical, technicalScope: 'expanded' }, {})).toBe(false);
    expect(matchesJobFilter({ ...mechanical, technicalScope: 'expanded' }, parseJobFilter({ includeExpandedTechnical: true }))).toBe(true);
    expect(parseJobFilter({ includeCategories: ['mechanical'] })).toEqual({ includeCategories: ['mechanical'], includeExpandedTechnical: true });
  });
  it('recognizes every expanded discipline and rejects commercial collisions', () => {
    const titles = [
      'Engineering Rotation Intern', 'Thermal Engineering Co-op', 'RF Engineer Intern', 'Propulsion Intern',
      'Structural Analysis Intern', 'Materials Engineering Intern', 'Manufacturing Intern', 'Biomedical Engineering Intern',
      'Renewable Energy Intern', 'Validation Engineer Intern', 'Engineering Technician Apprentice',
    ];
    for (const title of titles) expect(technicalScopeFor(listing(title, `https://example.com/${title}`)), title).toBe('expanded');
    for (const title of ['Supply Chain Engineering Intern', 'Facilities Engineer Intern', 'Customer Support Technician']) {
      expect(isTechnicalJob(listing(title, `https://example.com/${title}`)), title).toBe(false);
    }
  });
  it('admits technical domains the six coarse categories never named', () => {
    for (const title of ['Data Engineer Intern', 'Cybersecurity Analyst Intern', 'Hardware Engineer (FPGA/ASIC) Intern',
      'Platform Engineer Intern', 'Network Engineer Intern', 'Windows Engineer Intern', 'IT Operations Intern',
      'DevOps/SRE Intern', 'Analytics Intern', 'Firmware Internship 2027', 'Member of Technical Staff Intern']) {
      expect(isTechnicalJob(listing(title, 'https://example.com/role')), title).toBe(true);
    }
  });
  it('recognizes explicitly technical project delivery without broadening generic management', () => {
    expect(isTechnicalJob(listing('Technical Project Management Intern (Summer 2027)', 'https://example.com/tpm'))).toBe(true);
    expect(isTechnicalJob(listing('Technical Program Manager Intern', 'https://example.com/tpgm'))).toBe(true);
    expect(isTechnicalJob(listing('Project Management Intern', 'https://example.com/pm'))).toBe(false);
    expect(isTechnicalJob(listing('Marketing Project Manager Intern', 'https://example.com/marketing'))).toBe(false);
  });
  it('lets a business function outrank a technical word it merely shares', () => {
    for (const title of ['AI Marketing Intern', 'Talent Acquisition Technology Intern', 'Platform Campaign Project Intern',
      'Technical Recruiting Intern - AI & Automation', 'Supply Chain Intern', 'Administrative Business Partner - Security']) {
      expect(isTechnicalJob(listing(title, 'https://example.com/role')), title).toBe(false);
    }
  });
  it('keeps a strong technical signal even inside a business-function title', () => {
    expect(isTechnicalJob(listing('Data Science Intern (Customer Success)', 'https://example.com/ds'))).toBe(true);
    expect(isTechnicalJob(listing('Sales and Trading Intern', 'https://example.com/st'))).toBe(true);
  });
  it('never lets a company name make a role technical', () => {
    expect(isTechnicalJob(listing('Marketing Intern', 'https://example.com/m', 'Palantir Technologies'))).toBe(false);
    expect(isTechnicalJob(listing('Office Coordinator Intern', 'https://example.com/o', 'Data Systems Software Inc'))).toBe(false);
  });
  it('stores filtered jobs but never queues them for push or email', async () => {
    const store = new MemoryInternshipStore();
    await new Poller([new Adapter([listing('Software Engineering Intern', 'https://example.com/initial')])], store).poll();
    const report = await new Poller([new Adapter([listing('Software Engineering Intern', 'https://example.com/initial'), listing('Graduate Research Intern', 'https://example.com/grad')])], store, () => new Date(), { excludeCategories: ['grad'] }).poll();
    expect(report.newJobs).toEqual([]); expect(report.filteredJobs).toHaveLength(1); expect(await store.pendingSms()).toEqual([]); expect(await store.pendingDigest()).toEqual([]);
  });
});
