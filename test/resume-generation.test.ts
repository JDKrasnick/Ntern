import { describe, expect, it } from 'vitest';
import { RESUME_DRAFT_MODELS, parseResumeChanges, workersAiResumeDraftGenerator } from '../src/resume-generation.js';

describe('resume model output parsing', () => {
  it('accepts the four structured change types and assigns server identifiers', () => {
    const changes = parseResumeChanges({ response: JSON.stringify({ changes: [
      { type: 'add', target: { kind: 'project', bankItemId: 'a' }, section: 'Projects', suggestion: 'Built dashboard', evidenceIds: ['a'], reason: 'matches role' },
      { type: 'rewrite', target: { kind: 'role', bankItemId: 'b' }, section: 'Experience', original: 'Built app', suggestion: 'Built app', evidenceIds: ['b'], reason: 'clearer wording' },
      { type: 'move', target: { kind: 'skill', bankItemId: 'c' }, section: 'Skills', original: 'TypeScript', evidenceIds: ['c'], reason: 'surface relevant skill' },
      { type: 'remove', target: { kind: 'project', bankItemId: 'd' }, section: 'Projects', original: 'Old item', evidenceIds: ['d'], reason: 'less relevant' },
    ] }) });
    expect(changes).toHaveLength(4);
    expect(changes.map((change) => change.type)).toEqual(['add', 'rewrite', 'move', 'remove']);
    expect(changes.every((change) => change.changeId.length > 10)).toBe(true);
  });

  it('rejects malformed or unsupported output before evidence validation', () => {
    expect(() => parseResumeChanges({ response: '{"changes":[{"type":"invent","section":"X"}]}' })).toThrow('Model change schema is invalid');
    expect(() => parseResumeChanges({ response: 'not json' })).toThrow();
  });

  const input = { job: { importId: 'j', canonicalUrl: 'https://x.test', description: 'Build TypeScript', source: 'manual' as const, contentHash: 'h', status: 'ready' as const, revision: 0, createdAt: 'now', updatedAt: 'now' }, profile: { userId: 'student', profileId: 'p', name: 'Base', tags: [], bankItemIds: [], sectionOrder: [], template: 'clean-standard' as const, approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' }, bankItems: [] };

  it('advances to the next model only when a model is unavailable', async () => {
    const calls: string[] = [];
    const ai = { async run(model: string) { calls.push(model); if (model === RESUME_DRAFT_MODELS[0]) throw new Error('5028: model deprecated'); return { response: JSON.stringify({ changes: [] }) }; } };
    const changes = await workersAiResumeDraftGenerator(ai).generate(input);
    expect(changes).toEqual([]);
    expect(calls).toEqual([...RESUME_DRAFT_MODELS]);
  });

  it('does not advance the chain on a schema error so the caller can retry with feedback', async () => {
    const calls: string[] = [];
    const ai = { async run(model: string) { calls.push(model); return { response: 'not json' }; } };
    await expect(workersAiResumeDraftGenerator(ai).generate(input)).rejects.toThrow();
    expect(calls).toEqual([RESUME_DRAFT_MODELS[0]]);
  });
});
