import { createHash } from 'node:crypto';
import { inferJobFocuses } from './core/filters.js';
import { catalogSourceClasses, type CatalogSource } from './catalog-fields.js';
import { catalogVisibleAt, compareCatalogRecency } from './catalog-recency.js';
import { canonicalCompanyKey } from './core/normalize.js';
import { publicApplicationUrl } from './core/application-url.js';
import { employerCategory, type EmployerCategory } from './core/employers.js';
import { occurrenceProvenance } from './sources/provenance.js';
import type { Internship } from './types.js';
import { allDisciplineStyles, disciplineKey, disciplineSearchVariants } from '../shared/discipline-display.js';

const DISCIPLINE_FILTER_VALUES: Record<string, string> = Object.fromEntries(
  allDisciplineStyles().map(({ tag, style }) => [tag, style.filterValue]),
);

function disciplinesMatch(available: string[], requested: string[]): boolean {
  const availableKeys = available.map(disciplineKey);
  return requested.some((value) => availableKeys.includes(disciplineKey(value)));
}
export { disciplineSearchVariants };

export type CatalogGroupKind = 'program-group' | 'employer-release' | 'individual';
export type EducationEvidence = 'explicit' | 'inferred' | 'unspecified' | 'conflicting';

export interface CatalogEducationSummary {
  levels: string[];
  evidence: EducationEvidence;
  label: string;
}

export interface CatalogGroupRow {
  groupId: string;
  kind: CatalogGroupKind;
  company: string;
  seasons: string[];
  education: CatalogEducationSummary[];
  roleCount: number;
  /** Counts only explicitly classified roles; legacy-unclassified roles are not inferred. */
  unconfirmedRoleCount: number;
  titles: string[];
  disciplines: string[];
  locations: string[];
  workModes: string[];
  createdAt: string;
  updatedAt: string;
  hasNewRoles: boolean;
  roleIds: string[];
  /** A representative full-fidelity role keeps collapsed cards informative. */
  featuredRole: CatalogGroupRole;
  compensations: string[];
}

export interface CatalogGroupDetails {
  group: CatalogGroupRow;
  roles: CatalogGroupRole[];
}

export interface CatalogProjectionPage {
  groups: CatalogGroupDetails[];
  cursor?: string;
}

export interface CatalogGroupRole {
  jobId: string;
  company: string;
  title: string;
  location: string;
  locations: string[];
  visibleAt: string;
  season: string;
  education: CatalogEducationSummary;
  disciplines: string[];
  workModes: string[];
  sourceCredibility: 'official' | 'corroborated' | 'community' | 'unspecified';
  provenanceLabels: string[];
  detailUrl: string;
  officialApplyUrl: string;
  applicationUrlValidated: boolean;
  open: boolean;
  employerCategory: EmployerCategory;
  requiresUsCitizenship: boolean;
  advancedDegreeRequired: boolean;
  compensation: Internship['compensation'];
  housing?: Internship['housing'];
  workAuthorizationStatus: NonNullable<Internship['workAuthorizationStatus']>;
  applicationDeadline?: Internship['applicationDeadline'];
  graduationWindow?: Internship['graduationWindow'];
  programType?: Internship['programType'];
  firstSeenAt: string;
  lastSeenAt: string;
  sourceReferences: Internship['sourceReferences'];
  applicationUrlValidatedAt?: string;
  invalidApplicationUrl?: string;
  postingIdentityStatus?: Internship['postingIdentityStatus'];
}

export interface CatalogGroupFilter {
  query?: string;
  source?: CatalogSource;
  disciplines?: string[];
  seasons?: string[];
  educationLevels?: string[];
  workModes?: string[];
  locations?: string[];
  status?: 'open' | 'closed';
  employerCategories?: EmployerCategory[];
  hideUsCitizenshipRequired?: boolean;
  hideAdvancedDegreeRequired?: boolean;
  /** Keep only roles whose stored compensation text is non-empty. */
  hasCompensation?: boolean;
  postingIdentityConfirmedOnly?: boolean;
}

/** A durable release already contains the job set matched for one user. */
export interface CatalogRelease {
  releaseId: string;
  userId: string;
  jobIds: string[];
  newJobIds: string[];
  createdAt: string;
}

type StructuredIdentity = {
  canonicalCompanyId?: string;
  canonicalCompanyName?: string;
  company?: { canonicalId?: string; id?: string; displayName?: string | { value?: string } };
  programType?: string | { value?: string };
  season?: string | { term?: string; year?: number | string; evidence?: string; evidenceStatus?: string };
  educationAudience?: {
    levels?: string[];
    evidence?: string;
    evidenceStatus?: string;
  };
  education?: {
    levels?: string[];
    evidence?: string;
    evidenceStatus?: string;
  };
  title?: { official?: string | { value?: string }; display?: string | { value?: string } };
  disciplineTags?: Array<string | { value?: string }>;
  disciplines?: Array<string | { value?: string }>;
  locations?: Array<string | { name?: string; displayName?: string; workMode?: string }>;
  workModes?: string[];
};

type CatalogJob = Internship & { internshipIdentity?: StructuredIdentity; identity?: StructuredIdentity };
export type BuiltGroup = { row: CatalogGroupRow; jobs: Internship[] };

/** The role count that makes an employer's day a card rather than separate roles. */
export const RELEASE_MINIMUM_ROLES = 4;
const compact = (value: string) => value.trim().replace(/\s+/g, ' ');
const folded = (value: string) => compact(value).toLocaleLowerCase('en-US');
const unique = (values: string[]) => [...new Map(values.filter(Boolean).map((value) => [folded(value), compact(value)])).values()];
const timestamp = (job: Internship) => Date.parse(catalogVisibleAt(job));
const identityFor = (job: Internship) => (job as CatalogJob).internshipIdentity ?? (job as CatalogJob).identity;

function companyKey(job: Internship) {
  const identity = identityFor(job);
  const value = identity?.canonicalCompanyId ?? identity?.company?.canonicalId ?? identity?.company?.id ?? job.company;
  const key = canonicalCompanyKey(value);
  return key || undefined;
}

function displayCompany(job: Internship) {
  const structured = identityFor(job)?.canonicalCompanyName ?? provenancedText(identityFor(job)?.company?.displayName);
  return compact(structured ?? job.company).replace(/^[^\p{L}\p{N}]+/u, '').trim() || compact(structured ?? job.company);
}

function provenancedText(value: string | { value?: string } | undefined) {
  return typeof value === 'string' ? value : value?.value;
}

function titleFor(job: Internship) {
  const title = identityFor(job)?.title;
  return compact(provenancedText(title?.display) ?? provenancedText(title?.official) ?? job.title);
}

function seasonFor(job: Internship) {
  const season = identityFor(job)?.season;
  if (typeof season === 'string') return compact(season);
  if (season?.term && season.year) return `${compact(season.term)}-${season.year}`;
  return compact(job.season);
}

function evidence(value: string | undefined): EducationEvidence {
  return value === 'explicit' || value === 'inferred' || value === 'conflicting' ? value : 'unspecified';
}

export function catalogEducation(job: Internship): CatalogEducationSummary {
  const identity = identityFor(job);
  const audience = identity?.educationAudience ?? identity?.education;
  const levels = unique(audience?.levels ?? []).sort((left, right) => left.localeCompare(right));
  const status = evidence(audience?.evidenceStatus ?? audience?.evidence);
  if (status === 'conflicting') return { levels, evidence: status, label: 'Education requirements conflict across sources' };
  if (status === 'unspecified' || levels.length === 0) {
    return { levels: [], evidence: 'unspecified', label: 'Education level not specified by employer' };
  }
  return { levels, evidence: status, label: levels.join(' + ') };
}

function safeProgramKey(job: Internship) {
  const identity = identityFor(job);
  const company = companyKey(job);
  const season = seasonFor(job);
  const education = catalogEducation(job);
  const programType = provenancedText(identity?.programType);
  const seasonIdentity = identity?.season;
  const explicitSeason = typeof seasonIdentity === 'object'
    && (seasonIdentity.evidenceStatus ?? seasonIdentity.evidence) === 'explicit'
    && Boolean(seasonIdentity.term && seasonIdentity.year);
  // Program rows make an affirmative product claim. Legacy or evidence-poor
  // roles stay individual until structured enrichment explicitly supports the
  // audience dimensions; employer bursts remain a separate, factual grouping.
  if (!identity || !company || !season || !programType || !explicitSeason
    || education.evidence !== 'explicit' || education.levels.length === 0) return undefined;
  return `${company}\u0000${folded(programType)}\u0000${folded(season)}\u0000${education.evidence}\u0000${education.levels.map(folded).sort().join(',')}`;
}

function locationsFor(job: Internship) {
  if (job.locations?.length) return unique(job.locations);
  const structured = identityFor(job)?.locations?.map((location) => typeof location === 'string' ? location : location.displayName ?? location.name ?? '') ?? [];
  return unique(structured.length ? structured : job.location.split(/\s*(?:;|\||\n)\s*/));
}

function workModesFor(job: Internship) {
  const identity = identityFor(job);
  const sourceModes = job.sourceReferences.map((reference) => reference.workMode ?? '').filter(Boolean);
  const locationModes = identity?.locations?.map((location) => typeof location === 'string' ? '' : location.workMode ?? '').filter(Boolean) ?? [];
  const declared = identity?.workModes ?? (locationModes.length ? locationModes : sourceModes);
  if (declared.length) return unique(declared);
  const text = `${job.location} ${job.title}`;
  return [/\bremote\b/i.test(text) ? 'remote' : '', /\bhybrid\b/i.test(text) ? 'hybrid' : '', /\b(?:on.?site|in.?person)\b/i.test(text) ? 'onsite' : ''].filter(Boolean);
}

function disciplinesFor(job: Internship) {
  const identity = identityFor(job);
  const structured = identity?.disciplineTags ?? identity?.disciplines;
  return unique(structured?.map((item) => {
    const value = typeof item === 'string' ? item : item.value ?? '';
    return DISCIPLINE_FILTER_VALUES[value] ?? value;
  }).filter(Boolean) ?? inferJobFocuses(job));
}

/** The drop a role belongs to: one employer, one day. The identity is derived
 * from those two facts alone, so the feed's card and an alert about the same drop
 * agree even though each sees only part of the day's roles. */
export function employerDropKey(job: Internship) {
  const company = companyKey(job);
  const visibleAt = catalogVisibleAt(job);
  if (!company || !Number.isFinite(Date.parse(visibleAt))) return undefined;
  return `${company}\u0000${visibleAt.slice(0, 10)}`;
}

/** The feed card id for a role's employer drop; alerts reuse it for the deep link. */
export function employerDropGroupId(job: Internship) {
  const key = employerDropKey(job);
  return key ? `employer-release-${createHash('sha256').update(key).digest('base64url').slice(0, 20)}` : undefined;
}

function groupId(kind: CatalogGroupKind, jobs: Internship[]) {
  const chronological = [...jobs].sort((left, right) => timestamp(left) - timestamp(right));
  // A release can contain roles that also have a structured program identity.
  // Keep its namespace tied to the observed employer drop so a remaining
  // program role cannot overwrite the release in a materialized projection.
  const programKey = kind === 'employer-release' ? undefined : safeProgramKey(chronological[0]!);
  const stable = programKey
    ? programKey
    : kind === 'employer-release'
      ? employerDropKey(chronological[0]!) ?? `${companyKey(chronological[0]!) ?? chronological[0]!.company}\u0000${catalogVisibleAt(chronological[0]!)}`
      : chronological[0]!.jobId;
  if (kind === 'employer-release' && !programKey) return `employer-release-${createHash('sha256').update(stable).digest('base64url').slice(0, 20)}`;
  return `${programKey ? 'program' : kind}-${createHash('sha256').update(stable).digest('base64url').slice(0, 20)}`;
}

function summarize(kind: CatalogGroupKind, jobs: Internship[], stableGroupId?: string): CatalogGroupRow {
  const sorted = [...jobs].sort(compareCatalogRecency);
  const chronological = [...jobs].sort((left, right) => timestamp(left) - timestamp(right));
  const createdAt = sorted.reduce((oldest, job) => catalogVisibleAt(job) < oldest ? catalogVisibleAt(job) : oldest, catalogVisibleAt(sorted[0]!));
  const updatedAt = catalogVisibleAt(sorted[0]!);
  const structuredCompany = sorted.find((job) => identityFor(job)?.canonicalCompanyName || provenancedText(identityFor(job)?.company?.displayName));
  const company = displayCompany(structuredCompany ?? chronological[0]!);
  return {
    groupId: stableGroupId ?? groupId(kind, sorted), kind, company,
    seasons: unique(sorted.map(seasonFor)),
    education: unique(sorted.map((job) => JSON.stringify(catalogEducation(job)))).map((item) => JSON.parse(item) as CatalogEducationSummary),
    roleCount: sorted.length,
    unconfirmedRoleCount: sorted.filter((job) => job.postingIdentityStatus === 'unconfirmed').length,
    titles: unique(sorted.map(titleFor)).slice(0, 3),
    disciplines: unique(sorted.flatMap(disciplinesFor)).slice(0, 6),
    locations: unique(sorted.flatMap(locationsFor)),
    workModes: unique(sorted.flatMap(workModesFor)),
    createdAt, updatedAt, hasNewRoles: updatedAt !== createdAt,
    roleIds: sorted.map((job) => job.jobId),
    featuredRole: catalogGroupRole(sorted[0]!),
    compensations: unique(sorted.map((job) => job.compensation.raw)),
  };
}

/** Groups each employer's roles into drops. A drop is one employer's posting day:
 * every role that employer makes visible in a UTC day belongs to the same card,
 * and four roles make a drop a release card while a smaller drop stays
 * individual, so an employer's two-role program still reads as a program card.
 *
 * The window used to be measured between consecutive roles (eight seconds, then
 * ten minutes), which split one employer's batch into several cards: Visa's 15
 * roles arrived in five waves and rendered as 8 cards, including a group that
 * duplicated the individual cards beside it. Roles that arrive later now collapse
 * into the drop that is already open, and the drop id depends only on the
 * employer and the day, so the card grows in place instead of reordering. */
function releaseGroups(jobs: Internship[]) {
  const releases: Internship[][] = [];
  const remaining = new Set(jobs);
  const byDrop = new Map<string, Internship[]>();
  for (const job of jobs) {
    const key = employerDropKey(job);
    if (!key) continue;
    const matches = byDrop.get(key) ?? [];
    matches.push(job); byDrop.set(key, matches);
  }
  for (const drop of byDrop.values()) {
    // Every role of a drop belongs to its card, so a role can never be shown
    // as an individual card beside the group that holds its siblings.
    if (drop.length >= RELEASE_MINIMUM_ROLES) {
      releases.push(drop);
      drop.forEach((job) => remaining.delete(job));
    }
  }
  return { releases, remaining: [...remaining] };
}

/** Deterministically builds safe catalog rows without treating title/location similarity as posting identity. */
export function groupCatalogJobs(jobs: Internship[], options: { includeClosed?: boolean } = {}): BuiltGroup[] {
  const visible = jobs.filter((job) => (options.includeClosed || job.open) && job.technical !== false);
  const { releases, remaining } = releaseGroups(visible);
  const grouped: Internship[][] = [];
  const unsafe: Internship[] = [];
  const programs = new Map<string, Internship[]>();
  for (const job of remaining) {
    const key = safeProgramKey(job);
    if (!key) { unsafe.push(job); continue; }
    const matches = programs.get(key) ?? [];
    matches.push(job); programs.set(key, matches);
  }
  grouped.push(...programs.values());
  return [
    ...releases.map((roles) => ({ row: summarize('employer-release', roles), jobs: roles })),
    ...grouped.map((roles) => ({ row: summarize(roles.length > 1 ? 'program-group' : 'individual', roles), jobs: roles })),
    ...unsafe.map((job) => ({ row: summarize('individual', [job]), jobs: [job] })),
  ].sort((left, right) => right.row.updatedAt.localeCompare(left.row.updatedAt));
}

function sourceCredibility(job: Internship): CatalogGroupRole['sourceCredibility'] {
  const classes = catalogSourceClasses(job);
  if (classes.includes('corroborated')) return 'corroborated';
  if (classes.includes('direct')) return 'official';
  if (classes.includes('community')) return 'community';
  return 'unspecified';
}

function provenanceLabels(job: Internship): string[] {
  const active = new Set(job.sourceReferences
    .filter((reference) => reference.state === 'open')
    .map(occurrenceProvenance)
    .filter((value): value is NonNullable<ReturnType<typeof occurrenceProvenance>> => Boolean(value)));
  return [
    ...(active.has('employer-submitted') ? ['Employer submitted'] : []),
    ...(active.has('official-ats') ? ['Official ATS'] : []),
    ...(active.has('official-structured') ? ['Official structured source'] : []),
    ...(active.has('reviewed-community') ? ['Reviewed community source'] : []),
  ];
}

export function catalogGroupDetails(group: BuiltGroup): CatalogGroupDetails {
  return {
    group: group.row,
    roles: [...group.jobs].sort(compareCatalogRecency).map(catalogGroupRole),
  };
}

function catalogGroupRole(job: Internship): CatalogGroupRole {
  const identityProgramType = provenancedText(identityFor(job)?.programType) as Internship['programType'];
  return {
    jobId: job.jobId, company: job.company, title: titleFor(job), location: job.location, season: seasonFor(job),
    locations: locationsFor(job), visibleAt: catalogVisibleAt(job),
    education: catalogEducation(job), disciplines: disciplinesFor(job), workModes: workModesFor(job),
    sourceCredibility: sourceCredibility(job), provenanceLabels: provenanceLabels(job), detailUrl: `/jobs/${encodeURIComponent(job.jobId)}`,
    officialApplyUrl: publicApplicationUrl(job.applyUrl), applicationUrlValidated: Boolean(job.applicationUrlValidatedAt), open: job.open,
    employerCategory: job.employerCategory ?? employerCategory(job.company),
    requiresUsCitizenship: Boolean(job.requirements?.requiresUsCitizenship),
    advancedDegreeRequired: Boolean(job.requirements?.advancedDegreeRequired),
    compensation: job.compensation, ...(job.housing?.length ? { housing: job.housing } : {}), workAuthorizationStatus: job.workAuthorizationStatus ?? 'unknown',
    ...(job.applicationDeadline ? { applicationDeadline: job.applicationDeadline } : {}),
    ...(job.graduationWindow ? { graduationWindow: job.graduationWindow } : {}),
    ...(job.programType ?? identityProgramType ? { programType: job.programType ?? identityProgramType } : {}),
    firstSeenAt: job.firstSeenAt, lastSeenAt: job.lastSeenAt,
    sourceReferences: job.sourceReferences,
    ...(job.applicationUrlValidatedAt ? { applicationUrlValidatedAt: job.applicationUrlValidatedAt } : {}),
    ...(job.invalidApplicationUrl ? { invalidApplicationUrl: job.invalidApplicationUrl } : {}),
    ...(job.postingIdentityStatus ? { postingIdentityStatus: job.postingIdentityStatus } : {}),
  };
}

function includesFolded(values: string[], requested: string[]) {
  const available = values.map(folded);
  return requested.some((value) => available.includes(folded(value)));
}

export function filterCatalogGroups(groups: BuiltGroup[], filter: CatalogGroupFilter): BuiltGroup[] {
  const query = folded(filter.query ?? '');
  return groups.flatMap((group) => {
    const jobs = group.jobs.filter((job) => {
      const education = catalogEducation(job);
      return (!query || folded(`${job.company} ${titleFor(job)} ${job.location} ${seasonFor(job)}`).includes(query))
        && (!filter.status || job.open === (filter.status === 'open'))
        && (!filter.employerCategories?.length || filter.employerCategories.includes(job.employerCategory ?? employerCategory(job.company)))
        && (!filter.hideUsCitizenshipRequired || !job.requirements?.requiresUsCitizenship)
        && (!filter.hideAdvancedDegreeRequired || !job.requirements?.advancedDegreeRequired)
        && (!filter.source || filter.source === 'all' || catalogSourceClasses(job).includes(filter.source))
        && (!filter.hasCompensation || Boolean(job.compensation?.raw?.trim()))
        && (!filter.disciplines?.length || disciplinesMatch(disciplinesFor(job), filter.disciplines))
        && (!filter.seasons?.length || includesFolded([seasonFor(job)], filter.seasons))
        // Unspecified education matches every audience but remains visibly unspecified.
        && (!filter.educationLevels?.length || education.evidence === 'unspecified' || includesFolded(education.levels, filter.educationLevels))
        && (!filter.workModes?.length || includesFolded(workModesFor(job), filter.workModes))
        && (!filter.locations?.length || filter.locations.some((location) => folded(locationsFor(job).join(' ')).includes(folded(location))));
    });
    return jobs.length ? [{ row: summarize(group.row.kind, jobs, group.row.groupId), jobs }] : [];
  });
}

function credibilityMatches(value: CatalogGroupRole['sourceCredibility'], source: CatalogSource) {
  if (source === 'all') return true;
  if (source === 'corroborated') return value === 'corroborated';
  if (source === 'direct') return value === 'official' || value === 'corroborated';
  return value === 'community' || value === 'corroborated';
}

/** Filters a materialized projection without loading full catalog job records. */
export function filterCatalogGroupDetails(groups: CatalogGroupDetails[], filter: CatalogGroupFilter): CatalogGroupDetails[] {
  const query = folded(filter.query ?? '');
  return groups.flatMap((details) => {
    const roles = details.roles.filter((role) =>
      (!query || folded(`${role.company} ${role.title} ${role.location} ${role.season}`).includes(query))
      && (!filter.status || role.open === (filter.status === 'open'))
      && (!filter.employerCategories?.length || filter.employerCategories.includes(role.employerCategory))
      && (!filter.hideUsCitizenshipRequired || !role.requiresUsCitizenship)
      && (!filter.hideAdvancedDegreeRequired || !role.advancedDegreeRequired)
      && (!filter.postingIdentityConfirmedOnly || role.postingIdentityStatus !== 'unconfirmed')
      && (!filter.source || credibilityMatches(role.sourceCredibility, filter.source))
      && (!filter.disciplines?.length || disciplinesMatch(role.disciplines, filter.disciplines))
      && (!filter.seasons?.length || includesFolded([role.season], filter.seasons))
      && (!filter.educationLevels?.length || role.education.evidence === 'unspecified' || includesFolded(role.education.levels, filter.educationLevels))
      && (!filter.workModes?.length || includesFolded(role.workModes, filter.workModes))
      && (!filter.hasCompensation || Boolean(role.compensation?.raw?.trim()))
      && (!filter.locations?.length || filter.locations.some((location) => folded((role.locations ?? role.location.split(/\s*(?:;|\||\n)\s*/)).join(' ')).includes(folded(location)))));
    if (!roles.length) return [];
    return [{
      group: {
        ...details.group,
        education: unique(roles.map((role) => JSON.stringify(role.education))).map((item) => JSON.parse(item) as CatalogEducationSummary),
        roleCount: roles.length,
        unconfirmedRoleCount: roles.filter((role) => role.postingIdentityStatus === 'unconfirmed').length,
        titles: unique(roles.map((role) => role.title)).slice(0, 3),
        disciplines: unique(roles.flatMap((role) => role.disciplines)).slice(0, 6),
        locations: unique(roles.flatMap((role) => role.locations ?? role.location.split(/\s*(?:;|\||\n)\s*/))),
        workModes: unique(roles.flatMap((role) => role.workModes)),
        seasons: unique(roles.map((role) => role.season)),
        roleIds: roles.map((role) => role.jobId),
        featuredRole: roles[0]!,
        compensations: unique(roles.map((role) => role.compensation?.raw ?? '')),
        createdAt: roles.reduce((oldest, role) => role.visibleAt < oldest ? role.visibleAt : oldest, roles[0]!.visibleAt),
        updatedAt: roles.reduce((newest, role) => role.visibleAt > newest ? role.visibleAt : newest, roles[0]!.visibleAt),
        hasNewRoles: roles.some((role) => role.visibleAt !== roles[0]!.visibleAt),
      },
      roles,
    }];
  });
}
