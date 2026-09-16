import { createHash } from 'node:crypto';
import { readBoundedJson } from '../core/bounded-body.js';
import { hasLifecycleTitleSignal } from '../core/early-career.js';
import { isTechnicalJob } from '../core/filters.js';
import { parseCompensation } from '../core/normalize.js';
import { platformFetch } from '../core/platform-fetch.js';
import { processSnapshot } from '../ingestion/processor.js';
import { publishedLeverSources } from './lever-config.js';
import { SourceFetchError } from './source-error.js';
import type { JobRequirements, ProviderTimestamp, RawListing, SourceAdapter, SourceCheckpoint, SourceConnector, SourceFetchResult, SourceSnapshot, SourcedPosting } from '../types.js';

export interface LeverPosting {
  id?: string;
  text?: string;
  applyUrl?: string;
  hostedUrl?: string;
  description?: string;
  descriptionPlain?: string;
  additional?: string;
  additionalPlain?: string;
  salaryDescription?: string;
  salaryDescriptionPlain?: string;
  salaryRange?: { currency?: string; interval?: string; min?: number; max?: number };
  lists?: { text?: string; content?: string }[];
  createdAt?: number;
  updatedAt?: number;
  categories?: { location?: string; commitment?: string; team?: string; allLocations?: string[] };
  workplaceType?: string;
}

export interface LeverAdapterOptions {
  id: string;
  company: string;
  /** Lever's public site identifier, which is also enforced in the application URL. */
  site: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const usCitizen = '(?:u\\.?s\\.?|united states)\\s+citizens?';
const degree = "(?:advanced degree|master'?s|ph\\.?d\\.?|doctorate|mba)";
const citizenshipPattern = new RegExp(`(?:\\b(?:must|requires?|requirement|eligible only|only)\\b[^.]{0,120}${usCitizen}|${usCitizen}[^.]{0,80}\\b(?:required|only|must)\\b)`, 'i');
const advancedDegreePattern = new RegExp(`(?:\\b(?:must|requires?|requirement|eligible only)\\b[^.]{0,120}${degree}|${degree}[^.]{0,80}\\b(?:required|must)\\b)`, 'i');

function plain(value: string | undefined) {
  return (value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function leverSalaryText(posting: LeverPosting): string | undefined {
  const range = posting.salaryRange;
  const periods: Record<string, string> = {
    'per-year-salary': 'year', 'per-month-salary': 'month',
    'per-week-salary': 'week', 'per-day-wage': 'day', 'per-hour-wage': 'hour',
  };
  const period = range?.interval ? periods[range.interval] : undefined;
  // Unknown intervals and incomplete bands are not grounds to infer annual pay.
  const structured = range && period && /^[A-Z]{3}$/.test(range.currency ?? '')
    && typeof range.min === 'number' && Number.isFinite(range.min) && range.min > 0
    && typeof range.max === 'number' && Number.isFinite(range.max) && range.max >= range.min
    ? `Salary: ${range.currency} ${range.min} - ${range.max} per ${period}` : undefined;
  return [structured, posting.salaryDescriptionPlain, posting.salaryDescription]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map(plain).join('\n') || undefined;
}

export function inferLeverSeason(title: string, description: string): string {
  const text = `${title} ${description}`;
  const season = text.match(/\b(summer|fall|spring|winter)\s*(?:intern(?:ship)?\s*)?(20\d{2})\b/i);
  if (season) return `${season[1].toLowerCase()}-${season[2]}`;
  const year = text.match(/\b(20\d{2})\b/);
  return year ? year[1] : 'ongoing';
}

export function leverRequirements(content: string): JobRequirements {
  return {
    requiresUsCitizenship: citizenshipPattern.test(content),
    advancedDegreeRequired: advancedDegreePattern.test(content)
  };
}

function workMode(value: string | undefined): RawListing['workMode'] | undefined {
  if (!value) return undefined;
  if (/remote/i.test(value)) return 'remote';
  if (/hybrid/i.test(value)) return 'hybrid';
  if (/on.?site|in.?person/i.test(value)) return 'onsite';
  return undefined;
}

function postedAt(posting: LeverPosting): string | undefined {
  const timestamp = posting.createdAt ?? posting.updatedAt;
  return timestamp ? new Date(timestamp).toISOString() : undefined;
}

function providerTimestamp(posting: LeverPosting): ProviderTimestamp | undefined {
  const value = postedAt(posting);
  return value ? { value, semantics: posting.createdAt ? 'published' : 'updated' } : undefined;
}

export function mapLeverPosting(posting: LeverPosting, options: Pick<LeverAdapterOptions, 'id' | 'company' | 'site'>, fetchedAt = new Date().toISOString(), row = 1): RawListing | undefined {
  const title = plain(posting.text);
  const content = [posting.descriptionPlain, posting.description, posting.additionalPlain, posting.additional].map(plain).join(' ');
  if (!title || !posting.applyUrl || !hasLifecycleTitleSignal(title)) return undefined;
  const season = inferLeverSeason(title, content);
  const location = plain(posting.categories?.location) || posting.categories?.allLocations?.map(plain).filter(Boolean).join(' / ') || 'Unspecified';
  const listing: RawListing = {
    sourceId: options.id,
    document: posting.id ?? posting.hostedUrl ?? posting.applyUrl,
    sourceUrl: `https://api.lever.co/v0/postings/${options.site}?mode=json`,
    row,
    company: options.company,
    title,
    location,
    season,
    applyUrl: posting.applyUrl,
    compensation: parseCompensation(content),
    requirements: leverRequirements(content),
    state: 'open',
    postedAt: postedAt(posting),
    ...(providerTimestamp(posting) ? { providerTimestamp: providerTimestamp(posting) } : {}),
    workMode: workMode(posting.workplaceType),
    fetchedAt
  };
  return isTechnicalJob(listing) ? listing : undefined;
}

export function mapLeverSourcedPosting(
  posting: LeverPosting,
  options: Pick<LeverAdapterOptions, 'id' | 'company' | 'site'>,
  fetchedAt = new Date().toISOString(),
  row = 1,
): SourcedPosting {
  if (!posting.id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(posting.id)
    || !posting.text || !posting.applyUrl || !posting.hostedUrl) {
    throw new SourceFetchError(`${options.id}: Lever posting shape was invalid`, 'json');
  }
  const expectedHosted = new RegExp(`^/${options.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${posting.id}/?$`);
  const expectedApply = new RegExp(`^/${options.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${posting.id}/apply/?$`);
  let hosted: URL;
  let apply: URL;
  try {
    hosted = new URL(posting.hostedUrl);
    apply = new URL(posting.applyUrl);
  } catch {
    throw new SourceFetchError(`${options.id}: Lever posting URL contract was invalid`, 'identity');
  }
  if (hosted.protocol !== 'https:' || apply.protocol !== 'https:' || hosted.hostname !== 'jobs.lever.co'
    || apply.hostname !== 'jobs.lever.co' || !expectedHosted.test(hosted.pathname) || !expectedApply.test(apply.pathname)) {
    throw new SourceFetchError(`${options.id}: Lever posting URL contract was invalid`, 'identity');
  }
  const content = [
    posting.descriptionPlain,
    posting.description,
    posting.additionalPlain,
    posting.additional,
    ...(posting.lists ?? []).flatMap((list) => [list.text, list.content]),
  ].filter((value): value is string => typeof value === 'string').map((value) => ({
    kind: 'description' as const,
    format: value.includes('<') ? 'html' as const : 'plain' as const,
    value,
  }));
  return {
    sourceId: options.id,
    provenance: 'official-ats',
    externalId: posting.id,
    document: posting.id,
    sourceUrl: `https://api.lever.co/v0/postings/${options.site}?mode=json`,
    row,
    fetchedAt,
    employer: { name: options.company, authority: 'reviewed-registry' },
    providerIdentity: { provider: 'lever', tenant: options.site },
    title: posting.text,
    content,
    locations: [...new Set([posting.categories?.location, ...(posting.categories?.allLocations ?? [])]
      .filter((value): value is string => Boolean(value)))],
    ...(leverSalaryText(posting) ? { compensationText: leverSalaryText(posting) } : {}),
    applyUrl: posting.applyUrl,
    hostedUrl: posting.hostedUrl,
    providerEvidence: {
      provider: 'lever', tenant: options.site.toLowerCase(), postingId: posting.id.toLowerCase(),
      sourceId: options.id, urls: [posting.hostedUrl, posting.applyUrl],
    },
    sourceState: 'open',
    ...(providerTimestamp(posting) ? { publishedAt: providerTimestamp(posting)!.value, providerTimestamp: providerTimestamp(posting)! } : {}),
    classificationTags: [posting.categories?.commitment, posting.categories?.team].filter((value): value is string => Boolean(value)),
    declaredWorkMode: posting.workplaceType,
  };
}

function normalizedProjection(postings: LeverPosting[]): string {
  return JSON.stringify([...postings].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''))));
}

function retryAfterMs(response: Response, now: Date): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now.getTime()) : undefined;
}

type TransitionalLeverResult = SourceSnapshot & SourceFetchResult;
export const LEVER_PAGE_SIZE = 100;
export const LEVER_MAX_PAGES = 50;
export const LEVER_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Measured ceilings: the largest observed page is 1.94 MB (Palantir at 100
 * postings) and the largest whole board 6.1 MB across 316 postings, so a page
 * ceiling above either stops a runaway response before `JSON.parse` while the
 * board ceiling bounds the retained set of pages.
 */
export const LEVER_PAGE_MAX_BYTES = 4 * 1024 * 1024;
export const LEVER_BOARD_MAX_BYTES = 16 * 1024 * 1024;

export class LeverPostingsAdapter implements SourceAdapter, SourceConnector {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: LeverAdapterOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetchImpl ?? platformFetch;
    this.now = options.now ?? (() => new Date());
  }

  async fetch(previous?: SourceCheckpoint): Promise<TransitionalLeverResult> {
    const sourceUrl = `https://api.lever.co/v0/postings/${this.options.site}?mode=json`;
    const postings: LeverPosting[] = [];
    let boardBytes = 0;
    // Lever returns weak ETags but does not honor If-None-Match on this public
    // endpoint. Always fetch every page and use the stable content hash to
    // detect unchanged boards.
    for (let page = 0; page < LEVER_MAX_PAGES; page += 1) {
      const skip = page * LEVER_PAGE_SIZE;
      const pageUrl = `${sourceUrl}&skip=${skip}&limit=${LEVER_PAGE_SIZE}`;
      const response = await this.fetchImpl(pageUrl, {
        headers: {
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(LEVER_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new SourceFetchError(
          `${this.id}: Lever fetch failed (${response.status})`,
          'http',
          response.status,
          response.status === 429 ? retryAfterMs(response, this.now()) : undefined,
        );
      }
      const body = await readBoundedJson(response, LEVER_PAGE_MAX_BYTES, `${this.id}: Lever`);
      boardBytes += body.bytes;
      if (boardBytes > LEVER_BOARD_MAX_BYTES) {
        throw new SourceFetchError(`${this.id}: Lever board exceeds ${LEVER_BOARD_MAX_BYTES} bytes`, 'capacity');
      }
      const payload = body.value;
      if (!Array.isArray(payload)) throw new SourceFetchError(`${this.id}: Lever response was not an array`, 'json');
      postings.push(...payload as LeverPosting[]);
      if (payload.length < LEVER_PAGE_SIZE) break;
      if (page === LEVER_MAX_PAGES - 1) {
        throw new SourceFetchError(`${this.id}: Lever pagination exceeded ${LEVER_MAX_PAGES} pages`, 'json');
      }
    }
    const fetchedAt = this.now().toISOString();
    const sourced = postings.map((posting, index) => mapLeverSourcedPosting(posting, this.options, fetchedAt, index + 1));
    if (new Set(sourced.map((posting) => posting.externalId)).size !== sourced.length) {
      throw new SourceFetchError(`${this.id}: Lever returned duplicate posting IDs`, 'identity');
    }
    const contentHash = createHash('sha256').update(normalizedProjection(postings)).digest('hex');
    const neutral: SourceSnapshot = {
      sourceId: this.id,
      outcome: contentHash === previous?.contentHash ? 'unchanged' : 'changed',
      complete: true,
      postings: sourced,
      rawCount: postings.length,
      contentHash,
      checkpoint: {
        sourceId: this.id,
        contentHash,
        lastSuccessAt: fetchedAt,
        successfulFetches: (previous?.successfulFetches ?? 0) + 1,
        lastRowCount: 0,
        lastRawCount: postings.length,
        activeExternalIds: sourced.map((posting) => posting.externalId),
      },
    };
    const processed = processSnapshot(neutral);
    const eligible = processed.listings.filter((listing) => listing.technical !== false);
    neutral.checkpoint.lastRowCount = eligible.length;
    return {
      ...neutral,
      rawRowCount: postings.length,
      processed,
      listings: eligible,
      notModified: neutral.outcome === 'unchanged',
      ...(neutral.outcome === 'unchanged' ? { unchangedReason: 'content_hash' as const } : {}),
      conditionalRequest: { attempted: false, notModified: false },
    };
  }
}

export const approvedLeverSourceConfigs: LeverAdapterOptions[] = publishedLeverSources()
  .map(({ id, company, site }) => ({ id, company, site }));

/** Compatibility export for local checks; production polling uses the Lever FIFO worker. */
export const approvedLeverSources: SourceAdapter[] = approvedLeverSourceConfigs.map(
  (options) => new LeverPostingsAdapter(options),
);
