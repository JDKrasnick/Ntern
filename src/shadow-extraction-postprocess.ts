import type { ShadowExtraction, ShadowField } from './shadow-extraction.js';

/**
 * Conservative role-scope filtering for validated extraction fields.
 *
 * The model already has the correct rule in its prompt.  These guards only
 * remove claims whose own evidence is categorically company-wide compliance or
 * office copy; they never manufacture a missing fact. Changes must be evaluated
 * against source-derived labels before release.
 */
export type ShadowPostprocessReason = 'generic-e-verify' | 'statutory-wage-copy' | 'equal-opportunity-copy' | 'procedural-eligibility-copy' | 'generic-hybrid-benefit' | 'generic-office-copy' | 'eligibility-geography-not-location' | 'student-affiliation-not-location' | 'non-role-location-copy' | 'generic-language-requirement' | 'candidate-student-status' | 'candidate-graduation-date' | 'office-reference-not-mode' | 'conditional-remote-not-hybrid' | 'incomplete-on-complete-input' | 'non-temporal-schedule-copy';

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
const proceduralEligibility = /\b(?:e-?verify|drug[- ]?test|background[- ]?check|visa[- ]?(?:processing|application process)|visa application process|(?:application|applying)[^.\n]{0,120}\b(?:visa|permit|residen)|(?:(?:submit|attach)\b|(?:you|applicants?|candidates?)\s+(?:(?:must|should|are required to)\s+)?(?:provide|include)\b)[^.\n]{0,120}\b(?:passport|identity document|permit|visa|documentation))\b/iu;
const statutoryWage = /\b(?:minimum wage|wage notice|pay transparency)\b/iu;
const genericHybridBenefit = /\b(?:hybrid work model|hybrid work schedule options|flexible work model|work[- ]life)\b/iu;
const structuredRoleLocation = /^(?:OFFICIAL STRUCTURED ROLE LOCATION DATA[^\n]*\n)?Location:\s+\S/mu;
const roleLocationHeader = /\b(?:Full|Part)[- ]Time\s+(?:Temp\s+)?[^\n]{1,120}\bRequisition ID\s*:/iu;
const roleLocation = /\b(?:this|the) (?:role|position|internship|job)\b.*\b(?:in|at|based)\b|\b(?:interns?|internships?|co-?ops?|new grads?)\b.*\b(?:in|at|based)\b|\bbased(?: in person)? (?:at|in)\b|\bon[- ]?site in\b|\bavailable\b.*\bin\b|\b(?:primary|primarily|work)\s+locations?\s+(?:are|is|include)\b/iu;
const languageOnly = /\b(?:fluent|proficien(?:cy|t)|speak|language)\b/iu;
const eligibilityTerms = /\b(?:work authorization|authorized to work|work lawfully|eligible for employment|citizens?|citizenship|nationality|permanent resident|visa|sponsor(?:ship)?|clearance|export[- ]?control(?:led)?|itar|international traffic in arms|national defense authorization act|ndaa)\b/iu;
const studentStatus = /\b(?:current(?:ly)?|enrolled)\b[^.\n]{0,80}\b(?:student|co-?op)\b|\bstudents? only\b/iu;
const applicantResidence = /\b(?:applicants?|candidates?|students?)\b[^.\n]{0,80}\b(?:must|need to|are required to|should)\b[^.\n]{0,80}\b(?:live|reside|be located|available)\b/iu;
const companyIdentity = /\b(?:we|the company|our organization)\s+(?:are|is)\b|\babout (?:us|the company)\b/iu;
const candidateAffiliation = /\b(?:student|recent graduate|degree|school|university|co-?op)\b/iu;
const equalOpportunity = /\b(?:equal employment opportunity|equal opportunity employer)\b/iu;
const graduationDate = /\bgraduat(?:e|ing|ion date)\b/iu;
const explicitMode = /\b(?:remote|hybrid|on[- ]?site|in[- ]?office|in[- ]person)\b|\bin the office \d+ days?\b/iu;
const explicitLocalizedOnsite = /\b(?:präsenz vor ort|anwesenheit vor ort)\b[^.\n]{0,60}\b(?:erforderlich|verpflichtend)\b/iu;
const mandatoryOnsite = /\b(?:must|expected|required)\b[^.\n]{0,100}\b(?:on[- ]?site|in[- ]?office|in the office)\b/iu;
const conditionalRemote = /\b(?:may|possible|subject to|discretionary|approval|approved)\b[^.\n]{0,120}\b(?:remote|from home|work from home)\b/iu;
const primaryLocationList = /\b(?:primary|primarily|work)\s+locations?\s+(?:are|is|include)\s+([^.\n]+)/iu;
const roleTimingSignal = /\b(?:\d+\s*[-–]?\s*|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+)(?:(?:[a-z]+(?:-[a-z]+){1,2})\s+)?(?:weeks?|months?)\b|\b(?:full|part)[- ]?time\b|\b\d+\s*(?:[-–]\s*\d+\s*)?hours?\s*(?:\/|per|a)\s*week\b|\b(?:spring|summer|fall|autumn|winter|january|february|march|april|may|june|july|august|september|october|november|december|start(?:ing)?|end(?:ing)?|duration|until|through)\b/iu;
const localizedRoleDuration = /(?:인턴십|실습)\s*기간[^.\n]{0,40}\d+\s*(?:[~〜–—-]\s*\d+\s*)?(?:주|개월)|\b(?:dauer|durée|duración|duração)\s*:?\s*\d+\s*(?:[–—-]\s*\d+\s*)?(?:wochen?|monate?|mois|semaines?|meses|semanas)\b/iu;
const locationInPassage = /\bin\s+([A-Z][a-z]+(?:[ -][A-Z][a-z]+){0,3})(?=$|[.,;:])/gu;

function notStated(): ShadowField {
  return { value: null, status: 'not-stated', evidence: [], qualifiers: [] };
}

function fieldText(field: ShadowField): string {
  return field.evidence.join('\n');
}

function containsLocation(passage: string, location: string): boolean {
  const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = ` ${fold(passage)} `;
  if (words.includes(` ${fold(location)} `)) return true;
  const components = location.split(',').map(fold).filter(Boolean);
  // Only an individual structured location label can reorder components. Do
  // not assemble a city and country from different sites or prose passages.
  return components.length > 0 && passage.split('\n').filter((line) => /^Location:\s+/u.test(line))
    .some((line) => {
      const label = ` ${fold(line.replace(/^Location:\s+/u, ''))} `;
      return components.every((component) => label.includes(` ${component} `));
    });
}

/** Apply the named postprocessing variant to a validated extraction. */
export function postprocessRoleScopedExtraction(extraction: ShadowExtraction, inputCompleteness: 'complete' | 'incomplete' = 'complete'): ShadowPostprocessResult {
  const fields = { ...extraction.fields };
  const changes: ShadowPostprocessChange[] = [];
  const clear = (field: keyof ShadowExtraction['fields'], reason: ShadowPostprocessReason) => {
    fields[field] = notStated();
    changes.push({ field, reason });
  };

  if (inputCompleteness === 'complete') {
    for (const field of Object.keys(fields) as Array<keyof ShadowExtraction['fields']>) {
      if (fields[field].status === 'incomplete') clear(field, 'incomplete-on-complete-input');
    }
  }

  const eligibility = fields.eligibility;
  if (eligibility.status === 'present') {
    const passages = eligibility.evidence;
    if (passages.length > 0 && passages.every((passage) => genericEverify.test(passage))) clear('eligibility', 'generic-e-verify');
    else if (passages.length > 0 && passages.every((passage) => statutoryWage.test(passage))) clear('eligibility', 'statutory-wage-copy');
    else if (passages.length > 0 && passages.every((passage) => equalOpportunity.test(passage))) clear('eligibility', 'equal-opportunity-copy');
    else if (Array.isArray(eligibility.value)) {
      // Values and quotes are independent lists: one quote can support several
      // claims, and one claim can cite several quotes. Do not pair by index.
      const retainedValues = eligibility.value.filter((value) => typeof value === 'string'
        && eligibilityTerms.test(value) && !proceduralEligibility.test(value));
      const retainedPassages = passages.filter((passage) => eligibilityTerms.test(passage));
      if (retainedValues.length === 0 || retainedPassages.length === 0) clear('eligibility', 'procedural-eligibility-copy');
      else if (retainedValues.length !== eligibility.value.length) fields.eligibility = { ...eligibility, value: retainedValues, evidence: retainedPassages, qualifiers: [] };
    } else if (passages.length > 0 && passages.every((passage) => proceduralEligibility.test(passage))) clear('eligibility', 'procedural-eligibility-copy');
  }

  const workMode = fields.workMode;
  if (workMode.status === 'present') {
    const text = fieldText(workMode);
    if (genericHybridBenefit.test(text) && !roleScoped.test(text)) clear('workMode', 'generic-hybrid-benefit');
    else if (workMode.value === 'hybrid' && mandatoryOnsite.test(text) && conditionalRemote.test(text)) {
      fields.workMode = { ...workMode, value: 'onsite', qualifiers: [] };
      changes.push({ field: 'workMode', reason: 'conditional-remote-not-hybrid' });
    }
  }

  const locations = fields.locations;
  if (locations.status === 'present') {
    const genericPassages = locations.evidence.filter((passage) => genericOffice.test(passage));
    const rolePassages = locations.evidence.filter((passage) => (roleLocation.test(passage)
      || structuredRoleLocation.test(passage) || roleLocationHeader.test(passage)) && !eligibilityTerms.test(passage));
    if (rolePassages.length > 0 && Array.isArray(locations.value)) {
      const labelledLists = rolePassages.map((passage) => primaryLocationList.exec(passage)?.[1]).filter((value): value is string => Boolean(value));
      const retained = locations.value.flatMap((value): string[] => {
        if (typeof value !== 'string') return [];
        const proseValue = /\b(?:available|spring|summer|fall|autumn|winter|intern|full[- ]time|part[- ]time)\b/iu.test(value);
        if (value.length <= 60 && !proseValue) {
          return rolePassages.some((passage) => containsLocation(passage, value))
            && (labelledLists.length === 0 || labelledLists.some((list) => containsLocation(list, value))) ? [value] : [];
        }
        return [...value.matchAll(locationInPassage)].map((match) => match[1]);
      });
      if (retained.length === 0) clear('locations', 'generic-office-copy');
      else fields.locations = { ...locations, value: retained, evidence: rolePassages };
    } else if (genericPassages.length > 0) clear('locations', 'generic-office-copy');
    else if (locations.evidence.length > 0 && locations.evidence.every((passage) => eligibilityTerms.test(passage))) clear('locations', 'eligibility-geography-not-location');
    else if (locations.evidence.length > 0 && locations.evidence.every((passage) => studentStatus.test(passage))) clear('locations', 'student-affiliation-not-location');
    else if (locations.evidence.length > 0 && locations.evidence.every((passage) => eligibilityTerms.test(passage)
      || proceduralEligibility.test(passage) || applicantResidence.test(passage) || companyIdentity.test(passage))) clear('locations', 'non-role-location-copy');
    if (fields.locations.status === 'present' && fields.locations.evidence.length > 0
      && fields.locations.evidence.every((passage) => genericEverify.test(passage))) clear('locations', 'generic-office-copy');
  }

  const languageEligibility = fields.eligibility;
  if (languageEligibility.status === 'present' && languageEligibility.evidence.length > 0
    && languageEligibility.evidence.every((passage) => languageOnly.test(passage) && !eligibilityTerms.test(passage))) {
    clear('eligibility', 'generic-language-requirement');
  }

  const studentEligibility = fields.eligibility;
  if (studentEligibility.status === 'present' && studentEligibility.evidence.length > 0
    && studentEligibility.evidence.every((passage) => (studentStatus.test(passage) || candidateAffiliation.test(passage)) && !eligibilityTerms.test(passage))) {
    clear('eligibility', 'candidate-student-status');
  }

  const mode = fields.workMode;
  if (mode.status === 'present' && mode.evidence.length > 0 && mode.evidence.every((passage) => !explicitMode.test(passage)
    && !(mode.value === 'onsite' && explicitLocalizedOnsite.test(passage)))) {
    clear('workMode', 'office-reference-not-mode');
  }

  const timing = fields.timing;
  if (timing.status === 'present' && timing.evidence.length > 0) {
    const isRoleTiming = (passage: string) => !graduationDate.test(passage)
      && !/\b(?:application.*deadline|deadline.*application|posting.*open|applications? (?:will|are).*accepted)\b/iu.test(passage)
      && !/\b(?:relevant experience|pursuing .*degree|returning to school|academic projects?|future full[- ]time employment|completion of .*study|continued enrollment|applicants? considered|students? only)\b/iu.test(passage);
    const roleTiming = timing.evidence.filter(isRoleTiming);
    if (roleTiming.length === 0) clear('timing', 'candidate-graduation-date');
    else if (roleTiming.length !== timing.evidence.length) {
      const value = Array.isArray(timing.value) && timing.value.length === timing.evidence.length
        ? timing.value.filter((_, index) => isRoleTiming(timing.evidence[index]!)) : timing.value;
      fields.timing = { ...timing, value, evidence: roleTiming, qualifiers: [] };
    }
    const remaining = fields.timing;
    if (remaining.status === 'present' && remaining.evidence.length > 0
      && remaining.evidence.every((passage) => !roleTimingSignal.test(passage) && !localizedRoleDuration.test(passage))) {
      clear('timing', 'non-temporal-schedule-copy');
    }
  }

  return { extraction: { ...extraction, fields }, changes };
}
