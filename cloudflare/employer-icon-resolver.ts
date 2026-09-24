/**
 * Automatic company-icon resolution.
 *
 * A posting admits an employer long before anyone uploads a logo. This pass
 * fills that gap without blocking publication: a task row is written during
 * admission, and a bounded scheduled sweep later gathers evidence from the real
 * application link, asks two independent providers for a domain, scores the
 * candidates, and either accepts a clear winner, escalates one middle-band case
 * to a single schema-validated tie-breaker, or falls back to a monogram.
 *
 * Nothing here is allowed to hide a role or delay a notification: every failure
 * path ends in a stable monogram, and a resolved decision is only ever rendered
 * when the operator has moved the resolver out of observe mode.
 */

import { createHash } from 'node:crypto';
import { registrableDomain } from '../src/core/registrable-domain.js';
import {
  MAX_PROVIDER_CANDIDATES, decideIconDomain, acceptIconTieBreak, iconEvidenceFingerprint,
  iconTextMatchesEmployer, iconTieBreakSchema, isIconTransportHost, parseIconTieBreakDecision,
  tenantCorroboratesEmployer, employerNamesDomain,
  type IconCandidateScore, type IconDomainCandidate, type IconDomainDecision, type IconEvidenceSignal,
  type IconTieBreakDecision, type EmployerIconSeed,
} from '../src/employer-icon-resolution.js';
import {
  ICON_PROVIDER_TIMEOUT_MS, MAX_ICON_ASSET_BYTES, brandfetchCandidateDomains, brandfetchSearchUrl,
  logoDevCandidateDomains, logoDevImageUrl, logoDevSearchUrl, parseIconPageEvidence, validIconAsset,
  type IconPageEvidence,
} from '../src/employer-icon-discovery.js';
import { safeFetchBytes, safeFetchText, type HostResolver } from '../src/employer/safe-network.js';
import { inferOpenAIJson, shadowDefaultModelId, type OpenAIJsonRequest, type OpenAIJsonResult } from './openai-shadow-inference.js';
import {
  D1EmployerIconStore, employerIconTieBreakWindowMs,
  type EmployerIconContext, type EmployerIconMode, type EmployerIconSettings, type EmployerIconTask,
} from './employer-icon-store.js';
import type { D1Database, R2Bucket } from './types.js';

/** A resolved decision is revalidated on this cadence. */
const ICON_REVALIDATE_MS = 30 * 24 * 60 * 60 * 1_000;
/** A definitive no-match backs off from one day to the revalidation ceiling. */
const ICON_UNRESOLVED_BASE_RETRY_MS = 24 * 60 * 60 * 1_000;
/** A transient provider or network problem retries sooner, from one hour. */
const ICON_TRANSIENT_BASE_RETRY_MS = 60 * 60 * 1_000;
const ICON_TRANSIENT_MAX_RETRY_MS = 24 * 60 * 60 * 1_000;
const ICON_LEASE_MS = 5 * 60_000;
const ICON_LINK_TIMEOUT_MS = 10_000;
const ICON_LINK_MAX_REDIRECTS = 5;
/**
 * The same 512 KiB ceiling `application-url.ts` uses to read an application page.
 * A posting page larger than this is truncated rather than rejected: the
 * employer's name lives in the first few kilobytes of `<head>`, and a two-megabyte
 * Lever page must not cost this employer its icon.
 */
const ICON_LINK_MAX_BYTES = 512 * 1024;
const ICON_PROVIDER_MAX_BYTES = 128 * 1024;
const MAX_ICON_EVIDENCE_BYTES = 16 * 1024;
/** How many employers a single pass may seed when they have no task row at all. */
const ICON_BACKFILL_PER_PASS = 5;
const tieBreakSchemaName = 'company_icon_domain_resolution';

export interface EmployerIconResolverEnvironment {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  /** Server-side Logo.dev credential. Never emitted in a response, key, or log. */
  LOGO_DEV_TOKEN?: string;
  /** Brandfetch client ID; used for in-memory corroboration only. */
  BRANDFETCH_CLIENT_ID?: string;
  OPENAI_KEY?: string;
}

export interface EmployerIconResolverDependencies {
  resolver: HostResolver;
  fetchImpl?: typeof fetch;
  /** Overridden in tests so no network call is made. */
  infer?: (request: OpenAIJsonRequest) => Promise<OpenAIJsonResult>;
}

interface PersistedCandidate {
  domain: string;
  score: number;
  signals: string[];
  rejected?: boolean;
  rejectionReason?: string;
}

export interface EmployerIconSweepResult {
  mode: EmployerIconMode;
  claimed: number;
  backfilled: number;
  resolved: number;
  unresolved: number;
  retryable: number;
  reasonCodes: string[];
}

/**
 * Records one deduplicated resolution task. Returns true when a new row was
 * written, which is the only signal a caller needs for metrics.
 */
export async function enqueueEmployerIconResolution(
  store: D1EmployerIconStore,
  seed: Omit<EmployerIconSeed, 'enqueuedAt'>,
  now: Date,
): Promise<boolean> {
  const at = now.toISOString();
  return store.enqueue({
    id: crypto.randomUUID(),
    canonicalEmployerId: seed.canonicalEmployerId,
    evidenceFingerprint: iconEvidenceFingerprint({
      canonicalEmployerId: seed.canonicalEmployerId, displayName: seed.displayName,
      applicationUrl: seed.applicationUrl, provider: seed.provider,
      ...(seed.tenant ? { tenant: seed.tenant } : {}),
    }),
    evidenceJson: boundedIconEvidence({
      version: 1, kind: 'seed', ...seed, enqueuedAt: at,
    }),
    nextRetryAt: at,
    now: at,
  });
}

/**
 * One bounded sweep. Runs from the existing maintenance cron, so a new queue
 * binding and a new schedule are not required to make progress.
 */
export async function runEmployerIconResolutionPass(
  env: EmployerIconResolverEnvironment,
  now: Date,
  deps: EmployerIconResolverDependencies,
): Promise<EmployerIconSweepResult> {
  const store = new D1EmployerIconStore(env.DB);
  const settings = await store.settings();
  const result: EmployerIconSweepResult = {
    mode: settings.mode, claimed: 0, backfilled: 0, resolved: 0, unresolved: 0, retryable: 0, reasonCodes: [],
  };
  if (settings.mode === 'off') return result;

  result.backfilled = await backfillSeedlessEmployers(store, settings, now);
  const tasks = await store.claimDue(now.toISOString(), settings.maxPerSweep, ICON_LEASE_MS);
  result.claimed = tasks.length;

  for (const task of tasks) {
    try {
      const outcome = await resolveEmployerIconTask({ store, task, settings, env, now, deps });
      result[outcome.outcome] += 1;
      result.reasonCodes.push(outcome.reasonCode);
    } catch (error) {
      // Every definitive outcome is persisted inside the task; a throw means the
      // resolver itself failed. Release the lease so the next sweep retries
      // rather than waiting for the lease to expire.
      await store.release(task.id, now.toISOString());
      result.retryable += 1;
      result.reasonCodes.push('unexpected-failure');
      console.error(JSON.stringify({
        event: 'company_icon_resolution_failed',
        canonicalEmployerId: task.canonicalEmployerId,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      }));
    }
  }

  const reasonCodes: Record<string, number> = {};
  for (const reasonCode of result.reasonCodes) reasonCodes[reasonCode] = (reasonCodes[reasonCode] ?? 0) + 1;
  console.log(JSON.stringify({
    event: 'company_icon_resolution_complete',
    mode: result.mode,
    company_icon_resolution_attempted_total: result.claimed,
    company_icon_resolution_resolved_total: result.resolved,
    company_icon_resolution_monogram_total: result.unresolved + result.retryable,
    company_icon_resolution_retryable_total: result.retryable,
    company_icon_resolution_backfilled_total: result.backfilled,
    company_icon_resolution_reason_codes: reasonCodes,
  }));
  return result;
}

/**
 * Seeds employers that never produced a task because no posting admitted them
 * yet. One task per pass keeps the backfill from competing with live work.
 */
async function backfillSeedlessEmployers(
  store: D1EmployerIconStore,
  settings: EmployerIconSettings,
  now: Date,
): Promise<number> {
  const candidates = await store.employersNeedingResolution(ICON_BACKFILL_PER_PASS);
  let seeded = 0;
  for (const employer of candidates) {
    const recorded = await enqueueEmployerIconResolution(store, {
      canonicalEmployerId: employer.id, displayName: employer.displayName, roleTitle: '',
      applicationUrl: '', provider: 'reviewed-registry', sourceId: 'reviewed-registry',
    }, now);
    if (recorded) seeded += 1;
  }
  if (seeded > 0) {
    console.log(JSON.stringify({ event: 'company_icon_resolution_backfilled', mode: settings.mode, seeded }));
  }
  return seeded;
}

interface ResolveTaskInput {
  store: D1EmployerIconStore;
  task: EmployerIconTask;
  settings: EmployerIconSettings;
  env: EmployerIconResolverEnvironment;
  now: Date;
  deps: EmployerIconResolverDependencies;
}

interface ResolveOutcome {
  outcome: 'resolved' | 'unresolved' | 'retryable';
  reasonCode: string;
}

async function resolveEmployerIconTask(input: ResolveTaskInput): Promise<ResolveOutcome> {
  const { store, task, env, now, deps } = input;
  const at = now.toISOString();
  const context = await store.context(task.canonicalEmployerId);
  if (!context) {
    await store.dropTask(task.id, at, 'employer-missing');
    return { outcome: 'unresolved', reasonCode: 'employer-missing' };
  }
  const seed = parseIconSeed(task.evidenceJson, context);
  const previousInvalidation = parseInvalidatedReason(task.evidenceJson);
  // A reviewer-uploaded icon outranks every automatic answer, and a wrong-icon
  // report must be reviewed by a person rather than retried automatically.
  if (context.iconKey && context.iconSource !== 'logo-dev') {
    await store.dropTask(task.id, at, 'reviewed-icon-present');
    return { outcome: 'resolved', reasonCode: 'reviewed-icon-present' };
  }
  if (context.resolutionStatus === 'invalidated' || previousInvalidation) {
    // A withdrawn decision waits for a person. Releasing the lease keeps the row
    // out of the claim set without rewriting the status the review queue reports.
    await store.release(task.id, at);
    return { outcome: 'unresolved', reasonCode: 'awaiting-review' };
  }

  const gathered = await gatherIconEvidence(seed, deps);
  const providers = await lookupProviderDomains(seed, {
    ...(env.LOGO_DEV_TOKEN ? { logoDevToken: env.LOGO_DEV_TOKEN } : {}),
    ...(env.BRANDFETCH_CLIENT_ID ? { brandfetchClientId: env.BRANDFETCH_CLIENT_ID } : {}),
  }, deps);
  const candidates = iconCandidates(seed, context, gathered, providers);
  const decision = decideIconDomain(candidates);
  const attempt = task.attempts + 1;

  if (decision.outcome === 'resolved' && decision.selectedDomain) {
    return acceptSelectedDomain({ ...input, context, seed, decision, gathered, providers, attempt, at });
  }
  if (decision.outcome === 'llm-review') {
    const escalation = await escalateToTieBreak({ ...input, context, seed, decision, gathered, providers, attempt, at });
    if (escalation) return escalation;
  }

  // A provider that only failed transiently has not earned a day-long backoff.
  const transient = providers.transientFailure || gathered?.failure === 'transport';
  if (transient) {
    await store.markRetryable({
      taskId: task.id,
      evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
        outcome: 'retryable', reasonCode: 'transient-provider-failure', attempt,
      })),
      nextRetryAt: new Date(now.getTime() + transientRetryDelay(attempt, providers.retryAfterMs)).toISOString(),
      now: at,
    });
    return { outcome: 'retryable', reasonCode: 'transient-provider-failure' };
  }

  const nextRetryAt = new Date(now.getTime() + unresolvedRetryDelay(attempt)).toISOString();
  await store.markUnresolved({
    taskId: task.id, canonicalEmployerId: task.canonicalEmployerId,
    evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
      outcome: 'unresolved', reasonCode: decision.outcome === 'llm-review' ? 'tie-break-rejected' : 'no-reliable-domain', attempt,
    })),
    nextRetryAt, now: at,
  });
  return { outcome: 'unresolved', reasonCode: decision.outcome === 'llm-review' ? 'tie-break-rejected' : 'no-reliable-domain' };
}

interface AcceptInput extends ResolveTaskInput {
  context: EmployerIconContext;
  seed: EmployerIconSeed;
  decision: IconDomainDecision;
  gathered?: GatheredIconEvidence;
  providers: ProviderLookup;
  attempt: number;
  at: string;
  /** Present when a tie-breaker chose this domain, so the review record can show what it cited. */
  tieBreak?: { citedEvidenceIds: readonly string[]; inputTokens: number; outputTokens: number; reasonCode: string };
}

/**
 * Confirms the selected domain can actually produce an icon before recording it.
 * The image probe uses `fallback=404`, so Logo.dev's generated monogram tile can
 * never be mistaken for a real logo.
 */
async function acceptSelectedDomain(input: AcceptInput): Promise<ResolveOutcome> {
  const { store, task, settings, env, now, deps, context, seed, decision, gathered, providers, at } = input;
  const domain = decision.selectedDomain!;
  let iconKey: string | undefined;
  let imageVerified = false;

  if (env.LOGO_DEV_TOKEN) {
    const probe = await probeLogoDevImage(domain, env.LOGO_DEV_TOKEN, deps);
    if (!probe.available) {
      if (probe.transient) {
        await store.markRetryable({
          taskId: task.id,
          evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
            outcome: 'retryable', reasonCode: 'image-probe-transient',
          })),
          nextRetryAt: new Date(now.getTime() + transientRetryDelay(input.attempt, probe.retryAfterMs)).toISOString(),
          now: at,
        });
        return { outcome: 'retryable', reasonCode: 'image-probe-transient' };
      }
      // A selected domain with no real image is not usable. Record the decision
      // but publish a monogram rather than a broken image.
      const revalidateAt = new Date(now.getTime() + unresolvedRetryDelay(input.attempt)).toISOString();
      await store.markUnresolved({
        taskId: task.id, canonicalEmployerId: task.canonicalEmployerId,
        evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
          outcome: 'unresolved', reasonCode: 'image-unavailable',
          ...(input.tieBreak ? { tieBreak: input.tieBreak } : {}),
        })),
        nextRetryAt: revalidateAt, now: at,
      });
      return { outcome: 'unresolved', reasonCode: 'image-unavailable' };
    }
    imageVerified = true;
    // Bytes reach R2 only once an operator has confirmed the plan permits
    // self-hosting; otherwise the icon is rendered from the provider's own CDN.
    if (settings.logoDevRetentionLicensedAt && probe.bytes && probe.contentType) {
      iconKey = await storeIconAsset(env, context.id, probe.bytes, probe.contentType);
    }
  }

  // The decision is recorded even in observe mode; observe only withholds it
  // from readers. That is what lets an operator switch to resolve mode and see
  // the week of recorded decisions immediately instead of waiting for a sweep.
  await store.markResolved({
    taskId: task.id, canonicalEmployerId: task.canonicalEmployerId,
    selectedDomain: domain,
    selectedSource: 'logo-dev',
    confidence: decision.selectedScore ?? 0,
    evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
      outcome: 'resolved', reasonCode: 'domain-accepted', imageVerified,
      ...(input.tieBreak ? { tieBreak: input.tieBreak } : {}),
      ...(iconKey ? { iconKey } : {}),
    })),
    revalidateAt: new Date(now.getTime() + ICON_REVALIDATE_MS).toISOString(),
    now: at,
    ...(iconKey ? { iconKey } : {}),
  });
  return { outcome: 'resolved', reasonCode: 'domain-accepted' };
}

/**
 * One schema-validated tie-breaker for the middle band. It may only choose among
 * the submitted candidates, and it can never widen what was already known.
 * Returns undefined when the budget is exhausted or the model declined.
 */
async function escalateToTieBreak(input: AcceptInput): Promise<ResolveOutcome | undefined> {
  const { store, task, env, now, deps, context, seed, decision, gathered, providers, attempt, at } = input;
  const apiKey = env.OPENAI_KEY;
  if (!apiKey) return undefined;
  if (!withinTieBreakBudget(context, task.evidenceFingerprint, now)) {
    await store.markUnresolved({
      taskId: task.id, canonicalEmployerId: task.canonicalEmployerId,
      evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
        outcome: 'unresolved', reasonCode: 'tie-break-budget-exhausted',
      })),
      nextRetryAt: new Date(now.getTime() + unresolvedRetryDelay(attempt)).toISOString(), now: at,
    });
    return { outcome: 'unresolved', reasonCode: 'tie-break-budget-exhausted' };
  }

  const submitted = decision.scores.filter((candidate) => !candidate.rejected).slice(0, 5);
  if (!submitted.length) return undefined;
  const result = await runIconTieBreak({ seed, gathered, submitted, apiKey, deps });
  await store.recordTieBreak({
    canonicalEmployerId: context.id, at, evidenceFingerprint: task.evidenceFingerprint,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens,
  });
  console.log(JSON.stringify({
    event: 'company_icon_resolution_tie_break', canonicalEmployerId: context.id,
    accepted: result.accepted, reasonCode: result.reasonCode,
  }));
  if (!result.accepted || !result.domain) return undefined;
  return acceptSelectedDomain({
    ...input,
    tieBreak: {
      citedEvidenceIds: result.decision?.evidenceIds ?? [],
      inputTokens: result.inputTokens, outputTokens: result.outputTokens, reasonCode: result.reasonCode,
    },
    decision: {
      outcome: 'resolved', scores: decision.scores, selectedDomain: result.domain,
      selectedScore: submitted.find((candidate) => candidate.domain === result.domain)?.score ?? 0,
      reason: `tie-break ${result.reasonCode}`,
    },
  });
}

interface TieBreakOutcome {
  accepted: boolean;
  domain?: string;
  reasonCode: string;
  inputTokens: number;
  outputTokens: number;
  decision?: IconTieBreakDecision;
}

/**
 * The one bounded model call, shared by the live resolver and the read-only
 * diagnostic so both report the same decision for the same evidence.
 */
async function runIconTieBreak(input: {
  seed: EmployerIconSeed;
  gathered?: GatheredIconEvidence;
  submitted: readonly IconCandidateScore[];
  apiKey: string;
  deps: EmployerIconResolverDependencies;
}): Promise<TieBreakOutcome> {
  const { seed, gathered, submitted, apiKey, deps } = input;
  const infer = deps.infer ?? ((request: OpenAIJsonRequest) => inferOpenAIJson(apiKey, request, deps.fetchImpl ?? fetch));
  const result = await infer({
    prompt: { system: tieBreakSystemPrompt, user: JSON.stringify(tieBreakInput(seed, gathered, submitted)) },
    schemaName: tieBreakSchemaName, schema: iconTieBreakSchema,
    model: shadowDefaultModelId, maxOutputTokens: 400,
  });
  const decision = parseIconTieBreakDecision(result.response);
  const acceptance = acceptIconTieBreak(decision, submitted);
  return {
    accepted: acceptance.accepted,
    ...(acceptance.domain ? { domain: acceptance.domain } : {}),
    reasonCode: acceptance.reasonCode,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    ...(decision ? { decision } : {}),
  };
}

/** The model earns a call only when the evidence materially changed or the window lapsed. */
function withinTieBreakBudget(context: EmployerIconContext, evidenceFingerprint: string, now: Date): boolean {
  if (!context.tieBreakAt) return true;
  if (context.tieBreakFingerprint === evidenceFingerprint) return false;
  const elapsed = now.getTime() - Date.parse(context.tieBreakAt);
  return !Number.isFinite(elapsed) || elapsed >= employerIconTieBreakWindowMs;
}

const tieBreakSystemPrompt = [
  'You identify the official web domain of the employer behind one job posting.',
  'Use only the supplied JSON. Never invent a domain and never answer with a URL.',
  'The candidates array lists every domain that may be selected, each with the evidence ids that support it.',
  'Answer with decision "accept" only when the candidates themselves prove the official domain;',
  'cite at least two distinct evidence ids that belong to that candidate.',
  'Answer "uncertain" or "reject" when the evidence does not prove one official domain.',
].join(' ');

function tieBreakInput(seed: EmployerIconSeed, gathered: GatheredIconEvidence | undefined, submitted: readonly IconCandidateScore[]): Record<string, unknown> {
  return {
    employer: seed.displayName.slice(0, 200),
    role: seed.roleTitle.slice(0, 200),
    source: { provider: seed.provider, ...(seed.tenant ? { tenant: seed.tenant } : {}) },
    urls: {
      application: seed.applicationUrl.slice(0, 300),
      ...(gathered ? { final: gathered.finalUrl.slice(0, 300) } : {}),
      ...(gathered ? { redirectHosts: gathered.redirectHosts.slice(0, 5) } : {}),
    },
    page: {
      ...(gathered?.page.title ? { title: gathered.page.title.slice(0, 200) } : {}),
      ...(gathered?.page.ogSiteName ? { siteName: gathered.page.ogSiteName.slice(0, 200) } : {}),
      organizationDomains: (gathered?.page.organizations ?? []).flatMap((organization) => organization.domains ?? []).slice(0, 5),
    },
    candidates: submitted.map((candidate) => ({
      domain: candidate.domain, score: candidate.score, evidenceIds: [...candidate.evidenceIds],
    })),
  };
}

interface GatheredIconEvidence {
  finalUrl: string;
  /** Hostnames the request was validated through, in order. */
  redirectHosts: string[];
  page: IconPageEvidence;
  /** Set when the link could not be read at all; providers still get a chance. */
  failure?: string;
}

async function gatherIconEvidence(seed: EmployerIconSeed, deps: EmployerIconResolverDependencies): Promise<GatheredIconEvidence | undefined> {
  if (!seed.applicationUrl) return undefined;
  try {
    const result = await safeFetchText(seed.applicationUrl, {
      resolver: deps.resolver, fetcher: deps.fetchImpl ?? fetch,
      timeoutMs: ICON_LINK_TIMEOUT_MS, maxRedirects: ICON_LINK_MAX_REDIRECTS, maxBodyBytes: ICON_LINK_MAX_BYTES,
      onOversize: 'truncate',
    });
    return {
      finalUrl: result.url,
      redirectHosts: hostnames(result.redirects),
      page: parseIconPageEvidence(result.body),
    };
  } catch (error) {
    // A blocked, challenged, or timed-out link is normal. The employer still has
    // provider evidence, and a monogram is a valid answer.
    const message = error instanceof Error ? error.message : String(error);
    return {
      finalUrl: seed.applicationUrl, redirectHosts: hostnames([seed.applicationUrl]),
      page: { organizations: [] },
      failure: /non-public|did not resolve|Fetch limits/u.test(message) ? 'blocked' : 'transport',
    };
  }
}

function hostnames(urls: readonly string[]): string[] {
  return urls.flatMap((value) => {
    try { return [new URL(value).hostname.toLowerCase()]; } catch { return []; }
  });
}

interface ProviderLookup {
  logoDev: string[];
  brandfetch: string[];
  transientFailure: boolean;
  retryAfterMs?: number;
  failures: Record<string, string>;
}

/** Server-side provider credentials. A token never reaches a response or a key. */
export interface EmployerIconProviderCredentials {
  logoDevToken?: string;
  brandfetchClientId?: string;
}

async function lookupProviderDomains(
  seed: EmployerIconSeed,
  credentials: EmployerIconProviderCredentials,
  deps: EmployerIconResolverDependencies,
): Promise<ProviderLookup> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const failures: Record<string, string> = {};
  const unconfigured: ProviderResponse = { domains: [], failure: 'unconfigured' };
  const [logoDev, brandfetch] = await Promise.all([
    credentials.logoDevToken
      ? requestProviderDomains(logoDevSearchUrl(seed.displayName), { authorization: `Bearer ${credentials.logoDevToken}` },
        seed.displayName, logoDevCandidateDomains, fetchImpl)
      : Promise.resolve(unconfigured),
    credentials.brandfetchClientId
      ? requestProviderDomains(brandfetchSearchUrl(seed.displayName, credentials.brandfetchClientId), {},
        seed.displayName, brandfetchCandidateDomains, fetchImpl)
      : Promise.resolve(unconfigured),
  ]);
  if (logoDev.failure) failures['logo-dev'] = logoDev.failure;
  if (brandfetch.failure) failures.brandfetch = brandfetch.failure;
  const retryable = [logoDev, brandfetch].filter((entry) => entry.retryAfterMs !== undefined || entry.transient === true);
  return {
    logoDev: logoDev.domains, brandfetch: brandfetch.domains,
    transientFailure: retryable.length > 0,
    ...(retryable.length ? { retryAfterMs: Math.max(0, ...retryable.map((entry) => entry.retryAfterMs ?? 0)) } : {}),
    failures,
  };
}

interface ProviderResponse {
  domains: string[];
  failure?: string;
  transient?: boolean;
  retryAfterMs?: number;
}

/**
 * Provider hosts are fixed literals, so this path needs a size cap and a
 * deadline rather than the full SSRF controls used for employer links. A 404 is
 * a miss, not a failure; 429 and 5xx are transient and honour `Retry-After`.
 */
async function requestProviderDomains(
  url: string,
  headers: Record<string, string>,
  displayName: string,
  parse: (value: unknown, displayName: string) => string[],
  fetchImpl: typeof fetch,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ICON_PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (response.status === 404) return { domains: [] };
    if (!response.ok) {
      const retryAfter = retryAfterMs(response.headers.get('retry-after'), Date.now());
      return {
        domains: [], failure: `http-${response.status}`,
        transient: response.status === 429 || response.status >= 500,
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
      };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > ICON_PROVIDER_MAX_BYTES) return { domains: [], failure: 'oversized' };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > ICON_PROVIDER_MAX_BYTES) return { domains: [], failure: 'oversized' };
    return { domains: parse(JSON.parse(new TextDecoder().decode(bytes)), displayName).slice(0, MAX_PROVIDER_CANDIDATES) };
  } catch {
    return { domains: [], failure: 'transport', transient: true };
  } finally {
    clearTimeout(timeout);
  }
}

/** Parses `Retry-After` as delta-seconds or an HTTP date. */
function retryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * Builds candidates from the link, the page's own statements, and both
 * providers. Page metadata is only ever attributed to a domain the page itself
 * named, so a repeated employer name cannot vouch for an unrelated host.
 */
function iconCandidates(
  seed: EmployerIconSeed,
  context: EmployerIconContext,
  gathered: GatheredIconEvidence | undefined,
  providers: ProviderLookup,
): IconDomainCandidate[] {
  const signals: Record<string, IconEvidenceSignal[]> = {};
  const exempt: Record<string, boolean> = {};
  const add = (hostOrDomain: string, signal: IconEvidenceSignal) => {
    const domain = registrableDomain(hostOrDomain);
    if (!domain) return;
    signals[domain] = [...(signals[domain] ?? []), signal];
    exempt[domain] ||= employerNamesDomain(context.displayName, domain);
  };
  add(hostOf(seed.applicationUrl) ?? '', 'final-url');
  let titleMatches = false;
  let siteMatches = false;
  let organizationNameMatches = false;
  let pageNamedDomain: string | undefined;
  if (gathered) {
    add(hostOf(gathered.finalUrl) ?? '', 'final-url');
    for (const host of gathered.redirectHosts.slice(0, -1)) add(host, 'redirect-host');
    const matched = (gathered.page.organizations ?? [])
      .filter((organization) => organization.name && organization.domains?.length
        && iconTextMatchesEmployer(organization.name, context.displayName));
    const matchedDomains = matched.flatMap((organization) => organization.domains!);
    for (const domain of matchedDomains) { add(domain, 'jsonld-url'); add(domain, 'jsonld-name'); }
    // A structured Organization block that names the employer but publishes no
    // canonical URL still proves *who* is hiring, so it corroborates a provider
    // nomination exactly as the document title does.
    organizationNameMatches = matched.length > 0 || (gathered.page.organizations ?? []).some(
      (organization) => organization.name && !organization.domains?.length
        && iconTextMatchesEmployer(organization.name, context.displayName),
    );
    titleMatches = iconTextMatchesEmployer(gathered.page.title, context.displayName);
    siteMatches = iconTextMatchesEmployer(gathered.page.ogSiteName, context.displayName)
      || iconTextMatchesEmployer(gathered.page.ogTitle, context.displayName);
    const fallback = hostOf(gathered.finalUrl);
    // A transport host can still be the page's own domain when it is the employer's
    // own site, so the page's naming evidence reaches Google or GitHub too.
    pageNamedDomain = matchedDomains[0]
      ?? (fallback && (!isIconTransportHost(fallback) || employerNamesDomain(context.displayName, fallback))
        ? registrableDomain(fallback) : undefined);
  }
  // Employer-identity evidence — the page naming the employer, its structured
  // Organization block, and the posting's own reviewed board slug — corroborates the
  // domains a provider nominated whenever the page names no domain itself. Those are
  // independent assertions about the same employer: the page and the board establish
  // *which* employer is hiring, the provider establishes that employer's domain. It is
  // never attached to a host the page did not name, so it cannot vouch for an
  // unrelated domain.
  const identityTargets = pageNamedDomain
    ? [pageNamedDomain]
    : [...providers.logoDev, ...providers.brandfetch];
  const tenantCorroborates = tenantCorroboratesEmployer(seed.tenant, context.id);
  for (const target of identityTargets) {
    if (titleMatches) add(target, 'page-title');
    if (siteMatches) add(target, 'opengraph');
    if (organizationNameMatches) add(target, 'jsonld-name');
    if (tenantCorroborates) add(target, 'ats-tenant');
  }
  for (const domain of providers.logoDev) add(domain, 'logo-dev');
  for (const domain of providers.brandfetch) add(domain, 'brandfetch');
  return Object.entries(signals).map(([domain, domainSignals]) => ({
    domain, signals: domainSignals,
    ...(exempt[domain] ? { employerNamesDomain: true } : {}),
  }));
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

interface ImageProbe {
  available: boolean;
  transient: boolean;
  retryAfterMs?: number;
  bytes?: Uint8Array;
  contentType?: string;
}

/**
 * Confirms a real raster logo exists for the domain. `fallback=404` is what
 * distinguishes a genuine logo from Logo.dev's generated monogram tile.
 */
async function probeLogoDevImage(
  domain: string,
  token: string,
  deps: EmployerIconResolverDependencies,
): Promise<ImageProbe> {
  try {
    const result = await safeFetchBytes(logoDevImageUrl(domain, token), {
      resolver: deps.resolver, fetcher: deps.fetchImpl ?? fetch,
      timeoutMs: ICON_PROVIDER_TIMEOUT_MS, maxRedirects: 0, maxBodyBytes: MAX_ICON_ASSET_BYTES,
    });
    if (result.status === 404) return { available: false, transient: false };
    if (result.status < 200 || result.status >= 300) {
      const retryAfter = retryAfterMs(result.headers.get('retry-after'), Date.now());
      return {
        available: false,
        transient: result.status === 429 || result.status >= 500,
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
      };
    }
    const contentType = result.headers.get('content-type');
    if (!validIconAsset(contentType, result.body.byteLength)) return { available: false, transient: false };
    return { available: true, transient: false, bytes: result.body, contentType: contentType!.split(';')[0]!.trim().toLowerCase() };
  } catch {
    return { available: false, transient: true };
  }
}

/** Stores the provider's WebP output under an immutable, content-addressed key. */
async function storeIconAsset(
  env: EmployerIconResolverEnvironment,
  canonicalEmployerId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const extension = contentType === 'image/webp' ? 'webp' : contentType.split('/')[1]!.replace('jpeg', 'jpg');
  const key = `company-icons/${canonicalEmployerId}/logo-${digest}.${extension}`;
  await env.DOCUMENTS.put(key, bytes.buffer as ArrayBuffer, { httpMetadata: { contentType } });
  return key;
}

function unresolvedRetryDelay(attempt: number): number {
  return Math.min(ICON_UNRESOLVED_BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1), ICON_REVALIDATE_MS);
}

function transientRetryDelay(attempt: number, retryAfterMs?: number): number {
  const backoff = Math.min(ICON_TRANSIENT_BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1), ICON_TRANSIENT_MAX_RETRY_MS);
  return Math.max(backoff, retryAfterMs ?? 0);
}

function parseIconSeed(evidenceJson: string, context: EmployerIconContext): EmployerIconSeed {
  let parsed: unknown;
  try { parsed = JSON.parse(evidenceJson); } catch { parsed = undefined; }
  const record = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed : {}) as Record<string, unknown>;
  const text = (value: unknown, fallback: string, maximum: number) =>
    typeof value === 'string' && value ? value.slice(0, maximum) : fallback;
  return {
    canonicalEmployerId: context.id,
    displayName: text(record.displayName, context.displayName, 200),
    roleTitle: text(record.roleTitle, '', 200),
    applicationUrl: text(record.applicationUrl, '', 2_048),
    provider: text(record.provider, 'unknown', 80),
    ...(typeof record.tenant === 'string' && record.tenant ? { tenant: record.tenant.slice(0, 300) } : {}),
    sourceId: text(record.sourceId, 'unknown', 300),
  };
}

function parseInvalidatedReason(evidenceJson: string): string | undefined {
  try {
    const parsed = JSON.parse(evidenceJson) as Record<string, unknown>;
    return typeof parsed.invalidatedReason === 'string' ? parsed.invalidatedReason : undefined;
  } catch { return undefined; }
}

interface EvidenceRecordInput {
  outcome: string;
  reasonCode: string;
  attempt?: number;
  imageVerified?: boolean;
  iconKey?: string;
  tieBreak?: { citedEvidenceIds: readonly string[]; inputTokens: number; outputTokens: number; reasonCode: string };
}

/**
 * The persistable evidence record.
 *
 * Brandfetch's standard terms forbid persisting its data, so a candidate that
 * only Brandfetch nominated is omitted and its contribution is recorded as a
 * bare agreement flag. Logo.dev domains are recorded because they are rebuilt by
 * this service rather than trusted from the provider response.
 */
function evidenceRecord(
  seed: EmployerIconSeed,
  decision: IconDomainDecision,
  gathered: GatheredIconEvidence | undefined,
  providers: ProviderLookup,
  outcome: EvidenceRecordInput,
): Record<string, unknown> {
  const candidates: PersistedCandidate[] = decision.scores
    .filter((candidate) => candidate.signals.some((signal) => signal !== 'brandfetch'))
    .slice(0, 10)
    .map((candidate) => ({
      domain: candidate.domain, score: Number(candidate.score.toFixed(3)), signals: [...candidate.signals],
      ...(candidate.rejected ? { rejected: true } : {}),
      ...(candidate.rejectionReason ? { rejectionReason: candidate.rejectionReason } : {}),
    }));
  const brandfetchAgreed = decision.scores.some((candidate) => !candidate.rejected
    && candidate.signals.includes('logo-dev') && candidate.signals.includes('brandfetch'));
  return {
    version: 1,
    kind: 'decision',
    canonicalEmployerId: seed.canonicalEmployerId,
    displayName: seed.displayName.slice(0, 200),
    roleTitle: seed.roleTitle.slice(0, 200),
    provider: seed.provider,
    ...(seed.tenant ? { tenant: seed.tenant } : {}),
    ...(seed.applicationUrl ? { applicationUrl: seed.applicationUrl.slice(0, 2_048) } : {}),
    ...(gathered ? { finalUrl: gathered.finalUrl.slice(0, 2_048) } : {}),
    ...(gathered ? { redirectHosts: gathered.redirectHosts.slice(0, 6) } : {}),
    ...(gathered?.failure ? { pageFailure: gathered.failure } : {}),
    ...(Object.keys(providers.failures).length ? { providerFailures: providers.failures } : {}),
    ...(brandfetchAgreed ? { brandfetchAgreed: true } : {}),
    ...(outcome.attempt === undefined ? {} : { attempt: outcome.attempt }),
    candidates,
    outcome: outcome.outcome,
    reasonCode: outcome.reasonCode,
    ...(outcome.imageVerified === undefined ? {} : { imageVerified: outcome.imageVerified }),
    // What the model cited is the whole basis for a middle-band decision, so the
    // exception reviewer can see it without replaying the request.
    ...(outcome.tieBreak ? {
      tieBreak: {
        reasonCode: outcome.tieBreak.reasonCode,
        citedEvidenceIds: [...outcome.tieBreak.citedEvidenceIds],
        inputTokens: outcome.tieBreak.inputTokens,
        outputTokens: outcome.tieBreak.outputTokens,
      },
    } : {}),
    ...(outcome.iconKey ? { iconKey: outcome.iconKey } : {}),
  };
}

/** Trims the candidate list until the record fits the stored-evidence ceiling. */
function boundedIconEvidence(record: Record<string, unknown>): string {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (encode(record) <= MAX_ICON_EVIDENCE_BYTES) return JSON.stringify(record);
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  for (let keep = candidates.length - 1; keep >= 0; keep -= 1) {
    const trimmed = { ...record, candidates: candidates.slice(0, keep), candidatesTruncated: true };
    if (encode(trimmed) <= MAX_ICON_EVIDENCE_BYTES) return JSON.stringify(trimmed);
  }
  return JSON.stringify({ ...record, candidates: [], candidatesTruncated: true });
}

/**
 * Confirms that a domain can actually produce a real raster logo. Exposed so an
 * operator-confirmed domain passes exactly the same gate as an automatic one.
 */
export async function verifyIconDomain(
  domain: string,
  credentials: EmployerIconProviderCredentials,
  deps: EmployerIconResolverDependencies,
): Promise<boolean> {
  if (!credentials.logoDevToken) return false;
  return (await probeLogoDevImage(domain, credentials.logoDevToken, deps)).available;
}

/**
 * One employer, resolved read-only.
 *
 * This composes exactly the functions the live sweep uses, so a diagnostic can
 * never report a different candidate order, score, or tie-break than the
 * resolver would reach. It writes nothing: no task row, no employer column, no
 * R2 object, and no queue message.
 */
export interface EmployerIconDiagnostic {
  seed: EmployerIconSeed;
  finalUrl?: string;
  redirectHosts: string[];
  pageFailure?: string;
  pageOrganizations: string[];
  providerFailures: Record<string, string>;
  /** Provider nominations, display-only. Brandfetch data is never persisted. */
  logoDevDomains: string[];
  brandfetchDomains: string[];
  decision: IconDomainDecision;
  imageVerified?: boolean;
  tieBreak?: TieBreakOutcome & { called: true };
}

export async function diagnoseEmployerIcon(input: {
  seed: EmployerIconSeed;
  credentials: EmployerIconProviderCredentials;
  deps: EmployerIconResolverDependencies;
  /** Existing employer row, when the caller could read one. */
  context?: EmployerIconContext;
  /** Present only when the diagnostic was asked to exercise the tie-breaker. */
  tieBreakApiKey?: string;
}): Promise<EmployerIconDiagnostic> {
  const { seed, credentials, deps } = input;
  const context = input.context ?? { id: seed.canonicalEmployerId, displayName: seed.displayName };
  const gathered = await gatherIconEvidence(seed, deps);
  const providers = await lookupProviderDomains(seed, credentials, deps);
  const decision = decideIconDomain(iconCandidates(seed, context, gathered, providers));
  const submitted = decision.scores.filter((candidate) => !candidate.rejected).slice(0, 5);
  const imageVerified = decision.selectedDomain && credentials.logoDevToken
    ? (await probeLogoDevImage(decision.selectedDomain, credentials.logoDevToken, deps)).available
    : undefined;
  const tieBreak = decision.outcome === 'llm-review' && input.tieBreakApiKey && submitted.length
    ? { called: true as const, ...await runIconTieBreak({ seed, gathered, submitted, apiKey: input.tieBreakApiKey, deps }) }
    : undefined;
  return {
    seed,
    ...(gathered ? { finalUrl: gathered.finalUrl } : {}),
    redirectHosts: gathered?.redirectHosts ?? [],
    ...(gathered?.failure ? { pageFailure: gathered.failure } : {}),
    pageOrganizations: (gathered?.page.organizations ?? []).flatMap((organization) => organization.domains ?? []),
    providerFailures: providers.failures,
    logoDevDomains: providers.logoDev,
    brandfetchDomains: providers.brandfetch,
    decision,
    ...(imageVerified === undefined ? {} : { imageVerified }),
    ...(tieBreak ? { tieBreak } : {}),
  };
}
