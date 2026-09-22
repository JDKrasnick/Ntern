import { describe, expect, it } from 'vitest';
import { renderResumeLatex } from '../src/resume-latex.js';

describe('fixed resume LaTeX rendering', () => {
  it('escapes accepted changes without accepting arbitrary commands', () => {
    const result = renderResumeLatex(
      { userId: 'student', profileId: 'profile', name: 'Technical % base', tags: [], bankItemIds: [], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [{ changeId: 'change', type: 'add', section: 'Projects', suggestion: 'Used C#_50%', evidenceIds: ['bank'], reason: 'fit', decision: 'accepted' }], revision: 0, status: 'finalized', createdAt: 'now', updatedAt: 'now' },
    );
    expect(result.tex).toContain('Technical \\% base');
    expect(result.tex).toContain('C\\#\\_50\\%');
    expect(result.resumeSpecHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('preserves the reviewed base and applies accepted add, remove, move, and rewrite changes', () => {
    const profile = { userId: 'student', profileId: 'profile', name: 'Candidate', tags: [], bankItemIds: ['role', 'project', 'skill'], sectionOrder: ['Experience', 'Projects', 'Skills'], template: 'clean-standard' as const, approvedWording: { Education: 'Cornell University' }, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const draft = { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [
      { changeId: 'remove', type: 'remove' as const, section: 'Experience', original: 'Old role', evidenceIds: ['role'], reason: 'irrelevant', decision: 'accepted' as const },
      { changeId: 'move', type: 'move' as const, section: 'Experience', original: 'TypeScript', evidenceIds: ['skill'], reason: 'surface it', decision: 'accepted' as const },
      { changeId: 'rewrite', type: 'rewrite' as const, section: 'Projects', original: 'Built dashboard', suggestion: 'Built an accessible dashboard', evidenceIds: ['project'], reason: 'clearer', decision: 'accepted' as const },
      { changeId: 'add', type: 'add' as const, section: 'Projects', suggestion: 'Shipped tests', evidenceIds: ['project'], reason: 'relevant', decision: 'accepted' as const },
    ], revision: 0, status: 'finalized' as const, createdAt: 'now', updatedAt: 'now' };
    const bank = [
      { userId: 'student', bankItemId: 'role', kind: 'role' as const, content: 'Old role', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'project', kind: 'project' as const, content: 'Built dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'skill', kind: 'skill' as const, content: 'TypeScript', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
    ];
    const { tex } = renderResumeLatex(profile, draft, bank);
    expect(tex).toContain('Cornell University');
    expect(tex).toContain('Built an accessible dashboard');
    expect(tex).toContain('Shipped tests');
    expect(tex).toContain('TypeScript');
    expect(tex).not.toContain('Old role');
    expect(tex).not.toContain('Built dashboard');
  });
});
