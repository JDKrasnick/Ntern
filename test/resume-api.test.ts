import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';

const event = (userId: string | undefined, method: string, rawPath: string, body?: unknown) => ({
  rawPath, body: body === undefined ? undefined : JSON.stringify(body), requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) },
});

describe('resume API ownership and revisions', () => {
  it('stays absent until explicitly enabled', async () => {
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users: new MemoryUserStore() });
    expect((await handler(event('student', 'GET', '/me/resume-bank'))).statusCode).toBe(404);
  });

  it('keeps bank items private and makes verification an optimistic user decision', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, now: () => '2026-09-22T00:00:00.000Z' });
    const created = await handler(event('student-a', 'POST', '/me/resume-bank', { kind: 'bullet', content: 'Built a dashboard', verified: true }));
    expect(created.statusCode).toBe(201);
    const item = JSON.parse(created.body) as { bankItemId: string; verified: boolean; revision: number };
    expect(item.verified).toBe(false);
    expect(JSON.parse((await handler(event('student-b', 'GET', '/me/resume-bank'))).body)).toEqual({ items: [] });
    expect((await handler(event('student-b', 'PATCH', `/me/resume-bank/${item.bankItemId}`, { revision: item.revision, verified: true }))).statusCode).toBe(404);
    const updated = await handler(event('student-a', 'PATCH', `/me/resume-bank/${item.bankItemId}`, { revision: item.revision, verified: true }));
    expect(JSON.parse(updated.body)).toMatchObject({ verified: true, revision: 1 });
    expect((await handler(event('student-a', 'PATCH', `/me/resume-bank/${item.bankItemId}`, { revision: item.revision, verified: false }))).statusCode).toBe(409);
  });

  it('rejects a saved-base reference to somebody else’s bank evidence', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const bank = JSON.parse((await handler(event('owner', 'POST', '/me/resume-bank', { kind: 'skill', content: 'TypeScript' }))).body) as { bankItemId: string };
    const response = await handler(event('other', 'POST', '/me/resume-profiles', { name: 'Web', tags: ['web'], bankItemIds: [bank.bankItemId], sectionOrder: ['skills'], template: 'clean-standard' }));
    expect(response.statusCode).toBe(403);
  });

  it('deletes only the owner profile at the current revision', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const created = await handler(event('owner', 'POST', '/me/resume-profiles', { name: 'Web', tags: ['web'], bankItemIds: [], sectionOrder: ['skills'], template: 'clean-standard' }));
    const profile = JSON.parse(created.body) as { profileId: string; revision: number };
    expect((await handler(event('other', 'DELETE', `/me/resume-profiles/${profile.profileId}`, { revision: profile.revision }))).statusCode).toBe(404);
    expect((await handler(event('owner', 'DELETE', `/me/resume-profiles/${profile.profileId}`, { revision: profile.revision + 1 }))).statusCode).toBe(409);
    expect((await handler(event('owner', 'DELETE', `/me/resume-profiles/${profile.profileId}`, { revision: profile.revision }))).statusCode).toBe(204);
    expect((await handler(event('owner', 'GET', `/me/resume-profiles/${profile.profileId}`))).statusCode).toBe(404);
  });

  it('keeps manual job text private and generates only verified, selected evidence', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, now: () => '2026-09-22T00:00:00.000Z' });
    expect((await handler(event('student', 'POST', '/me/resume-imports', { url: 'http://127.0.0.1/private' }))).statusCode).toBe(400);
    const bank = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank', { kind: 'project', content: 'Built a TypeScript dashboard' }))).body) as { bankItemId: string; revision: number };
    await handler(event('student', 'PATCH', `/me/resume-bank/${bank.bankItemId}`, { revision: bank.revision, verified: true }));
    const profile = JSON.parse((await handler(event('student', 'POST', '/me/resume-profiles', { name: 'Web', tags: [], bankItemIds: [bank.bankItemId], sectionOrder: ['projects'], template: 'clean-standard' }))).body) as { profileId: string };
    const imported = JSON.parse((await handler(event('student', 'POST', '/me/resume-imports', { url: 'https://careers.example.test/jobs/1', manualDescription: 'Seeking TypeScript engineers for a dashboard.' }))).body) as { importId: string };
    const draft = await handler(event('student', 'POST', '/me/resume-drafts', { profileId: profile.profileId, importId: imported.importId }));
    expect(draft.statusCode).toBe(201);
    const value = JSON.parse(draft.body) as { changes: Array<{ evidenceIds: string[]; suggestion: string }> };
    expect(value.changes).toEqual([expect.objectContaining({ evidenceIds: [bank.bankItemId], suggestion: 'Built a TypeScript dashboard' })]);
    expect((await handler(event('other', 'GET', `/me/resume-imports/${imported.importId}`))).statusCode).toBe(404);
  });
});
