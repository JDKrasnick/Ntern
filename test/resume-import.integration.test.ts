import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createApiHandler } from '../src/api.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import { workersAiResumeSemanticIndex, type ResumeVectorIndex } from '../src/resume-embeddings.js';

/**
 * Cross-module integration for the résumé import path: the real API handler,
 * the real DOCX extractor, the real store contracts, and the real semantic index
 * composed with a deterministic in-memory Vectorize + Workers AI stand-in. This
 * exercises the wiring the unit tests mock out (batched embedding, de-duplicated
 * bank reconciliation, paid-only ranking, and the document cap).
 */

const docxContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX = (() => {
  const paragraphs = ['Projects', 'Compiler Lab', '• Built a parser', '• Added type checking'];
  const xml = `<w:document><w:body>${paragraphs.map((text) => `<w:p><w:t>${text}</w:t></w:p>`).join('')}</w:body></w:document>`;
  const bytes = zipSync({ 'word/document.xml': new TextEncoder().encode(xml) });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
})();

const event = (userId: string | undefined, method: string, rawPath: string, body?: unknown) => ({
  rawPath, body: body === undefined ? undefined : JSON.stringify(body), requestContext: { http: { method }, ...(userId ? { authorizer: { jwt: { claims: { sub: userId } } } } : {}) },
});
const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

const EMBEDDING_DIMENSIONS = 768;
/** Deterministic hashed bag-of-words embedding: shared words raise cosine
 * similarity, which is all the ranking contract needs. */
function embedText(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9+#.-]{2,}/gu) ?? []) {
    const digest = createHash('sha256').update(word).digest();
    vector[((digest[0]! << 8) | digest[1]!) % EMBEDDING_DIMENSIONS] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}
const cosine = (left: number[], right: number[]) => left.reduce((total, value, index) => total + value * right[index]!, 0);

function inMemoryVectorize() {
  const vectors = new Map<string, { namespace: string; values: number[] }>();
  const key = (namespace: string, id: string) => `${namespace}\u0000${id}`;
  const index: ResumeVectorIndex & { upsertCalls: number; deleteCalls: number; queryCalls: number } = {
    upsertCalls: 0, deleteCalls: 0, queryCalls: 0,
    async upsert(entries) { index.upsertCalls += 1; for (const entry of entries) vectors.set(key(entry.namespace, entry.id), { namespace: entry.namespace, values: entry.values }); },
    async deleteByIds(ids, { namespace }) { index.deleteCalls += 1; for (const id of ids) vectors.delete(key(namespace, id)); },
    async query(values, { namespace, topK }) {
      index.queryCalls += 1;
      return { matches: [...vectors.entries()].filter(([, entry]) => entry.namespace === namespace)
        .map(([entryKey, entry]) => ({ id: entryKey.slice(entryKey.indexOf('\u0000') + 1), score: cosine(values, entry.values) }))
        .sort((left, right) => right.score - left.score).slice(0, topK) };
    },
  };
  return index;
}

const fakeAi = { run: async (_model: string, input: unknown) => ({ data: (input as { text: string[] }).text.map(embedText) }) };

function harness(subscription?: { tier: 'plus' | 'pro' }) {
  const users = new MemoryUserStore();
  const vectorize = inMemoryVectorize();
  const handler = createApiHandler({
    jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
    documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => DOCX },
    resumeSemanticIndex: workersAiResumeSemanticIndex(fakeAi, vectorize),
  });
  if (subscription) void users.putResumeSubscription({ userId: 'student', tier: subscription.tier, status: 'active', provider: 'apple', updatedAt: 'now' });
  return { users, vectorize, handler };
}

async function seedDocument(users: MemoryUserStore, documentId: string) {
  await users.putDocument({ userId: 'student', documentId, fileName: 'resume.docx', contentType: docxContentType, objectKey: `private/student/${documentId}`, createdAt: 'now' });
}

async function importResume(handler: ReturnType<typeof createApiHandler>, documentId: string) {
  return json<{ items: Array<{ bankItemId: string; kind: string; content: string }> }>(await handler(event('student', 'POST', '/me/resume-bank/import', { documentId })));
}

describe('resume import integration', () => {
  it('extracts, de-duplicates, batches, and ranks a paid résumé end to end', async () => {
    const { users, vectorize, handler } = harness({ tier: 'pro' });
    await seedDocument(users, 'resume');
    const first = await importResume(handler, 'resume');
    expect(first.items.map((item) => item.content).sort()).toEqual(['Added type checking', 'Built a parser', 'Compiler Lab']);
    expect(vectorize.upsertCalls).toBe(1); // one batched embed call for the paid import

    const second = await importResume(handler, 'resume');
    expect(second.items.map((item) => item.bankItemId).sort()).toEqual(first.items.map((item) => item.bankItemId).sort());
    expect(vectorize.upsertCalls).toBe(1); // a re-import creates nothing to embed
    expect(json<{ items: unknown[] }>(await handler(event('student', 'GET', '/me/resume-bank'))).items).toHaveLength(3);

    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Compiler', tags: [], bankItemIds: first.items.map((item) => item.bankItemId), sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/compiler', description: 'Build a compiler parser with type checking', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const recommendation = json<{ recommendations: Array<{ explanation: string; score: number }> }>(await handler(event('student', 'POST', '/me/resume-jobs/job/recommendation')));
    expect(recommendation.recommendations[0]?.explanation).toContain('Semantic similarity');
    expect(recommendation.recommendations[0]?.score).toBeGreaterThan(0);
  });

  it('keeps semantic ranking off for free plans and warms the cache once on upgrade', async () => {
    const { users, vectorize, handler } = harness();
    await seedDocument(users, 'resume');
    await importResume(handler, 'resume');
    expect(vectorize.upsertCalls).toBe(0); // free imports never embed

    await users.putResumeProfile({ userId: 'student', profileId: 'profile', name: 'Compiler', tags: [], bankItemIds: (await users.listResumeBank('student')).map((item) => item.bankItemId), sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' });
    await users.putImportedResumeJob('student', { importId: 'job', canonicalUrl: 'https://careers.example.test/compiler', description: 'Build a compiler parser', source: 'manual', contentHash: 'job', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' });
    const free = json<{ recommendations: Array<{ explanation: string }> }>(await handler(event('student', 'POST', '/me/resume-jobs/job/recommendation')));
    expect(free.recommendations[0]?.explanation).not.toContain('Semantic');
    expect(vectorize.queryCalls).toBe(0);

    await users.putResumeSubscription({ userId: 'student', tier: 'plus', status: 'active', provider: 'apple', updatedAt: 'now' });
    const paid = json<{ recommendations: Array<{ explanation: string }> }>(await handler(event('student', 'POST', '/me/resume-jobs/job/recommendation')));
    expect(vectorize.upsertCalls).toBe(1); // exactly one warm-up batch after upgrading
    expect(paid.recommendations[0]?.explanation).toContain('Semantic similarity');
  });

  it('separates distinct roots that share a summary line but not their typed details', async () => {
    const users = new MemoryUserStore();
    const handler = createApiHandler({ jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true });
    const base = { userId: 'student', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' } as const;
    await users.putResumeBankItem({ ...base, bankItemId: 'a', kind: 'project', content: 'Machine Learning', details: { name: 'Machine Learning', tagline: 'Ranking', technologies: ['Python'] } });
    await users.putResumeBankItem({ ...base, bankItemId: 'b', kind: 'project', content: 'Machine Learning', details: { name: 'Machine Learning', tagline: 'Vision', technologies: ['PyTorch'] } });
    // Both roots remain distinct in the resolved bank because their details differ.
    await users.putDocument({ userId: 'student', documentId: 'resume', fileName: 'resume.docx', contentType: docxContentType, objectKey: 'private/student/resume', createdAt: 'now' });
    const handlerWithExtractor = createApiHandler({
      jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => DOCX },
      resumeDocumentExtractor: async () => [{ localId: 'line-2', kind: 'project', content: 'Machine Learning', sourceLocation: 'line 2' }],
    });
    const imported = json<{ items: Array<{ bankItemId: string; content: string }> }>(await handlerWithExtractor(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' })));
    expect(imported.items.some((item) => item.content === 'Machine Learning')).toBe(true);
    expect(json<{ items: unknown[] }>(await handler(event('student', 'GET', '/me/resume-bank'))).items).toHaveLength(3);
  });

  it('surfaces a storage fault with its own diagnostic instead of the graph message', async () => {
    class FaultyStore extends MemoryUserStore {
      async putResumeBankItems(): Promise<never> { throw new Error('D1 write unavailable'); }
    }
    const users = new FaultyStore();
    const handler = createApiHandler({
      jobs: new MemoryInternshipStore(), users, resumeTunerEnabled: true,
      documentStorage: { createUploadUrl: async () => '', createDownloadUrl: async () => '', deleteObject: async () => undefined, readContent: async () => DOCX },
      resumeDocumentExtractor: async () => [{ localId: 'line-2', kind: 'project', content: 'Compiler Lab', sourceLocation: 'line 2' }],
    });
    await users.putDocument({ userId: 'student', documentId: 'resume', fileName: 'resume.docx', contentType: docxContentType, objectKey: 'private/student/resume', createdAt: 'now' });
    const response = await handler(event('student', 'POST', '/me/resume-bank/import', { documentId: 'resume' }));
    expect(response.statusCode).toBe(400);
    expect(json<{ message: string }>(response).message).toBe('D1 write unavailable');
  });
});
