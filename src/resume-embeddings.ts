import { createHash } from 'node:crypto';
import type { ResumeBankItem } from './resume.js';
import type { WorkersAi } from './resume-generation.js';

export interface ResumeVectorIndex {
  upsert(vectors: Array<{ id: string; values: number[]; namespace: string }>): Promise<unknown>;
  deleteByIds(ids: string[], options: { namespace: string }): Promise<unknown>;
  query(values: number[], options: { topK: number; namespace: string }): Promise<{ matches: Array<{ id: string; score: number }> }>;
}

export interface ResumeSemanticIndex {
  index(item: ResumeBankItem): Promise<void>;
  /** Optional batched upsert so a large imported bank does not embed one item per call. */
  indexMany?(items: ResumeBankItem[]): Promise<void>;
  remove(userId: string, bankItemIds: string[]): Promise<void>;
  scores(userId: string, jobDescription: string, bankItemIds: string[]): Promise<Map<string, number>>;
}

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBEDDING_BATCH_SIZE = 50;
const namespaceFor = (userId: string) => `resume-${createHash('sha256').update(userId).digest('hex').slice(0, 48)}`;

function embeddingFrom(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 768 || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error('Workers AI returned an invalid resume embedding');
  }
  return value as number[];
}

function vectorsFrom(output: unknown, expected: number): number[][] {
  const data = typeof output === 'object' && output !== null && 'data' in output ? (output as { data?: unknown }).data : undefined;
  if (!Array.isArray(data) || data.length !== expected) throw new Error('Workers AI returned an invalid resume embedding batch');
  return data.map(embeddingFrom);
}

async function embed(ai: WorkersAi, text: string): Promise<number[]> {
  const output = await ai.run(EMBEDDING_MODEL, { text: [text.slice(0, 8_000)] });
  return embeddingFrom(vectorsFrom(output, 1)[0]);
}

async function embedBatch(ai: WorkersAi, texts: string[]): Promise<number[][]> {
  return vectorsFrom(await ai.run(EMBEDDING_MODEL, { text: texts.map((text) => text.slice(0, 8_000)) }), texts.length);
}

/** Vectorize is a replaceable derived cache. Its namespace is a stable hash of
 * the account ID; raw user IDs and résumé text stay out of Vectorize metadata. */
export function workersAiResumeSemanticIndex(ai: WorkersAi, index: ResumeVectorIndex): ResumeSemanticIndex {
  return {
    async index(item) {
      if (!item.verified) return;
      await index.upsert([{ id: item.bankItemId, values: await embed(ai, item.content), namespace: namespaceFor(item.userId) }]);
    },
    async indexMany(items) {
      const verified = items.filter((item) => item.verified);
      for (let offset = 0; offset < verified.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = verified.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const vectors = await embedBatch(ai, batch.map((item) => item.content));
        await index.upsert(batch.map((item, position) => ({ id: item.bankItemId, values: vectors[position]!, namespace: namespaceFor(item.userId) })));
      }
    },
    async remove(userId, bankItemIds) {
      for (let offset = 0; offset < bankItemIds.length; offset += 1_000) await index.deleteByIds(bankItemIds.slice(offset, offset + 1_000), { namespace: namespaceFor(userId) });
    },
    async scores(userId, jobDescription, bankItemIds) {
      if (!bankItemIds.length) return new Map();
      const results = await index.query(await embed(ai, jobDescription), { namespace: namespaceFor(userId), topK: Math.min(100, bankItemIds.length) });
      const allowed = new Set(bankItemIds);
      return new Map(results.matches.filter((match) => allowed.has(match.id) && Number.isFinite(match.score)).map((match) => [match.id, Math.max(0, Math.min(1, match.score))]));
    },
  };
}
