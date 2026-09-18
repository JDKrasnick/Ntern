import { createHash } from 'node:crypto';
import { readBoundedJson } from '../core/bounded-body.js';
import { isTechnicalJob } from '../core/filters.js';
import { parseCompensation } from '../core/normalize.js';
import { platformFetch } from '../core/platform-fetch.js';
import { earlyCareerRequirements, hasLifecycleTitleSignal, htmlToText, inferSeason, inferWorkMode } from '../core/early-career.js';
import { extractGreenhouseCompensationBands } from '../metadata-acquisition.js';
import { greenhouseApplicationUrlRejection } from './quality.js';
import { GREENHOUSE_BOARD_API_HOST, assertBoardToken, boardIdentityUrl, validateBoardToken, type ReviewedGreenhouseSource } from './greenhouse-config.js';
import { SourceFetchError, categorizeFetchError } from './source-error.js';
import { processSnapshot } from '../ingestion/processor.js';
import type { RawListing, SourceAdapter, SourceCheckpoint, SourceConnector, SourceFetchResult, SourceSnapshot, SourcedPosting } from '../types.js';

/** Defensive model of the documented Job Board API `content=true` job shape. */
export interface GreenhouseJob {
  id?: number | string;
  internal_job_id?: number | string | null;
  title?: string;
  location?: { name?: string } | null;
  updated_at?: string;
  absolute_url?: string;
  content?: string;
  departments?: Array<{ name?: string } | null>;
  offices?: Array<{ name?: string } | null>;
}

export interface GreenhouseJobsResponse {
  jobs?: GreenhouseJob[];
  meta?: { total?: number };
}

export interface GreenhouseAdapterOptions {
  source: ReviewedGreenhouseSource;
  /** Shadow polling uses a separate checkpoint so promotion always starts quietly. */
  checkpointId?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Board ceiling measured against the isolate: a `content=true` board is held as
 * UTF-16, and `JSON.parse` plus the mapped postings peak near 3.7× the body
 * bytes, so 16 MB leaves roughly a third of the memory limit for the occurrence
 * set, the reconciliation plan, and notification fanout. Boards above it fail
 * as `capacity` before `JSON.parse` instead of exhausting the isolate.
 */
export const GREENHOUSE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const GREENHOUSE_JOB_MAX_BYTES = 512 * 1024;
export const GREENHOUSE_BOARD_MAX_JOBS = 5_000;
export const GREENHOUSE_CONTENT_HASH_VERSION = 2;
/**
 * The deadline covers headers and body, because the largest reviewed boards are
 * tens of megabytes (SpaceX answers `?content=true` with 27.7 MB). The same
 * endpoint already gets this budget from the candidate probe and the live
 * contract check; the adapter previously cut it off at 8 s, which aborted
 * in-flight board transfers.
 */
export const GREENHOUSE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Read-only evidence for a token found on an employer's official careers page.
 * This is deliberately not a `ReviewedGreenhouseSource`: probing never writes
 * the registry, schedules a source, or grants an application-host allowlist.
 */
export type GreenhouseCandidateProbeResult =
  | {
    state: 'ok';
    boardToken: string;
    boardName: string;
    rawJobs: number;
    prospectJobs: number;
    candidateEligibleJobs: number;
    malformedRows: number;
    etagPresent: boolean;
    initialHostSummary: Record<string, number>;
    eligibleRoleSamples: Array<{ document: string; title: string }>;
  }
  | {
    state: 'invalid-token' | 'identity-http-error' | 'identity-response-host-error' | 'identity-json-error' | 'jobs-http-error' | 'jobs-json-error' | 'transport-error';
    boardToken: string;
    status?: number;
    inconclusive?: boolean;
  };

function boardBase(token: string): string {
  return `https://${GREENHOUSE_BOARD_API_HOST}/v1/boards/${encodeURIComponent(assertBoardToken(token))}`;
}

export function greenhouseJobsUrl(token: string, options: { content?: boolean } = {}): string {
  return `${boardBase(token)}/jobs?content=${options.content === false ? 'false' : 'true'}`;
}

/**
 * Owner-only candidate probe for a token already evidenced on an employer's
 * official careers page. It is intentionally read-only and returns only safe
 * counts, host summaries, and a few role titles for review.
 */
export async function probeGreenhouseCandidate(
  boardToken: string,
  fetchImpl: typeof fetch = fetch,
  fetchedAt = new Date().toISOString(),
): Promise<GreenhouseCandidateProbeResult> {
  if (!validateBoardToken(boardToken)) return { state: 'invalid-token', boardToken };

  let identityResponse: Response;
  try {
    identityResponse = await fetchImpl(boardIdentityUrl(boardToken), {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { state: 'transport-error', boardToken, inconclusive: true };
  }
  if (!identityResponse.ok) return { state: 'identity-http-error', boardToken, status: identityResponse.status };
  try {
    if (new URL(identityResponse.url || boardIdentityUrl(boardToken)).hostname.toLowerCase() !== GREENHOUSE_BOARD_API_HOST) {
      return { state: 'identity-response-host-error', boardToken };
    }
  } catch {
    return { state: 'identity-response-host-error', boardToken };
  }
  let identity: unknown;
  try { identity = await identityResponse.json(); } catch { return { state: 'identity-json-error', boardToken }; }
  if (!identity || typeof identity !== 'object' || typeof (identity as { name?: unknown }).name !== 'string') {
    return { state: 'identity-json-error', boardToken };
  }
  const boardName = (identity as { name: string }).name;

  let jobsResponse: Response;
  try {
    jobsResponse = await fetchImpl(greenhouseJobsUrl(boardToken), {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { state: 'transport-error', boardToken, inconclusive: true };
  }
  if (!jobsResponse.ok) return { state: 'jobs-http-error', boardToken, status: jobsResponse.status };
  let payload: unknown;
  try { payload = await jobsResponse.json(); } catch { return { state: 'jobs-json-error', boardToken }; }
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as GreenhouseJobsResponse).jobs)) {
    return { state: 'jobs-json-error', boardToken };
  }

  const jobs = (payload as GreenhouseJobsResponse).jobs ?? [];
  const source: ReviewedGreenhouseSource = {
    id: `greenhouse-${boardToken}`, employerId: boardToken, displayName: boardName, aliases: [boardName], boardToken,
    careersUrl: `https://boards.greenhouse.io/${boardToken}`, expectedBoardNames: [boardName], admittedBoardName: boardName,
    admittedAt: fetchedAt, allowedInitialHosts: ['boards.greenhouse.io'], allowedFinalHosts: ['job-boards.greenhouse.io'], status: 'shadow', sourceClass: 'greenhouse',
  };
  const initialHostSummary: Record<string, number> = {};
  const eligibleRoleSamples: Array<{ document: string; title: string }> = [];
  let malformedRows = 0;
  let prospectJobs = 0;
  let candidateEligibleJobs = 0;
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    if (!isGreenhouseJobShape(job)) { malformedRows += 1; continue; }
    if (job.absolute_url) {
      try {
        const host = new URL(job.absolute_url).hostname.toLowerCase();
        initialHostSummary[host] = (initialHostSummary[host] ?? 0) + 1;
      } catch { /* Invalid candidate URLs are represented by their absence from the host summary. */ }
    }
    if (job.internal_job_id === null || job.internal_job_id === undefined) prospectJobs += 1;
    const mapped = mapGreenhouseJob(job, source, fetchedAt, index + 1);
    if (!mapped) continue;
    candidateEligibleJobs += 1;
    if (eligibleRoleSamples.length < 3) eligibleRoleSamples.push({ document: mapped.document, title: mapped.title });
  }
  return {
    state: 'ok', boardToken, boardName, rawJobs: jobs.length, prospectJobs, candidateEligibleJobs, malformedRows,
    etagPresent: Boolean(jobsResponse.headers.get('etag')), initialHostSummary, eligibleRoleSamples,
  };
}

function names(list: Array<{ name?: string } | null> | undefined): string {
  return (list ?? []).map((item) => htmlToText(item?.name)).filter(Boolean).join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNamedList(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every((item) => item === null || (isRecord(item) && (item.name === undefined || typeof item.name === 'string'))));
}

/**
 * Validates one raw job row before mapping so schema drift (a null, non-object,
 * or wrong-typed field, or an unparseable `updated_at`) surfaces as a
 * source-scoped invalid-shape failure instead of a raw TypeError/RangeError.
 */
export function isGreenhouseJobShape(value: unknown): value is GreenhouseJob {
  if (!isRecord(value)) return false;
  if (value.id !== undefined && typeof value.id !== 'number' && typeof value.id !== 'string') return false;
  if (value.internal_job_id !== undefined && value.internal_job_id !== null && typeof value.internal_job_id !== 'number' && typeof value.internal_job_id !== 'string') return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  if (value.updated_at !== undefined && (typeof value.updated_at !== 'string' || Number.isNaN(Date.parse(value.updated_at)))) return false;
  if (value.absolute_url !== undefined && typeof value.absolute_url !== 'string') return false;
  if (value.content !== undefined && typeof value.content !== 'string') return false;
  if (value.location !== undefined && value.location !== null && !(isRecord(value.location) && (value.location.name === undefined || typeof value.location.name === 'string'))) return false;
  return isNamedList(value.departments) && isNamedList(value.offices);
}

/**
 * Sorted projection so a fallback content hash is stable across response
 * ordering. It covers every published field — description, location,
 * departments/offices, and prospect status — so a change that affects the
 * catalog cannot leave the hash unchanged.
 */
function jobProjection(job: GreenhouseJob): string {
  return JSON.stringify({
        id: String(job.id ?? ''),
        prospect: job.internal_job_id === null || job.internal_job_id === undefined,
        updated_at: job.updated_at ?? '',
        absolute_url: job.absolute_url ?? '',
        title: job.title ?? '',
        location: job.location?.name ?? '',
        content: job.content ?? '',
        departments: names(job.departments),
        offices: names(job.offices),
      });
}

/**
 * Maps one Greenhouse posting to a canonical listing. The company is always the
 * reviewed display name — never the response — and prospect posts
 * (`internal_job_id: null`) are excluded. Departments and offices are used only
 * as classification context, not stored on the listing.
 */
export function mapGreenhouseJob(
  job: GreenhouseJob,
  source: ReviewedGreenhouseSource,
  fetchedAt = new Date().toISOString(),
  row = 1,
): RawListing | undefined {
  if (job.internal_job_id === null || job.internal_job_id === undefined) return undefined;
  const title = htmlToText(job.title);
  const document = job.id === undefined || job.id === null ? '' : String(job.id);
  if (!title || !document || !job.absolute_url) return undefined;
  if (!hasLifecycleTitleSignal(title)) return undefined;

  const content = htmlToText(job.content);
  const location = htmlToText(job.location?.name ?? undefined) || 'Unspecified';
  const workMode = inferWorkMode(`${location} ${content}`);
  const classificationContext = `${title} ${names(job.departments)} ${names(job.offices)}`.replace(/\s+/g, ' ').trim();
  const listing: RawListing = {
    sourceId: source.id,
    document,
    sourceUrl: greenhouseJobsUrl(source.boardToken),
    row,
    company: source.displayName,
    title,
    location,
    season: inferSeason(title, content),
    applyUrl: job.absolute_url,
    compensation: parseCompensation(content),
    requirements: earlyCareerRequirements(content),
    state: 'open',
    ...(job.updated_at && !Number.isNaN(Date.parse(job.updated_at)) ? {
      postedAt: new Date(job.updated_at).toISOString(),
      providerTimestamp: { value: new Date(job.updated_at).toISOString(), semantics: 'updated' as const },
    } : {}),
    ...(workMode ? { workMode } : {}),
    fetchedAt,
  };
  // Title supplies the lifecycle signal; the technical decision may also draw on
  // department/office context, but prose alone never promotes a non-internship role.
  return isTechnicalJob({ ...listing, title: classificationContext }) ? listing : undefined;
}

export function mapGreenhouseSourcedPosting(
  job: GreenhouseJob,
  source: ReviewedGreenhouseSource,
  fetchedAt = new Date().toISOString(),
  row = 1,
): SourcedPosting | undefined {
  const externalId = job.id === undefined || job.id === null ? '' : String(job.id);
  const title = htmlToText(job.title);
  if (!externalId || !title || !job.absolute_url) return undefined;
  const description = job.content ?? '';
  const compensationBands = extractGreenhouseCompensationBands(description);
  return {
    sourceId: source.id,
    provenance: 'official-ats',
    externalId,
    document: externalId,
    sourceUrl: greenhouseJobsUrl(source.boardToken),
    row,
    fetchedAt,
    employer: { id: source.employerId, name: source.displayName, authority: 'reviewed-registry' },
    providerIdentity: { provider: 'greenhouse', tenant: source.boardToken },
    title,
    content: [{ kind: 'description', format: 'html', value: description }],
    ...(compensationBands.length ? { compensationBands } : {}),
    locations: [htmlToText(job.location?.name ?? undefined)].filter(Boolean),
    applyUrl: job.absolute_url,
    providerEvidence: {
      provider: 'greenhouse', tenant: source.boardToken.toLowerCase(), postingId: externalId,
      sourceId: source.id, urls: [job.absolute_url],
    },
    sourceState: job.internal_job_id === null || job.internal_job_id === undefined ? 'prospect' : 'open',
    ...(job.updated_at && !Number.isNaN(Date.parse(job.updated_at)) ? {
      publishedAt: new Date(job.updated_at).toISOString(),
      providerTimestamp: { value: new Date(job.updated_at).toISOString(), semantics: 'updated' as const },
    } : {}),
    classificationTags: [names(job.departments), names(job.offices)].filter(Boolean),
  };
}

type TransitionalGreenhouseResult = SourceSnapshot & SourceFetchResult;

export class GreenhouseBoardAdapter implements SourceAdapter, SourceConnector {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: GreenhouseAdapterOptions) {
    this.id = options.checkpointId ?? options.source.id;
    this.fetchImpl = options.fetchImpl ?? platformFetch;
    this.now = options.now ?? (() => new Date());
  }

  async fetch(previous?: SourceCheckpoint): Promise<TransitionalGreenhouseResult> {
    const url = greenhouseJobsUrl(this.options.source.boardToken);
    const conditionalRequestAttempted = Boolean(previous?.etag);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json', ...(previous?.etag ? { 'If-None-Match': previous.etag } : {}) },
        signal: AbortSignal.timeout(GREENHOUSE_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A rejected fetch never delivered a board, so it is a transport failure
      // rather than evidence about the provider's schema.
      throw categorizeFetchError(error, this.id);
    }
    if (response.status === 304) {
      return {
        sourceId: this.id,
        outcome: 'unchanged',
        complete: true,
        postings: [],
        rawCount: previous?.lastRawCount ?? previous?.lastRowCount ?? 0,
        contentHash: previous?.contentHash ?? '',
        listings: [],
        notModified: true,
        unchangedReason: 'not_modified',
        conditionalRequest: { attempted: conditionalRequestAttempted, notModified: true, validatorChanged: false },
        checkpoint: { ...previous, sourceId: this.id, lastSuccessAt: this.now().toISOString(), successfulFetches: previous?.successfulFetches ?? 0 },
      };
    }
    if (!response.ok) throw new SourceFetchError(`${this.id}: Greenhouse fetch failed (${response.status})`, 'http', response.status);
    // A board whose descriptions do not fit is still readable without them: the
    // listing carries the same jobs, their locations, and their application URLs
    // at a fraction of the size — SpaceX answers with 27.8 MB of descriptions and
    // 2.5 MB without, and its parsed form does not fit the isolate at all. Reading
    // the listing keeps the source ingesting instead of failing as `capacity`
    // twice and quarantining, and the first attempt still stops within one chunk
    // of the ceiling so the oversized body is never retained.
    let contentOmitted = false;
    let payload: unknown;
    try {
      payload = (await readBoundedJson(response, GREENHOUSE_RESPONSE_MAX_BYTES, `${this.id}: Greenhouse`)).value;
    } catch (error) {
      if (!(error instanceof SourceFetchError) || error.category !== 'capacity') throw error;
      contentOmitted = true;
      await response.body?.cancel().catch(() => undefined);
      response = await this.fetchImpl(greenhouseJobsUrl(this.options.source.boardToken, { content: false }), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(GREENHOUSE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new SourceFetchError(`${this.id}: Greenhouse listing fetch failed (${response.status})`, 'http', response.status);
      // A listing that does not fit either is still a capacity failure.
      payload = (await readBoundedJson(response, GREENHOUSE_RESPONSE_MAX_BYTES, `${this.id}: Greenhouse listing`)).value;
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as GreenhouseJobsResponse).jobs)) {
      throw new SourceFetchError(`${this.id}: Greenhouse response shape was invalid`, 'json');
    }
    const jobs = (payload as GreenhouseJobsResponse).jobs ?? [];
    if (jobs.length > GREENHOUSE_BOARD_MAX_JOBS) {
      throw new SourceFetchError(`${this.id}: Greenhouse board exceeds ${GREENHOUSE_BOARD_MAX_JOBS} jobs`, 'capacity');
    }
    const returnedEtag = response.headers.get('etag');
    const fetchedAt = this.now().toISOString();
    const postings: SourcedPosting[] = [];
    const digests: string[] = [];
    const rejectedApplicationUrls: Array<{ row: number; url: string; reason: string }> = [];
    for (const [index, job] of jobs.entries()) {
      if (!isGreenhouseJobShape(job)) throw new SourceFetchError(`${this.id}: Greenhouse response shape was invalid`, 'json');
      // Description text is the only field that can approach the per-job limit,
      // and UTF-8 bytes are never fewer than the UTF-16 code units that hold
      // them, so only a row long enough to matter is measured exactly: an
      // ordinary board no longer re-serializes every job to prove it fits.
      if ((job.content?.length ?? 0) > GREENHOUSE_JOB_MAX_BYTES
        && new TextEncoder().encode(JSON.stringify(job)).byteLength > GREENHOUSE_JOB_MAX_BYTES) {
        throw new SourceFetchError(`${this.id}: Greenhouse job ${String(job.id ?? index + 1)} exceeds ${GREENHOUSE_JOB_MAX_BYTES} bytes`, 'capacity');
      }
      digests.push(createHash('sha256').update(jobProjection(job)).digest('hex'));
      const posting = mapGreenhouseSourcedPosting(job, this.options.source, fetchedAt, index + 1);
      if (!posting) continue;
      const rejection = greenhouseApplicationUrlRejection(posting.applyUrl, this.options.source.allowedInitialHosts);
      if (rejection) rejectedApplicationUrls.push({ row: index + 1, url: posting.applyUrl, reason: rejection });
      else postings.push(posting);
    }
    // The digest set is the same one, sorted the same way, so the content hash
    // is unchanged — but no second array of full-content projections is kept
    // alive alongside the parsed board.
    const contentHash = createHash('sha256')
      .update(`greenhouse-v${GREENHOUSE_CONTENT_HASH_VERSION}:${digests.sort().join('')}`)
      .digest('hex');
    // Every job is mapped, so the parsed container and whatever else the
    // provider returned alongside `jobs` is dead before the snapshot is built.
    payload = undefined;
    const neutral: SourceSnapshot = {
      sourceId: this.id,
      outcome: previous?.contentHashAlgorithmVersion === GREENHOUSE_CONTENT_HASH_VERSION && contentHash === previous?.contentHash ? 'unchanged' : 'changed',
      complete: true,
      postings,
      rawCount: jobs.length,
      contentHash,
      checkpoint: {
        sourceId: this.id,
        etag: returnedEtag ?? previous?.etag,
        contentHash,
        contentHashAlgorithmVersion: GREENHOUSE_CONTENT_HASH_VERSION,
        lastSuccessAt: fetchedAt,
        successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        contentOmitted,
        lastRowCount: 0,
        lastRawCount: jobs.length,
        activeExternalIds: postings.map((posting) => posting.externalId),
        lastRawRowCount: jobs.length,
        lastWithheldRowCount: rejectedApplicationUrls.length,
      },
    };
    const processed = processSnapshot(neutral);
    const listings = processed.listings.filter((listing) => listing.technical !== false);
    neutral.checkpoint.lastRowCount = listings.length;
    return {
      ...neutral,
      rawRowCount: jobs.length,
      processed,
      listings,
      ...(rejectedApplicationUrls.length ? { rejectedApplicationUrls } : {}),
      notModified: neutral.outcome === 'unchanged',
      ...(neutral.outcome === 'unchanged' ? { unchangedReason: 'content_hash' as const } : {}),
      conditionalRequest: {
        attempted: conditionalRequestAttempted,
        notModified: false,
        ...(conditionalRequestAttempted && returnedEtag
          ? { validatorChanged: returnedEtag !== previous?.etag }
          : {}),
      },
    };
  }
}

/** Adapters are constructed for focused checks only; source scheduling is opt-in. */
export function greenhouseAdapters(sources: ReviewedGreenhouseSource[], fetchImpl?: typeof fetch): GreenhouseBoardAdapter[] {
  return sources.map((source) => new GreenhouseBoardAdapter({ source, ...(fetchImpl ? { fetchImpl } : {}) }));
}
