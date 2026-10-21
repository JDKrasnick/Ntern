import AsyncStorage from '@react-native-async-storage/async-storage';

export type HistoryRole = { jobId: string; company: string; title: string; applyUrl: string; location?: string; season?: string };
export type ApplicationHistoryEntry = { job: HistoryRole; openedAt: string };
const key = 'internnotifs.application-history.v1';
let writes = Promise.resolve();

export function parseApplicationHistory(value: unknown): ApplicationHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ApplicationHistoryEntry[] = [];
  for (const item of value) {
    const job = item?.job;
    if (!job || !['jobId', 'company', 'title', 'applyUrl'].every(field => typeof job[field] === 'string')
      || !job.jobId || !/^https:\/\//iu.test(job.applyUrl) || typeof item.openedAt !== 'string' || !Number.isFinite(Date.parse(item.openedAt))) continue;
    entries.push({ job: { jobId: job.jobId, company: job.company, title: job.title, applyUrl: job.applyUrl,
      ...(typeof job.location === 'string' ? { location: job.location } : {}), ...(typeof job.season === 'string' ? { season: job.season } : {}) }, openedAt: new Date(item.openedAt).toISOString() });
  }
  const seen = new Set<string>();
  return entries.sort((a, b) => b.openedAt.localeCompare(a.openedAt)).filter(entry => {
    if (seen.has(entry.job.jobId)) return false;
    seen.add(entry.job.jobId);
    return true;
  });
}

export function rememberApplication(history: ApplicationHistoryEntry[], job: HistoryRole, openedAt = new Date().toISOString()) {
  return parseApplicationHistory([{ job, openedAt }, ...history]);
}

export async function loadApplicationHistory() {
  try { return parseApplicationHistory(JSON.parse(await AsyncStorage.getItem(key) ?? '[]')); }
  catch { return []; }
}

export function saveApplicationHistory(history: ApplicationHistoryEntry[]) {
  writes = writes.catch(() => undefined).then(() => AsyncStorage.setItem(key, JSON.stringify(history)));
  return writes;
}

/** Remove only completed handoffs. A group with other roles gets a fresh representative. */
export function remainingCatalogGroup<G extends { roleIds: string[]; roleCount: number; featuredRole: R; titles: string[]; opportunity?: R['opportunity'] }, R extends { jobId: string; title: string; opportunity?: unknown }>(
  group: G, excluded: ReadonlySet<string>, roles?: R[],
): G | undefined {
  if (!group.roleIds.some(id => excluded.has(id))) return group;
  const ids = group.roleIds.filter(id => !excluded.has(id));
  if (!ids.length) return undefined;
  const remaining = roles?.filter(role => ids.includes(role.jobId));
  const featuredRole = excluded.has(group.featuredRole.jobId) ? remaining?.[0] : group.featuredRole;
  if (!featuredRole) return undefined; // Hide briefly while the group's remaining roles load.
  return { ...group, roleIds: ids, roleCount: ids.length, featuredRole,
    ...(remaining ? { titles: [...new Set(remaining.map(role => role.title))].slice(0, 3) } : {}),
    opportunity: featuredRole.opportunity };
}
