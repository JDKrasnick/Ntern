export type CatalogPage<T> = {
  jobs: T[];
  cursor?: string;
};

export type GroupedCatalogPage<T> = {
  groups: T[];
  cursor?: string;
};

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
