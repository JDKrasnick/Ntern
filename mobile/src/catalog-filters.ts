import { DEFAULT_DAY_ZONE } from '../../shared/zone-day';
import { educationLevels, type EducationLevel } from '../../shared/education-display';
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
  /** A `YYYY-MM-DD` release day, read in `dayZone`. */
  day?: string;
  dayZone?: string;
  /** The reader's own level; roles that state a different audience are hidden. */
  educationLevel: EducationLevel;
};

/**
 * The level the reader is studying. Undergraduate leads because the catalog's
 * audience is early-career, and it is what an unconfigured install browses as.
 */
export const defaultEducationLevel: EducationLevel = 'undergraduate';

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
  if (state.day) {
    params.set('day', state.day);
    if (state.dayZone) params.set('dayZone', state.dayZone);
  }
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
  /** The release day a reader narrowed to, as `YYYY-MM-DD`. */
  day?: string;
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

/** The client's filter state as the request shape the catalog API takes. */
export function catalogRequestState(
  filters: CatalogFilterValues,
  options: { query?: string; dayZone?: string } = {},
): GroupedCatalogFilterState {
  const query = options.query?.trim();
  const day = filters.day;
  return {
    ...(query ? { query } : {}),
    source: filters.sourceFilter,
    status: filters.jobStatus,
    employerCategory: filters.employerFilter,
    disciplines: filters.disciplines,
    seasons: filters.seasons,
    workModes: filters.workModes,
    educationLevel: filters.educationLevel,
    hasCompensation: filters.hasCompensation,
    hideUsCitizenshipRequired: filters.hideUsCitizenshipRequired,
    ...(day ? { day, dayZone: options.dayZone ?? DEFAULT_DAY_ZONE } : {}),
  };
}

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
    day: 'day' in value && typeof value.day === 'string' ? value.day : undefined,
    educationLevel: chosenOption('educationLevel' in value ? value.educationLevel : undefined, educationLevels, defaultEducationLevel),
  };
}

export const employerCategoryLabels: Record<'faang' | 'startup' | 'normal', string> = {
  faang: 'FAANG',
  startup: 'Startups',
  normal: 'Normal',
};

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
