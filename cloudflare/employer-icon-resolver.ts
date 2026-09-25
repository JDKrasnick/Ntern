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
  tenantCorroboratesEmployer, employerNamesDomain, employerDistinctiveTerms, officialIconProvenance,
  plausibleEmployerName, providerNameMatchesEmployer, parseIconProposal, iconProposalSchema,
  acceptIconAssetPick, parseIconAssetPick, iconAssetPickSchema,
  ICON_PROPOSAL_MINIMUM_CONFIDENCE,
  type IconCandidateScore, type IconDomainCandidate, type IconDomainDecision, type IconEvidenceSignal,
  type IconTieBreakDecision, type EmployerIconSeed,
} from '../src/employer-icon-resolution.js';
import {
  ICON_PROVIDER_TIMEOUT_MS, MAX_ICON_ASSET_BYTES, assetShapeUsable, bannerAssetShapeUsable,
  brandfetchSearchUrl, providerDomainCandidates,
  iconAssetType, iconSvgAsset, isPlatformBannerUrl, platformLogoUrls,
  proposedDomainMatchesEmployer, siteLogoAssetCandidates,
  logoDevImageUrl, logoDevSearchUrl, parseIconPageEvidence,
  type IconPageEvidence,
} from '../src/employer-icon-discovery.js';

import { safeIconSvg, type IconSvgRasterizer } from '../src/svg-icon.js';
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
const ICON_BACKFILL_PER_PASS = 25;
/**
 * The client identity the resolver presents when it reads an employer's public
 * posting. Greenhouse's edge answers a request that presents no client at all with
 * `406 Not Acceptable`, so a stable, honest user agent is part of being able to read
 * the page; the sweep's rate is unchanged either way, five employers every ten
 * minutes. Exported so the read-only coverage script presents the same client.
 */
export const ICON_PAGE_REQUEST_HEADERS: Record<string, string> = {
  'user-agent': 'NternCompanyIcons/1.0 (+https://intern-notifs.jdkrasnick.workers.dev; read-only)',
  accept: 'text/html,application/xhtml+xml',
};
const tieBreakSchemaName = 'company_icon_domain_resolution';
/** What the confirmation path cost this pass, shared with its caller. */
interface ConfirmationStats {
  probes: number;
  ties: number;
}

/** How many declared site assets the fallback will consider from one page. */
const MAX_SITE_ASSET_CANDIDATES = 6;
/** Bounded provider work per employer: one query each for the names worth asking. */
const MAX_DECLARED_NAME_QUERIES = 3;
const MAX_PROVIDER_QUERIES_PER_EMPLOYER = 4;
/** A domain decision confirms at most this many corroborated candidates by fetching them. */
const MAX_CONFIRMATION_PROBES = 3;

/**
 * The two Logo.dev credentials, from any name an operator may have provisioned.
 *
 * They are not interchangeable: the secret key authorizes the name search
 * (`Authorization: Bearer`), and only the account's publishable token authorizes
 * `img.logo.dev` — the secret key is answered with `401` there. Presenting one where
 * the other belongs silently disables every provider-sourced icon, because the
 * verified-image gate can then never confirm one.
 */
export function logoDevCredentials(env: {
  LOGO_DEV_TOKEN?: string;
  LOGO_DEV_IMAGE_TOKEN?: string;
  LOGO_SECRET_KEY?: string;
  LOGO_PUBLISHABLE_KEY?: string;
  LOGO_DEV_PUBLISHABLE_KEY?: string;
  LOGO_DEV_PUBLISHABLE_TOKEN?: string;
}): { logoDevToken?: string; logoDevImageToken?: string } {
  const logoDevToken = env.LOGO_DEV_TOKEN ?? env.LOGO_SECRET_KEY;
  const logoDevImageToken = env.LOGO_DEV_IMAGE_TOKEN
    ?? env.LOGO_PUBLISHABLE_KEY ?? env.LOGO_DEV_PUBLISHABLE_KEY ?? env.LOGO_DEV_PUBLISHABLE_TOKEN;
  return {
    ...(logoDevToken ? { logoDevToken } : {}),
    ...(logoDevImageToken ? { logoDevImageToken } : {}),
  };
}

export interface EmployerIconResolverEnvironment {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  /**
   * Server-side Logo.dev credentials. Neither is emitted in a response, key, or log.
   *
   * They are two different credentials on purpose: the secret key authorizes the
   * name search (`Authorization: Bearer`), and only the account's publishable token
   * authorizes `img.logo.dev` — the secret key is answered with `401` there. Passing
   * one where the other belongs silently disables every provider-sourced icon,
   * because the verified-image gate can never confirm one.
   */
  LOGO_DEV_TOKEN?: string;
  /** Publishable Logo.dev token (`pk_…`) used for the image endpoint. */
  LOGO_DEV_IMAGE_TOKEN?: string;
  /** Accepted aliases, so provisioning by either name works. */
  LOGO_SECRET_KEY?: string;
  LOGO_PUBLISHABLE_KEY?: string;
  LOGO_DEV_PUBLISHABLE_KEY?: string;
  LOGO_DEV_PUBLISHABLE_TOKEN?: string;
  /** Brandfetch client ID; used for in-memory corroboration only. */
  BRANDFETCH_CLIENT_ID?: string;
  OPENAI_KEY?: string;
}

export interface EmployerIconResolverDependencies {
  resolver: HostResolver;
  fetchImpl?: typeof fetch;
  /** Overridden in tests so no network call is made. */
  infer?: (request: OpenAIJsonRequest) => Promise<OpenAIJsonResult>;
  /**
   * Rasterizes a board logo published only as SVG. The ingestion Worker passes the
   * resvg renderer; a caller without one simply refuses those boards, which is why
   * the diagnostic and the API Worker can share this code unchanged.
   */
  rasterizeSvg?: IconSvgRasterizer;
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
  /**
   * Employer-domain fetches spent confirming candidates, and how many employers were
   * left to the model because two candidates both named themselves. This is the price of
   * the confirmation path, and observe mode is where it should be read before anyone
   * raises the sweep size.
   */
  confirmationProbes: number;
  confirmationTies: number;
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
    confirmationProbes: 0, confirmationTies: 0,
  };
  if (settings.mode === 'off') return result;

  result.backfilled = await backfillSeedlessEmployers(store, settings, now);
  const tasks = await store.claimDue(now.toISOString(), settings.maxPerSweep, ICON_LEASE_MS);
  result.claimed = tasks.length;
  const providerOutcomes: Record<string, number> = {};
  const confirmation: ConfirmationStats = { probes: 0, ties: 0 };

  for (const task of tasks) {
    try {
      const outcome = await resolveEmployerIconTask({ store, task, settings, env, now, deps, providerOutcomes, confirmation });
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

  result.confirmationProbes = confirmation.probes;
  result.confirmationTies = confirmation.ties;
  const reasonCodes: Record<string, number> = {};
  for (const reasonCode of result.reasonCodes) reasonCodes[reasonCode] = (reasonCodes[reasonCode] ?? 0) + 1;
  console.log(JSON.stringify({
    event: 'company_icon_resolution_complete',
    mode: result.mode,
    company_icon_resolution_attempted_total: result.claimed,
    company_icon_resolution_resolved_total: result.resolved,
    company_icon_resolution_confirmation_probes: result.confirmationProbes,
    company_icon_resolution_confirmation_ties: result.confirmationTies,
    company_icon_resolution_monogram_total: result.unresolved + result.retryable,
    company_icon_resolution_retryable_total: result.retryable,
    company_icon_resolution_backfilled_total: result.backfilled,
    company_icon_resolution_provider_outcomes: providerOutcomes,
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
    // Carry the employer's own posting link when the catalog still has one: a task with
    // a link resolves exactly as a live admission would, while a nameless seed can only
    // reach a provider nomination and often declines ("AEVEX" has no provider entry,
    // but the Greenhouse posting's own board link names `aevex.com`).
    const posting = await store.latestPostingForEmployer(employer.id);
    const provider = posting?.provider ?? 'reviewed-registry';
    const sourceId = posting?.sourceId ?? 'reviewed-registry';
    const prefix = `${provider}-`;
    const tenant = sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : undefined;
    const recorded = await enqueueEmployerIconResolution(store, {
      canonicalEmployerId: employer.id, displayName: employer.displayName,
      roleTitle: posting?.title ?? '', applicationUrl: posting?.url ?? '',
      provider, sourceId,
      ...(tenant ? { tenant } : {}),
      ...(posting?.provenance ? { provenance: posting.provenance } : {}),
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
  /**
   * Accumulator for the whole pass. The provider call happens per task, but the
   * operator needs a pass-level hit rate to judge whether the provider is actually
   * finding employers, so the caller owns the tally.
   */
  providerOutcomes?: Record<string, number>;
  /** Pass-level tally of what confirming candidates cost and how often it tied. */
  confirmation?: ConfirmationStats;
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
  // report must be reviewed by a person rather than retried automatically. Only
  // `reviewed` is a person's icon: a board logo or a site asset this resolver wrote is
  // machine work, so the employer's *domain* is still worth deciding on a revalidation —
  // and `POST …/resolve` must be able to re-arm one.
  if (context.iconKey && context.iconSource === 'reviewed') {
    await store.dropTask(task.id, at, 'reviewed-icon-present');
    return { outcome: 'resolved', reasonCode: 'reviewed-icon-present' };
  }
  if (context.resolutionStatus === 'invalidated' || previousInvalidation) {
    // A withdrawn decision waits for a person. Releasing the lease keeps the row
    // out of the claim set without rewriting the status the review queue reports.
    await store.release(task.id, at);
    return { outcome: 'unresolved', reasonCode: 'awaiting-review' };
  }
  if (context.resolutionStatus === 'resolved' && !(await store.hasResolvedTask(context.id))) {
    // A decision a person settled before any sweep reached the employer — an
    // operator `confirm` on an unswept employer — writes the canonical status but
    // no resolved task row, so the task in hand can only be a stale seed from an
    // earlier deploy. Dropping it ends the row without letting the sweep overwrite
    // a domain a person chose with a provider's namesake. An employer the resolver
    // itself resolved still has its resolved task, so it is not dropped here: that
    // task is a fresh revalidation the sweep is meant to decide. `POST …/resolve`
    // clears the status to re-open a settled decision deliberately.
    await store.dropTask(task.id, at, 'canonical-decision-settled');
    return { outcome: 'unresolved', reasonCode: 'canonical-decision-settled' };
  }

  const gathered = await gatherIconEvidence(seed, deps);
  // What the ATS board calls this employer, gated to names that denote a company
  // rather than a landing page. Used both to widen the provider query and as
  // identity evidence, so it is computed once.
  const declaredName = plausibleEmployerName(gathered?.page.declaredEmployerName)
    ? gathered!.page.declaredEmployerName : undefined;
  // Other names the employer's own page declares about itself — a structured-data
  // organisation name, the site name — which is exactly what a search index holds when
  // the catalog carries a program name instead of the brand.
  const declaredNames = [...new Set([
    ...(declaredName ? [declaredName] : []),
    ...(gathered?.page.organizations ?? []).flatMap((organization) => organization.name ? [organization.name] : []),
    ...(gathered?.page.ogSiteName ? [gathered.page.ogSiteName] : []),
  ].filter((name) => plausibleEmployerName(name)).map((name) => name.trim()).filter(Boolean))].slice(0, MAX_DECLARED_NAME_QUERIES);
  const providers = await lookupProviderDomains(seed, {
    ...logoDevCredentials(env),
    ...(env.BRANDFETCH_CLIENT_ID ? { brandfetchClientId: env.BRANDFETCH_CLIENT_ID } : {}),
  }, deps, declaredNames);
  if (input.providerOutcomes) {
    for (const [provider, outcome] of Object.entries(providers.outcomes)) {
      input.providerOutcomes[`${provider}:${outcome}`] = (input.providerOutcomes[`${provider}:${outcome}`] ?? 0) + 1;
    }
  }
  const candidates = iconCandidates(seed, context, gathered, providers, declaredName);
  const decision = decideIconDomain(candidates);
  const attempt = task.attempts + 1;

  // The employer's own uploaded logo is independent of the domain decision: it is
  // the employer's mark, published by the employer on its own board, so it renders
  // even while the domain stays unknown. Never fatal — an absent or unusable asset
  // simply leaves the domain path to decide. Its provenance is recorded on the
  // employer row as `icon_source = 'platform'`.
  await storePlatformLogo({ store, env, context, gathered, now, deps });

  if (decision.outcome === 'resolved' && decision.selectedDomain) {
    return acceptSelectedDomain({ ...input, context, seed, decision, gathered, providers, attempt, at });
  }
  // A candidate the domain itself vouches for is decided by that proof, before spending
  // the employer's model call at all — and it is the same proof a proposal needs, so a
  // domain can never be accepted here that a proposal could not have justified.
  if (decision.outcome !== 'resolved') {
    const confirmed = await confirmDomainCandidate({
      decision, displayName: context.displayName, declaredName, deps,
      ...(input.confirmation ? { stats: input.confirmation } : {}),
    });
    if (confirmed) {
      console.log(JSON.stringify({
        event: 'company_icon_resolution_domain_confirmed', canonicalEmployerId: context.id,
        domain: confirmed.domain, evidenceIds: confirmed.evidenceIds, score: confirmed.score,
      }));
      return acceptSelectedDomain({
        ...input, context, seed, gathered, providers, attempt, at,
        decision: {
          outcome: 'resolved', scores: decision.scores,
          selectedDomain: confirmed.domain, selectedScore: confirmed.score,
          reason: `the domain names itself as ${context.displayName}`,
        },
        selectedSource: 'confirmed',
      });
    }
  }
  // A model call that throws — an OpenAI outage — must not become an immediate,
  // un-backoff'd retry of the same task: record it as the transient failure it is.
  const transientModelFailure = async (): Promise<ResolveOutcome> => {
    await store.markRetryable({
      taskId: task.id,
      evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
        outcome: 'retryable', reasonCode: 'model-call-failed', attempt,
      })),
      nextRetryAt: new Date(now.getTime() + transientRetryDelay(attempt)).toISOString(), now: at,
    });
    return { outcome: 'retryable', reasonCode: 'model-call-failed' };
  };
  if (decision.outcome === 'llm-review') {
    let escalation: ResolveOutcome | undefined;
    try {
      escalation = await escalateToTieBreak({ ...input, context, seed, decision, gathered, providers, attempt, at, declaredName });
    } catch { return transientModelFailure(); }
    if (escalation) return escalation;
  }
  // Nothing to rank: on a platform host the page can name the employer without
  // naming any domain, so the resolver may ask once for a domain — and then has to
  // prove it, because the domain itself must say it belongs to this employer.
  if (decision.outcome === 'unresolved') {
    let proposal: ResolveOutcome | undefined;
    try {
      proposal = await proposeDomain({ ...input, context, seed, decision, gathered, providers, attempt, at, declaredName });
    } catch { return transientModelFailure(); }
    if (proposal) return proposal;
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
  /** The employer name the ATS board declares, when it is usable and differs. */
  declaredName?: string;
  /** Records which source produced the accepted domain. */
  selectedSource?: 'logo-dev' | 'proposed' | 'confirmed' | 'tie-break';
  /** Set when this task already made its one bounded model call. */
  modelCallSpent?: boolean;
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
  let assetSource: 'declared' | 'model' | undefined;
  const imageToken = logoDevCredentials(env).logoDevImageToken;

  if (imageToken) {
    const probe = await probeLogoDevImage(domain, imageToken, deps);
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
    imageVerified = probe.available;
    // Bytes reach R2 only once an operator has confirmed the plan permits
    // self-hosting; otherwise the icon is rendered from the provider's own CDN.
    if (probe.available && settings.logoDevRetentionLicensedAt && probe.bytes && probe.contentType) {
      iconKey = await storeIconAsset(env, context.id, probe.bytes, probe.contentType);
    }
  } else {
    console.warn(JSON.stringify({
      event: 'company_icon_resolution_image_token_missing', canonicalEmployerId: context.id, domain,
    }));
  }

  if (!imageVerified) {
    // The provider has nothing for this domain — no logo in its index, or no
    // credential to ask with. The employer's own verified site is the next source,
    // and reading it needs no provider at all.
    const asset = await storeDomainAsset({
      store, env, context, task, domain, now, deps,
      // A task gets at most one model call. A tie-break or proposal already spent it,
      // so the asset pick may not spend a second one in the same task.
      modelBudgetAvailable: input.modelCallSpent !== true
        && withinTieBreakBudget(context, task.evidenceFingerprint, now),
      ...(gathered?.siteAssetUrls ? { inHandSiteAssetUrls: gathered.siteAssetUrls } : {}),
    });
    if (asset) {
      iconKey = asset.key;
      assetSource = asset.source;
    } else if (!imageToken) {
      // Still a configuration state rather than a verdict on this employer: say so,
      // and retry soon instead of spending its revalidation window on a monogram.
      // `markRetryable` (not `markUnresolved`) keeps a config problem out of the
      // exception queue and out of the attempt count.
      await store.markRetryable({
        taskId: task.id,
        evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
          outcome: 'retryable', reasonCode: 'image-token-missing',
        })),
        nextRetryAt: new Date(now.getTime() + transientRetryDelay(input.attempt)).toISOString(), now: at,
      });
      return { outcome: 'retryable', reasonCode: 'image-token-missing' };
    } else {
      // A selected domain with no real image anywhere we can read is not usable.
      // Record the decision but publish a monogram rather than a broken image.
      await store.markUnresolved({
        taskId: task.id, canonicalEmployerId: task.canonicalEmployerId,
        evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
          outcome: 'unresolved', reasonCode: 'image-unavailable',
          ...(input.tieBreak ? { tieBreak: input.tieBreak } : {}),
        })),
        nextRetryAt: new Date(now.getTime() + unresolvedRetryDelay(input.attempt)).toISOString(), now: at,
      });
      return { outcome: 'unresolved', reasonCode: 'image-unavailable' };
    }
  }

  // The decision is recorded even in observe mode; observe only withholds it
  // from readers. That is what lets an operator switch to resolve mode and see
  // the week of recorded decisions immediately instead of waiting for a sweep.
  await store.markResolved({
    taskId: task.id, canonicalEmployerId: task.canonicalEmployerId,
    selectedDomain: domain,
    selectedSource: input.selectedSource ?? 'logo-dev',
    confidence: decision.selectedScore ?? 0,
    evidenceJson: boundedIconEvidence(evidenceRecord(seed, decision, gathered, providers, {
      outcome: 'resolved',
      reasonCode: assetSource ? `domain-accepted-site-${assetSource}` : 'domain-accepted',
      imageVerified: imageVerified || assetSource !== undefined,
      ...(assetSource ? { assetSource } : {}),
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
    selectedSource: 'tie-break',
    modelCallSpent: true,
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
 * Asks once for a domain, then proves it.
  *
  * This is the only path where a model introduces a URL rather than ranking
  * submitted ones, so nothing about the answer is trusted: the proposed domain is
  * fetched through the same SSRF controls as any other link, and it must present
  * itself as this employer — naming either the catalog name or the name the
  * employer's own board declares. Only then does it become a candidate, and the
  * verified-image gate still applies afterwards. A proposal that fails verification
  * is recorded and discarded.
  *
  * Shares the tie-breaker's budget: one call per employer per window.
  */
 async function proposeDomain(input: AcceptInput): Promise<ResolveOutcome | undefined> {
   const { store, task, env, now, deps, context, seed, gathered, at, declaredName } = input;
   const apiKey = env.OPENAI_KEY;
   if (!apiKey) return undefined;
   if (!withinTieBreakBudget(context, task.evidenceFingerprint, now)) return undefined;

   const infer = deps.infer ?? ((request: OpenAIJsonRequest) => inferOpenAIJson(apiKey, request, deps.fetchImpl ?? fetch));
   const result = await infer({
     prompt: { system: proposalSystemPrompt, user: JSON.stringify(proposalInput(seed, gathered, declaredName)) },
     schemaName: 'company_icon_domain_proposal', schema: iconProposalSchema,
     model: shadowDefaultModelId, maxOutputTokens: 300,
   });
   await store.recordTieBreak({
     canonicalEmployerId: context.id, at, evidenceFingerprint: task.evidenceFingerprint,
     inputTokens: result.inputTokens, outputTokens: result.outputTokens,
   });

   const proposal = await judgeIconProposal({
     displayName: context.displayName, declaredName, deps, response: result.response,
   });
   logProposal(context.id, proposal.domain, proposal.confidence, proposal.reasonCode);
   if (proposal.reasonCode !== 'verified' || !proposal.domain) return undefined;

   return acceptSelectedDomain({
     ...input,
     modelCallSpent: true,
     decision: {
       outcome: 'resolved', scores: decisionWithProposal(input.decision, proposal.domain),
       selectedDomain: proposal.domain, selectedScore: proposal.confidence ?? 0,
       reason: `proposal ${(proposal.confidence ?? 0).toFixed(2)} verified against the domain itself`,
     },
     selectedSource: 'proposed',
   });
 }

/**
 * The candidate a domain's own word decides, when the score alone could not.
 *
 * Every non-rejected candidate the evidence produced is fetched — strongest first, at
 * most `MAX_CONFIRMATION_PROBES` — and each must name the employer in its own metadata,
 * the same proof a proposal needs. Exactly one confirming is a decision; two confirming
 * is a real tie, which stays with the model. A provider commonly nominates a domain and
 * a near miss ("replit.com" and "asdf.xyz"), and a platform-hosted posting may offer no
 * second signal at all, so the alternative to asking the domains is asking the model
 * about a domain the domain itself could have settled.
 *
 * Shared by the sweep and the diagnostic so neither can report a decision the other
 * would not reach.
 */
async function confirmDomainCandidate(input: {
  decision: IconDomainDecision;
  displayName: string;
  declaredName?: string;
  deps: EmployerIconResolverDependencies;
  /** Counted so a pass reports what its confirmations cost. */
  stats?: ConfirmationStats;
}): Promise<{ domain: string; score: number; evidenceIds: readonly string[] } | undefined> {
  const { decision, displayName, declaredName, deps, stats } = input;
  if (decision.outcome === 'resolved') return undefined;
  // Bounded: a decision needs at most a few probes, and the cost is one fetch each.
  const candidates = decision.scores.filter((candidate) => !candidate.rejected).slice(0, MAX_CONFIRMATION_PROBES);
  const confirmed: Array<{ domain: string; score: number; evidenceIds: readonly string[] }> = [];
  for (const candidate of candidates) {
    if (stats) stats.probes += 1;
    if (await verifyProposedDomain(candidate.domain, displayName, declaredName, deps)) {
      confirmed.push({ domain: candidate.domain, score: candidate.score, evidenceIds: candidate.evidenceIds });
    }
  }
  // Two candidates naming themselves is a real tie, and the model owns it.
  if (stats && confirmed.length > 1) stats.ties += 1;
  return confirmed.length === 1 ? confirmed[0] : undefined;
}

/** What one proposal attempt concluded, and why, whether or not it was usable. */
export interface IconProposalOutcome {
  domain: string | null;
  confidence: number | null;
  reasonCode: 'not-attempted' | 'transport-host' | 'verified' | 'unverified';
}

/**
 * Judges one proposal answer: structural validation, the transport refusal, and then
 * proof that the domain names this employer in its own metadata. Shared by the live
 * sweep and the read-only diagnostic so both report the same verdict for the same
 * answer, and so a diagnostic cannot claim a proposal the resolver would refuse.
 */
export async function judgeIconProposal(input: {
  displayName: string;
  declaredName?: string;
  deps: EmployerIconResolverDependencies;
  response: unknown;
}): Promise<IconProposalOutcome> {
  const { displayName, declaredName, deps, response } = input;
  const proposal = parseIconProposal(response);
  if (!proposal || !proposal.domain || proposal.confidence < ICON_PROPOSAL_MINIMUM_CONFIDENCE) {
    return { domain: proposal?.domain ?? null, confidence: proposal?.confidence ?? null, reasonCode: 'not-attempted' };
  }
  if (isIconTransportHost(proposal.domain)) {
    return { domain: proposal.domain, confidence: proposal.confidence, reasonCode: 'transport-host' };
  }
  const verified = await verifyProposedDomain(proposal.domain, displayName, declaredName, deps);
  return { domain: proposal.domain, confidence: proposal.confidence, reasonCode: verified ? 'verified' : 'unverified' };
}

 /** Records the proposal as a candidate in the evidence trail before it is judged. */
 function decisionWithProposal(decision: IconDomainDecision, domain: string): IconCandidateScore[] {
   return [
     ...decision.scores,
     { domain, score: 0, signals: ['proposed-domain'], evidenceIds: [`proposed-domain:${domain}`], rejected: false },
   ];
 }

 /**
  * Fetches the proposed domain and requires it to name this employer. The homepage
  * is the employer's own statement about itself, which is what makes a model's
  * suggestion usable rather than merely plausible.
  */
 async function verifyProposedDomain(
   domain: string,
   displayName: string,
   declaredName: string | undefined,
   deps: EmployerIconResolverDependencies,
 ): Promise<boolean> {
   try {
     const result = await safeFetchText(`https://${domain}/`, {
       resolver: deps.resolver, fetcher: deps.fetchImpl ?? fetch,
       timeoutMs: ICON_LINK_TIMEOUT_MS, maxRedirects: ICON_LINK_MAX_REDIRECTS, maxBodyBytes: ICON_LINK_MAX_BYTES,
       onOversize: 'truncate',
     });
     if (result.status < 200 || result.status >= 300) return false;
     return proposedDomainMatchesEmployer(parseIconPageEvidence(result.body), displayName, declaredName);
   } catch {
     return false;
   }
 }

/**
 * One proposal attempt for the read-only diagnostic: the same model call, the same
 * judge, and no store write.
 */
async function runIconProposal(input: {
  seed: EmployerIconSeed;
  gathered?: GatheredIconEvidence;
  declaredName?: string;
  apiKey: string;
  deps: EmployerIconResolverDependencies;
}): Promise<IconProposalOutcome> {
  const { seed, gathered, declaredName, apiKey, deps } = input;
  const infer = deps.infer ?? ((request: OpenAIJsonRequest) => inferOpenAIJson(apiKey, request, deps.fetchImpl ?? fetch));
  try {
    const result = await infer({
      prompt: { system: proposalSystemPrompt, user: JSON.stringify(proposalInput(seed, gathered, declaredName)) },
      schemaName: 'company_icon_domain_proposal', schema: iconProposalSchema,
      model: shadowDefaultModelId, maxOutputTokens: 300,
    });
    return await judgeIconProposal({ displayName: seed.displayName, declaredName, deps, response: result.response });
  } catch {
    return { domain: null, confidence: null, reasonCode: 'not-attempted' };
  }
}

 function logProposal(employerId: string, domain: string | null, confidence: number | null, reasonCode: string): void {
   console.log(JSON.stringify({
     event: 'company_icon_resolution_proposal', canonicalEmployerId: employerId,
     domain, confidence, reasonCode,
   }));
 }

 const proposalSystemPrompt = [
   'You identify the official website domain of the employer behind one job posting.',
   'You are given bounded metadata from the posting because no provider nominated a domain.',
   'Use only the supplied JSON. Never invent a domain and never answer with a URL path.',
   'Answer with the registrable domain alone, for example "example.com", and be explicit about your confidence.',
   'Answer null when the evidence does not identify one employer clearly.',
 ].join(' ');

 function proposalInput(
   seed: EmployerIconSeed,
   gathered: GatheredIconEvidence | undefined,
   declaredName: string | undefined,
 ): Record<string, unknown> {
   return {
     employer: seed.displayName.slice(0, 200),
     ...(declaredName ? { employerAsItsBoardNamesIt: declaredName.slice(0, 200) } : {}),
     role: seed.roleTitle.slice(0, 200),
     source: { provider: seed.provider, ...(seed.tenant ? { tenant: seed.tenant.slice(0, 200) } : {}) },
     urls: {
       application: seed.applicationUrl.slice(0, 300),
       ...(gathered ? { final: gathered.finalUrl.slice(0, 300) } : {}),
     },
     page: {
       ...(gathered?.page.title ? { title: gathered.page.title.slice(0, 200) } : {}),
       ...(gathered?.page.ogSiteName ? { siteName: gathered.page.ogSiteName.slice(0, 200) } : {}),
       organizationDomains: (gathered?.page.organizations ?? []).flatMap((organization) => organization.domains ?? []).slice(0, 5),
     },
   };
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
  // Everything structural held and only the model's own confidence fell short, so the
  // answer is proven the way a proposal is: the domain itself must name this employer.
  // A self-reported confidence is a guess; a page that names the employer is evidence.
  let verified = false;
  if (acceptance.pendingVerification) {
    verified = await verifyProposedDomain(acceptance.pendingVerification.domain, seed.displayName, undefined, deps);
    console.log(JSON.stringify({
      event: 'company_icon_resolution_tie_break_verified',
      canonicalEmployerId: seed.canonicalEmployerId,
      domain: acceptance.pendingVerification.domain,
      confidence: acceptance.pendingVerification.confidence,
      verified,
    }));
  }
  const accepted = acceptance.accepted || verified;
  return {
    accepted,
    ...(accepted ? { domain: acceptance.domain ?? acceptance.pendingVerification!.domain } : {}),
    reasonCode: acceptance.accepted ? acceptance.reasonCode : verified ? 'accepted-domain-confirmed' : acceptance.reasonCode,
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
  "A candidate the employer's own Organization node or ATS board declares (evidence ids beginning jsonld-url or platform-website) is the employer's own statement of its domain, and outranks a careers host, an ATS host, or a provider nomination that merely shares the name.",
  'When two candidates both fit the name, prefer the corporate brand domain over a careers or jobs subdomain and over a namesake.',
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
  /**
   * The employer's uploaded board logos, most suitable first. Only URLs are kept;
   * page HTML is never retained.
   */
  platformLogoUrls?: string[];
  /** Marks the posting page itself declares about the employer, when it is on the employer's own site. */
  siteAssetUrls?: string[];
  /** Set when the link could not be read at all; providers still get a chance. */
  failure?: string;
  /** The HTTP status the posting answered with, recorded for the reviewer. */
  status?: number;
}

/**
 * How a posting's non-2xx response is treated. A rate limit, a bot wall, or a
 * server fault is the platform asking for room rather than evidence that the
 * employer has no logo, so it retries from an hour. A withdrawn or malformed
 * posting is not going to change its mind, so it takes the long backoff.
 */
function pageFailureOutcome(status: number): string {
  return status === 403 || status === 406 || status === 408 || status === 425 || status === 429 || status >= 500
    ? 'transport' : 'blocked';
}

async function gatherIconEvidence(seed: EmployerIconSeed, deps: EmployerIconResolverDependencies): Promise<GatheredIconEvidence | undefined> {
  if (!seed.applicationUrl) return undefined;
  try {
    const result = await safeFetchText(seed.applicationUrl, {
      resolver: deps.resolver, fetcher: deps.fetchImpl ?? fetch,
      headers: ICON_PAGE_REQUEST_HEADERS,
      timeoutMs: ICON_LINK_TIMEOUT_MS, maxRedirects: ICON_LINK_MAX_REDIRECTS, maxBodyBytes: ICON_LINK_MAX_BYTES,
      onOversize: 'truncate',
    });
    // An error or challenge page is not the employer's posting: it names no
    // employer, carries no board art, and must not be recorded as if it had been
    // read. Providers still get their chance, so the employer is not lost.
    if (result.status < 200 || result.status >= 300) {
      return {
        finalUrl: result.url, redirectHosts: hostnames(result.redirects),
        page: { organizations: [] }, failure: pageFailureOutcome(result.status), status: result.status,
      };
    }
    const logoUrls = platformLogoUrls(result.body);
    // The employer's own declared marks, read from the page already in hand: for an
    // employer whose postings live on its own domain this is the whole site-asset
    // fallback with no extra request at all. Only URLs are kept, and the report is
    // bounded, so no page HTML is retained.
    const siteAssetUrls = siteLogoAssetCandidates(result.body, result.url).slice(0, MAX_SITE_ASSET_CANDIDATES);
    return {
      finalUrl: result.url,
      redirectHosts: hostnames(result.redirects),
      page: parseIconPageEvidence(result.body),
      ...(logoUrls.length ? { platformLogoUrls: logoUrls } : {}),
      ...(siteAssetUrls.length ? { siteAssetUrls } : {}),
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
  /**
   * What each provider actually did: `nominated`, `miss`, `failed`, or
   * `unconfigured`. This is the only honest way to see a provider's real hit rate,
   * because a miss and an unconfigured provider both yield no candidates.
   */
  outcomes: Record<string, string>;
}

function providerOutcome(response: ProviderResponse): string {
  if (response.failure === 'unconfigured') return 'unconfigured';
  if (response.failure !== undefined) return 'failed';
  return response.domains.length ? 'nominated' : 'miss';
}

/** Server-side provider credentials. A token never reaches a response or a key. */
export interface EmployerIconProviderCredentials {
  /** Logo.dev secret key (`sk_…`): authorizes the name search only. */
  logoDevToken?: string;
  /** Logo.dev publishable token (`pk_…`): authorizes the image endpoint only. */
  logoDevImageToken?: string;
  brandfetchClientId?: string;
}

async function lookupProviderDomains(
  seed: EmployerIconSeed,
  credentials: EmployerIconProviderCredentials,
  deps: EmployerIconResolverDependencies,
  /** Names the employer's own board or page declares, strongest first. */
  declaredNames: readonly string[] = [],
): Promise<ProviderLookup> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const failures: Record<string, string> = {};
  const [logoDev, brandfetch] = await Promise.all([
    searchProvider('logo-dev', credentials.logoDevToken, seed, fetchImpl, logoDevSearchUrl, providerDomainCandidates, declaredNames),
    searchProvider('brandfetch', credentials.brandfetchClientId, seed, fetchImpl,
      (name) => brandfetchSearchUrl(name, credentials.brandfetchClientId), providerDomainCandidates, declaredNames),
  ]);
  if (logoDev.failure) failures['logo-dev'] = logoDev.failure;
  if (brandfetch.failure) failures.brandfetch = brandfetch.failure;
  const retryable = [logoDev, brandfetch].filter((entry) => entry.retryAfterMs !== undefined || entry.transient === true);
  return {
    logoDev: logoDev.domains, brandfetch: brandfetch.domains,
    transientFailure: retryable.length > 0,
    ...(retryable.length ? { retryAfterMs: Math.max(0, ...retryable.map((entry) => entry.retryAfterMs ?? 0)) } : {}),
    failures,
    outcomes: { 'logo-dev': providerOutcome(logoDev), brandfetch: providerOutcome(brandfetch) },
  };
}

interface ProviderResponse {
  domains: string[];
  /**
   * How well the matching entry denotes the employer: `2` the same name, `1` only the
   * brand's own spelling of it. A weak answer does not end the search, because the next
   * query may reach the entry that carries an actual logo.
   */
  strength?: 0 | 1 | 2;
  failure?: string;
  transient?: boolean;
  retryAfterMs?: number;
}

/**
 * One provider search, with a second attempt on the employer's distinctive brand
 * token when the full catalog name finds nothing.
 *
 * Real catalogs carry names a search index does not hold verbatim —
 * "Flagship Pioneering Co-Op Program", "Palantir Technologies" — while the brand
 * itself does match. Both attempts use the same exact-name rule, so the retry can
 * only find a domain the first attempt could have accepted on a shorter query.
 */
async function searchProvider(
  provider: 'logo-dev' | 'brandfetch',
  credential: string | undefined,
  seed: EmployerIconSeed,
  fetchImpl: typeof fetch,
  url: (name: string) => string,
  parse: (value: unknown, displayName: string) => { domains: string[]; strength: 0 | 1 | 2 },
  /** Names the employer's own board and page declare, strongest first. */
  declaredNames: readonly string[],
): Promise<ProviderResponse> {
  // Logo.dev's search is authorized by its secret key; Brandfetch's answers without a
  // client id, which only attributes the call to the account.
  if (!credential && provider === 'logo-dev') return { domains: [], failure: 'unconfigured' };
  const headers: Record<string, string> = credential && provider === 'logo-dev'
    ? { authorization: `Bearer ${credential}` } : {};
  const first = await requestProviderDomains(url(seed.displayName), headers, seed.displayName, parse, fetchImpl);
  if ((first.domains.length && first.strength === 2) || first.failure !== undefined) return first;

  // Only retry when the query actually changes, and always match the provider's
  // answer against the name that was asked for.
  const brand = employerDistinctiveTerms(seed.displayName).join(' ');
  const full = seed.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
  const queries = [...new Set([
    // The employer's own declared names come first: a board or a structured-data
    // organisation name is what the index holds when the catalog carries a program name.
    // "Rivian and Volkswagen Group Technologies" is reachable where "RV Tech" is not.
    ...declaredNames.filter((name) => name.trim() && name.trim().toLowerCase() !== full),
    ...(brand && brand !== full ? [brand] : []),
  ])].slice(0, MAX_PROVIDER_QUERIES_PER_EMPLOYER);
  let failure: ProviderResponse | undefined;
  // A spelling-variant match is worth keeping, but not worth stopping for: the next
  // query may reach the entry that has a logo.
  let weak: ProviderResponse | undefined;
  for (const query of queries) {
    const response = await requestProviderDomains(url(query), headers, query, parse, fetchImpl);
    if (response.domains.length && response.strength === 2) {
      // Which input actually reached the provider is the only way to know whether the
      // extra names are earning their requests.
      console.log(JSON.stringify({
        event: 'company_icon_provider_query_won', provider,
        canonicalEmployerId: seed.canonicalEmployerId, query, strength: response.strength,
        catalogName: seed.displayName, declaredNames: declaredNames.length,
      }));
      return response;
    }
    if (response.domains.length && !weak) weak = response;
    // Keep trying the remaining queries: one query failing, or the provider having
    // no answer for it, must not hide the name the employer's own board declares.
    // The first problem is still reported when nothing answers.
    if (failure === undefined && response.failure !== undefined) failure = response;
  }
  // A weak answer beats the first query's failure, but never a stronger one.
  return weak ?? failure ?? first;
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
  parse: (value: unknown, displayName: string) => { domains: string[]; strength: 0 | 1 | 2 },
  fetchImpl: typeof fetch,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ICON_PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    if (response.status === 404) return { domains: [], strength: 0 };
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
    const parsed = parse(JSON.parse(new TextDecoder().decode(bytes)), displayName);
    return { domains: parsed.domains.slice(0, MAX_PROVIDER_CANDIDATES), strength: parsed.strength };
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
  declaredName?: string,
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

  let declaredNameMatchesEmployer = false;
  let pageNamedDomain: string | undefined;
  // The host admission reviewed and recorded for this role. Where the link later
  // redirects stays evidence (final-url, redirect-host) but is not the recorded
  // destination, and the recorded one is both the reviewed fact and usually the
  // employer's primary domain rather than a role-specific site.
  const applicationHost = registrableDomain(hostOf(seed.applicationUrl) ?? '');
  if (gathered) {
    add(hostOf(gathered.finalUrl) ?? '', 'final-url');
    for (const host of gathered.redirectHosts.slice(0, -1)) add(host, 'redirect-host');
    const matched = (gathered.page.organizations ?? [])
      .filter((organization) => organization.name && organization.domains?.length
        && iconTextMatchesEmployer(organization.name, context.displayName));
    const matchedDomains = matched.flatMap((organization) => organization.domains!);
    for (const domain of matchedDomains) { add(domain, 'jsonld-url'); add(domain, 'jsonld-name'); }
    // What the ATS board itself says the employer's site is, and what it calls the
    // employer. Both are the platform's record for the board the catalog reviewed,
    // read from the page already in hand.
    const declaredDomain = gathered.page.declaredWebsite;
    if (declaredDomain) add(declaredDomain, 'platform-website');
    declaredNameMatchesEmployer = Boolean(declaredName)
      && (iconTextMatchesEmployer(declaredName, context.displayName)
        || providerNameMatchesEmployer(declaredName!, context.displayName));
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
    pageNamedDomain = declaredDomain
      ?? matchedDomains[0]
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
    if (declaredNameMatchesEmployer) add(target, 'platform-name');
    if (tenantCorroborates) add(target, 'ats-tenant');
  }
  for (const domain of providers.logoDev) add(domain, 'logo-dev');
  for (const domain of providers.brandfetch) add(domain, 'brandfetch');
  // An officially-admitted role's application host is the employer's own site. A
  // transport host is not: it is the platform, and the exemption above decides
  // whether it is the employer's own platform domain.
  if (officialIconProvenance(seed.provenance) && applicationHost
    && (!isIconTransportHost(applicationHost) || employerNamesDomain(context.displayName, applicationHost))) {
    add(applicationHost, 'official-application-host');
  }
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
export async function probeLogoDevImage(
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
    const contentType = iconAssetType(result.headers.get('content-type'), result.body);
    if (!contentType) return { available: false, transient: false };
    return { available: true, transient: false, bytes: result.body, contentType };
  } catch {
    return { available: false, transient: true };
  }
}

/**
 * Stores the logo the employer uploaded to its own ATS board.
 *
 * No identity inference is involved: the page is the employer's own posting, and
 * the asset is on the platform's board-logo host, so the mark belongs to the
 * employer by construction. The bytes are copied into our own bucket so rendering
 * never depends on the platform's CDN, and the key records its own provenance.
 *
 * Two asset shapes need a judgement beyond "is it an image". A board that publishes
 * its mark only as SVG is rasterized, because the API serves raster formats only. A
 * Greenhouse banner is the employer's own art but is a promotional strip as often as
 * it is the employer's mark, so it is stored only when its own shape says it is
 * square enough to be an icon.
 */
async function storePlatformLogo(input: {
  store: D1EmployerIconStore;
  env: EmployerIconResolverEnvironment;
  context: EmployerIconContext;
  gathered?: GatheredIconEvidence;
  now: Date;
  deps: EmployerIconResolverDependencies;
}): Promise<string | undefined> {
  const { store, env, context, gathered, now, deps } = input;
  const urls = gathered?.platformLogoUrls ?? [];
  // A reviewer's icon and an already-stored one are both left alone.
  if (!urls.length || context.iconKey) return undefined;
  // Candidates are tried in order: a board can offer a square logo as an SVG and a
  // usable raster behind it, so one unusable asset must not end the attempt.
  for (const url of urls) {
    const banner = isPlatformBannerUrl(url);
    try {
      const result = await safeFetchBytes(url, {
        resolver: deps.resolver, fetcher: deps.fetchImpl ?? fetch,
        timeoutMs: ICON_PROVIDER_TIMEOUT_MS, maxRedirects: 1, maxBodyBytes: MAX_ICON_ASSET_BYTES,
      });
      const asset = result.status >= 200 && result.status < 300
        ? await platformAsset(result.headers.get('content-type'), result.body, banner, deps)
        : { usable: false as const, reason: 'status' };
      if (!asset.usable) {
        console.log(JSON.stringify({
          event: 'company_icon_platform_logo_rejected', canonicalEmployerId: context.id,
          status: result.status, byteLength: result.body.byteLength,
          contentType: result.headers.get('content-type'), kind: banner ? 'banner' : 'logo', reason: asset.reason,
        }));
        continue;
      }
      const key = await storeIconAsset(env, context.id, asset.bytes, asset.contentType, 'platform');
      await store.markPlatformIcon({ canonicalEmployerId: context.id, iconKey: key, now: now.toISOString() });
      console.log(JSON.stringify({
        event: 'company_icon_platform_logo_stored', canonicalEmployerId: context.id, key,
        kind: banner ? 'banner' : 'logo', format: asset.contentType, rasterized: asset.rasterized,
      }));
      return key;
    } catch (error) {
      console.log(JSON.stringify({
        event: 'company_icon_platform_logo_failed', canonicalEmployerId: context.id,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      }));
    }
  }
  return undefined;
}

type PlatformAsset =
  | { usable: true; bytes: Uint8Array; contentType: string; rasterized: boolean }
  | { usable: false; reason: string };

/**
 * The storable image an asset carries, if any. A raster is taken as it stands,
 * unless it is a banner whose shape is not square enough to be an icon. An SVG is
 * rasterized, so what reaches the bucket is never the publisher's document — and a
 * banner is shape-checked after rasterization too, because the banner rule is about
 * the picture, not about the container it arrived in.
 */
async function platformAsset(
  contentType: string | null | undefined,
  bytes: Uint8Array,
  banner: boolean,
  deps: EmployerIconResolverDependencies,
): Promise<PlatformAsset> {
  const raster = iconAssetType(contentType, bytes);
  if (raster) {
    if (banner && !bannerAssetShapeUsable(bytes)) return { usable: false, reason: 'banner-not-square' };
    return { usable: true, bytes, contentType: raster, rasterized: false };
  }
  const svg = iconSvgAsset(contentType, bytes);
  if (!svg) return { usable: false, reason: 'not-a-raster' };
  if (!deps.rasterizeSvg) return { usable: false, reason: 'svg-not-servable' };
  const safe = safeIconSvg(svg);
  if (!safe) return { usable: false, reason: 'svg-unsafe' };
  const png = await deps.rasterizeSvg(safe);
  if (!png || png.byteLength === 0 || png.byteLength > MAX_ICON_ASSET_BYTES) return { usable: false, reason: 'svg-raster-failed' };
  if (banner && !bannerAssetShapeUsable(png)) return { usable: false, reason: 'banner-not-square' };
  return { usable: true, bytes: png, contentType: 'image/png', rasterized: true };
}

/**
 * The employer's own site, read when its board published nothing usable and the
 * provider has no icon for the domain.
 *
 * The domain is already verified by the time this runs, so the page in hand is the
 * employer's own: only **declared** assets are read (touch icon, structured `logo`,
 * share card, favicon), in the order a site publishes them as its brand mark, and
 * each one must survive the same fetch, raster, size, and shape gates as any other
 * asset. When none does, and the employer still has its one bounded model call, the
 * model may choose among the candidates — or name a URL on that same domain, which is
 * the one place a model is allowed to point at an asset. Nothing else is trusted: an
 * off-domain URL is dropped before a request is made, and the bytes still have to
 * pass every gate.
 */
async function storeDomainAsset(input: {
  store: D1EmployerIconStore;
  env: EmployerIconResolverEnvironment;
  context: EmployerIconContext;
  task: EmployerIconTask;
  domain: string;
  now: Date;
  deps: EmployerIconResolverDependencies;
  /** True when the employer's single model call for this window is still unspent. */
  modelBudgetAvailable: boolean;
  /** Assets the posting page already declared, when that page is on the employer's own site. */
  inHandSiteAssetUrls?: readonly string[];
}): Promise<{ key: string; source: 'declared' | 'model'; candidates: number } | undefined> {
  const { store, env, context, task, domain, now, deps, modelBudgetAvailable } = input;
  if (context.iconKey) return undefined;

  const storeCandidate = async (
    bytes: Uint8Array, contentType: string, source: 'declared' | 'model', url: string, candidateCount: number,
  ) => {
    const key = await storeIconAsset(env, context.id, bytes, contentType, 'domain-asset');
    await store.markPlatformIcon({
      canonicalEmployerId: context.id, iconKey: key, now: now.toISOString(), source: 'domain-asset',
    });
    console.log(JSON.stringify({
      event: 'company_icon_domain_asset_stored', canonicalEmployerId: context.id, key,
      source, url, candidates: candidateCount, format: contentType,
    }));
    return { key, source, candidates: candidateCount };
  };

  // The cheapest source first: an own-domain posting page has already been fetched, so
  // its own declared marks cost nothing and are the employer's own word about itself.
  const inHand = (input.inHandSiteAssetUrls ?? []).filter((url) => sameRegistrableDomain(url, domain));
  for (const url of inHand) {
    const asset = await fetchDomainAsset(url, deps);
    if (asset) return storeCandidate(asset.bytes, asset.contentType, 'declared', url, inHand.length);
  }

  // Then the domain's homepage: the page a visitor lands on, and often the one that
  // declares the touch icon the sub-page omitted.
  let page: { body: string; url: string } | undefined;
  try {
    const result = await safeFetchText(`https://${domain}/`, {
      resolver: deps.resolver, fetcher: deps.fetchImpl ?? fetch, headers: ICON_PAGE_REQUEST_HEADERS,
      timeoutMs: ICON_LINK_TIMEOUT_MS, maxRedirects: ICON_LINK_MAX_REDIRECTS, maxBodyBytes: ICON_LINK_MAX_BYTES,
      onOversize: 'truncate',
    });
    if (result.status >= 200 && result.status < 300) page = { body: result.body, url: result.url };
  } catch { /* the in-hand assets were already tried */ }
  const candidates = page ? siteLogoAssetCandidates(page.body, page.url).slice(0, MAX_SITE_ASSET_CANDIDATES) : [];
  for (const url of candidates) {
    const asset = await fetchDomainAsset(url, deps);
    if (asset) return storeCandidate(asset.bytes, asset.contentType, 'declared', url, candidates.length);
  }
  if (!candidates.length && !inHand.length) console.log(JSON.stringify({
    event: 'company_icon_domain_asset_none', canonicalEmployerId: context.id, domain,
  }));
  if (!modelBudgetAvailable || !env.OPENAI_KEY) return undefined;

  const pick = await runIconAssetPick({
    apiKey: env.OPENAI_KEY, deps,
    employer: context.displayName, domain,
    hrefs: page ? siteAssetHrefs(page.body, page.url).slice(0, 12) : [],
    candidates,
  });
  // The call happened, so it is paid for even when the answer is unusable — otherwise
  // a rejected nomination or a failed fetch is bought again on the next sweep.
  if (pick) {
    await store.recordTieBreak({
      canonicalEmployerId: context.id, at: now.toISOString(),
      evidenceFingerprint: task.evidenceFingerprint,
      inputTokens: pick.inputTokens, outputTokens: pick.outputTokens,
    });
  }
  if (!pick?.nomination) return undefined;
  const asset = await fetchDomainAsset(pick.nomination.url, deps);
  if (!asset) {
    console.log(JSON.stringify({
      event: 'company_icon_domain_asset_rejected', canonicalEmployerId: context.id,
      url: pick.nomination.url, kind: pick.nomination.kind, confidence: pick.nomination.confidence,
    }));
    return undefined;
  }
  return storeCandidate(asset.bytes, asset.contentType, 'model', pick.nomination.url, candidates.length);
}

/** Whether an asset URL belongs to the employer's verified domain. */
function sameRegistrableDomain(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const wanted = domain.toLowerCase();
    return host === wanted || host.endsWith(`.${wanted}`);
  } catch { return false; }
}

/** One asset fetch, judged exactly as a board logo is. */
async function fetchDomainAsset(
  url: string,
  deps: EmployerIconResolverDependencies,
): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
  try {
    const result = await safeFetchBytes(url, {
      resolver: deps.resolver, fetcher: deps.fetchImpl ?? fetch,
      timeoutMs: ICON_PROVIDER_TIMEOUT_MS, maxRedirects: 1, maxBodyBytes: MAX_ICON_ASSET_BYTES,
    });
    if (result.status < 200 || result.status >= 300) return undefined;
    const raster = iconAssetType(result.headers.get('content-type'), result.body);
    if (raster) return assetShapeUsable(result.body) ? { bytes: result.body, contentType: raster } : undefined;
    const svg = iconSvgAsset(result.headers.get('content-type'), result.body);
    if (!svg || !deps.rasterizeSvg) return undefined;
    const safe = safeIconSvg(svg);
    if (!safe) return undefined;
    const png = await deps.rasterizeSvg(safe);
    if (!png || png.byteLength === 0 || png.byteLength > MAX_ICON_ASSET_BYTES) return undefined;
    return assetShapeUsable(png) ? { bytes: png, contentType: 'image/png' } : undefined;
  } catch { return undefined; }
}

/** Every `https` image URL the page references, for the model to choose from. */
function siteAssetHrefs(html: string, pageUrl: string): string[] {
  const found = new Set<string>();
  for (const [, value] of html.matchAll(VISIBLE_ASSET_PATTERN)) {
    try {
      const url = new URL(value, pageUrl);
      if (url.protocol === 'https:') found.add(url.href);
    } catch { /* relative junk */ }
  }
  return [...found].filter((url) => !isPlatformBannerUrl(url));
}

const VISIBLE_ASSET_PATTERN = /<img\b[^>]+src=["']([^"']+)["']|srcset=["']([^"']+)["']|url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/giu;

/**
 * The one call that may name an asset. It receives the assets read from the page and
 * the page's other image URLs, and may answer with one of them or with another URL on
 * the same domain; the answer is admitted only through `acceptIconAssetPick`.
 */
async function runIconAssetPick(input: {
  apiKey: string;
  deps: EmployerIconResolverDependencies;
  employer: string;
  domain: string;
  hrefs: readonly string[];
  candidates: readonly string[];
}): Promise<{
  inputTokens: number;
  outputTokens: number;
  nomination?: { url: string; kind: 'submitted' | 'nominated'; confidence: number };
} | undefined> {
  const { apiKey, deps, employer, domain, hrefs, candidates } = input;
  const infer = deps.infer ?? ((request: OpenAIJsonRequest) => inferOpenAIJson(apiKey, request, deps.fetchImpl ?? fetch));
  let result: OpenAIJsonResult;
  try {
    result = await infer({
      prompt: {
        system: assetSystemPrompt,
        user: JSON.stringify({
          employer,
          domain,
          declaredLogoAssets: [...candidates],
          imagesOnThePage: [...hrefs],
        }),
      },
      schemaName: 'company_icon_asset_pick', schema: iconAssetPickSchema,
      model: shadowDefaultModelId, maxOutputTokens: 200,
    });
  } catch { return undefined; }
  const tokens = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  const nomination = acceptIconAssetPick(parseIconAssetPick(result.response), candidates, domain);
  // The tokens are owed even when the answer is unusable, so the caller can bill the
  // employer's window for the call it actually made.
  if (!nomination) return tokens;
  console.log(JSON.stringify({
    event: 'company_icon_domain_asset_nominated', employer, domain,
    url: nomination.url, kind: nomination.kind, confidence: nomination.confidence,
  }));
  return {
    ...tokens,
    nomination: { url: nomination.url, kind: nomination.kind, confidence: nomination.confidence },
  };
}

const assetSystemPrompt = [
  'You choose the image that is one company\'s own logo, to be shown as a square app icon.',
  'Use only the supplied JSON. The declaredLogoAssets array lists the assets the company publishes as its mark, best first.',
  'Answer with one of those URLs, or, when none of them is the mark, with another https URL on the company\'s own domain.',
  'Never answer with a URL on another domain. Answer null when nothing in the input is the company mark.',
  'Prefer a square mark over a wide wordmark, and a real logotype over a share card or a screenshot.',
].join(' ');

/** Stores the provider's WebP output under an immutable, content-addressed key. */
async function storeIconAsset(
  env: EmployerIconResolverEnvironment,
  canonicalEmployerId: string,
  bytes: Uint8Array,
  contentType: string,
  kind: 'logo' | 'platform' | 'domain-asset' = 'logo',
): Promise<string> {
  const prefix = kind === 'domain-asset' ? 'site' : kind;
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const extension = contentType === 'image/webp' ? 'webp' : contentType.split('/')[1]!.replace('jpeg', 'jpg');
  const key = `company-icons/${canonicalEmployerId}/${prefix}-${digest}.${extension}`;
  await env.DOCUMENTS.put(key, bytes.buffer as ArrayBuffer, { httpMetadata: { contentType } });
  return key;
}

function unresolvedRetryDelay(attempt: number): number {
  return Math.min(ICON_UNRESOLVED_BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1), ICON_REVALIDATE_MS);
}

function transientRetryDelay(attempt: number, retryAfterMs?: number): number {
  const backoff = Math.min(ICON_TRANSIENT_BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1), ICON_TRANSIENT_MAX_RETRY_MS);
  // A server may ask for a `Retry-After` beyond the revalidation horizon; that must
  // never push an employer past the point where it would be re-checked anyway.
  return Math.min(Math.max(backoff, retryAfterMs ?? 0), ICON_REVALIDATE_MS);
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
    ...(record.provenance === 'official-ats' || record.provenance === 'official-structured'
      || record.provenance === 'employer-submitted' || record.provenance === 'reviewed-community'
      ? { provenance: record.provenance } : {}),
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
    ...(gathered?.status ? { pageStatus: gathered.status } : {}),
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
  if (!credentials.logoDevImageToken) return false;
  return (await probeLogoDevImage(domain, credentials.logoDevImageToken, deps)).available;
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
  /** The HTTP status the posting answered with, when it was not a success. */
  pageStatus?: number;
  pageOrganizations: string[];
  providerFailures: Record<string, string>;
  /** Provider nominations, display-only. Brandfetch data is never persisted. */
  logoDevDomains: string[];
  brandfetchDomains: string[];
  decision: IconDomainDecision;
  /** Set when the decision came from proving a corroborated candidate, not the model. */
  confirmedDomain?: { domain: string; score: number; evidenceIds: string[] };
  imageVerified?: boolean;
  tieBreak?: TieBreakOutcome & { called: true };
  /** Present when the candidate set was empty and one bounded call proposed a domain. */
  proposal?: IconProposalOutcome;
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
  const declaredName = plausibleEmployerName(gathered?.page.declaredEmployerName)
    ? gathered!.page.declaredEmployerName : undefined;
  // The diagnostic asks the providers exactly what the sweep asks them.
  const declaredNames = [...new Set([
    ...(declaredName ? [declaredName] : []),
    ...(gathered?.page.organizations ?? []).flatMap((organization) => organization.name ? [organization.name] : []),
    ...(gathered?.page.ogSiteName ? [gathered.page.ogSiteName] : []),
  ].filter((name) => plausibleEmployerName(name)).map((name) => name.trim()).filter(Boolean))];
  const providers = await lookupProviderDomains(seed, credentials, deps, declaredNames);
  const decision = decideIconDomain(iconCandidates(seed, context, gathered, providers, declaredName));
  const submitted = decision.scores.filter((candidate) => !candidate.rejected).slice(0, 5);
  const confirmed = await confirmDomainCandidate({ decision, displayName: input.seed.displayName, ...(declaredName ? { declaredName } : {}), deps });
  const tieBreak = !confirmed && decision.outcome === 'llm-review' && input.tieBreakApiKey && submitted.length
    ? { called: true as const, ...await runIconTieBreak({ seed, gathered, submitted, apiKey: input.tieBreakApiKey, deps }) }
    : undefined;
  // Nothing to rank: the live sweep asks once for a domain and then proves it, so the
  // diagnostic does the same rather than reporting a monogram the resolver would not.
  const proposal = decision.outcome === 'unresolved' && input.tieBreakApiKey
    ? await runIconProposal({ seed, gathered, declaredName, apiKey: input.tieBreakApiKey, deps })
    : undefined;
  const proposedDomain = proposal?.reasonCode === 'verified' ? proposal.domain ?? undefined : undefined;
  const tieBreakDomain = tieBreak?.accepted === true ? tieBreak.domain : undefined;
  // Probe the domain the sweep would actually publish, not the top-scored candidate
  // the decision happened to rank first, so `imageVerified` describes the right domain.
  const acceptedDomain = confirmed?.domain ?? tieBreakDomain ?? proposedDomain ?? decision.selectedDomain;
  const imageVerified = acceptedDomain && credentials.logoDevImageToken
    ? (await probeLogoDevImage(acceptedDomain, credentials.logoDevImageToken, deps)).available
    : undefined;
  return {
    seed,
    ...(gathered ? { finalUrl: gathered.finalUrl } : {}),
    redirectHosts: gathered?.redirectHosts ?? [],
    ...(gathered?.failure ? { pageFailure: gathered.failure } : {}),
    ...(gathered?.status ? { pageStatus: gathered.status } : {}),
    pageOrganizations: (gathered?.page.organizations ?? []).flatMap((organization) => organization.domains ?? []),
    providerFailures: providers.failures,
    logoDevDomains: providers.logoDev,
    brandfetchDomains: providers.brandfetch,
    decision,
    ...(confirmed ? { confirmedDomain: { ...confirmed, evidenceIds: [...confirmed.evidenceIds] } } : {}),
    ...(imageVerified === undefined ? {} : { imageVerified }),
    ...(tieBreak ? { tieBreak } : {}),
    ...(proposal ? { proposal } : {}),
  };
}
