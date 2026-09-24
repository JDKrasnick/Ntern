import { describe, expect, it } from 'vitest';
import { escapeLatex, normalizeResumeJobUrl, proposeResumeReadabilityChanges, recommendResumeProfiles, validateResumeChanges } from '../src/resume.js';

describe('resume safety contracts', () => {
  it('normalizes public HTTPS job URLs without retaining fragments', () => {
    expect(normalizeResumeJobUrl(' https://careers.example.test/a#details ')).toBe('https://careers.example.test/a');
    expect(() => normalizeResumeJobUrl('http://careers.example.test/a')).toThrow('HTTPS');
    expect(() => normalizeResumeJobUrl('https://user:pass@careers.example.test/a')).toThrow('credentials');
    expect(() => normalizeResumeJobUrl('https://127.0.0.1/a')).toThrow('Private network');
  });

  it('escapes fixed-template LaTex fields', () => {
    expect(escapeLatex('C#_50%')).toBe('C\\#\\_50\\%');
  });

  it('rejects unverified cross-user evidence and unsupported numeric claims', () => {
    const verified = { userId: 'owner', bankItemId: 'bank-1', kind: 'project' as const, content: 'Improved 20% with Python', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const target = { kind: 'project' as const, bankItemId: 'bank-1' };
    expect(() => validateResumeChanges([{ changeId: 'c', type: 'rewrite', target, section: 'Experience', original: 'Improved 20% with Python', suggestion: 'Improved 30%', evidenceIds: ['bank-1'], reason: 'fit' }], [verified])).toThrow('numeric');
    expect(() => validateResumeChanges([{ changeId: 'c', type: 'rewrite', target, section: 'Experience', original: 'Improved 20% with Python', suggestion: 'Improved 20%', evidenceIds: ['other'], reason: 'fit' }], [verified])).toThrow('verified');
  });

  it('rejects unrelated nonnumeric claims and invalid change shapes', () => {
    const verified = { userId: 'owner', bankItemId: 'bank-1', kind: 'project' as const, content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const target = { kind: 'project' as const, bankItemId: 'bank-1' };
    expect(() => validateResumeChanges([{ changeId: 'c', type: 'add', target, section: 'Experience', suggestion: 'Led a global security team', evidenceIds: ['bank-1'], reason: 'fit' }], [verified])).toThrow('claims');
    expect(() => validateResumeChanges([{ changeId: 'c', type: 'move', target, section: 'Projects', suggestion: verified.content, evidenceIds: ['bank-1'], reason: 'fit' }], [verified])).toThrow('change type');
  });

  it('rejects bullet evidence and targets that cross project parents', () => {
    const common = { userId: 'owner', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const projectA = { ...common, bankItemId: 'project-a', kind: 'project' as const, content: 'Project A' };
    const projectB = { ...common, bankItemId: 'project-b', kind: 'project' as const, content: 'Project B' };
    const bulletA = { ...common, bankItemId: 'bullet-a', kind: 'bullet' as const, parent: { kind: 'project' as const, bankItemId: 'project-a' }, content: 'Built TypeScript APIs' };
    const bulletB = { ...common, bankItemId: 'bullet-b', kind: 'bullet' as const, parent: { kind: 'project' as const, bankItemId: 'project-b' }, content: 'Built React interfaces' };
    expect(() => validateResumeChanges([{ changeId: 'c', type: 'rewrite', target: { kind: 'bullet', bankItemId: 'bullet-a', parent: bulletA.parent }, section: 'Projects', original: bulletA.content, suggestion: 'Built React APIs', evidenceIds: ['bullet-a', 'bullet-b'], reason: 'fit' }], [projectA, projectB, bulletA, bulletB])).toThrow('different parent');
  });

  it('ranks bases with explainable verified-evidence coverage', () => {
    const recommendation = recommendResumeProfiles('TypeScript dashboard engineer', [
      { userId: 'student', profileId: 'web', name: 'Web', tags: ['typescript'], bankItemIds: ['dashboard'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', profileId: 'ml', name: 'ML', tags: ['machine-learning'], bankItemIds: [], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' },
    ], [{ userId: 'student', bankItemId: 'dashboard', kind: 'project', content: 'Built a TypeScript dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' }]);
    expect(recommendation[0]).toMatchObject({ profileId: 'web', score: 110, explanation: expect.stringContaining('verified bank item') });
  });

  it('proposes explicit removals to keep a large base readable without starving a parent', () => {
    const common = { userId: 'student', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const projects = ['compiler', 'dashboard'].map((bankItemId) => ({ ...common, bankItemId, kind: 'project' as const, content: bankItemId }));
    const bullets = projects.flatMap((project) => Array.from({ length: 8 }, (_, index) => ({
      ...common, bankItemId: `${project.bankItemId}-${index}`, kind: 'bullet' as const,
      parent: { kind: 'project' as const, bankItemId: project.bankItemId },
      content: index === 0 ? `Built a TypeScript ${project.content}` : `Documented ${project.content} result ${index}`,
    })));
    const changes = proposeResumeReadabilityChanges({ importId: 'job', canonicalUrl: 'https://example.test/job', description: 'TypeScript engineering', source: 'manual', contentHash: 'hash', status: 'ready', revision: 0, createdAt: 'now', updatedAt: 'now' }, [...projects, ...bullets]);
    expect(changes).toHaveLength(4);
    expect(changes.every((change) => change.type === 'remove' && change.target.kind === 'bullet')).toBe(true);
    expect(changes.map((change) => change.target.bankItemId)).not.toContain('compiler-0');
    expect(changes.map((change) => change.target.bankItemId)).not.toContain('dashboard-0');
  });
});
