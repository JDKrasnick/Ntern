import { describe, expect, it } from 'vitest';
import {
  buildInternshipIdentity,
  educationAudienceLevels,
  educationAudienceLabel,
  educationAudienceMatches,
  effectiveAdvancedDegreeRequired,
  deriveTitleFields,
  mergeEducationEvidence,
  mergeProvenancedValues,
} from '../src/identity/enrichment.js';
import type { FieldProvenance } from '../src/types.js';

const evidence = (source: FieldProvenance['source'], evidenceCode: string): FieldProvenance => ({
  source,
  sourceId: source,
  evidenceCode,
});

describe('provider-neutral field enrichment', () => {
  it('builds a durable grouping identity from one official ATS posting', () => {
    const identity = buildInternshipIdentity({
      sourceId: 'greenhouse-acme',
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/42',
      observedAt: '2026-08-24T00:00:00.000Z',
      company: 'Acme, Inc.',
      title: 'Software Engineering Intern, Summer 2027',
      location: 'New York, NY / Remote',
      season: 'summer-2027',
      seasonEvidenceStatus: 'explicit',
      content: "Currently enrolled in a bachelor's or master's program.",
      workMode: 'hybrid',
    });
    expect(identity).toMatchObject({
      company: { canonicalId: 'acme' },
      programType: { value: 'internship' },
      season: { term: 'summer', year: 2027, evidenceStatus: 'explicit' },
      education: { levels: ['masters', 'undergraduate'], evidenceStatus: 'explicit' },
      locations: [{ name: 'New York, NY', workMode: 'hybrid' }, { name: 'Remote', workMode: 'hybrid' }],
    });
  });

  it('reads the audience an employer states rather than every degree word on the page', () => {
    // Live Clearwater Analytics posting: the requirement is a four-year degree,
    // and "Master's" is a typo'd action verb in the bullet above it.
    expect(educationAudienceLevels("Master's\nthe team's business domain basics within 1 month and detailed knowledge within 3.\nCurrent students pursuing a four-year degree in Computer Science or related field."))
      .toEqual(['undergraduate']);
    expect(educationAudienceLevels('You will master complex distributed systems and master our tooling.')).toEqual([]);
    expect(educationAudienceLevels('Mastery of Python and SQL required.')).toEqual([]);
    expect(educationAudienceLevels("Master's or PhD degree required in Computer Science.")).toEqual(['doctoral', 'masters']);
    expect(educationAudienceLevels('Must be enrolled in a graduate program.')).toEqual(['masters']);
    expect(educationAudienceLevels('This role is for graduate students only.')).toEqual(['masters']);
    expect(educationAudienceLevels("Currently pursuing a Bachelor's, Master's, or PhD degree in Electrical Engineering."))
      .toEqual(['doctoral', 'masters', 'undergraduate']);
    expect(educationAudienceLevels("2027 Leadership Development Program Intern (Master's)")).toEqual(['masters']);
    // A latency measurement is not a degree.
    expect(educationAudienceLevels('Latency under 5 ms.')).toEqual([]);
    // "4-year college degree" is the same audience as "four-year degree".
    expect(educationAudienceLevels('Experience with C/C++ 4-year college degree or higher.')).toEqual(['undergraduate']);
    expect(educationAudienceLevels('A 4 year university degree in Physics is required.')).toEqual(['undergraduate']);
  });

  it('does not read an application form\u2019s degree options as an audience', () => {
    // A rendered Greenhouse page with its application form: the "degree of
    // study" dropdown lists Bachelors and Masters/phD, but the role is a
    // Masters posting. The form is UI, not a requirement.
    expect(educationAudienceLevels('Please indicate your degree of study Bachelors Masters/phD Please select and confirm your anticipated graduation date'))
      .toEqual([]);
    expect(educationAudienceLevels('Degree of study Bachelors Masters/phD')).toEqual([]);
    // A real sentence next to a form mention is still read.
    expect(educationAudienceLevels("Please indicate your degree of study\nCurrently pursuing a Master's degree in Computer Science."))
      .toEqual(['masters']);
  });

  it('clears a community advanced-degree badge the employer\u2019s explicit audience contradicts', () => {
    // SpaceX-style: a community cap says graduate-only, the official page admits
    // undergraduates. The explicit audience wins.
    expect(effectiveAdvancedDegreeRequired({ levels: ['undergraduate'], evidenceStatus: 'explicit', advancedDegreeRequired: true })).toBe(false);
    expect(effectiveAdvancedDegreeRequired({ levels: ['doctoral', 'masters', 'undergraduate'], evidenceStatus: 'explicit', advancedDegreeRequired: true })).toBe(false);
    // Graduate-only explicit levels keep (and can assert) the requirement.
    expect(effectiveAdvancedDegreeRequired({ levels: ['masters'], evidenceStatus: 'explicit', advancedDegreeRequired: false })).toBe(true);
    expect(effectiveAdvancedDegreeRequired({ levels: ['doctoral'], evidenceStatus: 'explicit' })).toBe(true);
    // Silence leaves the stored badge untouched.
    expect(effectiveAdvancedDegreeRequired({ levels: [], evidenceStatus: 'unspecified', advancedDegreeRequired: true })).toBe(true);
    expect(effectiveAdvancedDegreeRequired({ advancedDegreeRequired: true })).toBe(true);
  });

  it('never turns a stated preference or a waived requirement into an audience', () => {
    expect(educationAudienceLevels("Master's degree preferred.")).toEqual([]);
    expect(educationAudienceLevels('Pursuing an MBA is a plus.')).toEqual([]);
    expect(educationAudienceLevels("No Master's degree is required.")).toEqual([]);
    // One clause's preference must not demote another clause's requirement.
    expect(educationAudienceLevels('MS preferred, BS required.')).toEqual(['undergraduate']);
    expect(educationAudienceLevels("A Master's degree is not required. A Bachelor's degree is required.")).toEqual(['undergraduate']);
  });

  it('prefers official structured evidence and retains corroboration for the winning value', () => {
    expect(mergeProvenancedValues([
      { value: 'Engineer Intern', provenance: [evidence('reviewed-community', 'table-title')] },
      { value: 'Software Engineer Intern', provenance: [evidence('official-page', 'h1')] },
      { value: 'Software Engineer Intern', provenance: [evidence('official-ats', 'job-title')] },
    ])).toEqual({
      value: 'Software Engineer Intern',
      provenance: [evidence('official-ats', 'job-title'), evidence('official-page', 'h1')],
    });
  });

  it('keeps missing education unspecified, visible, and matching every user', () => {
    const audience = mergeEducationEvidence([{ provenance: [evidence('official-ats', 'education-absent')] }]);
    expect(audience).toMatchObject({ levels: [], evidenceStatus: 'unspecified' });
    expect(educationAudienceMatches(audience, ['undergraduate'])).toBe(true);
    expect(educationAudienceLabel(audience)).toBe('Education level not specified by employer.');
  });

  it('unions compatible explicit audiences while keeping minimum degree separate', () => {
    const audience = mergeEducationEvidence([
      { levels: ['undergraduate'], minimumDegree: 'high-school', provenance: [evidence('official-ats', 'audience')] },
      { levels: ['masters'], minimumDegree: 'high-school', provenance: [evidence('official-page', 'requirements')] },
    ]);
    expect(audience).toMatchObject({
      levels: ['masters', 'undergraduate'],
      minimumDegree: 'high-school',
      evidenceStatus: 'explicit',
    });
    expect(educationAudienceMatches(audience, ['doctoral'])).toBe(false);
  });

  it('marks contradictory degree requirements and disjoint graduation windows as conflicting', () => {
    const audience = mergeEducationEvidence([
      {
        levels: ['undergraduate'],
        minimumDegree: 'bachelors',
        graduationDateWindow: { end: '2027-05' },
        provenance: [evidence('official-json-ld', 'qualification')],
      },
      {
        levels: ['undergraduate'],
        minimumDegree: 'masters',
        graduationDateWindow: { start: '2028-01' },
        provenance: [evidence('official-page', 'requirements')],
      },
    ]);
    expect(audience.evidenceStatus).toBe('conflicting');
    expect(audience.minimumDegree).toBeUndefined();
    expect(educationAudienceMatches(audience, ['doctoral'])).toBe(true);
  });

  it('preserves the official title while deriving a lightly cleaned display title and supplemental tags', () => {
    const provenance = evidence('deterministic-inference', 'title-v1');
    expect(deriveTitleFields({
      value: '🔥  Machine Learning / Software Engineer Internship ',
      provenance: [evidence('official-ats', 'job-title')],
    }, provenance)).toEqual({
      official: {
        value: '🔥  Machine Learning / Software Engineer Internship ',
        provenance: [evidence('official-ats', 'job-title')],
      },
      display: { value: 'Machine Learning / Software Engineer Internship', provenance: [provenance] },
      search: { value: 'machine learning software engineer intern', provenance: [provenance] },
      disciplines: [
        { value: 'ai-ml', provenance: [provenance] },
        { value: 'software', provenance: [provenance] },
      ],
    });
  });
});
