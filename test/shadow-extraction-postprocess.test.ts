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

  it('does not invent missing facts or rewrite a role-scoped hybrid statement', () => {
    const result = postprocessRoleScopedExtraction(extraction({
      workMode: field('present', 'hybrid', ['This position follows a flexible hybrid work model.']),
    }));
    expect(result.extraction.fields.workMode.status).toBe('present');
    expect(result.changes).toEqual([]);
  });
});
