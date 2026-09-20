export type GroupedNotificationCohort = ReadonlySet<string> | '*';

export function parseGroupedNotificationCohort(value: string | undefined): GroupedNotificationCohort {
  const stored = value?.startsWith('v1:') ? value.slice(3) : value ?? '';
  const userIds = stored.split(',').map((item) => item.trim()).filter(Boolean);
  return userIds.includes('*') ? '*' : new Set(userIds);
}

export function legacyDeliveryExclusions(cohort: GroupedNotificationCohort) {
  return cohort === '*' ? { excludeAllUsers: true } : { excludeUserIds: cohort };
}
