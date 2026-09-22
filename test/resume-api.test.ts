import { describe, expect, it, vi } from 'vitest';
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

  it('supports the specified resolve, recommendation, decision, and finalization routes', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const bank = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank', { kind: 'skill', content: 'TypeScript' }))).body) as { bankItemId: string; revision: number };
    await handler(event('student', 'PATCH', `/me/resume-bank/${bank.bankItemId}`, { revision: bank.revision, verified: true }));
    const profile = JSON.parse((await handler(event('student', 'POST', '/me/resume-profiles', { name: 'Web', tags: ['typescript'], bankItemIds: [bank.bankItemId], sectionOrder: [], template: 'clean-standard' }))).body) as { profileId: string };
    const pending = JSON.parse((await handler(event('student', 'POST', '/me/resume-jobs/resolve', { url: 'https://careers.example.test/jobs/1' }))).body) as { importId: string; revision: number };
    const ready = JSON.parse((await handler(event('student', 'POST', `/me/resume-jobs/${pending.importId}/manual-description`, { revision: pending.revision, description: 'TypeScript engineering role' }))).body) as { importId: string };
    expect(JSON.parse((await handler(event('student', 'POST', `/me/resume-jobs/${ready.importId}/recommendation`))).body)).toMatchObject({ recommendations: [expect.objectContaining({ profileId: profile.profileId })] });
    const draft = JSON.parse((await handler(event('student', 'POST', '/me/resume-drafts', { profileId: profile.profileId, importId: ready.importId }))).body) as { draftId: string; revision: number; changes: Array<{ changeId: string }> };
    const decided = await handler(event('student', 'PATCH', `/me/resume-drafts/${draft.draftId}/changes/${draft.changes[0]!.changeId}`, { revision: draft.revision, decision: 'accepted' }));
    const updated = JSON.parse(decided.body) as { revision: number };
    expect((await handler(event('student', 'POST', `/me/resume-drafts/${draft.draftId}/finalize`, { revision: updated.revision }))).statusCode).toBe(200);
  });

  it('resolves catalog records before cache or asynchronous public-page acquisition', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({
      jobId: 'catalog-job', company: 'Acme', title: 'Platform Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: 'https://careers.example.test/jobs/1', normalizedUrl: 'https://careers.example.test/jobs/1', fingerprint: 'acme-platform',
      compensation: { raw: '' }, sourceReferences: [], open: true, firstSeenAt: '2026-09-22T00:00:00.000Z', lastSeenAt: '2026-09-22T00:00:00.000Z', notification: { smsPending: false, digestPending: false },
    });
    const queued = vi.fn();
    const handler = createApiHandler({
      jobs, users: new MemoryUserStore(), resumeTunerEnabled: true,
      resumeImportQueue: { send: queued },
      resumeImportCache: { get: async () => ({ canonicalUrl: 'https://careers.example.test/jobs/2', description: 'cached role text', contentHash: 'cached' }) },
    });
    const response = await handler(event('student', 'POST', '/me/resume-jobs/resolve', { url: 'https://careers.example.test/jobs/1' }));
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ready', source: 'catalog', title: 'Platform Intern', company: 'Acme' });
    expect(queued).not.toHaveBeenCalled();
  });

  it('uses a ready shared public-job cache before queuing a fetch', async () => {
    const queued = vi.fn();
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users: new MemoryUserStore(), resumeTunerEnabled: true,
      resumeImportQueue: { send: queued },
      resumeImportCache: { get: async () => ({ canonicalUrl: 'https://careers.example.test/jobs/2', title: 'Cached role', description: 'Public cached job description', contentHash: 'cached' }) },
    });
    const response = await handler(event('student', 'POST', '/me/resume-jobs/resolve', { url: 'https://careers.example.test/jobs/2' }));
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ready', source: 'cache', title: 'Cached role' });
    expect(queued).not.toHaveBeenCalled();
  });

  it('rejects malformed generated changes and falls back to verified deterministic evidence', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'evidence', kind: 'project', content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Web', tags: [], bankItemIds: ['evidence'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'TypeScript dashboard role', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeDraftGenerator: { generate: async () => [{ changeId: 'bad', type: 'add', section: 'Projects', suggestion: 'Claim 999 customers', evidenceIds: ['unknown'], reason: 'bad' }] } });
    const response = await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }));
    expect(JSON.parse(response.body)).toMatchObject({ changes: [expect.objectContaining({ evidenceIds: ['evidence'] })] });
  });

  it('imports PDF or DOCX extraction as unverified, user-owned bank cards', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'student', documentId: 'resume', fileName: 'resume.pdf', contentType: 'application/pdf', objectKey: 'private/student/resume', createdAt: 'now' });
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => new ArrayBuffer(0) },
      resumeDocumentExtractor: async () => [{ kind: 'project', content: 'Built a dashboard', sourceLocation: 'line 3' }],
    });
    const response = await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }));
    expect(JSON.parse(response.body)).toMatchObject({ items: [expect.objectContaining({ content: 'Built a dashboard', sourceDocumentId: 'resume', sourceLocation: 'line 3', verified: false })] });
  });

  it('finalizes reviewed drafts into private fixed-template TeX artifacts', async () => {
    const users = new MemoryUserStore();
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Technical base', tags: [], bankItemIds: [], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeDraft({ userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [{ changeId: 'change', type: 'add', section: 'Projects', suggestion: 'Built a dashboard', evidenceIds: ['bank'], reason: 'fit', decision: 'accepted' }], revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now' });
    const putTex = vi.fn(); const putPdf = vi.fn();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeArtifactStorage: { putTex, putPdf, compile: async () => new Uint8Array([37, 80, 68, 70]).buffer, createContentUrl: async () => 'https://example.test/artifact' } });
    const finalized = await handler(event('student', 'POST', '/me/resume-drafts/draft/finalize', { revision: 0 }));
    expect(finalized.statusCode).toBe(200);
    expect(JSON.parse(finalized.body)).toMatchObject({ artifact: { draftId: 'draft', templateVersion: '2026-09-22.1', compilerVersion: 'fixed-template-tex-v1' } });
    expect(putTex).toHaveBeenCalledOnce();
    expect(putPdf).toHaveBeenCalledOnce();
    expect(JSON.parse(finalized.body)).toMatchObject({ artifact: { objectKey: expect.stringMatching(/\.pdf$/u), texObjectKey: expect.stringMatching(/\.tex$/u) } });
  });
});
