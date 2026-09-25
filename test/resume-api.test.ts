import { describe, expect, it, vi } from 'vitest';
import { createApiHandler, resumeGenerationEvidence } from '../src/api.js';
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

  it('ranks generation candidates by semantic score when available', () => {
    const common = { userId: 'student', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const job = { importId: 'j', canonicalUrl: 'https://x.test', description: 'unrelated job words', source: 'manual' as const, contentHash: 'h', status: 'ready' as const, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const bank = [
      { ...common, bankItemId: 'a', kind: 'project' as const, content: 'Built a compiler' },
      { ...common, bankItemId: 'b', kind: 'project' as const, content: 'Wrote marketing copy' },
    ];
    // With no keyword overlap, the semantic score decides candidate order and
    // every item still reaches the model.
    const evidence = resumeGenerationEvidence(job, bank, 80, new Map([['b', 0.9]]));
    expect(evidence[0]?.bankItemId).toBe('b');
    expect(evidence).toHaveLength(2);
  });

  it('emits a generation metric for each draft', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'evidence', kind: 'project', content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['evidence'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'TypeScript dashboard role', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect((await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }))).statusCode).toBe(201);
      const line = spy.mock.calls.map((args) => String(args[0])).find((entry) => entry.includes('InternNotifs/Resume'));
      expect(line).toBeDefined();
      expect(JSON.parse(line!)).toMatchObject({ event: 'resume_draft_generation', _aws: { CloudWatchMetrics: [{ Namespace: 'InternNotifs/Resume' }] } });
    } finally { spy.mockRestore(); }
  });

  it('edits an added or rewritten line only when it stays grounded in evidence', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'evidence', kind: 'project', content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['evidence'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeDraft({ userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now', changes: [
      { changeId: 'add', type: 'add', target: { kind: 'project', bankItemId: 'evidence' }, section: 'Projects', suggestion: 'Built a TypeScript dashboard', evidenceIds: ['evidence'], reason: 'r' },
    ] });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const edited = await handler(event('student', 'PATCH', '/me/resume-drafts/draft/changes/add', { revision: 0, suggestion: 'Built a TypeScript dashboard' }));
    expect(edited.statusCode).toBe(200);
    expect((JSON.parse(edited.body) as { changes: Array<{ suggestion?: string }> }).changes[0]?.suggestion).toBe('Built a TypeScript dashboard');
    const unsupported = await handler(event('student', 'PATCH', '/me/resume-drafts/draft/changes/add', { revision: 1, suggestion: 'Led a global security team' }));
    expect(unsupported.statusCode).toBe(400);
  });

  it('retries generation with validation feedback before falling back', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'evidence', kind: 'project', content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['evidence'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'TypeScript dashboard role', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const feedback: Array<string | undefined> = [];
    const generate = vi.fn(async (input: { feedback?: string }) => {
      feedback.push(input.feedback);
      if (!input.feedback) return [{ changeId: 'bad', type: 'add' as const, target: { kind: 'project' as const, bankItemId: 'evidence' }, section: 'Projects', suggestion: 'Led a global security team', evidenceIds: ['evidence'], reason: 'bad' }];
      return [{ changeId: 'good', type: 'add' as const, target: { kind: 'project' as const, bankItemId: 'evidence' }, section: 'Projects', suggestion: 'Built a TypeScript dashboard', evidenceIds: ['evidence'], reason: 'fits' }];
    });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeDraftGenerator: { generate }, now: () => '2026-09-23T00:00:00.000Z' });
    const response = await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }));
    expect(response.statusCode).toBe(201);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(feedback[1]).toContain('evidence');
    expect((JSON.parse(response.body) as { changes: unknown[] }).changes.length).toBeGreaterThan(0);
  });

  it('drops a duplicate addition instead of discarding the model changes', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'role', kind: 'role', content: 'Northwind — Software Engineering Intern', details: { organization: 'Northwind', title: 'Software Engineering Intern' }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'bullet', kind: 'bullet', parent: { kind: 'role', bankItemId: 'role' }, content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['role', 'bullet'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'TypeScript dashboard role', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const generate = vi.fn(async () => [
      { changeId: 'dup', type: 'add' as const, target: { kind: 'role' as const, bankItemId: 'role' }, section: 'Experience', suggestion: 'Built a TypeScript dashboard', evidenceIds: ['bullet'], reason: 'repeats' },
      { changeId: 'keep', type: 'rewrite' as const, target: { kind: 'bullet' as const, bankItemId: 'bullet', parent: { kind: 'role' as const, bankItemId: 'role' } }, section: 'Experience', original: 'Built a TypeScript dashboard', suggestion: 'Built a TypeScript dashboard', evidenceIds: ['bullet'], reason: 'fits' },
    ]);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeDraftGenerator: { generate } });
    const response = await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }));
    expect(response.statusCode).toBe(201);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((JSON.parse(response.body) as { changes: Array<{ type: string }> }).changes).toEqual([expect.objectContaining({ type: 'rewrite' })]);
  });

  it('keeps the valid changes when one cites unknown evidence', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'role', kind: 'role', content: 'Northwind — Software Engineering Intern', details: { organization: 'Northwind', title: 'Software Engineering Intern' }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'bullet', kind: 'bullet', parent: { kind: 'role', bankItemId: 'role' }, content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['role', 'bullet'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'TypeScript dashboard role', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const target = { kind: 'bullet' as const, bankItemId: 'bullet', parent: { kind: 'role' as const, bankItemId: 'role' } };
    const generate = vi.fn(async () => [
      { changeId: 'bad', type: 'rewrite' as const, target, section: 'Experience', original: 'Built a TypeScript dashboard', suggestion: 'Built a TypeScript dashboard', evidenceIds: ['ghost'], reason: 'invents evidence' },
      { changeId: 'good', type: 'rewrite' as const, target, section: 'Experience', original: 'Built a TypeScript dashboard', suggestion: 'Built a TypeScript dashboard', evidenceIds: ['bullet'], reason: 'fits' },
    ]);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeDraftGenerator: { generate } });
    const response = await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }));
    expect(response.statusCode).toBe(201);
    expect(generate).toHaveBeenCalledTimes(2);
    expect((JSON.parse(response.body) as { changes: Array<{ evidenceIds: string[] }> }).changes).toEqual([expect.objectContaining({ evidenceIds: ['bullet'] })]);
  });

  it('serves aligned review rows for a draft', async () => {
    const users = new MemoryUserStore();
    await users.putProfile({ userId: 'student', contact: { name: 'Student', email: 'student@example.test' }, location: 'Remote', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'project', kind: 'project', content: 'Compiler Lab', details: { name: 'Compiler Lab', technologies: ['TypeScript'] }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['project'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeDraft({ userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now', changes: [
      { changeId: 'rewrite', type: 'rewrite', target: { kind: 'project', bankItemId: 'project' }, section: 'Projects', original: 'Compiler Lab', suggestion: 'Compiler Lab — compiler', evidenceIds: ['project'], reason: 'fits' },
    ] });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const response = await handler(event('student', 'GET', '/me/resume-drafts/draft/review'));
    expect(response.statusCode).toBe(200);
    const rows = (JSON.parse(response.body) as { rows: Array<{ changeId?: string }> }).rows;
    expect(rows.some((row) => row.changeId === 'rewrite')).toBe(true);
  });

  it('renders the original and proposed pages without recompiling per decision', async () => {
    const users = new MemoryUserStore();
    await users.putProfile({ userId: 'student', contact: { name: 'Student', email: 'student@example.test' }, location: 'Remote', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'bank', kind: 'project', content: 'Built a dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['bank'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeDraft({ userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now', changes: [
      { changeId: 'add', type: 'add', target: { kind: 'project', bankItemId: 'bank' }, section: 'Projects', suggestion: 'Built a dashboard', evidenceIds: ['bank'], reason: 'r', decision: 'accepted' },
    ] });
    const compile = vi.fn(async () => ({ pdf: new Uint8Array([37, 80, 68, 70]).buffer, pageCount: 1, previewPngs: [new Uint8Array([137, 80, 78, 71]).buffer] }));
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeArtifactStorage: { putTex: async () => undefined, putPdf: async () => undefined, putPreview: async () => undefined, compile } });
    const preview = await handler(event('student', 'POST', '/me/resume-drafts/draft/preview'));
    expect(preview.statusCode).toBe(200);
    const body = JSON.parse(preview.body) as { artifact: { objectKey: string }; original: { objectKey: string }; rows: unknown[] };
    expect(body.artifact).toMatchObject({ pageCount: 1, objectKey: expect.stringMatching(/\.pdf$/u) });
    expect(body.original).toMatchObject({ pageCount: 1, objectKey: expect.stringMatching(/\.pdf$/u) });
    expect(body.artifact.objectKey).not.toBe(body.original.objectKey);
    expect(body.rows.length).toBeGreaterThan(0);
    // Original + proposal: two compiles for the whole review, never one per decision.
    expect(compile).toHaveBeenCalledTimes(2);
    const draft = JSON.parse((await handler(event('student', 'GET', '/me/resume-drafts/draft'))).body) as { status: string };
    expect(draft.status).toBe('reviewing');
    // The identical proposal compiled for the preview is reused when finalizing.
    const finalized = await handler(event('student', 'POST', '/me/resume-drafts/draft/finalize', { revision: 0 }));
    expect(finalized.statusCode).toBe(200);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('boxes each change on the original and proposed pages from the compiler line boxes', async () => {
    const users = new MemoryUserStore();
    await users.putProfile({ userId: 'student', contact: { name: 'Student', email: 'student@example.test' }, location: 'Remote', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'project', kind: 'project', content: 'Compiler Lab', details: { name: 'Compiler Lab', technologies: ['TypeScript'] }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'bullet', kind: 'bullet', parent: { kind: 'project', bankItemId: 'project' }, content: 'Built a recursive descent parser', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['project', 'bullet'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeDraft({ userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now', changes: [
      { changeId: 'rewrite', type: 'rewrite', target: { kind: 'bullet', bankItemId: 'bullet', parent: { kind: 'project', bankItemId: 'project' } }, section: 'Projects', original: 'Built a recursive descent parser', suggestion: 'Built a parser', evidenceIds: ['bullet'], reason: 'fits' },
    ] });
    const head = { x: 0, y: 0.1, w: 0.4, h: 0.02, text: 'Compiler Lab — TypeScript' };
    const proposalLines = [[head, { x: 0, y: 0.2, w: 0.5, h: 0.02, text: 'Built a parser' }]];
    const originalLines = [[head, { x: 0, y: 0.2, w: 0.65, h: 0.02, text: 'Built a recursive descent parser' }]];
    let call = 0;
    const compile = vi.fn(async () => ({ pdf: new Uint8Array([37, 80, 68, 70]).buffer, pageCount: 1, previewPngs: [new Uint8Array([137, 80, 78, 71]).buffer], lineBoxes: call++ === 0 ? proposalLines : originalLines }));
    const stored = new Map<string, unknown>();
    const storage = { putTex: async () => undefined, putPdf: async () => undefined, putPreview: async () => undefined, putLineBoxes: async (key: string, lines: string) => { stored.set(key, JSON.parse(lines)); }, getLineBoxes: async (key: string) => stored.get(key) as never, compile };
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeArtifactStorage: storage });
    const preview = await handler(event('student', 'POST', '/me/resume-drafts/draft/preview'));
    expect(preview.statusCode).toBe(200);
    const row = (JSON.parse(preview.body) as { rows: Array<{ changeId?: string; beforeBox?: { page: number; x: number; y: number; w: number; h: number }; afterBox?: { page: number; x: number; y: number; w: number; h: number } }> }).rows.find((candidate) => candidate.changeId === 'rewrite');
    expect(row?.beforeBox).toMatchObject({ page: 1, x: 0, y: 0.2 });
    expect(row?.beforeBox?.w).toBeCloseTo(0.65, 4);
    expect(row?.afterBox).toMatchObject({ page: 1, x: 0, y: 0.2 });
    expect(row?.afterBox?.w).toBeCloseTo(0.5, 4);
  });

  it('refunds the monthly allowance when a draft cannot be persisted', async () => {
    class ConflictStore extends MemoryUserStore {
      async putResumeDraft(): Promise<boolean> { return false; }
    }
    const users = new ConflictStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'evidence', kind: 'project', content: 'Built a TypeScript service', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Technical base', tags: [], bankItemIds: ['evidence'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'TypeScript role', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, now: () => '2026-09-23T00:00:00.000Z' });
    expect((await handler(event('student', 'POST', '/me/resume-drafts', { profileId: 'profile', importId: 'job' }))).statusCode).toBe(409);
    expect(JSON.parse((await handler(event('student', 'GET', '/me/subscription'))).body)).toMatchObject({ usage: { used: 0, remaining: 2 } });
  });

  it('deletes a bank parent with its bullets and prunes saved bases', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'project', kind: 'project', content: 'Compiler Lab', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'bullet-a', kind: 'bullet', parent: { kind: 'project', bankItemId: 'project' }, content: 'Built a parser', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'skill', kind: 'skill', content: 'TypeScript', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['project', 'bullet-a', 'skill'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    const remove = vi.fn(async () => undefined);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeSemanticIndex: { index: async () => undefined, remove, scores: async () => new Map() } });
    const response = await handler(event('student', 'DELETE', '/me/resume-bank/project', { revision: 0 }));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ removed: expect.arrayContaining(['project', 'bullet-a']) });
    const bank = JSON.parse((await handler(event('student', 'GET', '/me/resume-bank'))).body) as { items: Array<{ bankItemId: string }> };
    expect(bank.items.map((item) => item.bankItemId)).toEqual(['skill']);
    const profile = (JSON.parse((await handler(event('student', 'GET', '/me/resume-profiles'))).body) as { profiles: Array<{ bankItemIds: string[]; revision: number }> }).profiles[0]!;
    expect(profile.bankItemIds).toEqual(['skill']);
    expect(profile.revision).toBe(1);
    expect(remove).toHaveBeenCalledWith('student', expect.arrayContaining(['project', 'bullet-a']));
  });

  it('rejects a stale bank deletion without removing anything', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'project', kind: 'project', content: 'Compiler Lab', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    expect((await handler(event('student', 'DELETE', '/me/resume-bank/project', { revision: 5 }))).statusCode).toBe(409);
    const bank = JSON.parse((await handler(event('student', 'GET', '/me/resume-bank'))).body) as { items: unknown[] };
    expect(bank.items).toHaveLength(1);
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

  it('uses trusted catalog title and company but still acquires the full description', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({
      jobId: 'catalog-job', company: 'Acme', title: 'Platform Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: 'https://careers.example.test/jobs/1', normalizedUrl: 'https://careers.example.test/jobs/1', fingerprint: 'acme-platform',
      compensation: { raw: '' }, sourceReferences: [], open: true, firstSeenAt: '2026-09-22T00:00:00.000Z', lastSeenAt: '2026-09-22T00:00:00.000Z', notification: { smsPending: false, digestPending: false },
    });
    const queued = vi.fn(async () => undefined);
    const handler = createApiHandler({
      jobs, users: new MemoryUserStore(), resumeTunerEnabled: true,
      resumeImportQueue: { send: queued },
      resumeImportCache: { get: async () => undefined },
    });
    const response = await handler(event('student', 'POST', '/me/resume-jobs/resolve', { url: 'https://careers.example.test/jobs/1' }));
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'pending', source: 'catalog', title: 'Platform Intern', company: 'Acme',
      // A provisional, non-empty summary keeps the import readable while the
      // full public description is acquired.
      description: expect.stringContaining('Platform Intern at Acme.'),
    });
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it('prefers a ready shared public-job cache over the compact catalog summary', async () => {
    const jobs = new MemoryInternshipStore();
    await jobs.putInternship({
      jobId: 'catalog-job', company: 'Acme', title: 'Platform Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: 'https://careers.example.test/jobs/1', normalizedUrl: 'https://careers.example.test/jobs/1', fingerprint: 'acme-platform',
      compensation: { raw: '' }, sourceReferences: [], open: true, firstSeenAt: '2026-09-22T00:00:00.000Z', lastSeenAt: '2026-09-22T00:00:00.000Z', notification: { smsPending: false, digestPending: false },
    });
    const queued = vi.fn(async () => undefined);
    const handler = createApiHandler({
      jobs, users: new MemoryUserStore(), resumeTunerEnabled: true,
      resumeImportQueue: { send: queued },
      resumeImportCache: { get: async () => ({ canonicalUrl: 'https://careers.example.test/jobs/1', title: 'Platform Intern', description: 'Full public cached job description', contentHash: 'cached' }) },
    });
    const response = await handler(event('student', 'POST', '/me/resume-jobs/resolve', { url: 'https://careers.example.test/jobs/1' }));
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ready', source: 'cache', title: 'Platform Intern', description: 'Full public cached job description' });
    expect(queued).not.toHaveBeenCalled();
  });

  it('queues an unknown employer URL without a cached description', async () => {
    const queued = vi.fn(async () => undefined);
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users: new MemoryUserStore(), resumeTunerEnabled: true,
      resumeImportQueue: { send: queued },
      resumeImportCache: { get: async () => undefined },
    });
    const response = await handler(event('student', 'POST', '/me/resume-jobs/resolve', { url: 'https://careers.example.test/jobs/2' }));
    expect(JSON.parse(response.body)).toMatchObject({ status: 'pending', description: '' });
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it('uses a ready shared public-job cache for an unknown employer URL before queuing', async () => {
    const queued = vi.fn(async () => undefined);
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users: new MemoryUserStore(), resumeTunerEnabled: true,
      resumeImportQueue: { send: queued },
      resumeImportCache: { get: async () => ({ canonicalUrl: 'https://careers.example.test/jobs/2', title: 'Cached role', description: 'Public cached job description', contentHash: 'cached' }) },
    });
    const response = await handler(event('student', 'POST', '/me/resume-jobs/resolve', { url: 'https://careers.example.test/jobs/2' }));
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ready', source: 'cache', title: 'Cached role' });
    expect(queued).not.toHaveBeenCalled();
  });

  it('adds isolated semantic similarity to the deterministic saved-base recommendation for paid plans', async () => {
    const users = new MemoryUserStore();
    await users.putResumeSubscription({ userId: 'student', tier: 'plus', status: 'active', provider: 'apple', updatedAt: 'now' });
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

  it('keeps semantic ranking paid-only and warms the derived cache once on upgrade', async () => {
    const users = new MemoryUserStore();
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'evidence', kind: 'project', content: 'Implemented mobile user interfaces', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Mobile', tags: [], bankItemIds: ['evidence'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/job', description: 'Software internship', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const scores = vi.fn(async () => new Map<string, number>());
    const indexMany = vi.fn(async () => undefined);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeSemanticIndex: { index: async () => undefined, remove: async () => undefined, scores, indexMany } });
    // Free account: the derived index is never queried.
    const free = JSON.parse((await handler(event('student', 'POST', '/me/resume-jobs/job/recommendation'))).body) as { recommendations: Array<{ explanation: string }> };
    expect(scores).not.toHaveBeenCalled();
    expect(free.recommendations[0]?.explanation).not.toContain('Semantic');
    // Paid account with a cold cache: warm it once, then score.
    await users.putResumeSubscription({ userId: 'student', tier: 'pro', status: 'active', provider: 'apple', updatedAt: 'now' });
    scores.mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map([['evidence', 0.5]]));
    const paid = JSON.parse((await handler(event('student', 'POST', '/me/resume-jobs/job/recommendation'))).body) as { recommendations: Array<{ explanation: string }> };
    expect(indexMany).toHaveBeenCalledOnce();
    expect(paid.recommendations[0]?.explanation).toContain('Semantic similarity: 50%');
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

  it('imports a whole document with one bank read and a single batched write', async () => {
    class CountingStore extends MemoryUserStore {
      listCalls = 0;
      batchCalls = 0;
      async listResumeBank(userId: string) { this.listCalls += 1; return super.listResumeBank(userId); }
      async putResumeBankItems(values: Parameters<MemoryUserStore['putResumeBankItems']>[0]) { this.batchCalls += 1; return super.putResumeBankItems(values); }
    }
    const users = new CountingStore();
    await users.putDocument({ userId: 'student', documentId: 'resume', fileName: 'resume.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey: 'private/student/resume', createdAt: 'now' });
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => new ArrayBuffer(0) },
      resumeDocumentExtractor: async () => [
        { localId: 'parent', kind: 'project', content: 'Compiler Lab', sourceLocation: 'line 2' },
        { localId: 'bullet-a', kind: 'bullet', parent: { kind: 'project', localId: 'parent' }, content: 'Built a parser', sourceLocation: 'line 3' },
        { localId: 'bullet-b', kind: 'bullet', parent: { kind: 'project', localId: 'parent' }, content: 'Added type checking', sourceLocation: 'line 4' },
      ],
    });
    const response = await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }));
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ kind: 'project', content: 'Compiler Lab' }),
      expect.objectContaining({ kind: 'bullet', content: 'Built a parser' }),
      expect.objectContaining({ kind: 'bullet', content: 'Added type checking' }),
    ]) });
    // Two bounded bank reads total (dedup resolution plus one merged validation),
    // never one per item; the write is a single batch.
    expect(users.listCalls).toBe(2);
    expect(users.batchCalls).toBe(1);
    const persisted = JSON.parse((await handler(event('student', 'GET', '/me/resume-bank'))).body) as { items: unknown[] };
    expect(persisted.items).toHaveLength(3);
  });

  it('de-duplicates a re-imported résumé against the existing bank and reuses its items', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'student', documentId: 'resume', fileName: 'resume.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey: 'private/student/resume', createdAt: 'now' });
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => new ArrayBuffer(0) },
      resumeDocumentExtractor: async () => [
        { localId: 'parent', kind: 'project', content: 'Compiler Lab', sourceLocation: 'line 2' },
        { localId: 'bullet-a', kind: 'bullet', parent: { kind: 'project', localId: 'parent' }, content: 'Built a parser', sourceLocation: 'line 3' },
      ],
    });
    const first = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }))).body) as { items: Array<{ bankItemId: string }> };
    const second = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }))).body) as { items: Array<{ bankItemId: string }> };
    // Re-import resolves to the same stored items: no new rows, same identifiers.
    expect(second.items.map((item) => item.bankItemId).sort()).toEqual(first.items.map((item) => item.bankItemId).sort());
    const persisted = JSON.parse((await handler(event('student', 'GET', '/me/resume-bank'))).body) as { items: unknown[] };
    expect(persisted.items).toHaveLength(2);
  });

  it('keeps a genuinely new bullet on a reused parent during a partial re-import', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'student', documentId: 'resume', fileName: 'resume.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey: 'private/student/resume', createdAt: 'now' });
    let includeExtra = false;
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => new ArrayBuffer(0) },
      resumeDocumentExtractor: async () => [
        { localId: 'parent', kind: 'project', content: 'Compiler Lab', sourceLocation: 'line 2' },
        { localId: 'bullet-a', kind: 'bullet', parent: { kind: 'project', localId: 'parent' }, content: 'Built a parser', sourceLocation: 'line 3' },
        ...(includeExtra ? [{ localId: 'bullet-b', kind: 'bullet' as const, parent: { kind: 'project' as const, localId: 'parent' }, content: 'Added type checking', sourceLocation: 'line 4' }] : []),
      ],
    });
    const first = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }))).body) as { items: Array<{ kind: string; content: string; bankItemId: string }> };
    const parentId = first.items.find((item) => item.kind === 'project')!.bankItemId;
    includeExtra = true;
    const second = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }))).body) as { items: Array<{ kind: string; content: string; bankItemId: string; parent?: { bankItemId: string } }> };
    // The reused parent keeps its identifier; only the new bullet is added.
    expect(second.items.find((item) => item.kind === 'project')?.bankItemId).toBe(parentId);
    expect(second.items.find((item) => item.content === 'Added type checking')).toMatchObject({ kind: 'bullet', parent: { bankItemId: parentId } });
    const persisted = JSON.parse((await handler(event('student', 'GET', '/me/resume-bank'))).body) as { items: unknown[] };
    expect(persisted.items).toHaveLength(3);
  });

  it('indexes newly imported items in one batch and only for paid plans', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'student', documentId: 'resume', fileName: 'resume.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey: 'private/student/resume', createdAt: 'now' });
    const indexMany = vi.fn((...args: unknown[]) => { void args; return Promise.resolve(); });
    let withExtra = false;
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => new ArrayBuffer(0) },
      resumeSemanticIndex: { index: async () => undefined, indexMany, remove: async () => undefined, scores: async () => new Map() },
      resumeDocumentExtractor: async () => [
        { localId: 'parent', kind: 'project', content: 'Compiler Lab', sourceLocation: 'line 2' },
        ...(withExtra ? [{ localId: 'bullet', kind: 'bullet' as const, parent: { kind: 'project' as const, localId: 'parent' }, content: 'Built a parser', sourceLocation: 'line 3' }] : []),
      ],
    });
    await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }));
    expect(indexMany).not.toHaveBeenCalled();
    await users.putResumeSubscription({ userId: 'student', tier: 'plus', status: 'active', provider: 'apple', updatedAt: 'now' });
    withExtra = true;
    await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }));
    expect(indexMany).toHaveBeenCalledOnce();
    // Only the genuinely new bullet is embedded; the reused project is skipped.
    expect(indexMany.mock.calls[0]![0]).toHaveLength(1);
  });

  it('clears a stale derived vector when a free plan edits a verified item', async () => {
    const users = new MemoryUserStore();
    const remove = vi.fn(async () => undefined);
    const index = vi.fn(async () => undefined);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      resumeSemanticIndex: { index, remove, scores: async () => new Map() } });
    const item = JSON.parse((await handler(event('student', 'POST', '/me/resume-bank', { kind: 'project', content: 'Built a compiler' }))).body) as { bankItemId: string; revision: number };
    // A free plan must not index the edit, but must clear any previous vector so
    // the derived cache can never contradict the authoritative content.
    const patched = await handler(event('student', 'PATCH', `/me/resume-bank/${item.bankItemId}`, { revision: item.revision, verified: true, content: 'Built a query compiler' }));
    expect(patched.statusCode).toBe(200);
    expect(index).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('student', [item.bankItemId]);
    // A paid plan re-indexes the same edit instead of clearing it.
    await users.putResumeSubscription({ userId: 'student', tier: 'plus', status: 'active', provider: 'apple', updatedAt: 'now' });
    const revision = JSON.parse(patched.body).revision as number;
    await handler(event('student', 'PATCH', `/me/resume-bank/${item.bankItemId}`, { revision, verified: true, content: 'Built a query planner' }));
    expect(index).toHaveBeenCalledTimes(1);
  });

  it('reports the résumé document cap instead of failing silently', async () => {
    class CappedStore extends MemoryUserStore {
      async putDocument(): Promise<void> { throw new Error('Document storage quota reached'); }
    }
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users: new CappedStore(), resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => 'https://upload.test', createDownloadUrl: async () => '', deleteObject: async () => undefined },
    });
    const response = await handler(event('student', 'POST', '/me/documents', { fileName: 'resume.pdf', contentType: 'application/pdf' }));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).message).toContain('5 résumé documents');
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
    expect(JSON.parse(finalized.body)).toMatchObject({ artifact: { draftId: 'draft', templateVersion: '2026-09-23.4', compilerVersion: 'typed-fixed-template-tex-v2' } });
    expect(putTex).toHaveBeenCalledOnce();
    expect(putTex.mock.calls[0]?.[1]).toContain('Student Name');
    expect(putTex.mock.calls[0]?.[1]).toContain('student@example.test');
    expect(putTex.mock.calls[0]?.[1]).not.toContain('Technical base');
    expect(putPdf).toHaveBeenCalledOnce();
    expect(putPreview).toHaveBeenCalledOnce();
    expect(JSON.parse(finalized.body)).toMatchObject({ artifact: { objectKey: expect.stringMatching(/\.pdf$/u), texObjectKey: expect.stringMatching(/\.tex$/u), pageCount: 1, previewObjectKeys: [expect.stringMatching(/preview-1\.png$/u)] } });
  });

  it('reuses one compiled artifact for content-identical drafts instead of recompiling', async () => {
    const users = new MemoryUserStore();
    await users.putProfile({ userId: 'student', contact: { name: 'Student Name', email: 'student@example.test' }, location: 'Ithaca, NY', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' });
    await users.putResumeBankItem({ userId: 'student', bankItemId: 'bank', kind: 'project', content: 'Built a dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Technical base', tags: [], bankItemIds: ['bank'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    const changes = [{ changeId: 'change', type: 'add' as const, target: { kind: 'project' as const, bankItemId: 'bank' }, section: 'Projects', suggestion: 'Built a dashboard', evidenceIds: ['bank'], reason: 'fit', decision: 'accepted' as const }];
    for (const draftId of ['draft-a', 'draft-b']) await users.putResumeDraft({ userId: 'student', draftId, profileId: 'profile', importId: 'job', changes, revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now' });
    const compile = vi.fn(async () => ({ pdf: new Uint8Array([37, 80, 68, 70]).buffer, pageCount: 1, previewPngs: [new Uint8Array([137, 80, 78, 71]).buffer] }));
    const putPdf = vi.fn();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true, resumeArtifactStorage: { putTex: async () => undefined, putPdf, putPreview: async () => undefined, compile } });
    const first = JSON.parse((await handler(event('student', 'POST', '/me/resume-drafts/draft-a/finalize', { revision: 0 }))).body) as { artifact: { artifactId: string; resumeSpecHash: string } };
    const second = JSON.parse((await handler(event('student', 'POST', '/me/resume-drafts/draft-b/finalize', { revision: 0 }))).body) as { artifact: { artifactId: string; resumeSpecHash: string } };
    expect(second.artifact.artifactId).toBe(first.artifact.artifactId);
    expect(second.artifact.resumeSpecHash).toBe(first.artifact.resumeSpecHash);
    expect(compile).toHaveBeenCalledOnce();
    expect(putPdf).toHaveBeenCalledOnce();
    expect(await users.listResumeArtifacts('student')).toHaveLength(1);
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
