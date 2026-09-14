import type { SourceClass } from './quality.js';
import type { EmptyBoardAcknowledgement } from './reviewed-source.js';
import { apiProbedGreenhouseSources } from './greenhouse-registry-data.js';
import { reviewedGreenhouseExpansionSources } from './greenhouse-expansion-data.js';
import { reviewedGreenhouseOwnerApprovedExpansionSources } from './greenhouse-owner-approved-expansion-data.js';

/** The only Greenhouse board host we ever read identity/jobs from. */
export const GREENHOUSE_BOARD_API_HOST = 'boards-api.greenhouse.io';

export type ReviewedGreenhouseStatus = 'shadow' | 'published';

/**
 * A checked-in, human-reviewed Greenhouse board. Nothing here is inferred from
 * free-form company input: every field is approved by the owner before a token
 * can ever become an API URL.
 */
export interface ReviewedGreenhouseSource {
  /** Stable source ID, always `greenhouse-{boardToken}`. */
  id: string;
  employerId: string;
  /** Canonical name shown in the catalog; never taken from the API response. */
  displayName: string;
  /** Optional dedupe grouping shared with other providers for the same employer. */
  groupId?: string;
  /** Explicit, reviewed lookup aliases for the owner-facing admission command. */
  aliases: string[];
  boardToken: string;
  /** Official careers page the owner supplied when approving the board. */
  careersUrl: string;
  /** Reviewed board-name allowlist compared with exact normalized equality. */
  expectedBoardNames: string[];
  /** Exact name returned by the owner-reviewed admission request. */
  admittedBoardName: string;
  /** UTC time the owner-reviewed admission request completed. */
  admittedAt: string;
  /** Hosts an application URL may start on before any redirect. */
  allowedInitialHosts: string[];
  /** Hosts an application URL may finally resolve to after redirects. */
  allowedFinalHosts: string[];
  status: ReviewedGreenhouseStatus;
  /** `api-probed` entries are published now and queued for later ownership review. */
  evidenceStatus?: 'reviewed' | 'api-probed';
  /** Required justification when a board uses a non-Greenhouse careers host. */
  hostExceptionReason?: string;
  /** Set only after the owner confirms the board itself is empty. */
  emptyBoardAcknowledged?: EmptyBoardAcknowledgement;
  sourceClass?: Extract<SourceClass, 'greenhouse'>;
}

/**
 * Original manually reviewed starter cohort. Every board was checked
 * against its official careers page and the fixed public Greenhouse identity
 * endpoint on 2026-07-27.
 */
const manuallyReviewedGreenhouseSources: ReviewedGreenhouseSource[] = [
  {
    id: 'greenhouse-figma', employerId: 'figma', displayName: 'Figma', aliases: ['Figma, Inc.'], boardToken: 'figma',
    careersUrl: 'https://www.figma.com/careers/', expectedBoardNames: ['Figma'], admittedBoardName: 'Figma', admittedAt: '2026-07-27T21:13:00.000Z',
    allowedInitialHosts: ['boards.greenhouse.io'], allowedFinalHosts: ['job-boards.greenhouse.io'], status: 'published', evidenceStatus: 'reviewed', sourceClass: 'greenhouse',
  },
  {
    id: 'greenhouse-datadog', employerId: 'datadog', displayName: 'Datadog', aliases: ['Datadog, Inc.'], boardToken: 'datadog',
    careersUrl: 'https://careers.datadoghq.com/', expectedBoardNames: ['Datadog'], admittedBoardName: 'Datadog', admittedAt: '2026-07-27T21:13:00.000Z',
    allowedInitialHosts: ['careers.datadoghq.com'], allowedFinalHosts: ['careers.datadoghq.com'], status: 'published', evidenceStatus: 'reviewed', sourceClass: 'greenhouse',
    hostExceptionReason: 'Datadog serves its official Greenhouse application flow from careers.datadoghq.com.',
  },
  {
    id: 'greenhouse-cloudflare', employerId: 'cloudflare', displayName: 'Cloudflare', aliases: ['Cloudflare, Inc.'], boardToken: 'cloudflare',
    careersUrl: 'https://www.cloudflare.com/careers/', expectedBoardNames: ['Cloudflare'], admittedBoardName: 'Cloudflare', admittedAt: '2026-07-27T21:13:00.000Z',
    allowedInitialHosts: ['boards.greenhouse.io'], allowedFinalHosts: ['job-boards.greenhouse.io'], status: 'published', evidenceStatus: 'reviewed', sourceClass: 'greenhouse',
  },
];

/**
 * Official Greenhouse source registry. API-probed entries use the current board
 * identity as their catalog name and remain queued for later ownership review.
 */
export const reviewedGreenhouseSources: ReviewedGreenhouseSource[] = [
  ...manuallyReviewedGreenhouseSources,
  ...apiProbedGreenhouseSources,
  ...reviewedGreenhouseExpansionSources,
  ...reviewedGreenhouseOwnerApprovedExpansionSources,
];

/** Greenhouse board tokens are lowercase slugs; anything URL-shaped is rejected. */
const boardTokenPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;

export function validateBoardToken(value: unknown): value is string {
  return typeof value === 'string' && boardTokenPattern.test(value);
}

export function assertBoardToken(value: string): string {
  if (!validateBoardToken(value)) throw new Error(`Invalid Greenhouse board token: ${JSON.stringify(value)}`);
  return value;
}

const corporateSuffixes = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'limited', 'llc', 'ltd', 'plc']);

/** Accent/case/whitespace/punctuation-folded terms. Does not strip suffixes. */
function foldTerms(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Exact folded board-name comparison, kept separate from the catalog normalizer. */
function foldBoardName(value: string): string {
  return foldTerms(value).join(' ');
}

/** Owner-facing alias/ID lookup key: folded and stripped of trailing corporate suffixes. */
export function normalizeEmployerLookup(value: string): string {
  const terms = foldTerms(value);
  while (terms.length > 1 && corporateSuffixes.has(terms.at(-1)!)) terms.pop();
  return terms.join(' ');
}

export function matchesExpectedBoardName(candidate: string, expectedBoardNames: string[]): boolean {
  const folded = foldBoardName(candidate);
  return folded.length > 0 && expectedBoardNames.some((name) => foldBoardName(name) === folded);
}

export type ReviewedSourceLookup =
  | { status: 'found'; source: ReviewedGreenhouseSource }
  | { status: 'unknown' }
  | { status: 'ambiguous'; candidates: ReviewedGreenhouseSource[] };

/**
 * Exact source-ID or reviewed-alias lookup. Never issues a network request and
 * never converts free-form input into a board token.
 */
export function findReviewedGreenhouseSource(
  query: string,
  registry: ReviewedGreenhouseSource[] = reviewedGreenhouseSources,
): ReviewedSourceLookup {
  const byId = registry.find((source) => source.id === query.trim());
  if (byId) return { status: 'found', source: byId };
  const key = normalizeEmployerLookup(query);
  if (!key) return { status: 'unknown' };
  const matches = registry.filter((source) =>
    [source.displayName, source.employerId, ...source.aliases].some((alias) => normalizeEmployerLookup(alias) === key),
  );
  if (matches.length === 0) return { status: 'unknown' };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
  return { status: 'found', source: matches[0] };
}

/** Exact host or dot-boundary subdomain match; `greenhouse.io.evil.test` never matches. */
export function hostMatchesAllowlist(host: string, allowedHosts: string[]): boolean {
  const normalized = host.trim().toLowerCase();
  return allowedHosts.some((allowed) => {
    const candidate = allowed.trim().toLowerCase();
    return normalized === candidate || normalized.endsWith(`.${candidate}`);
  });
}

/**
 * Runtime invariant check mirroring the `ReviewedGreenhouseSource` contract, so
 * an unsafe cast or a non-TypeScript consumer cannot slip a malformed board past
 * the type system. Returns a safe reason string, or `undefined` when valid.
 */
export function reviewedSourceConfigError(source: ReviewedGreenhouseSource): string | undefined {
  if (!validateBoardToken(source.boardToken)) return 'board token is not a valid Greenhouse slug';
  if (source.id !== `greenhouse-${source.boardToken}`) return 'id must equal `greenhouse-{boardToken}`';
  if (source.employerId.trim() === '') return 'employerId is empty';
  if (source.displayName.trim() === '') return 'displayName is empty';
  if (source.aliases.length === 0) return 'aliases must not be empty';
  let careers: URL;
  try {
    careers = new URL(source.careersUrl);
  } catch {
    return 'careersUrl is not a valid URL';
  }
  if (careers.protocol !== 'https:') return 'careersUrl must be https';
  if (source.expectedBoardNames.length === 0 || source.expectedBoardNames.some((name) => name.trim() === '')) {
    return 'expectedBoardNames must be non-empty with no blank entries';
  }
  if (!matchesExpectedBoardName(source.admittedBoardName, source.expectedBoardNames)) return 'admittedBoardName must match expectedBoardNames';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(source.admittedAt) || Number.isNaN(Date.parse(source.admittedAt))) {
    return 'admittedAt must be a UTC timestamp';
  }
  if (source.allowedInitialHosts.length === 0) return 'allowedInitialHosts must not be empty';
  if (source.allowedFinalHosts.length === 0) return 'allowedFinalHosts must not be empty';
  const applicationHosts = [...source.allowedInitialHosts, ...source.allowedFinalHosts];
  for (const host of applicationHosts) {
    let parsed: URL;
    try {
      parsed = new URL(`https://${host}`);
    } catch {
      return `host ${JSON.stringify(host)} is not a bare hostname`;
    }
    if (parsed.hostname !== host.toLowerCase()) return `host ${JSON.stringify(host)} is not a bare hostname`;
  }
  if (applicationHosts.some((host) => !hostMatchesAllowlist(host, ['greenhouse.io'])) && !source.hostExceptionReason?.trim()) {
    return 'a non-Greenhouse application host requires hostExceptionReason';
  }
  if (source.status !== 'shadow' && source.status !== 'published') return 'status must be shadow or published';
  if (source.evidenceStatus !== undefined && source.evidenceStatus !== 'reviewed' && source.evidenceStatus !== 'api-probed') {
    return 'evidenceStatus must be reviewed or api-probed';
  }
  return undefined;
}

/** Throwing wrapper used to guard the checked-in registry at module load. */
export function assertReviewedGreenhouseRegistry(
  registry: ReviewedGreenhouseSource[] = reviewedGreenhouseSources,
): ReviewedGreenhouseSource[] {
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  for (const source of registry) {
    const error = reviewedSourceConfigError(source);
    if (error) throw new Error(`Invalid reviewed Greenhouse source ${JSON.stringify(source.id)}: ${error}`);
    if (seenIds.has(source.id)) throw new Error(`Duplicate reviewed Greenhouse source id ${JSON.stringify(source.id)}`);
    if (seenTokens.has(source.boardToken)) throw new Error(`Duplicate reviewed Greenhouse board token ${JSON.stringify(source.boardToken)}`);
    seenIds.add(source.id);
    seenTokens.add(source.boardToken);
  }
  return registry;
}

// Fail fast if the checked-in registry ever violates the admission contract.
assertReviewedGreenhouseRegistry();

export function boardIdentityUrl(boardToken: string): string {
  return `https://${GREENHOUSE_BOARD_API_HOST}/v1/boards/${encodeURIComponent(assertBoardToken(boardToken))}`;
}

export interface GreenhouseBoardIdentity {
  name?: string;
  content?: string;
}

export type AdmissionReason =
  | 'invalid-token'
  | 'invalid-config'
  | 'transport-error'
  | 'not-found'
  | 'http-error'
  | 'unapproved-response-host'
  | 'malformed-json'
  | 'name-mismatch';

export interface AdmissionResult {
  ok: boolean;
  reason?: AdmissionReason;
  /** True when the outcome is an infrastructure failure that must be retried, not a rejection. */
  inconclusive?: boolean;
  diagnostics: {
    sourceId: string;
    boardToken: string;
    status?: number;
    resolvedHost?: string;
    returnedName?: string;
    matchedName?: boolean;
    configError?: string;
    transportError?: string;
  };
}

/** Error class/name only; never leaks a message that could carry sensitive data. */
function safeTransportError(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Owner-operated admission check. Calls only the fixed Greenhouse board
 * identity endpoint, verifies the reviewed board name, and never persists a
 * discovered token or mutates configuration.
 */
export async function admitGreenhouseSource(
  source: ReviewedGreenhouseSource,
  fetchImpl: typeof fetch = fetch,
): Promise<AdmissionResult> {
  const diagnostics: AdmissionResult['diagnostics'] = { sourceId: source.id, boardToken: source.boardToken };
  if (!validateBoardToken(source.boardToken)) return { ok: false, reason: 'invalid-token', diagnostics };
  const configError = reviewedSourceConfigError(source);
  if (configError) {
    diagnostics.configError = configError;
    return { ok: false, reason: 'invalid-config', diagnostics };
  }

  let response: Response;
  try {
    response = await fetchImpl(boardIdentityUrl(source.boardToken), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    diagnostics.transportError = safeTransportError(error);
    return { ok: false, reason: 'transport-error', inconclusive: true, diagnostics };
  }
  diagnostics.status = response.status;
  if (response.status === 404) return { ok: false, reason: 'not-found', diagnostics };
  if (!response.ok) return { ok: false, reason: 'http-error', diagnostics };

  let resolvedHost: string | undefined;
  try {
    resolvedHost = new URL(response.url || boardIdentityUrl(source.boardToken)).hostname.toLowerCase();
  } catch {
    resolvedHost = undefined;
  }
  diagnostics.resolvedHost = resolvedHost;
  if (resolvedHost !== GREENHOUSE_BOARD_API_HOST) return { ok: false, reason: 'unapproved-response-host', diagnostics };

  let identity: GreenhouseBoardIdentity;
  try {
    identity = (await response.json()) as GreenhouseBoardIdentity;
  } catch {
    return { ok: false, reason: 'malformed-json', diagnostics };
  }
  if (!identity || typeof identity !== 'object' || typeof identity.name !== 'string') {
    return { ok: false, reason: 'malformed-json', diagnostics };
  }
  diagnostics.returnedName = identity.name;
  const matched = matchesExpectedBoardName(identity.name, source.expectedBoardNames);
  diagnostics.matchedName = matched;
  if (!matched) return { ok: false, reason: 'name-mismatch', diagnostics };
  return { ok: true, diagnostics };
}
