import { describe, expect, it } from 'vitest';
import { RESUME_DRAFT_MODELS, parseResumeChanges, workersAiResumeDraftGenerator } from '../src/resume-generation.js';
import type { ResumeBankItem } from '../src/resume.js';

const input = { job: { importId: 'j', canonicalUrl: 'https://x.test', description: 'Build TypeScript', source: 'manual' as const, contentHash: 'h', status: 'ready' as const, revision: 0, createdAt: 'now', updatedAt: 'now' }, profile: { userId: 'student', profileId: 'p', name: 'Base', tags: [], bankItemIds: [], sectionOrder: [], template: 'clean-standard' as const, approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' }, bankItems: [] as ResumeBankItem[] };

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

  it('reads an OpenAI-compatible response as well as the legacy response field', () => {
    const content = JSON.stringify({ changes: [
      { type: 'rewrite', target: { kind: 'role', bankItemId: 'b' }, section: 'Experience', original: 'Built app', suggestion: 'Built app', evidenceIds: ['b'], reason: 'clearer wording' },
    ] });
    const choices = { choices: [{ message: { content } }] };
    expect(parseResumeChanges(choices)).toHaveLength(1);
    // The Workers AI binding can hand the same result back as a JSON string.
    expect(parseResumeChanges(JSON.stringify(choices))[0]?.type).toBe('rewrite');
    expect(parseResumeChanges({ choices: [{ message: { content: JSON.parse(content) } }] })).toHaveLength(1);
  });

  it('caps a long change list instead of rejecting it', () => {
    const changes = parseResumeChanges({ response: JSON.stringify({ changes: Array.from({ length: 15 }, (_, index) => ({
      type: 'rewrite', target: { kind: 'role', bankItemId: `b${index}` }, section: 'Experience', original: 'Built app', suggestion: 'Built app', evidenceIds: ['b'], reason: 'r',
    })) }) });
    expect(changes).toHaveLength(12);
  });

  it('rejects malformed or unsupported output before evidence validation', () => {
    expect(() => parseResumeChanges({ response: '{"changes":[{"type":"invent","section":"X"}]}' })).toThrow('Model change schema is invalid');
    expect(() => parseResumeChanges({ response: 'not json' })).toThrow();
  });

  it('advances to the next model only when a model is unavailable', async () => {
    const calls: string[] = [];
    const ai = { async run(model: string) { calls.push(model); if (model === RESUME_DRAFT_MODELS[0]) throw new Error('5028: model deprecated'); return { response: JSON.stringify({ changes: [] }) }; } };
    const changes = await workersAiResumeDraftGenerator(ai).generate(input);
    expect(changes).toEqual([]);
    // Advance past the unavailable model but stop at the first that answers.
    expect(calls).toEqual([RESUME_DRAFT_MODELS[0], RESUME_DRAFT_MODELS[1]]);
  });

  it('does not advance the chain on a schema error so the caller can retry with feedback', async () => {
    const calls: string[] = [];
    const ai = { async run(model: string) { calls.push(model); return { response: 'not json' }; } };
    await expect(workersAiResumeDraftGenerator(ai).generate(input)).rejects.toThrow();
    expect(calls).toEqual([RESUME_DRAFT_MODELS[0]]);
  });
});

describe('resume model target resolution', () => {
  const bank: ResumeBankItem[] = [
    { userId: 'student', bankItemId: 'role', kind: 'role', content: 'Northwind', details: { organization: 'Northwind' }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
    { userId: 'student', bankItemId: 'bullet', kind: 'bullet', parent: { kind: 'role', bankItemId: 'role' }, content: 'Built it', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
  ];
  const output = (target: unknown) => ({ response: JSON.stringify({ changes: [
    { type: 'rewrite', target, section: 'Experience', original: 'Built it', suggestion: 'Built it', evidenceIds: ['bullet'], reason: 'clearer' },
  ] }) });

  it('repairs a wrong parent pointer by resolving the id against the source repository', () => {
    const changes = parseResumeChanges(output({ kind: 'bullet', bankItemId: 'bullet', parent: { kind: 'skill', bankItemId: 'role' } }), bank);
    expect(changes[0]?.target).toEqual({ kind: 'bullet', bankItemId: 'bullet', parent: { kind: 'role', bankItemId: 'role' } });
  });

  it('accepts a bare id and resolves it to the canonical ref', () => {
    expect(parseResumeChanges(output('bullet'), bank)[0]?.target).toEqual({ kind: 'bullet', bankItemId: 'bullet', parent: { kind: 'role', bankItemId: 'role' } });
  });

  it('resolves a target the model echoed as the line text', () => {
    expect(parseResumeChanges(output('Northwind'), bank)[0]?.target).toEqual({ kind: 'role', bankItemId: 'role' });
    expect(parseResumeChanges(output('Built it'), bank)[0]?.target).toEqual({ kind: 'bullet', bankItemId: 'bullet', parent: { kind: 'role', bankItemId: 'role' } });
  });

  it('defaults the original text from the target for a remove or move', () => {
    const parsed = parseResumeChanges({ response: JSON.stringify({ changes: [
      { type: 'remove', target: { kind: 'bullet', bankItemId: 'bullet' }, section: 'Experience', evidenceIds: ['bullet'], reason: 'r' },
      { type: 'move', target: 'Northwind', section: 'Experience', evidenceIds: ['role'], reason: 'r' },
    ] }) }, bank);
    expect(parsed[0]).toMatchObject({ type: 'remove', original: 'Built it' });
    expect(parsed[1]).toMatchObject({ type: 'move', original: 'Northwind' });
  });

  it('rejects an unknown id with an actionable message for the retry', () => {
    expect(() => parseResumeChanges(output({ kind: 'role', bankItemId: 'ghost' }), bank)).toThrow(/not one of the source repository ids/);
  });

  it('lets the generator repair a bad parent instead of failing the draft', async () => {
    const ai = { async run() { return output({ kind: 'bullet', bankItemId: 'bullet', parent: { kind: 'skill', bankItemId: 'bullet' } }); } };
    const changes = await workersAiResumeDraftGenerator(ai).generate({ ...input, bankItems: bank });
    expect(changes[0]?.target).toEqual({ kind: 'bullet', bankItemId: 'bullet', parent: { kind: 'role', bankItemId: 'role' } });
  });

  it('coerces each change type to its contract instead of rejecting an extra field', () => {
    const parsed = parseResumeChanges({ response: JSON.stringify({ changes: [
      { type: 'add', target: { kind: 'role', bankItemId: 'role' }, section: 'Experience', original: 'stale', suggestion: 'Owned ingestion', evidenceIds: ['role'], reason: 'r' },
      { type: 'move', target: { kind: 'bullet', bankItemId: 'bullet' }, section: 'Experience', original: 'Built it', suggestion: 'ignored', evidenceIds: ['bullet'], reason: 'r' },
    ] }) }, bank);
    expect(parsed[0]).toMatchObject({ type: 'add', suggestion: 'Owned ingestion' });
    expect(parsed[0]?.original).toBeUndefined();
    expect(parsed[1]).toMatchObject({ type: 'move', original: 'Built it' });
    expect(parsed[1]?.suggestion).toBeUndefined();
  });

  it('keeps the usable changes when one candidate is malformed', () => {
    const parsed = parseResumeChanges({ response: JSON.stringify({ changes: [
      { type: 'add', target: { kind: 'role', bankItemId: 'role' }, section: 'Experience', evidenceIds: ['role'], reason: 'r' },
      { type: 'rewrite', target: { kind: 'bullet', bankItemId: 'bullet' }, section: 'Experience', original: 'Built it', suggestion: 'Built it', evidenceIds: ['bullet'], reason: 'r' },
    ] }) }, bank);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ type: 'rewrite' });
  });

  it('names the missing field so the feedback retry can fix it', () => {
    expect(() => parseResumeChanges({ response: JSON.stringify({ changes: [
      { type: 'add', target: { kind: 'role', bankItemId: 'role' }, section: 'Experience', evidenceIds: ['role'], reason: 'r' },
    ] }) })).toThrow(/add change must include a suggestion/);
    expect(() => parseResumeChanges({ response: JSON.stringify({ changes: [
      { type: 'rewrite', target: { kind: 'bullet', bankItemId: 'bullet' }, section: 'Experience', original: 'Built it', evidenceIds: ['bullet'], reason: 'r' },
    ] }) })).toThrow(/rewrite change must include original and suggestion/);
  });
});
