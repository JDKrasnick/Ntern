import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isEducationLevel, jobCategories, matchesJobFilter, parseJobFilter } from './core/filters.js';
import { type InternshipStore, type ReleaseStore, type UserStore } from './store.js';
import { ACCOUNT_EXPORT_SCHEMA_VERSION, type AccountDataExport, type ApplicantProfile, type ApplicationRecord, type ApplicationStatus, type DeviceToken, type Internship, type OccurrenceProvenance, type UserPreferences } from './types.js';
import { EmployerIntegrationRegistry } from './providers.js';
import { assistanceAvailability } from './application-assistance.js';
import { createApplicationSession, transitionApplicationSession, type ApplicationFieldDraft, type ApplicationSession, type ApplicationSessionEvent } from './application-automation.js';
import { companyCoverage } from '../coverage/summary.js';
import { catalogGroupDetails, employerDropDay, filterCatalogGroupDetails, filterCatalogGroups, groupCatalogJobs, materializedReleaseDay,
  type CatalogGroupDetails, type CatalogGroupFilter } from './catalog-groups.js';
import { dayZone, isCalendarDay } from '../shared/zone-day.js';
import { publicApplicationUrl } from './core/application-url.js';
import { occurrenceProvenance } from './sources/provenance.js';
import { catalogEligible, deriveCanonicalAdmission } from './catalog-admission.js';
import { normalizeResumeJobUrl, recommendResumeProfiles, type ImportedJob, type ResumeBankItem, type ResumeChange, type ResumeDraft, type ResumeProfile, type ResumeTemplateId } from './resume.js';
import { extractResumeDocument, type ExtractedResumeItem } from './resume-document.js';
import { RESUME_COMPILER_VERSION, RESUME_TEMPLATE_VERSION, renderResumeLatex } from './resume-latex.js';

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
    ...(isEducationLevel(parameters?.educationLevel) ? { educationLevel: parameters.educationLevel } : {}),
    ...(parameters?.hasCompensation === 'true' ? { hasCompensation: true } : {}),
    ...(list('discipline', 'disciplines')?.length ? { disciplines: list('discipline', 'disciplines') } : {}),
    ...(list('season', 'seasons')?.length ? { seasons: list('season', 'seasons') } : {}),
    ...(list('education', 'educationLevels')?.length ? { educationLevels: list('education', 'educationLevels') } : {}),
    ...(list('workMode', 'workModes')?.length ? { workModes: list('workMode', 'workModes') } : {}),
    ...(list('location', 'locations')?.length ? { locations: list('location', 'locations') } : {}),
    ...(isCalendarDay(parameters?.day) ? { day: parameters!.day, dayZone: dayZone(parameters?.dayZone) } : {}),
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
  if (!isDefaultBrowse && store.listCatalogProjectionFiltered) {
    // A filtered or searched request reads the matching groups in SQL instead of
    // walking every group in the projection in JS. A sparse query used to read the
    // whole catalog to find its matches, which a large employer card makes
    // untenable; the eligibility re-check (a projection outlives the deploy that
    // wrote it) still runs on what comes back, and a page whose groups all drop is
    // followed by at most a few more rather than ending the feed early.
    let next = cursor;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const page = await store.listCatalogProjectionFiltered(next, limit, filter);
      if (!page) return undefined;
      const groups = page.groups.flatMap((details) => {
        const eligible = eligibleProjectedGroup(details);
        return eligible ? filterCatalogGroupDetails([eligible], filter) : [];
      });
      if (groups.length || !page.cursor) return { groups, ...(page.cursor ? { cursor: page.cursor } : {}) };
      next = page.cursor;
    }
    return { groups: [] };
  }
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
  readContent?(document: { userId: string; documentId: string; objectKey: string; contentType: string }): Promise<ArrayBuffer>;
}

export interface ResumeImportQueue {
  send(message: { userId: string; importId: string; canonicalUrl: string }): Promise<void>;
}

/** Shared, public-job cache only. It never exposes another user's résumé data. */
export interface ResumeImportCache {
  get(canonicalUrl: string): Promise<Pick<ImportedJob, 'canonicalUrl' | 'title' | 'company' | 'description' | 'contentHash'> | undefined>;
}

export interface ResumeArtifactStorage {
  putTex(objectKey: string, tex: string): Promise<void>;
  createContentUrl(artifact: { userId: string; artifactId: string; objectKey: string }): Promise<string>;
}

export interface ApiDependencies {
  jobs: InternshipStore;
  users: UserStore;
  releases?: ReleaseStore;
  documentStorage?: DocumentStorage;
  resumeImportQueue?: ResumeImportQueue;
  resumeImportCache?: ResumeImportCache;
  resumeDocumentExtractor?: (bytes: ArrayBuffer, contentType: string) => Promise<ExtractedResumeItem[]>;
  resumeArtifactStorage?: ResumeArtifactStorage;
  deleteIdentity?: (userId: string) => Promise<void>;
  /** Revokes and deletes linked-provider data before the account record disappears. */
  beforeDeleteUser?: (userId: string) => Promise<void>;
  integrations?: EmployerIntegrationRegistry;
  now?: () => string;
  identityUnconfirmedPublicationEnabled?: boolean;
  /** Default-disabled because résumé records are sensitive private data. */
  resumeTunerEnabled?: boolean;
}

const resumeKinds = new Set<ResumeBankItem['kind']>(['role', 'project', 'skill', 'education', 'bullet']);
const resumeTemplates = new Set<ResumeTemplateId>(['jake-technical', 'clean-standard', 'research-academic', 'project-compact']);
function resumeText(value: unknown, field: string, max = 8_000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${field} must be non-empty text up to ${max} characters`);
  return value.trim();
}
function resumeStrings(value: unknown, field: string, limit = 24): string[] {
  if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 160)) throw new Error(`${field} must be a short text list`);
  return value.map((item) => item.trim());
}
function resumeDraftChanges(job: ImportedJob, bankItems: ResumeBankItem[]): ResumeChange[] {
  const jobWords = new Set(job.description.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/gu) ?? []);
  return bankItems.filter((item) => item.verified).flatMap((item) => {
    const matched = (item.content.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/gu) ?? []).filter((word) => jobWords.has(word));
    if (!matched.length) return [];
    return [{ changeId: randomUUID(), type: 'add' as const, section: item.kind === 'skill' ? 'Skills' : 'Selected experience', suggestion: item.content, evidenceIds: [item.bankItemId], reason: `Matches job language: ${[...new Set(matched)].slice(0, 3).join(', ')}.` }];
  }).slice(0, 12);
}
export function createApiHandler(dependencies: ApiDependencies) {
  const identityUnconfirmedPublicationEnabled = dependencies.identityUnconfirmedPublicationEnabled ?? true;
  const integrations = dependencies.integrations ?? new EmployerIntegrationRegistry();
  const documentStorage = dependencies.documentStorage;
  const resumeTunerEnabled = dependencies.resumeTunerEnabled === true;
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
      if (method === 'GET' && path === '/catalog/days') {
        const from = event.queryStringParameters?.from;
        const to = event.queryStringParameters?.to;
        if ((from && !isCalendarDay(from)) || (to && !isCalendarDay(to))) return reply(400, { message: 'from and to must be YYYY-MM-DD' });
        const zone = dayZone(event.queryStringParameters?.dayZone);
        // The index describes every release day, so it never applies the day filter
        // it exists to offer; every other facet still narrows what it counts.
        const filter = {
          ...catalogFilter(event.queryStringParameters),
          ...(!identityUnconfirmedPublicationEnabled ? { postingIdentityConfirmedOnly: true } : {}),
        };
        delete filter.day;
        const days = new Map<string, { day: string; roles: number; employers: Set<string> }>();
        const count = (day: string | undefined, company: string) => {
          if (!day || (from && day < from) || (to && day > to)) return;
          const entry = days.get(day) ?? { day, roles: 0, employers: new Set<string>() };
          entry.roles += 1;
          entry.employers.add(company);
          days.set(day, entry);
        };
        const projectedRoles = await dependencies.jobs.listCatalogProjectionRoles?.(filter, { from, to });
        if (projectedRoles) {
          for (const role of projectedRoles) {
            if (!catalogEligible({ admission: deriveCanonicalAdmission(role.sourceReferences, new Date().toISOString()) })) continue;
            count(materializedReleaseDay(role, zone), role.company);
          }
        } else {
          const groups = filterCatalogGroups(
            groupCatalogJobs(await completeCatalog(dependencies.jobs, identityUnconfirmedPublicationEnabled), { includeClosed: true }),
            filter,
          );
          for (const group of groups) {
            for (const job of group.jobs) count(employerDropDay(job, zone), job.company);
          }
        }
        return reply(200, {
          zone,
          days: [...days.values()]
            .sort((left, right) => left.day.localeCompare(right.day))
            .map(({ day, roles, employers }) => ({ day, roles, employers: employers.size })),
        });
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
      if (path.startsWith('/me/resume-')) {
        if (!resumeTunerEnabled) return reply(404, { message: 'Resume tailoring is not enabled' });
        const timestamp = dependencies.now?.() ?? now();
        if (path === '/me/resume-bank') {
          if (method === 'GET') return reply(200, { items: await dependencies.users.listResumeBank(userId) });
          if (method === 'POST') {
            const body = parseBody(event);
            if (!resumeKinds.has(body.kind as ResumeBankItem['kind'])) return reply(400, { message: 'kind is not supported' });
            const item: ResumeBankItem = {
              userId, bankItemId: randomUUID(), kind: body.kind as ResumeBankItem['kind'], content: resumeText(body.content, 'content'),
              ...(typeof body.sourceDocumentId === 'string' && body.sourceDocumentId ? { sourceDocumentId: body.sourceDocumentId.slice(0, 160) } : {}),
              ...(typeof body.sourceLocation === 'string' && body.sourceLocation ? { sourceLocation: body.sourceLocation.slice(0, 500) } : {}),
              // A caller cannot mark unreviewed extraction as verified.
              verified: false, revision: 0, createdAt: timestamp, updatedAt: timestamp,
            };
            if (!await dependencies.users.putResumeBankItem(item)) return reply(409, { message: 'Resume bank item already exists; retry' });
            return reply(201, item);
          }
        }
        if (method === 'POST' && path === '/me/resume-bank/import') {
          if (!documentStorage?.readContent) return reply(503, { message: 'Document import is unavailable' });
          const body = parseBody(event);
          const documentId = resumeText(body.documentId, 'documentId', 160);
          const document = (await dependencies.users.listDocuments(userId)).find((item) => item.documentId === documentId);
          if (!document) return reply(404, { message: 'Document not found' });
          const items = await (dependencies.resumeDocumentExtractor ?? extractResumeDocument)(await documentStorage.readContent(document), document.contentType);
          const created: ResumeBankItem[] = [];
          for (const extracted of items.slice(0, 100)) {
            const item: ResumeBankItem = { userId, bankItemId: randomUUID(), kind: extracted.kind, content: extracted.content, sourceDocumentId: document.documentId, sourceLocation: extracted.sourceLocation, verified: false, revision: 0, createdAt: timestamp, updatedAt: timestamp };
            if (await dependencies.users.putResumeBankItem(item)) created.push(item);
          }
          return reply(201, { items: created });
        }
        const bankMatch = path.match(/^\/me\/resume-bank\/([^/]+)$/u);
        if (bankMatch && method === 'PATCH') {
          const previous = await dependencies.users.getResumeBankItem(userId, decodeURIComponent(bankMatch[1]!));
          if (!previous) return reply(404, { message: 'Resume bank item not found' });
          const body = parseBody(event);
          if (!Number.isInteger(body.revision) || body.revision !== previous.revision) return reply(409, { message: 'Resume bank item changed; refresh and retry' });
          if (body.kind !== undefined && !resumeKinds.has(body.kind as ResumeBankItem['kind'])) return reply(400, { message: 'kind is not supported' });
          if (body.verified !== undefined && typeof body.verified !== 'boolean') return reply(400, { message: 'verified must be a boolean' });
          const updated: ResumeBankItem = {
            ...previous,
            ...(body.content === undefined ? {} : { content: resumeText(body.content, 'content') }),
            ...(body.kind === undefined ? {} : { kind: body.kind as ResumeBankItem['kind'] }),
            ...(body.verified === undefined ? {} : { verified: body.verified }),
            revision: previous.revision + 1, updatedAt: timestamp,
          };
          if (!await dependencies.users.putResumeBankItem(updated, previous.revision)) return reply(409, { message: 'Resume bank item changed; refresh and retry' });
          return reply(200, updated);
        }
        if (path === '/me/resume-imports' || path === '/me/resume-jobs/resolve') {
          if (method === 'GET') return reply(200, { imports: await dependencies.users.listImportedResumeJobs(userId) });
          if (method === 'POST') {
            const body = parseBody(event);
            const canonicalUrl = normalizeResumeJobUrl(resumeText(body.url, 'url', 2_000));
            const manualDescription = body.manualDescription === undefined ? undefined : resumeText(body.manualDescription, 'manualDescription', 30_000);
            const catalog = manualDescription ? undefined : await dependencies.jobs.findByUrl(canonicalUrl);
            const cached = manualDescription || catalog ? undefined : await dependencies.resumeImportCache?.get(canonicalUrl);
            // The catalog has already passed the application's normal source and URL
            // admission checks. It is still deliberately a compact role summary: no
            // private résumé text is ever put into the shared acquisition cache.
            const catalogDescription = catalog && [
              `${catalog.title} at ${catalog.company}.`,
              catalog.location ? `Location: ${catalog.location}.` : '',
              catalog.season ? `Program: ${catalog.season}.` : '',
              catalog.requirements?.requiresUsCitizenship ? 'US citizenship required.' : '',
              catalog.requirements?.advancedDegreeRequired ? 'Advanced degree required.' : '',
            ].filter(Boolean).join(' ');
            const description = manualDescription ?? catalogDescription ?? cached?.description ?? '';
            const imported: ImportedJob = {
              importId: randomUUID(), canonicalUrl: cached?.canonicalUrl ?? canonicalUrl,
              ...(catalog ? { title: catalog.title, company: catalog.company } : cached?.title || cached?.company ? { title: cached?.title, company: cached?.company } : {}),
              description, source: manualDescription ? 'manual' : catalog ? 'catalog' : 'cache',
              contentHash: cached?.contentHash ?? createHash('sha256').update(description || canonicalUrl).digest('hex'),
              status: manualDescription || catalog || cached ? 'ready' : 'pending', revision: 0, createdAt: timestamp, updatedAt: timestamp,
            };
            if (!await dependencies.users.putImportedResumeJob(userId, imported)) return reply(409, { message: 'Job import already exists; retry' });
            if (imported.status === 'pending' && dependencies.resumeImportQueue) await dependencies.resumeImportQueue.send({ userId, importId: imported.importId, canonicalUrl });
            return reply(201, imported);
          }
        }
        const importMatch = path.match(/^\/me\/resume-imports\/([^/]+)$/u);
        if (importMatch) {
          const importId = decodeURIComponent(importMatch[1]!);
          const previous = await dependencies.users.getImportedResumeJob(userId, importId);
          if (!previous) return reply(404, { message: 'Imported job not found' });
          if (method === 'GET') return reply(200, previous);
          if (method === 'PATCH') {
            const body = parseBody(event);
            if (!Number.isInteger(body.revision) || body.revision !== previous.revision) return reply(409, { message: 'Imported job changed; refresh and retry' });
            const description = resumeText(body.manualDescription, 'manualDescription', 30_000);
            const updated: ImportedJob = { ...previous, description, source: 'manual', status: 'ready', contentHash: createHash('sha256').update(description).digest('hex'), revision: previous.revision + 1, updatedAt: timestamp };
            if (!await dependencies.users.putImportedResumeJob(userId, updated, previous.revision)) return reply(409, { message: 'Imported job changed; refresh and retry' });
            return reply(200, updated);
          }
        }
        const resumeJobMatch = path.match(/^\/me\/resume-jobs\/([^/]+)(?:\/(manual-description|recommendation))?$/u);
        if (resumeJobMatch) {
          const importId = decodeURIComponent(resumeJobMatch[1]!);
          const action = resumeJobMatch[2];
          const imported = await dependencies.users.getImportedResumeJob(userId, importId);
          if (!imported) return reply(404, { message: 'Imported job not found' });
          if (method === 'GET' && !action) return reply(200, imported);
          if (method === 'POST' && action === 'manual-description') {
            const body = parseBody(event);
            if (!Number.isInteger(body.revision) || body.revision !== imported.revision) return reply(409, { message: 'Imported job changed; refresh and retry' });
            const description = resumeText(body.description, 'description', 30_000);
            const updated: ImportedJob = { ...imported, description, source: 'manual', status: 'ready', contentHash: createHash('sha256').update(description).digest('hex'), revision: imported.revision + 1, updatedAt: timestamp };
            if (!await dependencies.users.putImportedResumeJob(userId, updated, imported.revision)) return reply(409, { message: 'Imported job changed; refresh and retry' });
            return reply(200, updated);
          }
          if (method === 'POST' && action === 'recommendation') {
            if (imported.status !== 'ready') return reply(409, { message: 'The job description is still pending. Paste it manually to continue.' });
            const [profiles, bankItems] = await Promise.all([dependencies.users.listResumeProfiles(userId), dependencies.users.listResumeBank(userId)]);
            return reply(200, { recommendations: recommendResumeProfiles(imported.description, profiles, bankItems) });
          }
        }
        if (path === '/me/resume-profiles') {
          if (method === 'GET') return reply(200, { profiles: await dependencies.users.listResumeProfiles(userId) });
          if (method === 'POST') {
            const body = parseBody(event);
            const template = body.template as ResumeTemplateId;
            if (!resumeTemplates.has(template)) return reply(400, { message: 'template is not supported' });
            const bankItemIds = resumeStrings(body.bankItemIds, 'bankItemIds', 100);
            const owned = new Set((await dependencies.users.listResumeBank(userId)).map((item) => item.bankItemId));
            if (bankItemIds.some((id) => !owned.has(id))) return reply(403, { message: 'A resume profile may only reference your bank items' });
            const profile: ResumeProfile = {
              userId, profileId: randomUUID(), name: resumeText(body.name, 'name', 120), tags: resumeStrings(body.tags ?? [], 'tags'), bankItemIds,
              sectionOrder: resumeStrings(body.sectionOrder ?? [], 'sectionOrder', 32), template, approvedWording: {}, bankRevision: 0, revision: 0, createdAt: timestamp, updatedAt: timestamp,
            };
            if (!await dependencies.users.putResumeProfile(profile)) return reply(409, { message: 'Resume profile already exists; retry' });
            return reply(201, profile);
          }
        }
        const profileMatch = path.match(/^\/me\/resume-profiles\/([^/]+)$/u);
        if (profileMatch) {
          const profileId = decodeURIComponent(profileMatch[1]!);
          const previous = await dependencies.users.getResumeProfile(userId, profileId);
          if (!previous) return reply(404, { message: 'Resume profile not found' });
          if (method === 'GET') return reply(200, previous);
          if (method === 'DELETE') {
            const body = parseBody(event);
            if (!Number.isInteger(body.revision) || body.revision !== previous.revision) return reply(409, { message: 'Resume profile changed; refresh and retry' });
            if (!await dependencies.users.deleteResumeProfile(userId, profileId, previous.revision)) return reply(409, { message: 'Resume profile changed; refresh and retry' });
            return reply(204, {});
          }
          if (method === 'PATCH') {
            const body = parseBody(event);
            if (!Number.isInteger(body.revision) || body.revision !== previous.revision) return reply(409, { message: 'Resume profile changed; refresh and retry' });
            const template = body.template === undefined ? previous.template : body.template as ResumeTemplateId;
            if (!resumeTemplates.has(template)) return reply(400, { message: 'template is not supported' });
            const bankItemIds = body.bankItemIds === undefined ? previous.bankItemIds : resumeStrings(body.bankItemIds, 'bankItemIds', 100);
            const owned = new Set((await dependencies.users.listResumeBank(userId)).map((item) => item.bankItemId));
            if (bankItemIds.some((id) => !owned.has(id))) return reply(403, { message: 'A resume profile may only reference your bank items' });
            const updated: ResumeProfile = {
              ...previous, template, bankItemIds,
              ...(body.name === undefined ? {} : { name: resumeText(body.name, 'name', 120) }),
              ...(body.tags === undefined ? {} : { tags: resumeStrings(body.tags, 'tags') }),
              ...(body.sectionOrder === undefined ? {} : { sectionOrder: resumeStrings(body.sectionOrder, 'sectionOrder', 32) }),
              revision: previous.revision + 1, updatedAt: timestamp,
            };
            if (!await dependencies.users.putResumeProfile(updated, previous.revision)) return reply(409, { message: 'Resume profile changed; refresh and retry' });
            return reply(200, updated);
          }
        }
        if (path === '/me/resume-drafts') {
          if (method === 'GET') return reply(200, { drafts: await dependencies.users.listResumeDrafts(userId) });
          if (method === 'POST') {
            const body = parseBody(event);
            const profileId = resumeText(body.profileId, 'profileId', 160);
            const importId = resumeText(body.importId, 'importId', 160);
            const [profile, imported, bankItems] = await Promise.all([
              dependencies.users.getResumeProfile(userId, profileId), dependencies.users.getImportedResumeJob(userId, importId), dependencies.users.listResumeBank(userId),
            ]);
            if (!profile) return reply(404, { message: 'Resume profile not found' });
            if (!imported) return reply(404, { message: 'Imported job not found' });
            if (imported.status !== 'ready') return reply(409, { message: 'The job description is still pending. Paste it manually to continue.' });
            const allowed = new Set(profile.bankItemIds);
            const changes = resumeDraftChanges(imported, bankItems.filter((item) => allowed.has(item.bankItemId)));
            const draft: ResumeDraft = { userId, draftId: randomUUID(), profileId, importId, changes, revision: 0, status: 'reviewing', createdAt: timestamp, updatedAt: timestamp };
            if (!await dependencies.users.putResumeDraft(draft)) return reply(409, { message: 'Resume draft already exists; retry' });
            return reply(201, draft);
          }
        }
        const draftMatch = path.match(/^\/me\/resume-drafts\/([^/]+)$/u);
        if (draftMatch) {
          const draftId = decodeURIComponent(draftMatch[1]!);
          const previous = await dependencies.users.getResumeDraft(userId, draftId);
          if (!previous) return reply(404, { message: 'Resume draft not found' });
          if (method === 'GET') return reply(200, previous);
          if (method === 'PATCH') {
            const body = parseBody(event);
            if (!Number.isInteger(body.revision) || body.revision !== previous.revision) return reply(409, { message: 'Resume draft changed; refresh and retry' });
            if (!Array.isArray(body.decisions)) return reply(400, { message: 'decisions must be a list' });
            const decisions = new Map(body.decisions.map((decision) => [typeof decision === 'object' && decision !== null ? (decision as Record<string, unknown>).changeId : undefined, typeof decision === 'object' && decision !== null ? (decision as Record<string, unknown>).decision : undefined]));
            if ([...decisions].some(([id, decision]) => typeof id !== 'string' || (decision !== 'accepted' && decision !== 'rejected')) || [...decisions.keys()].some((id) => !previous.changes.some((change) => change.changeId === id))) return reply(400, { message: 'decisions must name draft changes and use accepted or rejected' });
            const changes = previous.changes.map((change) => ({ ...change, ...(decisions.has(change.changeId) ? { decision: decisions.get(change.changeId) as 'accepted' | 'rejected' } : {}) }));
            const updated: ResumeDraft = { ...previous, changes, status: changes.every((change) => change.decision) ? 'finalized' : 'reviewing', revision: previous.revision + 1, updatedAt: timestamp };
            if (!await dependencies.users.putResumeDraft(updated, previous.revision)) return reply(409, { message: 'Resume draft changed; refresh and retry' });
            return reply(200, updated);
          }
        }
        const draftChangeMatch = path.match(/^\/me\/resume-drafts\/([^/]+)\/changes\/([^/]+)$/u);
        if (draftChangeMatch && method === 'PATCH') {
          const draftId = decodeURIComponent(draftChangeMatch[1]!);
          const changeId = decodeURIComponent(draftChangeMatch[2]!);
          const previous = await dependencies.users.getResumeDraft(userId, draftId);
          if (!previous) return reply(404, { message: 'Resume draft not found' });
          const body = parseBody(event);
          if (!Number.isInteger(body.revision) || body.revision !== previous.revision) return reply(409, { message: 'Resume draft changed; refresh and retry' });
          if (body.decision !== 'accepted' && body.decision !== 'rejected') return reply(400, { message: 'decision must be accepted or rejected' });
          if (!previous.changes.some((change) => change.changeId === changeId)) return reply(404, { message: 'Resume change not found' });
          const decision = body.decision as NonNullable<ResumeChange['decision']>;
          const changes = previous.changes.map((change) => change.changeId === changeId ? { ...change, decision } : change);
          const updated: ResumeDraft = { ...previous, changes, status: changes.every((change) => change.decision) ? 'finalized' : 'reviewing', revision: previous.revision + 1, updatedAt: timestamp };
          if (!await dependencies.users.putResumeDraft(updated, previous.revision)) return reply(409, { message: 'Resume draft changed; refresh and retry' });
          return reply(200, updated);
        }
        const finalizeDraftMatch = path.match(/^\/me\/resume-drafts\/([^/]+)\/finalize$/u);
        if (finalizeDraftMatch && method === 'POST') {
          const draftId = decodeURIComponent(finalizeDraftMatch[1]!);
          const previous = await dependencies.users.getResumeDraft(userId, draftId);
          if (!previous) return reply(404, { message: 'Resume draft not found' });
          const body = parseBody(event);
          if (!Number.isInteger(body.revision) || body.revision !== previous.revision) return reply(409, { message: 'Resume draft changed; refresh and retry' });
          if (!previous.changes.every((change) => change.decision)) return reply(409, { message: 'Review every change before finalizing' });
          const updated: ResumeDraft = { ...previous, status: 'finalized', revision: previous.revision + 1, updatedAt: timestamp };
          if (!await dependencies.users.putResumeDraft(updated, previous.revision)) return reply(409, { message: 'Resume draft changed; refresh and retry' });
          if (!dependencies.resumeArtifactStorage) return reply(200, { draft: updated });
          const profile = await dependencies.users.getResumeProfile(userId, updated.profileId);
          if (!profile) return reply(404, { message: 'Resume profile not found' });
          const rendered = renderResumeLatex(profile, updated);
          const existing = (await dependencies.users.listResumeArtifacts(userId)).find((artifact) => artifact.resumeSpecHash === rendered.resumeSpecHash);
          if (existing) return reply(200, { draft: updated, artifact: existing });
          const artifactId = randomUUID();
          const objectKey = `private/${userId}/resume-artifacts/${rendered.resumeSpecHash}.tex`;
          await dependencies.resumeArtifactStorage.putTex(objectKey, rendered.tex);
          const artifact = { userId, artifactId, draftId, objectKey, texObjectKey: objectKey, templateVersion: RESUME_TEMPLATE_VERSION, compilerVersion: RESUME_COMPILER_VERSION, resumeSpecHash: rendered.resumeSpecHash, createdAt: timestamp };
          if (!await dependencies.users.putResumeArtifact(artifact)) return reply(409, { message: 'Resume artifact changed; refresh and retry' });
          return reply(200, { draft: updated, artifact });
        }
        const artifactContentMatch = path.match(/^\/me\/resume-artifacts\/([^/]+)\/content$/u);
        if (artifactContentMatch && method === 'GET') {
          if (!dependencies.resumeArtifactStorage) return reply(503, { message: 'Resume artifact storage is unavailable' });
          const artifact = await dependencies.users.getResumeArtifact(userId, decodeURIComponent(artifactContentMatch[1]!));
          if (!artifact) return reply(404, { message: 'Resume artifact not found' });
          return reply(200, { artifact, downloadUrl: await dependencies.resumeArtifactStorage.createContentUrl(artifact) });
        }
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
        const [profile, applications, documents, resumeBank, resumeProfiles, resumeDrafts, resumeImports, resumeArtifacts] = await Promise.all([
          dependencies.users.getProfile(userId),
          dependencies.users.listApplications(userId),
          dependencies.users.listDocuments(userId),
          dependencies.users.listResumeBank(userId),
          dependencies.users.listResumeProfiles(userId),
          dependencies.users.listResumeDrafts(userId),
          dependencies.users.listImportedResumeJobs(userId),
          dependencies.users.listResumeArtifacts(userId),
        ]);
        const exported: AccountDataExport = {
          schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
          exportedAt: dependencies.now?.() ?? now(),
          account: {
            profile: profile ?? null,
            applications,
            documents: documents.map(({ documentId, fileName, contentType, createdAt }) => ({ documentId, fileName, contentType, createdAt })),
            resume: { bankItems: resumeBank, profiles: resumeProfiles, drafts: resumeDrafts, imports: resumeImports, artifacts: resumeArtifacts },
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
        let artifacts: Awaited<ReturnType<UserStore['listResumeArtifacts']>>;
        let activeDocumentUploads: boolean;
        try {
          await dependencies.users.beginUserDeletion(userId);
          [documents, artifacts, activeDocumentUploads] = await Promise.all([
            dependencies.users.listDocuments(userId),
            dependencies.users.listResumeArtifacts(userId),
            dependencies.users.hasActiveDocumentUploads(userId),
          ]);
        } catch {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'account-data', retryable: true, message: 'Account deletion could not be prepared. Your account data and sign-in were kept so you can retry.' });
        }
        if (activeDocumentUploads) {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'document-storage', retryable: true, message: 'A document upload is still finishing. Your account data and sign-in were kept so you can retry deletion.' });
        }
        if ((documents.length > 0 || artifacts.length > 0) && !documentStorage) {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'document-storage', retryable: true, message: 'Document storage is unavailable. Your account data and sign-in were kept so you can retry.' });
        }
        try {
          if (documentStorage) await Promise.all([
            ...documents.map((document) => documentStorage.deleteObject(document.objectKey)),
            ...artifacts.map((artifact) => documentStorage.deleteObject(artifact.objectKey)),
          ]);
        } catch {
          return reply(503, { code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'document-storage', retryable: true, message: 'Account deletion is incomplete. Your document and resume artifact records and sign-in are still available so you can retry.' });
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
