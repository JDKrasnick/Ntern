import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { jobCategories, matchesJobFilter, parseJobFilter } from './core/filters.js';
import { DynamoInternshipStore, DynamoReleaseStore, DynamoUserStore, type InternshipStore, type ReleaseStore, type UserStore } from './store.js';
import { ACCOUNT_EXPORT_SCHEMA_VERSION, type AccountDataExport, type ApplicantProfile, type ApplicationRecord, type ApplicationStatus, type DeviceToken, type Internship, type OccurrenceProvenance, type UserPreferences } from './types.js';
import { EmployerIntegrationRegistry } from './providers.js';
import { assistanceAvailability } from './application-assistance.js';
import { createApplicationSession, transitionApplicationSession, type ApplicationFieldDraft, type ApplicationSession, type ApplicationSessionEvent } from './application-automation.js';
import { companyCoverage } from '../coverage/summary.js';
import { catalogGroupDetails, filterCatalogGroupDetails, filterCatalogGroups, groupCatalogJobs,
  type CatalogGroupDetails, type CatalogGroupFilter } from './catalog-groups.js';
import { publicApplicationUrl } from './core/application-url.js';
import { occurrenceProvenance } from './sources/provenance.js';
import { catalogEligible, deriveCanonicalAdmission } from './catalog-admission.js';

type ApiEvent = { requestContext?: { authorizer?: { jwt?: { claims?: Record<string, string> } }; http?: { method?: string }; requestId?: string }; rawPath?: string; routeKey?: string; pathParameters?: Record<string, string>; queryStringParameters?: Record<string, string>; headers?: Record<string, string | undefined>; body?: string | null };
type ApiResponse = { statusCode: number; headers: Record<string, string>; body: string };
const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
const reply = (statusCode: number, body: unknown): ApiResponse => ({ statusCode, headers, body: JSON.stringify(body) });
const parseBody = (event: ApiEvent): Record<string, unknown> => { try { return event.body ? JSON.parse(event.body) as Record<string, unknown> : {}; } catch { throw new Error('Request body must be valid JSON'); } };
const identity = (event: ApiEvent) => event.requestContext?.authorizer?.jwt?.claims?.sub;
const now = () => new Date().toISOString();
const statuses: ApplicationStatus[] = ['saved', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn'];
const hashSecret = (value: string) => createHash('sha256').update(value).digest('base64url');
const inMinutes = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
const isBefore = (left: string, right: string) => new Date(left).getTime() < new Date(right).getTime();
const publicJob = <T extends { applyUrl: string; sourceReferences: Array<{ sourceId: string; provenance?: OccurrenceProvenance }> }>(job: T): T => ({
  ...job,
  applyUrl: publicApplicationUrl(job.applyUrl),
  sourceReferences: job.sourceReferences.map((reference) => ({ ...reference, provenance: occurrenceProvenance(reference) })),
});

function catalogFilter(parameters: Record<string, string> | undefined): CatalogGroupFilter {
  const list = (...names: string[]) => {
    const value = names.map((name) => parameters?.[name]).find((candidate) => candidate !== undefined);
    return value?.split(',').map((item) => item.trim()).filter(Boolean);
  };
  return {
    ...(parameters?.q?.trim() ? { query: parameters.q.trim() } : {}),
    ...(parameters?.source ? { source: parameters.source as CatalogGroupFilter['source'] } : {}),
    status: parameters?.status === 'closed' ? 'closed' : 'open',
    ...(list('employerCategory', 'employerCategories')?.length ? { employerCategories: list('employerCategory', 'employerCategories') as CatalogGroupFilter['employerCategories'] } : {}),
    ...(parameters?.hideUsCitizenshipRequired === 'true' ? { hideUsCitizenshipRequired: true } : {}),
    ...(parameters?.hideAdvancedDegreeRequired === 'true' ? { hideAdvancedDegreeRequired: true } : {}),
    ...(parameters?.hasCompensation === 'true' ? { hasCompensation: true } : {}),
    ...(list('discipline', 'disciplines')?.length ? { disciplines: list('discipline', 'disciplines') } : {}),
    ...(list('season', 'seasons')?.length ? { seasons: list('season', 'seasons') } : {}),
    ...(list('education', 'educationLevel', 'educationLevels')?.length ? { educationLevels: list('education', 'educationLevel', 'educationLevels') } : {}),
    ...(list('workMode', 'workModes')?.length ? { workModes: list('workMode', 'workModes') } : {}),
    ...(list('location', 'locations')?.length ? { locations: list('location', 'locations') } : {}),
  };
}

function identityPublished<T extends { postingIdentityStatus?: string }>(value: T, enabled: boolean): boolean {
  return enabled || value.postingIdentityStatus !== 'unconfirmed';
}

async function completeCatalog(store: InternshipStore, identityUnconfirmedPublicationEnabled = true) {
  if (store.listCatalog) return (await store.listCatalog()).filter((job) => identityPublished(job, identityUnconfirmedPublicationEnabled));
  const jobs = []; let cursor: string | undefined;
  do {
    const page = await store.listOpen?.(cursor, 50, 'open');
    if (!page) break;
    jobs.push(...page.jobs.filter((job) => identityPublished(job, identityUnconfirmedPublicationEnabled))); cursor = page.cursor;
  } while (cursor);
  return jobs;
}

async function jobsPage(
  store: InternshipStore,
  cursor: string | undefined,
  limit: number,
  status: 'open' | 'closed',
  query: Parameters<NonNullable<InternshipStore['listOpen']>>[3],
  identityUnconfirmedPublicationEnabled: boolean,
) {
  const jobs: Internship[] = [];
  let next = cursor;
  do {
    const page = await store.listOpen?.(next, Math.max(1, limit - jobs.length), status, query);
    if (!page) return { jobs: [] };
    jobs.push(...page.jobs.filter((job) => identityPublished(job, identityUnconfirmedPublicationEnabled)));
    next = page.cursor;
  } while (jobs.length < limit && next);
  return { jobs, ...(next ? { cursor: next } : {}) };
}

function eligibleProjectedGroup(details: CatalogGroupDetails, at = new Date()): CatalogGroupDetails | undefined {
  const roles = details.roles
    .filter((role) => catalogEligible({ admission: deriveCanonicalAdmission(role.sourceReferences, at.toISOString()) }))
    // A projection outlives the deploy that wrote it, so the read path
    // sanitizes handoff URLs as well as the projection builder.
    .map((role) => ({ ...role, officialApplyUrl: publicApplicationUrl(role.officialApplyUrl) }));
  if (!roles.length) return undefined;
  if (roles.length === details.roles.length) return { ...details, roles };
  return filterCatalogGroupDetails([{ ...details, roles }], {})[0];
}

async function projectedCatalogPage(store: InternshipStore, cursor: string | undefined, limit: number, filter: CatalogGroupFilter) {
  const isDefaultBrowse = filter.status === 'open' && Object.keys(filter).length === 1;
  if (!store.listCatalogProjection) return undefined;
  const scanLimit = isDefaultBrowse ? limit : Math.max(limit, 100);
  const groups = [];
  let next = cursor;
  do {
    const offset = Number(next ?? 0);
    const page = await store.listCatalogProjection(next, scanLimit);
    if (!page) return undefined;
    for (let index = 0; index < page.groups.length; index += 1) {
      const eligible = eligibleProjectedGroup(page.groups[index]!);
      const [match] = eligible ? filterCatalogGroupDetails([eligible], filter) : [];
      if (!match) continue;
      groups.push(match);
      if (groups.length === limit) {
        const consumed = offset + index + 1;
        const hasMore = index + 1 < page.groups.length || page.cursor !== undefined;
        return { groups, ...(hasMore ? { cursor: String(consumed) } : {}) };
      }
    }
    if (!page.cursor) return { groups };
    next = page.cursor;
  } while (next);
  return { groups };
}

function safeSession(session: ApplicationSession) {
  const safe: Partial<ApplicationSession> = { ...session };
  delete safe.userId;
  delete safe.handoff;
  delete safe.eventIds;
  return safe;
}

function applicationSummary(
  application: ApplicationRecord,
  job: Awaited<ReturnType<NonNullable<InternshipStore['getJob']>>>,
  identityUnconfirmedPublicationEnabled = true,
) {
  const availability = !job ? 'catalog-review' as const
    : !job.open ? 'closed' as const
      : catalogEligible(job) && identityPublished(job, identityUnconfirmedPublicationEnabled) ? 'available' as const : 'catalog-review' as const;
  return {
    ...application,
    ...(job ? {
      job: {
        jobId: job.jobId,
        company: job.company,
        title: job.title,
        location: job.location,
        season: job.season,
        open: job.open,
        ...(job.postingIdentityStatus ? { postingIdentityStatus: job.postingIdentityStatus } : {}),
        availability,
        ...(availability !== 'catalog-review' ? {
          applyUrl: publicApplicationUrl(job.applyUrl),
          assistance: assistanceAvailability(job, application.applyMode),
        } : {
          unavailableReason: job.postingIdentityStatus === 'unconfirmed' && !identityUnconfirmedPublicationEnabled
            ? 'Ntern verified the employer and application page, but is still reviewing this listing’s exact posting identity.'
            : 'Ntern couldn’t verify the official role page and is reviewing it.',
        }),
        sourceReferences: publicJob(job).sourceReferences.map(({ sourceId, sourceUrl, provenance, state }) => ({ sourceId, sourceUrl, provenance, state })),
      },
    } : { availability }),
  };
}

function parseFields(value: unknown): ApplicationFieldDraft[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('event.fields must contain at most 200 field plans');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each field plan must be an object');
    const field = item as Record<string, unknown>;
    if (typeof field.key !== 'string' || !field.key.trim() || field.key.length > 160 || typeof field.label !== 'string' || field.label.length > 300 || typeof field.required !== 'boolean' || typeof field.resolved !== 'boolean' || !['standard', 'sensitive', 'voluntary-self-identification'].includes(field.classification as string) || !['exact', 'inferred', 'unknown'].includes(field.confidence as string)) throw new Error('Field plan is invalid');
    if ('value' in field || 'rawValue' in field) throw new Error('Raw field values must not be persisted');
    const valueRef = field.valueRef;
    if (valueRef !== undefined && (!valueRef || typeof valueRef !== 'object' || Array.isArray(valueRef) || !['profile', 'reusable-answer', 'document', 'user'].includes((valueRef as Record<string, unknown>).source as string) || typeof (valueRef as Record<string, unknown>).key !== 'string')) throw new Error('Field value references are invalid');
    if (field.maskedPreview !== undefined && (typeof field.maskedPreview !== 'string' || field.maskedPreview.length > 200)) throw new Error('Field previews must be short masked strings');
    return {
      key: field.key,
      label: field.label,
      required: field.required,
      resolved: field.resolved,
      classification: field.classification as ApplicationFieldDraft['classification'],
      confidence: field.confidence as ApplicationFieldDraft['confidence'],
      ...(valueRef ? { valueRef: valueRef as ApplicationFieldDraft['valueRef'] } : {}),
      ...(typeof field.maskedPreview === 'string' ? { maskedPreview: field.maskedPreview } : {}),
    };
  });
}

function parseSessionEvent(value: unknown, userControlled: boolean): ApplicationSessionEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('event is required');
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'start': case 'cancel': return { type: event.type };
    case 'fill-completed': case 'answers-updated': return { type: event.type, fields: parseFields(event.fields) };
    case 'verification-required':
      if (!['captcha', 'mfa', 'email', 'identity', 'portal-login', 'other'].includes(event.reason as string)) throw new Error('Verification reason is invalid');
      return { type: 'verification-required', reason: event.reason as Extract<ApplicationSessionEvent, { type: 'verification-required' }>['reason'] };
    case 'fail':
      if (typeof event.message !== 'string' || !event.message.trim()) throw new Error('Failure message is required');
      return { type: 'fail', message: event.message };
    case 'review-approved':
      if (!userControlled) throw new Error('Review approval requires the signed-in user');
      return { type: 'review-approved', actor: 'user' };
    case 'verification-completed':
      if (!userControlled) throw new Error('Verification completion requires the signed-in user');
      return { type: 'verification-completed', actor: 'user' };
    case 'submission-confirmed':
      if (!userControlled) throw new Error('Submission confirmation requires the signed-in user');
      return { type: 'submission-confirmed', actor: 'user' };
    default: throw new Error('Application session event is not supported');
  }
}

function bearerFrom(event: ApiEvent) {
  const value = event.headers?.authorization ?? event.headers?.Authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice('Bearer '.length) : undefined;
}

function matchesHash(value: string, hash: string) {
  const left = Buffer.from(hashSecret(value)); const right = Buffer.from(hash);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function applySessionEvent(
  users: UserStore,
  session: ApplicationSession,
  body: Record<string, unknown>,
  timestamp: string,
  userControlled: boolean,
): Promise<{ statusCode: number; body: unknown }> {
  if (typeof body.eventId !== 'string' || !body.eventId.trim() || body.eventId.length > 160) throw new Error('eventId is required');
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) throw new Error('expectedVersion must be a non-negative integer');
  if (session.eventIds.includes(body.eventId)) return { statusCode: 200, body: { session: safeSession(session), replayed: true } };
  if (body.expectedVersion !== session.version) return { statusCode: 409, body: { message: 'Session version conflict', currentVersion: session.version } };
  if (!isBefore(timestamp, session.expiresAt)) return { statusCode: 410, body: { message: 'Application session expired' } };
  const event = parseSessionEvent(body.event, userControlled);
  const transitioned = transitionApplicationSession(session, event, timestamp);
  const updated: ApplicationSession = {
    ...transitioned,
    version: session.version + 1,
    eventIds: [...session.eventIds, body.eventId].slice(-100),
  };
  if (!await users.putApplicationSession(session.userId, updated, session.version)) return { statusCode: 409, body: { message: 'Session version conflict' } };
  if (updated.status === 'submitted') {
    const application = await users.getApplication(session.userId, session.applicationId);
    if (application && application.status === 'saved') {
      const dequeued = { ...application }; delete dequeued.queuedAt; await users.putApplication(session.userId, { ...dequeued, status: 'applied', updatedAt: timestamp });
    }
  }
  return { statusCode: 200, body: { session: safeSession(updated) } };
}

function pushPreferences(value: unknown): UserPreferences['push'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('push must be an object');
  const push = value as Record<string, unknown>; const template = (name: 'titleTemplate' | 'descriptionTemplate') => {
    const result = push[name]; if (result === undefined) return undefined;
    if (typeof result !== 'string' || result.length > 500) throw new Error(`push.${name} must be a string of at most 500 characters`);
    return result;
  };
  const titleTemplate = template('titleTemplate'); const descriptionTemplate = template('descriptionTemplate'); const aliases = push.roleAbbreviations;
  if (aliases !== undefined && (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.entries(aliases).some(([key, item]) => !key.trim() || typeof item !== 'string' || item.length > 40))) throw new Error('push.roleAbbreviations must map non-empty strings to short strings');
  return { ...(titleTemplate !== undefined ? { titleTemplate } : {}), ...(descriptionTemplate !== undefined ? { descriptionTemplate } : {}), ...(aliases ? { roleAbbreviations: aliases as Record<string, string> } : {}) };
}

function alertSettings(
  value: unknown,
  previous?: UserPreferences['alertSettings'],
): NonNullable<UserPreferences['alertSettings']> {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('alertSettings must be an object');
  }
  const settings = (value ?? {}) as Record<string, unknown>;
  const delivery = settings.delivery ?? previous?.delivery ?? 'immediate';
  if (delivery !== 'immediate' && delivery !== 'daily-digest') {
    throw new Error('alertSettings.delivery must be immediate or daily-digest');
  }
  const reminders = settings.applicationReminders ?? previous?.applicationReminders ?? true;
  if (typeof reminders !== 'boolean') throw new Error('alertSettings.applicationReminders must be a boolean');
  const followUpDays = settings.followUpDays ?? previous?.followUpDays ?? 7;
  if (typeof followUpDays !== 'number' || !Number.isInteger(followUpDays) || followUpDays < 1 || followUpDays > 30) {
    throw new Error('alertSettings.followUpDays must be a whole number from 1 to 30');
  }
  const quietHours = settings.quietHours ?? previous?.quietHours;
  const timezone = settings.timezone ?? previous?.timezone ?? (quietHours as { timezone?: unknown } | undefined)?.timezone;
  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || !timezone.trim() || timezone.length > 100) {
      throw new Error('alertSettings.timezone must be a timezone name');
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone.trim() }); }
    catch { throw new Error('alertSettings.timezone must be a valid IANA timezone'); }
  }
  if (settings.delivery === 'daily-digest' && timezone === undefined) {
    throw new Error('alertSettings.timezone is required for daily-digest delivery');
  }
  if (quietHours !== undefined) {
    if (!quietHours || typeof quietHours !== 'object' || Array.isArray(quietHours)) {
      throw new Error('alertSettings.quietHours must be an object');
    }
    const quiet = quietHours as Record<string, unknown>;
    if (
      typeof quiet.start !== 'string' ||
      typeof quiet.end !== 'string' ||
      typeof quiet.timezone !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.end) ||
      !quiet.timezone.trim() ||
      quiet.timezone.length > 100
    ) {
      throw new Error('alertSettings.quietHours needs start/end times (HH:MM) and a timezone');
    }
  }
  return {
    delivery,
    ...(timezone ? { timezone: timezone.trim() } : {}),
    applicationReminders: reminders,
    followUpDays,
    ...(quietHours ? { quietHours: quietHours as { start: string; end: string; timezone: string } } : {}),
  };
}

function applicationHandoff(
  value: unknown,
  previous?: UserPreferences['applicationHandoff'],
): NonNullable<UserPreferences['applicationHandoff']> {
  const handoff = value ?? previous ?? 'window';
  if (handoff !== 'window' && handoff !== 'tab') {
    throw new Error('applicationHandoff must be window or tab');
  }
  return handoff;
}

function requireProfile(value: Record<string, unknown>, userId: string): ApplicantProfile {
  const contact = value.contact as ApplicantProfile['contact'];
  if (!contact?.name || !contact.email || typeof value.location !== 'string' || typeof value.workAuthorization !== 'string' || !Array.isArray(value.education) || !value.links || !value.reusableAnswers) throw new Error('Profile needs contact name/email, location, work authorization, education, links, and reusable answers');
  if ((contact.firstName !== undefined && typeof contact.firstName !== 'string') || (contact.lastName !== undefined && typeof contact.lastName !== 'string') || (contact.phone !== undefined && typeof contact.phone !== 'string')) throw new Error('Profile contact details must be text');
  return { userId, contact, location: value.location, workAuthorization: value.workAuthorization, links: value.links as Record<string, string>, education: value.education as ApplicantProfile['education'], reusableAnswers: value.reusableAnswers as Record<string, string>, ...(typeof value.resumeDocumentId === 'string' ? { resumeDocumentId: value.resumeDocumentId } : {}), ...(value.sensitive && typeof value.sensitive === 'object' ? { sensitive: value.sensitive as Record<string, unknown> } : {}), updatedAt: now() };
}

export interface DocumentStorage {
  createUploadUrl(document: { userId: string; documentId: string; objectKey: string; contentType: string }): Promise<string>;
  createDownloadUrl(document: { userId: string; documentId: string; objectKey: string; contentType: string }): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}

export interface ApiDependencies {
  jobs: InternshipStore;
  users: UserStore;
  releases?: ReleaseStore;
  documentStorage?: DocumentStorage;
  deleteIdentity?: (userId: string) => Promise<void>;
  /** Revokes and deletes linked-provider data before the account record disappears. */
  beforeDeleteUser?: (userId: string) => Promise<void>;
  /** AWS document compatibility retained for rollback and export only. */
  documentsBucket?: string;
  integrations?: EmployerIntegrationRegistry;
  s3?: S3Client;
  now?: () => string;
  identityUnconfirmedPublicationEnabled?: boolean;
}
export function createApiHandler(dependencies: ApiDependencies) {
  const identityUnconfirmedPublicationEnabled = dependencies.identityUnconfirmedPublicationEnabled ?? true;
  const integrations = dependencies.integrations ?? new EmployerIntegrationRegistry();
  const documentStorage: DocumentStorage | undefined = dependencies.documentStorage ?? (dependencies.documentsBucket ? {
    async createUploadUrl(document) {
      const s3 = dependencies.s3 ?? new S3Client({});
      return getSignedUrl(s3, new PutObjectCommand({ Bucket: dependencies.documentsBucket, Key: document.objectKey, ContentType: document.contentType, ServerSideEncryption: 'aws:kms' }), { expiresIn: 300 });
    },
    async createDownloadUrl(document) {
      const s3 = dependencies.s3 ?? new S3Client({});
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: dependencies.documentsBucket, Key: document.objectKey }), { expiresIn: 300 });
    },
    async deleteObject(objectKey) {
      const s3 = dependencies.s3 ?? new S3Client({});
      await s3.send(new DeleteObjectCommand({ Bucket: dependencies.documentsBucket, Key: objectKey }));
    },
  } : undefined);
  return async (event: ApiEvent): Promise<ApiResponse> => {
    try {
      const method = event.requestContext?.http?.method ?? event.routeKey?.split(' ')[0] ?? 'GET'; const path = event.rawPath ?? event.routeKey?.split(' ')[1] ?? '/';
      if (method === 'OPTIONS') return reply(204, {});
      if (method === 'GET' && path === '/coverage') {
        const requestedLimit = Number(event.queryStringParameters?.limit ?? 50);
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 50;
        const requestedCursor = Number(event.queryStringParameters?.cursor ?? 0);
        const cursor = Number.isFinite(requestedCursor) ? Math.max(Math.trunc(requestedCursor), 0) : 0;
        const query = (event.queryStringParameters?.q ?? '').trim().toLowerCase();
        const state = event.queryStringParameters?.state;
        const allowedStates = ['direct-published', 'direct-shadow', 'feed-observed', 'candidate-only'];
        if (state && !allowedStates.includes(state)) return reply(400, { message: 'state is not supported' });
        const matching = companyCoverage.companies.filter((company) =>
          (!query || company.displayName.toLowerCase().includes(query))
          && (!state || company.coverageState === state),
        );
        const companies = matching.slice(cursor, cursor + limit);
        const nextOffset = cursor + companies.length;
        return reply(200, {
          generatedAt: companyCoverage.generatedAt,
          methodology: companyCoverage.methodology,
          counts: companyCoverage.counts,
          matchedCompanies: matching.length,
          companies,
          ...(nextOffset < matching.length ? { nextCursor: String(nextOffset) } : {}),
        });
      }
      if (method === 'GET' && path === '/jobs') {
        const requestedLimit = Number(event.queryStringParameters?.limit ?? 25);
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50) : 25;
        const status = event.queryStringParameters?.status ?? 'open';
        if (status !== 'open' && status !== 'closed') return reply(400, { message: 'status must be open or closed' });
        const query = event.queryStringParameters?.q?.trim();
        if (query && query.length > 120) return reply(400, { message: 'q must be 120 characters or fewer' });
        const source = event.queryStringParameters?.source;
        if (source && !['all', 'direct', 'community', 'corroborated'].includes(source)) return reply(400, { message: 'source is not supported' });
        const page = await jobsPage(dependencies.jobs, event.queryStringParameters?.cursor, limit, status, { ...(query ? { query } : {}), ...(source ? { source: source as 'all' | 'direct' | 'community' | 'corroborated' } : {}) }, identityUnconfirmedPublicationEnabled);
        return reply(200, { ...page, jobs: page.jobs.map(publicJob) });
      }
      if (method === 'GET' && path === '/catalog') {
        const requestedLimit = Number(event.queryStringParameters?.limit ?? 25);
        const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50) : 25;
        const cursor = event.queryStringParameters?.cursor;
        const status = event.queryStringParameters?.status;
        if (status && status !== 'open' && status !== 'closed') return reply(400, { message: 'status must be open or closed' });
        const query = event.queryStringParameters?.q?.trim();
        if (query && query.length > 120) return reply(400, { message: 'q must be 120 characters or fewer' });
        const source = event.queryStringParameters?.source;
        if (source && !['all', 'direct', 'community', 'corroborated'].includes(source)) return reply(400, { message: 'source is not supported' });
        const filter = {
          ...catalogFilter(event.queryStringParameters),
          ...(!identityUnconfirmedPublicationEnabled ? { postingIdentityConfirmedOnly: true } : {}),
        };
        const requestedOffset = Number(cursor ?? 0);
        if (!Number.isFinite(requestedOffset) || requestedOffset < 0 || !Number.isInteger(requestedOffset)) return reply(400, { message: 'cursor is invalid' });
        const projected = await projectedCatalogPage(dependencies.jobs, cursor, limit, filter);
        if (projected) return reply(200, { groups: projected.groups.map((group) => group.group), ...(projected.cursor ? { cursor: projected.cursor } : {}) });
        const grouped = filterCatalogGroups(groupCatalogJobs(await completeCatalog(dependencies.jobs, identityUnconfirmedPublicationEnabled), { includeClosed: true }), filter);
        const page = grouped.slice(requestedOffset, requestedOffset + limit).map((group) => group.row);
        const nextOffset = requestedOffset + page.length;
        return reply(200, { groups: page, ...(nextOffset < grouped.length ? { cursor: String(nextOffset) } : {}) });
      }
      const catalogGroupMatch = path.match(/^\/catalog\/groups\/([^/]+)$/);
      if (method === 'GET' && catalogGroupMatch) {
        const status = event.queryStringParameters?.status;
        if (status && status !== 'open' && status !== 'closed') return reply(400, { message: 'status must be open or closed' });
        const groupId = decodeURIComponent(catalogGroupMatch[1]!);
        const projected = await dependencies.jobs.getCatalogProjectionGroup?.(groupId);
        if (projected) {
          const eligible = eligibleProjectedGroup(projected);
          const filtered = eligible ? filterCatalogGroupDetails([eligible], {
            ...catalogFilter(event.queryStringParameters),
            ...(!identityUnconfirmedPublicationEnabled ? { postingIdentityConfirmedOnly: true } : {}),
          })[0] : undefined;
          return filtered ? reply(200, filtered) : reply(404, { message: 'Catalog group not found' });
        }
        const group = groupCatalogJobs(await completeCatalog(dependencies.jobs, identityUnconfirmedPublicationEnabled), { includeClosed: true }).find((candidate) => candidate.row.groupId === groupId);
        const filtered = group && filterCatalogGroupDetails([catalogGroupDetails(group)], {
          ...catalogFilter(event.queryStringParameters),
          ...(!identityUnconfirmedPublicationEnabled ? { postingIdentityConfirmedOnly: true } : {}),
        })[0];
        return filtered ? reply(200, filtered) : reply(404, { message: 'Catalog group not found' });
      }
      const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
      if (method === 'GET' && jobMatch) {
        const job = await dependencies.jobs.getJob?.(decodeURIComponent(jobMatch[1]));
        return job && catalogEligible(job) && identityPublished(job, identityUnconfirmedPublicationEnabled)
          ? reply(200, { ...publicJob(job), assistance: assistanceAvailability(job) })
          : reply(404, { message: 'Job not found' });
      }
      if (method === 'POST' && path === '/assist/exchange') {
        const body = parseBody(event);
        if (typeof body.sessionId !== 'string' || typeof body.code !== 'string') return reply(400, { message: 'sessionId and code are required' });
        const session = await dependencies.users.getApplicationSessionById(body.sessionId);
        const timestamp = dependencies.now?.() ?? now();
        if (!session?.handoff || session.handoff.consumedAt || !isBefore(timestamp, session.handoff.codeExpiresAt) || !matchesHash(body.code, session.handoff.codeHash)) return reply(401, { message: 'Handoff code is invalid or expired' });
        const bearer = `${session.sessionId}.${randomBytes(32).toString('base64url')}`;
        const bearerExpiresAt = inMinutes(timestamp, 5);
        const updated: ApplicationSession = {
          ...session,
          version: session.version + 1,
          updatedAt: timestamp,
          handoff: { ...session.handoff, consumedAt: timestamp, bearerHash: hashSecret(bearer), bearerExpiresAt },
        };
        if (!await dependencies.users.putApplicationSession(session.userId, updated, session.version)) return reply(409, { message: 'Session changed; retry the exchange' });
        return reply(200, { bearer, expiresAt: bearerExpiresAt, session: safeSession(updated) });
      }
      if ((method === 'GET' && path === '/assist/session') || (method === 'POST' && path === '/assist/session/events')) {
        const bearer = bearerFrom(event);
        const [sessionId] = bearer?.split('.', 2) ?? [];
        if (!bearer || !sessionId) return reply(401, { message: 'A session bearer is required' });
        const session = await dependencies.users.getApplicationSessionById(sessionId);
        const timestamp = dependencies.now?.() ?? now();
        if (!session?.handoff?.bearerHash || !session.handoff.bearerExpiresAt || !isBefore(timestamp, session.handoff.bearerExpiresAt) || !matchesHash(bearer, session.handoff.bearerHash)) return reply(401, { message: 'Session bearer is invalid or expired' });
        if (method === 'GET') return reply(200, { session: safeSession(session) });
        const body = parseBody(event);
        const result = await applySessionEvent(dependencies.users, session, body, timestamp, false);
        return reply(result.statusCode, result.body);
      }
      const userId = identity(event); if (!userId) return reply(401, { message: 'Authentication required' });
      const deletingAccount = method === 'DELETE' && path === '/me';
      if (!deletingAccount && method !== 'GET' && method !== 'HEAD' && await dependencies.users.isUserDeletionPending(userId)) {
        return reply(409, { code: 'ACCOUNT_DELETION_IN_PROGRESS', retryable: false, message: 'Account deletion is already in progress. Finish or retry deletion before changing account data.' });
      }
      const releaseMatch = path.match(/^\/me\/releases\/([^/]+)$/);
      if (method === 'GET' && releaseMatch) {
        const releaseId = decodeURIComponent(releaseMatch[1]!);
        const release = await dependencies.releases?.getRelease(userId, releaseId);
        if (!release) return reply(404, { message: 'Release not found' });
        const jobs = (await Promise.all(release.jobIds.map((jobId) => dependencies.jobs.getJob(jobId))))
          .filter((job): job is NonNullable<typeof job> => Boolean(job)
            && catalogEligible(job!)
            && identityPublished(job!, identityUnconfirmedPublicationEnabled));
        const visibleJobIds = new Set(jobs.map((job) => job.jobId));
        return reply(200, {
          releaseId: release.releaseId,
          createdAt: release.createdAt,
          newJobIds: release.newJobIds.filter((jobId) => visibleJobIds.has(jobId)),
          deepLink: `internnotifs://releases/${encodeURIComponent(release.releaseId)}`,
          // Mobile clients render the complete role list directly; grouped
          // metadata remains alongside it for collapsed release summaries.
          jobs: jobs.map(publicJob),
          groups: groupCatalogJobs(jobs, { includeClosed: true }).map(catalogGroupDetails),
        });
      }
      if (method === 'GET' && path === '/me/preferences') return reply(200, (await dependencies.users.getPreferences(userId)) ?? { userId, filter: {}, alertsEnabled: false, onboardingComplete: false });
      if (method === 'PUT' && path === '/me/preferences') { const body = parseBody(event); const previous = await dependencies.users.getPreferences(userId); const filter = parseJobFilter(body.filter ?? previous?.filter ?? {}); const push = pushPreferences(body.push); const value: UserPreferences = { userId, filter: filter ?? {}, alertsEnabled: typeof body.alertsEnabled === 'boolean' ? body.alertsEnabled : previous?.alertsEnabled ?? false, emailAlertsEnabled: typeof body.emailAlertsEnabled === 'boolean' ? body.emailAlertsEnabled : previous?.emailAlertsEnabled ?? false, onboardingComplete: typeof body.onboardingComplete === 'boolean' ? body.onboardingComplete : previous?.onboardingComplete ?? false, applicationHandoff: applicationHandoff(body.applicationHandoff, previous?.applicationHandoff), alertSettings: alertSettings(body.alertSettings, previous?.alertSettings), ...(push !== undefined ? { push } : previous?.push ? { push: previous.push } : {}), ...(previous?.lastCatalogOpenedAt ? { lastCatalogOpenedAt: previous.lastCatalogOpenedAt } : {}), updatedAt: now() }; await dependencies.users.putPreferences(value); return reply(200, value); }
      if (method === 'POST' && path === '/me/opening') {
        const openedAt = dependencies.now?.() ?? now();
        const previous = await dependencies.users.getPreferences(userId);
        const previousOpenedAt = previous?.lastCatalogOpenedAt;
        const preferences: UserPreferences = {
          userId,
          filter: previous?.filter ?? {},
          alertsEnabled: previous?.alertsEnabled ?? false,
          emailAlertsEnabled: previous?.emailAlertsEnabled ?? false,
          onboardingComplete: previous?.onboardingComplete ?? false,
          ...(previous?.applicationHandoff ? { applicationHandoff: previous.applicationHandoff } : {}),
          ...(previous?.alertSettings ? { alertSettings: previous.alertSettings } : {}),
          ...(previous?.push ? { push: previous.push } : {}),
          lastCatalogOpenedAt: openedAt,
          // Opening the catalog is not a preference edit, so preserve the
          // existing preference timestamp when one exists.
          updatedAt: previous?.updatedAt ?? openedAt,
        };
        // The first launch establishes a baseline. This avoids presenting an
        // unbounded historical backlog when the feature rolls out.
        if (!previousOpenedAt) {
          await dependencies.users.putPreferences(preferences);
          return reply(200, { jobs: [], groups: [], total: 0, hasMore: false, previousOpenedAt: null, openedAt });
        }
        const matches = (await dependencies.jobs.listOpenSince(previousOpenedAt, openedAt))
          .filter((job) => identityPublished(job, identityUnconfirmedPublicationEnabled)
            && matchesJobFilter(job, previous?.filter));
        // Keep launch fast if a source backfills many records; the Feed remains
        // the complete catalog and provides the explicit path to the remainder.
        const limit = 50;
        await dependencies.users.putPreferences(preferences);
        const visible = matches.slice(0, limit);
        return reply(200, { jobs: visible.map(publicJob), groups: groupCatalogJobs(visible).map(catalogGroupDetails), total: matches.length, hasMore: matches.length > limit, previousOpenedAt, openedAt });
      }
      if (method === 'POST' && path === '/me/devices') { const body = parseBody(event); if (typeof body.token !== 'string' || !body.token.startsWith('ExponentPushToken[') || (body.platform !== 'ios' && body.platform !== 'android')) return reply(400, { message: 'A valid Expo token and platform are required' }); const value: DeviceToken = { userId, token: body.token, platform: body.platform, active: true, createdAt: now(), updatedAt: now() }; await dependencies.users.putDevice(value); return reply(201, value); }
      if (method === 'DELETE' && path.startsWith('/me/devices/')) { await dependencies.users.deleteDevice(userId, decodeURIComponent(path.slice('/me/devices/'.length))); return reply(204, {}); }
      if (method === 'GET' && path === '/me/profile') return reply(200, (await dependencies.users.getProfile(userId)) ?? null);
      if (method === 'PUT' && path === '/me/profile') { const profile = requireProfile(parseBody(event), userId); await dependencies.users.putProfile(profile); return reply(200, profile); }
      if (method === 'GET' && path === '/me/export') {
        const [profile, applications, documents] = await Promise.all([
          dependencies.users.getProfile(userId),
          dependencies.users.listApplications(userId),
          dependencies.users.listDocuments(userId),
        ]);
        const exported: AccountDataExport = {
          schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
          exportedAt: dependencies.now?.() ?? now(),
          account: {
            profile: profile ?? null,
            applications,
            documents: documents.map(({ documentId, fileName, contentType, createdAt }) => ({ documentId, fileName, contentType, createdAt })),
          },
        };
        return reply(200, exported);
      }
      if (method === 'GET' && path === '/me/applications') {
        const requestedStatus = event.queryStringParameters?.status;
        if (requestedStatus !== undefined && !statuses.includes(requestedStatus as ApplicationStatus)) return reply(400, { message: `status must be one of ${statuses.join(', ')}` });
        const requestedQueued = event.queryStringParameters?.queued;
        if (requestedQueued !== undefined && requestedQueued !== 'true' && requestedQueued !== 'false') return reply(400, { message: 'queued must be true or false' });
        const applications = (await dependencies.users.listApplications(userId)).filter((application) =>
          (!requestedStatus || application.status === requestedStatus) &&
          (requestedQueued === undefined || (requestedQueued === 'true'
            ? application.status === 'saved' && application.queuedAt !== undefined
            : !(application.status === 'saved' && application.queuedAt !== undefined))));
        const summaries = await Promise.all(applications.map(async (application) => {
          const job = await dependencies.jobs.getJob?.(application.jobId);
          return applicationSummary(application, job, identityUnconfirmedPublicationEnabled);
        }));
        return reply(200, { applications: summaries });
      }
      if (method === 'POST' && path === '/me/applications') {
        const body = parseBody(event); if (typeof body.jobId !== 'string') return reply(400, { message: 'jobId is required' });
        const job = await dependencies.jobs.getJob?.(body.jobId);
        if (!job || !catalogEligible(job) || !identityPublished(job, identityUnconfirmedPublicationEnabled)) return reply(404, { message: 'Job not found' });
        if (body.queued !== undefined && typeof body.queued !== 'boolean') return reply(400, { message: 'queued must be a boolean' });
        const timestamp = now(); const existing = (await dependencies.users.listApplications(userId)).find((application) => application.jobId === job.jobId);
        const status = statuses.includes(body.status as ApplicationStatus) ? body.status as ApplicationStatus : existing?.status ?? 'saved';
        const queued = body.queued ?? true;
        const application: ApplicationRecord = {
          applicationId: existing?.applicationId ?? randomUUID(), jobId: job.jobId, status,
          ...(existing?.appliedAt ? { appliedAt: existing.appliedAt } : status === 'applied' ? { appliedAt: timestamp } : {}),
          ...(existing?.detection ? { detection: existing.detection } : {}),
          ...(status === 'saved' && queued ? { queuedAt: existing?.queuedAt ?? timestamp } : {}),
          notes: typeof body.notes === 'string' ? body.notes.slice(0, 5000) : existing?.notes,
          applyMode: integrations.applyMode(job), createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
        };
        await dependencies.users.putApplication(userId, application);
        return reply(existing ? 200 : 201, {
          ...applicationSummary(application, job, identityUnconfirmedPublicationEnabled),
          officialApplyUrl: application.applyMode === 'official-form' ? publicApplicationUrl(job.applyUrl) : undefined,
        });
      }
      const appMatch = path.match(/^\/me\/applications\/([^/]+)$/);
      if (method === 'PATCH' && appMatch) {
        const current = await dependencies.users.getApplication(userId, decodeURIComponent(appMatch[1]));
        if (!current) return reply(404, { message: 'Application not found' });
        const body = parseBody(event);
        if (body.status !== undefined && !statuses.includes(body.status as ApplicationStatus)) return reply(400, { message: `status must be one of ${statuses.join(', ')}` });
        if (body.queued !== undefined && typeof body.queued !== 'boolean') return reply(400, { message: 'queued must be a boolean' });
        const timestamp = now();
        const nextStatus = (body.status ? body.status as ApplicationStatus : current.status);
        if (body.queued === true && (current.status !== 'saved' || nextStatus !== 'saved')) return reply(409, { message: 'Only roles to apply to can queue' });
        const updated: ApplicationRecord = { ...current, ...(body.status ? { status: body.status as ApplicationStatus } : {}), ...(!current.appliedAt && body.status === 'applied' ? { appliedAt: timestamp } : {}), ...(typeof body.notes === 'string' ? { notes: body.notes.slice(0, 5000) } : {}), updatedAt: timestamp };
        if (nextStatus !== 'saved') delete updated.queuedAt;
        else if (body.queued === true) updated.queuedAt = current.queuedAt ?? timestamp;
        else if (body.queued === false) delete updated.queuedAt;
        await dependencies.users.putApplication(userId, updated);
        const job = await dependencies.jobs.getJob?.(updated.jobId);
        return reply(200, applicationSummary(updated, job, identityUnconfirmedPublicationEnabled));
      }
      if (method === 'DELETE' && appMatch) { const current = await dependencies.users.getApplication(userId, decodeURIComponent(appMatch[1]!)); if (!current) return reply(404, { message: 'Application not found' }); if (current.status !== 'saved') return reply(409, { message: 'Only saved roles can be unsaved' }); await dependencies.users.deleteApplication(userId, current.applicationId); return reply(204, {}); }
      const applicationSessionMatch = path.match(/^\/me\/applications\/([^/]+)\/assistance-sessions$/);
      if (method === 'POST' && applicationSessionMatch) {
        const application = await dependencies.users.getApplication(userId, decodeURIComponent(applicationSessionMatch[1]));
        if (!application) return reply(404, { message: 'Application not found' });
        if (application.status !== 'saved') return reply(409, { message: 'Only To Apply roles can start assistance' });
        const job = await dependencies.jobs.getJob?.(application.jobId);
        if (!job) return reply(404, { message: 'Job not found' });
        if (!catalogEligible(job) || !identityPublished(job, identityUnconfirmedPublicationEnabled)) {
          return reply(409, { message: 'Assistance is unavailable while Ntern reviews the official role page' });
        }
        const body = parseBody(event);
        if (body.mode !== 'headed' && body.mode !== 'headless') return reply(400, { message: 'mode must be headed or headless' });
        const availability = assistanceAvailability(job, application.applyMode);
        if ((body.mode === 'headed' && availability.eligibility !== 'headed-supported') || (body.mode === 'headless' && availability.eligibility !== 'remote-supported')) {
          return reply(409, { message: 'Assistance is not available for this destination', assistance: availability });
        }
        const timestamp = dependencies.now?.() ?? now();
        const session = createApplicationSession({ sessionId: randomUUID(), userId, applicationId: application.applicationId, jobId: job.jobId, mode: body.mode, now: timestamp });
        const code = `${session.sessionId}.${randomBytes(32).toString('base64url')}`;
        session.handoff = { codeHash: hashSecret(code), codeExpiresAt: inMinutes(timestamp, 1) };
        if (!await dependencies.users.putApplicationSession(userId, session)) return reply(409, { message: 'Could not create application session; retry' });
        return reply(201, { session: safeSession(session), handoff: { sessionId: session.sessionId, code, expiresAt: inMinutes(timestamp, 1) } });
      }
      const sessionMatch = path.match(/^\/me\/application-sessions\/([^/]+)$/);
      if (method === 'GET' && sessionMatch) {
        const session = await dependencies.users.getApplicationSession(userId, decodeURIComponent(sessionMatch[1]));
        return session ? reply(200, { session: safeSession(session) }) : reply(404, { message: 'Application session not found' });
      }
      const sessionEventsMatch = path.match(/^\/me\/application-sessions\/([^/]+)\/events$/);
      if (method === 'POST' && sessionEventsMatch) {
        const session = await dependencies.users.getApplicationSession(userId, decodeURIComponent(sessionEventsMatch[1]));
        if (!session) return reply(404, { message: 'Application session not found' });
        const result = await applySessionEvent(dependencies.users, session, parseBody(event), dependencies.now?.() ?? now(), true);
        return reply(result.statusCode, result.body);
      }
      const sessionCancelMatch = path.match(/^\/me\/application-sessions\/([^/]+)\/cancel$/);
      if (method === 'POST' && sessionCancelMatch) {
        const session = await dependencies.users.getApplicationSession(userId, decodeURIComponent(sessionCancelMatch[1]));
        if (!session) return reply(404, { message: 'Application session not found' });
        const body = parseBody(event);
        const result = await applySessionEvent(dependencies.users, session, { ...body, event: { type: 'cancel' } }, dependencies.now?.() ?? now(), true);
        return reply(result.statusCode, result.body);
      }
      if (method === 'GET' && path === '/me/documents') return reply(200, { documents: await dependencies.users.listDocuments(userId) });
      if (method === 'POST' && path === '/me/documents') { if (!documentStorage) return reply(503, { message: 'Document storage is unavailable' }); const body = parseBody(event); if (typeof body.fileName !== 'string' || typeof body.contentType !== 'string') return reply(400, { message: 'fileName and contentType are required' }); const documentId = randomUUID(); const objectKey = `private/${userId}/${documentId}`; const document = { userId, documentId, fileName: body.fileName.slice(0, 255), contentType: body.contentType, objectKey, createdAt: now() }; const uploadUrl = await documentStorage.createUploadUrl(document); await dependencies.users.putDocument(document); return reply(201, { document, uploadUrl }); }
      const docMatch = path.match(/^\/me\/documents\/([^/]+)$/);
      if (method === 'GET' && docMatch) { if (!documentStorage) return reply(503, { message: 'Document storage is unavailable' }); const document = (await dependencies.users.listDocuments(userId)).find((item) => item.documentId === decodeURIComponent(docMatch[1])); if (!document) return reply(404, { message: 'Document not found' }); return reply(200, { document, downloadUrl: await documentStorage.createDownloadUrl(document) }); }
      if (method === 'DELETE' && docMatch) { const document = (await dependencies.users.listDocuments(userId)).find((item) => item.documentId === decodeURIComponent(docMatch[1])); if (!document) return reply(404, { message: 'Document not found' }); if (documentStorage) await documentStorage.deleteObject(document.objectKey); await dependencies.users.deleteDocument(userId, document.documentId); return reply(204, {}); }
      if (method === 'DELETE' && path === '/me') {
        if (!dependencies.deleteIdentity) {
          return reply(503, { code: 'ACCOUNT_DELETION_UNAVAILABLE', retryable: false, message: 'Account deletion is unavailable on this retired service. Update Ntern and try again.' });
        }
        let documents: Awaited<ReturnType<UserStore['listDocuments']>>;
        let activeDocumentUploads: boolean;
        try {
          await dependencies.users.beginUserDeletion(userId);
          [documents, activeDocumentUploads] = await Promise.all([
            dependencies.users.listDocuments(userId),
            dependencies.users.hasActiveDocumentUploads(userId),
          ]);
        } catch {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'account-data', retryable: true, message: 'Account deletion could not be prepared. Your account data and sign-in were kept so you can retry.' });
        }
        if (activeDocumentUploads) {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'document-storage', retryable: true, message: 'A document upload is still finishing. Your account data and sign-in were kept so you can retry deletion.' });
        }
        if (documents.length > 0 && !documentStorage) {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'document-storage', retryable: true, message: 'Document storage is unavailable. Your account data and sign-in were kept so you can retry.' });
        }
        try {
          if (documentStorage) await Promise.all(documents.map((document) => documentStorage.deleteObject(document.objectKey)));
        } catch {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'document-storage', retryable: true, message: 'Account deletion is incomplete. Your document records and sign-in are still available so you can retry.' });
        }
        try {
          await dependencies.beforeDeleteUser?.(userId);
          await dependencies.users.deleteUser(userId);
        } catch {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'account-data', retryable: true, message: 'Document cleanup finished, but account data could not be fully deleted. Please retry.' });
        }
        try {
          await dependencies.deleteIdentity(userId);
        } catch (error) {
          if ((error as { name?: string }).name !== 'UserNotFoundException') {
            return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'identity', retryable: true, message: 'Your account data was deleted, but sign-in cleanup is incomplete. Please retry while you are still signed in.' });
          }
        }
        return reply(204, {});
      }
      return reply(404, { message: 'Not found', supportedCategories: jobCategories });
    } catch (error) { return reply(400, { message: error instanceof Error ? error.message : 'Invalid request' }); }
  };
}

export const handler = createApiHandler({
  jobs: new DynamoInternshipStore(process.env.INTERNSHIPS_TABLE ?? ''),
  users: new DynamoUserStore(process.env.USERS_TABLE ?? ''),
  releases: new DynamoReleaseStore(process.env.USERS_TABLE ?? ''),
  documentsBucket: process.env.DOCUMENTS_BUCKET,
  identityUnconfirmedPublicationEnabled: process.env.IDENTITY_UNCONFIRMED_PUBLICATION_ENABLED === 'true',
});
