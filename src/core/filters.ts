import type { EducationLevel, RawListing } from '../types.js';
import { educationLevels } from '../../shared/education-display.js';
import { educationAudienceOf, educationExcludesLevel } from '../identity/enrichment.js';
import { employerCategories, employerCategory, type EmployerCategory } from './employers.js';

export const legacyJobCategories = ['ai-ml', 'grad', 'swe', 'quant', 'product', 'design'] as const;
export const expandedJobCategories = ['general-engineering', 'mechanical', 'electrical', 'aerospace', 'civil', 'chemical-materials', 'industrial-manufacturing', 'biomedical', 'environmental-energy', 'systems-test', 'technical-operations'] as const;
export const jobCategories = [...legacyJobCategories, ...expandedJobCategories] as const;
export type JobCategory = typeof jobCategories[number];
/** The initial public catalog deliberately stays focused on technical early-career roles. */
export const technicalJobCategories: JobCategory[] = ['ai-ml', 'swe', 'quant', 'product', 'design'];
export const jobFocuses = ['AI/ML', 'Cloud/Infra', 'Security', 'Data', 'Backend/API', 'Frontend/Mobile', 'Systems/Hardware', 'Quant/Fintech', 'Product', 'Design', 'SWE'] as const;
export type JobFocus = typeof jobFocuses[number];
export interface JobFilter {
  /** A job must match at least one included keyword or category when either list is supplied. */
  includeKeywords?: string[];
  includeCategories?: JobCategory[];
  /** Exclusions always win over inclusions. */
  excludeKeywords?: string[];
  excludeCategories?: JobCategory[];
  /** When supplied, a job must match one selected company bucket as well as any role or keyword filter. */
  includeEmployerCategories?: EmployerCategory[];
  /** Exclusions always win over employer-category inclusions. */
  excludeEmployerCategories?: EmployerCategory[];
  /** Hide listings whose source explicitly requires U.S. citizenship. */
  excludeUsCitizenshipRequired?: boolean;
  /**
   * The reader's own level. A role whose stated audience omits it is hidden; an
   * employer that never stated an audience is never hidden.
   */
  educationLevel?: EducationLevel;
  /** Explicit consent gate for roles that qualify only under the expanded policy. */
  includeExpandedTechnical?: boolean;
}

export function isEducationLevel(value: unknown): value is EducationLevel {
  return educationLevels.some((level) => level === value);
}

/** Fields any filterable listing carries; the education audience lives in its identity. */
export type FilterableListing = Pick<RawListing, 'company' | 'title' | 'location' | 'season' | 'requirements'>
  & { internshipIdentity?: unknown; roleMetadata?: unknown; technicalScope?: 'legacy' | 'expanded' };

export type FilterMatchReasonKind = 'category' | 'keyword' | 'company-type' | 'default-all-technical';
export interface FilterMatchReason { kind: FilterMatchReasonKind; label: string; }
export interface JobFilterEvaluation {
  matches: boolean;
  reasons: FilterMatchReason[];
  /** Exclusion details stay private; users only need to know they were enforced. */
  exclusionsApplied: boolean;
}

const categoryLabels: Record<JobCategory, string> = {
  'ai-ml': 'AI/ML', grad: 'Graduate roles', swe: 'Software engineering', quant: 'Quantitative', product: 'Product', design: 'Design',
  'general-engineering': 'Engineering', mechanical: 'Mechanical', electrical: 'Electrical', aerospace: 'Aerospace', civil: 'Civil', 'chemical-materials': 'Chemical & materials', 'industrial-manufacturing': 'Manufacturing', biomedical: 'Biomedical', 'environmental-energy': 'Environment & energy', 'systems-test': 'Systems & test', 'technical-operations': 'Technical operations',
};
const employerCategoryLabels: Record<EmployerCategory, string> = { faang: 'FAANG', startup: 'Startups', normal: 'Other companies' };

const patterns: Record<JobCategory, RegExp> = {
  'ai-ml': /\b(ai|artificial intelligence|machine learning|ml|data scien(?:ce|tist)|deep learning|nlp|computer vision|generative ai|llm)\b/i,
  grad: /\b(graduate|grad|master'?s|ph\.?d\.?|mba)\b/i,
  swe: /\b(software|swe|backend|frontend|full[ -]?stack|developer)\b/i,
  quant: /\b(quant|quantitative|trading|trader|research)\b/i,
  product: /\b(product manager|product management|pm)\b/i,
  design: /\b(design|ux|ui|user experience)\b/i,
  'general-engineering': /\b(?:engineering (?:intern|co-?op|rotation)|engineering rotation(?: intern)?|project engineer)\b/i,
  mechanical: /\b(?:mechanical|thermal|fluid(?:s| dynamics)?|hvac)\b/i,
  electrical: /\b(?:electrical|electronics?|rf|power systems?|instrumentation)\b/i,
  aerospace: /\b(?:aerospace|aerodynamic|propulsion|flight|space systems?)\b/i,
  civil: /\b(?:civil|structural|transportation|geotechnical|construction)\b/i,
  'chemical-materials': /\b(?:chemical|process engineer|materials?|polymers?|metallurgy|batter(?:y|ies))\b/i,
  'industrial-manufacturing': /\b(?:industrial|manufacturing|production|tooling|automation)\b/i,
  biomedical: /\b(?:biomedical|bioengineering|medical devices?)\b/i,
  'environmental-energy': /\b(?:environmental|renewable energy|utilities)\b/i,
  'systems-test': /\b(?:systems?|integration|test|validation|verification|reliability|safety|quality)\b/i,
  'technical-operations': /\b(?:engineering technician|technologist|cad|drafting|laboratory technician|technical apprenticeship)\b/i,
};
const focusPatterns: Array<[JobFocus, RegExp]> = [
  ['AI/ML', /\b(generative ai|gen ai|artificial intelligence|machine learning|\bml\b|llm|nlp|natural language|computer vision|deep learning)\b/i],
  ['Cloud/Infra', /\b(cloud|infrastructure|infra|platform|devops|site reliability|\bsre\b|distributed systems?|kubernetes|docker|networking|observability)\b/i],
  ['Security', /\b(security|cybersecurity|privacy|cryptograph|identity|authentication|authorization)\b/i],
  ['Data', /\b(data engineering|data engineer|analytics|business intelligence|\bbi\b|data warehouse|\betl\b)\b/i],
  ['Backend/API', /\b(back[- ]?end|api|microservices?|server[- ]?side|services?)\b/i],
  ['Frontend/Mobile', /\b(front[- ]?end|full[- ]?stack|web|ios|android|mobile|react)\b/i],
  ['Systems/Hardware', /\b(systems?|embedded|firmware|compiler|operating systems?|\bos\b|hardware)\b/i],
  ['Quant/Fintech', /\b(quant|quantitative|trading|trader|financial|fintech|risk)\b/i],
  ['Product', /\b(product manager|product management|\bpm\b)\b/i],
  ['Design', /\b(design|ux|ui|user experience)\b/i]
];

/**
 * Technical evidence the six coarse categories miss. Category patterns drive
 * user-facing filters, so they stay as they are; eligibility additionally
 * accepts a named technical domain.
 *
 * All three patterns match the role title and its classification context only,
 * never the company: "Palantir Technologies" must not make its marketing roles
 * technical.
 *
 * `strong` names a domain no other function shares, so it settles eligibility on
 * its own.
 */
const strongTechnicalPattern = new RegExp([
  String.raw`\b(?:software|swe|sde+|firmware|hardware|embedded|silicon|semiconductor|fpga|asic|vlsi|rtl|pcb)\b`,
  String.raw`\b(?:programming|programmer|developer|coding|compiler|algorithms?|computational|bioinformatics)\b`,
  String.raw`\b(?:computer (?:science|engineer(?:ing)?|vision)|(?:applied|research|data|computer) scientist)\b`,
  String.raw`\b(?:infrastructure|devops|\bsre\b|site reliability|kubernetes|observability|\biot\b|robotics|mechatronics)\b`,
  String.raw`\b(?:cloud|databases?|\bsql\b|nosql|distributed systems?|windows|linux|unix|macos)\b`,
  String.raw`\b(?:cyber ?security|infosec|appsec|cryptograph\w*|penetration test\w*)\b`,
  String.raw`\b(?:machine learning|deep learning|gen(?:erative)? ?ai|artificial intelligence|\bml\b|\bnlp\b|\bllm\b|inference)\b`,
  String.raw`\bdata (?:engineer\w*|analyst\w*|analytics|scien\w+|pipeline|platform|integration|extraction|warehouse|modeling)\b`,
  String.raw`\b(?:sdet|test automation|quality (?:assurance|engineer(?:ing)?)|technical staff)\b`,
  // Explicit technical delivery roles coordinate engineering work even when
  // the posting does not list a programming stack.
  String.raw`\btechnical (?:project|program) manage(?:ment|r)\b`,
  String.raw`\b(?:ios|android|front ?end|back ?end|full ?stack)\b`,
  // Quantitative finance is in scope, and its titles often also say "sales".
  String.raw`\b(?:quant|quantitative|trading|trader|algorithmic)\b`,
].join('|'), 'i');

/** Acronyms whose lowercase forms are ordinary English words, so case matters. */
const technicalAcronymPattern = /\b(?:IT|QA|BI|ETL|DBA)\b/;

/**
 * `qualified` evidence is technical only alongside a technical role word:
 * "Platform Engineer" is, "Platform Campaign" is not.
 */
const qualifiedTechnicalPattern = new RegExp([
  String.raw`\b(?:platform|systems?|network\w*|security|technolog\w+|analytics|business intelligence|\bqa\b|mobile|web)\b[^,|(]{0,24}\b(?:engineer\w*|developer|architect\w*|analyst\w*|administrator|administration|operations?|intern(?:ship)?s?|co-?op)\b`,
  String.raw`\b(?:engineer\w*|analyst\w*|intern(?:ship)?s?|co-?op)\b[^,|(]{0,24}\b(?:platform|systems?|network\w*|security|technolog\w+|analytics|business intelligence)\b`,
].join('|'), 'i');

/**
 * A business function outranks evidence it merely shares a word with: "Talent
 * Acquisition Technology Intern" recruits and "Platform Campaign Intern"
 * markets, while a strong signal such as "Data Science Intern (Customer
 * Success)" still stands.
 */
const nontechnicalFunctionPattern = new RegExp([
  String.raw`\b(?:talent acquisition|recruit\w*|people operations|human resources|\bhr\b)\b`,
  String.raw`\b(?:marketing|campaign|brand|advertis\w*|social media|public relations|communications?)\b`,
  String.raw`\b(?:sales|account executive|business development|partnerships?|customer (?:success|advocacy|service|experience))\b`,
  String.raw`\b(?:supply chain|logistics|procurement|purchasing|warehouse operations|facilities|real estate)\b`,
  String.raw`\b(?:legal|paralegal|compliance officer|accounting|payroll|\btax\b|audit(?:or|ing)?)\b`,
  String.raw`\b(?:event|concierge|hospitality|volunteer|fundrais\w*|philanthrop\w*)\b`,
].join('|'), 'i');

function terms(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>) {
  return `${listing.company} ${listing.title} ${listing.location} ${listing.season}`.replace(/\s+/g, ' ').trim();
}
function matchesKeyword(value: string, keyword: string) { return keyword.trim() !== '' && value.toLowerCase().includes(keyword.trim().toLowerCase()); }
function matchesCategory(value: string, category: JobCategory) { return patterns[category].test(value); }

export function classifyJob(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>): JobCategory[] {
  const value = terms(listing);
  // Existing categories retain their whole-listing behavior. Engineering scope
  // relies on title evidence, never an employer's boilerplate or location.
  return jobCategories.filter((category) => matchesCategory(legacyJobCategories.includes(category as typeof legacyJobCategories[number]) ? value : listing.title, category));
}
/**
 * Tools and practices that only appear in technical job text. Individually weak
 * — a marketing post can mention SQL — so these only ever accumulate a score for
 * a role whose title decided nothing.
 */
const technicalStackPattern = new RegExp([
  String.raw`\b(?:python|java|javascript|typescript|kotlin|swift|golang|scala|matlab|verilog|vhdl)\b`,
  String.raw`(?:\bc\+\+|\bc#|\bobjective-c\b|\.net\b)`,
  String.raw`\b(?:react|angular|vue|node(?:\.?js)?|django|flask|spring boot|rails)\b`,
  String.raw`\b(?:docker|terraform|ansible|jenkins|ci/cd|git(?:hub|lab)?|jira)\b`,
  String.raw`\b(?:aws|gcp|azure|lambda|s3|ec2|serverless|microservices?)\b`,
  String.raw`\b(?:pytorch|tensorflow|scikit|pandas|numpy|spark|hadoop|kafka|airflow|dbt|tableau|power bi)\b`,
  String.raw`\b(?:rest(?:ful)? api|graphql|grpc|webhooks?|sdk|\bapi\b|\bcli\b)\b`,
  String.raw`\b(?:data structures?|object[- ]oriented|unit test\w*|code review|debugg\w*|refactor\w*|version control)\b`,
  String.raw`\b(?:relational database|schema design|query optimization|latency|throughput|scalab\w+)\b`,
].join('|'), 'i');

export type TechnicalBasis = 'title' | 'business-function' | 'description' | 'no-evidence';

export interface TechnicalAssessment {
  technical: boolean;
  basis: TechnicalBasis;
  /** Present only when the title was inconclusive and description text decided it. */
  score?: number;
  signals?: string[];
}

/** Distinct matches only: one word repeated twenty times is still one signal. */
function distinctMatches(value: string, pattern: RegExp): string[] {
  return [...new Set([...value.matchAll(new RegExp(pattern.source, 'gi'))].map((match) => match[0].toLowerCase()))];
}

const DESCRIPTION_SCORE_THRESHOLD = 4;
/**
 * Company boilerplate says "we build silicon and software", so domain words
 * alone once made a truck driver technical. Named tools and practices appear in
 * what a technical role actually asks of a candidate, so an uncertain role must
 * show several of them.
 */
const DESCRIPTION_STACK_MINIMUM = 2;

/**
 * Eligibility reads the role, never the employer or its city: not every job at
 * "Jump Trading Group" is quantitative, and not every job in "Research Triangle
 * Park" is research. User-facing keyword filters still match the whole listing.
 *
 * A title that names a domain, or names a business function, settles the question
 * by itself. Only a title that decides nothing falls through to scoring the
 * description, so the cost and the false-positive surface of keyword counting
 * stay confined to genuinely uncertain roles.
 */
export function assessTechnicalRole(
  listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>,
  description?: string,
): TechnicalAssessment {
  if (strongTechnicalPattern.test(listing.title) || technicalAcronymPattern.test(listing.title)) {
    return { technical: true, basis: 'title' };
  }
  if (nontechnicalFunctionPattern.test(listing.title)) return { technical: false, basis: 'business-function' };
  const role = { company: '', title: listing.title, location: '', season: '' };
  if (classifyJob(role).some((category) => technicalJobCategories.includes(category))
    || qualifiedTechnicalPattern.test(listing.title)) {
    return { technical: true, basis: 'title' };
  }
  if (classifyJob(role).some((category) => expandedJobCategories.includes(category as typeof expandedJobCategories[number]))) {
    return { technical: true, basis: 'title' };
  }
  const text = (description ?? '').trim();
  if (!text) return { technical: false, basis: 'no-evidence' };
  const domain = distinctMatches(text, strongTechnicalPattern);
  const stack = distinctMatches(text, technicalStackPattern);
  const business = distinctMatches(text, nontechnicalFunctionPattern);
  const score = Math.min(domain.length, 3) * 3 + Math.min(stack.length, 6) - business.length * 2;
  return {
    technical: score >= DESCRIPTION_SCORE_THRESHOLD && stack.length >= DESCRIPTION_STACK_MINIMUM,
    basis: 'description',
    score,
    signals: [...domain.slice(0, 3), ...stack.slice(0, 6)],
  };
}

export function technicalScopeFor(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>, description?: string): 'legacy' | 'expanded' | undefined {
  if (!assessTechnicalRole(listing, description).technical) return undefined;
  const categories = classifyJob(listing);
  return categories.some((category) => expandedJobCategories.includes(category as typeof expandedJobCategories[number]))
    && !categories.some((category) => technicalJobCategories.includes(category as typeof technicalJobCategories[number])) ? 'expanded' : 'legacy';
}

export function isTechnicalJob(listing: Pick<RawListing, 'company' | 'title' | 'location' | 'season'>, description?: string) {
  return assessTechnicalRole(listing, description).technical;
}

/** Deterministic title-keyword classification for compact notification context; it does not infer qualifications. */
export function inferJobFocuses(listing: Pick<RawListing, 'title'>): JobFocus[] {
  const value = listing.title.replace(/\s+/g, ' ').trim();
  const matched = focusPatterns.filter(([, pattern]) => pattern.test(value)).map(([focus]) => focus);
  return matched.length ? matched : /\b(software|swe|engineer|developer)\b/i.test(value) ? ['SWE'] : [];
}

export function evaluateJobFilter(listing: FilterableListing, filter?: JobFilter): JobFilterEvaluation {
  const value = terms(listing);
  const categories = classifyJob(listing);
  const companyCategory = employerCategory(listing.company);
  const activeFilter = filter ?? {};
  if (listing.technicalScope === 'expanded' && !activeFilter.includeExpandedTechnical) return { matches: false, reasons: [], exclusionsApplied: false };
  const requirements = listing.requirements ?? {
    requiresUsCitizenship: /🇺🇸|\b(?:requires?|must be)\s+(?:a\s+)?(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i.test(value),
    advancedDegreeRequired: /🎓|\b(?:advanced degree|master'?s|ph\.?d\.?|mba)\b/i.test(value)
  };
  const audience = educationAudienceOf(listing);
  const excludedByAudience = activeFilter.educationLevel
    ? educationExcludesLevel({
      levels: audience?.levels, evidenceStatus: audience?.evidenceStatus,
      advancedDegreeRequired: requirements.advancedDegreeRequired, level: activeFilter.educationLevel,
    })
    : false;
  const exclusionsApplied = Boolean(activeFilter.excludeKeywords?.length || activeFilter.excludeCategories?.length || activeFilter.excludeEmployerCategories?.length || activeFilter.excludeUsCitizenshipRequired || activeFilter.educationLevel);
  const excluded = [...(activeFilter.excludeKeywords ?? []).map((keyword) => matchesKeyword(value, keyword)), ...(activeFilter.excludeCategories ?? []).map((category) => categories.includes(category)), ...(activeFilter.excludeEmployerCategories ?? []).map((category) => companyCategory === category), Boolean(activeFilter.excludeUsCitizenshipRequired && requirements.requiresUsCitizenship), excludedByAudience].some(Boolean);
  if (excluded) return { matches: false, reasons: [], exclusionsApplied };
  const keywordReasons = (activeFilter.includeKeywords ?? []).filter((keyword) => matchesKeyword(value, keyword)).map((keyword) => ({ kind: 'keyword' as const, label: keyword.trim() }));
  const categoryReasons = (activeFilter.includeCategories ?? []).filter((category) => categories.includes(category)).map((category) => ({ kind: 'category' as const, label: categoryLabels[category] }));
  const companyReasons = (activeFilter.includeEmployerCategories ?? []).filter((category) => companyCategory === category).map((category) => ({ kind: 'company-type' as const, label: employerCategoryLabels[category] }));
  const hasRoleInclusions = Boolean(activeFilter.includeKeywords?.length || activeFilter.includeCategories?.length);
  const hasCompanyInclusions = Boolean(activeFilter.includeEmployerCategories?.length);
  const matches = (!hasRoleInclusions || categoryReasons.length + keywordReasons.length > 0) && (!hasCompanyInclusions || companyReasons.length > 0);
  if (!matches) return { matches: false, reasons: [], exclusionsApplied };
  const reasons: FilterMatchReason[] = [...categoryReasons, ...keywordReasons, ...companyReasons];
  if (!hasRoleInclusions) reasons.unshift({ kind: 'default-all-technical', label: 'All technical roles' });
  return { matches: true, reasons: reasons.filter((reason, index) => reasons.findIndex((candidate) => candidate.kind === reason.kind && candidate.label.toLowerCase() === reason.label.toLowerCase()) === index), exclusionsApplied };
}

export function matchesJobFilter(listing: FilterableListing, filter?: JobFilter) {
  return evaluateJobFilter(listing, filter).matches;
}

function stringList(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) throw new Error(`jobFilter.${name} must be an array of non-empty strings`);
  return value;
}
function categoryList(value: unknown, name: string): JobCategory[] | undefined {
  const values = stringList(value, name);
  if (values?.some((value) => !jobCategories.includes(value as JobCategory))) throw new Error(`jobFilter.${name} contains an unsupported category`);
  return values as JobCategory[] | undefined;
}
function employerCategoryList(value: unknown, name: string): EmployerCategory[] | undefined {
  const values = stringList(value, name);
  if (values?.some((value) => !employerCategories.includes(value as EmployerCategory))) throw new Error(`jobFilter.${name} contains an unsupported employer category`);
  return values as EmployerCategory[] | undefined;
}
function booleanValue(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`jobFilter.${name} must be a boolean`);
  return value;
}
function educationLevelValue(value: unknown): EducationLevel | undefined {
  if (value === undefined) return undefined;
  if (!isEducationLevel(value)) throw new Error(`jobFilter.educationLevel must be one of ${educationLevels.join(', ')}`);
  return value;
}

export function parseJobFilter(value: unknown): JobFilter | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('jobFilter must be an object');
  const config = value as Record<string, unknown>;
  const includeKeywords = stringList(config.includeKeywords, 'includeKeywords');
  const includeCategories = categoryList(config.includeCategories, 'includeCategories');
  const excludeKeywords = stringList(config.excludeKeywords, 'excludeKeywords');
  const excludeCategories = categoryList(config.excludeCategories, 'excludeCategories');
  const includeEmployerCategories = employerCategoryList(config.includeEmployerCategories, 'includeEmployerCategories');
  const excludeEmployerCategories = employerCategoryList(config.excludeEmployerCategories, 'excludeEmployerCategories');
  const excludeUsCitizenshipRequired = booleanValue(config.excludeUsCitizenshipRequired, 'excludeUsCitizenshipRequired');
  const educationLevel = educationLevelValue(config.educationLevel);
  const includeExpandedTechnical = booleanValue(config.includeExpandedTechnical, 'includeExpandedTechnical');
  const selectedExpandedCategory = Boolean(includeCategories?.some((category) => expandedJobCategories.includes(category as typeof expandedJobCategories[number])));
  return {
    ...(includeKeywords !== undefined ? { includeKeywords } : {}),
    ...(includeCategories !== undefined ? { includeCategories } : {}),
    ...(excludeKeywords !== undefined ? { excludeKeywords } : {}),
    ...(excludeCategories !== undefined ? { excludeCategories } : {}),
    ...(includeEmployerCategories !== undefined ? { includeEmployerCategories } : {}),
    ...(excludeEmployerCategories !== undefined ? { excludeEmployerCategories } : {}),
    ...(excludeUsCitizenshipRequired !== undefined ? { excludeUsCitizenshipRequired } : {}),
    ...(educationLevel !== undefined ? { educationLevel } : {}),
    ...((includeExpandedTechnical || selectedExpandedCategory) ? { includeExpandedTechnical: true } : {}),
  };
}
