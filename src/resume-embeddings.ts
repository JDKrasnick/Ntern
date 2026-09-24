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
  remove(userId: string, bankItemIds: string[]): Promise<void>;
  scores(userId: string, jobDescription: string, bankItemIds: string[]): Promise<Map<string, number>>;
}

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const namespaceFor = (userId: string) => `resume-${createHash('sha256').update(userId).digest('hex').slice(0, 48)}`;

function vectorFrom(output: unknown): number[] {
  const data = typeof output === 'object' && output !== null && 'data' in output ? (output as { data?: unknown }).data : undefined;
  const vector = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : undefined;
  if (!vector || vector.length !== 768 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Workers AI returned an invalid resume embedding');
  return vector as number[];
}

async function embed(ai: WorkersAi, text: string): Promise<number[]> {
  return vectorFrom(await ai.run(EMBEDDING_MODEL, { text: [text.slice(0, 8_000)] }));
}

/** Vectorize is a replaceable derived cache. Its namespace is a stable hash of
 * the account ID; raw user IDs and résumé text stay out of Vectorize metadata. */
export function workersAiResumeSemanticIndex(ai: WorkersAi, index: ResumeVectorIndex): ResumeSemanticIndex {
  return {
    async index(item) {
      if (!item.verified) return;
      await index.upsert([{ id: item.bankItemId, values: await embed(ai, item.content), namespace: namespaceFor(item.userId) }]);
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
