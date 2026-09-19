import type {
  EducationAudience,
  EducationLevel,
  DisciplineTag,
  EvidenceSource,
  FieldProvenance,
  GraduationDateWindow,
  MinimumDegree,
  InternshipIdentity,
  WorkMode,
  ProvenancedValue,
} from '../types.js';
import { canonicalCompanyKey } from '../core/normalize.js';

const SOURCE_PRIORITY: Record<EvidenceSource, number> = {
  'official-api': -1,
  'official-ats': 0,
  'official-json-ld': 1,
  'official-page': 2,
  'reviewed-shadow': 2.5,
  'reviewed-community': 3,
  'deterministic-inference': 4,
};

function provenanceKey(item: FieldProvenance): string {
  return [item.source, item.sourceId, item.sourceUrl ?? '', item.evidenceCode, item.contentHash ?? ''].join('|');
}

export function mergeProvenance(items: readonly FieldProvenance[]): FieldProvenance[] {
  return [...new Map(items.map((item) => [provenanceKey(item), item])).values()]
    .sort((left, right) => SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source]
      || provenanceKey(left).localeCompare(provenanceKey(right)));
}

/** Chooses the highest-authority value, retaining corroborating evidence for that value. */
export function mergeProvenancedValues<T>(values: readonly ProvenancedValue<T>[]): ProvenancedValue<T> | undefined {
  const candidates = values.filter((item) => item.provenance.length > 0);
  if (!candidates.length) return undefined;
  const priority = (item: ProvenancedValue<T>) => Math.min(...item.provenance.map((entry) => SOURCE_PRIORITY[entry.source]));
  const winner = [...candidates].sort((left, right) => priority(left) - priority(right)
    || JSON.stringify(left.value).localeCompare(JSON.stringify(right.value)))[0]!;
  const matching = candidates.filter((item) => JSON.stringify(item.value) === JSON.stringify(winner.value));
  return { value: winner.value, provenance: mergeProvenance(matching.flatMap((item) => item.provenance)) };
}

export interface EducationEvidence {
  /** Omit all semantic fields when the source does not explicitly specify education. */
  levels?: EducationLevel[];
  graduationDateWindow?: GraduationDateWindow;
  minimumDegree?: MinimumDegree;
  provenance: FieldProvenance[];
}

function windowsConflict(windows: GraduationDateWindow[]): boolean {
  const bounded = windows.filter((window) => window.start || window.end);
  if (bounded.length < 2) return false;
  const latestStart = bounded.map((window) => window.start).filter((item): item is string => Boolean(item)).sort().at(-1);
  const earliestEnd = bounded.map((window) => window.end).filter((item): item is string => Boolean(item)).sort()[0];
  return Boolean(latestStart && earliestEnd && latestStart > earliestEnd);
}

function combinedWindow(windows: GraduationDateWindow[]): GraduationDateWindow | undefined {
  if (!windows.length) return undefined;
  const starts = windows.map((window) => window.start).filter((item): item is string => Boolean(item)).sort();
  const ends = windows.map((window) => window.end).filter((item): item is string => Boolean(item)).sort();
  return { ...(starts[0] ? { start: starts[0] } : {}), ...(ends.at(-1) ? { end: ends.at(-1) } : {}) };
}

export function mergeEducationEvidence(evidence: readonly EducationEvidence[]): EducationAudience {
  const explicit = evidence.filter((item) => item.levels?.length || item.graduationDateWindow || item.minimumDegree);
  if (!explicit.length) return { levels: [], evidenceStatus: 'unspecified', provenance: mergeProvenance(evidence.flatMap((item) => item.provenance)) };
  const levels = [...new Set(explicit.flatMap((item) => item.levels ?? []))].sort() as EducationLevel[];
  const windows = explicit.map((item) => item.graduationDateWindow).filter((item): item is GraduationDateWindow => Boolean(item));
  const degrees = [...new Set(explicit.map((item) => item.minimumDegree).filter((item): item is MinimumDegree => Boolean(item)))];
  const conflict = degrees.length > 1 || windowsConflict(windows);
  return {
    levels,
    ...(combinedWindow(windows) ? { graduationDateWindow: combinedWindow(windows) } : {}),
    ...(degrees.length === 1 ? { minimumDegree: degrees[0] } : {}),
    evidenceStatus: conflict ? 'conflicting' : 'explicit',
    provenance: mergeProvenance(explicit.flatMap((item) => item.provenance)),
  };
}

export function educationAudienceMatches(audience: EducationAudience, userLevels: readonly EducationLevel[]): boolean {
  if (audience.evidenceStatus === 'unspecified' || audience.evidenceStatus === 'conflicting') return true;
  return audience.levels.length === 0 || audience.levels.some((level) => userLevels.includes(level));
}

export function educationAudienceLabel(audience: EducationAudience): string {
  if (audience.evidenceStatus === 'unspecified') return 'Education level not specified by employer.';
  if (audience.evidenceStatus === 'conflicting') return 'Employer education requirements conflict across official sources.';
  return audience.levels.join(', ');
}

/** The stated audience a filter needs; every field is validated before it is read. */
export interface StatedEducationAudience {
  levels: string[];
  evidenceStatus?: string;
}

/**
 * Roles carry the audience inside the identity they were built from, and older
 * stored records hold that identity untyped. Reconciled official-page evidence
 * replaces the identity's own scan, so the first holder that states levels wins.
 */
export function educationAudienceOf(job: { internshipIdentity?: unknown; roleMetadata?: unknown }): StatedEducationAudience | undefined {
  for (const holder of [job.internshipIdentity, job.roleMetadata]) {
    if (!holder || typeof holder !== 'object' || !('education' in holder)) continue;
    const education = holder.education;
    if (!education || typeof education !== 'object' || !('levels' in education) || !Array.isArray(education.levels)) continue;
    const evidence = 'evidenceStatus' in education ? education.evidenceStatus : undefined;
    return {
      levels: education.levels.filter((level): level is string => typeof level === 'string'),
      ...(typeof evidence === 'string' ? { evidenceStatus: evidence } : {}),
    };
  }
  return undefined;
}

/**
 * Whether stated evidence turns this reader away. Silence and contradiction never
 * exclude — the employer simply did not say — and a reader is only ever excluded
 * by evidence about their own level. The legacy badge records a graduate
 * requirement without saying which degree, so it can only rule out an
 * undergraduate.
 */
export function educationExcludesLevel(input: {
  levels?: readonly string[];
  evidenceStatus?: string;
  advancedDegreeRequired?: boolean;
  level: EducationLevel;
}): boolean {
  if (input.evidenceStatus === 'explicit' && input.levels?.length) return !input.levels.includes(input.level);
  return Boolean(input.advancedDegreeRequired) && input.level === 'undergraduate';
}

/** Light display cleanup preserves the employer's wording rather than replacing it with tags. */
export function cleanDisplayTitle(officialTitle: string): string {
  return officialTitle.normalize('NFKC').replace(/^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\s]*/u, '').replace(/\s+/g, ' ').trim();
}

export function normalizeSearchTitle(displayTitle: string): string {
  return displayTitle.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\bswe\b/g, 'software engineer')
    .replace(/\binternship\b/g, 'intern')
    .replace(/[^a-z0-9+#]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const DISCIPLINE_PATTERNS: Array<[DisciplineTag, RegExp]> = [
  ['ai-ml', /\b(?:ai|artificial intelligence|machine learning|ml|deep learning)\b/i],
  ['data', /\b(?:data|analytics|business intelligence)\b/i],
  ['infrastructure-cloud', /\b(?:infrastructure|cloud|platform|devops|site reliability|sre)\b/i],
  ['security', /\b(?:security|cybersecurity|infosec)\b/i],
  ['quant', /\b(?:quant|quantitative|trading)\b/i],
  ['product', /\b(?:product manager|product management)\b/i],
  ['technical-design', /\b(?:product design|ux|ui|designer)\b/i],
  ['software', /\b(?:software|developer|engineering|engineer|frontend|backend|full stack|mobile)\b/i],
];

/** Deterministic title classification; tags supplement but never replace the full title. */
export function disciplineTagsForTitle(title: string): DisciplineTag[] {
  return DISCIPLINE_PATTERNS.filter(([, pattern]) => pattern.test(title)).map(([tag]) => tag);
}

export function deriveTitleFields(
  official: ProvenancedValue<string>,
  inferenceProvenance: FieldProvenance,
): {
  official: ProvenancedValue<string>;
  display: ProvenancedValue<string>;
  search: ProvenancedValue<string>;
  disciplines: Array<ProvenancedValue<DisciplineTag>>;
} {
  const display = cleanDisplayTitle(official.value);
  return {
    official,
    display: { value: display, provenance: [inferenceProvenance] },
    search: { value: normalizeSearchTitle(display), provenance: [inferenceProvenance] },
    disciplines: disciplineTagsForTitle(display).map((value) => ({ value, provenance: [inferenceProvenance] })),
  };
}

export interface InternshipIdentityInput {
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
  company: string;
  companyId?: string;
  title: string;
  location: string;
  season: string;
  seasonEvidenceStatus?: 'explicit' | 'inferred' | 'unspecified';
  content?: string;
  workMode?: WorkMode;
  evidenceSource?: EvidenceSource;
}

function seasonParts(value: string): { term?: 'spring' | 'summer' | 'fall' | 'winter'; year?: number } {
  const match = /\b(spring|summer|fall|winter)-(20\d{2})\b/i.exec(value);
  return match ? { term: match[1]!.toLowerCase() as 'spring' | 'summer' | 'fall' | 'winter', year: Number(match[2]) } : {};
}

function programType(title: string, provenance: FieldProvenance): ProvenancedValue<InternshipIdentity['programType']['value']> {
  const value = /\bco[ -]?op\b/i.test(title) ? 'co-op'
    : /\bapprenticeship\b/i.test(title) ? 'apprenticeship'
      : /\bnew[ -]?grad(?:uate)?\b/i.test(title) ? 'new-grad'
        : /\bentry[ -]?level\b/i.test(title) ? 'entry-level' : 'internship';
  return { value, provenance: [{ ...provenance, evidenceCode: `program-type-${value}` }] };
}

// A sentence carries the audience statement; a segment (list punctuation) carries
// one alternative. Splitting on both keeps "MS preferred, BS required" from
// reading its requirement clause as a preference.
const EDUCATION_SENTENCE_SPLIT = /\s*\n+\s*|(?<=[.!?])\s+/u;
const EDUCATION_SEGMENT_SPLIT = /\s*[;|]\s*|\s*,\s*|\s+\/\s+/u;
/** Text that demotes a degree to a nice-to-have; it never states who may apply. */
const DEGREE_PREFERRED_ONLY = /\b(?:preferred|preferably|a plus|nice to have|desirable|ideally|bonus|advantage(?:ous)?)\b/iu;
/** Text that withdraws the requirement instead of stating an audience. */
const DEGREE_WAIVED = /\b(?:not required|need not|no\s+(?:[\w’'-]+\s+){0,3}degree\s+(?:is\s+)?required)\b/iu;
/** Evidence that a bare degree word states an audience rather than an action. */
const DEGREE_CONTEXT = /\b(?:degrees?|program(?:me)?s?|students?|candidates?|studies|thesis|course(?:work)?|standing|education|qualifications?|pursuing|enrolled|enrolment|enrollment|open to|eligible|eligibility|requirements?|required|must|class of|applicants?)\b/iu;

// Case matters for the two-letter forms: "5 ms latency" is not a Master's, and
// "our MA office" is not a degree. A lowercase form only counts with degree
// context, and a period-separated form keeps its own spelling.
const DEGREE_NOUN = String.raw`degrees?|program(?:me)?s?|students?|candidates?|studies|thesis|course(?:work)?|level`;
const EDUCATION_AUDIENCE_PATTERNS: Record<EducationLevel, readonly RegExp[]> = {
  undergraduate: [
    /\b(?:undergrad(?:uate)?s?|bachelor(?:['’]s|s)?(?:\s+degree)?|college students?|university students?|four[ -]?year degree|4[ -]?year degree)\b/iu,
    /(?<![\w.])(?:BSc|BS|B\.S\.|BA|B\.A\.)(?![\w.])/u,
    new RegExp(String.raw`(?<![\w.])(?:bsc|bs|ba)(?![\w.])\s+(?:${DEGREE_NOUN}|in\s+\w+)`, 'iu'),
  ],
  masters: [
    new RegExp(String.raw`\bmaster['’]s\s+(?:${DEGREE_NOUN}|of\s+\w+|in\s+\w+)`, 'iu'),
    new RegExp(String.raw`\bmasters\s+(?:${DEGREE_NOUN}|of\s+\w+|in\s+\w+)`, 'iu'),
    new RegExp(String.raw`\bmaster\s+(?:of|${DEGREE_NOUN})`, 'iu'),
    new RegExp(String.raw`\bgraduate\s+(?:students?|program(?:me)?s?|degree|level|coursework)`, 'iu'),
    /(?<![\w.])(?:MSc|MS|M\.S\.)(?![\w.])/u,
    /(?<![\w.])(?:MA|M\.A\.)(?![\w.])/u,
    new RegExp(String.raw`(?<![\w.])(?:msc|ms|ma)(?![\w.])\s+(?:${DEGREE_NOUN}|in\s+\w+)`, 'iu'),
  ],
  mba: [/\bm\.?b\.?a\.?s?\b/iu],
  doctoral: [/\b(?:ph\.?\s?d\.?(?!\w)|doctorate|doctoral|doctorates)\b/iu],
};
/**
 * A degree word with nothing after it. "Master the team's domain" and "Master's
 * the team's domain" are instructions, so an unqualified form only counts when
 * the next token continues a degree phrase and the sentence states an audience.
 */
const MASTERS_UNQUALIFIED = /(?<![\w.'’])master['’]?s?\b/giu;
const MASTERS_CONTINUATION = new RegExp(String.raw`^\s*(?:$|[,;)]|\/|or\b|and\b|in\b|of\b|preferred\b|required\b|${DEGREE_NOUN})`, 'iu');

function unqualifiedMastersAudience(segment: string, sentenceHasContext: boolean): boolean {
  for (const match of segment.matchAll(MASTERS_UNQUALIFIED)) {
    const index = match.index ?? 0;
    if (!MASTERS_CONTINUATION.test(segment.slice(index + match[0].length))) continue;
    // "(Master's)" labels a level; a bare mention needs the sentence to say why.
    if (sentenceHasContext || segment.slice(0, index).trimEnd().endsWith('(')) return true;
  }
  return false;
}

/**
 * The levels an employer says may apply, not every degree word on the page.
 * Descriptions use these words as ordinary English too — "Master the team's
 * domain", "Master's degree preferred", "No Master's degree is required" — and
 * none of those turns away an undergraduate. Over-reporting a level hides a role
 * the reader could apply to, so an unclear mention is dropped, not guessed.
 */
export function educationAudienceLevels(value: string): EducationLevel[] {
  if (!value) return [];
  const levels = new Set<EducationLevel>();
  for (const sentence of value.split(EDUCATION_SENTENCE_SPLIT)) {
    if (!sentence.trim()) continue;
    const sentenceHasContext = DEGREE_CONTEXT.test(sentence);
    for (const segment of sentence.split(EDUCATION_SEGMENT_SPLIT)) {
      if (!segment.trim() || DEGREE_PREFERRED_ONLY.test(segment) || DEGREE_WAIVED.test(segment)) continue;
      for (const [level, patterns] of Object.entries(EDUCATION_AUDIENCE_PATTERNS) as Array<[EducationLevel, readonly RegExp[]]>) {
        if (patterns.some((pattern) => pattern.test(segment))) levels.add(level);
      }
      if (unqualifiedMastersAudience(segment, sentenceHasContext)) levels.add('masters');
    }
  }
  return [...levels].sort();
}

function educationEvidence(content: string, provenance: FieldProvenance): EducationAudience {
  const levels = educationAudienceLevels(content);
  return mergeEducationEvidence([{ ...(levels.length ? { levels } : {}), provenance: [provenance] }]);
}

function locationParts(value: string): string[] {
  return [...new Set(value.split(/\s+\/\s+|;|\|/).map((item) => item.trim()).filter(Boolean))];
}

function atsEvidence(sourceId: string): EvidenceSource {
  return /^(?:shadow-)?(?:greenhouse|lever|ashby|workday|bytedance)-/i.test(sourceId) ? 'official-ats' : 'reviewed-community';
}

/**
 * Builds the descriptive identity consumed by catalog grouping and filtering.
 * Only row/title/content signals are used; missing education or season evidence
 * remains explicitly unspecified instead of being guessed from a role title.
 */
export function buildInternshipIdentity(input: InternshipIdentityInput): InternshipIdentity {
  const source = input.evidenceSource ?? atsEvidence(input.sourceId);
  const field = (evidenceCode: string, fieldSource = source): FieldProvenance => ({
    source: fieldSource,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    evidenceCode,
    observedAt: input.observedAt,
  });
  const inference = (evidenceCode: string): FieldProvenance => field(evidenceCode, 'deterministic-inference');
  const officialTitle: ProvenancedValue<string> = { value: input.title, provenance: [field('title')] };
  const title = deriveTitleFields(officialTitle, inference('title-derived-fields-v1'));
  const season = seasonParts(input.season);
  const seasonStatus = input.seasonEvidenceStatus
    ?? (season.term && season.year ? 'inferred' : 'unspecified');
  const seasonProvenance = [field(seasonStatus === 'explicit' ? 'season-explicit' : 'season-derived')];
  const content = input.content ?? '';
  const education = educationEvidence(content, field('education-requirement'));
  const locations = locationParts(input.location).map((name) => ({
    name,
    workMode: input.workMode ?? (/remote/i.test(name) ? 'remote' : /hybrid/i.test(name) ? 'hybrid' : /on.?site|in.?person/i.test(name) ? 'onsite' : 'unspecified') as WorkMode,
    provenance: [field('location')],
  }));
  return {
    company: {
      canonicalId: input.companyId ?? canonicalCompanyKey(input.company),
      displayName: { value: input.company, provenance: [field('company')] },
    },
    programType: programType(input.title, inference('program-type')),
    season: { ...season, evidenceStatus: seasonStatus, provenance: seasonProvenance },
    education,
    title: { official: title.official, display: title.display, search: title.search },
    disciplines: title.disciplines,
    locations,
  };
}
