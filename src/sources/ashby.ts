import { createHash } from 'node:crypto';
import { readBoundedJson } from '../core/bounded-body.js';
import { processSnapshot } from '../ingestion/processor.js';
import { platformFetch } from '../core/platform-fetch.js';
import type { ProcessedSnapshot, SourceAdapter, SourceCheckpoint, SourceConnector, SourceFetchResult, SourceSnapshot, SourcedPosting } from '../types.js';
import { reviewedAshbySources } from './ashby-config.js';
import { ASHBY_API_HOST, ASHBY_API_VERSION } from './ashby-probe.js';
import type { ReviewedSourceRecord } from './reviewed-source.js';
import { SourceFetchError } from './source-error.js';

export const ASHBY_REQUEST_TIMEOUT_MS = 15_000;
export const ASHBY_JOB_HOST = 'jobs.ashbyhq.com';
/**
 * Measured ceilings: the largest observed board response is 10.3 MB (Airwallex,
 * 583 listed postings), so the response ceiling sits above every live board
 * while still stopping a runaway body before `JSON.parse`, and the posting cap
 * bounds how many rows one delivery maps and reconciles.
 */
export const ASHBY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const ASHBY_BOARD_MAX_POSTINGS = 1_000;

interface AshbyCompensation {
  scrapeableCompensationSalarySummary?: string | null;
  compensationTierSummary?: string | null;
}

export interface AshbyPosting {
  id: string;
  title: string;
  location: string;
  secondaryLocations?: Array<{ location: string }> | null;
  department?: string | null;
  team?: string | null;
  isListed: boolean;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
  publishedAt?: string | null;
  employmentType?: string | null;
  jobUrl: string;
  applyUrl: string;
  compensation?: AshbyCompensation | null;
}

export interface AshbyAdapterOptions {
  source: ReviewedSourceRecord;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

type AshbyFetchResult = SourceSnapshot & SourceFetchResult & { processed: ProcessedSnapshot };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publishedAtPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function sourceUrl(boardName: string): string {
  return `https://${ASHBY_API_HOST}/posting-api/job-board/${encodeURIComponent(boardName)}?includeCompensation=true`;
}

function retryAfterMs(response: Response, now: Date): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now.getTime()) : undefined;
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isCompensation(value: unknown): value is AshbyCompensation | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') return false;
  const compensation = value as Record<string, unknown>;
  return optionalString(compensation.scrapeableCompensationSalarySummary)
    && optionalString(compensation.compensationTierSummary);
}

function isAshbyPosting(value: unknown): value is AshbyPosting {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (!['id', 'title', 'location', 'jobUrl', 'applyUrl'].every((key) => typeof row[key] === 'string')) return false;
  if (typeof row.isListed !== 'boolean') return false;
  if (!['department', 'team', 'workplaceType', 'descriptionHtml', 'descriptionPlain', 'publishedAt', 'employmentType']
    .every((key) => optionalString(row[key]))) return false;
  if (row.isRemote !== undefined && row.isRemote !== null && typeof row.isRemote !== 'boolean') return false;
  if (typeof row.workplaceType === 'string' && !['OnSite', 'Remote', 'Hybrid'].includes(row.workplaceType)) return false;
  if (typeof row.employmentType === 'string' && !['FullTime', 'PartTime', 'Intern', 'Contract', 'Temporary'].includes(row.employmentType)) return false;
  if (row.secondaryLocations !== undefined && row.secondaryLocations !== null) {
    if (!Array.isArray(row.secondaryLocations)
      || !row.secondaryLocations.every((location) => location && typeof location === 'object'
        && typeof (location as Record<string, unknown>).location === 'string')) return false;
  }
  return isCompensation(row.compensation);
}

function exactAshbyUrl(value: string, boardName: string, id: string, application: boolean): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.hostname.toLowerCase() === ASHBY_JOB_HOST
    && (!url.port || url.port === '443') && !url.username && !url.password
    && url.pathname === `/${boardName}/${id}${application ? '/application' : ''}`;
}

function validPublishedAt(value: string): boolean {
  const match = publishedAtPattern.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 || second! > 59
    || offsetHour > 23 || offsetMinute > 59) return false;
  return day! <= new Date(Date.UTC(year!, month!, 0)).getUTCDate();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

function contentHash(rows: AshbyPosting[]): string {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(canonical(sorted))).digest('hex');
}

function uniqueLocations(row: AshbyPosting): string[] {
  const values = [row.location, ...(row.secondaryLocations ?? []).map(({ location }) => location)];
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => value && !seen.has(value) && Boolean(seen.add(value)));
}

function workMode(row: AshbyPosting): string | undefined {
  if (row.workplaceType?.trim()) return row.workplaceType;
  if (typeof row.isRemote === 'boolean') return row.isRemote ? 'Remote' : 'OnSite';
  return undefined;
}

function mapPosting(row: AshbyPosting, source: ReviewedSourceRecord, fetchedAt: string, index: number): SourcedPosting {
  const boardName = source.identity.boardKey;
  if (!uuidPattern.test(row.id)) throw new SourceFetchError(`${source.id}: Ashby posting ID was not a UUID`, 'identity');
  if (!exactAshbyUrl(row.jobUrl, boardName, row.id, false)) {
    throw new SourceFetchError(`${source.id}: Ashby job URL did not match the exact board/posting path`, 'identity');
  }
  if (row.publishedAt && !validPublishedAt(row.publishedAt)) {
    throw new SourceFetchError(`${source.id}: Ashby publication date was invalid`, 'json');
  }
  let applyUrl: URL;
  try { applyUrl = new URL(row.applyUrl); } catch { applyUrl = new URL('https://invalid.invalid'); }
  if (applyUrl.hostname.toLowerCase() === ASHBY_JOB_HOST && !exactAshbyUrl(row.applyUrl, boardName, row.id, true)) {
    throw new SourceFetchError(`${source.id}: Ashby application URL did not match the exact board/posting path`, 'identity');
  }
  const description = row.descriptionHtml?.trim()
    ? { kind: 'description' as const, format: 'html' as const, value: row.descriptionHtml }
    : row.descriptionPlain?.trim()
      ? { kind: 'description' as const, format: 'plain' as const, value: row.descriptionPlain }
      : undefined;
  const compensationText = row.compensation?.scrapeableCompensationSalarySummary?.trim()
    || row.compensation?.compensationTierSummary?.trim() || undefined;
  const declaredWorkMode = workMode(row);
  return {
    sourceId: source.id, provenance: 'official-ats', externalId: row.id, document: row.id, sourceUrl: sourceUrl(boardName), row: index + 1, fetchedAt,
    employer: { name: source.company, authority: 'reviewed-registry' }, title: row.title,
    providerIdentity: { provider: 'ashby', tenant: boardName },
    content: description ? [description] : [], locations: uniqueLocations(row), applyUrl: row.applyUrl,
    hostedUrl: row.jobUrl, sourceState: 'open',
    ...(row.employmentType?.toLowerCase() === 'intern' ? { lifecycleAuthority: 'posting' as const } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt, providerTimestamp: { value: row.publishedAt, semantics: 'published' as const } } : {}),
    classificationTags: [row.department, row.team, row.employmentType].filter((value): value is string => Boolean(value?.trim())),
    ...(declaredWorkMode ? { declaredWorkMode } : {}), ...(compensationText ? { compensationText } : {}),
  };
}

function applicationRejection(row: AshbyPosting, source: ReviewedSourceRecord): string | undefined {
  let url: URL;
  try { url = new URL(row.applyUrl); } catch { return 'invalid application URL'; }
  if (url.protocol !== 'https:' || url.username || url.password) return 'application URL must use plain HTTPS authority';
  const host = url.hostname.toLowerCase();
  return source.allowedApplicationHosts.some(({ host: candidate }) => candidate.toLowerCase() === host)
    ? undefined : `application host ${host} is not a reviewed Ashby destination`;
}

export class AshbyPostingsAdapter implements SourceAdapter, SourceConnector {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: AshbyAdapterOptions) {
    if (options.source.identity.provider !== 'ashby' || options.source.identity.apiRegion !== 'global') {
      throw new Error('AshbyPostingsAdapter requires a reviewed global Ashby source');
    }
    this.id = options.source.id;
    this.fetchImpl = options.fetchImpl ?? platformFetch;
    this.now = options.now ?? (() => new Date());
  }

  async fetch(previous?: SourceCheckpoint): Promise<AshbyFetchResult> {
    const endpoint = sourceUrl(this.options.source.identity.boardKey);
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(ASHBY_REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new SourceFetchError(`${this.id}: Ashby transport failed (${error instanceof Error ? error.message : String(error)})`, 'transport');
    }
    if (response.status >= 300 && response.status < 400) throw new SourceFetchError(`${this.id}: Ashby redirected the public posting request`, 'identity', response.status);
    if (!response.ok) {
      throw new SourceFetchError(`${this.id}: Ashby fetch failed (${response.status})`, 'http', response.status,
        response.status === 429 || response.status >= 500 ? retryAfterMs(response, this.now()) : undefined);
    }
    if (response.redirected || (response.url && response.url !== endpoint)) throw new SourceFetchError(`${this.id}: Ashby redirected the public posting request`, 'identity');
    const payload = (await readBoundedJson(response, ASHBY_RESPONSE_MAX_BYTES, `${this.id}: Ashby`)).value;
    if (!payload || typeof payload !== 'object') throw new SourceFetchError(`${this.id}: Ashby response root was malformed`, 'json');
    const root = payload as Record<string, unknown>;
    if (root.apiVersion !== ASHBY_API_VERSION) throw new SourceFetchError(`${this.id}: Ashby API version drifted`, 'identity');
    if (!Array.isArray(root.jobs)) throw new SourceFetchError(`${this.id}: Ashby jobs collection was malformed`, 'json');
    if (root.jobs.length > ASHBY_BOARD_MAX_POSTINGS) {
      throw new SourceFetchError(`${this.id}: Ashby board exceeds ${ASHBY_BOARD_MAX_POSTINGS} postings`, 'capacity');
    }
    if (!root.jobs.every(isAshbyPosting)) throw new SourceFetchError(`${this.id}: Ashby posting row was malformed`, 'json');

    const listed = (root.jobs as AshbyPosting[]).filter(({ isListed }) => isListed);
    const ids = new Set<string>();
    for (const row of listed) {
      if (ids.has(row.id)) throw new SourceFetchError(`${this.id}: Ashby returned duplicate posting IDs`, 'identity');
      ids.add(row.id);
    }
    const fetchedAt = this.now().toISOString();
    const rejectedApplicationUrls: NonNullable<SourceFetchResult['rejectedApplicationUrls']> = [];
    const postings: SourcedPosting[] = [];
    listed.forEach((row, index) => {
      const mapped = mapPosting(row, this.options.source, fetchedAt, index);
      const reason = applicationRejection(row, this.options.source);
      if (reason) rejectedApplicationUrls.push({ row: index + 1, url: row.applyUrl, reason });
      else postings.push(mapped);
    });
    const hash = contentHash(listed);
    const outcome = hash === previous?.contentHash ? 'unchanged' : 'changed';
    const baseSnapshot: SourceSnapshot = {
      sourceId: this.id, outcome, complete: true, postings, rawCount: listed.length, contentHash: hash,
      checkpoint: { sourceId: this.id, successfulFetches: previous?.successfulFetches ?? 0 },
    };
    const processed: ProcessedSnapshot = processSnapshot(baseSnapshot);
    processed.decisions.push(...rejectedApplicationUrls.map(({ row }) => ({ externalId: listed[row - 1]!.id, outcome: 'withheld' as const, reason: 'source-policy' as const })));
    processed.counts.withheld += rejectedApplicationUrls.length;
    const listings = processed.listings.filter(({ technical }) => technical !== false);
    const checkpoint: SourceCheckpoint = {
      sourceId: this.id, contentHash: hash, lastSuccessAt: fetchedAt,
      successfulFetches: (previous?.successfulFetches ?? 0) + 1, lastRawCount: listed.length,
      lastRowCount: listings.length, activeExternalIds: listed.map(({ id }) => id),
    };
    return {
      ...baseSnapshot, processed, listings, rawRowCount: listed.length, rejectedApplicationUrls, checkpoint,
      notModified: outcome === 'unchanged', ...(outcome === 'unchanged' ? { unchangedReason: 'content_hash' as const } : {}),
    };
  }
}

export const approvedAshbySourceConfigs = reviewedAshbySources.map((source) => ({ source }));
export const approvedAshbySources: SourceAdapter[] = approvedAshbySourceConfigs.map((options) => new AshbyPostingsAdapter(options));
