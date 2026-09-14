import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { handleEmployerApi } from '../cloudflare/employer-api.js';
import { handleEmployerOperations } from '../cloudflare/employer-operations-api.js';
import { D1EmployerStore } from '../cloudflare/employer-store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';
import { MemoryInternshipStore } from '../src/store.js';
import { reviewedProviderRegistry, reviewedStructuredRegistry } from '../cloudflare/employer-registry.js';
import { reviewedAshbySources } from '../src/sources/ashby-config.js';
import { reviewedGreenhouseSources } from '../src/sources/greenhouse-config.js';

type SqliteValue = string | number | bigint | null | Uint8Array;
function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query); const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return { prepare: prepared, async batch(statements) { database.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; } catch (error) { database.exec('ROLLBACK'); throw error; } } };
}

function fixture() {
  const database = new DatabaseSync(':memory:'); database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  database.exec(readFileSync(new URL('../cloudflare/migrations/0006_employer_channel.sql', import.meta.url), 'utf8'));
  database.prepare("INSERT INTO auth_users (user_id,email,password_hash,password_salt,verified_at,created_at,updated_at) VALUES ('owner','owner@acme.test','x','x','2026-08-01','2026-08-01','2026-08-01')").run();
  return { database, store: new D1EmployerStore(sqliteD1(database)), jobs: new MemoryInternshipStore() };
}

const at = () => new Date('2026-08-26T12:00:00.000Z');
const request = (path: string, value: unknown, key: string) => new Request(`https://api.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value) });
const operations = <T extends object>(value: T) => ({ ...value, validateReviewedHost: async () => {} });

describe('employer channel API', () => {
  it('idempotently seeds and reads reviewed provider dispatch from D1', async () => {
    const { database, store } = fixture();
    const first = await reviewedProviderRegistry(store);
    const count = first.greenhouse.length + first.lever.length + first.ashby.length;
    expect(first.greenhouse.length).toBeGreaterThan(0);
    expect(first.lever.length).toBeGreaterThan(0);
    expect(first.ashby.length).toBeGreaterThan(0);
    await reviewedProviderRegistry(store);
    expect(await store.listReviewedSources()).toHaveLength(count);
    database.close();
  });

  it('carries a reviewed empty-board acknowledgement from D1 into runtime dispatch', async () => {
    const { database, store } = fixture();
    await reviewedProviderRegistry(store);
    const ashby = reviewedAshbySources.find((source) => source.emptyBoardAcknowledged)!;
    const greenhouse = reviewedGreenhouseSources.find((source) => source.emptyBoardAcknowledged)!;
    const registry = await reviewedProviderRegistry(store);
    expect(registry.ashby.find((source) => source.id === ashby.id)?.emptyBoardAcknowledged).toEqual(ashby.emptyBoardAcknowledged);
    expect(registry.greenhouse.find((source) => source.id === greenhouse.id)?.emptyBoardAcknowledged).toEqual(greenhouse.emptyBoardAcknowledged);
    database.close();
  });

  it('refreshes a drifted reviewed config and leaves employer-owned records alone', async () => {
    const { database, store } = fixture();
    await reviewedProviderRegistry(store);
    const target = reviewedAshbySources.find((source) => source.id === 'ashby-blockhouse')!;
    const stored = (await store.listReviewedSources()).find((record) => record.sourceId === target.id)!;
    await store.putReviewedSource({ ...stored, config: { ...stored.config, emptyBoardAcknowledged: undefined, staleField: true } });
    await reviewedProviderRegistry(store);
    const refreshed = (await store.listReviewedSources()).find((record) => record.sourceId === target.id)!;
    expect(refreshed.config).toEqual({ ...target });
    expect(refreshed.state).toBe(stored.state);

    const owned = reviewedAshbySources.find((source) => !source.emptyBoardAcknowledged)!;
    database.prepare("INSERT INTO employer_organizations (id,name,domain,state,created_at,updated_at) VALUES ('org-owner','Owner Co','owner.test','active','2026-08-01','2026-08-01')").run();
    const ownedStored = (await store.listReviewedSources()).find((record) => record.sourceId === owned.id)!;
    await store.putReviewedSource({ ...ownedStored, organizationId: 'org-owner', config: { id: owned.id, employerSubmitted: true } });
    await reviewedProviderRegistry(store);
    const ownedAfter = (await store.listReviewedSources()).find((record) => record.sourceId === owned.id)!;
    expect(ownedAfter.config).toEqual({ id: owned.id, employerSubmitted: true });
    database.close();
  });

  it('runs claim, review, submission publication, and idempotent dedupe end to end', async () => {
    const { database, store, jobs } = fixture();
    const dependencies = { store, jobs, userId: 'owner', userEmail: 'owner@acme.test', now: at, validateSourceUrl: async () => {} };
    const claim = await handleEmployerApi(request('/employer/organizations', { name: 'Acme', domain: 'acme.test' }, 'claim-1'), dependencies);
    expect(claim.status).toBe(201);
    const claimed = await claim.json() as { organization: { organizationId: string } }; const orgId = claimed.organization.organizationId;

    const challenge = await handleEmployerApi(request(`/employer/organizations/${orgId}/challenges`, { method: 'email-domain' }, 'challenge-1'), dependencies);
    expect(challenge.status).toBe(201);
    expect(await store.getVerification(orgId)).toMatchObject({ state: 'review-pending' });

    const review = await handleEmployerOperations(request(`/operations/employers/organizations/${orgId}/verification/decision`, { decision: 'verified' }, 'verify-1'), operations({ store, jobs, actor: 'reviewer', now: at }));
    expect(review.status).toBe(200);
    expect(await store.getVerification(orgId)).toMatchObject({ state: 'verified', expiresAt: '2027-02-22T12:00:00.000Z' });

    const invitation = await handleEmployerApi(request(`/employer/organizations/${orgId}/invitations`, {
      email: 'editor@acme.test', role: 'editor',
    }, 'invite-1'), dependencies);
    expect(await invitation.json()).toMatchObject({ token: expect.any(String) });
    expect(await store.idempotencyResult(orgId, 'invitation.create', 'invite-1')).not.toHaveProperty('token');

    const sourceResponse = await handleEmployerApi(request(`/employer/organizations/${orgId}/sources`, {
      provider: 'json-ld', url: 'https://careers.acme.test/jobs',
    }, 'source-1'), dependencies);
    expect(sourceResponse.status).toBe(201);
    const sourceBody = await sourceResponse.json() as { source: { sourceId: string } };
    const sourceDecision = await handleEmployerOperations(request(
      `/operations/employers/organizations/${orgId}/sources/${sourceBody.source.sourceId}/decision`,
      { decision: 'shadow', allowedApplicationHosts: ['careers.acme.test'] }, 'source-review-1',
    ), operations({ store, jobs, actor: 'reviewer', now: at }));
    expect(sourceDecision.status).toBe(200);
    const connection = await store.getSource(orgId, sourceBody.source.sourceId);
    await jobs.putCheckpoint({ sourceId: `shadow-${connection!.sourceId!}`, successfulFetches: 2, lastSuccessAt: at().toISOString(), lastRowCount: 1 });
    const changedPromotion = await handleEmployerOperations(request(
      `/operations/employers/organizations/${orgId}/sources/${sourceBody.source.sourceId}/decision`,
      { decision: 'active', allowedApplicationHosts: ['apply.acme.test'] }, 'source-review-changed',
    ), operations({ store, jobs, actor: 'reviewer', now: at }));
    expect(changedPromotion.status).toBe(400);
    expect(await store.getSource(orgId, sourceBody.source.sourceId)).toMatchObject({ state: 'shadow' });
    const sourcePromotion = await handleEmployerOperations(request(
      `/operations/employers/organizations/${orgId}/sources/${sourceBody.source.sourceId}/decision`,
      { decision: 'active', allowedApplicationHosts: ['careers.acme.test'] }, 'source-review-2',
    ), operations({ store, jobs, actor: 'reviewer', now: at }));
    expect(sourcePromotion.status).toBe(200);
    expect(await reviewedStructuredRegistry(store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'json-ld', status: 'published', allowedApplicationHosts: [{ host: 'careers.acme.test' }] }),
    ]));

    const submissionResponse = await handleEmployerApi(request(`/employer/organizations/${orgId}/submissions`, {
      company: 'Acme', title: 'Software Engineering Intern', programType: 'internship', discipline: 'software',
      location: 'Remote', workMode: 'remote', season: 'summer-2027', applicationUrl: 'https://careers.acme.test/apply/1',
      deadline: 'rolling', workAuthorization: 'unknown', submit: true,
    }, 'submission-1'), dependencies);
    expect(submissionResponse.status).toBe(201);
    const submission = await submissionResponse.json() as { submission: { submissionId: string; state: string } };
    expect(submission.submission.state).toBe('pending-review');

    const decisionPath = `/operations/employers/organizations/${orgId}/submissions/${submission.submission.submissionId}/decision`;
    const published = await handleEmployerOperations(request(decisionPath, { decision: 'published' }, 'publish-1'), operations({ store, jobs, actor: 'reviewer', now: at }));
    expect(published.status).toBe(200);
    expect([...jobs.jobs.values()][0]).toMatchObject({ workAuthorizationStatus: 'unknown', sourceReferences: [{ provenance: 'employer-submitted' }] });
    const replay = await handleEmployerOperations(request(decisionPath, { decision: 'published' }, 'publish-1'), operations({ store, jobs, actor: 'reviewer', now: at }));
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect([...jobs.jobs.values()][0]?.sourceReferences).toHaveLength(1);

    const reusedUrlSubmission = await handleEmployerApi(request(`/employer/organizations/${orgId}/submissions`, {
      company: 'Acme', title: 'Backend Engineering Intern', programType: 'internship', discipline: 'software',
      location: 'Remote', workMode: 'remote', season: 'summer-2027', applicationUrl: 'https://careers.acme.test/apply/1',
      deadline: 'rolling', workAuthorization: 'unknown', submit: true,
    }, 'submission-reused-url'), dependencies);
    const reusedUrlBody = await reusedUrlSubmission.json() as { submission: { submissionId: string } };
    const reusedUrlDecision = await handleEmployerOperations(request(
      `/operations/employers/organizations/${orgId}/submissions/${reusedUrlBody.submission.submissionId}/decision`,
      { decision: 'published' }, 'publish-reused-url',
    ), operations({ store, jobs, actor: 'reviewer', now: at }));
    expect(reusedUrlDecision.status).toBe(200);
    expect(jobs.jobs.size).toBe(2);

    const list = await handleEmployerApi(new Request('https://api.test/employer/organizations'), dependencies);
    expect(await list.json()).toMatchObject({ organizations: [{ organizationId: orgId, role: 'owner', verificationState: 'verified' }] });
    const revoked = await handleEmployerOperations(request(`/operations/employers/organizations/${orgId}/verification/decision`,
      { decision: 'revoked', reason: 'Identity evidence was withdrawn' }, 'revoke-1'), operations({ store, jobs, actor: 'reviewer', now: at }));
    expect(revoked.status).toBe(200);
    expect(await reviewedStructuredRegistry(store)).toEqual([]);
    expect((await handleEmployerOperations(request(decisionPath, { decision: 'published' }, 'publish-after-revoke'),
      operations({ store, jobs, actor: 'reviewer', now: at }))).status).toBe(409);
    expect((await handleEmployerOperations(request(`/operations/employers/organizations/${orgId}/verification/decision`,
      { decision: 'verified' }, 'verify-closed'), operations({ store, jobs, actor: 'reviewer', now: at }))).status).toBe(409);
    expect((await handleEmployerApi(request(`/employer/organizations/${orgId}/sources`, {
      provider: 'json-ld', url: 'https://careers.acme.test/other',
    }, 'closed-source'), dependencies)).status).toBe(409);
    database.close();
  });

  it('recovers completed challenge verification and invitation acceptance when the idempotency result was not persisted', async () => {
    const { database, store, jobs } = fixture();
    const timestamp = at().toISOString();
    database.prepare("INSERT INTO auth_users (user_id,email,password_hash,password_salt,verified_at,created_at,updated_at) VALUES ('editor','editor@acme.test','x','x','2026-08-01','2026-08-01','2026-08-01')").run();
    await store.putOrganization({ id: 'recover', name: 'Recover', domain: 'acme.test', state: 'active', createdAt: timestamp, updatedAt: timestamp });
    await store.putMembership({ organizationId: 'recover', userId: 'owner', role: 'owner', createdAt: timestamp, updatedAt: timestamp });
    const ownerDependencies = { store, jobs, userId: 'owner', userEmail: 'owner@acme.test', now: at, validateSourceUrl: async () => {} };

    const challengeResponse = await handleEmployerApi(request('/employer/organizations/recover/challenges', { method: 'dns-txt' }, 'recover-challenge'), ownerDependencies);
    const challengeBody = await challengeResponse.json() as { challenge: { id: string }; token: string };
    expect(await store.consumeChallenge(challengeBody.challenge.id, timestamp)).toBe(true);
    const verified = await handleEmployerApi(request(`/employer/organizations/recover/challenges/${challengeBody.challenge.id}/verify`, {
      token: challengeBody.token,
    }, 'recover-verify'), { ...ownerDependencies, verifyPublishedChallenge: async () => { throw new Error('completed challenges must not refetch'); } });
    expect(verified.status).toBe(200);
    expect(await store.getVerification('recover')).toMatchObject({ state: 'review-pending', challengeId: challengeBody.challenge.id });
    expect(await store.idempotencyResult('recover', 'challenge.verify', 'recover-verify')).toEqual({ verificationState: 'review-pending' });
    await store.putVerification({ organizationId: 'recover', state: 'verified', updatedAt: timestamp, verifiedAt: timestamp, expiresAt: '2027-02-22T12:00:00.000Z' });
    expect((await handleEmployerApi(request(`/employer/organizations/recover/challenges/${challengeBody.challenge.id}/verify`, {
      token: challengeBody.token,
    }, 'recover-verify-late'), ownerDependencies)).status).toBe(200);
    expect(await store.getVerification('recover')).toMatchObject({ state: 'verified' });

    await store.putInvitation({ id: 'accepted', organizationId: 'recover', email: 'editor@acme.test', role: 'editor', tokenHash: await import('../src/employer/index.js').then(({ hashChallengeToken }) => hashChallengeToken('accepted-token')),
      createdAt: timestamp, expiresAt: '2026-09-01T00:00:00.000Z', acceptedAt: timestamp });
    await store.putMembership({ organizationId: 'recover', userId: 'editor', role: 'editor', createdAt: timestamp, updatedAt: timestamp });
    const accepted = await handleEmployerApi(request('/employer/invitations/accepted-token/accept', {}, 'recover-invite'),
      { ...ownerDependencies, userId: 'editor', userEmail: 'editor@acme.test' });
    expect(accepted.status).toBe(200);
    expect(await store.idempotencyResult('recover', 'invitation.accept', 'recover-invite')).toEqual({ organizationId: 'recover', role: 'editor' });
    database.close();
  });

  it('keeps editor and organization permissions isolated', async () => {
    const { database, store, jobs } = fixture();
    const now = at().toISOString();
    await store.putOrganization({ id: 'org-one', name: 'One', domain: 'one.test', state: 'active', createdAt: now, updatedAt: now });
    await store.putOrganization({ id: 'org-two', name: 'Two', domain: 'two.test', state: 'active', createdAt: now, updatedAt: now });
    await store.putMembership({ organizationId: 'org-one', userId: 'owner', role: 'editor', createdAt: now, updatedAt: now });
    const dependencies = { store, jobs, userId: 'owner', userEmail: 'owner@acme.test', now: at, validateSourceUrl: async () => {} };
    expect((await handleEmployerApi(request('/employer/organizations/org-one/challenges', { method: 'dns-txt' }, 'no-owner'), dependencies)).status).toBe(403);
    expect((await handleEmployerApi(new Request('https://api.test/employer/organizations/org-two'), dependencies)).status).toBe(404);
    database.close();
  });
});
