export type CatalogPage<T> = {
  jobs: T[];
  cursor?: string;
};

export type GroupedCatalogPage<T> = {
  groups: T[];
  cursor?: string;
};

export type SearchableCatalogGroup = {
  company: string;
  titles: string[];
  featuredRole: { company: string; title: string };
};

/** Match every query term at the start of a company or role-title word. */
export function catalogSearchPreviewMatches(group: SearchableCatalogGroup, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!terms.length) return true;
  const words = [group.company, ...group.titles, group.featuredRole.company, group.featuredRole.title]
    .join(" ").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return terms.every((term) => words.some((word) => word.startsWith(term)));
}

export function filterGroupedCatalogPage<T extends SearchableCatalogGroup>(
  page: GroupedCatalogPage<T>,
  query: string,
): GroupedCatalogPage<T> {
  return query.trim()
    ? { ...page, groups: page.groups.filter((group) => catalogSearchPreviewMatches(group, query)) }
    : page;
}

/**
 * Older API deployments can return location-only matches. Walk a bounded set
 * of their pages until one contributes a company/title match or reaches the end.
 */
export async function nextMatchingGroupedCatalogPage<T extends SearchableCatalogGroup>(
  cursor: string,
  query: string,
  fetchPage: (cursor: string) => Promise<GroupedCatalogPage<T>>,
  maximumPages = 25,
): Promise<GroupedCatalogPage<T>> {
  let nextCursor: string | undefined = cursor;
  for (let pageNumber = 0; nextCursor && pageNumber < maximumPages; pageNumber += 1) {
    const page = filterGroupedCatalogPage(await fetchPage(nextCursor), query);
    if (page.groups.length || !page.cursor) return page;
    nextCursor = page.cursor;
  }
  return { groups: [], ...(nextCursor ? { cursor: nextCursor } : {}) };
}

/** Invalidate every old response before deciding whether a local preview is safe. */
export function beginCatalogQueryChange<T extends SearchableCatalogGroup>(
  generation: { current: number },
  groups: T[],
  query: string,
  hasActiveFilters: boolean,
): T[] | undefined {
  generation.current += 1;
  return hasActiveFilters ? undefined : groups.filter((group) => catalogSearchPreviewMatches(group, query));
}

/** Append a page without allowing a role to appear twice after a refresh. */
export function appendCatalogPage<T extends { jobId: string }>(
  current: T[],
  page: CatalogPage<T>,
): T[] {
  const jobIds = new Set(current.map((job) => job.jobId));
  const additions = page.jobs.filter((job) => {
    if (jobIds.has(job.jobId)) return false;
    jobIds.add(job.jobId);
    return true;
  });
  return additions.length ? [...current, ...additions] : current;
}

export function appendGroupedCatalogPage<T extends { groupId: string }>(
  current: T[],
  page: GroupedCatalogPage<T>,
): T[] {
  const groupIds = new Set(current.map((group) => group.groupId));
  const additions = page.groups.filter((group) => {
    if (groupIds.has(group.groupId)) return false;
    groupIds.add(group.groupId);
    return true;
  });
  return additions.length ? [...current, ...additions] : current;
}

/** A filtered group with one remaining role should look and behave like a role. */
export function catalogCardKind(group: { roleCount: number; featuredRole?: unknown }) {
  return group.roleCount === 1 && group.featuredRole ? 'role' as const : 'group' as const;
}
