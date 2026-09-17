import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createHash } from 'node:crypto';
import { evaluateJobFilter, inferJobFocuses, type FilterMatchReason, type JobFocus } from './core/filters.js';
import { postingIdentityKey, score } from './core/normalize.js';
import { platformFetch } from './core/platform-fetch.js';
import type { DeliveryReceipt, Internship } from './types.js';
import type { InternshipStore, ReleaseStore, UserStore } from './store.js';
import { employerDropGroupId, employerDropKey, RELEASE_MINIMUM_ROLES } from './catalog-groups.js';
import { matchesJobFilter } from './core/filters.js';
import { notificationSourceLabelFor } from './sources/source-label.js';
import { publicApplicationUrl } from './core/application-url.js';
import { canonicalPostingTiming, formatPostingDate } from './core/posting-time.js';

export const rankInternships = (jobs: Internship[]) => [...jobs].sort((a, b) => score(b.company, b.compensation) - score(a.company, a.compensation) || (canonicalPostingTiming(b).timestamp ?? '').localeCompare(canonicalPostingTiming(a).timestamp ?? '') || b.firstSeenAt.localeCompare(a.firstSeenAt));

export interface PushMessage {
  title: string;
  body: string;
  click?: string;
  tags?: string[];
  data?:
    | { destination: 'job'; jobId: string; url: string; matchedFilters: { reasons: FilterMatchReason[]; exclusionsApplied: boolean } }
    | { destination: 'release'; releaseId: string; url: string };
}
export interface PushPublisher { publish(message: PushMessage): Promise<void>; }

const PUSH_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_LEGACY_PUSH_JOBS_PER_RUN = 10;

export interface ExpoPushTicket { id?: string; status: 'ok' | 'error'; details?: { error?: string }; message?: string; }
export const MAX_EXPO_PUSH_ATTEMPTS = 3;
export class ExpoPushHttpError extends Error {
  constructor(readonly status: number) {
    super(`Expo Push Service rejected notification with HTTP ${status}`);
    this.name = 'ExpoPushHttpError';
  }
}

function retryableExpoHttpStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

export type ProviderFailureKind = 'retryable' | 'definitive-failure' | 'unknown';

export function classifyExpoPushFailure(error: unknown): ProviderFailureKind {
  if (!(error instanceof ExpoPushHttpError)) return 'unknown';
  return retryableExpoHttpStatus(error.status) ? 'retryable' : 'definitive-failure';
}

export function classifyAwsServiceFailure(error: unknown): ProviderFailureKind {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
  if (status === undefined) return 'unknown';
  return retryableExpoHttpStatus(status) ? 'retryable' : 'definitive-failure';
}
export type NotificationDeliveryEvent = {
  event: 'notification_sent' | 'notification_failed' | 'notification_skipped_duplicate' | 'push_receipt_confirmed' | 'push_receipt_failed';
  occurredAt: string;
  jobId: string;
  recipientKey: string;
  platform?: 'ios' | 'android';
  company?: string;
  title?: string;
  renderedTitle?: string;
  location?: string;
  season?: string;
  normalizedUrl?: string;
  sourceIds?: string[];
  reason?: string;
};
export type NotificationDeliveryLogger = (event: NotificationDeliveryEvent) => void;

const defaultDeliveryLogger: NotificationDeliveryLogger = (event) => console.log(JSON.stringify(event));
function recipientKey(userId: string, token: string) { return createHash('sha256').update(`${userId}\0${token}`).digest('hex').slice(0, 16); }
export function notificationDedupeKey(job: Pick<Internship, 'jobId' | 'normalizedUrl' | 'postingIdentity'>) {
  if (job.postingIdentity?.canonicalJobId) {
    return createHash('sha256').update(`posting-v1:${job.postingIdentity.canonicalJobId}`).digest('hex');
  }
  try { return postingIdentityKey(job.normalizedUrl); }
  catch { return createHash('sha256').update(`job:${job.jobId}`).digest('hex'); }
}
function emitDeliveryEvent(logger: NotificationDeliveryLogger, event: NotificationDeliveryEvent) { try { logger(event); } catch { /* Logging must never change delivery behavior. */ } }
function deliveryContext(job: Internship, userId: string, token: string, platform: 'ios' | 'android', renderedTitle: string) {
  return {
    jobId: job.jobId,
    recipientKey: recipientKey(userId, token),
    platform,
    company: job.company,
    title: job.title,
    renderedTitle,
    location: job.location,
    season: job.season,
    normalizedUrl: job.normalizedUrl,
    sourceIds: [...new Set(job.sourceReferences.map((source) => source.sourceId))].sort(),
  };
}
/** Minimal Expo Push Service client: Expo handles APNs/FCM credential delivery. */
export class ExpoPushPublisher {
  constructor(private readonly endpoint = 'https://exp.host/--/api/v2/push/send', private readonly fetcher: typeof fetch = platformFetch) {}
  async publish(token: string, message: PushMessage): Promise<ExpoPushTicket> {
    const response = await this.fetcher(this.endpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ to: token, sound: 'default', priority: 'high', title: message.title, body: message.body, data: message.data ?? { jobId: message.click }, channelId: 'job-alerts' }), signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new ExpoPushHttpError(response.status);
    const body = await response.json() as { data?: ExpoPushTicket | ExpoPushTicket[] };
    const ticket = Array.isArray(body.data) ? body.data[0] : body.data;
    if (!ticket) throw new Error('Expo Push Service returned no ticket');
    return ticket;
  }
  async receipts(ticketIds: string[]): Promise<Record<string, ExpoPushTicket>> {
    if (!ticketIds.length) return {};
    const response = await this.fetcher('https://exp.host/--/api/v2/push/getReceipts', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ticketIds }), signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Expo Push Service rejected receipt lookup with HTTP ${response.status}`);
    const body = await response.json() as { data?: Record<string, ExpoPushTicket> };
    return body.data ?? {};
  }
}

function nativePushMessage(job: Internship, filter: Parameters<typeof evaluateJobFilter>[1], templates?: PushTemplates): PushMessage {
  // Keep the legacy compact title/body defaults; only the transport changes from ntfy to Expo.
  const evaluation = evaluateJobFilter(job, filter);
  return {
    ...pushMessage(job, templates ?? defaultPushTemplates),
    click: job.jobId,
    data: {
      destination: 'job',
      jobId: job.jobId,
      url: `internnotifs://jobs/${encodeURIComponent(job.jobId)}`,
      matchedFilters: { reasons: evaluation.reasons, exclusionsApplied: evaluation.exclusionsApplied }
    }
  };
}

/** A drop's alert: the first one says what the employer posted, a later one says
 * how many roles joined a drop the user has already heard about. The body keeps
 * each role's own location (up to three, then a count) so the compact card still
 * carries the precise detail the per-role alerts used to. */
export function dropPushMessage(company: string, roles: Internship[], added: boolean): PushMessage {
  const count = roles.length;
  const aliases = defaultRoleAbbreviations;
  const shown = roles.slice(0, 3).map((job) => renderPushTemplate('{location} · {season}', job, aliases).replace(/[\r\n]+/g, ' ').trim());
  const focuses = [...new Set(roles.flatMap((job) => inferJobFocuses(job)))].slice(0, 3);
  const unconfirmed = roles.filter((job) => job.postingIdentityStatus === 'unconfirmed').length;
  const summary = [
    `${count} role${count === 1 ? '' : 's'}`,
    ...shown,
    ...(count > shown.length ? [`+${count - shown.length} more`] : []),
    focuses.length ? `Focus: ${focuses.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return {
    title: added ? `${count} role${count === 1 ? '' : 's'} added to ${company}` : `${company} posted ${count} matching roles`,
    body: [summary, unconfirmed ? `${unconfirmed} role${unconfirmed === 1 ? '' : 's'}: identity unconfirmed.` : ''].filter(Boolean).join('\n'),
    click: safeClick(publicApplicationUrl(roles[0]!.applyUrl)),
  };
}

/**
 * One alert per employer drop instead of one per role. The first alert says what
 * the employer posted; an alert for a drop the user already heard about says how
 * many roles were added to it, and the drop's roles stay collapsed behind one
 * card. Only roles matching the user's own filter are counted or delivered.
 *
 * Receipts remain per role: a role delivered once is never sent again, and a run
 * that only sees already-delivered roles sends nothing.
 */
export async function sendNewJobNotifications(
  jobs: Internship[],
  users: UserStore,
  publisher: ExpoPushPublisher,
  now: () => Date = () => new Date(),
  logger: NotificationDeliveryLogger = defaultDeliveryLogger,
  options: { excludeUserIds?: ReadonlySet<string>; excludeAllUsers?: boolean; releases?: ReleaseStore } = {},
): Promise<{ sent: number; skipped: number; failed: number }> {
  let sent = 0; let skipped = 0; let failed = 0;
  const devices = await users.activeDevices();
  const preferences = new Map<string, Awaited<ReturnType<UserStore['getPreferences']>>>();
  const delivered = (receipt: DeliveryReceipt | undefined) => receipt?.status === 'ok' || receipt?.status === 'pending' || receipt?.deliveryState === 'definitive-failure';
  // One drop per employer per day; the id matches the feed's card, so an alert
  // and the card it points at always describe the same set of roles. A role whose
  // timestamp cannot place it in a drop still alerts, on its own.
  const byDrop = new Map<string, { dropId: string; company: string; roles: Internship[] }>();
  for (const job of jobs) {
    const key = employerDropKey(job);
    const dropId = (key ? employerDropGroupId(job) : undefined) ?? `individual-${job.jobId}`;
    const drop = byDrop.get(key ?? dropId) ?? { dropId, company: job.company, roles: [] };
    drop.roles.push(job);
    byDrop.set(key ?? dropId, drop);
  }
  for (const { dropId, company, roles } of byDrop.values()) {
    // The feed renders a drop as one card only from RELEASE_MINIMUM_ROLES roles;
    // below that (with no card already open for the day) every role keeps its own
    // card, so it keeps its own alert and the two surfaces stay consistent.
    const opensCard = roles.length >= RELEASE_MINIMUM_ROLES;
    for (const device of devices) {
      if (options.excludeAllUsers || options.excludeUserIds?.has(device.userId)) { skipped += roles.length; continue; }
      let preference = preferences.get(device.userId);
      if (!preference) { preference = await users.getPreferences(device.userId); preferences.set(device.userId, preference); }
      if (!preference?.alertsEnabled || !preference.onboardingComplete) { skipped += roles.length; continue; }
      const matching = roles.filter((job) => matchesJobFilter(job, preference.filter));
      if (!matching.length) { skipped += roles.length; continue; }
      // Check the old job-ID key during the rolling migration so a previously
      // delivered role is not resent merely because its receipt key was hardened.
      const existing = await Promise.all(matching.map(async (job) => (
        await users.getReceipt(device.userId, notificationDedupeKey(job), device.token)
        ?? await users.getReceipt(device.userId, job.jobId, device.token)
      )));
      const previous = options.releases ? await options.releases.getRelease(device.userId, dropId) : undefined;
      const card = opensCard || Boolean(previous);
      for (const batch of card ? [matching] : matching.map((job) => [job])) {
        const fresh = batch.filter((job) => !delivered(existing[matching.indexOf(job)]));
        if (!fresh.length) { skipped += batch.length; continue; }
        const message = card
          ? dropPushMessage(company, batch, Boolean(previous))
          : nativePushMessage(batch[0]!, preference.filter, preference.push);
        const context = deliveryContext(fresh[0]!, device.userId, device.token, device.platform, message.title);
        const timestamp = now().toISOString();
        const claimed: Array<{ job: Internship; receipt: DeliveryReceipt }> = [];
        for (const job of fresh) {
          const prior = existing[matching.indexOf(job)];
          const receipt: DeliveryReceipt = { userId: device.userId, jobId: job.jobId, dedupeKey: notificationDedupeKey(job), token: device.token, status: 'pending', attempts: (prior?.attempts ?? 0) + 1, deliveryState: 'claimed', createdAt: prior?.createdAt ?? timestamp, updatedAt: timestamp };
          if (await users.claimReceipt(receipt)) claimed.push({ job, receipt });
        }
        if (!claimed.length) {
          emitDeliveryEvent(logger, { event: 'notification_skipped_duplicate', occurredAt: timestamp, ...context, reason: 'concurrent_delivery_claim' });
          skipped += fresh.length; continue;
        }
        const releases = options.releases;
        if (card && releases) {
          // The card the alert points at: one release row per user and drop, its
          // job set growing as the employer adds roles, so the app can open the
          // same roles the alert was about.
          const known = [...new Set([...(previous?.jobIds ?? []), ...matching.map((job) => job.jobId)])].sort();
          await releases.putRelease({
            releaseId: dropId, userId: device.userId,
            jobIds: known, newJobIds: claimed.map(({ job }) => job.jobId).sort(),
            createdAt: previous?.createdAt ?? timestamp,
          });
          message.data = { destination: 'release', releaseId: dropId, url: `internnotifs://releases/${encodeURIComponent(dropId)}` };
          message.click = message.data.url;
        }
        try {
          const ticket = await publisher.publish(device.token, message);
          // An ok response without a ticket is ambiguous: Expo may have accepted it,
          // so the permanent claim remains but automated delivery never retries it.
          const accepted = ticket.status === 'ok' && Boolean(ticket.id);
          const ambiguous = ticket.status === 'ok' && !ticket.id;
          await Promise.all(claimed.map(({ receipt }) => users.putReceipt({
            ...receipt, ticketId: ticket.id,
            status: accepted || ambiguous ? 'pending' : 'error',
            deliveryState: accepted ? 'accepted' : ambiguous ? 'unknown' : 'definitive-failure',
            updatedAt: now().toISOString(),
          })));
          if (accepted) { emitDeliveryEvent(logger, { event: 'notification_sent', occurredAt: now().toISOString(), ...context }); sent += claimed.length; }
          else {
            emitDeliveryEvent(logger, { event: 'notification_failed', occurredAt: now().toISOString(), ...context, reason: ambiguous ? 'ambiguous_provider_acceptance' : ticket.details?.error ?? ticket.message ?? 'expo_ticket_error' });
            failed += claimed.length; if (ticket.details?.error === 'DeviceNotRegistered') await users.putDevice({ ...device, active: false, updatedAt: now().toISOString() });
          }
        } catch (error) {
          const failure = classifyExpoPushFailure(error);
          const explicitHttpFailure = failure !== 'unknown';
          await Promise.all(claimed.map(({ receipt }) => {
            const retryable = failure === 'retryable' && (receipt.attempts ?? 1) < MAX_EXPO_PUSH_ATTEMPTS;
            return users.putReceipt({
              ...receipt,
              status: explicitHttpFailure ? retryable ? 'retryable' : 'error' : 'pending',
              deliveryState: explicitHttpFailure ? retryable ? 'claimed' : 'definitive-failure' : 'unknown',
              lastErrorCode: error instanceof ExpoPushHttpError ? `ExpoHttp${error.status}` : 'TransportAmbiguous',
              lastErrorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
              lastErrorAt: now().toISOString(),
              updatedAt: now().toISOString(),
            });
          }));
          emitDeliveryEvent(logger, { event: 'notification_failed', occurredAt: now().toISOString(), ...context, reason: error instanceof Error ? error.message.slice(0, 240) : 'unknown_transport_error' });
          failed += claimed.length;
        }
      }
    }
  }
  return { sent, skipped, failed };
}

/** Expo tickets are accepted asynchronously; this reconciliation deactivates invalid tokens. */
export async function inspectExpoPushReceipts(users: UserStore, publisher: ExpoPushPublisher, now: () => Date = () => new Date(), logger: NotificationDeliveryLogger = defaultDeliveryLogger): Promise<{ ok: number; invalid: number; retryable: number; pending: number }> {
  const receipts = await users.pendingReceipts(); const byId = await publisher.receipts(receipts.map((receipt) => receipt.ticketId).filter((id): id is string => Boolean(id))); let ok = 0; let invalid = 0; let pending = 0;
  const retryable = 0;
  for (const receipt of receipts) {
    const result = receipt.ticketId ? byId[receipt.ticketId] : undefined;
    if (!result) { pending += 1; continue; }
    if (result.status === 'ok') { await users.putReceipt({ ...receipt, status: 'ok', deliveryState: 'delivered', updatedAt: now().toISOString() }); emitDeliveryEvent(logger, { event: 'push_receipt_confirmed', occurredAt: now().toISOString(), jobId: receipt.jobId, recipientKey: recipientKey(receipt.userId, receipt.token) }); ok += 1; continue; }
    await users.putReceipt({ ...receipt, status: 'error', deliveryState: 'definitive-failure', updatedAt: now().toISOString() });
    emitDeliveryEvent(logger, { event: 'push_receipt_failed', occurredAt: now().toISOString(), jobId: receipt.jobId, recipientKey: recipientKey(receipt.userId, receipt.token), reason: result.details?.error ?? result.message ?? 'expo_receipt_error' });
    if (result.details?.error === 'DeviceNotRegistered') {
      const device = (await users.activeDevices()).find((candidate) => candidate.userId === receipt.userId && candidate.token === receipt.token);
      if (device) await users.putDevice({ ...device, active: false, updatedAt: now().toISOString() });
      invalid += 1;
    }
  }
  return { ok, invalid, retryable, pending };
}

export async function retryExpoPushNotifications(
  jobs: InternshipStore,
  users: UserStore,
  publisher: ExpoPushPublisher,
  now: () => Date = () => new Date(),
  options: { excludeUserIds?: ReadonlySet<string>; excludeAllUsers?: boolean } = {},
): Promise<{ sent: number; skipped: number; failed: number }> {
  let sent = 0; let skipped = 0; let failed = 0;
  const devices = new Map((await users.activeDevices()).map((device) => [`${device.userId}\u0000${device.token}`, device]));
  for (const receipt of await users.retryableReceipts()) {
    if (options.excludeAllUsers || options.excludeUserIds?.has(receipt.userId)) {
      await users.putReceipt({
        ...receipt,
        status: 'error',
        deliveryState: 'definitive-failure',
        lastErrorCode: 'GroupedPipelineCohort',
        lastErrorMessage: 'Legacy retry suppressed after grouped delivery activation',
        lastErrorAt: now().toISOString(),
        updatedAt: now().toISOString(),
      });
      skipped += 1;
      continue;
    }
    const attempts = receipt.attempts ?? 1;
    const job = await jobs.getJob(receipt.jobId);
    const preference = await users.getPreferences(receipt.userId);
    const device = devices.get(`${receipt.userId}\u0000${receipt.token}`);
    if (attempts >= MAX_EXPO_PUSH_ATTEMPTS || !job || !device
      || !preference?.alertsEnabled || !preference.onboardingComplete || !matchesJobFilter(job, preference.filter)) {
      await users.putReceipt({ ...receipt, status: 'error', updatedAt: now().toISOString() });
      skipped += 1;
      continue;
    }
    const attemptedAt = now().toISOString();
    try {
      const ticket = await publisher.publish(receipt.token, nativePushMessage(job, preference.filter, preference.push));
      const accepted = ticket.status === 'ok' && Boolean(ticket.id);
      const invalid = ticket.details?.error === 'DeviceNotRegistered';
      await users.putReceipt({
        ...receipt,
        ticketId: ticket.id,
        attempts: attempts + 1,
        status: accepted ? 'pending' : invalid || attempts + 1 >= MAX_EXPO_PUSH_ATTEMPTS ? 'error' : 'retryable',
        deliveryState: accepted ? 'accepted' : invalid || attempts + 1 >= MAX_EXPO_PUSH_ATTEMPTS ? 'definitive-failure' : 'claimed',
        ...(!accepted ? { lastErrorCode: ticket.details?.error ?? 'ExpoRejected', lastErrorMessage: ticket.message?.slice(0, 500), lastErrorAt: attemptedAt } : {}),
        updatedAt: attemptedAt,
      });
      if (accepted) sent += 1;
      else {
        if (invalid) await users.putDevice({ ...device, active: false, updatedAt: attemptedAt });
        failed += 1;
      }
    } catch (error) {
      const failure = classifyExpoPushFailure(error);
      const explicitHttpFailure = failure !== 'unknown';
      const retryable = failure === 'retryable' && attempts + 1 < MAX_EXPO_PUSH_ATTEMPTS;
      await users.putReceipt({
        ...receipt,
        attempts: attempts + 1,
        status: explicitHttpFailure ? retryable ? 'retryable' : 'error' : 'pending',
        deliveryState: explicitHttpFailure ? retryable ? 'claimed' : 'definitive-failure' : 'unknown',
        lastErrorCode: error instanceof ExpoPushHttpError ? `ExpoHttp${error.status}` : 'TransportAmbiguous',
        lastErrorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        lastErrorAt: attemptedAt,
        updatedAt: attemptedAt,
      });
      failed += 1;
    }
  }
  return { sent, skipped, failed };
}

/**
 * Reconciles the legacy notification marker with the durable Expo receipt
 * pipeline. New-role delivery is idempotent per device, so replaying a bounded
 * set closes migration gaps without duplicating already accepted pushes.
 */
export async function drainPendingExpoNotifications(
  jobs: InternshipStore,
  users: UserStore,
  publisher: ExpoPushPublisher,
  now: () => Date = () => new Date(),
  releases?: ReleaseStore,
): Promise<{
  processed: number;
  deferred: number;
  delivery: Awaited<ReturnType<typeof sendNewJobNotifications>>;
  receipts: Awaited<ReturnType<typeof inspectExpoPushReceipts>>;
  retries: Awaited<ReturnType<typeof retryExpoPushNotifications>>;
}> {
  const pending = rankInternships(await jobs.pendingSms()).slice(0, MAX_LEGACY_PUSH_JOBS_PER_RUN);
  const [devices, preferences] = await Promise.all([users.activeDevices(), users.activePreferences()]);
  const readyUserIds = new Set(preferences.map((preference) => preference.userId));
  const hasReadyDevice = devices.some((device) => readyUserIds.has(device.userId));
  const delivery = await sendNewJobNotifications(pending, users, publisher, now, undefined, releases ? { releases } : {});
  // A device can be registered slightly before onboarding saves its alert
  // preferences. Do not consume the global legacy marker until at least one
  // fully opted-in device has evaluated the batch; receipts own delivery and
  // retry state after that point.
  if (hasReadyDevice) {
    const sentAt = now().toISOString();
    for (const job of pending) await jobs.markSmsSent(job.jobId, sentAt);
  }
  const receipts = await inspectExpoPushReceipts(users, publisher, now);
  const retries = await retryExpoPushNotifications(jobs, users, publisher, now);
  return {
    processed: hasReadyDevice ? pending.length : 0,
    deferred: hasReadyDevice ? 0 : pending.length,
    delivery,
    receipts,
    retries,
  };
}

export class NtfyPublisher implements PushPublisher {
  constructor(private readonly topic: string, private readonly endpoint = 'https://ntfy.sh', private readonly fetcher: typeof fetch = platformFetch) {}
  async publish(message: PushMessage) {
    const response = await this.fetcher(this.endpoint.replace(/\/$/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: this.topic, title: message.title, message: message.body, priority: 4, ...(message.tags?.length ? { tags: message.tags } : {}), ...(message.click ? { click: message.click } : {}) }),
      signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`ntfy rejected notification with HTTP ${response.status}`);
  }
}

export interface PushTemplates { titleTemplate?: string; descriptionTemplate?: string; roleAbbreviations?: Record<string, string>; }
export const defaultRoleAbbreviations: Record<string, string> = {
  'software development engineer': 'SDE',
  'software engineering': 'SWE',
  'software engineer': 'SWE',
  'machine learning': 'ML',
  'artificial intelligence': 'AI',
  'data science': 'DS',
  'product management': 'PM',
  quantitative: 'Quant'
};
export const defaultPushTemplates: Required<PushTemplates> = {
  titleTemplate: '{shortTitle} — {company}',
  descriptionTemplate: '{location} · {season}{compensationDetail}\n{focus}{postedDetail}\nSource: {source}\n{url}',
  roleAbbreviations: defaultRoleAbbreviations
};

function displayValue(value: string | undefined) { return (value ?? '').replace(/[\r\n\t]+/g, ' ').trim(); }
function safeClick(url: string) { try { const parsed = new URL(url); return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined; } catch { return undefined; } }
export function notificationSourceLabel(job: Internship): string {
  return notificationSourceLabelFor(job.sourceReferences);
}
export function compactRoleTitle(title: string, roleAbbreviations: Record<string, string> = defaultRoleAbbreviations) {
  const original = displayValue(title);
  const candidates = Object.entries(roleAbbreviations).map(([source, replacement]) => ({ source, replacement: displayValue(replacement), at: original.toLowerCase().indexOf(source.toLowerCase()) })).filter((candidate) => candidate.at >= 0).sort((left, right) => left.at - right.at || right.source.length - left.source.length);
  if (candidates[0]?.replacement) return candidates[0].replacement;
  const result = original;
  return result.replace(/\b(internship|intern|co-op)\b/gi, '').replace(/[\s–—-]+$/g, '').replace(/\s{2,}/g, ' ').trim() || displayValue(title);
}
export function renderPushTemplate(template: string, job: Internship, roleAbbreviations: Record<string, string> = defaultRoleAbbreviations) {
  const compensation = displayValue(job.compensation.raw) || (job.compensation.maxHourlyUSD ? `$${job.compensation.maxHourlyUSD.toFixed(0)}/hr` : '');
  const timing = canonicalPostingTiming(job);
  const posted = timing.timestamp ? formatPostingDate(timing.timestamp) : '';
  const timingLabel = timing.kind === 'employer-posted'
    ? 'Employer posted'
    : timing.kind === 'source-reported'
      ? 'Source reported'
      : timing.kind === 'found'
        ? 'Found by InternNotifs'
        : '';
  const focus = inferJobFocuses(job).join(' · ');
  const values: Record<string, string> = {
    title: displayValue(job.title), shortTitle: compactRoleTitle(job.title, roleAbbreviations), company: displayValue(job.company), location: displayValue(job.location), season: displayValue(job.season), compensation, compensationDetail: compensation ? ` · ${compensation}` : '', focus: focus ? `Focus: ${focus}` : '', posted, postedDetail: posted ? `${focus ? ' · ' : ''}${timingLabel}: ${posted}` : '', source: notificationSourceLabel(job), url: safeClick(publicApplicationUrl(job.applyUrl)) ?? ''
  };
  return template.replace(/\{(title|shortTitle|company|location|season|compensation|compensationDetail|focus|posted|postedDetail|source|url)\}/g, (_, key: string) => values[key] ?? '').replace(/\n[ \t]*\n+/g, '\n').trim();
}
function renderPushDescription(template: string, job: Internship, roleAbbreviations: Record<string, string>) {
  const body = renderPushTemplate(template, job, roleAbbreviations);
  const sourced = template.includes('{source}') ? body : `${body}\nSource: ${notificationSourceLabel(job)}`.trim();
  return job.postingIdentityStatus === 'unconfirmed' ? `${sourced}\nIdentity unconfirmed` : sourced;
}
function pushMessage(job: Internship, templates: PushTemplates): PushMessage {
  const aliases = { ...defaultRoleAbbreviations, ...(templates.roleAbbreviations ?? {}) };
  const title = renderPushTemplate(templates.titleTemplate ?? defaultPushTemplates.titleTemplate, job, aliases).replace(/[\r\n]+/g, ' ').slice(0, 180);
  const tagsByFocus: Partial<Record<JobFocus, string>> = { 'AI/ML': 'brain', 'Cloud/Infra': 'cloud', Security: 'lock', Data: 'bar_chart', 'Backend/API': 'computer', 'Frontend/Mobile': 'computer', 'Systems/Hardware': 'gear', 'Quant/Fintech': 'chart_with_upwards_trend', Product: 'clipboard', Design: 'art', SWE: 'computer' };
  const tag = inferJobFocuses(job).map((focus) => tagsByFocus[focus]).find((candidate): candidate is string => Boolean(candidate));
  const tags = tag ? [tag] : [];
  return { title: title || 'New internship', body: renderPushDescription(templates.descriptionTemplate ?? defaultPushTemplates.descriptionTemplate, job, aliases), click: safeClick(publicApplicationUrl(job.applyUrl)), ...(tags.length ? { tags } : {}) };
}
export function summaryChunks(jobs: Internship[], limit = 1200): Internship[][] {
  const chunks: Internship[][] = []; let current: Internship[] = []; let length = 0;
  for (const job of jobs) { const itemLength = pushMessage(job, defaultPushTemplates).body.length + 2; if (current.length && length + itemLength > limit) { chunks.push(current); current = []; length = 0; } current.push(job); length += itemLength; }
  if (current.length) chunks.push(current); return chunks;
}

export async function sendPendingNotifications(store: InternshipStore, publisher: PushPublisher, templates: PushTemplates = defaultPushTemplates, now: () => Date = () => new Date()): Promise<{ sent: number; failed: number }> {
  // This fallback shares a Lambda with ingestion. Bound each pass so a stale
  // delivery destination cannot consume the entire invocation and trigger
  // overlapping Scheduler retries. Remaining jobs stay pending for later runs.
  const jobs = rankInternships(await store.pendingSms()).slice(0, MAX_LEGACY_PUSH_JOBS_PER_RUN); let sent = 0; let failed = 0;
  for (const job of jobs.slice(0, 5)) {
    try { await publisher.publish(pushMessage(job, templates)); await store.markSmsSent(job.jobId, now().toISOString()); sent += 1; }
    catch { failed += 1; }
  }
  for (const chunk of summaryChunks(jobs.slice(5))) {
    const aliases = { ...defaultRoleAbbreviations, ...(templates.roleAbbreviations ?? {}) };
    try { await publisher.publish({ title: `${chunk.length} new internships`, body: chunk.map((job) => `${renderPushTemplate(templates.titleTemplate ?? defaultPushTemplates.titleTemplate, job, aliases)}\n${renderPushDescription(templates.descriptionTemplate ?? defaultPushTemplates.descriptionTemplate, job, aliases)}`).join('\n\n') }); for (const job of chunk) await store.markSmsSent(job.jobId, now().toISOString()); sent += chunk.length; }
    catch { failed += chunk.length; }
  }
  return { sent, failed };
}

export interface EmailSender { send(subject: string, text: string, html: string): Promise<void>; }
export class SesEmailSender implements EmailSender {
  private readonly client = new SESv2Client({});
  constructor(private readonly from: string, private readonly to: string) {}
  async send(subject: string, text: string, html: string) {
    await this.client.send(new SendEmailCommand({ FromEmailAddress: this.from, Destination: { ToAddresses: [this.to] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text }, Html: { Data: html } } } } }));
  }
}

const escapeHtml = (input: string) => input.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char);
export async function sendDigest(store: InternshipStore, sender: EmailSender, now: () => Date = () => new Date()): Promise<number> {
  const jobs = rankInternships(await store.pendingDigest()); if (!jobs.length) return 0;
  const text = jobs.map((job) => `${job.company} — ${job.title} (${job.location})\n${publicApplicationUrl(job.applyUrl)}`).join('\n\n');
  const html = `<h1>Internship digest</h1><ul>${jobs.map((job) => `<li><strong>${escapeHtml(job.company)}</strong> — ${escapeHtml(job.title)} (${escapeHtml(job.location)})<br><a href="${escapeHtml(publicApplicationUrl(job.applyUrl))}">Apply</a></li>`).join('')}</ul>`;
  await sender.send(`Internship digest: ${jobs.length} new role${jobs.length === 1 ? '' : 's'}`, text, html);
  await store.markDigested(jobs.map((job) => job.jobId), now().toISOString());
  return jobs.length;
}
