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
export type ShadowPostprocessReason = 'generic-e-verify' | 'statutory-wage-copy' | 'generic-hybrid-benefit' | 'generic-office-copy' | 'generic-language-requirement';

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
const roleLocation = /\b(?:this|the) (?:role|position|internship|job)\b|\bbased (?:at|in)\b|\bon[- ]site in\b/iu;
const languageOnly = /\b(?:fluent|proficien(?:cy|t)|speak|language)\b/iu;
const eligibilityTerms = /\b(?:work authorization|authorized to work|citizen(?:ship)?|permanent resident|visa|sponsor(?:ship)?|clearance|export[- ]controlled|itar)\b/iu;

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
    const passages = eligibility.evidence;
    if (passages.length > 0 && passages.every((passage) => genericEverify.test(passage))) clear('eligibility', 'generic-e-verify');
    else if (passages.length > 0 && passages.every((passage) => statutoryWage.test(passage))) clear('eligibility', 'statutory-wage-copy');
  }

  const workMode = fields.workMode;
  if (workMode.status === 'present') {
    const text = fieldText(workMode);
    if (genericHybridBenefit.test(text) && !roleScoped.test(text)) clear('workMode', 'generic-hybrid-benefit');
  }

  const locations = fields.locations;
  if (locations.status === 'present') {
    const genericPassages = locations.evidence.filter((passage) => genericOffice.test(passage));
    const rolePassages = locations.evidence.filter((passage) => roleLocation.test(passage));
    if (genericPassages.length > 0 && rolePassages.length === 0) clear('locations', 'generic-office-copy');
    else if (genericPassages.length > 0 && rolePassages.length > 0 && Array.isArray(locations.value)) {
      const roleText = rolePassages.join('\n').toLocaleLowerCase();
      const retained = locations.value.filter((value): value is string => typeof value === 'string' && roleText.includes(value.toLocaleLowerCase()));
      if (retained.length === 0) clear('locations', 'generic-office-copy');
      else fields.locations = { ...locations, value: retained, evidence: rolePassages };
    }
    if (fields.locations.status === 'present' && fields.locations.evidence.length > 0
      && fields.locations.evidence.every((passage) => genericEverify.test(passage))) clear('locations', 'generic-office-copy');
  }

  const languageEligibility = fields.eligibility;
  if (languageEligibility.status === 'present' && languageEligibility.evidence.length > 0
    && languageEligibility.evidence.every((passage) => languageOnly.test(passage) && !eligibilityTerms.test(passage))) {
    clear('eligibility', 'generic-language-requirement');
  }

  return { extraction: { ...extraction, fields }, changes };
}
