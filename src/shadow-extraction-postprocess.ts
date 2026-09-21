import type { ShadowExtraction, ShadowField } from './shadow-extraction.js';

/**
 * A deliberately narrow, reversible experiment for role-scope false positives.
 *
 * The model already has the correct rule in its prompt.  These guards only
 * remove claims whose own evidence is categorically company-wide compliance or
 * office copy; they never manufacture a missing fact.  They are not wired to
 * publication: callers must compare the returned changes against a labelled
 * set before enabling any variant in the Worker.
 */
export type ShadowPostprocessReason = 'generic-e-verify' | 'statutory-wage-copy' | 'generic-hybrid-benefit' | 'generic-office-copy';

export interface ShadowPostprocessChange {
  field: keyof ShadowExtraction['fields'];
  reason: ShadowPostprocessReason;
}

export interface ShadowPostprocessResult {
  extraction: ShadowExtraction;
  changes: ShadowPostprocessChange[];
}

const roleScoped = /\b(?:this|the) (?:role|position|internship|job)\b|\byou (?:will|must|are required)\b/iu;
const genericOffice = /\b(?:headquartered|headquarters|offices? (?:in|across|around)|our locations?)\b/iu;
const genericEverify = /\be-?verify\b/iu;
const statutoryWage = /\b(?:minimum wage|wage notice|pay transparency)\b/iu;
const genericHybridBenefit = /\b(?:hybrid work model|flexible work model|work[- ]life)\b/iu;

function notStated(): ShadowField {
  return { value: null, status: 'not-stated', evidence: [], qualifiers: [] };
}

function fieldText(field: ShadowField): string {
  return field.evidence.join('\n');
}

/** Apply the named postprocessing variant to a validated extraction. */
export function postprocessRoleScopedExtraction(extraction: ShadowExtraction): ShadowPostprocessResult {
  const fields = { ...extraction.fields };
  const changes: ShadowPostprocessChange[] = [];
  const clear = (field: keyof ShadowExtraction['fields'], reason: ShadowPostprocessReason) => {
    fields[field] = notStated();
    changes.push({ field, reason });
  };

  const eligibility = fields.eligibility;
  if (eligibility.status === 'present') {
    const text = fieldText(eligibility);
    if (genericEverify.test(text)) clear('eligibility', 'generic-e-verify');
    else if (statutoryWage.test(text)) clear('eligibility', 'statutory-wage-copy');
  }

  const workMode = fields.workMode;
  if (workMode.status === 'present') {
    const text = fieldText(workMode);
    if (genericHybridBenefit.test(text) && !roleScoped.test(text)) clear('workMode', 'generic-hybrid-benefit');
  }

  const locations = fields.locations;
  if (locations.status === 'present') {
    const text = fieldText(locations);
    if (genericOffice.test(text) && !roleScoped.test(text)) clear('locations', 'generic-office-copy');
  }

  return { extraction: { ...extraction, fields }, changes };
}
