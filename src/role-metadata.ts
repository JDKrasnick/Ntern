import { createHash } from 'node:crypto';
import { compensationLabels } from '../shared/compensation-display.js';
import { metadataDescriptionText } from './core/metadata-text.js';
import { boundedText, locationSummary, normalizeLocations } from './catalog-quality.js';
import { educationAudienceLevels, mergeEducationEvidence, mergeProvenance } from './identity/enrichment.js';
import type {
  ApplicationDeadline,
  Compensation,
  CompensationPeriod,
  CompensationRange,
  EducationAudience,
  EducationLevel,
  EvidenceSource,
  FieldProvenance,
  GraduationDateWindow,
  Internship,
  InternshipIdentity,
  InternshipLocation,
  MetadataConflict,
  MinimumDegree,
  ProvenancedValue,
  ReconciledRoleMetadata,
  RoleMetadataEvidence,
  RoleMetadataField,
  WorkMode,
  HousingDetail,
} from './types.js';

// Increment whenever a parser change can produce a different result from an
// unchanged artifact. This makes the collection scheduler revisit both a
// previous negative result and an already-enriched posting.
export const ROLE_METADATA_EXTRACTION_VERSION = 17;
export const VERIFIED_PAGE_METADATA_SOURCES = ['official-json-ld', 'official-page'] as const;
const SOURCE_PRIORITY: Record<EvidenceSource, number> = {
  // Exact-role detail retrieval owns its own slot; a later board-list poll
  // must not erase fields the list endpoint omits.
  'official-api': -1,
  'official-ats': 0,
  'official-json-ld': 1,
  'official-page': 2,
  // A publication receipt binds this to the exact official description. It can
  // fill omissions in an ATS response, while direct page evidence still wins.
  'reviewed-shadow': 2.5,
  'reviewed-community': 3,
  'deterministic-inference': 4,
};

export interface RoleMetadataArtifact {
  title: string;
  text?: string;
  compensationText?: string;
  compensationSections?: Array<{ label: string; text: string }>;
  compensationBands?: Array<{ minAmount: number; maxAmount: number; currency: string; period?: CompensationPeriod; label?: string; sourceText: string }>;
  locations?: string[];
  workMode?: string;
  publishedAt?: string;
  updatedAt?: string;
  deadline?: string;
  deadlineTimezone?: string;
}

export interface ApplicationMetadataArtifact extends RoleMetadataArtifact {
  identifier?: string;
  inspectionTruncated?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function jsonLdTypes(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((item) => typeof item === 'string' ? [item.toLowerCase()] : []);
}

function jsonLdJobs(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) { value.forEach((item) => jsonLdJobs(item, output)); return; }
  if (!record(value)) return;
  if (jsonLdTypes(value['@type']).includes('jobposting')) output.push(value);
  if (value['@graph']) jsonLdJobs(value['@graph'], output);
}

function jsonLdIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || undefined;
  if (!record(value)) return undefined;
  const id = typeof value.value === 'string' || typeof value.value === 'number' ? String(value.value).trim() : '';
  return id || stringValue(value['@id']);
}

function postingIdentifierMatches(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  const normalizedExpected = decode(expected).trim().toLowerCase();
  const normalizedActual = decode(actual).trim().toLowerCase();
  if (normalizedActual === normalizedExpected) return true;
  try {
    const url = new URL(actual);
    return url.pathname.split('/').filter(Boolean).some((part) => decode(part).toLowerCase() === normalizedExpected)
      || [...url.searchParams.values()].some((value) => value.toLowerCase() === normalizedExpected)
      || decode(url.hash.replace(/^#/u, '')).toLowerCase() === normalizedExpected;
  } catch {
    return normalizedActual.split(/[:/#?&=]+/u).some((part) => part === normalizedExpected);
  }
}

function jsonLdLocations(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdLocations);
  if (!record(value)) return [];
  const name = stringValue(value.name);
  const address = record(value.address) ? value.address : undefined;
  const parts = address ? [address.addressLocality, address.addressRegion, address.addressCountry].map(stringValue).filter((item): item is string => Boolean(item)) : [];
  return name ? [name] : parts.length ? [parts.join(', ')] : [];
}

function jsonLdCompensation(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const currency = stringValue(value.currency) ?? 'XXX';
  const amountValue = record(value.value) ? value.value : value;
  const min = typeof amountValue.minValue === 'number' ? amountValue.minValue : typeof amountValue.value === 'number' ? amountValue.value : undefined;
  const max = typeof amountValue.maxValue === 'number' ? amountValue.maxValue : min;
  const unit = stringValue(amountValue.unitText);
  return min !== undefined && max !== undefined ? `Salary: ${currency} ${min}${min === max ? '' : ` - ${max}`}${unit ? ` per ${unit}` : ''}` : undefined;
}

/** Parses transient JSON-LD into bounded role artifacts; callers persist only extracted evidence. */
export function applicationMetadataArtifactsFromJsonDocuments(documents: readonly string[]): ApplicationMetadataArtifact[] {
  const rows: Record<string, unknown>[] = [];
  for (const document of documents) {
    try { jsonLdJobs(JSON.parse(document), rows); } catch { /* Malformed publisher blocks are non-fatal. */ }
  }
  return rows.flatMap((row) => {
    const title = stringValue(row.title);
    if (!title) return [];
    const remote = stringValue(row.jobLocationType);
    const locations = [...jsonLdLocations(row.jobLocation), ...(remote?.toUpperCase() === 'TELECOMMUTE' ? ['Remote'] : [])];
    return [{
      title,
      ...(jsonLdIdentifier(row.identifier) ? { identifier: jsonLdIdentifier(row.identifier) } : {}),
      ...(stringValue(row.description) ? { text: metadataDescriptionText(stringValue(row.description)!).slice(0, 40_000),
        ...(stringValue(row.description)!.length > 40_000 ? { inspectionTruncated: true } : {}) } : {}),
      ...(locations.length ? { locations } : {}),
      ...(remote ? { workMode: remote } : {}),
      ...(jsonLdCompensation(row.baseSalary) ? { compensationText: jsonLdCompensation(row.baseSalary) } : {}),
      ...(stringValue(row.datePosted) ? { publishedAt: stringValue(row.datePosted) } : {}),
      ...(stringValue(row.dateModified) ? { updatedAt: stringValue(row.dateModified) } : {}),
      ...(stringValue(row.validThrough) ? { deadline: stringValue(row.validThrough) } : {}),
    } satisfies ApplicationMetadataArtifact];
  });
}

function titleAgreement(expected: string, actual: string): boolean {
  const ignored = new Set(['intern', 'internship', 'summer', 'fall', 'winter', 'spring', 'new', 'grad', 'the', 'and', 'of', 'at', 'in']);
  const terms = (value: string) => [...new Set(value.toLowerCase().replace(/[^a-z0-9+#]+/gu, ' ').split(' ').filter((term) => term.length > 1 && !ignored.has(term)))];
  const expectedTerms = terms(expected); const actualTerms = new Set(terms(actual));
  return expectedTerms.length === 0 || expectedTerms.filter((term) => actualTerms.has(term)).length / expectedTerms.length >= 0.5;
}

export function extractVerifiedPageMetadataEvidence(input: {
  expectedTitle: string;
  expectedPostingId?: string;
  page: RoleMetadataArtifact;
  jsonLdArtifacts?: readonly ApplicationMetadataArtifact[];
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
  exactPosting: boolean;
}): RoleMetadataEvidence[] {
  if (!input.exactPosting) return [];
  const expectedId = input.expectedPostingId?.toLowerCase();
  const artifacts = input.jsonLdArtifacts ?? [];
  const matching = artifacts.filter((artifact) => titleAgreement(input.expectedTitle, artifact.title)
    && (expectedId && artifact.identifier
      ? postingIdentifierMatches(expectedId, artifact.identifier)
      : artifacts.length === 1));
  const selected = matching.length === 1 ? matching[0] : !expectedId && artifacts.length === 1 && titleAgreement(input.expectedTitle, artifacts[0]!.title) ? artifacts[0] : undefined;
  const jsonLd = selected ? extractPostingMetadataEvidence({ artifact: selected, sourceClass: 'official-json-ld', sourceId: input.sourceId,
    sourceUrl: input.sourceUrl, observedAt: input.observedAt, exactPosting: true }) : [];
  const pageAgrees = titleAgreement(input.expectedTitle, `${input.page.title} ${input.page.text ?? ''}`);
  if (!pageAgrees && !selected) return [];
  const page = pageAgrees ? extractPostingMetadataEvidence({ artifact: input.page, sourceClass: 'official-page', sourceId: input.sourceId,
    sourceUrl: input.sourceUrl, observedAt: input.observedAt, exactPosting: true }) : [];
  return mergeRoleMetadataEvidence(jsonLd, page);
}

export interface ExtractRoleMetadataInput {
  artifact: RoleMetadataArtifact;
  sourceClass: EvidenceSource;
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
  exactPosting: boolean;
  artifactHash?: string;
  titleOnly?: boolean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function roleMetadataArtifactHash(artifact: RoleMetadataArtifact): string {
  return createHash('sha256').update(stable(artifact)).digest('hex');
}

/** Re-observing identical evidence keeps a review; any content/version change expires it. */
export function roleMetadataReviewFingerprint(evidence: readonly RoleMetadataEvidence[]): string {
  const withoutObservation = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutObservation)
    : record(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'observedAt').map(([key, child]) => [key, withoutObservation(child)])) : value;
  return createHash('sha256').update(stable({ extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
    evidence: evidence.filter(item => item.extractionVersion === ROLE_METADATA_EXTRACTION_VERSION && item.exactPosting)
      .map(item => stable(withoutObservation(item))).sort() })).digest('hex');
}

function provenance(input: ExtractRoleMetadataInput, artifactHash: string, evidenceCode: string): FieldProvenance {
  return {
    source: input.sourceClass,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    evidenceCode,
    contentHash: artifactHash,
    observedAt: input.observedAt,
  };
}

function minimumDegree(value: string): MinimumDegree | undefined {
  const clauses = value.split(/(?<=[.!?;])\s+|\n+/u).filter(clause =>
    !/\b(?:not required|no\s+(?:[\w’'-]+\s+){0,3}degree\s+(?:is\s+)?required)\b/iu.test(clause));
  // An OR-list states alternatives, not that its highest degree is mandatory.
  const degreeNames = String.raw`associate(?:['’]s|s)?|bachelor(?:['’]s|s)?|master(?:['’]s|s)?|Ph\.?D\.?|doctorate|doctoral`;
  for (const clause of clauses) {
    const alternatives = new RegExp(String.raw`\b(${degreeNames})(?:\s+degree)?\s+(?:or|and/or)\s+(${degreeNames})(?:\s+degree)?`, 'iu').exec(clause);
    if (!alternatives) continue;
    const before = clause.slice(0, alternatives.index);
    const after = clause.slice(alternatives.index + alternatives[0].length);
    if (!/^\s+(?:is\s+|are\s+)?required\b/iu.test(after)
      && !/\bmust (?:have|hold|possess)\s+(?:an?\s+)?$/iu.test(before)) continue;
    const choices = alternatives.slice(1).map(name => /^associate/iu.test(name) ? 'associates' as const
      : /^bachelor/iu.test(name) ? 'bachelors' as const : /^master/iu.test(name) ? 'masters' as const : 'doctoral' as const);
    return (['associates', 'bachelors', 'masters', 'doctoral'] as const).find(degree => choices.includes(degree));
  }
  value = clauses.join(' ');
  const required = (degree: string) => new RegExp(
    `(?:\\b${degree}(?: degree)?\\s+(?:is\\s+)?required\\b|\\bmust\\s+(?:have|hold|possess)\\s+(?:an?\\s+)?${degree}(?: degree)?\\b|\\bminimum(?: education| degree)?[^.;]{0,30}\\b${degree}\\b)`,
    'iu',
  ).test(value);
  if (required('(?:ph\\.?d\\.?|doctoral?|doctorate)')) return 'doctoral';
  if (required("master(?:['’]s|s)?")) return 'masters';
  if (required("bachelor(?:['’]s|s)?")) return 'bachelors';
  if (required("associate(?:['’]s|s)?")) return 'associates';
  if (/\bhigh school diploma\s+(?:is\s+)?required\b|\bminimum[^.;]{0,30}\bhigh school\b/iu.test(value)) return 'high-school';
  return undefined;
}

// A pay row is a label, not prose: "Masters $50/hour" states its own audience in
// two words, so the clause and preference rules that govern descriptions do not
// apply here.
function payTierEducationLevels(segment: string): EducationLevel[] {
  const levels: EducationLevel[] = [];
  if (/\b(?:undergrad(?:uate)?s?|bachelor(?:['’]s|s)?|college student|university student)\b/iu.test(segment)) levels.push('undergraduate');
  if (/\b(?:master['’]s|masters|graduate student)\b/iu.test(segment) || /(?<![\w.])(?:MSc|MS|M\.S\.|MA|M\.A\.)(?![\w.])/u.test(segment)) levels.push('masters');
  if (/\bm\.?b\.?a\.?s?\b/iu.test(segment)) levels.push('mba');
  if (/\b(?:ph\.?\s?d\.?(?!\w)|doctorate|doctoral|doctorates)\b/iu.test(segment)) levels.push('doctoral');
  return levels;
}

const MONTH: Record<string, string> = {
  january: '01', jan: '01', february: '02', feb: '02', march: '03', mar: '03', april: '04', apr: '04',
  may: '05', june: '06', jun: '06', july: '07', jul: '07', august: '08', aug: '08', september: '09', sep: '09', sept: '09',
  october: '10', oct: '10', november: '11', nov: '11', december: '12', dec: '12',
};

function graduationWindow(value: string): GraduationDateWindow | undefined {
  // Keep graduation dates inside their own clause. "Graduate students" is an
  // audience, not a graduation event; nearby application/start dates are not
  // evidence of a graduation window.
  const marker = /\b(?:graduat(?:es|ed|ing|ion)|graduate(?!\s+(?:students?|school|degree|program|intern|level)\b)|class of|degree completion)\b/iu;
  const context = value.split(/(?<=[.!?;])\s+|\n+/u)
    .map(clause => clause.split(/\b(?:applications? (?:close|deadline)|apply by|(?:internship|program) (?:starts?|begins?))\b/iu)[0] ?? '')
    .filter(clause => marker.test(clause)).map(clause => clause.slice(0, 400)).join(' ');
  if (!context) return undefined;
  const dates = [
    ...[...context.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(20\d{2})\b/giu)]
      .map((match) => `${match[2]}-${MONTH[match[1]!.toLowerCase()]}`),
    ...[...context.matchAll(/\b(Winter|Spring|Summer|Fall|Autumn)\s+(20\d{2})\b/giu)]
      .map((match) => `${match[2]}-${({ winter: '01', spring: '05', summer: '08', fall: '12', autumn: '12' } as const)[match[1]!.toLowerCase() as 'winter' | 'spring' | 'summer' | 'fall' | 'autumn']}`),
  ].sort();
  if (dates.length) return { start: dates[0], end: dates[dates.length - 1] };
  const years = [...context.matchAll(/\b20\d{2}\b/gu)].map((match) => match[0]).sort();
  if (years.length >= 2) return { start: `${years[0]}-01`, end: `${years[years.length - 1]}-12` };
  if (years.length === 1) return { start: `${years[0]}-01`, end: `${years[0]}-12` };
  return undefined;
}

function explicitWorkMode(value: string | undefined): Exclude<WorkMode, 'unspecified'> | undefined {
  if (!value) return undefined;
  if (/\bhybrid\b/iu.test(value)) return 'hybrid';
  if (/\b(?:remote|telecommute|work from home)\b/iu.test(value)) return 'remote';
  if (/\b(?:on[ -]?site|in[ -]?person)\b/iu.test(value)) return 'onsite';
  return undefined;
}

function titleWorkMode(value: string): Exclude<WorkMode, 'unspecified'> | undefined {
  // Technical topics such as "Remote Sensing" and "Hybrid Systems" are not
  // workplace promises. Title-only evidence needs a separate mode qualifier.
  const qualifier = /(?:^|[-–—|]|\()\s*(?:fully\s+)?(remote|hybrid|on[ -]?site|in[ -]?person)\s*(?:$|\)|[-–—|])/iu.exec(value)?.[1];
  return explicitWorkMode(qualifier);
}

function amount(value: string, suffix?: string): number {
  const parsed = Number(value.replace(/,/gu, ''));
  return suffix?.toLowerCase() === 'k' ? parsed * 1_000 : parsed;
}

const CURRENCY_SYMBOL: Record<string, string> = { '€': 'EUR', '£': 'GBP' };
const PERIOD = String.raw`hour|hourly|hr|day|daily|week|weekly|month|monthly|year|yearly|yr|annum|annual(?:ly|ized)?|biweekly|bi-weekly|semimonthly|semi-monthly|bimonthly|fortnightly|one-time`;
const MONEY_AMOUNT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const CURRENCY_CODE = String.raw`USD|CAD|AUD|NZD|SGD|HKD|EUR|GBP|JPY|CNY|INR|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BRL|MXN|ARS|CLP|COP|KRW|TWD|IDR|MYR|PHP|THB|VND|ILS|AED|SAR|ZAR|TRY|XXX`;
const PAY = new RegExp(String.raw`(?:(${CURRENCY_CODE})\s*)?([$€£])?\s*(${MONEY_AMOUNT})\s*([kK])?\s*(?:(?:-|–|—|to)\s*(?:(${CURRENCY_CODE})\s*)?[$€£]?\s*(${MONEY_AMOUNT})\s*([kK])?)?\s*(?:\/\s*)?(?:per\s+)?\(?\s*(${PERIOD})(?:\b|$)`, 'giu');
const SPLIT_PERIOD_PAY = new RegExp(String.raw`(?:(${CURRENCY_CODE})\s*)?([$€£])?\s*(${MONEY_AMOUNT})\s*([kK])?\s*(?:\/|per\s+)(${PERIOD})\s*(?:-|–|—|to)\s*(?:(${CURRENCY_CODE})\s*)?[$€£]?\s*(${MONEY_AMOUNT})\s*([kK])?\s*(?:\/|per\s+)(${PERIOD})(?:\b|$)`, 'giu');
const USD_TEXT_PAY = new RegExp(String.raw`\b(USD)\s+(${MONEY_AMOUNT})\s*([kK])?\s*(?:(?:-|–|—|to)\s*(${MONEY_AMOUNT})\s*([kK])?)?\s*(?:\/|per\s+)?(${PERIOD})(?:\b|$)`, 'giu');
// Some ATS templates place the currency after a range and before its period.
// Keep this separate from PAY so its capture groups remain easy to audit.
const BETWEEN_RANGE_AND_PERIOD_CURRENCY_PAY = new RegExp(String.raw`([$€£])\s*(${MONEY_AMOUNT})\s*([kK])?\s*(?:-|–|—|to)\s*[$€£]?\s*(${MONEY_AMOUNT})\s*([kK])?\s*(${CURRENCY_CODE})\s*(?:\/\s*)?(?:per\s+)?(${PERIOD})(?:\b|$)`, 'giu');
// Publishers often state the period in the label, not after the amounts.
// Keep that label in the same clause and require explicit pay terminology.
const LABELED_PAY = new RegExp(String.raw`\b(hourly|annual(?:ized)?|yearly|daily|weekly|monthly)\s+(?:(?:base|estimated|starting)\s+)?(?:pay|salary|wage|rate|compensation)(?:\s+range)?[^.;$€£\d]{0,100}?(?:(${CURRENCY_CODE})\s*)?([$€£])\s*(${MONEY_AMOUNT})\s*([kK])?\s*(?:(?:-|–|—|to)\s*[$€£]?\s*(${MONEY_AMOUNT})\s*([kK])?)?(?:\s*\(?(${CURRENCY_CODE})\b\)?)?`, 'giu');

function compensationPeriod(value: string): CompensationPeriod {
  if (value === 'unknown') return 'unknown';
  if (/^(?:hour|hourly|hr)$/iu.test(value)) return 'hourly';
  if (/^(?:year|yearly|yr|annum|annual(?:ly|ized)?)$/iu.test(value)) return 'annual';
  if (/^(?:day|daily)$/iu.test(value)) return 'daily';
  if (/^(?:week|weekly)$/iu.test(value)) return 'weekly';
  if (/^(?:month|monthly)$/iu.test(value)) return 'monthly';
  return 'other';
}

// A standalone school-year/degree row or city/state table cell is explicit
// scope. Do not shorten richer labels (e.g. "PhD students") or interpret
// "Senior Software Engineer" as a school-year tier.
const EDUCATION_PAY_ROW = /^(freshman|sophomore|junior|senior|masters?|ph\.?d\.?)\s*(?=[$€£]\s*\d)/iu;
const LOCATION_PAY_ROW = /^([A-Z][A-Za-z .'-]{1,60},\s+[A-Z][A-Za-z .'-]{1,60})\s*\|\s*\(?\s*(?=(?:[A-Z]{3}\s*)?[$€£]\s*\d)/u;

function applicability(segment: string, knownLocations: readonly string[]): Pick<CompensationRange, 'applicableLocations' | 'applicableEducationLevels' | 'applicabilityLabel'> {
  const explicitLocation = LOCATION_PAY_ROW.exec(segment)?.[1]?.trim();
  const locations = knownLocations.filter((location) => {
    const terms = location.toLowerCase().split(/[^a-z0-9]+/u).filter((term) => term.length > 2 && !['remote', 'united', 'states'].includes(term));
    return terms.length > 0 && terms.every((term) => segment.toLowerCase().includes(term));
  });
  const regional = /\bspecific work locations,?\s+(?:within|in)\s+(.{1,250}?),?\s+and the base pay range\b/iu.exec(segment)?.[1]
    ?? /\b(?:salary|pay) range for (?:this|the) role in (.{1,250}?)\s+is\b/iu.exec(segment)?.[1]
    ?? /\bpay range for (?!this\b|the\b)(.{1,250}?)\s+is\b/iu.exec(segment)?.[1];
  const starting = /\b(?:starts? at|starting at)\s*[$€£]/iu.test(segment);
  const prefix = regional?.replace(/,\s*$/u, '').trim() ?? /^\s*([A-Za-z][A-Za-z0-9 .,&/()-]{2,100})\s*:/u.exec(segment)?.[1]?.trim()
    ?? /^\s*([A-Za-z][A-Za-z0-9 .,&/()-]{1,100}?)\s*[-–—]\s*Minimum\b/iu.exec(segment)?.[1]?.trim()
    ?? /\bfor (?:the )?([\w. -]{1,60}\blevel)\b/iu.exec(segment)?.[1]?.trim()
    ?? /\bfor ((?:undergrad(?:uate)?|graduate|PhD)(?: students?)?)\b/iu.exec(segment)?.[1]?.trim();
  const compensationLabel = prefix && /\b(?:salary|pay|compensation|wages?|earnings?|rate|range)\b/iu.test(prefix)
    && !/\bfull[ -]time\b/iu.test(prefix);
  const genericHeading = prefix && /^(?:base|required skills|additional requirements|what we offer|requirements|qualifications)$/iu.test(prefix);
  const levels = payTierEducationLevels(segment);
  const educationTier = EDUCATION_PAY_ROW.exec(segment)?.[1];
  return {
    ...(explicitLocation ? { applicableLocations: normalizeLocations([explicitLocation]) } : locations.length ? { applicableLocations: normalizeLocations(locations) } : {}),
    ...(levels.length ? { applicableEducationLevels: levels } : {}),
    ...(starting ? { applicabilityLabel: 'Starting rate (lower bound)' }
      : educationTier ? { applicabilityLabel: educationTier }
      : !locations.length && prefix && !compensationLabel && !genericHeading ? { applicabilityLabel: boundedText(prefix, 120) } : {}),
  };
}

// Employer pages frequently flatten salary and benefits into one paragraph.
// Keep benefit amounts out of compensation without discarding a genuine wage
// earlier in that same paragraph (for example, Varda's hourly rate followed by
// a cell-phone reimbursement).
function isBenefitAmount(segment: string, start: number, end: number): boolean {
  const amountMarker = /(?:[$€£]\s*\d[\d,.]*|\b(?:USD|CAD|AUD|EUR|GBP)\s+\d[\d,.]*)/giu;
  let previousAmountEnd = Math.max(0, start - 120);
  for (const marker of segment.matchAll(amountMarker)) {
    if ((marker.index ?? 0) >= start) break;
    previousAmountEnd = (marker.index ?? 0) + marker[0].length;
  }
  const before = segment.slice(previousAmountEnd, start);
  const after = segment.slice(end, end + 180);
  // Stop the forward context at the next monetary amount. This makes the
  // exclusion clause-aware even when the source omitted punctuation/newlines.
  const nextAmount = after.search(/(?:[$€£]\s*\d|\b(?:USD|CAD|AUD|EUR|GBP)\s+\d)/iu);
  const beforeNextAmount = nextAmount < 0 ? after : after.slice(0, nextAmount);
  const benefitMatches = [...before.matchAll(/\b(?:reimburse(?:d|ment|s)?|allowance|benefit)\b/giu)];
  const lastBenefit = benefitMatches.at(-1)?.index;
  const laterPayLabel = lastBenefit !== undefined
    && /\b(?:salary|pay|wage|rate|compensation)\b/iu.test(before.slice(lastBenefit));
  const priorBenefit = lastBenefit !== undefined && !laterPayLabel;
  if (priorBenefit) return true;
  // A forward reimbursement belongs to this amount only when no next amount
  // starts the clause; otherwise the label is associated with that next value.
  return nextAmount < 0
    && /\b(?:reimburse(?:d|ment|s)?|allowance|benefit)\b/iu.test(beforeNextAmount)
    && /\b(?:pay\s+period|per\s+(?:pay\s+)?period)\b/iu.test(beforeNextAmount);
}

export function extractCompensationRanges(
  value: string,
  input: { provenance: FieldProvenance; knownLocations?: readonly string[]; requirePayContext?: boolean } ,
): CompensationRange[] {
  const ranges: CompensationRange[] = [];
  // Qualified dollar symbols are explicit currencies, including on both ends
  // of a range. Normalize the notation before matching, never infer from pay size.
  const qualified = value.replace(/\bUS\s+D\b(?=\s*(?:to\b|[-–—.,]|$))/gu, 'USD').replace(/\b(US|CA|AU|NZ|SG|HK)\$/gu, (_, code: string) =>
    `${({ US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD' } as Record<string, string>)[code]} $`);
  const normalized = qualified.replace(new RegExp(String.raw`\b(hourly|annual(?:ized)?|yearly|daily|weekly|monthly)\s+(?:(?:base|estimated|starting)\s+)?(?:pay|salary|wage|rate|compensation)(?:\s+range)?[^.;$€£\d]{0,100}?(${MONEY_AMOUNT})\s*(${CURRENCY_CODE})\s*(?:-|–|—|to)\s*(${MONEY_AMOUNT})\s*\3\b`, 'giu'),
    (matched: string, period: string, first: string, currency: string, second: string) =>
      `${matched.slice(0, matched.indexOf(first))}${currency} $${first} - $${second}/${period}`)
    .replace(/(\d)\s+,\s*(?=\d{3}\b)/gu, '$1,')
    .replace(/\b((?:primary location\s+)?full[ -]time\s+(?:salary|pay)\s+range)\s*:\s*\n\s*(?=[$€£])/giu, '$1: ')
    // Adjacent employer min/max fields describe one range, not two offers.
    // Require the same label and currency notation on both endpoints.
    .replace(new RegExp(String.raw`\b(salary\s*\/\s*rate)\s+minimum\s*:\s*((?:(?:${CURRENCY_CODE})\s*)?[$€£])\s*(${MONEY_AMOUNT})\s*\n\s*\1\s+maximum\s*:\s*\2\s*(${MONEY_AMOUNT})`, 'giu'), '$1: $2$3 - $2$4')
    .replace(new RegExp(String.raw`\bminimum\s+(pay|salary)\s*:?\s*((?:(?:${CURRENCY_CODE})\s*)?[$€£])\s*(${MONEY_AMOUNT})\s*\n\s*maximum\s+\1\s*:?\s*\2\s*(${MONEY_AMOUNT})`, 'giu'),
      (matched: string, label: string, currency: string, first: string, second: string, offset: number, full: string) => {
        // Rendered employer fact tables may state cadence in a separate field.
        // Only carry an explicit Hourly value through bounded metadata rows;
        // prose, other money, related jobs, or "Salaried" cannot supply a unit.
        const trailingFields = full.slice(offset + matched.length, offset + matched.length + 2000);
        const hourly = /^\s*\n(?:(?:Line of Business|Banner Name|Education Level|Required License and Certification|Job Schedule|Job Category|Job Identification|Locations)[^\n$€£]{0,200}\n){0,8}Hourly or Salaried\s*:?\s*Hourly(?:\n|$)/iu.test(trailingFields);
        return `${label}: ${currency}${first} - ${currency}${second}${hourly ? '/hour' : ''}`;
      })
    .replace(new RegExp(String.raw`\bpay range\s*[-–—]\s*start\s*:\s*((?:(?:${CURRENCY_CODE})\s*)?[$€£])\s*(${MONEY_AMOUNT})\s*\n\s*pay range\s*[-–—]\s*end\s*:\s*\1\s*(${MONEY_AMOUNT})`, 'giu'), 'Pay range: $1$2 - $1$3')
    // Rendered fact tables put the label on its own line above its value, as
    // iCIMS does with "Salary Min ($)" then "USD $25.00". Text is segmented on
    // newlines, so without this the two ends become two competing point values
    // and reconciliation refuses to invent a winner. Both ends must carry the
    // same currency notation, exactly as the inline forms above require.
    .replace(new RegExp(String.raw`\b(?:salary|pay|wage|compensation)\s+min(?:imum)?\s*(?:\([^)\n]{0,24}\))?\s*:?\s*\n\s*((?:(?:${CURRENCY_CODE})\s*)?[$€£])\s*(${MONEY_AMOUNT})\s*\n\s*(?:salary|pay|wage|compensation)\s+max(?:imum)?\s*(?:\([^)\n]{0,24}\))?\s*:?\s*\n\s*\1\s*(${MONEY_AMOUNT})`, 'giu'), 'Salary: $1$2 - $1$3')
    .replace(new RegExp(String.raw`([$€£]\s*${MONEY_AMOUNT})\s+through\s+(?=[$€£]\s*\d)`, 'giu'), '$1 - ')
    .replace(/\bD\.C\./gu, 'DC')
    .replace(new RegExp(String.raw`([$€£]?\s*${MONEY_AMOUNT}\s*[kK]?)\s+(${CURRENCY_CODE})(?=\s*(?:[-–—]|to)\s*)`, 'giu'), '$2 $1')
    .replace(/([-–—]|\bto\b)\s*(?:maximum|max\.?)\s*(?=[$€£\d])/giu, '$1 ')
    .replace(/(\d)\s+MIN\s*(?=[-–—])/giu, '$1 ')
    .replace(new RegExp(String.raw`\bbetween\s+((?:(?:${CURRENCY_CODE})\s*)?[$€£]\s*${MONEY_AMOUNT}\s*[kK]?)\s+and\s+(?=(?:(?:${CURRENCY_CODE})\s*)?[$€£]\s*\d)`, 'giu'), 'between $1 - ');
  const payContext = /\b(?:salary|pays?|compensation|base rate|market range|hourly rate|annual range|hiring range|internships? (?:is|are) paid)\b/iu;
  const segments = normalized.split(/(?<=[.;\n])\s+|\s*[;\n]\s*/u).filter(Boolean).flatMap(segment => {
    // Inline degree tiers are separate disclosures, not range endpoints. Keep
    // each amount with its own qualifier; do not carry a period across tiers.
    const tiers = /\bfor (?:undergrad(?:uate)?|graduate|PhD)\b/iu.test(segment)
      ? segment.split(/(?:,\s*(?:and\s+)?|\s+and\s+)(?=(?:(?:USD|CAD|EUR|GBP)\s*)?[$€£]\s*\d)/iu) : [segment];
    return tiers.map(text => ({ text, inlinePayContext: tiers.length > 1 && payContext.test(segment) }));
  });
  let inheritedPayContext = false;
  let currentPayContext = false;
  const append = (segment: string, raw: string, first: number, second: number, periodText: string, currency: string, matchStart = segment.indexOf(raw)) => {
    if (matchStart >= 0 && isBenefitAmount(segment, matchStart, matchStart + raw.length)) return;
    if (input.requirePayContext && !currentPayContext) return;
    const period = compensationPeriod(periodText);
    const minAmount = Math.min(first, second); const maxAmount = Math.max(first, second);
    // Nominal yen/rupee amounts are not comparable to dollars. Only apply
    // dollar plausibility bounds to known USD; never convert foreign pay.
    const plausible = currency !== 'USD' ? minAmount > 0 && maxAmount <= 1_000_000_000
      : period === 'hourly' ? minAmount >= 5 && maxAmount <= 500
        : period === 'annual' ? minAmount >= 10_000 && maxAmount <= 1_000_000
          : minAmount > 0 && maxAmount <= 1_000_000;
    if (!plausible) return;
    ranges.push({ minAmount, maxAmount, currency, period, ...(period === 'other' ? { periodLabel: periodText.toLowerCase() } : {}), ...applicability(segment, input.knownLocations ?? []),
      sourceText: boundedText(raw, 160), provenance: [input.provenance] });
  };
  for (const { text: segment, inlinePayContext } of segments) {
    const hasMoney = /[$€£]\s*\d/u.test(segment) || new RegExp(String.raw`\b(?:${CURRENCY_CODE})\s+\d`, 'iu').test(segment);
    if (!hasMoney) {
      inheritedPayContext = segment.length <= 160 && payContext.test(segment);
      continue;
    }
    const salaryRow = EDUCATION_PAY_ROW.test(segment) || LOCATION_PAY_ROW.test(segment)
      || /^(?:[A-Za-z][^$€£\n]{0,120}:\s*|(?:Level\w*\s+[\w.]+\s*[-–—]\s*)?Minimum\s*|[$€£]|[A-Z]{3}\s)/iu.test(segment);
    currentPayContext = inlinePayContext || payContext.test(segment) || inheritedPayContext && salaryRow;
    inheritedPayContext = inheritedPayContext && salaryRow;
    // Benefits, equity and application questions are not base compensation.
    if (/\b(?:sign[ -]?on|signing bonus|revenue|salary expectations?|desired salary|stipend|lunch allowance)\b/iu.test(segment)) { inheritedPayContext = false; continue; }
    const statedCurrencies = [...segment.matchAll(new RegExp(String.raw`\b(${CURRENCY_CODE})\b`, 'giu'))].map((match) => match[1]!.toUpperCase());
    if (new Set(statedCurrencies).size > 1) continue;
    const before = ranges.length;
    for (const match of segment.matchAll(LABELED_PAY)) {
      // An attached unit takes precedence over a generic template heading.
      if (new RegExp(String.raw`^\s*(?:/|per\s+)(${PERIOD})\b`, 'iu').test(segment.slice((match.index ?? 0) + match[0].length))) continue;
      const currency = match[2]?.toUpperCase() ?? match[8]?.toUpperCase()
        ?? CURRENCY_SYMBOL[match[3]!] ?? 'XXX';
      append(segment, match[0], amount(match[4]!, match[5]), match[6] ? amount(match[6], match[7]) : amount(match[4]!, match[5]), match[1]!, currency, match.index);
    }
    const splitPatterns = [SPLIT_PERIOD_PAY, ...( /\bbetween\b/iu.test(segment)
      ? [new RegExp(SPLIT_PERIOD_PAY.source.replace('(?:-|–|—|to)', 'and'), 'giu')] : [])];
    for (const match of splitPatterns.flatMap(pattern => [...segment.matchAll(pattern)])) {
      const leftPeriod = compensationPeriod(match[5]!);
      const rightPeriod = compensationPeriod(match[9]!);
      if (leftPeriod !== rightPeriod) continue;
      const currency = match[1]?.toUpperCase() ?? match[6]?.toUpperCase()
        ?? CURRENCY_SYMBOL[match[2]!] ?? 'XXX';
      append(segment, match[0], amount(match[3]!, match[4]), amount(match[7]!, match[8]), match[5]!, currency, match.index);
    }
    for (const match of segment.matchAll(BETWEEN_RANGE_AND_PERIOD_CURRENCY_PAY)) {
      const currency = match[6]!.toUpperCase() ?? CURRENCY_SYMBOL[match[1]!] ?? 'XXX';
      append(segment, match[0], amount(match[2]!, match[3]), amount(match[4]!, match[5]), match[7]!, currency, match.index);
    }
    for (const match of segment.matchAll(PAY)) {
      const explicit = match[1]?.toUpperCase();
      if (!explicit && !match[2]) continue;
      const symbolCurrency = CURRENCY_SYMBOL[match[2]!] ?? 'XXX';
      const trailing = match[5]?.toUpperCase();
      const nearbyPrefix = segment.slice(Math.max(0, (match.index ?? 0) - 8), match.index).match(new RegExp(String.raw`\b(${CURRENCY_CODE})\s*$`, 'iu'))?.[1]?.toUpperCase();
      const nearbySuffix = segment.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 8).match(new RegExp(String.raw`^\s*(${CURRENCY_CODE})\b`, 'iu'))?.[1]?.toUpperCase();
      const currency = explicit ?? trailing ?? nearbyPrefix ?? nearbySuffix ?? symbolCurrency;
      append(segment, match[0], amount(match[3]!, match[4]), match[6] ? amount(match[6], match[7]) : amount(match[3]!, match[4]), match[8]!, currency, match.index);
    }
    for (const match of segment.matchAll(USD_TEXT_PAY)) {
      append(segment, match[0], amount(match[2]!, match[3]), match[4] ? amount(match[4], match[5]) : amount(match[2]!, match[3]), match[6]!, 'USD', match.index);
    }
    // A clearly labelled disclosed amount is useful even without a period.
    // Do not downgrade a malformed/mixed explicit-period expression to unknown.
    if (ranges.length === before && !new RegExp(String.raw`\b(?:${PERIOD}|biweekly|semimonthly)\b`, 'iu').test(segment)
      && (input.requirePayContext !== true || currentPayContext)) {
      const unknownPay = new RegExp(String.raw`(?:(${CURRENCY_CODE})\s*([$€£])?|([$€£]))\s*(${MONEY_AMOUNT})\s*([kK])?\s*(?:(?:-|–|—|to)\s*(?:(${CURRENCY_CODE})\s*)?[$€£]?\s*(${MONEY_AMOUNT})\s*([kK])?)?(?:\s*(${CURRENCY_CODE})\b)?`, 'giu');
      for (const match of segment.matchAll(unknownPay)) {
        const codes = [match[1], match[6], match[9]].filter(Boolean).map((value) => value!.toUpperCase());
        if (new Set(codes).size > 1) continue;
        const currency = codes[0] ?? CURRENCY_SYMBOL[match[2] ?? match[3] ?? ''] ?? 'XXX';
        append(segment, match[0], amount(match[4]!, match[5]), match[7] ? amount(match[7], match[8]) : amount(match[4]!, match[5]), 'unknown', currency, match.index);
      }
    }
  }
  const key = (range: CompensationRange) => stable({ minAmount: range.minAmount, maxAmount: range.maxAmount, currency: range.currency,
    period: range.period, periodLabel: range.periodLabel, applicableLocations: range.applicableLocations, applicableEducationLevels: range.applicableEducationLevels,
    applicabilityLabel: range.applicabilityLabel });
  const normalizedPeriodText = (text: string) => text.replace(/\s*(?:per|\/)\s*(?:hour|hr)\b/giu, '/hour');
  const unique = [...new Map(ranges.map((range) => [key(range), range])).values()];
  return unique.filter((candidate) => candidate.minAmount !== candidate.maxAmount || !unique.some((range) =>
    range !== candidate && range.minAmount !== range.maxAmount && range.period === candidate.period
      && (range.currency === candidate.currency || candidate.currency === 'XXX')
      && stable({ locations: range.applicableLocations, education: range.applicableEducationLevels, label: range.applicabilityLabel })
        === stable({ locations: candidate.applicableLocations, education: candidate.applicableEducationLevels, label: candidate.applicabilityLabel })
      && normalizedPeriodText(range.sourceText).includes(normalizedPeriodText(candidate.sourceText))
      && (candidate.minAmount === range.minAmount || candidate.maxAmount === range.maxAmount)))
    .sort((left, right) => key(left).localeCompare(key(right)));
}

/**
 * A pay label can either describe the amount or limit it. "Hourly Pay Range"
 * merely names what follows, while "Hourly Pay Range (CA Only)" and "SF Bay Area
 * Hourly Rate" restrict who it applies to. Only a remainder that still names a
 * place or a level withholds the range from the USD scalar; otherwise a purely
 * descriptive label was silently discarding a global, well-formed hourly rate.
 */
function payScopeFromLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const remainder = label
    .replace(/\b(?:hourly|daily|weekly|biweekly|monthly|annual|yearly|salary|salaries|pay|rate|range|estimated|estimate|base|compensation|wage|stipend|co-?op|intern(?:ship)?|per|hour|year|month|week|day|only)\b/giu, ' ')
    .replace(/[\s:;,.()[\]{}·/\\–—-]+/gu, ' ')
    .trim();
  return remainder || undefined;
}

export function compensationFromRanges(ranges: readonly CompensationRange[]): Compensation {
  // `ranges` is the additive public contract. Retain every explicit amount,
  // including native currencies and nonstandard/unknown periods. The old USD
  // scalar bounds remain intentionally narrow for existing sorting consumers.
  const projected = ranges.map((range) => ({ ...range, provenance: mergeProvenance(range.provenance) }));
  const raw = boundedText(compensationLabels({ ranges: projected }).join(' · '), 160);
  const result: Compensation = { raw, ...(projected.length ? { ranges: projected } : {}) };
  const supported = projected.filter((range) => range.currency === 'USD' && ['hourly', 'annual'].includes(range.period));
  const global = supported.filter((range) => !payScopeFromLabel(range.applicabilityLabel)
    && !range.applicableLocations?.length && !range.applicableEducationLevels?.length);
  const hourly = global.filter((range) => range.period === 'hourly');
  const annual = global.filter((range) => range.period === 'annual');
  // Two sources quoting the same band agree, so they still yield a scalar; two
  // sources quoting different bands do not, and no winner is invented.
  if (hourly.length && hourly.every((range) => range.minAmount === hourly[0]!.minAmount && range.maxAmount === hourly[0]!.maxAmount)) {
    result.minHourlyUSD = hourly[0]!.minAmount; result.maxHourlyUSD = hourly[0]!.maxAmount;
  }
  if (annual.length && annual.every((range) => range.minAmount === annual[0]!.minAmount && range.maxAmount === annual[0]!.maxAmount)) {
    result.minAnnualUSD = annual[0]!.minAmount; result.maxAnnualUSD = annual[0]!.maxAmount;
  }
  return result;
}

export function extractHousingDetails(value: string, input: { provenance: FieldProvenance; knownLocations?: readonly string[] }): HousingDetail[] {
  const details: HousingDetail[] = [];
  for (const raw of value.split(/(?<=[.!?;])\s+|\n+|\s*[•|]\s*/u)) {
    const clause = raw.replace(/^\s*[-•]\s*/u, '').trim();
    // Negated remote-work eligibility is a condition on who receives housing,
    // not a denial of the benefit. Preserve the complete condition in evidence.
    const benefitPolarity = clause.replace(/\bnot\s+(?:working\s+)?(?:100\s*%|fully|entirely)\s+remote\b/giu, 'onsite');
    if (!/\b(?:housing|accommodation|rent)\b/iu.test(clause)
      || /\b(?:reasonable accommodation|disabilit(?:y|ies)|accessibility|interviews?)\b/iu.test(clause)
      || /\b(?:not|no|cannot|unavailable|without)\b/iu.test(benefitPolarity.replace(/\bat no cost\b/giu, 'free'))) continue;
    const kind: HousingDetail['kind'] | undefined = /\b(?:stipend|allowance)\b/iu.test(clause) ? 'stipend'
      : /\b(?:free|company[ -]paid|employer[ -]paid)\s+(?:housing|accommodation)\b|\b(?:housing|accommodation|rent)(?:\s+(?:is|are|will be|provided|costs?))*\s+(?:free|at no cost|fully covered by (?:us|the company)|paid for by (?:us|the company))\b/iu.test(clause) ? 'employer-paid'
        : !/\b(?:covered|reimbursed|reimbursement|assistance)\b/iu.test(clause)
          && /\b(?:you|interns?|employees?|residents?)\s+(?:must |will )?(?:pay|cover)\s+(?:for |their )?(?:housing|accommodation|rent)\b|\b(?:housing|accommodation|rent)\s+(?:costs?|charges?)\s*:?\s*(?:[A-Z]{3}\s*)?[$€£]\s*\d/iu.test(clause) ? 'employee-cost'
          : !/\b(?:assistance|support|help securing)\b/iu.test(clause)
            && /\b(?:housing|accommodation)\s+(?:is |will be )?(?:provided|available)|\b(?:provide|offer)\s+(?:company\s+)?housing\b/iu.test(clause) ? 'available' : undefined;
    if (!kind) continue;
    // An amount belongs to housing only in a clause with one monetary range
    // and no competing salary, meal or relocation component.
    const amounts = /\b(?:salary|base pay|hourly pay|wages?|meals?|relocation|travel|bonus|deposit|up to|starting at)\b|\b(?:plus|and|with|including)\s+(?:an?\s+)?(?:eligible for\s+)?(?:housing|accommodation)\b/iu.test(clause) ? []
      : extractCompensationRanges(clause.replace(/\b(?:stipend|allowance)\b/giu, 'support'), { ...input, requirePayContext: false });
    const range = amounts.length === 1 ? amounts[0] : undefined;
    // A benefit can disclose cadence without disclosing its amount. Bind the
    // unit to the housing label, never a nearby salary or another benefit.
    const labeledPeriods = [...clause.matchAll(/\b(hourly|daily|weekly|monthly|annual|yearly)\s+(?:(?:housing|accommodation|rent)\s+(?:stipend|allowance|costs?)|(?:stipend|allowance)\s+for\s+(?:housing|accommodation|rent))\b/giu)]
      .map(match => compensationPeriod(match[1]!));
    const unpricedPeriod = new Set(labeledPeriods).size === 1 ? labeledPeriods[0] : undefined;
    details.push({ kind, ...(range ? { minAmount: range.minAmount, maxAmount: range.maxAmount, currency: range.currency,
      period: range.period, ...(range.periodLabel ? { periodLabel: range.periodLabel } : {}) }
      : unpricedPeriod ? { period: unpricedPeriod } : {}),
      ...(/\b(?:may|eligible|depending|dependent|subject to|up to|if|when|either|qualif\w*|relocat\w*|permanent residence|overseas applicants?)\b/iu.test(clause) ? { conditional: true } : {}),
      sourceText: boundedText(clause, 240), provenance: [input.provenance] });
  }
  return [...new Map(details.map(detail => [stable({ ...detail, sourceText: undefined, provenance: undefined }), detail])).values()];
}

function isoInstant(value: string | undefined): string | undefined {
  // Date.parse supplies the runtime's current/default year for fragments such
  // as "May 22". A publisher timestamp must state its own four-digit year.
  if (!value || !/\b\d{4}\b/u.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  const named = /^\s*(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s*$/iu.exec(value);
  const dayNamed = /^\s*(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})\s*$/iu.exec(value);
  const namedCalendar = named ? `${named[3]}-${MONTH[named[1]!.toLowerCase()]}-${named[2]!.padStart(2, '0')}`
    : dayNamed ? `${dayNamed[3]}-${MONTH[dayNamed[2]!.toLowerCase()]}-${dayNamed[1]!.padStart(2, '0')}` : undefined;
  if (namedCalendar) {
    const instant = `${namedCalendar}T00:00:00Z`;
    return Number.isFinite(Date.parse(instant)) && new Date(instant).toISOString().slice(0, 10) === namedCalendar
      ? new Date(instant).toISOString() : undefined;
  }
  const calendar = /^\s*(\d{4}-\d{2}-\d{2})(?:[T ]|$)/u.exec(value)?.[1];
  if (calendar && (!Number.isFinite(Date.parse(`${calendar}T00:00:00Z`))
    || new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) !== calendar)) return undefined;
  return new Date(value).toISOString();
}

function deadline(value: string | undefined, timezone?: string): ApplicationDeadline | undefined {
  if (!value) return undefined;
  if (/\brolling\b/iu.test(value)) return { kind: 'rolling' };
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/u.exec(value);
  const named = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/iu.exec(value);
  const dayNamed = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(20\d{2})\b/iu.exec(value);
  const slash = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/u.exec(value);
  const slashFirst = Number(slash?.[1]); const slashSecond = Number(slash?.[2]);
  // Without an explicit locale, accept a slash date only when one ordering is
  // impossible. Never silently choose between month/day and day/month.
  const slashDate = slash && slashFirst <= 12 && slashSecond > 12
    ? `${slash[3]}-${slash[1]!.padStart(2, '0')}-${slash[2]!.padStart(2, '0')}`
    : slash && slashFirst > 12 && slashSecond <= 12
      ? `${slash[3]}-${slash[2]!.padStart(2, '0')}-${slash[1]!.padStart(2, '0')}` : undefined;
  const date = iso ? iso[0]
    : named ? `${named[3]}-${MONTH[named[1]!.toLowerCase()]}-${named[2]!.padStart(2, '0')}`
      : dayNamed ? `${dayNamed[3]}-${MONTH[dayNamed[2]!.toLowerCase()]}-${dayNamed[1]!.padStart(2, '0')}` : slashDate;
  if (!date || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return undefined;
  let explicitZone = timezone ?? (/Z$/u.test(value.trim()) ? 'UTC' : /[+-]\d{2}:\d{2}$/u.exec(value.trim())?.[0]);
  if (explicitZone) {
    const offset = /^([+-])(\d{2}):(\d{2})$/u.exec(explicitZone);
    if (offset) { if (Number(offset[2]) > 23 || Number(offset[3]) > 59) explicitZone = undefined; }
    else { try { new Intl.DateTimeFormat('en', { timeZone: explicitZone }); } catch { explicitZone = undefined; } }
  }
  return { kind: 'date', date, ...(explicitZone ? { timezone: /^[+-]\d{2}:\d{2}$/u.test(explicitZone) ? `UTC${explicitZone}` : explicitZone } : {}) };
}

function fieldExcerpt(value: string, pattern: RegExp): string | undefined {
  const sentence = value.split(/(?<=[.!?;\n])\s+/u).find((part) => pattern.test(part));
  return sentence ? boundedText(sentence, 240) : undefined;
}

function sentenceAt(value: string, index: number, length: number): string {
  const before = value.slice(0, index);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf(';'), before.lastIndexOf('\n')) + 1;
  const after = value.slice(index + length);
  const boundary = after.search(/[.!?;\n]/u);
  return value.slice(start, boundary < 0 ? value.length : index + length + boundary);
}

function explicitPageWorkMode(value: string): Exclude<WorkMode, 'unspecified'> | undefined {
  const labeled = /\b(?:work(?:place| location| arrangement)?|location type|work mode)\s*(?::|\n)\s*(remote|hybrid|on[ -]?site|in[ -]?person)\b/iu.exec(value)?.[1];
  if (labeled) return explicitWorkMode(labeled);
  const asserted = /\b(?:this|the)\s+(?:role|position|job|internship)\s+is\s+((?:a\s+full[ -]time\s+position,?\s+|based\s+|a\s+|fully\s+){0,2})(remote|hybrid|on[ -]?site|in[ -]?person)\b(?:\s+position\b)?/giu;
  for (const match of value.matchAll(asserted)) {
    const sentence = sentenceAt(value, match.index ?? 0, match[0].length);
    if (/\b(?:not|may|might|could|would|depending|conditional(?:ly)?|potentially|if|unless|subject to)\b/iu.test(sentence)) continue;
    return explicitWorkMode(match[2]);
  }
  return undefined;
}

function textApplicationDeadline(value: string): ApplicationDeadline | undefined {
  for (const sentence of value.split(/(?<=[.!?;\n])\s+/u)) {
    const rolling = /\bapplications?\s+(?:are\s+)?(?:reviewed|accepted|considered|processed) on (?:a )?rolling basis\b/iu.test(sentence);
    if (rolling) {
      if (/\b(?:no applications?|not|never|only if|if|unless|subject to|may|might|could)\b/iu.test(sentence)) continue;
      return { kind: 'rolling' };
    }
    if (!/\b(?:(?:application )?(?:deadline|closes?|apply by)|applications? (?:must be )?submitted by)\b/iu.test(sentence)) continue;
    const parsed = deadline(sentence);
    if (parsed) return parsed;
  }
  return undefined;
}

function labeledLocations(value: string): string[] {
  const match = /\b(?:job\s+)?locations?\s*(?::|\n)\s*([^.;|\n]{2,120})/iu.exec(value)?.[1];
  if (!match || /^(?:remote|hybrid|on[ -]?site|in[ -]?person)$/iu.test(match.trim())) return [];
  return normalizeLocations([match]);
}

function labeledInstant(value: string, label: 'posted' | 'updated'): string | undefined {
  const expression = label === 'posted'
    ? /\b(?:date posted|posted(?: on)?)\s*:\s*([^.;\n]{8,50})/iu
    : /\b(?:last updated|updated(?: on)?)\s*:\s*([^.;\n]{8,50})/iu;
  const raw = expression.exec(value)?.[1];
  return isoInstant(raw);
}

/** Extracts only explicit facts from an exact role artifact. Absence produces no value. */
export function extractRoleMetadataEvidence(input: ExtractRoleMetadataInput): RoleMetadataEvidence | undefined {
  if (!input.exactPosting) return undefined;
  const artifactHash = input.artifactHash ?? roleMetadataArtifactHash(input.artifact);
  const field = (code: string) => provenance(input, artifactHash, code);
  const title = input.artifact.title.trim();
  // Title-derived audience hints intentionally live in their own low-priority
  // evidence record. Do not let a title token inherit official-page authority.
  const text = input.titleOnly ? title : input.artifact.text ?? '';
  const compensationText = input.titleOnly ? '' : input.artifact.compensationText?.trim() || input.artifact.text || '';
  const normalizedLocations = input.titleOnly ? [] : normalizeLocations(input.artifact.locations?.length ? input.artifact.locations : labeledLocations(input.artifact.text ?? ''));
  const compensationRanges = extractCompensationRanges(compensationText, {
    provenance: field('compensation-range'), knownLocations: normalizedLocations,
    requirePayContext: !input.artifact.compensationText,
  });
  // A dedicated salary field can be partial; it must not hide disclosures in
  // the role description. The latter still needs explicit pay context.
  if (!input.titleOnly && input.artifact.compensationText && input.artifact.text) compensationRanges.push(...extractCompensationRanges(input.artifact.text, {
    provenance: field('compensation-range'), knownLocations: normalizedLocations, requirePayContext: true,
  }));
  for (const band of input.titleOnly ? [] : input.artifact.compensationBands ?? []) {
    if (!Number.isFinite(band.minAmount) || !Number.isFinite(band.maxAmount) || band.minAmount <= 0 || band.maxAmount < band.minAmount) continue;
    const periodText = ({ hourly: 'hour', annual: 'year', weekly: 'week', daily: 'day', monthly: 'month' } as Record<string, string>)[band.period ?? ''];
    if (band.period && band.period !== 'unknown' && !periodText) continue;
    const ranges = extractCompensationRanges(`Salary: ${band.currency} ${band.minAmount} - ${band.maxAmount}${periodText ? ` per ${periodText}` : ''}`, {
      provenance: field('compensation-range'), requirePayContext: false,
    });
    const bandRanges = ranges.map((range) => ({ ...range, sourceText: boundedText(band.sourceText, 160),
      ...(band.label ? { applicabilityLabel: boundedText(band.label, 120) } : {}) }));
    // Structured employer bands also appear in the description. Prefer their
    // explicit label/unit over an otherwise identical unlabeled body amount.
    for (let index = compensationRanges.length - 1; index >= 0; index -= 1) {
      const candidate = compensationRanges[index]!;
      if (!candidate.applicabilityLabel && !candidate.applicableLocations?.length && !candidate.applicableEducationLevels?.length
        && bandRanges.some(range => range.minAmount === candidate.minAmount && range.maxAmount === candidate.maxAmount
          && (range.period === candidate.period || candidate.period === 'unknown')
          && (range.currency === candidate.currency || candidate.currency === 'XXX'))) compensationRanges.splice(index, 1);
    }
    compensationRanges.push(...bandRanges);
  }
  for (const section of input.titleOnly ? [] : input.artifact.compensationSections ?? []) {
    const sectionRanges = extractCompensationRanges(section.text, {
      provenance: field('compensation-range'), knownLocations: normalizedLocations, requirePayContext: false,
    }).map((range) => ({ ...range, ...(section.label ? { applicabilityLabel: boundedText(section.label, 120) } : {}) }));
    // The same visible amount also occurs in flattened body text. Keep its
    // explicit row label instead of manufacturing a conflicting global band.
    for (let index = compensationRanges.length - 1; index >= 0; index -= 1) {
      const candidate = compensationRanges[index]!;
      if (!candidate.applicabilityLabel && sectionRanges.some((range) =>
        range.minAmount === candidate.minAmount && range.maxAmount === candidate.maxAmount && range.period === candidate.period
        && (range.currency === candidate.currency || candidate.currency === 'XXX'))) compensationRanges.splice(index, 1);
    }
    compensationRanges.push(...sectionRanges);
  }
  const levels = educationAudienceLevels(text);
  const housing = input.titleOnly ? [] : extractHousingDetails(text, { provenance: field('housing-explicit'), knownLocations: normalizedLocations });
  const window = graduationWindow(text);
  const degree = minimumDegree(text);
  const education = levels.length || window || degree ? mergeEducationEvidence([{
    ...(levels.length ? { levels } : {}), ...(window ? { graduationDateWindow: window } : {}), ...(degree ? { minimumDegree: degree } : {}),
    provenance: [field(input.titleOnly ? 'education-title-explicit' : 'education-explicit')],
  }]) : undefined;
  const mode = input.titleOnly
    ? titleWorkMode(title)
    : explicitWorkMode(input.artifact.workMode) ?? explicitPageWorkMode(input.artifact.text ?? '');
  const locations: InternshipLocation[] = normalizedLocations.map((name) => ({ name,
    workMode: explicitWorkMode(name) ?? mode ?? 'unspecified', provenance: [field('location-explicit')] }));
  const directDeadline = input.titleOnly ? undefined : deadline(input.artifact.deadline, input.artifact.deadlineTimezone);
  const textDeadline = input.titleOnly ? undefined : textApplicationDeadline(input.artifact.text ?? '');
  const applicationDeadline = directDeadline ?? textDeadline;
  const publishedAt = input.titleOnly ? undefined : isoInstant(input.artifact.publishedAt) ?? labeledInstant(input.artifact.text ?? '', 'posted');
  const updatedAt = input.titleOnly ? undefined : isoInstant(input.artifact.updatedAt) ?? labeledInstant(input.artifact.text ?? '', 'updated');
  if (!compensationRanges.length && !housing.length && !education && !locations.length && !mode && !applicationDeadline && !publishedAt && !updatedAt) return undefined;
  const excerpts: Partial<Record<RoleMetadataField, string>> = {};
  if (compensationRanges.length) excerpts.compensation = boundedText([...new Set(compensationRanges.map((range) => range.sourceText))].join(' · '), 240);
  if (housing.length) excerpts.housing = housing[0]!.sourceText;
  if (education) excerpts.education = fieldExcerpt(text, /\b(?:bachelor|undergrad|four[ -]?year|master|graduate student|mba|ph\.?d\.?|doctoral?|graduat(?:e|ing|ion)|class of)\b/iu);
  if (applicationDeadline) excerpts['application-deadline'] = fieldExcerpt(input.artifact.text ?? input.artifact.deadline ?? '', /\b(?:deadline|closes?|apply by|rolling)\b/iu);
  return {
    schemaVersion: 1, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION, artifactHash,
    sourceClass: input.sourceClass, sourceId: input.sourceId, sourceUrl: input.sourceUrl, observedAt: input.observedAt, exactPosting: true,
    ...(compensationRanges.length ? { compensationRanges } : {}), ...(housing.length ? { housing } : {}), ...(education ? { education } : {}), ...(locations.length ? { locations } : {}),
    ...(mode ? { workMode: { value: mode, provenance: [field(input.titleOnly ? 'work-mode-title-explicit' : 'work-mode-explicit')] } } : {}),
    ...(applicationDeadline ? { applicationDeadline: { value: applicationDeadline, provenance: [field('application-deadline-explicit')] } } : {}),
    ...(publishedAt ? { employerPublishedAt: { value: publishedAt, provenance: [field('employer-published-at')] } } : {}),
    ...(updatedAt ? { employerUpdatedAt: { value: updatedAt, provenance: [field('employer-updated-at')] } } : {}),
    ...(Object.keys(excerpts).length ? { excerpts } : {}),
  };
}

export function extractPostingMetadataEvidence(input: Omit<ExtractRoleMetadataInput, 'sourceClass' | 'titleOnly'> & { sourceClass: Exclude<EvidenceSource, 'deterministic-inference'> }): RoleMetadataEvidence[] {
  const artifactHash = input.artifactHash ?? roleMetadataArtifactHash(input.artifact);
  const extracted = extractRoleMetadataEvidence({ ...input, artifactHash });
  const sourceSnapshot: RoleMetadataEvidence = extracted ?? {
    schemaVersion: 1,
    extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
    artifactHash,
    sourceClass: input.sourceClass,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    observedAt: input.observedAt,
    exactPosting: true,
  };
  return [
    sourceSnapshot,
    extractRoleMetadataEvidence({ ...input, artifactHash, sourceClass: 'deterministic-inference', titleOnly: true }),
  ].filter((value): value is RoleMetadataEvidence => Boolean(value));
}

export function roleMetadataEvidenceHasFields(value: RoleMetadataEvidence): boolean {
  return Boolean(value.compensationRanges?.length || value.housing?.length || value.education || value.locations?.length || value.workMode
    || value.applicationDeadline || value.employerPublishedAt || value.employerUpdatedAt);
}

export function metadataEvidenceSlot(value: RoleMetadataEvidence): string {
  return `${value.sourceClass}\0${value.sourceId}`;
}

export function mergeRoleMetadataEvidence(current: readonly RoleMetadataEvidence[] = [], incoming: readonly RoleMetadataEvidence[] = []): RoleMetadataEvidence[] {
  const slots = new Map(current.map((item) => [metadataEvidenceSlot(item), item]));
  for (const item of incoming) slots.set(metadataEvidenceSlot(item), item);
  return [...slots.values()].sort((left, right) => metadataEvidenceSlot(left).localeCompare(metadataEvidenceSlot(right)));
}

/** Replaces the complete page-derived snapshot while preserving evidence owned by other stages. */
export function replaceVerifiedPageMetadataEvidence(
  current: readonly RoleMetadataEvidence[] = [],
  incoming: readonly RoleMetadataEvidence[] = [],
  sourceId: string,
): RoleMetadataEvidence[] {
  const replaced = new Set<EvidenceSource>(VERIFIED_PAGE_METADATA_SOURCES);
  return mergeRoleMetadataEvidence(
    current.filter((item) => item.sourceId !== sourceId || !replaced.has(item.sourceClass)),
    incoming,
  );
}

function priority(value: { provenance: FieldProvenance[] }): number {
  return Math.min(...value.provenance.map((item) => SOURCE_PRIORITY[item.source]));
}

function scalar<T>(field: RoleMetadataField, values: Array<ProvenancedValue<T> & { artifactHash: string }>, existing?: T): {
  value?: ProvenancedValue<T>; conflict?: MetadataConflict;
} {
  if (!values.length) return {};
  const best = Math.min(...values.map(priority));
  const candidates = values.filter((value) => priority(value) === best);
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = stable(candidate.value); const matches = groups.get(key) ?? []; matches.push(candidate); groups.set(key, matches);
  }
  if (groups.size > 1) return {
    ...(existing !== undefined ? { value: { value: existing, provenance: [] } } : {}),
    conflict: { field, evidenceHashes: [...new Set(candidates.map((item) => item.artifactHash))].sort(), values: [...groups.keys()].sort() },
  };
  const matching = [...groups.values()][0]!;
  return { value: { value: matching[0]!.value, provenance: mergeProvenance(matching.flatMap((item) => item.provenance)) } };
}

function rangeApplicability(range: CompensationRange): string {
  return stable({ currency: range.currency, period: range.period,
    periodLabel: range.periodLabel,
    label: range.applicabilityLabel,
    locations: [...(range.applicableLocations ?? [])].map((item) => item.toLowerCase()).sort(),
    education: [...(range.applicableEducationLevels ?? [])].sort() });
}

function rangeValue(range: CompensationRange): string {
  return stable({ minAmount: range.minAmount, maxAmount: range.maxAmount });
}

function rangeAudience(range: CompensationRange): string {
  // This parser-generated amount qualifier is not a distinct population.
  // Regional, education and publisher-supplied audience labels remain scoped.
  const label = range.applicabilityLabel?.trim().toLowerCase();
  return stable({
    label: label === 'starting rate (lower bound)' ? undefined : label || undefined,
    locations: [...(range.applicableLocations ?? [])].map(item => item.trim().toLowerCase()).sort(),
    education: [...(range.applicableEducationLevels ?? [])].sort(),
  });
}

function reconcileRanges(evidence: readonly RoleMetadataEvidence[], existing: readonly CompensationRange[] = []): { ranges: CompensationRange[]; conflicts: MetadataConflict[] } {
  const groups = new Map<string, Array<CompensationRange & { artifactHash: string }>>();
  // Community estimates are fallback evidence for an audience, not another
  // employer pay band just because their currency or unit differs. Keep all
  // official bands and distinct regional/education/label scopes; never convert
  // amounts or infer an unstated currency. An unresolved official pay period
  // is insufficient to withdraw a more specific community disclosure.
  const officialAudiences = new Set(evidence.flatMap(item => item.compensationRanges ?? [])
    .filter(range => priority(range) < SOURCE_PRIORITY['reviewed-community'] && range.period !== 'unknown')
    .map(rangeAudience));
  const eligible = (range: CompensationRange) => priority(range) < SOURCE_PRIORITY['reviewed-community']
    || !officialAudiences.has(rangeAudience(range));
  for (const item of evidence) for (const range of item.compensationRanges ?? []) {
    if (!eligible(range)) continue;
    const key = rangeApplicability(range); const values = groups.get(key) ?? []; values.push({ ...range, artifactHash: item.artifactHash }); groups.set(key, values);
  }
  const ranges: CompensationRange[] = []; const conflicts: MetadataConflict[] = [];
  for (const [key, values] of groups) {
    const best = Math.min(...values.map(priority));
    const candidates = values.filter((value) => priority(value) === best);
    const distinct = new Map(candidates.map((value) => [rangeValue(value), value]));
    if (distinct.size > 1) {
      const preserved = existing.find((range) => rangeApplicability(range) === key && eligible(range));
      if (preserved) ranges.push(preserved);
      conflicts.push({ field: 'compensation', applicabilityKey: key,
        evidenceHashes: [...new Set(candidates.map((item) => item.artifactHash))].sort(), values: [...distinct.keys()].sort() });
      continue;
    }
    const winner = [...distinct.values()][0]!;
    ranges.push({ minAmount: winner.minAmount, maxAmount: winner.maxAmount, currency: winner.currency, period: winner.period,
      ...(winner.periodLabel ? { periodLabel: winner.periodLabel } : {}),
      ...(winner.applicabilityLabel ? { applicabilityLabel: winner.applicabilityLabel } : {}),
      ...(winner.applicableLocations?.length ? { applicableLocations: winner.applicableLocations } : {}),
      ...(winner.applicableEducationLevels?.length ? { applicableEducationLevels: winner.applicableEducationLevels } : {}),
      sourceText: winner.sourceText, provenance: mergeProvenance(candidates.flatMap((item) => item.provenance)) });
  }
  return { ranges: ranges.sort((left, right) => rangeApplicability(left).localeCompare(rangeApplicability(right))), conflicts };
}

export function reconcileRoleMetadata(
  evidence: readonly RoleMetadataEvidence[],
  existing?: Internship,
): { metadata?: ReconciledRoleMetadata; compensation?: Compensation; conflicts: MetadataConflict[] } {
  const usable = evidence.filter((item) => item.schemaVersion === 1 && item.extractionVersion === ROLE_METADATA_EXTRACTION_VERSION
    && item.exactPosting && roleMetadataEvidenceHasFields(item));
  if (!usable.length) return { conflicts: [] };
  const conflicts: MetadataConflict[] = [];
  const ranges = reconcileRanges(usable, existing?.compensation.ranges);
  conflicts.push(...ranges.conflicts);
  const housing: HousingDetail[] = [];
  for (const kind of ['stipend', 'employer-paid', 'employee-cost', 'available'] as const) {
    const values = usable.flatMap(item => (item.housing ?? []).filter(detail => detail.kind === kind).map(detail => ({
      value: { ...detail, provenance: undefined, sourceText: undefined }, provenance: detail.provenance, artifactHash: item.artifactHash, detail,
    })));
    const result = scalar('housing', values);
    if (result.conflict) conflicts.push({ ...result.conflict, applicabilityKey: kind });
    else if (result.value) {
      const winner = values.find(item => stable(item.value) === stable(result.value!.value))!;
      housing.push({ ...winner.detail, provenance: result.value.provenance });
    }
  }
  const bestEducation = usable.filter((item) => item.education).map((item) => ({ ...item.education!, artifactHash: item.artifactHash }));
  let education: EducationAudience | undefined;
  if (bestEducation.length) {
    const best = Math.min(...bestEducation.map(priority));
    education = mergeEducationEvidence(bestEducation.filter((item) => priority(item) === best));
    if (education.evidenceStatus === 'conflicting') {
      conflicts.push({ field: 'education', evidenceHashes: [...new Set(bestEducation.map((item) => item.artifactHash))].sort(), values: bestEducation.map((item) => stable(item)).sort() });
      education = undefined;
    }
  }
  const locationValues = usable.flatMap((item) => (item.locations ?? []).map((location) => ({ ...location, artifactHash: item.artifactHash })));
  let locations: InternshipLocation[] | undefined;
  if (locationValues.length) {
    const best = Math.min(...locationValues.map(priority));
    const selected = locationValues.filter((item) => priority(item) === best);
    const byName = new Map<string, typeof selected>();
    for (const location of selected) { const key = location.name.toLowerCase(); const values = byName.get(key) ?? []; values.push(location); byName.set(key, values); }
    locations = [...byName.entries()].flatMap(([key, values]) => {
      const modes = [...new Set(values.map((item) => item.workMode).filter((item) => item !== 'unspecified'))].sort();
      if (modes.length > 1) {
        conflicts.push({ field: 'work-mode', applicabilityKey: key,
          evidenceHashes: [...new Set(values.map((item) => item.artifactHash))].sort(), values: modes });
        const preserved = existing?.roleMetadata?.locations?.find((item) => item.name.toLowerCase() === key);
        return preserved ? [preserved] : [];
      }
      return [{ name: values[0]!.name, workMode: modes[0] ?? 'unspecified',
        provenance: mergeProvenance(values.flatMap((item) => item.provenance)) }];
    }).sort((left, right) => left.name.localeCompare(right.name));
  }
  const scalarValues = <T>(pick: (item: RoleMetadataEvidence) => ProvenancedValue<T> | undefined) => usable.flatMap((item) => {
    const value = pick(item); return value ? [{ ...value, artifactHash: item.artifactHash }] : [];
  });
  const workMode = scalar('work-mode', scalarValues((item) => item.workMode), existing?.workMode === 'unspecified' ? undefined : existing?.workMode as Exclude<WorkMode, 'unspecified'> | undefined);
  const applicationDeadline = scalar('application-deadline', scalarValues((item) => item.applicationDeadline), existing?.applicationDeadline);
  const employerPublishedAt = scalar('employer-published-at', scalarValues((item) => item.employerPublishedAt), existing?.employerPublishedAt);
  const employerUpdatedAt = scalar('employer-updated-at', scalarValues((item) => item.employerUpdatedAt), existing?.employerUpdatedAt);
  for (const result of [workMode, applicationDeadline, employerPublishedAt, employerUpdatedAt]) if (result.conflict) conflicts.push(result.conflict);
  const graduation = education?.graduationDateWindow
    ? { value: education.graduationDateWindow, provenance: education.provenance }
    : undefined;
  const metadata: ReconciledRoleMetadata = {
    schemaVersion: 1, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
    evidenceHashes: [...new Set(usable.map((item) => item.artifactHash))].sort(),
    ...(ranges.ranges.length ? { compensationRanges: ranges.ranges } : {}), ...(education ? { education } : {}),
    ...(housing.length ? { housing } : {}),
    ...(locations?.length ? { locations } : {}), ...(workMode.value?.provenance.length ? { workMode: workMode.value } : {}),
    ...(applicationDeadline.value?.provenance.length ? { applicationDeadline: applicationDeadline.value } : {}),
    ...(graduation ? { graduationWindow: graduation } : {}),
    ...(employerPublishedAt.value?.provenance.length ? { employerPublishedAt: employerPublishedAt.value } : {}),
    ...(employerUpdatedAt.value?.provenance.length ? { employerUpdatedAt: employerUpdatedAt.value } : {}),
  };
  return { metadata, ...(ranges.ranges.length ? { compensation: compensationFromRanges(ranges.ranges) } : {}), conflicts };
}

function structuredIdentity(job: Internship): InternshipIdentity | undefined {
  const identity = job.internshipIdentity;
  if (!identity || typeof identity !== 'object') return undefined;
  const value = identity as Partial<InternshipIdentity>;
  return value.company && value.programType && value.season && value.education && value.title && Array.isArray(value.locations)
    ? value as InternshipIdentity : undefined;
}

/** Projects reconciled evidence without touching identity, lifecycle, visibility, or notification state. */
export function projectRoleMetadata(job: Internship, evidence = job.sourceReferences.flatMap((item) => item.metadataEvidence ?? [])): {
  job: Internship; conflicts: MetadataConflict[]; deferredEvidenceHashes?: string[];
} {
  const omission = job.metadataOmission;
  if (omission?.field === 'compensation' && omission.action === 'omit'
    && omission.evidenceFingerprint === roleMetadataReviewFingerprint(evidence)) {
    const withoutPay = evidence.map(item => ({ ...item, compensationRanges: undefined }));
    // Clear accepted and legacy pay too; a reviewed omission must never fall
    // back to a stale salary. Retain the original evidence in source references.
    const result = projectRoleMetadata({ ...job, metadataOmission: undefined, compensation: { raw: '' },
      ...(job.roleMetadata ? { roleMetadata: { ...job.roleMetadata, compensationRanges: undefined } } : {}) }, withoutPay);
    return { ...result, job: { ...result.job, metadataOmission: omission } };
  }
  if (omission) job = { ...job, metadataOmission: undefined };
  const result = reconcileRoleMetadata(evidence, job);
  const identity = structuredIdentity(job);
  const previousMetadata = job.roleMetadata;
  // A parser rollout is not a source withdrawal. Sources refresh independently:
  // projecting one current snapshot must not erase accepted fields whose
  // contributing snapshot is still awaiting re-extraction. Keep the accepted
  // projection (including its old version/provenance) until those snapshots
  // are replaced or removed; never promote stale evidence into a new result.
  const acceptedHashes = new Set(previousMetadata?.evidenceHashes ?? []);
  const deferredEvidenceHashes = [...new Set(evidence.filter(item => item.schemaVersion === 1 && item.exactPosting
    && item.extractionVersion !== ROLE_METADATA_EXTRACTION_VERSION
    && acceptedHashes.has(item.artifactHash)).map(item => item.artifactHash))].sort();
  if (deferredEvidenceHashes.length) return { job, conflicts: result.conflicts, deferredEvidenceHashes };
  // A conflict is not a withdrawal. Retain the accepted projection and its
  // provenance so later resolution or withdrawal can still replace it cleanly.
  if (result.metadata && previousMetadata) {
    const conflicted = new Set(result.conflicts.map((conflict) => conflict.field));
    const preserve = <K extends keyof ReconciledRoleMetadata>(key: K, field: RoleMetadataField) => {
      if (conflicted.has(field) && result.metadata![key] === undefined && previousMetadata[key] !== undefined) {
        result.metadata![key] = previousMetadata[key];
      }
    };
    preserve('workMode', 'work-mode');
    preserve('applicationDeadline', 'application-deadline');
    preserve('employerPublishedAt', 'employer-published-at');
    preserve('employerUpdatedAt', 'employer-updated-at');
    preserve('housing', 'housing');
  }
  if (!result.metadata && !identity?.programType?.value && !previousMetadata) return { job, conflicts: result.conflicts };
  const metadataLocations = result.metadata?.locations;
  const locationNames = metadataLocations?.map((item) => item.name);
  const previousEducationWasProjected = Boolean(identity && previousMetadata?.education
    && stable(identity.education) === stable(previousMetadata.education));
  const previousIdentityLocationsWereProjected = Boolean(identity && previousMetadata?.locations
    && stable(identity.locations) === stable(previousMetadata.locations));
  const updatedIdentity = identity && (result.metadata || previousMetadata) ? {
    ...identity,
    ...(result.metadata?.education ? { education: result.metadata.education }
      : previousEducationWasProjected ? { education: { levels: [], evidenceStatus: 'unspecified' as const, provenance: [] } } : {}),
    ...(metadataLocations?.length ? { locations: metadataLocations } : previousIdentityLocationsWereProjected ? { locations: [] } : {}),
  } : job.internshipIdentity;
  const previousCompensationWasProjected = Boolean(previousMetadata?.compensationRanges
    && stable(job.compensation) === stable(compensationFromRanges(previousMetadata.compensationRanges)));
  const projected: Internship = {
    ...job,
    ...(updatedIdentity ? { internshipIdentity: updatedIdentity } : {}),
    ...(result.metadata ? { roleMetadata: result.metadata } : {}),
    ...(result.metadata?.housing ? { housing: result.metadata.housing } : {}),
    ...(result.compensation ? { compensation: result.compensation } : previousCompensationWasProjected ? { compensation: { raw: '' } } : {}),
    ...(locationNames?.length ? { locations: locationNames, location: locationSummary(locationNames) } : {}),
    ...(result.metadata?.workMode ? { workMode: result.metadata.workMode.value } : {}),
    ...(result.metadata?.applicationDeadline ? { applicationDeadline: result.metadata.applicationDeadline.value } : {}),
    ...(result.metadata?.graduationWindow ? { graduationWindow: result.metadata.graduationWindow.value } : {}),
    ...(identity?.programType?.value ? { programType: identity.programType.value } : {}),
    ...(result.metadata?.employerPublishedAt ? { employerPublishedAt: result.metadata.employerPublishedAt.value } : {}),
    ...(result.metadata?.employerUpdatedAt ? { employerUpdatedAt: result.metadata.employerUpdatedAt.value } : {}),
  };
  if (!result.metadata) delete projected.roleMetadata;
  if (previousMetadata?.housing && stable(previousMetadata.housing) === stable(job.housing) && !result.metadata?.housing) delete projected.housing;
  if (previousMetadata?.workMode?.value === job.workMode && !result.metadata?.workMode) delete projected.workMode;
  if (stable(previousMetadata?.applicationDeadline?.value) === stable(job.applicationDeadline) && !result.metadata?.applicationDeadline) delete projected.applicationDeadline;
  if (stable(previousMetadata?.graduationWindow?.value) === stable(job.graduationWindow) && !result.metadata?.graduationWindow) delete projected.graduationWindow;
  if (previousMetadata?.employerPublishedAt?.value === job.employerPublishedAt && !result.metadata?.employerPublishedAt) delete projected.employerPublishedAt;
  if (previousMetadata?.employerUpdatedAt?.value === job.employerUpdatedAt && !result.metadata?.employerUpdatedAt) delete projected.employerUpdatedAt;
  const previousLocationNames = previousMetadata?.locations?.map((item) => item.name);
  if (previousLocationNames && stable(previousLocationNames) === stable(job.locations) && !metadataLocations?.length) {
    const fallbackLocations = normalizeLocations(job.sourceReferences.flatMap((reference) => reference.locations ?? [reference.location]));
    if (fallbackLocations.length) {
      projected.locations = fallbackLocations;
      projected.location = locationSummary(fallbackLocations);
    } else {
      delete projected.locations;
      projected.location = 'Location not specified';
    }
  }
  return { job: projected, conflicts: result.conflicts };
}

export function unsupportedMetadataCurrencies(evidence: readonly RoleMetadataEvidence[]): string[] {
  return [...new Set(evidence.flatMap((item) => item.compensationRanges ?? []).map((range) => range.currency).filter((currency) => currency !== 'USD'))].sort();
}

export function unsupportedMetadataPeriods(evidence: readonly RoleMetadataEvidence[]): string[] {
  return [...new Set(evidence.flatMap((item) => item.compensationRanges ?? []).map((range) => range.period)
    .filter((period) => !['hourly', 'annual'].includes(period)))].sort();
}
