import { allDisciplineStyles } from '../../shared/discipline-display';
import { DEFAULT_DAY_ZONE } from '../../shared/zone-day';
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
  /** A `YYYY-MM-DD` release day, read in `dayZone`. */
  day?: string;
  dayZone?: string;
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
  /** The release day the reader picked in the calendar, as `YYYY-MM-DD`. */
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

/**
 * The full catalog is the resting state. A query narrows it and so does any
 * facet, so Reset belongs on screen whenever either is in play — a reader who
 * typed a search has as much to undo as one who opened the filter sheet.
 */
export function catalogViewNarrowed(query: string, filters: CatalogFilterValues): boolean {
  return query.trim().length > 0 || countActiveCatalogFilters(filters) > 0;
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
    Boolean(filters.day),
    // The default level is how browse starts, so it is not a chosen filter.
    filters.educationLevel !== defaultEducationLevel,
  ].filter(Boolean).length;
}

export const employerCategoryLabels: Record<'faang' | 'startup' | 'normal', string> = {
  faang: 'FAANG',
  startup: 'Startups',
  normal: 'Normal',
};

export const sourceFilterOptions: ChipOption[] = [
  { value: 'all', label: 'All' },
  { value: 'direct', label: 'Direct' },
  { value: 'community', label: 'Community' },
  { value: 'corroborated', label: 'Direct + community' },
];

/** Disciplines in the order a student is most likely to look for them. */
export const disciplineChipOptions: ChipOption[] = (() => {
  const order = ['software', 'ai-ml', 'data', 'infrastructure-cloud', 'security', 'quant', 'product', 'technical-design'] as const;
  const byTag = new Map(allDisciplineStyles().map(({ tag, style }) => [tag, style] as const));
  return order.filter((tag) => byTag.has(tag)).map((tag) => ({ value: byTag.get(tag)!.filterValue, label: byTag.get(tag)!.label }));
})();

export type CatalogFilterToken = {
  key: string;
  label: string;
  /** Applied over the current filters, so clearing one facet never disturbs another. */
  patch: Partial<CatalogFilterValues>;
};

function optionLabel(options: ChipOption[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** A release day as a reader reads it: `Fri, Sep 18`. Parsed as UTC so the label
 * never moves a day that was computed in the reader's own zone. */
export function releaseDayLabel(day: string) {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) return day;
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(parsed);
}

/** Parameters for the release-day index that fills the calendar. */
export function catalogDayIndexParameters(
  filters: CatalogFilterValues,
  range: { from: string; to: string; dayZone: string },
) {
  const params = groupedCatalogParameters(catalogRequestState({ ...filters, day: undefined }, { dayZone: range.dayZone }));
  params.delete('limit');
  params.set('from', range.from);
  params.set('to', range.to);
  params.set('dayZone', range.dayZone);
  return params;
}

/** One removable token per active facet, in the order the filter sheet lists them. */
export function catalogFilterTokens(filters: CatalogFilterValues): CatalogFilterToken[] {
  return [
    ...(filters.day
      ? [{ key: `day:${filters.day}`, label: releaseDayLabel(filters.day), patch: { day: undefined } }]
      : []),
    ...filters.seasons.map((season) => ({
      key: `season:${season}`,
      label: optionLabel(seasonFilterOptions, season),
      patch: { seasons: filters.seasons.filter((value) => value !== season) },
    })),
    ...filters.disciplines.map((discipline) => ({
      key: `discipline:${discipline}`,
      label: optionLabel(disciplineChipOptions, discipline),
      patch: { disciplines: filters.disciplines.filter((value) => value !== discipline) },
    })),
    ...filters.workModes.map((mode) => ({
      key: `workMode:${mode}`,
      label: optionLabel(workModeFilterOptions, mode),
      patch: { workModes: filters.workModes.filter((value) => value !== mode) },
    })),
    ...(filters.educationLevel !== defaultEducationLevel
      ? [{ key: `education:${filters.educationLevel}`, label: optionLabel(educationFilterOptions, filters.educationLevel), patch: { educationLevel: defaultEducationLevel } }]
      : []),
    ...(filters.employerFilter !== 'all'
      ? [{ key: 'employer', label: employerCategoryLabels[filters.employerFilter], patch: { employerFilter: 'all' as const } }]
      : []),
    ...(filters.jobStatus !== 'open'
      ? [{ key: 'status', label: 'Closed roles', patch: { jobStatus: 'open' as const } }]
      : []),
    ...(filters.sourceFilter !== 'all'
      ? [{ key: 'source', label: optionLabel(sourceFilterOptions.slice(1), filters.sourceFilter), patch: { sourceFilter: 'all' as const } }]
      : []),
    ...(filters.hasCompensation ? [{ key: 'compensation', label: 'Pay listed', patch: { hasCompensation: false } }] : []),
    ...(filters.hideUsCitizenshipRequired
      ? [{ key: 'citizenship', label: 'No U.S. citizenship requirement', patch: { hideUsCitizenshipRequired: false } }]
      : []),
  ];
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
