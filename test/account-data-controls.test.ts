import { describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';

function event(userId: string | undefined, method: string, rawPath: string) {
  return {
    rawPath,
    requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) },
  };
}

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

describe('account data controls', () => {
  it('exports a stable schema with full account data and sanitized document metadata', async () => {
    const users = new MemoryUserStore();
    await users.putProfile({
      userId: 'mock-full',
      contact: { name: 'QA Student', email: 'qa@example.test' },
      location: 'Remote', workAuthorization: 'Authorized', links: {}, education: [], reusableAnswers: {},
      sensitive: { voluntaryAnswer: 'declined' }, updatedAt: '2026-08-25T00:00:00.000Z',
    });
    await users.putApplication('mock-full', {
      applicationId: 'application-1', jobId: 'job-1', status: 'interview', notes: 'Follow up Friday',
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
    });
    await users.putDocument({
      userId: 'mock-full', documentId: 'document-1', fileName: 'resume.pdf', contentType: 'application/pdf',
      objectKey: 'private/mock-full/secret-storage-key', createdAt: '2026-08-23T00:00:00.000Z',
    });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, now: () => '2026-08-26T12:00:00.000Z' });

    const response = await handler(event('mock-full', 'GET', '/me/export'));
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({
      schemaVersion: 2,
      exportedAt: '2026-08-26T12:00:00.000Z',
      account: {
        profile: expect.objectContaining({ userId: 'mock-full', contact: { name: 'QA Student', email: 'qa@example.test' } }),
        applications: [expect.objectContaining({ applicationId: 'application-1', status: 'interview' })],
        documents: [{ documentId: 'document-1', fileName: 'resume.pdf', contentType: 'application/pdf', createdAt: '2026-08-23T00:00:00.000Z' }],
        resume: { bankItems: [], profiles: [], drafts: [], imports: [], artifacts: [] },
      },
    });
    expect(response.body).not.toContain('secret-storage-key');
    expect(response.body).not.toContain('auth_sessions');
    expect(response.body).not.toContain('ticketId');
  });

  it('exports an empty account and rejects signed-out export and deletion', async () => {
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users: new MemoryUserStore(), now: () => '2026-08-26T12:00:00.000Z' });
    expect(json(await handler(event('mock-empty', 'GET', '/me/export')))).toEqual({
      schemaVersion: 2, exportedAt: '2026-08-26T12:00:00.000Z',
      account: { profile: null, applications: [], documents: [], resume: { bankItems: [], profiles: [], drafts: [], imports: [], artifacts: [] } },
    });
    expect((await handler(event(undefined, 'GET', '/me/export'))).statusCode).toBe(401);
    expect((await handler(event(undefined, 'DELETE', '/me'))).statusCode).toBe(401);
  });

  it('keeps document records and identity retryable when object deletion fails', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'mock-storage-failure', documentId: 'document-1', fileName: 'resume.pdf', contentType: 'application/pdf', objectKey: 'private/mock-storage-failure/document-1', createdAt: 'now' });
    const deleteIdentity = vi.fn();
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, deleteIdentity,
      documentStorage: { createUploadUrl: vi.fn(), createDownloadUrl: vi.fn(), deleteObject: vi.fn().mockRejectedValue(new Error('R2 unavailable')) },
    });

    const response = await handler(event('mock-storage-failure', 'DELETE', '/me'));
    expect(response.statusCode).toBe(503);
    expect(json(response)).toMatchObject({ code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'document-storage', retryable: true });
    expect(await users.listDocuments('mock-storage-failure')).toHaveLength(1);
    expect(deleteIdentity).not.toHaveBeenCalled();
  });

  it('reports account-store failure after object cleanup and allows a retry', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'mock-store-failure', documentId: 'document-1', fileName: 'resume.pdf', contentType: 'application/pdf', objectKey: 'private/mock-store-failure/document-1', createdAt: 'now' });
    const originalDeleteUser = users.deleteUser.bind(users);
    users.deleteUser = vi.fn().mockRejectedValueOnce(new Error('D1 unavailable')).mockImplementation(originalDeleteUser);
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const deleteIdentity = vi.fn().mockResolvedValue(undefined);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, deleteIdentity, documentStorage: { createUploadUrl: vi.fn(), createDownloadUrl: vi.fn(), deleteObject } });

    const first = await handler(event('mock-store-failure', 'DELETE', '/me'));
    expect(first.statusCode).toBe(503);
    expect(json(first)).toMatchObject({ stage: 'account-data', retryable: true });
    expect(deleteIdentity).not.toHaveBeenCalled();
    expect((await handler(event('mock-store-failure', 'DELETE', '/me'))).statusCode).toBe(204);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteIdentity).toHaveBeenCalledOnce();
  });

  it('keeps the authenticated recovery path through identity failure and makes repeat deletion idempotent', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'mock-identity-failure', filter: {}, alertsEnabled: false, onboardingComplete: true, updatedAt: 'now' });
    const deleteIdentity = vi.fn().mockRejectedValueOnce(new Error('identity unavailable')).mockResolvedValue(undefined);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, deleteIdentity });

    const first = await handler(event('mock-identity-failure', 'DELETE', '/me'));
    expect(first.statusCode).toBe(503);
    expect(json(first)).toMatchObject({ stage: 'identity', retryable: true });
    expect(await users.getPreferences('mock-identity-failure')).toBeUndefined();
    expect((await handler(event('mock-identity-failure', 'DELETE', '/me'))).statusCode).toBe(204);
    expect((await handler(event('mock-identity-failure', 'DELETE', '/me'))).statusCode).toBe(204);
  });

  it('deletes the mock account without deleting its separately owned installation settings', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'mock-account', filter: { includeKeywords: ['backend'] }, alertsEnabled: false, onboardingComplete: true, updatedAt: 'now' });
    await users.putPreferences({ userId: 'installation:mock-device', filter: { includeKeywords: ['security'] }, alertsEnabled: true, onboardingComplete: true, updatedAt: 'now' });
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, deleteIdentity: vi.fn().mockResolvedValue(undefined) });

    expect((await handler(event('mock-account', 'DELETE', '/me'))).statusCode).toBe(204);
    expect(await users.getPreferences('mock-account')).toBeUndefined();
    expect(await users.getPreferences('installation:mock-device')).toMatchObject({ alertsEnabled: true, filter: { includeKeywords: ['security'] } });
  });

  it('removes private resume artifact objects before deleting the account record', async () => {
    const users = new MemoryUserStore();
    await users.putResumeArtifact({ userId: 'mock-artifact', artifactId: 'artifact-1', draftId: 'draft-1', objectKey: 'private/mock-artifact/resume-artifacts/spec.pdf', texObjectKey: 'private/mock-artifact/resume-artifacts/spec.tex', previewObjectKeys: ['private/mock-artifact/resume-artifacts/spec/preview-1.png'], templateVersion: 'test', compilerVersion: 'test', resumeSpecHash: 'spec', createdAt: 'now' });
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, deleteIdentity: vi.fn().mockResolvedValue(undefined), documentStorage: { createUploadUrl: vi.fn(), createDownloadUrl: vi.fn(), deleteObject } });
    expect((await handler(event('mock-artifact', 'DELETE', '/me'))).statusCode).toBe(204);
    expect(deleteObject).toHaveBeenCalledWith('private/mock-artifact/resume-artifacts/spec.pdf');
    expect(deleteObject).toHaveBeenCalledWith('private/mock-artifact/resume-artifacts/spec.tex');
    expect(deleteObject).toHaveBeenCalledWith('private/mock-artifact/resume-artifacts/spec/preview-1.png');
    expect(await users.listResumeArtifacts('mock-artifact')).toEqual([]);
  });

  it('cleans up linked providers before deleting account data and identity', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'mock-linked-account', filter: {}, alertsEnabled: false, onboardingComplete: true, updatedAt: 'now' });
    const beforeDeleteUser = vi.fn().mockResolvedValue(undefined);
    const deleteUser = vi.spyOn(users, 'deleteUser');
    const deleteIdentity = vi.fn().mockResolvedValue(undefined);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, beforeDeleteUser, deleteIdentity });

    expect((await handler(event('mock-linked-account', 'DELETE', '/me'))).statusCode).toBe(204);
    expect(beforeDeleteUser).toHaveBeenCalledWith('mock-linked-account');
    expect(beforeDeleteUser.mock.invocationCallOrder[0]).toBeLessThan(deleteUser.mock.invocationCallOrder[0]!);
    expect(deleteUser.mock.invocationCallOrder[0]).toBeLessThan(deleteIdentity.mock.invocationCallOrder[0]!);
  });

  it('fails closed before changing data when identity deletion is not configured', async () => {
    const users = new MemoryUserStore();
    await users.putPreferences({ userId: 'mock-retired-service', filter: {}, alertsEnabled: false, onboardingComplete: true, updatedAt: 'now' });
    const beginUserDeletion = vi.spyOn(users, 'beginUserDeletion');
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users });
    const response = await handler(event('mock-retired-service', 'DELETE', '/me'));
    expect(response.statusCode).toBe(503);
    expect(json(response)).toMatchObject({ code: 'ACCOUNT_DELETION_UNAVAILABLE', retryable: false });
    expect(beginUserDeletion).not.toHaveBeenCalled();
    expect(await users.getPreferences('mock-retired-service')).toBeDefined();
  });

  it('keeps account records when document metadata exists but storage is unavailable', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'mock-no-storage', documentId: 'document-1', fileName: 'resume.pdf', contentType: 'application/pdf', objectKey: 'private/mock-no-storage/document-1', createdAt: 'now' });
    const deleteIdentity = vi.fn();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, deleteIdentity });
    const response = await handler(event('mock-no-storage', 'DELETE', '/me'));
    expect(response.statusCode).toBe(503);
    expect(json(response)).toMatchObject({ stage: 'document-storage', retryable: true });
    expect(await users.listDocuments('mock-no-storage')).toHaveLength(1);
    expect(deleteIdentity).not.toHaveBeenCalled();
  });

  it('classifies an initial account-store read failure as retryable without exposing provider details', async () => {
    const users = new MemoryUserStore();
    users.listDocuments = vi.fn().mockRejectedValue(new Error('internal D1 connection details'));
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, deleteIdentity: vi.fn() });

    const response = await handler(event('mock-read-failure', 'DELETE', '/me'));
    expect(response.statusCode).toBe(503);
    expect(json(response)).toMatchObject({ code: 'ACCOUNT_DELETION_INCOMPLETE', stage: 'account-data', retryable: true });
    expect(response.body).not.toContain('internal D1 connection details');
  });

  it('keeps data and identity available until an active document upload finishes', async () => {
    const users = new MemoryUserStore();
    await users.putDocument({ userId: 'mock-active-upload', documentId: 'document-1', fileName: 'resume.pdf', contentType: 'application/pdf', objectKey: 'private/mock-active-upload/document-1', createdAt: 'now' });
    users.hasActiveDocumentUploads = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    const deleteIdentity = vi.fn().mockResolvedValue(undefined);
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, deleteIdentity, documentStorage: { createUploadUrl: vi.fn(), createDownloadUrl: vi.fn(), deleteObject } });

    const first = await handler(event('mock-active-upload', 'DELETE', '/me'));
    expect(first.statusCode).toBe(503);
    expect(json(first)).toMatchObject({ stage: 'document-storage', retryable: true });
    expect(await users.listDocuments('mock-active-upload')).toHaveLength(1);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(deleteIdentity).not.toHaveBeenCalled();

    expect((await handler(event('mock-active-upload', 'DELETE', '/me'))).statusCode).toBe(204);
    expect(deleteObject).toHaveBeenCalledOnce();
    expect(deleteIdentity).toHaveBeenCalledOnce();
  });
});
