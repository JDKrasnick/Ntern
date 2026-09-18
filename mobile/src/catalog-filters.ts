import { educationLevelLabels, educationLevels, type EducationLevel } from '../../shared/education-display';

export type GroupedCatalogFilterState = {
  query?: string;
  source: 'all' | 'direct' | 'community' | 'corroborated';
  status: 'open' | 'closed';
  employerCategory: 'all' | 'faang' | 'startup' | 'normal';
  disciplines?: string[];
  seasons?: string[];
  workModes?: string[];
  hasCompensation?: boolean;
  hideUsCitizenshipRequired: boolean;
  /** The reader's own level; roles that state a different audience are hidden. */
  educationLevel: EducationLevel;
};

export type ChipOption = { value: string; label: string };
/** Education chips carry the level itself so a single-select can stay typed. */
export type EducationChipOption = { value: EducationLevel; label: string };

/** Grounded in live catalog data: Summer 2027 dominates; these four cover dated roles. */
export const seasonFilterOptions: ChipOption[] = [
  { value: 'summer-2027', label: 'Summer 2027' },
  { value: 'fall-2026', label: 'Fall 2026' },
  { value: 'winter-2027', label: 'Winter 2027' },
  { value: 'spring-2027', label: 'Spring 2027' },
];

export const workModeFilterOptions: ChipOption[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'onsite', label: 'On-site' },
];

/**
 * The level the reader is studying. Undergraduate leads because the catalog's
 * audience is early-career, and it is what an unconfigured install browses as.
 */
export const defaultEducationLevel: EducationLevel = 'undergraduate';

export const educationFilterOptions: EducationChipOption[] = educationLevels.map((value) => ({ value, label: educationLevelLabels[value] }));

export function groupedCatalogParameters(
  state: GroupedCatalogFilterState,
  page: { limit?: number; cursor?: string } = {},
) {
  const params = new URLSearchParams({ limit: String(page.limit ?? 25), status: state.status });
  if (page.cursor) params.set('cursor', page.cursor);
  if (state.query?.trim()) params.set('q', state.query.trim());
  if (state.source !== 'all') params.set('source', state.source);
  if (state.employerCategory !== 'all') params.set('employerCategory', state.employerCategory);
  if (state.disciplines?.length) params.set('disciplines', state.disciplines.join(','));
  if (state.seasons?.length) params.set('seasons', state.seasons.join(','));
  if (state.workModes?.length) params.set('workModes', state.workModes.join(','));
  if (state.hasCompensation) params.set('hasCompensation', 'true');
  if (state.hideUsCitizenshipRequired) params.set('hideUsCitizenshipRequired', 'true');
  params.set('educationLevel', state.educationLevel);
  return params;
}

export type CatalogFilterValues = {
  disciplines: string[];
  seasons: string[];
  workModes: string[];
  employerFilter: 'all' | 'faang' | 'startup' | 'normal';
  jobStatus: 'open' | 'closed';
  sourceFilter: 'all' | 'direct' | 'community' | 'corroborated';
  hasCompensation: boolean;
  hideUsCitizenshipRequired: boolean;
  educationLevel: EducationLevel;
};

const employerFilterValues = ['all', 'faang', 'startup', 'normal'] as const;
const sourceFilterValues = ['all', 'direct', 'community', 'corroborated'] as const;
const jobStatusValues = ['open', 'closed'] as const;

export const emptyCatalogFilters: CatalogFilterValues = {
  disciplines: [],
  seasons: [],
  workModes: [],
  employerFilter: 'all',
  jobStatus: 'open',
  sourceFilter: 'all',
  hasCompensation: false,
  hideUsCitizenshipRequired: false,
  educationLevel: defaultEducationLevel,
};

function storedList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function chosenOption<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

/**
 * Stored filters are a user-editable blob on the device, so every field is
 * validated and an unrecognized one falls back instead of breaking browse.
 */
export function parseCatalogFilters(value: unknown): CatalogFilterValues | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return {
    disciplines: storedList('disciplines' in value ? value.disciplines : undefined),
    seasons: storedList('seasons' in value ? value.seasons : undefined),
    workModes: storedList('workModes' in value ? value.workModes : undefined),
    employerFilter: chosenOption('employerFilter' in value ? value.employerFilter : undefined, employerFilterValues, 'all'),
    jobStatus: chosenOption('jobStatus' in value ? value.jobStatus : undefined, jobStatusValues, 'open'),
    sourceFilter: chosenOption('sourceFilter' in value ? value.sourceFilter : undefined, sourceFilterValues, 'all'),
    hasCompensation: 'hasCompensation' in value && value.hasCompensation === true,
    hideUsCitizenshipRequired: 'hideUsCitizenshipRequired' in value && value.hideUsCitizenshipRequired === true,
    educationLevel: chosenOption('educationLevel' in value ? value.educationLevel : undefined, educationLevels, defaultEducationLevel),
  };
}

export function countActiveCatalogFilters(filters: CatalogFilterValues): number {
  return [
    filters.disciplines.length > 0,
    filters.seasons.length > 0,
    filters.workModes.length > 0,
    filters.employerFilter !== 'all',
    filters.jobStatus !== 'open',
    filters.sourceFilter !== 'all',
    filters.hasCompensation,
    filters.hideUsCitizenshipRequired,
    // The default level is how browse starts, so it is not a chosen filter.
    filters.educationLevel !== defaultEducationLevel,
  ].filter(Boolean).length;
}

export function catalogGroupAvailabilityLabel(
  group: { kind: 'program-group' | 'employer-release' | 'individual'; roleCount: number },
  status: 'open' | 'closed',
) {
  if (status === 'closed') return `${group.roleCount} closed role${group.roleCount === 1 ? '' : 's'}`;
  if (group.roleCount === 1) return 'Open role';
  if (group.kind === 'employer-release') return `${group.roleCount} new role${group.roleCount === 1 ? '' : 's'}`;
  if (group.kind === 'program-group') return `${group.roleCount} role${group.roleCount === 1 ? '' : 's'} in this program`;
  return '1 open role';
}
