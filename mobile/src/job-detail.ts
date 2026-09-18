export type FilterMatchReason = {
  kind: 'category' | 'keyword' | 'company-type' | 'default-all-technical';
  label: string;
};

export type JobNotificationData = {
  destination?: unknown;
  jobId?: unknown;
  releaseId?: unknown;
  applicationId?: unknown;
  url?: unknown;
  matchedFilters?: unknown;
};

export type AppDestination =
  | { kind: 'job'; jobId: string; reasons: FilterMatchReason[]; exclusionsApplied: boolean }
  | { kind: 'release'; releaseId: string }
  | { kind: 'queue' };

export type JobRouteState = 'idle' | 'loading' | 'missing' | 'error';

export function jobDetailPresentation(hasJob: boolean, routeState: JobRouteState) {
  if (routeState !== 'idle') return { visible: true, content: 'route' as const };
  if (hasJob) return { visible: true, content: 'job' as const };
  return { visible: false, content: 'hidden' as const };
}

function filterContext(value: unknown) {
  if (!value || typeof value !== 'object') return { reasons: [], exclusionsApplied: false };
  const context = value as { reasons?: unknown; exclusionsApplied?: unknown };
  const reasons = Array.isArray(context.reasons)
    ? context.reasons.filter((reason): reason is FilterMatchReason => {
      if (!reason || typeof reason !== 'object') return false;
      const value = reason as { kind?: unknown; label?: unknown };
      return ['category', 'keyword', 'company-type', 'default-all-technical'].includes(String(value.kind))
        && typeof value.label === 'string' && value.label.trim().length > 0;
    })
    : [];
  return { reasons, exclusionsApplied: context.exclusionsApplied === true };
}

export function destinationFromNotification(data: JobNotificationData): AppDestination | undefined {
  // Follow-up reminders already scheduled on devices (up to followUpDays ahead)
  // still carry destination 'saved', so that string keeps routing to the queue.
  if (typeof data.applicationId === 'string' || data.destination === 'saved') return { kind: 'queue' };
  if (data.destination === 'release' && typeof data.releaseId === 'string' && data.releaseId) return { kind: 'release', releaseId: data.releaseId };
  if (typeof data.jobId !== 'string' || !data.jobId) return undefined;
  return { kind: 'job', jobId: data.jobId, ...filterContext(data.matchedFilters) };
}

export function destinationFromUrl(url: string): AppDestination | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'internnotifs:' || !['jobs', 'releases'].includes(parsed.hostname)) return undefined;
    const encodedId = parsed.pathname.replace(/^\//, '').split('/')[0];
    if (!encodedId) return undefined;
    if (parsed.hostname === 'releases') return { kind: 'release', releaseId: decodeURIComponent(encodedId) };
    return { kind: 'job', jobId: decodeURIComponent(encodedId), reasons: [], exclusionsApplied: false };
  } catch {
    return undefined;
  }
}

export function jobDeepLink(jobId: string) {
  return `internnotifs://jobs/${encodeURIComponent(jobId)}`;
}

// A job supplied in the URL is already the current browser-history entry.
// Pushing it again would make dismissing the detail sheet navigate back to the
// same URL, which immediately reopens the sheet through the popstate handler.
export function shouldPushJobHistory(currentJobId: string | null, nextJobId: string) {
  return currentJobId !== nextJobId;
}

export function releaseDeepLink(releaseId: string) {
  return `internnotifs://releases/${encodeURIComponent(releaseId)}`;
}

export function isDuplicateJobOpen(activeJobId: string | undefined, nextJobId: string, allowActiveJob = false) {
  return !allowActiveJob && activeJobId === nextJobId;
}

export function jobOpenDisposition(
  activeJobId: string | undefined,
  nextJobId: string,
  dismissalPending = false,
) {
  if (!dismissalPending && activeJobId === nextJobId) return 'ignore' as const;
  if (dismissalPending || activeJobId) return 'replace' as const;
  return 'open' as const;
}

type SourceReference = {
  sourceId: string;
  provenance?: 'official-ats' | 'official-structured' | 'employer-submitted' | 'reviewed-community';
  state?: 'open' | 'closed';
  sourceUrl?: string;
  postedAt?: string;
  providerTimestamp?: { value: string; semantics: 'published' | 'updated' };
};
// Timestamp compatibility only: catalog credibility is driven by explicit
// occurrence provenance, while legacy rows retain their provider date semantics.
const officialProvider = (sourceId: string) => /^(greenhouse|lever|ashby)-/iu.test(sourceId);
export function sourcePresentation(references: SourceReference[]) {
  const provenance = new Set(references.filter((reference) => reference.state !== 'closed').map((reference) => reference.provenance).filter(Boolean));
  const labels = [
    ...(provenance.has('employer-submitted') ? ['Employer submitted'] : []),
    ...(provenance.has('official-ats') ? ['Official ATS'] : []),
    ...(provenance.has('official-structured') ? ['Official structured source'] : []),
    ...(provenance.has('reviewed-community') ? ['Reviewed community source'] : []),
  ];
  return {
    primary: labels[0] ?? 'Source unavailable',
    corroboration: labels.length > 1 ? `Also: ${labels.slice(1).join(' · ')}` : undefined,
    labels,
  };
}

export function freshnessLabel(lastSeenAt: string, now = new Date()) {
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.valueOf())) return 'Confirmation time unavailable';
  const elapsedDays = Math.max(0, Math.floor((now.valueOf() - date.valueOf()) / 86_400_000));
  if (elapsedDays === 0) return 'Confirmed today';
  if (elapsedDays === 1) return 'Confirmed yesterday';
  if (elapsedDays < 7) return `Confirmed ${elapsedDays} days ago`;
  return `Confirmed ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)}`;
}

const absoluteDatePattern = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function parsedAbsoluteDate(value: string | undefined) {
  if (!value || !absoluteDatePattern.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

function publicationDate(references: SourceReference[]) {
  const candidates = references.flatMap((reference) => {
    const official = reference.provenance === 'official-ats' || reference.provenance === 'official-structured'
      || (reference.provenance === undefined && officialProvider(reference.sourceId));
    const providerTimestamp = reference.providerTimestamp;
    const explicitlyPublished = providerTimestamp?.semantics === 'published';
    const providerValue = explicitlyPublished
      ? providerTimestamp.value
      : !providerTimestamp && !official
        ? reference.postedAt
        : undefined;
    const date = parsedAbsoluteDate(providerValue);
    return date ? [{ date, official: explicitlyPublished && official }] : [];
  });
  const official = candidates.filter((candidate) => candidate.official);
  const selected = (official.length ? official : candidates)
    .sort((left, right) => left.date.valueOf() - right.date.valueOf())[0]?.date;
  return selected
    ? { date: selected, verified: official.length > 0 }
    : undefined;
}

function compactAge(date: Date, now: Date) {
  const elapsed = Math.max(0, now.valueOf() - date.valueOf());
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function fullDate(date: Date) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}

export function postingTimingPresentation(
  references: SourceReference[],
  firstSeenAt: string,
  now = new Date(),
) {
  const publication = publicationDate(references);
  const found = parsedAbsoluteDate(firstSeenAt);
  if (publication) {
    const label = publication.verified ? 'Employer posted' : 'Source reported';
    return {
      kind: publication.verified ? 'employer-posted' as const : 'source-reported' as const,
      timestamp: publication.date,
      verified: publication.verified,
      summary: `${label} ${compactAge(publication.date, now)}`,
      detail: found
        ? `${label} ${fullDate(publication.date)}${publication.verified ? ' · Verified employer date' : ' · Not employer-verified'} · Found by Ntern ${fullDate(found)}`
        : `${label} ${fullDate(publication.date)}${publication.verified ? ' · Verified employer date' : ' · Not employer-verified'}`,
    };
  }
  return {
    kind: found ? 'found' as const : 'unknown' as const,
    ...(found ? { timestamp: found } : {}),
    verified: false,
    summary: found ? `Found by Ntern ${compactAge(found, now)}` : 'Posting time unavailable',
    detail: found
      ? `Original posting date unavailable · Found by Ntern ${fullDate(found)}`
      : 'Original posting date unavailable',
  };
}

export function postingRecencyBadge(
  isNewToCatalog: boolean,
  timing: ReturnType<typeof postingTimingPresentation>,
  now = new Date(),
) {
  if (!isNewToCatalog) return undefined;
  if (timing.kind === 'found' || timing.kind === 'source-reported') return 'New here';
  if (timing.kind !== 'employer-posted' || !timing.timestamp) return undefined;
  const elapsed = now.valueOf() - timing.timestamp.valueOf();
  return elapsed >= 0 && elapsed <= 72 * 60 * 60 * 1000 ? 'New' : undefined;
}

export function isNewJob(firstSeenAt: string, options: { signedIn: boolean; previousCatalogOpenedAt?: string | null; now?: Date }) {
  const discovered = new Date(firstSeenAt).valueOf();
  if (Number.isNaN(discovered)) return false;
  if (options.signedIn && options.previousCatalogOpenedAt) {
    const previous = new Date(options.previousCatalogOpenedAt).valueOf();
    return !Number.isNaN(previous) && discovered > previous;
  }
  const now = options.now?.valueOf() ?? Date.now();
  return discovered > now - 72 * 60 * 60 * 1000 && discovered <= now;
}

export function validatedOfficialUrl(job: { applyUrl: string; applicationUrlValidatedAt?: string; invalidApplicationUrl?: string }) {
  return /^https:\/\//i.test(job.applyUrl) && Boolean(job.applicationUrlValidatedAt) && job.invalidApplicationUrl !== job.applyUrl
    ? job.applyUrl
    : undefined;
}

export function routeFailureState(error: unknown): 'missing' | 'error' {
  return error instanceof Error && /not found/i.test(error.message) ? 'missing' : 'error';
}
