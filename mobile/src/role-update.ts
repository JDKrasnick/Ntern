/** Opening timestamps change on retries; role identities define the update. */
export function roleUpdateKey(inbox: {
  jobs: Array<{ jobId: string }>;
  groups?: Array<{ group: { groupId: string } }>;
}): string {
  return JSON.stringify({
    jobs: [...new Set(inbox.jobs.map((job) => job.jobId))].sort(),
    groups: [...new Set(inbox.groups?.map(({ group }) => group.groupId) ?? [])].sort(),
  });
}
