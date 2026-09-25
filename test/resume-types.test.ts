import { describe, expect, it } from 'vitest';
import { parseResumeBankDetails, validateResumeBankGraph, validateResumeBankItemPlacement, validateResumeChanges } from '../src/resume.js';
import type { ResumeBankItem } from '../src/resume.js';

const base = { userId: 'student', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' } as const;
const project: ResumeBankItem = { ...base, bankItemId: 'project', kind: 'project', content: 'Compiler Lab', details: { name: 'Compiler Lab', technologies: ['TypeScript'] } };
const bullet: ResumeBankItem = { ...base, bankItemId: 'bullet', kind: 'bullet', parent: { kind: 'project', bankItemId: 'project' }, content: 'Built a parser' };

describe('strong typed résumé bank contract', () => {
  it('accepts a well-typed graph', () => {
    expect(() => validateResumeBankGraph([project, bullet])).not.toThrow();
  });

  it('rejects a bullet whose parent is missing, mistyped, or wrong', () => {
    expect(() => validateResumeBankGraph([project, { ...bullet, parent: { kind: 'project', bankItemId: 'missing' } }])).toThrow('owned role, project, or education parent');
    expect(() => validateResumeBankGraph([project, { ...bullet, parent: { kind: 'role', bankItemId: 'project' } }])).toThrow('owned role, project, or education parent');
  });

  it('rejects a parent pointer on a root item and duplicate identifiers', () => {
    expect(() => validateResumeBankGraph([{ ...project, parent: { kind: 'project', bankItemId: 'project' } } as unknown as ResumeBankItem])).toThrow('Only resume bullets may carry parent pointers');
    expect(() => validateResumeBankGraph([project, { ...project, bankItemId: 'project' }])).toThrow('identifiers must be unique');
  });

  it('rejects mixing two users in one graph', () => {
    expect(() => validateResumeBankGraph([project, { ...bullet, userId: 'other' }])).toThrow('one user');
  });

  it('requires an existing parent before a bullet can be placed', () => {
    expect(() => validateResumeBankItemPlacement(bullet, [])).toThrow('owned role, project, or education parent');
    expect(() => validateResumeBankItemPlacement(bullet, [project])).not.toThrow();
  });

  it('parses typed details and rejects malformed lists', () => {
    expect(parseResumeBankDetails('project', { name: 'X', technologies: ['a', 'b'] }, 'X')).toMatchObject({ name: 'X', technologies: ['a', 'b'] });
    expect(() => parseResumeBankDetails('project', { name: 'X', technologies: 'nope' }, 'X')).toThrow('technologies');
    expect(() => parseResumeBankDetails('skill', { category: 'Languages', skills: [1 as unknown as string] }, 'x')).toThrow('skills');
    expect(parseResumeBankDetails('skill', undefined, 'TypeScript, React')).toEqual({ category: 'Technical', skills: ['TypeScript', 'React'] });
  });

  it('requires an exact typed parent pointer on a change target', () => {
    const otherProject: ResumeBankItem = { ...base, bankItemId: 'other', kind: 'project', content: 'Other project', details: { name: 'Other project', technologies: [] } };
    const change = { changeId: 'c', type: 'rewrite' as const, target: { kind: 'bullet' as const, bankItemId: 'bullet', parent: { kind: 'project' as const, bankItemId: 'project' } }, section: 'Projects', original: 'Built a parser', suggestion: 'Built a parser', evidenceIds: ['bullet'], reason: 'r' };
    expect(() => validateResumeChanges([change], [project, bullet])).not.toThrow();
    expect(() => validateResumeChanges([{ ...change, target: { kind: 'bullet' as const, bankItemId: 'bullet', parent: { kind: 'project' as const, bankItemId: 'other' } } }], [project, otherProject, bullet])).toThrow('exact verified bank item');
    expect(() => validateResumeChanges([{ ...change, evidenceIds: ['other'] }], [project, otherProject, bullet])).toThrow('different parent');
  });
});
