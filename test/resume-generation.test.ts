import { describe, expect, it } from 'vitest';
import { parseResumeChanges } from '../src/resume-generation.js';

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
});
