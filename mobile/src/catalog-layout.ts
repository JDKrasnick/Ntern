/**
 * A catalog row becomes a comparison record only when its four columns have
 * enough room to stay readable. Narrower surfaces keep one touch-first reading
 * order instead of compressing desktop columns into a phone.
 */
export function catalogListUsesColumns(width: number) {
  return width >= 900;
}

export type CatalogFreshness = "new" | "day" | "week" | "all";

type CatalogNewnessGroup = { roleIds?: readonly string[]; updatedAt?: string };

export function catalogGroupHasNewRole(
  group: CatalogNewnessGroup,
  newJobIds?: ReadonlySet<string>,
) {
  return Boolean(group.roleIds?.some((roleId) => newJobIds?.has(roleId)));
}

export function catalogNewRoleCount(
  groups: readonly CatalogNewnessGroup[],
  newJobIds?: ReadonlySet<string>,
) {
  const visibleNewRoleIds = new Set<string>();
  groups.forEach((group) => {
    group.roleIds?.forEach((roleId) => {
      if (newJobIds?.has(roleId)) visibleNewRoleIds.add(roleId);
    });
  });
  return visibleNewRoleIds.size;
}

export function catalogGroupsForFreshness<T extends CatalogNewnessGroup>(
  groups: readonly T[],
  newJobIds: ReadonlySet<string> | undefined,
  freshness: CatalogFreshness,
  now = Date.now(),
) {
  if (freshness === "all") return groups;
  if (freshness === "new") return groups.filter((group) => catalogGroupHasNewRole(group, newJobIds));
  const age = freshness === "day" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return groups.filter((group) => {
    const updatedAt = group.updatedAt ? new Date(group.updatedAt).valueOf() : Number.NaN;
    return Number.isFinite(updatedAt) && updatedAt <= now && updatedAt >= now - age;
  });
}
