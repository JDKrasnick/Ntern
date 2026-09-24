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

  it('publishes fixed templates and validates typed parent details', async () => {
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users: new MemoryUserStore(), resumeTunerEnabled: true });
    const templates = await handler(event('student', 'GET', '/resume-templates'));
    expect(JSON.parse(templates.body)).toMatchObject({ templates: [
      { template: 'jake-technical', displayName: "Jake's Technical" },
      { template: 'clean-standard' },
      { template: 'research-academic' },
      { template: 'project-compact' },
    ] });
    const project = await handler(event('student', 'POST', '/me/resume-bank', {
      kind: 'project', content: 'Ntern | Internship radar', details: { name: 'Ntern', tagline: 'Internship radar', technologies: ['TypeScript', 'Cloudflare Workers'] },
    }));
    expect(JSON.parse(project.body)).toMatchObject({ kind: 'project', details: { name: 'Ntern', tagline: 'Internship radar', technologies: ['TypeScript', 'Cloudflare Workers'] } });
    expect((await handler(event('student', 'POST', '/me/resume-bank', {
      kind: 'project', content: 'Invalid', details: { name: 'Invalid', technologies: 'TypeScript' },
    }))).statusCode).toBe(400);
  });

  it('keeps trusted source items private and allows optimistic source-status edits', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, now: () => '2026-09-22T00:00:00.000Z' });
    const project = JSON.parse((await handler(event('student-a', 'POST', '/me/resume-bank', { kind: 'project', content: 'Dashboard project' }))).body) as { bankItemId: string };
    const created = await handler(event('student-a', 'POST', '/me/resume-bank', { kind: 'bullet', parent: { kind: 'project', bankItemId: project.bankItemId }, content: 'Built a dashboard', verified: true }));
    expect(created.statusCode).toBe(201);
    const item = JSON.parse(created.body) as { bankItemId: string; verified: boolean; revision: number };
    expect(item.verified).toBe(true);
    expect(JSON.parse((await handler(event('student-b', 'GET', '/me/resume-bank'))).body)).toEqual({ items: [] });
    expect((await handler(event('student-b', 'PATCH', `/me/resume-bank/${item.bankItemId}`, { revision: item.revision, verified: true }))).statusCode).toBe(404);
    const updated = await handler(event('student-a', 'PATCH', `/me/resume-bank/${item.bankItemId}`, { revision: item.revision, verified: false }));
    expect(JSON.parse(updated.body)).toMatchObject({ verified: false, revision: 1 });
    expect((await handler(event('student-a', 'PATCH', `/me/resume-bank/${item.bankItemId}`, { revision: item.revision, verified: true }))).statusCode).toBe(409);
  });

  it('requires immutable, owned, kind-correct parent pointers for bullets', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const ownerProject = JSON.parse((await handler(event('owner', 'POST', '/me/resume-bank', { kind: 'project', content: 'Owner project' }))).body) as { bankItemId: string };
    const otherProject = JSON.parse((await handler(event('other', 'POST', '/me/resume-bank', { kind: 'project', content: 'Other project' }))).body) as { bankItemId: string };
    expect((await handler(event('owner', 'POST', '/me/resume-bank', { kind: 'bullet', content: 'Orphan bullet' }))).statusCode).toBe(400);
    expect((await handler(event('owner', 'POST', '/me/resume-bank', { kind: 'bullet', parent: { kind: 'project', bankItemId: otherProject.bankItemId }, content: 'Cross-user bullet' }))).statusCode).toBe(400);
    expect((await handler(event('owner', 'POST', '/me/resume-bank', { kind: 'bullet', parent: { kind: 'role', bankItemId: ownerProject.bankItemId }, content: 'Wrong-kind bullet' }))).statusCode).toBe(400);
    const bullet = JSON.parse((await handler(event('owner', 'POST', '/me/resume-bank', { kind: 'bullet', parent: { kind: 'project', bankItemId: ownerProject.bankItemId }, content: 'Owned bullet' }))).body) as { bankItemId: string; revision: number };
    expect((await handler(event('owner', 'PATCH', `/me/resume-bank/${bullet.bankItemId}`, { revision: bullet.revision, parent: { kind: 'project', bankItemId: otherProject.bankItemId } }))).statusCode).toBe(400);
  });

  it('requires saved bases to select a bullet together with its parent', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const project = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank', { kind: 'project', content: 'Compiler' }))).body) as { bankItemId: string };
    const bullet = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank', { kind: 'bullet', parent: { kind: 'project', bankItemId: project.bankItemId }, content: 'Built parser' }))).body) as { bankItemId: string };
    expect((await handler(event('student', 'POST', '/me/resume-profiles', { name: 'Invalid', bankItemIds: [bullet.bankItemId], template: 'clean-standard' }))).statusCode).toBe(403);
    expect((await handler(event('student', 'POST', '/me/resume-profiles', { name: 'Valid', bankItemIds: [project.bankItemId, bullet.bankItemId], template: 'clean-standard' }))).statusCode).toBe(201);
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
    const value = JSON.parse(draft.body) as { changes: Array<{ evidenceIds: string[]; original: string; type: string }> };
    expect(value.changes).toEqual([expect.objectContaining({ evidenceIds: [bank.bankItemId], original: 'Built a TypeScript dashboard', type: 'move' })]);
    expect((await handler(event('other', 'GET', `/me/resume-imports/${imported.importId}`))).statusCode).toBe(404);
  });

  it('exposes the current plan and enforces the free monthly draft allowance', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'evidence', kind: 'project', content: 'Built a TypeScript service', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Technical base', tags: [], bankItemIds: ['evidence'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'TypeScript engineering role', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const generate = vi.fn(async () => []);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, now: () => '2026-09-23T00:00:00.000Z', resumeDraftGenerator: { generate } });

    expect(JSON.parse((await handler(event('student', 'GET', '/me/subscription'))).body)).toMatchObject({ tier: 'free', plan: { priceUsdMonthly: 0, tailoredDraftsPerMonth: 2 }, usage: { period: '2026-09', used: 0, remaining: 2 } });
    expect((await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }))).statusCode).toBe(201);
    expect((await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }))).statusCode).toBe(201);
    const limited = await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }));
    expect(limited.statusCode).toBe(402);
    expect(JSON.parse(limited.body)).toMatchObject({ code: 'RESUME_SUBSCRIPTION_LIMIT_REACHED', subscription: { usage: { used: 2, remaining: 0 } } });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('supports the specified resolve, recommendation, decision, and finalization routes', async () => {
    const users = new MemoryUserStore();
    await users.putProfile({ userId: 'student', contact: { name: 'Student', email: 'student@example.test' }, location: 'Remote', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeArtifactStorage: {
      putTex: async () => undefined, putPdf: async () => undefined, compile: async () => ({ pdf: new Uint8Array([37, 80, 68, 70]).buffer, pageCount: 1, previewPngs: [] }),
    } });
    const bank = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank', { kind: 'skill', content: 'TypeScript' }))).body) as { bankItemId: string; revision: number };
    await handler(event('student', 'PATCH', `/me/resume-bank/${bank.bankItemId}`, { revision: bank.revision, verified: true }));
    const profile = JSON.parse((await handler(event('student', 'POST', '/me/resume-profiles', { name: 'Web', tags: ['typescript'], bankItemIds: [bank.bankItemId], sectionOrder: [], template: 'clean-standard' }))).body) as { profileId: string };
    const pending = JSON.parse((await handler(event('student', 'POST', '/me/resume-jobs/resolve', { url: 'https://careers.example.test/jobs/1' }))).body) as { importId: string; revision: number };
    const ready = JSON.parse((await handler(event('student', 'POST', `/me/resume-jobs/${pending.importId}/manual-description`, { revision: pending.revision, description: 'TypeScript engineering role' }))).body) as { importId: string };
    expect(JSON.parse((await handler(event('student', 'POST', `/me/resume-jobs/${ready.importId}/recommendation`))).body)).toMatchObject({ recommendations: [expect.objectContaining({ profileId: profile.profileId })] });
    const draft = JSON.parse((await handler(event('student', 'POST', '/me/resume-drafts', { profileId: profile.profileId, importId: ready.importId }))).body) as { draftId: string; revision: number; changes: Array<{ changeId: string }> };
    const decided = await handler(event('student', 'PATCH', `/me/resume-drafts/${draft.draftId}/changes/${draft.changes[0]!.changeId}`, { revision: draft.revision, decision: 'accepted' }));
    const updated = JSON.parse(decided.body) as { revision: number; status: string };
    expect(updated.status).toBe('reviewing');
    const finalized = await handler(event('student', 'POST', `/me/resume-drafts/${draft.draftId}/finalize`, { revision: updated.revision }));
    expect(finalized.statusCode).toBe(200);
    expect(JSON.parse(finalized.body)).toMatchObject({ draft: { status: 'finalized' }, artifact: { objectKey: expect.stringMatching(/\.pdf$/u) } });
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

  it('adds isolated semantic similarity to the deterministic saved-base recommendation', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      resumeSemanticIndex: { index: async () => undefined, remove: async () => undefined, scores: async () => new Map([['semantic-evidence', 0.9]]) } });
    const bank = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank', { kind: 'project', content: 'Built a compiler' }))).body) as { bankItemId: string; revision: number };
    await handler(event('student', 'PATCH', `/me/resume-bank/${bank.bankItemId}`, { revision: bank.revision, verified: true }));
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'semantic-evidence', kind: 'project', content: 'Implemented mobile user interfaces', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    const profile = JSON.parse((await handler(event('student', 'POST', '/me/resume-profiles', { name: 'Mobile', tags: [], bankItemIds: ['semantic-evidence'], sectionOrder: [], template: 'clean-standard' }))).body) as { profileId: string };
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'Software internship', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const response = JSON.parse((await handler(event('student', 'POST', '/me/resume-jobs/job/recommendation'))).body) as { recommendations: Array<{ profileId: string; score: number; explanation: string }> };
    expect(response.recommendations).toEqual([expect.objectContaining({ profileId: profile.profileId, score: 23, explanation: expect.stringContaining('Semantic similarity: 90%') })]);
  });

  it('rejects malformed generated changes and falls back to verified deterministic evidence', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'evidence', kind: 'project', content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Web', tags: [], bankItemIds: ['evidence'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'TypeScript dashboard role', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeDraftGenerator: { generate: async () => [{ changeId: 'bad', type: 'add', target: { kind: 'project', bankItemId: 'evidence' }, section: 'Projects', suggestion: 'Claim 999 customers', evidenceIds: ['unknown'], reason: 'bad' }] } });
    const response = await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }));
    expect(JSON.parse(response.body)).toMatchObject({ changes: [expect.objectContaining({ evidenceIds: ['evidence'] })] });
  });

  it('retrieves a bounded relevant slice from a large Technical base for generation', async () => {
    const users = new MemoryUserStore();
    const ids = Array.from({ length: 140 }, (_, index) => `evidence-${index}`);
    for (const [index, bankItemId] of ids.entries()) await users.putResumeBankItem({
      userId: 'student', bankItemId, kind: 'project', content: index < 100 ? `Built TypeScript service ${index}` : `Unrelated archive ${index}`,
      verified: true, revision: 0, createdAt: 'now', updatedAt: 'now',
    });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Technical base', tags: [], bankItemIds: ids, sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', title: 'TypeScript Engineer', description: 'Build TypeScript services', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const received: Array<Array<{ content: string }>> = [];
    const generate = vi.fn(async (input: { bankItems: Array<{ content: string }> }) => { received.push(input.bankItems); return []; });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeDraftGenerator: { generate } });
    const response = await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }));
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ changes: expect.arrayContaining([expect.objectContaining({ evidenceIds: ['evidence-0'] })]) });
    const supplied = received[0]!;
    expect(supplied).toHaveLength(80);
    expect(supplied.every((item) => item.content.includes('TypeScript'))).toBe(true);
  });

  it('imports PDF or DOCX extraction as trusted, user-owned source cards', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'student', documentId: 'resume', fileName: 'resume.pdf', contentType: 'application/pdf', objectKey: 'private/student/resume', createdAt: 'now' });
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => new ArrayBuffer(0) },
      resumeDocumentExtractor: async () => [{ localId: 'line-3', kind: 'project', content: 'Built a dashboard', sourceLocation: 'line 3' }],
    });
    const response = await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }));
    expect(JSON.parse(response.body)).toMatchObject({ items: [expect.objectContaining({ content: 'Built a dashboard', sourceDocumentId: 'resume', sourceLocation: 'line 3', verified: true })] });
  });

  it('finalizes reviewed drafts into private fixed-template PDF artifacts with applicant contact details', async () => {
    const users = new MemoryUserStore();
    await users.putProfile({ userId: 'student', contact: { name: 'Student Name', email: 'student@example.test' }, location: 'Ithaca, NY', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'bank', kind: 'project', content: 'Built a dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Technical base', tags: [], bankItemIds: ['bank'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeDraft({ userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [{ changeId: 'change', type: 'add', target: { kind: 'project', bankItemId: 'bank' }, section: 'Projects', suggestion: 'Built a dashboard', evidenceIds: ['bank'], reason: 'fit', decision: 'accepted' }], revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now' });
    const putTex = vi.fn(); const putPdf = vi.fn(); const putPreview = vi.fn();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeArtifactStorage: { putTex, putPdf, putPreview, compile: async () => ({ pdf: new Uint8Array([37, 80, 68, 70]).buffer, pageCount: 1, previewPngs: [new Uint8Array([137, 80, 78, 71]).buffer] }) } });
    const finalized = await handler(event('student', 'POST', '/me/resume-drafts/draft/finalize', { revision: 0 }));
    expect(finalized.statusCode).toBe(200);
    expect(JSON.parse(finalized.body)).toMatchObject({ artifact: { draftId: 'draft', templateVersion: '2026-09-23.3', compilerVersion: 'typed-fixed-template-tex-v2' } });
    expect(putTex).toHaveBeenCalledOnce();
    expect(putTex.mock.calls[0]?.[1]).toContain('Student Name');
    expect(putTex.mock.calls[0]?.[1]).toContain('student@example.test');
    expect(putTex.mock.calls[0]?.[1]).not.toContain('Technical base');
    expect(putPdf).toHaveBeenCalledOnce();
    expect(putPreview).toHaveBeenCalledOnce();
    expect(JSON.parse(finalized.body)).toMatchObject({ artifact: { objectKey: expect.stringMatching(/\.pdf$/u), texObjectKey: expect.stringMatching(/\.tex$/u), pageCount: 1, previewObjectKeys: [expect.stringMatching(/preview-1\.png$/u)] } });
  });

  it('does not finalize a draft when applicant contact details or PDF compilation are unavailable', async () => {
    const users = new MemoryUserStore();
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Technical base', tags: [], bankItemIds: [], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeDraft({ userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [], revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now' });
    const storage = { putTex: async () => undefined, putPdf: async () => undefined, compile: async () => { throw new Error('compiler failed'); } };
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeArtifactStorage: storage });
    expect((await handler(event('student', 'POST', '/me/resume-drafts/draft/finalize', { revision: 0 }))).statusCode).toBe(409);
    expect((await users.getResumeDraft('student', 'draft'))?.status).toBe('reviewing');
    await users.putProfile({ userId: 'student', contact: { name: 'Student', email: 'student@example.test' }, location: 'Remote', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' });
    expect((await handler(event('student', 'POST', '/me/resume-drafts/draft/finalize', { revision: 0 }))).statusCode).toBe(503);
    expect((await users.getResumeDraft('student', 'draft'))?.status).toBe('reviewing');
  });
});
