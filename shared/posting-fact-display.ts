import { compensationLabels, compensationOptions, type DisplayCompensation } from './compensation-display';
import { housingLabels, type DisplayHousingDetail } from './housing-display';
import { postingFactDetails, type PostingFact, type PostingFactField } from './posting-facts';

export interface RoleFactSummary {
  field: PostingFactField;
  label: string;
  tags: string[];
  details: string[];
  payOptions: string[];
  morePayOptions: boolean;
}

interface DisplayContext {
  compensation?: DisplayCompensation;
  housing?: readonly DisplayHousingDetail[];
}

const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
const conditional = /\b(?:if|when|may|might|eligible|depends?|depending|conditional|subject to|relocating|based on|unless|except|only|within)\b/iu;
const negative = /^(?:no\b|none\b|not provided\b)|\b(?:not (?:provided|available|offered)|unavailable)\b/iu;

function housingTags(statements: string[], qualifiers: string[]): string[] {
  const all = [...statements, ...qualifiers].join(' ');
  if (statements.every(text => negative.test(text)) && !conditional.test(all)) return ['None'];
  const labels = statements.flatMap(text => {
    // Keep each amount with its own benefit, never attach a relocation amount to a housing stipend.
    const amounts = [...text.matchAll(/(?:\b(?:USD|CAD|AUD|EUR|GBP)\s*|[$€£¥])\s*\d[\d,]*(?:\.\d{1,2})?(?:\s*[–-]\s*(?:(?:USD|CAD|AUD|EUR|GBP)\s*|[$€£¥])?\s*\d[\d,]*(?:\.\d{1,2})?)?/gu)]
      .map(match => `${/cost to you|employee.paid|rent you pay/iu.test(text) ? 'Cost ' : /up to\s*$/iu.test(text.slice(0, match.index)) ? 'Up to ' : ''}${match[0]}`);
    if (amounts.length) return amounts;
    if (negative.test(text)) return [conditional.test(text) ? 'Depends'
      : /relocation/iu.test(text) && !/housing/iu.test(text) ? 'No relocation' : 'No housing'];
    if (/stipend|allowance/iu.test(text)) return ['Stipend: amount unstated'];
    if (/relocation/iu.test(text)) return ['Relocation: no amount'];
    if (/provided|employer.paid|furnished|covered/iu.test(text)) return ['Provided'];
    if (/\bavailable\b/iu.test(text)) return ['Available'];
    return [conditional.test(text) ? 'Depends' : 'Details'];
  });
  return unique([...labels, ...(conditional.test(all) ? ['Depends'] : [])]);
}

function educationTag(text: string): string {
  const levels = [
    [/\b(?:undergrad(?:uate)?|bachelor|BS|BA|BSc)\b/iu, 'Undergrad'],
    [/\b(?:master|masters|MS|MSc|MBA)\b/iu, 'Master’s'],
    [/\b(?:PhD|Ph\.D\.?|doctoral|doctorate)\b/iu, 'PhD'],
    [/\bassociate/iu, 'Associate'], [/\bhigh school\b/iu, 'High school'],
    [/\bgraduate (?:degree|program|student)\b/iu, 'Grad'],
  ] as const;
  const labels = levels.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  if (labels.length) return `${labels.join(' / ')}${/\bprefer/iu.test(text) ? ' preferred' : ''}`;
  if (/\b(?:enrolled|enrollment|studying|student)\b/iu.test(text)) return 'Enrolled';
  if (/\brecent grad|graduated.*(?:year|month)/iu.test(text)) return 'Recent grad';
  if (/\bequivalent experience\b/iu.test(text)) return 'Equivalent exp.';
  return 'Requirements';
}

function eligibilityTags(text: string): string[] {
  const tags: string[] = [];
  if (/\b(?:no|not|cannot|unavailable|unable)\b.*\b(?:sponsor|visa)|\b(?:sponsor\w*|visa)\b.*\b(?:not|unavailable)\b/iu.test(text)) tags.push('No sponsorship');
  else if (/\bsponsor\w*\b/iu.test(text)) tags.push(conditional.test(text) ? 'Depends' : 'Sponsorship');
  if (/\bu\.?s\.?\s+person/iu.test(text)) tags.push('US person');
  if (/\b(?:authorized|authorised|authorization|authorisation|work lawfully|work permit|right to work)\b/iu.test(text)) tags.push('Work authorization');
  if (/\bclearance\b/iu.test(text)) {
    tags.push(/\bno\b.*\bclearance|\bclearance\b.*\bnot required\b/iu.test(text) ? 'No clearance'
      : /\beligib/iu.test(text) ? 'Clearance eligibility'
        : conditional.test(text) ? 'May need clearance' : /\brequir|\bmust|\bactive\b/iu.test(text) ? 'Clearance required' : 'Clearance');
  }
  if (conditional.test(text)) tags.push('Depends');
  return tags.length ? tags : ['Requirements'];
}

function timingTags(text: string): string[] {
  const tags: string[] = [];
  if (/\bfull.time\b/iu.test(text)) tags.push('Full-time');
  if (/\bpart.time\b/iu.test(text)) tags.push('Part-time');
  if (/\b(?:fixed.term|temporary)\b/iu.test(text)) tags.push('Fixed-term');
  const hours = text.match(/\b(\d+(?:[–-]\d+)?)\s*(?:hours?|hrs?)\s*(?:per|a|\/)\s*week/iu);
  if (hours) tags.push(`${hours[1]} hr/wk`);
  const duration = text.match(/\b(\d+)\s*[- ]?\s*(weeks?|months?)\b/iu);
  if (duration) tags.push(`${duration[1]} ${duration[2]}${/\bminimum|at least\b/iu.test(text) ? ' min.' : ''}`);
  // Use an already short, complete date fragment; never cut a sentence mid-condition.
  const date = text.split(/[;·]/u)[0]!.trim();
  if (/\b(?:Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*|Spring|Summer|Fall|Winter)\b/iu.test(date)) {
    tags.push(date.length <= 24 ? date : 'Term dates');
  }
  if (/\bdepend|\bvary|\bvaries/iu.test(text)) tags.push('Dates vary');
  return tags.length ? tags : [text.length <= 24 ? text : 'Dates & hours'];
}

/** Presentation only: captions may be terse because full claims expand in place. */
export function postingFactSummaries(facts: readonly PostingFact[] | undefined, context: DisplayContext = {}): RoleFactSummary[] {
  const input = [...(facts ?? [])];
  const fallback = (field: PostingFactField, statements: string[]) => {
    if (statements.length && !input.some(fact => fact.field === field)) input.push({ field, statements, qualifiers: [], sourceUrl: '', contentHash: '' });
  };
  fallback('compensation', compensationLabels(context.compensation));
  fallback('housing', housingLabels(context.housing).map(item => unique([item.label, item.detail]).join(' · ')));
  return postingFactDetails(input).map(fact => {
    const source = input.find(item => item.field === fact.field)!;
    const full = fact.tags;
    let tags: string[];
    let details = full;
    let payOptions: string[] = [];
    let morePayOptions = false;
    if (fact.field === 'compensation') {
      const typed = compensationOptions(context.compensation);
      const options = typed.length ? typed : source.statements.map(text => ({ label: text.length <= 24 ? text : 'Pay details', detail: text }));
      tags = options.length > 1 ? ['Pay varies'] : [options[0]?.label ?? 'Pay details'];
      payOptions = options.slice(0, 3).map(option => option.detail);
      morePayOptions = options.length > 3;
      details = unique(source.qualifiers);
    } else if (fact.field === 'housing') tags = housingTags(source.statements, source.qualifiers);
    else if (fact.field === 'education') tags = full.map(educationTag);
    else if (fact.field === 'eligibility') tags = full.flatMap(eligibilityTags);
    else if (fact.field === 'timing') tags = full.flatMap(timingTags);
    else if (fact.field === 'locations') {
      const sites = unique(source.statements);
      const cities = unique(sites.map(text => text.split(',')[0]!.trim())).slice(0, 2);
      tags = [...cities, ...(sites.length > cities.length ? [`+${sites.length - cities.length} more`] : [])];
    } else tags = source.statements;
    // Long or unfamiliar copy gets a neutral disclosure, never a truncated claim.
    tags = unique(tags.map(tag => tag.length <= 24 ? tag : 'Details'));
    if (tags.length > 3 && tags.includes('Depends')) tags = [...tags.filter(tag => tag !== 'Depends').slice(0, 2), 'Depends'];
    return { field: fact.field, label: fact.label, tags: tags.slice(0, 3), details, payOptions, morePayOptions };
  });
}
