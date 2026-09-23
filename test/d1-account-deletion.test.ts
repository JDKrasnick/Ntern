import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { D1ReleaseStore, D1UserStore } from '../cloudflare/d1-store.js';
import { documentContent, type Environment } from '../cloudflare/worker.js';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore } from '../src/store.js';
import type { D1Database, D1PreparedStatement } from '../cloudflare/types.js';

type SqliteValue = string | number | bigint | null | Uint8Array;

function sqliteD1(database: DatabaseSync): D1Database {
  const prepared = (query: string, values: unknown[] = []): D1PreparedStatement => {
    const statement: StatementSync = database.prepare(query);
    const bound = values as SqliteValue[];
    return {
      bind(...next: unknown[]) { return prepared(query, next); },
      async first<T>() { return (statement.get(...bound) as T | undefined) ?? null; },
      async all<T>() { return { results: statement.all(...bound) as T[] }; },
      async run() { return { meta: { changes: Number(statement.run(...bound).changes) } }; },
    };
  };
  return {
    prepare(query: string) { return prepared(query); },
    async batch(statements: D1PreparedStatement[]) { return Promise.all(statements.map((statement) => statement.run())); },
  };
}

function accountSchema(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE user_items (
      user_id TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
      active_device INTEGER NOT NULL DEFAULT 0, device_token TEXT, receipt_state TEXT,
      session_id TEXT, expires_at INTEGER, PRIMARY KEY (user_id, item_key)
    );
    CREATE TABLE usage_counters (period TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (period, metric));
  `);
}

function event(userId: string) {
  return { rawPath: '/me', requestContext: { http: { method: 'DELETE' }, authorizer: { jwt: { claims: { sub: userId } } } } };
}

describe('D1 account deletion barrier', () => {
  it('atomically caps monthly resume draft usage', async () => {
    const database = new DatabaseSync(':memory:');
    accountSchema(database);
    const users = new D1UserStore(sqliteD1(database));

    const claims = await Promise.all(Array.from({ length: 8 }, () => users.claimResumeDraftAllowance('student', '2026-09', 2, '2026-09-23T00:00:00.000Z')));
    expect(claims.filter(Boolean)).toHaveLength(2);
    expect(await users.getResumeDraftUsage('student', '2026-09')).toBe(2);
    expect(await users.getResumeDraftUsage('student', '2026-10')).toBe(0);
    database.close();
  });

  it("updates a user's release as an employer drop grows", async () => {
    const database = new DatabaseSync(':memory:');
    accountSchema(database);
    const releases = new D1ReleaseStore(sqliteD1(database));

    await releases.putRelease({ releaseId: 'acme-day', userId: 'student', jobIds: ['one', 'two', 'three', 'four'], newJobIds: ['one', 'two', 'three', 'four'], createdAt: '2026-09-17T15:00:00.000Z' });
    await releases.putRelease({ releaseId: 'acme-day', userId: 'student', jobIds: ['five', 'four', 'one', 'three', 'two'], newJobIds: ['five'], createdAt: '2026-09-17T15:00:00.000Z' });

    expect(await releases.getRelease('student', 'acme-day')).toEqual({
      releaseId: 'acme-day', userId: 'student', jobIds: ['five', 'four', 'one', 'three', 'two'], newJobIds: ['five'], createdAt: '2026-09-17T15:00:00.000Z',
    });
    database.close();
  });

  it('deletes an application only within its owner partition', async () => {
    const database = new DatabaseSync(':memory:');
    accountSchema(database);
    const users = new D1UserStore(sqliteD1(database));
    const application = (applicationId: string) => ({ applicationId, jobId: applicationId, status: 'saved' as const, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z' });
    await users.putApplication('owner', application('first'));
    await users.putApplication('owner', application('neighbor'));

    await users.deleteApplication('other-user', 'first');
    expect(await users.getApplication('owner', 'first')).toBeDefined();
    await users.deleteApplication('owner', 'first');
    expect(await users.getApplication('owner', 'first')).toBeUndefined();
    expect(await users.getApplication('owner', 'neighbor')).toMatchObject({ applicationId: 'neighbor' });
    database.close();
  });

  it('does not let an expired upload clear the replacement lease', async () => {
    const database = new DatabaseSync(':memory:');
    accountSchema(database);
    const users = new D1UserStore(sqliteD1(database));
    const startedAt = new Date('2026-08-26T12:00:00.000Z');
    const afterExpiry = new Date('2026-08-26T12:16:00.000Z');

    expect(await users.beginDocumentUpload('lease-user', 'document-1', 'first', startedAt)).toBe(true);
    expect(await users.beginDocumentUpload('lease-user', 'document-1', 'overlap', startedAt)).toBe(false);
    expect(await users.beginDocumentUpload('lease-user', 'document-1', 'replacement', afterExpiry)).toBe(true);
    await users.finishDocumentUpload('lease-user', 'document-1', 'first');
    expect(await users.hasActiveDocumentUploads('lease-user', afterExpiry)).toBe(true);
    await users.finishDocumentUpload('lease-user', 'document-1', 'replacement');
    expect(await users.hasActiveDocumentUploads('lease-user', afterExpiry)).toBe(false);
    database.close();
  });

  it('makes deletion wait for an in-flight upload and removes the final object on retry', async () => {
    const database = new DatabaseSync(':memory:');
    accountSchema(database);
    const db = sqliteD1(database);
    const users = new D1UserStore(db);
    const userId = 'account-user';
    const document = { userId, documentId: 'document-1', fileName: 'resume.pdf', contentType: 'application/pdf', objectKey: 'private/account-user/document-1', createdAt: 'now' };
    await users.putDocument(document);

    const objects = new Map<string, ArrayBuffer>();
    const r2 = {
      async put(key: string, value: ArrayBuffer) { objects.set(key, value); },
      async get() { return null; },
      async delete(key: string) { objects.delete(key); },
    };
    const env = { DB: db, DOCUMENTS: r2 } as unknown as Environment;
    let finishBody: () => void = () => undefined;
    const bodyGate = new Promise<void>((resolve) => { finishBody = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array([0x25, 0x50]));
        await bodyGate;
        controller.enqueue(new Uint8Array([0x44, 0x46]));
        controller.close();
      },
    });
    const upload = documentContent(new Request(`https://example.test/me/documents/${document.documentId}/content`, {
      method: 'PUT', body, duplex: 'half',
    } as RequestInit & { duplex: 'half' }), env, userId, document.documentId);
    await vi.waitFor(async () => expect(await users.hasActiveDocumentUploads(userId)).toBe(true));

    const deleteIdentity = vi.fn().mockResolvedValue(undefined);
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, deleteIdentity,
      documentStorage: { createUploadUrl: vi.fn(), createDownloadUrl: vi.fn(), deleteObject: (key) => r2.delete(key) },
    });
    const firstDeletion = await handler(event(userId));
    expect(firstDeletion.statusCode).toBe(503);
    expect(JSON.parse(firstDeletion.body)).toMatchObject({ stage: 'document-storage', retryable: true });
    expect(deleteIdentity).not.toHaveBeenCalled();

    finishBody();
    expect((await upload).status).toBe(409);
    expect(objects.has(document.objectKey)).toBe(false);
    expect(await users.hasActiveDocumentUploads(userId)).toBe(false);

    expect((await handler(event(userId))).statusCode).toBe(204);
    expect(objects.has(document.objectKey)).toBe(false);
    expect(await users.listDocuments(userId)).toEqual([]);
    expect(deleteIdentity).toHaveBeenCalledOnce();
    await expect(users.putDocument({ ...document, documentId: 'late-document' })).rejects.toThrow('Account deletion is in progress');
    database.close();
  });
});
