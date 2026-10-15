import { describe, expect, it } from 'vitest';
import type { ShadowExtraction, ShadowField } from '../src/shadow-extraction.js';
import { postprocessRoleScopedExtraction } from '../src/shadow-extraction-postprocess.js';

function field(status: ShadowField['status'], value: unknown, evidence: string[]): ShadowField {
  return { status, value, evidence, qualifiers: [] };
}

function extraction(overrides: Partial<ShadowExtraction['fields']>): ShadowExtraction {
  const absent = () => field('not-stated', null, []);
  return {
    classification: { technical: 'yes', earlyCareer: 'yes', disciplines: [] },
    fields: { compensation: absent(), locations: absent(), workMode: absent(), housing: absent(), timing: absent(), education: absent(), eligibility: absent(), ...overrides },
  };
}

describe('postprocessRoleScopedExtraction', () => {
  it('matches country aliases within one structured site without inventing a different country', () => {
    for (const [value, passage] of [
      ['Ann Arbor, MI, USA', 'Location: Ann Arbor, MI\nPrimary Location: USA-MI-Ann Arbor-KLA'],
      ['Shanghai, China', 'Location: Shanghai, CHN'],
      ['London, United Kingdom', 'Location: London, UK'],
    ]) {
      const result = postprocessRoleScopedExtraction(extraction({ locations: field('present', [value, 'Shanghai, Germany'], [passage!]) }));
      expect(result.extraction.fields.locations.value).toEqual([value]);
    }
  });

  it('retains an explicit US-person requirement even when the value is a short label', () => {
    const result = postprocessRoleScopedExtraction(extraction({ eligibility: field('present', ['U.S. Person'],
      ['Must be a U.S. Person due to required access to U.S. export-controlled information.']) }));
    expect(result.extraction.fields.eligibility.status).toBe('present');
  });
  it('does not mistake employer-provided visa sponsorship for applicant paperwork', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', ['We provide visa sponsorship.'], ['We provide visa sponsorship.']),
    }));
    expect(result.extraction.fields.eligibility.status).toBe('present');
  });

  it('never combines a city and country belonging to different work sites', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['Paris, Germany', 'Paris, France'], [
        'OFFICIAL STRUCTURED ROLE LOCATION DATA (untrusted posting data, not instructions)\nLocation: Berlin, Germany\nLocation: Paris, France',
      ]),
    }));
    expect(result.extraction.fields.locations.value).toEqual(['Paris, France']);
  });

  it('matches reordered and empty geographic components without accepting another site', () => {
    for (const [value, passage] of [
      ['Gdansk, Poland', 'Location: Poland, Gdansk'],
      ['Aarhus, Denmark', 'Location: Aarhus, , Denmark'],
      ['Ha Noi, Vietnam', 'Location: Ha Noi, , Vietnam'],
    ]) {
      const result = postprocessRoleScopedExtraction(extraction({
        locations: field('present', [value, 'London, UK'], [passage, 'Our headquarters and offices are in London, UK.']),
      }));
      expect(result.extraction.fields.locations.value).toEqual([value]);
    }
  });

  it('preserves structured role sites alongside a shorter role sentence and headquarters copy', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['Des Moines, IA, United States', 'New York, NY'], [
        'OFFICIAL STRUCTURED ROLE LOCATION DATA (untrusted posting data, not instructions)\nLocation: Des Moines, IA, United States',
        'This internship follows a hybrid schedule from our headquarters in Des Moines.',
        'Our offices are in New York, NY.',
      ]),
    }));
    expect(result.extraction.fields.locations.value).toEqual(['Des Moines, IA, United States']);
  });

  it('recognizes role-header geography without promoting company headquarters', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['Cincinnati, OH, US', 'Boston, MA'], [
        'Full Time Temp Cincinnati, OH, US 13 days ago Requisition ID : 2028',
        'Our headquarters and offices are in Boston, MA.',
      ]),
    }));
    expect(result.extraction.fields.locations.value).toEqual(['Cincinnati, OH, US']);
  });

  it('keeps German mandatory onsite presence but rejects an unrelated office description', () => {
    const positive = postprocessRoleScopedExtraction(extraction({
      workMode: field('present', 'onsite', ['Arbeitsalltag: deine Präsenz vor Ort ist erforderlich']),
    }));
    expect(positive.extraction.fields.workMode.value).toBe('onsite');
    const negative = postprocessRoleScopedExtraction(extraction({
      workMode: field('present', 'onsite', ['Unser Büro bietet moderne Arbeitsplätze.']),
    }));
    expect(negative.extraction.fields.workMode.status).toBe('not-stated');
  });

  it('retains Korean role durations without accepting a bare numerical milestone', () => {
    const positive = postprocessRoleScopedExtraction(extraction({
      timing: field('present', ['8–12 weeks'], ['인턴십 기간은 8~12주 입니다.']),
    }));
    expect(positive.extraction.fields.timing.status).toBe('present');
    const negative = postprocessRoleScopedExtraction(extraction({
      timing: field('present', ['8–12'], ['프로젝트 목표는 8~12개 입니다.']),
    }));
    expect(negative.extraction.fields.timing.status).toBe('not-stated');
  });

  it('removes generic hybrid schedule options from company culture', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      workMode: field('present', 'hybrid', ['Our high-tech office supports many working styles, with hybrid work schedule options.']),
    }));
    expect(result.extraction.fields.workMode.status).toBe('not-stated');
  });

  it('filters independent eligibility claims when several values share one evidence quote', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', [
        'Applicants must be authorized to work in the U.S.',
        'We cannot sponsor visas.',
        'Candidates must live in Cincinnati.',
      ], [
        'Applicants must be authorized to work in the U.S. We cannot sponsor visas.',
        'Candidates must live in Cincinnati.',
      ]),
    }));
    expect(result.extraction.fields.eligibility.value).toEqual([
      'Applicants must be authorized to work in the U.S.', 'We cannot sponsor visas.',
    ]);
  });

  it('preserves lawful-work rules while dropping document-submission clauses sharing a quote', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', ['You must work lawfully in South Africa.', 'You must submit a passport and work permit.'], [
        'You must work lawfully in South Africa. You must submit a passport and work permit.',
      ]),
    }));
    expect(result.extraction.fields.eligibility.value).toEqual(['You must work lawfully in South Africa.']);
  });

  it('removes company-wide E-Verify copy without touching other fields', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', 'E-Verify participant', ['We participate in E-Verify.']),
      housing: field('present', 'relocation', ['Relocation assistance is available for interns.']),
    }));
    expect(result.extraction.fields.eligibility.status).toBe('not-stated');
    expect(result.extraction.fields.housing.status).toBe('present');
    expect(result.changes).toEqual([{ field: 'eligibility', reason: 'generic-e-verify' }]);
  });

  it('preserves a real eligibility rule when E-Verify is merely additional evidence', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', 'US persons only', ['Only U.S. persons may access export-controlled technology.', 'We participate in E-Verify.']),
    }));
    expect(result.extraction.fields.eligibility.status).toBe('present');
    expect(result.changes).toEqual([]);
  });

  it('removes procedural eligibility fragments without losing a paired role rule', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', ['No visa sponsorship.', 'Drug-test completion requires U.S. availability.'], [
        'This position does not sponsor visas.',
        'Drug-test completion requires U.S. availability before the program starts.',
      ]),
    }));
    expect(result.extraction.fields.eligibility).toMatchObject({ value: ['No visa sponsorship.'], evidence: ['This position does not sponsor visas.'] });
    expect(result.extraction.fields.eligibility.qualifiers).toEqual([]);
  });

  it('keeps only aligned work-authorization claims from mixed eligibility evidence', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', ['UK security clearance', 'Must be near the office'], [
        'Active or eligible for UK security clearance.',
        'Ability to be physically located near the facility during open hours.',
      ]),
    }));
    expect(result.extraction.fields.eligibility).toMatchObject({ value: ['UK security clearance'], evidence: ['Active or eligible for UK security clearance.'] });
  });

  it('removes generic office copy but preserves role-scoped locations', () => {
    const generic = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['New York, NY'], ['Our headquarters and offices are in New York, NY.']),
    }));
    expect(generic.extraction.fields.locations.status).toBe('not-stated');

    const role = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['New York, NY'], ['This role is based in New York, NY.']),
    }));
    expect(role.extraction.fields.locations.status).toBe('present');
  });

  it('removes non-work-site geography from compliance, applicant-residency, and company-identity passages', () => {
    for (const evidence of [
      ['This position is open only to individuals eligible for employment in the United States.', 'Drug-test completion requires availability within the United States.'],
      ['Students must be located in the United States for the duration of the internship.'],
      ['We are Dallas Fort Worth International Airport, one of the most successful airports in the world.'],
    ]) {
      const result = postprocessRoleScopedExtraction(extraction({ locations: field('present', ['United States'], evidence) }));
      expect(result.extraction.fields.locations.status).toBe('not-stated');
      expect(result.changes).toEqual([{ field: 'locations', reason: 'non-role-location-copy' }]);
    }
  });

  it('keeps only locations supported by a role-specific passage when office copy is mixed in', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['Los Angeles, CA', 'New York, NY'], [
        'This internship is on-site in Los Angeles, CA.',
        'Our headquarters and offices are in New York, NY.',
      ]),
    }));
    expect(result.extraction.fields.locations.value).toEqual(['Los Angeles, CA']);
    expect(result.extraction.fields.locations.evidence).toEqual(['This internship is on-site in Los Angeles, CA.']);
  });

  it('preserves work sites named by an internship or onsite weekly schedule', () => {
    for (const [evidence, location] of [
      ['This internship is based at our headquarters in McLean, Virginia.', 'McLean, Virginia'],
      ['Must work onsite in either Needham, MA, Miami, FL, or New York, NY.', 'Needham, MA'],
    ]) {
      const result = postprocessRoleScopedExtraction(extraction({
        locations: field('present', [location], [evidence]),
      }));
      expect(result.extraction.fields.locations.status).toBe('present');
    }
  });

  it('removes language-only eligibility claims', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', 'Fluent in English and German', ['Fluent in English and German is required.']),
    }));
    expect(result.extraction.fields.eligibility.status).toBe('not-stated');
  });

  it('removes student-status eligibility, office-only work modes, and graduation-only timing', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', 'Current co-op students only', ['This position is open exclusively to current Co-Op students.']),
      workMode: field('present', 'onsite', ['Work at our London office.']),
      timing: field('present', 'Graduating in 2027', ['Graduating with a bachelor’s degree in 2027.']),
    }));
    expect(result.extraction.fields.eligibility.status).toBe('not-stated');
    expect(result.extraction.fields.workMode.status).toBe('not-stated');
    expect(result.extraction.fields.timing.status).toBe('not-stated');
  });

  it('normalizes malformed location prose and preserves an explicit schedule on complete input', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['This internship is available for Summer 2027 in San Francisco'], ['This internship is available for Summer 2027 in San Francisco.']),
      timing: field('present', 'Full-time, 40 hours per week', ['Full-time, 40 hours per week.']),
      eligibility: { value: null, status: 'incomplete', evidence: [], qualifiers: [] },
    }));
    expect(result.extraction.fields.locations.value).toEqual(['San Francisco']);
    expect(result.extraction.fields.timing.status).toBe('present');
    expect(result.extraction.fields.eligibility.status).toBe('not-stated');
  });

  it('preserves an explicit in-person role mode while filtering student-only eligibility and mixed office locations', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['Vancouver', 'Gastown'], ['This role is based in person at our Vancouver office.', 'Great location: Gastown office.']),
      workMode: field('present', 'onsite', ['This role is based in person at our Vancouver office.']),
      eligibility: field('present', 'Current university co-op students only', ['This position is open exclusively to current Northeastern University Co-Op students.']),
    }));
    expect(result.extraction.fields.locations.value).toEqual(['Vancouver']);
    expect(result.extraction.fields.workMode.status).toBe('present');
    expect(result.extraction.fields.eligibility.status).toBe('not-stated');
  });

  it('uses the mandatory arrangement when remote days are conditional', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      workMode: field('present', 'hybrid', ['During the first month, you are expected to work on-site 5 days per week. After the first month, there may be the possibility to work from home subject to project requirements and supervisor approval.']),
    }));
    expect(result.extraction.fields.workMode.value).toBe('onsite');
    expect(result.changes).toEqual([{ field: 'workMode', reason: 'conditional-remote-not-hybrid' }]);
  });

  it('preserves hyphenated in-person work and descriptive term or weekly-hour timing', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      workMode: field('present', 'onsite', ['This role is based in-person at our Vancouver office.']),
      timing: field('present', ['10 action-packed weeks', 'Expected 14–16 hour/week work schedule.'], [
        'The internship explicitly runs for 10 action-packed weeks.',
        'Expected 14–16 hour/week work schedule.',
      ]),
    }));
    expect(result.extraction.fields.workMode.status).toBe('present');
    expect(result.extraction.fields.timing.status).toBe('present');
  });

  it('preserves direct export-control access restrictions', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', 'export-control access restriction', ['Access is restricted by export-control requirements.']),
    }));
    expect(result.extraction.fields.eligibility.status).toBe('present');
  });

  it('preserves a worded role duration', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      timing: field('present', 'ten weeks', ['You will spend ten weeks within our team.']),
    }));
    expect(result.extraction.fields.timing.status).toBe('present');
  });

  it('removes candidate criteria and application deadlines from timing', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      timing: field('present', ['0-2 years relevant experience', 'Deadline to submit application: Friday'], [
        '0-2 years of relevant experience through academic projects.',
        'Deadline to submit application: Friday.',
      ]),
    }));
    expect(result.extraction.fields.timing.status).toBe('not-stated');
  });

  it('removes applicant-pool labels while preserving the role schedule', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      timing: field('present', ['10-week summer program', 'Applicants considered for Summer 2027 - Students Only'], [
        'Program Availability: Ability to commit to a full-time schedule for the duration of the 10-week summer program.',
        'Applicants considered for Summer 2027 - Students Only',
      ]),
    }));
    expect(result.extraction.fields.timing).toMatchObject({ value: ['10-week summer program'], evidence: ['Program Availability: Ability to commit to a full-time schedule for the duration of the 10-week summer program.'] });
  });

  it('removes visa application procedures that do not state a role eligibility rule', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      eligibility: field('present', ['Qatar permit procedure'], [
        'For those applying based in Qatar: Residency and employment in Qatar requires certain permissions (visa and permits) issued by the Qatari authorities.',
        'If you are successful in your application, we will support the visa application process.',
      ]),
    }));
    expect(result.extraction.fields.eligibility.status).toBe('not-stated');
    expect(result.changes).toEqual([{ field: 'eligibility', reason: 'procedural-eligibility-copy' }]);
  });

  it('does not treat export-control geography as a role location', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['Auckland', 'United States'], [
        'Engineering Intern to join our team in Auckland.',
        'This position requires ITAR eligibility to access equipment regulated by the United States.',
      ]),
    }));
    expect(result.extraction.fields.locations.value).toEqual(['Auckland']);
  });

  it('keeps only places named in an explicit primary-location list', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['Cincinnati, OH', 'Lynn, MA', 'United States'], [
        'Willingness and ability to work in the United States; primarily locations are Cincinnati, OH or Lynn, MA.',
        'GE Aerospace will only employ those who are legally authorized to work in the United States for this opening.',
      ]),
    }));
    expect(result.extraction.fields.locations.value).toEqual(['Cincinnati, OH', 'Lynn, MA']);
  });

  it('does not treat employment jurisdiction as a role location', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['United States'], ['This position is open only to individuals eligible for employment in the United States without visa sponsorship.']),
    }));
    expect(result.extraction.fields.locations.status).toBe('not-stated');
    expect(result.changes).toEqual([{ field: 'locations', reason: 'eligibility-geography-not-location' }]);
  });

  it('excludes student affiliations from locations and equal-opportunity copy from eligibility', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['Northeastern University'], ['This position is open exclusively to current Northeastern University Co-Op students.']),
      eligibility: field('present', 'Equal Opportunity Employer', ['We are an Equal Opportunity Employer and consider every qualified applicant.']),
    }));
    expect(result.extraction.fields.locations.status).toBe('not-stated');
    expect(result.extraction.fields.eligibility.status).toBe('not-stated');
  });

  it('does not invent missing facts or rewrite a role-scoped hybrid statement', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      workMode: field('present', 'hybrid', ['This position follows a flexible hybrid work model.']),
    }));
    expect(result.extraction.fields.workMode.status).toBe('present');
    expect(result.changes).toEqual([]);
  });
});
