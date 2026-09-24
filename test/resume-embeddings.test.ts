import { describe, expect, it, vi } from 'vitest';
import { workersAiResumeSemanticIndex } from '../src/resume-embeddings.js';

const vector = Array.from({ length: 768 }, (_, index) => index / 1_000);

describe('resume semantic cache', () => {
  it('uses a hashed user namespace and never returns another user’s bank item', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({ matches: [{ id: 'owned', score: 0.84 }, { id: 'other-user-item', score: 0.99 }] });
    const index = workersAiResumeSemanticIndex({ run: vi.fn().mockResolvedValue({ data: [vector] }) }, { upsert, deleteByIds: vi.fn().mockResolvedValue(undefined), query });
    await index.index({ userId: 'student-a', bankItemId: 'owned', kind: 'project', content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' });
    const scores = await index.scores('student-a', 'Need TypeScript experience', ['owned']);
    expect(upsert.mock.calls[0]![0][0]).toMatchObject({ id: 'owned', namespace: expect.stringMatching(/^resume-[a-f0-9]{48}$/u), values: vector });
    expect(query.mock.calls[0]![1]).toMatchObject({ namespace: upsert.mock.calls[0]![0][0].namespace });
    expect(scores).toEqual(new Map([['owned', 0.84]]));
  });

  it('removes derived vectors in bounded batches during account deletion', async () => {
    const deleteByIds = vi.fn().mockResolvedValue(undefined);
    const index = workersAiResumeSemanticIndex({ run: vi.fn() }, { upsert: vi.fn(), deleteByIds, query: vi.fn() });
    await index.remove('student-a', Array.from({ length: 1_001 }, (_, index) => `item-${index}`));
    expect(deleteByIds).toHaveBeenCalledTimes(2);
    expect(deleteByIds.mock.calls[0]![0]).toHaveLength(1_000);
    expect(deleteByIds.mock.calls[1]![0]).toEqual(['item-1000']);
  });
});
