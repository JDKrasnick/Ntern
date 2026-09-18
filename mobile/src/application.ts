export type ApplicationJobSummary = {
  jobId: string;
  company: string;
  title: string;
  applyUrl?: string;
  open: boolean;
  availability?: 'available' | 'closed' | 'catalog-review';
  unavailableReason?: string;
  postingIdentityStatus?: 'confirmed' | 'unconfirmed';
  sourceReferences?: Array<{ sourceId: string; sourceUrl: string }>;
};

export function resolveApplicationJob<T extends ApplicationJobSummary>(
  application: { jobId: string; job?: ApplicationJobSummary },
  catalogJobs: T[],
): ApplicationJobSummary | T | undefined {
  return application.job ?? catalogJobs.find((job) => job.jobId === application.jobId);
}

export type QueueEntry = {
  applicationId: string;
  status: string;
  queuedAt?: string;
  createdAt?: string;
  jobId: string;
  job?: ApplicationJobSummary;
};
export function sortApplyQueue<T extends QueueEntry>(applications: T[]): T[] {
  return applications
    .filter((application) => application.status === 'saved' && application.queuedAt !== undefined)
    .sort((a, b) => (a.queuedAt ?? a.createdAt ?? '').localeCompare(b.queuedAt ?? b.createdAt ?? ''));
}

/** A saved record is only "in queue" while it still carries a queue timestamp. */
export function applicationStatusLabel(status: string, queuedAt?: string): string {
  if (status !== 'saved') return status.toUpperCase();
  return queuedAt !== undefined ? 'IN QUEUE' : 'AWAITING APPLY';
}

export type ApplicationSection<T> = { title: 'To apply' | 'Tracking'; data: T[] };

/** Queue and tracking are disjoint: every record lands in exactly one section. */
export function applicationSections<T extends QueueEntry>(
  applications: T[],
  queue: T[],
): Array<ApplicationSection<T>> {
  const queuedIds = new Set(queue.map((entry) => entry.applicationId));
  const tracked = applications.filter((entry) => !queuedIds.has(entry.applicationId));
  return [
    ...(queue.length ? [{ title: 'To apply' as const, data: queue }] : []),
    ...(tracked.length ? [{ title: 'Tracking' as const, data: tracked }] : []),
  ];
}

export function queueEntryTarget<T extends QueueEntry>(
  item: T,
  catalogJobs: Array<ApplicationJobSummary>,
): { jobId: string; applyUrl: string } | undefined {
  const job = resolveApplicationJob(item, catalogJobs);
  const availability = job && 'availability' in job && job.availability
    ? job.availability
    : job?.open ? 'available' : 'closed';
  const applyUrl = job && 'applyUrl' in job ? job.applyUrl : undefined;
  return availability === 'available' && applyUrl ? { jobId: job.jobId, applyUrl } : undefined;
}

export function nextAvailableQueueEntry<T extends QueueEntry>(
  queue: T[],
  catalogJobs: Array<ApplicationJobSummary>,
  fromIndex = 0,
): T | undefined {
  return queue.slice(fromIndex).find((item) => queueEntryTarget(item, catalogJobs) !== undefined);
}

export type QueueBulkSpec = number | "half" | "all";
export function selectBulkTargets<T>(targets: T[], spec: QueueBulkSpec): T[] {
  if (spec === "all") return targets;
  if (spec === "half") return targets.slice(0, Math.max(1, Math.ceil(targets.length / 2)));
  return targets.slice(0, Math.max(0, spec));
}
