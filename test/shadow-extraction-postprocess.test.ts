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

  it('normalizes malformed location prose and rejects schedule or incomplete-field noise on complete input', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      locations: field('present', ['This internship is available for Summer 2027 in San Francisco'], ['This internship is available for Summer 2027 in San Francisco.']),
      timing: field('present', 'Full-time, 40 hours per week', ['Full-time, 40 hours per week.']),
      eligibility: { value: null, status: 'incomplete', evidence: [], qualifiers: [] },
    }));
    expect(result.extraction.fields.locations.value).toEqual(['San Francisco']);
    expect(result.extraction.fields.timing.status).toBe('not-stated');
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

  it('preserves a worded role duration', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      timing: field('present', 'ten weeks', ['You will spend ten weeks within our team.']),
    }));
    expect(result.extraction.fields.timing.status).toBe('present');
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

  it('does not invent missing facts or rewrite a role-scoped hybrid statement', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      workMode: field('present', 'hybrid', ['This position follows a flexible hybrid work model.']),
    }));
    expect(result.extraction.fields.workMode.status).toBe('present');
    expect(result.changes).toEqual([]);
  });
});
