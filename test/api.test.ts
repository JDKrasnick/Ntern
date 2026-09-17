import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryReleaseStore, MemoryUserStore } from '../src/store.js';
import type { Internship } from '../src/types.js';

const job: Internship = { jobId: 'job-1', company: 'Acme', title: 'Software Intern', location: 'Remote', season: 'summer-2027', applyUrl: 'https://apply.example.test/role', normalizedUrl: 'https://apply.example.test/role', fingerprint: 'acme', compensation: { raw: '' }, sourceReferences: [], open: true, firstSeenAt: '2026-07-19T00:00:00.000Z', lastSeenAt: '2026-07-19T00:00:00.000Z', notification: { smsPending: false, digestPending: false } };
const event = (userId: string | undefined, method: string, rawPath: string, body?: unknown, queryStringParameters?: Record<string, string>) => ({ rawPath, queryStringParameters, body: body === undefined ? undefined : JSON.stringify(body), requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) } });
const hasUndefined = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.some(hasUndefined)) ||
  (value !== null && typeof value === 'object' && Object.values(value).some(hasUndefined));

describe('public API ownership boundary', () => {
  afterEach(() => vi.useRealTimers());
  it('returns the last exact-role verification timestamp during temporary unreadability', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T00:00:00Z'));
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({ ...job, admission: {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved', postingAttribution: 'attributed',
      destination: { classification: 'unresolved', candidateUrl: job.applyUrl, provider: 'structured', inspectedAt: '2026-08-26T00:00:00Z', lastKnownGoodAt: '2026-08-20T00:00:00Z' },
      metadata: { complete: true, title: 'complete', location: 'complete' }, catalogEligible: true, alertEligible: false,
      reasonCodes: ['destination-grace'], evaluatedAt: '2026-08-26T00:00:00Z', evidenceObservedAt: '2026-08-26T00:00:00Z',
      lastVerifiedAt: '2026-08-20T00:00:00Z', graceDeadline: '2026-08-27T00:00:00Z',
    } });
    const handler = createApiHandler({ jobs, users: new MemoryUserStore(), now: () => '2026-08-26T00:00:00Z' });
    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs/job-1'))).body))
      .toMatchObject({ admission: { lastVerifiedAt: '2026-08-20T00:00:00Z', alertEligible: false } });
  });

  it('keeps identity-unconfirmed roles in shadow until the rollout flag is enabled', async () => {
    const jobs = new MemoryInternshipStore();
    const users = new MemoryUserStore();
    const unconfirmed = { ...job, postingIdentityStatus: 'unconfirmed' as const };
    await jobs.putInternship(unconfirmed);
    await users.putApplication('student', { applicationId: 'saved-shadow', jobId: job.jobId, status: 'saved', createdAt: job.firstSeenAt, updatedAt: job.lastSeenAt });
    await users.putPreferences({
      userId: 'student', filter: {}, alertsEnabled: false, onboardingComplete: true,
      lastCatalogOpenedAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const releases = new MemoryReleaseStore();
    await releases.putRelease({ releaseId: 'shadow-release', userId: 'student', jobIds: [job.jobId], newJobIds: [job.jobId], createdAt: job.lastSeenAt });
    const shadow = createApiHandler({ jobs, users, releases, identityUnconfirmedPublicationEnabled: false, now: () => '2026-07-20T00:00:00.000Z' });
    expect(JSON.parse((await shadow(event(undefined, 'GET', '/jobs'))).body).jobs).toEqual([]);
    expect((await shadow(event(undefined, 'GET', `/jobs/${job.jobId}`))).statusCode).toBe(404);
    expect(JSON.parse((await shadow(event('student', 'GET', '/me/applications'))).body).applications[0].job)
      .toMatchObject({ availability: 'catalog-review' });
    expect(JSON.parse((await shadow(event('student', 'GET', '/me/releases/shadow-release'))).body))
      .toMatchObject({ jobs: [], newJobIds: [] });
    expect(JSON.parse((await shadow(event('student', 'POST', '/me/opening'))).body).jobs).toEqual([]);
    expect((await shadow(event('student', 'POST', '/me/applications', { jobId: job.jobId }))).statusCode).toBe(404);
    expect((await shadow(event('student', 'POST', '/me/applications/saved-shadow/assistance-sessions', { mode: 'headed' }))).statusCode).toBe(409);
    const active = createApiHandler({ jobs, users, identityUnconfirmedPublicationEnabled: true });
    expect(JSON.parse((await active(event(undefined, 'GET', '/jobs'))).body).jobs).toMatchObject([{ jobId: job.jobId }]);
  });

  it('retains quarantined roles in Saved without an unsafe handoff or assistance controls', async () => {
    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore();
    const review = { ...job, admission: {
      canonicalEmployer: { id: 'acme', displayName: 'Acme' }, employerResolution: 'resolved' as const,
      postingAttribution: 'attributed' as const,
      destination: { classification: 'aggregate-board' as const, candidateUrl: job.applyUrl, provider: 'structured' as const, inspectedAt: '2026-08-26T00:00:00Z' },
      metadata: { complete: true, title: 'complete' as const, location: 'complete' as const },
      catalogEligible: false, alertEligible: false, reasonCodes: ['destination-aggregate-board' as const],
      evaluatedAt: '2026-08-26T00:00:00Z', evidenceObservedAt: '2026-08-26T00:00:00Z',
    } };
    await jobs.putInternship(review);
    await users.putApplication('student', { applicationId: 'saved-1', jobId: job.jobId, status: 'saved', createdAt: '2026-08-20T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z' });
    const handler = createApiHandler({ jobs, users });
    expect((await handler(event(undefined, 'GET', `/jobs/${job.jobId}`))).statusCode).toBe(404);
    const summary = JSON.parse((await handler(event('student', 'GET', '/me/applications'))).body).applications[0];
    expect(summary.job).toMatchObject({ company: 'Acme', title: 'Software Intern', availability: 'catalog-review',
      unavailableReason: 'Ntern couldn’t verify the official role page and is reviewing it.' });
    expect(summary.job).not.toHaveProperty('applyUrl');
    expect(summary.job).not.toHaveProperty('assistance');
    expect((await handler(event('student', 'PATCH', '/me/applications/saved-1', { status: 'applied' }))).statusCode).toBe(200);
    expect((await handler(event('student', 'POST', '/me/applications/saved-1/assistance-sessions', { mode: 'headed' }))).statusCode).toBe(409);
  });
  it('publishes provider-neutral company coverage without requiring an account', async () => {
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users: new MemoryUserStore() });
    const response = await handler(event(undefined, 'GET', '/coverage', undefined, { q: 'figma', limit: '10' }));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      counts: { internshipObserved: expect.any(Number), directPublished: expect.any(Number) },
      matchedCompanies: 1,
      companies: [{
        displayName: 'Figma',
        coverageState: 'direct-published',
        directProviders: ['greenhouse']
      }]
    });
  });
  it('makes the feed public while keeping applications private to their Cognito subject', async () => {
    const sourcedJob = { ...job, sourceReferences: [{ sourceId: 'greenhouse-acme', document: 'role', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1', row: 1, company: 'Acme', title: 'Software Intern', location: 'Remote', season: 'summer-2027', applyUrl: job.applyUrl, compensation: { raw: '' }, state: 'open' as const }] };
    const jobs = new MemoryInternshipStore(); await jobs.putInternship(sourcedJob); await jobs.putInternship({ ...job, jobId: 'closed-job', open: false }); const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });
    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs'))).body).jobs).toHaveLength(1);
    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs', undefined, { status: 'closed' }))).body).jobs).toMatchObject([{ jobId: 'closed-job', open: false }]);
    expect((await handler(event(undefined, 'GET', '/me/applications'))).statusCode).toBe(401);
    const created = await handler(event('user-a', 'POST', '/me/applications', { jobId: 'job-1', notes: 'Tailor résumé' }));
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({
      job: { jobId: 'job-1', company: 'Acme', title: 'Software Intern', availability: 'available' },
    });
    expect(JSON.parse((await handler(event('user-b', 'GET', '/me/applications'))).body)).toEqual({ applications: [] });
    const applicationId = JSON.parse(created.body).applicationId as string;
    expect((await handler(event('user-b', 'PATCH', `/me/applications/${applicationId}`, { status: 'offer' }))).statusCode).toBe(404);
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications'))).body).applications[0]).toMatchObject({
      jobId: 'job-1',
      applyMode: 'official-form',
      job: { jobId: 'job-1', company: 'Acme', title: 'Software Intern', open: true, sourceReferences: [{ sourceId: 'greenhouse-acme', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1' }] },
    });
  });
  it('deletes only the authenticated user application and preserves neighboring records', async () => {
    const jobs = new MemoryInternshipStore(); await jobs.putInternship(job);
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs, users });
    const first = await handler(event('owner', 'POST', '/me/applications', { jobId: job.jobId }));
    const secondJob = { ...job, jobId: 'job-2', title: 'Data Intern' };
    await jobs.putInternship(secondJob);
    const second = await handler(event('owner', 'POST', '/me/applications', { jobId: secondJob.jobId }));
    const firstId = (JSON.parse(first.body) as { applicationId: string }).applicationId;
    const secondId = (JSON.parse(second.body) as { applicationId: string }).applicationId;

    expect((await handler(event(undefined, 'DELETE', `/me/applications/${firstId}`))).statusCode).toBe(401);
    expect((await handler(event('other-user', 'DELETE', `/me/applications/${firstId}`))).statusCode).toBe(404);
    expect((await handler(event('owner', 'DELETE', '/me/applications/missing'))).statusCode).toBe(404);
    expect((await handler(event('owner', 'DELETE', `/me/applications/${firstId}`))).statusCode).toBe(204);
    expect((await handler(event('owner', 'DELETE', `/me/applications/${firstId}`))).statusCode).toBe(404);
    expect((await handler(event('owner', 'PATCH', `/me/applications/${secondId}`, { status: 'applied' }))).statusCode).toBe(200);
    expect((await handler(event('owner', 'DELETE', `/me/applications/${secondId}`))).statusCode).toBe(409);
    expect(JSON.parse((await handler(event('owner', 'GET', '/me/applications'))).body).applications)
      .toMatchObject([{ applicationId: secondId, jobId: secondJob.jobId, status: 'applied' }]);
  });
  it('queues saved roles and clears queue membership on status advance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    const jobs = new MemoryInternshipStore(); await jobs.putInternship(job);
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs, users });
    const created = await handler(event('user-a', 'POST', '/me/applications', { jobId: job.jobId }));
    expect(created.statusCode).toBe(201);
    const saved = JSON.parse(created.body) as { applicationId: string };
    expect(saved).toMatchObject({ status: 'saved', queuedAt: '2026-09-08T00:00:00.000Z' });
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications', undefined, { queued: 'true' }))).body).applications)
      .toMatchObject([{ applicationId: saved.applicationId }]);
    expect((await handler(event('user-a', 'PATCH', `/me/applications/${saved.applicationId}`, { queued: false }))).statusCode).toBe(200);
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications', undefined, { queued: 'true' }))).body)).toEqual({ applications: [] });
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications', undefined, { queued: 'false' }))).body).applications)
      .toMatchObject([{ applicationId: saved.applicationId, status: 'saved' }]);
    expect((await handler(event('user-a', 'PATCH', `/me/applications/${saved.applicationId}`, { queued: true }))).statusCode).toBe(200);
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications', undefined, { queued: 'true' }))).body).applications)
      .toMatchObject([{ applicationId: saved.applicationId }]);
    const applied = await handler(event('user-a', 'PATCH', `/me/applications/${saved.applicationId}`, { status: 'applied' }));
    expect(applied.statusCode).toBe(200);
    expect(JSON.parse(applied.body)).toMatchObject({
      applicationId: saved.applicationId,
      status: 'applied',
      appliedAt: '2026-09-08T00:00:00.000Z',
      job: { jobId: job.jobId, title: 'Software Intern' },
    });
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications', undefined, { queued: 'true' }))).body)).toEqual({ applications: [] });
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications'))).body).applications)
      .toMatchObject([{ applicationId: saved.applicationId, status: 'applied', appliedAt: '2026-09-08T00:00:00.000Z' }]);
  });
  it('saves for later in one call without queueing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    const jobs = new MemoryInternshipStore(); await jobs.putInternship(job);
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs, users });
    const created = await handler(event('user-a', 'POST', '/me/applications', { jobId: job.jobId, status: 'saved', queued: false }));
    expect(created.statusCode).toBe(201);
    const saved = JSON.parse(created.body) as { applicationId: string };
    expect(saved).toMatchObject({ status: 'saved' });
    expect(saved).not.toHaveProperty('queuedAt');
    expect(JSON.parse((await handler(event('user-a', 'GET', '/me/applications', undefined, { queued: 'true' }))).body)).toEqual({ applications: [] });
    expect((await handler(event('user-a', 'POST', '/me/applications', { jobId: job.jobId, queued: 'yes' }))).statusCode).toBe(400);
  });
  it('rejects invalid queue updates', async () => {
    const jobs = new MemoryInternshipStore(); await jobs.putInternship(job);
    const users = new MemoryUserStore();
    const secondJob = { ...job, jobId: 'job-2', title: 'Data Intern', applyUrl: 'https://apply.example.test/role-2', normalizedUrl: 'https://apply.example.test/role-2' };
    await jobs.putInternship(secondJob);
    const handler = createApiHandler({ jobs, users });
    const appliedBody = JSON.parse((await handler(event('user-a', 'POST', '/me/applications', { jobId: secondJob.jobId, status: 'applied' }))).body) as { applicationId: string };
    const appliedId = appliedBody.applicationId;
    expect(appliedBody).not.toHaveProperty('queuedAt');
    const savedId = (JSON.parse((await handler(event('user-a', 'POST', '/me/applications', { jobId: job.jobId }))).body) as { applicationId: string }).applicationId;
    expect((await handler(event('user-a', 'PATCH', `/me/applications/${savedId}`, { queued: 'yes' }))).statusCode).toBe(400);
    expect((await handler(event('user-a', 'PATCH', `/me/applications/${appliedId}`, { queued: true }))).statusCode).toBe(409);
    expect((await handler(event('user-a', 'GET', '/me/applications', undefined, { queued: 'maybe' }))).statusCode).toBe(400);
  });
  it('persists per-user alert templates without resetting existing alert preferences', async () => {
    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });
    const first = await handler(event('user-a', 'PUT', '/me/preferences', { filter: { includeCategories: ['swe'], includeEmployerCategories: ['faang', 'startup'] }, alertsEnabled: true, onboardingComplete: true, push: { titleTemplate: '{company}: {title}', descriptionTemplate: '{location}\n{url}' } }));
    expect(JSON.parse(first.body)).toMatchObject({ alertsEnabled: true, push: { titleTemplate: '{company}: {title}' } });
    const second = await handler(event('user-a', 'PUT', '/me/preferences', { push: { titleTemplate: '{shortTitle} — {company}' } }));
    expect(JSON.parse(second.body)).toMatchObject({ filter: { includeCategories: ['swe'], includeEmployerCategories: ['faang', 'startup'] }, alertsEnabled: true, onboardingComplete: true, push: { titleTemplate: '{shortTitle} — {company}' } });
  });
  it('validates and preserves delivery settings for alert controls', async () => {
    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });
    const saved = await handler(event('user-a', 'PUT', '/me/preferences', {
      alertSettings: {
        delivery: 'daily-digest',
        timezone: 'America/New_York',
        quietHours: { start: '22:00', end: '08:00', timezone: 'America/New_York' },
        applicationReminders: true,
        followUpDays: 5
      }
    }));
    expect(saved.statusCode).toBe(200);
    expect(JSON.parse(saved.body)).toMatchObject({ alertSettings: { delivery: 'daily-digest', timezone: 'America/New_York', quietHours: { start: '22:00', end: '08:00' }, applicationReminders: true, followUpDays: 5 } });
    const missingTimezone = await handler(event('user-b', 'PUT', '/me/preferences', { alertSettings: { delivery: 'daily-digest' } }));
    expect(missingTimezone.statusCode).toBe(400);
    expect(JSON.parse(missingTimezone.body).message).toContain('timezone');
    const invalid = await handler(event('user-a', 'PUT', '/me/preferences', { alertSettings: { quietHours: { start: 'after dark', end: '08:00', timezone: 'America/New_York' } } }));
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body).message).toContain('quietHours');
  });
  it('persists onboarding preferences without undefined optional fields', async () => {
    const jobs = new MemoryInternshipStore(); const users = new MemoryUserStore(); const handler = createApiHandler({ jobs, users });
    const saved = await handler(event('user-a', 'PUT', '/me/preferences', {
      filter: { includeCategories: ['swe'], includeKeywords: ['backend'] },
      alertsEnabled: false,
      onboardingComplete: true,
      alertSettings: { delivery: 'immediate', applicationReminders: true, followUpDays: 7 }
    }));
    expect(saved.statusCode).toBe(200);
    const preference = await users.getPreferences('user-a');
    expect(preference?.filter).toStrictEqual({ includeCategories: ['swe'], includeKeywords: ['backend'] });
    expect(preference?.alertSettings).toStrictEqual({
      delivery: 'immediate',
      applicationReminders: true,
      followUpDays: 7
    });
    expect(preference?.applicationHandoff).toBe('window');
    expect(hasUndefined(preference)).toBe(false);
  });
  it('creates a versioned, no-submit Greenhouse assistance session while keeping unknown and LinkedIn destinations manual', async () => {
    const jobs = new MemoryInternshipStore();
    const greenhouse = { ...job, jobId: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/123', normalizedUrl: 'https://boards.greenhouse.io/acme/jobs/123' };
    const linkedin = { ...job, jobId: 'linkedin', applyUrl: 'https://www.linkedin.com/jobs/view/123', normalizedUrl: 'https://www.linkedin.com/jobs/view/123' };
    await jobs.putInternship(greenhouse); await jobs.putInternship(linkedin);
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs, users, now: () => '2026-07-20T12:00:00.000Z' });

    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs/greenhouse'))).body)).toMatchObject({ assistance: { eligibility: 'headed-supported', primaryAction: 'assist-in-safari' } });
    expect(JSON.parse((await handler(event(undefined, 'GET', '/jobs/linkedin'))).body)).toMatchObject({ assistance: { eligibility: 'manual-only', reasonCode: 'destination-policy-prohibits-automation' } });

    const application = JSON.parse((await handler(event('student-a', 'POST', '/me/applications', { jobId: 'greenhouse' }))).body) as { applicationId: string; status: string };
    expect(application.status).toBe('saved');
    const queue = JSON.parse((await handler(event('student-a', 'GET', '/me/applications', undefined, { status: 'saved' }))).body) as { applications: Array<{ job: { assistance: { eligibility: string } } }> };
    expect(queue.applications).toMatchObject([{ job: { assistance: { eligibility: 'headed-supported' } } }]);

    const created = await handler(event('student-a', 'POST', `/me/applications/${application.applicationId}/assistance-sessions`, { mode: 'headed' }));
    expect(created.statusCode).toBe(201);
    const handoff = JSON.parse(created.body) as { session: { sessionId: string; userId?: string; version: number }; handoff: { sessionId: string; code: string } };
    expect(handoff.session).toMatchObject({ version: 0 });
    expect(handoff.session.userId).toBeUndefined();

    const exchanged = await handler(event(undefined, 'POST', '/assist/exchange', { sessionId: handoff.handoff.sessionId, code: handoff.handoff.code }));
    expect(exchanged.statusCode).toBe(200);
    const bearer = (JSON.parse(exchanged.body) as { bearer: string }).bearer;
    expect((await handler(event(undefined, 'POST', '/assist/exchange', { sessionId: handoff.handoff.sessionId, code: handoff.handoff.code }))).statusCode).toBe(401);

    const assistedEvent = (payload: unknown) => handler({ ...event(undefined, 'POST', '/assist/session/events', payload), headers: { authorization: `Bearer ${bearer}` } });
    expect((await assistedEvent({ eventId: 'runner-start', expectedVersion: 1, event: { type: 'start' } })).statusCode).toBe(200);
    const field = { key: 'first_name', label: 'First name', required: true, resolved: true, classification: 'standard', confidence: 'exact', valueRef: { source: 'profile', key: 'contact.name' }, maskedPreview: 'S•••' };
    expect((await assistedEvent({ eventId: 'runner-fill', expectedVersion: 2, event: { type: 'fill-completed', fields: [field] } })).statusCode).toBe(200);
    const replay = await assistedEvent({ eventId: 'runner-fill', expectedVersion: 2, event: { type: 'fill-completed', fields: [field] } });
    expect(JSON.parse(replay.body)).toMatchObject({ replayed: true, session: { version: 3 } });
    expect((await assistedEvent({ eventId: 'runner-submit', expectedVersion: 3, event: { type: 'submission-confirmed' } })).statusCode).toBe(400);

    const approve = await handler(event('student-a', 'POST', `/me/application-sessions/${handoff.session.sessionId}/events`, { eventId: 'student-review', expectedVersion: 3, event: { type: 'review-approved' } }));
    expect(approve.statusCode).toBe(200);
    const submitted = await handler(event('student-a', 'POST', `/me/application-sessions/${handoff.session.sessionId}/events`, { eventId: 'student-confirmed', expectedVersion: 4, event: { type: 'submission-confirmed' } }));
    expect(submitted.statusCode).toBe(200);
    expect((await users.getApplication('student-a', application.applicationId))?.status).toBe('applied');
  });
});
