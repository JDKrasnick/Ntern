import { createHash } from 'node:crypto';
import { decodeMetadataCursor, encodeMetadataCursor } from '../src/metadata-audit.js';
import { createApiHandler, type DocumentStorage } from '../src/api.js';
import { ashbyWorkMessages, isAshbySourceDue } from '../src/ashby-dispatch.js';
import { processAshbyQueue } from '../src/ashby-worker.js';
import { greenhouseWorkMessages, isGreenhouseSourceDue } from '../src/greenhouse-dispatch.js';
import { processGreenhouseQueue } from '../src/greenhouse-worker.js';
import { isLeverSourceDue, leverWorkMessages } from '../src/lever-dispatch.js';
import { processLeverQueue } from '../src/lever-worker.js';
import { drainPendingExpoNotifications, ExpoPushPublisher, type EmailSender } from '../src/notifications.js';
import { runRuntimeCommand } from '../src/runtime.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import { createSourceOperationsHandler } from '../src/greenhouse-operations-api.js';
import type { reviewedAshbySources } from '../src/sources/ashby-config.js';
import type { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';
import type { reviewedLeverSources } from '../src/sources/lever-config.js';
import { defaultSources } from '../src/sources/index.js';
import type { SourceCheckpoint, SourceHealth } from '../src/types.js';
import { authenticatedInstallation, authenticatedUser, cleanupExpiredAuth, consumeAuthRateLimit, createInstallation, deleteAuthUser, handleAuthRequest, type AuthEnvironment } from './auth.js';
import { runCatalogQualityBackfill } from '../src/catalog-quality-backfill.js';
import { runPostingIdentityRepair, type PostingIdentityRepairPlan } from '../src/posting-identity-repair.js';
import { cleanupExpiredUserData, D1InternshipStore, D1ReleaseStore, D1UserStore } from './d1-store.js';
import { queueHasBacklog } from './queue-backlog.js';
import { processShadowExtractionBatch, shadowExtractionSummary } from './shadow-extraction.js';
import { handleShadowPublication } from './shadow-publication.js';
import type { D1Database, MessageBatch, Queue, R2Bucket, ScheduledController } from './types.js';
import { disconnectGmail, gmailApi, gmailCallback, GmailStore, processGmailWork, recordGmailFailure, type GmailWorkMessage } from './gmail.js';
import { D1EmployerStore } from './employer-store.js';
import { D1CatalogAdmissionStore, ROLE_METADATA_REVALIDATION_MS } from './catalog-admission-store.js';
import { handleCatalogAdmissionOperations } from './catalog-admission-api.js';
import { handleEmployerApi } from './employer-api.js';
import { closeEmployerOccurrence, handleEmployerOperations, runEmployerMaintenance } from './employer-operations-api.js';
import { assertPublicHttpsUrl, verifyDnsChallenge, verifyWellKnownChallenge } from '../src/employer/index.js';
import type { EmployerVerificationChallenge } from '../src/employer-types.js';
import { reviewedProviderRegistry, reviewedStructuredRegistry } from './employer-registry.js';
import { StructuredCareerSourceConnector } from '../src/sources/structured/index.js';
import { failedSourceHealth, safeDiagnostic, successfulSourceHealth } from '../src/source-health.js';
import type { BrowserWorker } from '@cloudflare/puppeteer';
import { destinationVerificationMessage, enqueueDueDestinationVerifications, processDestinationVerificationBatch,
  sendAdmissionOperationalAlert } from './destination-verification.js';
import { cleanupDlqRecords, handleDlqOperations, recordQueueFailureBestEffort, resolveQueueFailures, type DlqDependencies, type DlqName, type PeekedMessage } from './dlq-operations.js';
import { resilientD1 } from './resilient-d1.js';
import type { CatalogAdmissionResolver } from '../src/destination-verification.js';
import { ROLE_METADATA_EXTRACTION_VERSION } from '../src/role-metadata.js';
import {
  catalogProviderDefinitions,
  catalogProviderIds,
  integrationRegistry,
  isCatalogProviderId,
  providerForCloudflareCron,
  providerForQueueName,
  type CatalogProviderId,
  type CloudflareCatalogQueueBinding,
} from '../src/integration-registry.js';

export interface Environment extends AuthEnvironment {
  DOCUMENTS: R2Bucket;
  SHADOW_EXTRACTION_ARTIFACTS: R2Bucket;
  GREENHOUSE_QUEUE: Queue;
  LEVER_QUEUE: Queue;
  ASHBY_QUEUE: Queue;
  GITHUB_QUEUE: Queue;
  GMAIL_QUEUE: Queue;
  DESTINATION_VERIFICATION_QUEUE: Queue;
  SHADOW_EXTRACTION_QUEUE: Queue;
  DESTINATION_BROWSER: BrowserWorker;
  GREENHOUSE_DLQ: Queue;
  LEVER_DLQ: Queue;
  ASHBY_DLQ: Queue;
  GITHUB_DLQ: Queue;
  GMAIL_DLQ: Queue;
  DESTINATION_VERIFICATION_DLQ: Queue;
  SHADOW_EXTRACTION_DLQ: Queue;
  PUBLIC_API_URL: string;
  RESEND_API_KEY?: string;
  ADMISSION_SUPPORT_RECIPIENT?: string;
  AUTH_FROM_EMAIL?: string;
  DIGEST_TO_EMAIL?: string;
  NTFY_TOPIC?: string;
  NTFY_ENDPOINT?: string;
  OPERATIONS_SHARED_SECRET: string;
  EMPLOYER_PORTAL_ENABLED?: string;
  IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED?: string;
  TRUSTED_COMMUNITY_CATALOG_ENABLED?: string;
  IDENTITY_CONFIRMED_COVERAGE_FLOOR?: string;
  BILLING_WEBHOOK_SECRET?: string;
  CLOUDFLARE_SHUTDOWN_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  WORKER_NAME: string;
  GREENHOUSE_QUEUE_ID: string;
  LEVER_QUEUE_ID: string;
  ASHBY_QUEUE_ID: string;
  GITHUB_QUEUE_ID: string;
  GMAIL_QUEUE_ID: string;
  DESTINATION_VERIFICATION_QUEUE_ID: string;
  SHADOW_EXTRACTION_QUEUE_ID?: string;
  SHADOW_EXTRACTION_QUEUE_NAME?: string;
  ADMISSION_QUEUE_AGE_ALERT_HOURS?: string;
  ADMISSION_STALE_ALERT_THRESHOLD?: string;
  GMAIL_ENABLED?: string;
  SHADOW_EXTRACTION_ENABLED?: string;
  SHADOW_EXTRACTION_MONTHLY_FORECAST_CENTS?: string;
  SHADOW_EXTRACTION_MONTHLY_HEADROOM_CENTS?: string;
  /** Default-disabled, exact-cohort policy for reviewer-receipted shadow data. */
  LLM_METADATA_PUBLICATION_POLICY_JSON?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
  GMAIL_MESSAGE_HMAC_KEY?: string;
  GMAIL_REDIRECT_URI?: string;
}

function catalogAdmissionResolver(env: Environment): CatalogAdmissionResolver {
  const operations = new D1CatalogAdmissionStore(env.DB);
  const employers = new Map<string, ReturnType<typeof operations.resolveCanonicalEmployer>>();
  const rules = new Map<string, ReturnType<typeof operations.resolveReviewRule>>();
  let version: ReturnType<typeof operations.configurationVersion> | undefined;
  return {
    resolveCanonicalEmployer(identity) {
      const key = `${identity.provider}\0${identity.sourceId}\0${identity.tenant ?? ''}\0${identity.employerScope ?? ''}`;
      const pending = employers.get(key) ?? operations.resolveCanonicalEmployer(identity);
      employers.set(key, pending);
      return pending;
    },
    resolveDestinationRule(identity, candidateUrl) {
      let host: string;
      try { host = new URL(candidateUrl).hostname.toLowerCase(); } catch { host = candidateUrl; }
      const key = `${identity.provider}\0${identity.tenant ?? ''}\0${host}`;
      const pending = rules.get(key) ?? operations.resolveReviewRule(identity, candidateUrl);
      rules.set(key, pending);
      return pending;
    },
    configurationVersion() {
      version ??= operations.configurationVersion();
      return version;
    },
  };
}

async function dnsJson(name: string, type: 'A' | 'AAAA' | 'TXT'): Promise<Array<{ data?: string }>> {
  const endpoint = new URL('https://cloudflare-dns.com/dns-query');
  endpoint.searchParams.set('name', name); endpoint.searchParams.set('type', type);
  const response = await fetch(endpoint, { headers: { Accept: 'application/dns-json' } });
  if (!response.ok) throw new Error('DNS verification is temporarily unavailable');
  const value = await response.json() as { Answer?: Array<{ data?: string }> };
  return value.Answer ?? [];
}

const publicHostResolver = {
  async resolve(hostname: string): Promise<string[]> {
    const [ipv4, ipv6] = await Promise.all([dnsJson(hostname, 'A'), dnsJson(hostname, 'AAAA')]);
    return [...ipv4, ...ipv6].map((answer) => answer.data).filter((value): value is string => Boolean(value));
  },
};

async function verifyPublishedChallenge(challenge: EmployerVerificationChallenge, domain: string, token: string): Promise<boolean> {
  if (challenge.method === 'dns-txt') {
    const result = await verifyDnsChallenge({
      domain, token,
      resolver: { async resolveTxt(hostname) { return (await dnsJson(hostname, 'TXT')).map((answer) => (answer.data ?? '').replace(/^"|"$/gu, '').replace(/"\s+"/gu, '')); } },
    });
    return result.verified;
  }
  if (challenge.method === 'well-known') return (await verifyWellKnownChallenge({ domain, token, resolver: publicHostResolver })).verified;
  return false;
}

async function validateReviewedHost(host: string): Promise<void> {
  const normalized = host.trim().toLowerCase().replace(/\.$/u, '');
  if (!normalized || normalized.includes('/') || normalized.includes('@') || normalized.includes(':')) throw new Error('Reviewed application hosts must be exact hostnames');
  const url = await assertPublicHttpsUrl(`https://${normalized}/`, publicHostResolver);
  if (url.hostname.toLowerCase() !== normalized) throw new Error('Reviewed application host is invalid');
}

type ReviewedStructuredSource = Awaited<ReturnType<typeof reviewedStructuredRegistry>>[number];

export function structuredSourceRunBlocked(health: SourceHealth | undefined, force = false): boolean {
  if (force) return false;
  return health?.sourceStatus === 'paused' || health?.state === 'quarantined'
    || Boolean(health?.backoffUntil && Date.parse(health.backoffUntil) > Date.now());
}

export function githubSourceRunBlocked(health: SourceHealth | undefined, force: unknown): boolean {
  return force !== true && (health?.sourceStatus === 'paused' || health?.state === 'quarantined'
    || Boolean(health?.backoffUntil && Date.parse(health.backoffUntil) > Date.now()));
}

export function recoveredStructuredSourceHealth(health: SourceHealth): SourceHealth {
  const clean = { ...health };
  delete clean.backoffUntil;
  delete clean.quarantineReason;
  delete clean.quarantinedAt;
  return { ...clean, state: 'healthy', sourceStatus: 'paused', consecutiveFailures: 0, incidentState: 'resolved' };
}

export function failedStructuredRecoveryHealth(previous: SourceHealth | undefined, failed: SourceHealth): SourceHealth {
  if (!previous || (previous.state !== 'quarantined' && previous.sourceStatus !== 'paused')) return failed;
  return {
    ...failed,
    ...(previous.state === 'quarantined' ? {
      state: 'quarantined' as const,
      quarantinedAt: previous.quarantinedAt ?? failed.lastAttemptAt,
      quarantineReason: previous.quarantineReason ?? failed.lastSafeDiagnostic ?? 'Recovery validation failed',
    } : {}),
    sourceStatus: 'paused',
  };
}

async function runStructuredSource(source: ReviewedStructuredSource, env: Environment, options: { forceRecovery?: boolean } = {}): Promise<boolean> {
  const store = new D1InternshipStore(env.DB); const userStore = new D1UserStore(env.DB);
  const priorHealth = await store.getSourceHealth(source.id);
  const recoveryProbe = options.forceRecovery === true && structuredSourceRunBlocked(priorHealth);
  if (recoveryProbe) {
    const startedAt = new Date().toISOString();
    const connector = new StructuredCareerSourceConnector({ source: { ...source, id: `recovery-${source.id}` }, resolver: publicHostResolver });
    try {
      const snapshot = await connector.fetch();
      const completedAt = new Date().toISOString();
      const success = successfulSourceHealth({ sourceId: source.id, employerId: source.employer.id,
        provider: 'unknown', previous: priorHealth, startedAt, completedAt, contentHash: snapshot.contentHash,
        rawRows: snapshot.rawCount, validRows: snapshot.postings.length, eligibleRows: snapshot.listings.length,
        outcome: snapshot.outcome === 'changed' ? 'success_changed' : 'success_unchanged_hash' });
      await store.putSourceHealth(recoveredStructuredSourceHealth(success));
    } catch (error) {
      const failed = failedSourceHealth({ sourceId: source.id, employerId: source.employer.id,
        provider: 'unknown', previous: priorHealth, startedAt, completedAt: new Date().toISOString(), error });
      await store.putSourceHealth(failedStructuredRecoveryHealth(priorHealth, failed));
      throw error;
    }
    return true;
  }
  if (structuredSourceRunBlocked(priorHealth)) return false;
  if (source.status === 'shadow') {
    const startedAt = new Date().toISOString();
    const connector = new StructuredCareerSourceConnector({ source: { ...source, id: `shadow-${source.id}` }, resolver: publicHostResolver });
    try {
      const snapshot = await connector.fetch(await store.getCheckpoint(connector.id));
      await store.putCheckpoint(snapshot.checkpoint);
      const completedAt = new Date().toISOString();
      const success = successfulSourceHealth({ sourceId: source.id, employerId: source.employer.id,
        provider: 'unknown', previous: priorHealth, startedAt, completedAt, contentHash: snapshot.contentHash,
        rawRows: snapshot.rawCount, validRows: snapshot.postings.length, eligibleRows: snapshot.listings.length,
        outcome: snapshot.outcome === 'changed' ? 'success_changed' : 'success_unchanged_hash' });
      await store.putSourceHealth(success);
    } catch (error) {
      await store.putSourceHealth(failedSourceHealth({ sourceId: source.id, employerId: source.employer.id,
        provider: 'unknown', previous: priorHealth, startedAt, completedAt: new Date().toISOString(), error }));
      throw error;
    }
    return true;
  }
  const connector = new StructuredCareerSourceConnector({ source, resolver: publicHostResolver });
  const result = await runRuntimeCommand('poll', { store, userStore, sources: [connector], validateCatalogOnPoll: false,
    enqueueDestinationVerification: (request) => env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage(request)),
    catalogAdmissionResolver: catalogAdmissionResolver(env),
    identityUnconfirmedPublicationEnabled: env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
    trustedCommunityCatalogEnabled: env.TRUSTED_COMMUNITY_CATALOG_ENABLED === 'true',
    allowCompleteEmptySnapshot: true,
    config: { sesFrom: env.AUTH_FROM_EMAIL ?? '', sesTo: env.DIGEST_TO_EMAIL ?? '', ntfyTopic: env.NTFY_TOPIC, ntfyEndpoint: env.NTFY_ENDPOINT } });
  if ('poll' in result && result.poll?.failures.length) throw new Error(result.poll.failures.join('; '));
  return true;
}

async function verifiedAccountEmail(env: Environment, userId: string): Promise<string | undefined> {
  const row = await env.DB.prepare('SELECT email, verified_at FROM auth_users WHERE user_id = ?').bind(userId).first<{ email: string; verified_at: string | null }>();
  return row?.verified_at ? row.email : undefined;
}

async function accountEmail(env: Environment, userId: string): Promise<string | undefined> {
  return (await env.DB.prepare('SELECT email FROM auth_users WHERE user_id = ?').bind(userId).first<{ email: string }>())?.email;
}

async function removeEmployerAccessForDeletedAccount(env: Environment, userId: string, email?: string): Promise<void> {
  const store = new D1EmployerStore(env.DB); const jobs = new D1InternshipStore(env.DB);
  const timestamp = new Date().toISOString();
  for (const { organization, membership } of await store.listOrganizationsForUser(userId)) {
    if (membership.role !== 'owner') continue;
    const hasAnotherOwner = (await store.listMemberProfiles(organization.id)).some((member) => member.userId !== userId && member.role === 'owner');
    if (hasAnotherOwner) continue;
    const retainUntil = new Date(Date.parse(timestamp) + 365 * 86_400_000).toISOString();
    const event = (action: string, subjectType: string, subjectId?: string, details?: Record<string, unknown>) => ({
      id: crypto.randomUUID(), organizationId: organization.id, action, actorType: 'system' as const,
      subjectType, subjectId, details, createdAt: timestamp,
    });
    await store.putOrganization({ ...organization, state: 'closed', closedAt: timestamp, retainUntil, updatedAt: timestamp },
      event('organization.closed_for_owner_deletion', 'organization', organization.id, { retainUntil }));
    const verification = await store.getVerification(organization.id);
    if (verification) await store.putVerification({ ...verification, state: 'revoked', reason: 'The organization no longer has an owner', updatedAt: timestamp },
      event('verification.revoked_for_owner_deletion', 'organization', organization.id));
    const privilege = await store.getPublishingPrivilege(organization.id);
    await store.putPublishingPrivilege({ organizationId: organization.id, automaticPublishingEnabled: false,
      enabledAt: privilege?.enabledAt, enabledBy: privilege?.enabledBy, suspendedAt: timestamp,
      suspensionReason: 'The organization no longer has an owner', updatedAt: timestamp },
    event('automatic-publishing.suspended_for_owner_deletion', 'organization', organization.id));
    for (const submission of await store.listSubmissions(organization.id, 'published')) {
      await store.putSubmission({ ...submission, state: 'quarantined', reason: 'The organization no longer has an owner', updatedAt: timestamp },
        event('submission.quarantined_for_owner_deletion', 'submission', submission.id));
      await closeEmployerOccurrence(jobs, organization.id, submission.id, submission.applicationUrl);
    }
  }
  await store.removeUserAccess(userId, email);
}

type OperationsQueueEnvironment = Partial<Record<CloudflareCatalogQueueBinding, Queue>>;

const maxDocumentBytes = 5 * 1024 * 1024;

export function cloudflareOperationsQueueClient(env: OperationsQueueEnvironment) {
  const queues = new Map<string, Queue>();
  for (const provider of catalogProviderDefinitions) {
    const work = env[provider.runtime.cloudflareWorkBinding];
    const deadLetter = env[provider.runtime.cloudflareDeadLetterBinding];
    if (work) queues.set(provider.queues.work, work);
    if (deadLetter) queues.set(provider.queues.deadLetter, deadLetter);
  }
  return {
    async send(command: { input?: { QueueUrl?: string; MessageBody?: string } }) {
      const input = command.input;
      const queue = input?.QueueUrl ? queues.get(input.QueueUrl) : undefined;
      if (!queue) throw new Error(`Cloudflare queue ${JSON.stringify(input?.QueueUrl)} is not configured`);
      if (input?.MessageBody) {
        await queue.send(JSON.parse(input.MessageBody));
        return {};
      }
      if (!queue.metrics) throw new Error(`Cloudflare queue metrics are unavailable for ${input?.QueueUrl}`);
      const metrics = await queue.metrics();
      return {
        Attributes: {
          // Cloudflare exposes one real-time backlog total rather than SQS's
          // visible/in-flight split. The operations response marks processing
          // telemetry unavailable instead of fabricating that split.
          ApproximateNumberOfMessages: String(metrics.backlogCount),
        },
      };
    },
  };
}

export function cloudflareOperationsFleets(env: OperationsQueueEnvironment) {
  return Object.fromEntries(catalogProviderDefinitions.map((provider) => [provider.id, {
    ...(env[provider.runtime.cloudflareWorkBinding] ? { queueUrl: provider.queues.work } : {}),
    ...(env[provider.runtime.cloudflareDeadLetterBinding] ? { deadLetterQueueUrl: provider.queues.deadLetter } : {}),
  }]));
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key,X-Operations-Key,X-Operations-Actor',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function validBackfillProvider(value: string): boolean {
  return value === 'all' || value === 'structured' || isCatalogProviderId(value);
}

function eventResponse(result: { body: string; statusCode: number; headers?: Record<string, string> }): Response {
  const body = [101, 204, 205, 304].includes(result.statusCode) ? null : result.body;
  return withCors(new Response(body, { status: result.statusCode, headers: result.headers }));
}

function operationsAuthorized(request: Request, env: Environment): boolean {
  return Boolean(env.OPERATIONS_SHARED_SECRET)
    && request.headers.get('X-Operations-Key') === env.OPERATIONS_SHARED_SECRET;
}

function apiEvent(request: Request, userId: string | undefined, body: string | null) {
  const url = new URL(request.url);
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());
  return {
    requestContext: {
      http: { method: request.method },
      ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}),
    },
    rawPath: url.pathname,
    queryStringParameters,
    headers: Object.fromEntries(request.headers.entries()),
    body,
  };
}

async function isShutdown(env: Environment): Promise<boolean> {
  const state = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'billing_shutdown'").first<{ value: string }>();
  return state?.value === 'stopped';
}

async function cloudflareApi(env: Environment, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!env.CLOUDFLARE_SHUTDOWN_TOKEN) throw new Error('Cloudflare shutdown token is not configured');
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_SHUTDOWN_TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const result = await response.json() as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
  if (!response.ok || result.success === false) throw new Error(result.errors?.[0]?.message ?? `Cloudflare API returned HTTP ${response.status}`);
  return result.result;
}

export function dlqDependencies(env: Environment): DlqDependencies {
  const workQueues: Record<DlqName, Queue> = {
    greenhouse: env.GREENHOUSE_QUEUE,
    lever: env.LEVER_QUEUE,
    ashby: env.ASHBY_QUEUE,
    github: env.GITHUB_QUEUE,
    gmail: env.GMAIL_QUEUE,
    'destination-verification': env.DESTINATION_VERIFICATION_QUEUE,
  };
  return {
    db: env.DB,
    workQueues,
    sourceHealth: (sourceId) => new D1InternshipStore(env.DB).getSourceHealth(sourceId),
    api: {
      async resolveQueueId(exactName) {
        const result = await cloudflareApi(env, '/queues?per_page=100') as Array<{
          queue_id?: string; queue_name?: string; id?: string; name?: string;
        }>;
        const matches = result.filter((queue) => (queue.queue_name ?? queue.name) === exactName);
        const id = matches.length === 1 ? matches[0]!.queue_id ?? matches[0]!.id : undefined;
        if (!id) throw new Error(`Exact queue ${exactName} could not be resolved`);
        return id;
      },
      async peek(queueId, limit) {
        const result = await cloudflareApi(env, `/queues/${encodeURIComponent(queueId)}/messages/peek`, {
          method: 'POST', body: JSON.stringify({ batch_size: limit }),
        }) as { messages?: Array<{ id?: string; attempts?: number; body?: unknown; ref?: string; timestamp_ms?: number }> };
        return (result.messages ?? []).flatMap((message): PeekedMessage[] => message.id && message.ref ? [{
          id: message.id, attempts: message.attempts ?? 0, body: message.body, ref: message.ref,
          ...(message.timestamp_ms ? { timestampMs: message.timestamp_ms } : {}),
        }] : []);
      },
      async purge(queueId, refs) {
        const result = await cloudflareApi(env, `/queues/${encodeURIComponent(queueId)}/messages/purge`, {
          method: 'POST', body: JSON.stringify({ refs: refs.map((ref) => ({ ref })) }),
        }) as { errors?: Array<{ message?: string }>; warnings?: Record<string, string> };
        return { failedRefs: result.errors?.length ? refs : Object.keys(result.warnings ?? {}) };
      },
    },
  };
}

export function billingShutdownQueueIds(env: Environment): string[] {
  return [
    ...catalogProviderDefinitions.map((provider) => env[provider.runtime.cloudflareQueueIdBinding]),
    env.GMAIL_QUEUE_ID,
    env.DESTINATION_VERIFICATION_QUEUE_ID,
    ...(env.SHADOW_EXTRACTION_QUEUE_ID ? [env.SHADOW_EXTRACTION_QUEUE_ID] : []),
  ];
}

async function resolvedBillingShutdownQueueIds(env: Environment): Promise<string[]> {
  const configured = billingShutdownQueueIds(env);
  if (env.SHADOW_EXTRACTION_QUEUE_ID) return configured;
  if (!env.SHADOW_EXTRACTION_QUEUE_NAME) throw new Error('Shadow extraction queue identity is not configured');
  const queues = await cloudflareApi(env, '/queues?per_page=100') as Array<{
    queue_id?: string; queue_name?: string; id?: string; name?: string;
  }>;
  const matches = queues.filter((queue) => (queue.queue_name ?? queue.name) === env.SHADOW_EXTRACTION_QUEUE_NAME);
  const queueId = matches.length === 1 ? matches[0]!.queue_id ?? matches[0]!.id : undefined;
  if (!queueId) throw new Error(`Exact queue ${env.SHADOW_EXTRACTION_QUEUE_NAME} could not be resolved`);
  return [...configured, queueId];
}

async function billingShutdown(request: Request, env: Environment): Promise<Response> {
  if (request.method !== 'POST' || !env.BILLING_WEBHOOK_SECRET || request.headers.get('cf-webhook-auth') !== env.BILLING_WEBHOOK_SECRET) {
    return Response.json({ message: 'Not found' }, { status: 404 });
  }

  const queueIds = await resolvedBillingShutdownQueueIds(env);
  const scriptPath = `/workers/scripts/${encodeURIComponent(env.WORKER_NAME)}`;
  if (new URL(request.url).searchParams.get('dry-run') === 'true') {
    await Promise.all([
      ...queueIds.map((queueId) => cloudflareApi(env, `/queues/${queueId}/consumers`)),
      cloudflareApi(env, `${scriptPath}/schedules`),
      cloudflareApi(env, `${scriptPath}/subdomain`),
    ]);
    return Response.json({ ready: true });
  }

  const payload = await request.json().catch(() => null) as { account_id?: string; alert_type?: string; policy_name?: string } | null;
  if (payload?.account_id !== env.CLOUDFLARE_ACCOUNT_ID
    || payload.alert_type !== 'billing_budget_alert'
    || payload.policy_name !== 'InternNotifs budget warning: $5') {
    return Response.json({ ignored: true });
  }

  await env.DB.prepare(`
    INSERT INTO system_state (key, value, updated_at) VALUES ('billing_shutdown', 'stopped', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(new Date().toISOString()).run();

  for (const queueId of queueIds) {
    const consumers = await cloudflareApi(env, `/queues/${queueId}/consumers`) as Array<{ consumer_id?: string }>;
    for (const consumer of consumers) {
      if (consumer.consumer_id) await cloudflareApi(env, `/queues/${queueId}/consumers/${consumer.consumer_id}`, { method: 'DELETE' });
    }
  }
  await cloudflareApi(env, `${scriptPath}/schedules`, { method: 'PUT', body: '[]' });
  await cloudflareApi(env, `${scriptPath}/subdomain`, { method: 'DELETE' });
  return Response.json({ stopped: true });
}

class ResendEmailSender implements EmailSender {
  constructor(private readonly from: string, private readonly to: string, private readonly apiKey: string) {}
  async send(subject: string, text: string, html: string): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [this.to], subject, text, html }),
    });
    if (!response.ok) throw new Error(`Email provider rejected the digest with HTTP ${response.status}`);
  }
}

function documentStorage(env: Environment): DocumentStorage {
  const base = env.PUBLIC_API_URL.replace(/\/$/u, '');
  return {
    async createUploadUrl(document) { return `${base}/me/documents/${encodeURIComponent(document.documentId)}/content`; },
    async createDownloadUrl(document) { return `${base}/me/documents/${encodeURIComponent(document.documentId)}/content`; },
    async deleteObject(objectKey) { await env.DOCUMENTS.delete(objectKey); },
  };
}

export async function readDocumentUpload(request: Request): Promise<
  { tooLarge: true } | { tooLarge: false; content: ArrayBuffer }
> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxDocumentBytes) {
    await request.body?.cancel();
    return { tooLarge: true };
  }
  if (!request.body) return { tooLarge: false, content: new ArrayBuffer(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maxDocumentBytes) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(result.value);
  }

  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, content: content.buffer };
}

export async function documentContent(request: Request, env: Environment, userId: string, documentId: string): Promise<Response> {
  const users = new D1UserStore(env.DB);
  const document = (await users.listDocuments(userId)).find((item) => item.documentId === documentId);
  if (!document) return Response.json({ message: 'Document not found' }, { status: 404 });
  if (request.method === 'PUT') {
    const leaseId = crypto.randomUUID();
    if (!await users.beginDocumentUpload(userId, documentId, leaseId)) {
      const deletionPending = await users.isUserDeletionPending(userId);
      await request.body?.cancel();
      return Response.json(deletionPending
        ? { code: 'ACCOUNT_DELETION_IN_PROGRESS', message: 'Account deletion is in progress. This document was not uploaded.' }
        : { code: 'DOCUMENT_UPLOAD_IN_PROGRESS', message: 'A document upload is already in progress. Try again when it finishes.' }, { status: 409 });
    }
    try {
      const upload = await readDocumentUpload(request);
      if (upload.tooLarge) return Response.json({ message: 'Documents must be 5 MiB or smaller' }, { status: 413 });
      const period = new Date().toISOString().slice(0, 7);
      if (!await users.claimDocumentUpload(period)) return Response.json({ message: 'Monthly document upload quota reached' }, { status: 429 });
      await env.DOCUMENTS.put(document.objectKey, upload.content, { httpMetadata: { contentType: document.contentType } });
      if (await users.isUserDeletionPending(userId)) {
        await env.DOCUMENTS.delete(document.objectKey);
        return Response.json({ code: 'ACCOUNT_DELETION_IN_PROGRESS', message: 'Account deletion started before this upload completed. The uploaded document was removed.' }, { status: 409 });
      }
      return new Response(null, { status: 204 });
    } finally {
      await users.finishDocumentUpload(userId, documentId, leaseId);
    }
  }
  const object = await env.DOCUMENTS.get(document.objectKey);
  if (!object) return Response.json({ message: 'Document content not found' }, { status: 404 });
  const headers = new Headers({ 'Content-Type': object.httpMetadata?.contentType ?? document.contentType, 'Cache-Control': 'private, no-store' });
  if (object.size !== undefined) headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

async function fetchHandler(request: Request, env: Environment): Promise<Response> {
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
  const url = new URL(request.url);
  if (url.pathname === '/internal/billing-shutdown') return billingShutdown(request, env);
  if (await isShutdown(env)) return withCors(Response.json({ message: 'Service paused by billing guard' }, { status: 503 }));
  if (request.method === 'GET' && url.pathname === '/oauth/gmail/callback') return withCors(await gmailCallback(request, env));
  if (request.method === 'POST' && url.pathname === '/internal/refresh-catalog') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    return withCors(Response.json(await refreshCatalogProjection(new D1InternshipStore(env.DB))));
  }
  if (request.method === 'POST' && url.pathname === '/internal/recover-notifications') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const body = await request.json().catch(() => null) as { since?: unknown; limit?: unknown; apply?: unknown; expectedCandidateJobIds?: unknown } | null;
    const since = typeof body?.since === 'string' ? body.since : '';
    const limit = body?.limit === undefined ? 100 : body.limit;
    const apply = body?.apply === true;
    if (!since || Number.isNaN(Date.parse(since)) || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return withCors(Response.json({ message: 'since must be an ISO timestamp and limit must be an integer from 1 to 100' }, { status: 400 }));
    }
    const expectedCandidateJobIds = body?.expectedCandidateJobIds;
    if (apply && (!Array.isArray(expectedCandidateJobIds)
      || expectedCandidateJobIds.length > 100
      || expectedCandidateJobIds.some((jobId) => typeof jobId !== 'string' || !jobId || jobId.length > 512)
      || new Set(expectedCandidateJobIds).size !== expectedCandidateJobIds.length)) {
      return withCors(Response.json({ message: 'expectedCandidateJobIds must be the exact unique job-ID array from preview when apply is true' }, { status: 400 }));
    }
    try {
      const result = await new D1InternshipStore(env.DB).recoverUndeliveredNotifications({
        since: new Date(since).toISOString(), limit, apply,
        ...(Array.isArray(expectedCandidateJobIds) ? { expectedCandidateJobIds: expectedCandidateJobIds as string[] } : {}),
      });
      return withCors(Response.json({ ...result, applied: apply }));
    } catch (error) {
      return withCors(Response.json({ message: error instanceof Error ? error.message : 'Notification recovery failed' }, { status: 409 }));
    }
  }
  if (url.pathname === '/internal/role-metadata/audit' && request.method === 'GET') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    return withCors(Response.json(await new D1CatalogAdmissionStore(env.DB).roleMetadataAudit(), { headers: { 'Cache-Control': 'no-store' } }));
  }
  if (url.pathname === '/internal/role-metadata/review' && request.method === 'POST') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const input = await request.json().catch(() => ({})) as { action?: string; jobId?: string; reviewToken?: string; expectedDecisions?: number };
    const operations = new D1CatalogAdmissionStore(env.DB);
    try {
      if (input.action === 'preview-omission') {
        if (typeof input.jobId !== 'string' || !input.jobId || input.jobId.length > 512) throw new Error('jobId is invalid');
        return withCors(Response.json(await operations.stageRoleMetadataOmission(input.jobId, new Date().toISOString()), { headers: { 'Cache-Control': 'no-store' } }));
      }
      if (input.action === 'approve-omission') {
        if (typeof input.reviewToken !== 'string' || !/^[a-f0-9]{64}$/u.test(input.reviewToken) || input.expectedDecisions !== 1) {
          throw new Error('reviewToken and expectedDecisions must exactly match the review preview');
        }
        return withCors(Response.json(await operations.approveRoleMetadataOmission(input.reviewToken, input.expectedDecisions, new Date().toISOString())));
      }
      throw new Error('action must be preview-omission or approve-omission');
    } catch (error) {
      return withCors(Response.json({ message: error instanceof Error ? error.message : 'Metadata review failed' }, { status: 409 }));
    }
  }
  if (url.pathname === '/internal/role-metadata/backfill' && request.method === 'POST') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const input = await request.json().catch(() => ({})) as {
      action?: 'collect' | 'dry-run' | 'apply'; limit?: number; collectionToken?: string; cursor?: string;
      repairToken?: string; expectedJobs?: number; expectedOccurrences?: number;
    };
    const operations = new D1CatalogAdmissionStore(env.DB);
    try {
      if (input.action === 'collect') {
        const limit = input.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be an integer from 1 to 500');
        const collectionToken = input.collectionToken?.trim() || crypto.randomUUID();
        const candidates = await operations.metadataVerificationCandidates(limit, {
          observedBefore: new Date(Date.now() - ROLE_METADATA_REVALIDATION_MS).toISOString(),
          after: decodeMetadataCursor(input.cursor),
          reserveAt: new Date().toISOString(),
        });
        await sendQueueMessages(env.DESTINATION_VERIFICATION_QUEUE, candidates.map((candidate) => destinationVerificationMessage({
          ...candidate,
          reason: 'historical-backfill',
          metadataExtractionVersion: ROLE_METADATA_EXTRACTION_VERSION,
          metadataBackfillToken: collectionToken,
        })));
        const last = candidates.at(-1);
        return withCors(Response.json({ collectionToken, queued: candidates.length,
          nextCursor: last ? encodeMetadataCursor(last.jobId, last.sourceId) : null,
          // Exhausted is not collection-complete: reservations may still be in flight.
          exhausted: candidates.length < limit, extractionVersion: ROLE_METADATA_EXTRACTION_VERSION }));
      }
      if (input.action === 'apply') {
        if (typeof input.repairToken !== 'string' || !/^[a-f0-9]{64}$/u.test(input.repairToken)) throw new Error('repairToken is invalid');
        if (!Number.isInteger(input.expectedJobs) || (input.expectedJobs ?? -1) < 0 || !Number.isInteger(input.expectedOccurrences) || input.expectedOccurrences !== 0) {
          throw new Error('expectedJobs and expectedOccurrences must exactly match the dry-run');
        }
        const result = await operations.applyRoleMetadataRepair(input.repairToken, input.expectedJobs!, input.expectedOccurrences!, new Date().toISOString());
        if (result.projectionRefreshRequired) await refreshCatalogProjection(new D1InternshipStore(env.DB));
        // Full verification is a separate read-only request. Repeating the
        // paged whole-cohort audit after the guarded transaction and grouped
        // projection refresh can exceed D1's per-invocation query budget.
        return withCors(Response.json({ ...result, applied: true, verificationRequired: true,
          verificationPath: '/internal/role-metadata/audit' }));
      }
      if (input.action && input.action !== 'dry-run') throw new Error('action must be collect, dry-run, or apply');
      const report = await operations.stageRoleMetadataRepair(new Date().toISOString());
      const audit = await operations.roleMetadataAudit();
      return withCors(Response.json({
        ...report,
        verificationOutcomes: audit.verificationOutcomes,
        collectionCoverage: audit.collectionCoverage,
        projectionOnlyOmissions: audit.projectionOnlyOmissions,
        deferredProjections: audit.deferredProjections,
        supportedRoleSpecificDisclosedMetadataMisses: audit.supportedRoleSpecificDisclosedMetadataMisses,
        applied: false,
      }, { status: report.conflicts.length || audit.deferredProjections.length || !audit.collectionCoverage.complete ? 409 : 200 }));
    } catch (error) {
      return withCors(Response.json({ message: error instanceof Error ? error.message : 'Role metadata backfill failed' }, { status: 409 }));
    }
  }
  if (request.method === 'POST' && url.pathname === '/internal/catalog-quality-backfill') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const input = await request.json().catch(() => ({})) as { apply?: boolean; repairToken?: string; expectedChanged?: number };
    try {
      const report = await runCatalogQualityBackfill(env.DB, input);
      if (input.apply && report.projectionRefreshRequired) {
        await refreshCatalogProjection(new D1InternshipStore(env.DB));
        const verified = await runCatalogQualityBackfill(env.DB);
        return withCors(Response.json({ ...report, verification: verified }));
      }
      return withCors(Response.json(report, { status: report.conflicts.length ? 409 : 200 }));
    } catch (error) {
      return withCors(Response.json({ message: error instanceof Error ? error.message : 'Backfill failed' }, { status: 409 }));
    }
  }
  if (url.pathname.startsWith('/internal/admission/')) {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    return withCors(await handleCatalogAdmissionOperations(
      request,
      new D1CatalogAdmissionStore(env.DB),
      () => refreshCatalogProjection(new D1InternshipStore(env.DB)),
      'operations-reviewer',
      () => new Date(),
      (operation) => env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage(operation)),
      async () => ({
        work: env.DESTINATION_VERIFICATION_QUEUE.metrics ? await env.DESTINATION_VERIFICATION_QUEUE.metrics() : { status: 'unavailable' },
        deadLetter: env.DESTINATION_VERIFICATION_DLQ.metrics ? await env.DESTINATION_VERIFICATION_DLQ.metrics() : { status: 'unavailable' },
      }),
    ));
  }
  if (request.method === 'POST' && url.pathname === '/internal/posting-identity-repair') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const input = await request.json().catch(() => ({})) as {
      apply?: boolean; repairToken?: string; expectedChanges?: number; expectedDuplicateJobs?: number;
      scope?: 'all' | 'identity' | 'occurrences';
    };
    try {
      const report = await runPostingIdentityRepair(env.DB, input);
      if (input.apply && report.projectionRefreshRequired) {
        await refreshCatalogProjection(new D1InternshipStore(env.DB));
        const verification = await runPostingIdentityRepair(env.DB, { scope: input.scope });
        return withCors(Response.json({ ...report, verification }));
      }
      return withCors(Response.json(report, { status: report.conflicts.length ? 409 : 200 }));
    } catch (error) {
      return withCors(Response.json({ message: error instanceof Error ? error.message : 'Posting identity repair failed' }, { status: 409 }));
    }
  }
  if (url.pathname === '/internal/operations/dlq') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    return withCors(await handleDlqOperations(request, dlqDependencies(env)));
  }
  if (request.method === 'GET' && url.pathname === '/internal/operations/shadow-extraction') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    return withCors(Response.json(await shadowExtractionSummary(env.DB), { headers: { 'Cache-Control': 'no-store' } }));
  }
  if (url.pathname === '/internal/operations/shadow-publication') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    return withCors(await handleShadowPublication(request, env,
      () => refreshCatalogProjection(new D1InternshipStore(env.DB))));
  }
  if (request.method === 'POST' && url.pathname === '/internal/poll-source') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const provider = url.searchParams.get('provider');
    const sourceId = url.searchParams.get('sourceId');
    const atsProvider = isCatalogProviderId(provider) && provider !== 'github' ? provider : undefined;
    if (!sourceId || (provider !== 'structured' && !atsProvider)) {
      return withCors(Response.json({ message: 'provider and sourceId are required' }, { status: 400 }));
    }
    const employerStore = new D1EmployerStore(env.DB);
    if (provider === 'structured') {
      const source = (await reviewedStructuredRegistry(employerStore)).find((candidate) => candidate.id === sourceId);
      if (!source) return withCors(Response.json({ message: 'Source not found' }, { status: 404 }));
      try {
        await runStructuredSource(source, env, { forceRecovery: true });
        return withCors(Response.json({ sourceId, processed: true }));
      } catch (error) {
        return withCors(Response.json({ sourceId, processed: false, message: error instanceof Error ? error.message : 'Structured poll failed' }, { status: 502 }));
      }
    }
    const providers = await reviewedProviderRegistry(employerStore);
    const registry = atsProvider === 'greenhouse' ? providers.greenhouse : atsProvider === 'lever' ? providers.lever : providers.ashby;
    const source = registry.find((candidate) => candidate.id === sourceId);
    if (!source) return withCors(Response.json({ message: 'Source not found' }, { status: 404 }));
    const now = new Date();
    const message = atsProvider === 'greenhouse'
      ? { ...greenhouseWorkMessages([source as typeof reviewedGreenhouseSources[number]], now)[0]!, force: true }
      : atsProvider === 'lever'
        ? { ...leverWorkMessages([source as typeof reviewedLeverSources[number]], now, crypto.randomUUID())[0]!, force: true }
        : { ...ashbyWorkMessages([source as typeof reviewedAshbySources[number]], now, crypto.randomUUID())[0]!, force: true };
    const event = { Records: [{ messageId: crypto.randomUUID(), body: JSON.stringify(message) }] };
    const dependencies = { store: new D1InternshipStore(env.DB), userStore: new D1UserStore(env.DB) };
    const result = atsProvider === 'greenhouse'
      ? await processGreenhouseQueue(event, { ...dependencies, sources: providers.greenhouse })
      : atsProvider === 'lever'
        ? await processLeverQueue(event, { ...dependencies, sources: providers.lever })
        : await processAshbyQueue(event, { ...dependencies, sources: providers.ashby });
    if (result.batchItemFailures.length) return withCors(Response.json({ sourceId, processed: false }, { status: 502 }));
    return withCors(Response.json({ sourceId, processed: true }));
  }
  if (request.method === 'POST' && url.pathname === '/internal/backfill') {
    if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const provider = url.searchParams.get('provider') ?? 'all';
    if (!validBackfillProvider(provider)) {
      return withCors(Response.json({ message: 'provider is invalid' }, { status: 400 }));
    }
    const queued: Record<string, number> = {};
    if (provider === 'all' || provider === 'github') {
      await sendQueueMessages(env.GITHUB_QUEUE, defaultSources.map((source) => ({ sourceId: source.id })));
      queued.github = defaultSources.length;
    }
    if (provider === 'all' || provider === 'structured') {
      const structured = await reviewedStructuredRegistry(new D1EmployerStore(env.DB));
      await sendQueueMessages(env.GITHUB_QUEUE, structured.map((source) => ({ sourceId: source.id, sourceKind: 'structured' })));
      queued.structured = structured.length;
    }
    for (const candidate of catalogProviderIds.filter((id): id is Exclude<CatalogProviderId, 'github'> => id !== 'github')) {
      if (provider === 'all' || provider === candidate) queued[candidate] = await dispatchProviders(env, candidate, new Date(), true);
    }
    return withCors(Response.json({ queued }));
  }
  if (url.pathname.startsWith('/operations/') || url.pathname.startsWith('/internal/operations/')) {
    if (url.pathname.startsWith('/operations/employers/')) {
      if (!operationsAuthorized(request, env)) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
      return withCors(await handleEmployerOperations(request, {
        store: new D1EmployerStore(env.DB), jobs: new D1InternshipStore(env.DB),
        actor: 'operations-reviewer', validateReviewedHost,
      }));
    }
    const queueClient = cloudflareOperationsQueueClient(env);
    const cloudwatch = { async send() { return { MetricAlarms: [] }; } };
    const operations = createSourceOperationsHandler({
      store: new D1InternshipStore(env.DB),
      sharedSecret: env.OPERATIONS_SHARED_SECRET,
      fleets: cloudflareOperationsFleets(env),
      sqs: queueClient as never,
      cloudwatch: cloudwatch as never,
      alarmTelemetry: {
        status: 'unavailable',
        reason: 'Cloudflare alert policy state is not exposed to this Worker; queue and DLQ counts are live.',
      },
      queueTelemetry: {
        status: 'partial',
        reason: 'queuedMessages is the live total backlog; Cloudflare does not expose a waiting-versus-processing split.',
      },
    });
    const result = await operations({
      requestContext: { http: { method: request.method } },
      rawPath: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(request.headers.entries()),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    });
    return eventResponse(result);
  }
  const authResponse = await handleAuthRequest(request, env);
  if (authResponse) return withCors(authResponse);
  if (request.method === 'POST' && url.pathname === '/installations') {
    const ip = request.headers.get('CF-Connecting-IP')?.trim();
    if (ip) {
      const rateLimit = await consumeAuthRateLimit(env, 'installation:ip', ip, {
        limit: 20,
        windowMs: 60 * 60_000,
        blockMs: 60 * 60_000,
      });
      if (!rateLimit.allowed) {
        return withCors(Response.json({ message: 'Too many installation requests. Try again later.' }, {
          status: 429,
          headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) },
        }));
      }
    }
    return withCors(Response.json(await createInstallation(env), {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    }));
  }
  const roleReportMatch = url.pathname.match(/^\/roles\/([^/]+)\/reports$/u);
  if (request.method === 'POST' && roleReportMatch) {
    const accountId = await authenticatedUser(request, env);
    const reporterId = accountId ?? await authenticatedInstallation(request, env);
    if (!reporterId) return withCors(Response.json({ message: 'Account or installation authorization required' }, { status: 401 }));
    const rateLimit = await consumeAuthRateLimit(env, 'role-report:reporter', reporterId, { limit: 10, windowMs: 24 * 60 * 60_000, blockMs: 24 * 60 * 60_000 });
    if (!rateLimit.allowed) return withCors(Response.json({ message: 'Too many reports. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds) } }));
    const declaredLength = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > 8 * 1024) return withCors(Response.json({ message: 'Request body is too large' }, { status: 413 }));
    const reportText = await request.text();
    if (new TextEncoder().encode(reportText).byteLength > 8 * 1024) return withCors(Response.json({ message: 'Request body is too large' }, { status: 413 }));
    const input = (() => { try { return JSON.parse(reportText) as { category?: unknown; details?: unknown }; } catch { return null; } })();
    const categories = ['identity', 'destination', 'closed-role', 'misleading-metadata', 'other'] as const;
    if (!input || !categories.includes(input.category as typeof categories[number]) || (input.details !== undefined && (typeof input.details !== 'string' || input.details.length > 1_000))) {
      return withCors(Response.json({ message: 'A supported report category and at most 1,000 characters of detail are required' }, { status: 400 }));
    }
    const jobId = decodeURIComponent(roleReportMatch[1]!);
    const job = await new D1InternshipStore(env.DB).getJob(jobId);
    const submitted = job?.sourceReferences.find((reference) => reference.provenance === 'employer-submitted' && reference.externalId);
    const match = submitted?.sourceId.match(/^employer:([^:]+):submission:/u);
    if (!job || !submitted?.externalId || !match) return withCors(Response.json({ message: 'Employer-submitted role not found' }, { status: 404 }));
    const key = request.headers.get('Idempotency-Key')?.trim();
    if (!key || key.length > 160) return withCors(Response.json({ message: 'Idempotency-Key is required' }, { status: 400 }));
    const timestamp = new Date().toISOString(); const organizationId = match[1]!;
    const reportId = `report-${createHash('sha256').update(`${organizationId}:${reporterId}:${key}`).digest('hex').slice(0, 24)}`;
    const employerStore = new D1EmployerStore(env.DB);
    const result = { reportId, state: 'open' as const };
    if (await employerStore.idempotencyResult(organizationId, 'role.report', key)) return withCors(Response.json({ ...result, replayed: true }));
    await employerStore.putReport({ id: reportId, organizationId, submissionId: submitted.externalId, reporterKey: createHash('sha256').update(reporterId).digest('hex'), category: input.category as typeof categories[number], details: typeof input.details === 'string' ? input.details.trim() : undefined, state: 'open', createdAt: timestamp }, {
      id: crypto.randomUUID(), organizationId, action: 'report.created', actorType: 'system', subjectType: 'submission', subjectId: submitted.externalId,
      details: { category: input.category, jobId }, createdAt: timestamp, idempotencyKey: key,
    });
    await employerStore.claimIdempotency(organizationId, 'role.report', key, timestamp, result);
    return withCors(Response.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } }));
  }
  const handler = createApiHandler({
    jobs: new D1InternshipStore(env.DB),
    users: new D1UserStore(env.DB),
    releases: new D1ReleaseStore(env.DB),
    documentStorage: documentStorage(env),
    identityUnconfirmedPublicationEnabled: env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
    beforeDeleteUser: (userId) => disconnectGmail(userId, env),
    deleteIdentity: async (id) => {
      const email = await accountEmail(env, id);
      await removeEmployerAccessForDeletedAccount(env, id, email);
      await deleteAuthUser(id, env);
    },
  });
  if (url.pathname.startsWith('/installation/')) {
    const installationUserId = await authenticatedInstallation(request, env);
    if (!installationUserId) return withCors(Response.json({ message: 'Installation authorization required' }, { status: 401 }));
    const installationPath = url.pathname.slice('/installation'.length);
    const allowed = installationPath === '/preferences'
      || installationPath === '/opening'
      || installationPath === '/devices'
      || installationPath.startsWith('/devices/')
      || installationPath.startsWith('/releases/');
    if (!allowed) return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    const installationEvent = apiEvent(request, installationUserId, request.method === 'GET' || request.method === 'HEAD' ? null : await request.text());
    installationEvent.rawPath = `/me${installationPath}`;
    return eventResponse(await handler(installationEvent));
  }
  const userId = await authenticatedUser(request, env);
  if (userId && url.pathname.startsWith('/me/gmail')) {
    const response = await gmailApi(request, env, userId);
    if (response) return withCors(response);
  }
  if (url.pathname.startsWith('/employer/')) {
    if (env.EMPLOYER_PORTAL_ENABLED !== 'true') return withCors(Response.json({ message: 'Not found' }, { status: 404 }));
    if (!userId) return withCors(Response.json({ message: 'Authentication required' }, { status: 401 }));
    const userEmail = await verifiedAccountEmail(env, userId);
    if (!userEmail) return withCors(Response.json({ message: 'A verified account is required' }, { status: 403 }));
    return withCors(await handleEmployerApi(request, {
      store: new D1EmployerStore(env.DB), jobs: new D1InternshipStore(env.DB), userId, userEmail, verifyPublishedChallenge,
      validateSourceUrl: async (value) => { await assertPublicHttpsUrl(value, publicHostResolver); },
    }));
  }
  const contentMatch = url.pathname.match(/^\/me\/documents\/([^/]+)\/content$/u);
  if (contentMatch && (request.method === 'GET' || request.method === 'PUT')) {
    if (!userId) return withCors(Response.json({ message: 'Authentication required' }, { status: 401 }));
    return withCors(await documentContent(request, env, userId, decodeURIComponent(contentMatch[1])));
  }
  const event = apiEvent(request, userId, request.method === 'GET' || request.method === 'HEAD' ? null : await request.text());
  const result = await handler(event);
  return eventResponse(result);
}

async function due<T extends { id: string; status: 'published' | 'shadow' }>(
  sources: T[],
  store: D1InternshipStore,
  now: Date,
  predicate: (source: T, checkpoint: SourceCheckpoint | undefined, now: Date, health?: SourceHealth) => boolean,
): Promise<T[]> {
  const results: Array<T | undefined> = await Promise.all(sources.map(async (source): Promise<T | undefined> => {
    const checkpointId = source.status === 'shadow' ? `shadow-${source.id}` : source.id;
    const [checkpoint, health] = await Promise.all([store.getCheckpoint(checkpointId), store.getSourceHealth(source.id)]);
    return predicate(source, checkpoint, now, health) ? source : undefined;
  }));
  return results.filter((source): source is T => Boolean(source));
}

async function sendQueueMessages(queue: Queue, messages: unknown[]): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += 100) {
    await queue.sendBatch(messages.slice(offset, offset + 100).map((body) => ({ body })));
  }
}

async function dispatchProviders(
  env: Environment,
  provider: Exclude<CatalogProviderId, 'github'>,
  now = new Date(),
  force = false,
): Promise<number> {
  const store = new D1InternshipStore(env.DB);
  const registry = await reviewedProviderRegistry(new D1EmployerStore(env.DB));
  if (provider === 'greenhouse') {
    const sources = force ? registry.greenhouse : await due(registry.greenhouse, store, now, isGreenhouseSourceDue);
    const messages = greenhouseWorkMessages(sources, now);
    await sendQueueMessages(env.GREENHOUSE_QUEUE, messages);
    return messages.length;
  }
  if (provider === 'lever') {
    const dynamic = (await store.listLeverAdmissions?.() ?? []).map(({ source }) => source);
    const leverRegistry = [...registry.lever, ...dynamic.filter((source) => !registry.lever.some((candidate) => candidate.id === source.id))];
    const sources = force ? leverRegistry : await due(leverRegistry, store, now, isLeverSourceDue);
    const messages = leverWorkMessages(sources, now, crypto.randomUUID());
    await sendQueueMessages(env.LEVER_QUEUE, messages);
    return messages.length;
  }
  const sources = force ? registry.ashby : await due(registry.ashby, store, now, isAshbySourceDue);
  const messages = ashbyWorkMessages(sources, now, crypto.randomUUID());
  await sendQueueMessages(env.ASHBY_QUEUE, messages);
  return messages.length;
}

async function refreshCatalogProjection(store: D1InternshipStore) {
  const groups = groupCatalogJobs(await store.listCatalog(), { includeClosed: true }).map(catalogGroupDetails);
  const generatedAt = new Date().toISOString();
  await store.putCatalogProjection(groups, generatedAt);
  return {
    generatedAt,
    groups: groups.length,
    roles: groups.reduce((total, group) => total + group.roles.length, 0),
  };
}

export type PostingIdentityAuditEvent = {
  event: 'posting_identity_integrity_audit';
  enforcementActive: boolean;
  status: 'passed' | 'failed' | 'error';
  confirmedOccurrences: number | null;
  unconfirmedOccurrences: number | null;
  confirmedCoverage: number | null;
  confirmedCoverageFloor: number | null;
  coverageRegression: boolean | null;
  exactDuplicateGroups: number | null;
  duplicateJobs: number | null;
  duplicateAlertGroups: number | null;
  aliasConflicts: number | null;
  quarantinedOccurrences: number | null;
  untrackedQuarantines: number | null;
  presentationBlockers: number | null;
  legacyOccurrences: number | null;
  projectionMismatches: number | null;
  duplicateOccurrenceReferences: number | null;
  danglingOccurrenceReferences: number | null;
};

function postingIdentityAuditEvent(
  plan: PostingIdentityRepairPlan,
  enforcementActive: boolean,
  confirmedCoverageFloor: number,
): PostingIdentityAuditEvent {
  const coverageRegression = plan.occurrenceCounts.confirmedCoverage === null
    || plan.occurrenceCounts.confirmedCoverage < confirmedCoverageFloor;
  return {
    event: 'posting_identity_integrity_audit',
    enforcementActive,
    status: plan.gate.passed && !coverageRegression ? 'passed' : 'failed',
    confirmedOccurrences: plan.occurrenceCounts.confirmed,
    unconfirmedOccurrences: plan.occurrenceCounts.unconfirmed,
    confirmedCoverage: plan.occurrenceCounts.confirmedCoverage,
    confirmedCoverageFloor,
    coverageRegression,
    exactDuplicateGroups: plan.gate.exactDuplicateGroups,
    duplicateJobs: plan.duplicateJobs,
    duplicateAlertGroups: plan.duplicateAlertGroups,
    aliasConflicts: plan.gate.aliasConflicts,
    quarantinedOccurrences: plan.occurrenceCounts.quarantined,
    untrackedQuarantines: plan.gate.untrackedQuarantines,
    presentationBlockers: plan.gate.presentationBlockers,
    legacyOccurrences: plan.gate.legacyOccurrences,
    projectionMismatches: plan.gate.projectionMismatches,
    duplicateOccurrenceReferences: plan.gate.duplicateOccurrenceReferences,
    danglingOccurrenceReferences: plan.gate.danglingOccurrenceReferences,
  };
}

/** Emit only aggregate integrity counts. Repair tokens, job IDs, URLs, and
 * review samples stay out of production logs. Disabled rollout reports a
 * failed gate without failing the cron; enabled publication makes it fatal. */
export async function runScheduledPostingIdentityAudit(
  env: Pick<Environment, 'DB' | 'IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED' | 'IDENTITY_CONFIRMED_COVERAGE_FLOOR'>,
  dependencies: {
    audit?: (db: D1Database) => Promise<PostingIdentityRepairPlan>;
    log?: (event: string) => void;
  } = {},
): Promise<PostingIdentityAuditEvent> {
  const enforcementActive = env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true';
  const parsedCoverageFloor = Number(env.IDENTITY_CONFIRMED_COVERAGE_FLOOR);
  const confirmedCoverageFloor = env.IDENTITY_CONFIRMED_COVERAGE_FLOOR?.trim()
    && Number.isFinite(parsedCoverageFloor) && parsedCoverageFloor >= 0 && parsedCoverageFloor <= 1
    ? parsedCoverageFloor
    : undefined;
  const audit = dependencies.audit ?? ((db: D1Database) => runPostingIdentityRepair(db));
  let event: PostingIdentityAuditEvent;
  try {
    const plan = await audit(env.DB);
    event = confirmedCoverageFloor === undefined
      ? {
        ...postingIdentityAuditEvent(plan, enforcementActive, 1),
        status: 'error', confirmedCoverageFloor: null, coverageRegression: null,
      }
      : postingIdentityAuditEvent(plan, enforcementActive, confirmedCoverageFloor);
  } catch {
    event = {
      event: 'posting_identity_integrity_audit', enforcementActive, status: 'error',
      confirmedOccurrences: null, unconfirmedOccurrences: null, confirmedCoverage: null,
      confirmedCoverageFloor: confirmedCoverageFloor ?? null, coverageRegression: null,
      exactDuplicateGroups: null, duplicateJobs: null, duplicateAlertGroups: null, aliasConflicts: null,
      quarantinedOccurrences: null, untrackedQuarantines: null, presentationBlockers: null,
      legacyOccurrences: null, projectionMismatches: null, duplicateOccurrenceReferences: null,
      danglingOccurrenceReferences: null,
    };
  }
  const serialized = JSON.stringify(event);
  if (dependencies.log) dependencies.log(serialized);
  else if (event.status === 'passed') console.log(serialized);
  else console.error(serialized);
  if (enforcementActive && event.status !== 'passed') {
    throw new Error('Posting identity integrity gate failed while publication enforcement is active');
  }
  return event;
}

async function scheduledHandler(event: ScheduledController, env: Environment): Promise<void> {
  if (await isShutdown(env)) return;
  const store = new D1InternshipStore(env.DB);
  if (event.cron === '17 9 * * *') {
    await runScheduledPostingIdentityAudit(env);
    return;
  }
  const scheduledProvider = providerForCloudflareCron(event.cron);
  if (scheduledProvider === 'github') {
    if (await queueHasBacklog(env.GITHUB_QUEUE, 'github')) return;
    const structured = await reviewedStructuredRegistry(new D1EmployerStore(env.DB));
    const dueStructured = (await Promise.all(structured.map(async (source) => {
      const health = await store.getSourceHealth(source.id);
      if (health?.sourceStatus === 'paused' || health?.state === 'quarantined') return undefined;
      if (health?.backoffUntil && Date.parse(health.backoffUntil) > Date.now()) return undefined;
      if (health?.lastAttemptAt && Date.parse(health.lastAttemptAt) > Date.now() - 30 * 60_000) return undefined;
      return source;
    }))).filter((source): source is ReviewedStructuredSource => Boolean(source));
    const dueGithub = (await Promise.all(defaultSources.map(async (source) => {
      const health = await store.getSourceHealth(source.id);
      if (health?.sourceStatus === 'paused' || health?.state === 'quarantined') return undefined;
      if (health?.backoffUntil && Date.parse(health.backoffUntil) > Date.now()) return undefined;
      return source;
    }))).filter((source): source is typeof defaultSources[number] => Boolean(source));
    await sendQueueMessages(env.GITHUB_QUEUE, [
      ...dueGithub.map((source) => ({ sourceId: source.id })),
      ...dueStructured.map((source) => ({ sourceId: source.id, sourceKind: 'structured' })),
    ]);
    return;
  }
  if (event.cron === '9-59/10 * * * *') {
    const observedAt = new Date(event.scheduledTime);
    const admissionVerificationRetries = await enqueueDueDestinationVerifications(env, observedAt);
    const queueMetrics = env.DESTINATION_VERIFICATION_QUEUE.metrics ? await env.DESTINATION_VERIFICATION_QUEUE.metrics() : undefined;
    const deadLetterMetrics = env.DESTINATION_VERIFICATION_DLQ.metrics ? await env.DESTINATION_VERIFICATION_DLQ.metrics() : undefined;
    const maximumQueueAgeMs = Number(env.ADMISSION_QUEUE_AGE_ALERT_HOURS ?? 120) * 60 * 60_000;
    const queueAgeMs = queueMetrics?.oldestMessageTimestamp
      ? observedAt.getTime() - queueMetrics.oldestMessageTimestamp.getTime() : 0;
    const operationalSignals = [
      ...(deadLetterMetrics?.backlogCount ? ['destination-verification-dlq'] : []),
      ...(queueAgeMs >= maximumQueueAgeMs ? ['destination-verification-age'] : []),
    ];
    await sendAdmissionOperationalAlert(new D1CatalogAdmissionStore(env.DB), env, {
      signals: operationalSignals, observedAt: observedAt.toISOString(),
      details: `Destination queue depth: ${queueMetrics?.backlogCount ?? 'unavailable'}; oldest age ms: ${queueAgeMs}; DLQ depth: ${deadLetterMetrics?.backlogCount ?? 'unavailable'}.`,
    });
    const projection = await refreshCatalogProjection(store);
    const notifications = await drainPendingExpoNotifications(store, new D1UserStore(env.DB), new ExpoPushPublisher());
    console.log(JSON.stringify({ event: 'cloudflare_maintenance_complete', projection, notifications, admissionVerificationRetries }));
    return;
  }
  if (event.cron === '*/5 * * * *') {
    if (env.GMAIL_ENABLED !== 'true') return;
    const gmail = new GmailStore(env.DB);
    const userIds = await gmail.due(new Date(event.scheduledTime));
    await sendQueueMessages(env.GMAIL_QUEUE, userIds.map((userId) => ({
      version: 1,
      userId,
      mode: 'history',
      requestedAt: new Date(event.scheduledTime).toISOString(),
      advanceChecks: true,
    } satisfies GmailWorkMessage)));
    return;
  }
  if (scheduledProvider) {
    const provider = scheduledProvider as Exclude<CatalogProviderId, 'github'>;
    const queue = env[integrationRegistry[provider].runtime.cloudflareWorkBinding];
    if (!await queueHasBacklog(queue, provider)) await dispatchProviders(env, provider);
    return;
  }
  if (event.cron === '0 * * * *') {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(event.scheduledTime)));
    if (hour !== 9 && hour !== 17) return;
    if (!env.RESEND_API_KEY || !env.AUTH_FROM_EMAIL || !env.DIGEST_TO_EMAIL) throw new Error('Digest email is not configured');
    await runRuntimeCommand('digest', {
      store,
      config: { sesFrom: env.AUTH_FROM_EMAIL, sesTo: env.DIGEST_TO_EMAIL },
      emailSender: new ResendEmailSender(env.AUTH_FROM_EMAIL, env.DIGEST_TO_EMAIL, env.RESEND_API_KEY),
    });
    return;
  }
  if (event.cron === '42 8 * * *') {
    await cleanupExpiredAuth(env);
    await cleanupExpiredUserData(env.DB);
    await new GmailStore(env.DB).cleanup(new Date(event.scheduledTime));
    await cleanupDlqRecords(env.DB, new Date(event.scheduledTime));
    const employerMaintenance = await runEmployerMaintenance(new D1EmployerStore(env.DB), store, new Date(event.scheduledTime));
    const admissionVerificationRetries = await enqueueDueDestinationVerifications(env, new Date(event.scheduledTime));
    const admissionAudit = await new D1CatalogAdmissionStore(env.DB).audit({
      includeRecords: false,
      includeUnresolvedEmployers: false,
    });
    const activeAdmissionIncidents = (await new D1CatalogAdmissionStore(env.DB).listActiveIncidents()).length;
    const staleThreshold = Number(env.ADMISSION_STALE_ALERT_THRESHOLD ?? 1);
    await sendAdmissionOperationalAlert(new D1CatalogAdmissionStore(env.DB), env, {
      signals: [
        ...(admissionAudit.freshness.staleEligible >= staleThreshold ? ['stale-destination-evidence'] : []),
        ...(activeAdmissionIncidents ? ['active-admission-incidents'] : []),
      ],
      observedAt: new Date(event.scheduledTime).toISOString(),
      details: `Stale eligible destination evidence: ${admissionAudit.freshness.staleEligible}; total stale evidence: ${admissionAudit.freshness.stale}; active admission incidents: ${activeAdmissionIncidents}.`,
    });
    console.log(JSON.stringify({ event: 'employer_maintenance_complete', ...employerMaintenance, admissionVerificationRetries,
      admissionFreshness: admissionAudit.freshness, admissionValidationCoverage: admissionAudit.validationCoverage,
      activeAdmissionIncidents,
      admissionOperations: admissionAudit.operations }));
  }
}

async function queueHandler(batch: MessageBatch<unknown>, env: Environment): Promise<void> {
  if (await isShutdown(env)) {
    for (const message of batch.messages) message.ack();
    return;
  }
  if (batch.queue.includes('destination-verification')) {
    await processDestinationVerificationBatch(batch, env);
    return;
  }
  if (batch.queue.includes('shadow-extraction')) {
    await processShadowExtractionBatch(batch, env);
    return;
  }
  const records = batch.messages.map((message) => ({ messageId: message.id, body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body) }));
  if (batch.queue.includes('gmail')) {
    for (const message of batch.messages) {
      const body = (typeof message.body === 'string' ? JSON.parse(message.body) : message.body) as GmailWorkMessage;
      try {
        await processGmailWork(body, env);
        message.ack();
      } catch (error) {
        const failure = await recordGmailFailure(body.userId, error, env);
        console.error(JSON.stringify({
          event: 'gmail_work_failed',
          messageId: message.id,
          mode: body.mode,
          advanceChecks: body.advanceChecks === true,
          retry: failure.retry,
          retryDelaySeconds: failure.delaySeconds,
          error: error instanceof Error ? error.message : String(error),
          status: (error as { status?: unknown }).status ?? null,
          googleStatus: (error as { googleStatus?: unknown }).googleStatus ?? null,
        }));
        if (failure.retry) message.retry({ delaySeconds: failure.delaySeconds });
        else message.ack();
      }
    }
    return;
  }
  // Catalog consumers dead-letter valid work when D1 rotates its instance
  // mid-poll. Their persistence writes are idempotent, so retry the transient
  // reconnect error only for stores built by these catalog paths (issue #203).
  // Do not extend this wrapper to destination, shadow, or Gmail consumers:
  // their state transitions include writes whose business semantics require
  // their own idempotency guards.
  env = { ...env, DB: resilientD1(env.DB) };
  const catalogProvider = providerForQueueName(batch.queue);
  if (catalogProvider === 'github') {
    const failed = new Set<string>();
    const employerStore = new D1EmployerStore(env.DB);
    const admissionResolver = catalogAdmissionResolver(env);
    let structured: Awaited<ReturnType<typeof reviewedStructuredRegistry>>;
    try {
      structured = await reviewedStructuredRegistry(employerStore);
    } catch (error) {
      for (const queued of batch.messages) {
        const parsed = (() => {
          try { return JSON.parse(typeof queued.body === 'string' ? queued.body : JSON.stringify(queued.body)) as { sourceId?: string; sourceKind?: string }; }
          catch { return undefined; }
        })();
        await recordQueueFailureBestEffort({
          db: env.DB, queueName: batch.queue, messageId: queued.id, attempts: queued.attempts,
          timestamp: queued.timestamp, sourceId: parsed?.sourceId, sourceKind: parsed?.sourceKind,
          body: queued.body, error,
        });
        console.error(JSON.stringify({ command: 'github-poll-setup', messageId: queued.id, error: safeDiagnostic(error) }));
        queued.retry();
      }
      return;
    }
    const resolveFailures = async (messageId: string, attempts?: number) => {
      // A first-delivery message has no prior failure row, so skip the extra
      // write. Only retried deliveries (attempts > 1) can carry one to resolve.
      if ((attempts ?? 0) <= 1) return;
      try { await resolveQueueFailures(env.DB, batch.queue, messageId); }
      catch (error) {
        console.error(JSON.stringify({ command: 'github-failure-ledger-resolution', messageId,
          error: safeDiagnostic(error) }));
      }
    };
    for (const queued of batch.messages) {
      const record = { messageId: queued.id, body: typeof queued.body === 'string' ? queued.body : JSON.stringify(queued.body) };
      let parsedMessage: { sourceId?: string; sourceKind?: string; force?: boolean } | undefined;
      try {
        const message = JSON.parse(record.body) as { sourceId?: string; sourceKind?: string; force?: boolean };
        parsedMessage = message;
        const sourceId = message.sourceId;
        const reviewedStructured = message.sourceKind === 'structured' ? structured.find((candidate) => candidate.id === sourceId) : undefined;
        const source = defaultSources.find((candidate) => candidate.id === sourceId);
        if (reviewedStructured) {
          const ran = await runStructuredSource(reviewedStructured, env, { forceRecovery: message.force === true });
          if (ran) await resolveFailures(queued.id, queued.attempts);
          continue;
        }
        if (!source) throw new Error(`Unknown reviewed source ${JSON.stringify(sourceId)}`);
        const priorHealth = await new D1InternshipStore(env.DB).getSourceHealth(source.id);
        if (githubSourceRunBlocked(priorHealth, message.force)) {
          console.log(JSON.stringify({ event: 'source_poll_skipped', command: 'github-poll', sourceId: source.id,
            reason: priorHealth?.state === 'quarantined' ? 'quarantined' : priorHealth?.sourceStatus === 'paused' ? 'paused' : 'backoff' }));
          continue;
        }
        const result = await runRuntimeCommand('poll', {
          store: new D1InternshipStore(env.DB),
          userStore: new D1UserStore(env.DB),
          sources: [source],
          validateCatalogOnPoll: false,
          enqueueDestinationVerification: (request) => env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage(request)),
          catalogAdmissionResolver: admissionResolver,
          identityUnconfirmedPublicationEnabled: env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
          trustedCommunityCatalogEnabled: env.TRUSTED_COMMUNITY_CATALOG_ENABLED === 'true',
          // One row can perform several bounded HTTP probes. Keep migration
          // slices small enough to make durable progress even when the tail is
          // dominated by destinations that consume the six connection slots.
          maxAdmissionMigrationListingsPerSourceRun: 20,
          config: { sesFrom: env.AUTH_FROM_EMAIL ?? '', sesTo: env.DIGEST_TO_EMAIL ?? '', ntfyTopic: env.NTFY_TOPIC, ntfyEndpoint: env.NTFY_ENDPOINT },
        });
        if (result.poll && (result.poll.continuationSources.length || result.poll.failures.length)) {
          console.log(JSON.stringify({
            event: 'github_admission_migration_slice',
            sourceId: source.id,
            continuation: result.poll.continuationSources.includes(source.id),
            failureCount: result.poll.failures.length,
            failures: result.poll.failures.slice(0, 20),
          }));
        }
        if (result.poll?.failures.length) throw new Error(result.poll.failures.join('; '));
        if (result.poll?.continuationSources.includes(source.id)) {
          await sendQueueMessageWithin(env.GITHUB_QUEUE, { sourceId: source.id });
        }
        await resolveFailures(queued.id, queued.attempts);
      } catch (error) {
        failed.add(record.messageId);
        await recordQueueFailureBestEffort({
          db: env.DB, queueName: batch.queue, messageId: queued.id, attempts: queued.attempts,
          timestamp: queued.timestamp, sourceId: parsedMessage?.sourceId, sourceKind: parsedMessage?.sourceKind,
          body: queued.body, error,
        });
        console.error(JSON.stringify({ command: 'github-poll', messageId: record.messageId, error: safeDiagnostic(error) }));
      }
    }
    for (const message of batch.messages) {
      if (failed.has(message.id)) message.retry();
      else message.ack();
    }
    return;
  }
  const event = { Records: records };
  const messageById = new Map(batch.messages.map((message) => [message.id, message]));
  // Catalog polls carry only a sourceId. Persist the exact failure category and
  // diagnostic before the platform retries and dead-letters the message, so the
  // guarded DLQ inspector can explain every dead-letter instead of only GitHub.
  const onRecordFailure = async (record: { messageId: string; body: string }, error: unknown) => {
    const parsed = (() => {
      try { return JSON.parse(record.body) as { sourceId?: string }; }
      catch { return undefined; }
    })();
    const queued = messageById.get(record.messageId);
    await recordQueueFailureBestEffort({
      db: env.DB, queueName: batch.queue, messageId: record.messageId,
      attempts: queued?.attempts, timestamp: queued?.timestamp, sourceId: parsed?.sourceId,
      sourceKind: catalogProvider, body: record.body, error,
    });
  };
  let registry: Awaited<ReturnType<typeof reviewedProviderRegistry>>;
  try {
    // This read happens before an individual poll reaches processFifoBatch.
    // Without this boundary a D1 failure retried the whole batch directly,
    // leaving healthy sources with neither a health failure nor a ledger row.
    registry = await reviewedProviderRegistry(new D1EmployerStore(env.DB));
  } catch (error) {
    for (const record of records) await onRecordFailure(record, error);
    for (const message of batch.messages) message.retry();
    console.error(JSON.stringify({ command: 'catalog-poll-setup', provider: catalogProvider,
      messageIds: records.map((record) => record.messageId), error: safeDiagnostic(error) }));
    return;
  }
  const dependencies = {
    store: new D1InternshipStore(env.DB), userStore: new D1UserStore(env.DB),
    enqueueDestinationVerification: (request: Parameters<typeof destinationVerificationMessage>[0]) => env.DESTINATION_VERIFICATION_QUEUE.send(destinationVerificationMessage(request)),
    catalogAdmissionResolver: catalogAdmissionResolver(env),
    onRecordFailure,
  };
  // Legacy Lever admissions are irrelevant to Greenhouse and Ashby polls.
  // Avoid an additional D1 read before those providers enter their per-record
  // failure hook, which previously made a transient failure invisible to the
  // failure ledger.
  let legacyLever: typeof registry.lever = [];
  try {
    legacyLever = catalogProvider === 'lever'
      ? (await dependencies.store.listLeverAdmissions?.() ?? []).map(({ source }) => source)
      : [];
  } catch (error) {
    for (const record of records) await onRecordFailure(record, error);
    for (const message of batch.messages) message.retry();
    console.error(JSON.stringify({ command: 'catalog-poll-setup', provider: catalogProvider,
      messageIds: records.map((record) => record.messageId), error: safeDiagnostic(error) }));
    return;
  }
  const leverRegistry = [...registry.lever, ...legacyLever.filter((source) => !registry.lever.some((candidate) => candidate.id === source.id))];
  const result = catalogProvider === 'greenhouse'
    ? await processGreenhouseQueue(event, { ...dependencies, sources: registry.greenhouse })
    : catalogProvider === 'lever'
      ? await processLeverQueue(event, { ...dependencies, sources: leverRegistry })
      : catalogProvider === 'ashby'
        ? await processAshbyQueue(event, { ...dependencies, sources: registry.ashby })
        : { batchItemFailures: records.map((record) => ({ itemIdentifier: record.messageId })) };
  const failed = new Set(result.batchItemFailures.map(({ itemIdentifier }) => itemIdentifier));
  for (const message of batch.messages) {
    if (failed.has(message.id)) message.retry();
    else {
      // A first-delivery message has no prior failure row, so skip the extra
      // write. Only retried deliveries (attempts > 1) can carry one to resolve.
      if ((message.attempts ?? 0) > 1) {
        try { await resolveQueueFailures(env.DB, batch.queue, message.id); }
        catch (error) { console.error(JSON.stringify({ command: 'catalog-failure-ledger-resolution', messageId: message.id, error: safeDiagnostic(error) })); }
      }
      message.ack();
    }
  }
}

export async function sendQueueMessageWithin(queue: Queue, message: unknown, timeoutMs = 5_000): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queue.send(message),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Queue send timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export default {
  fetch: fetchHandler,
  scheduled: scheduledHandler,
  queue: queueHandler,
};
