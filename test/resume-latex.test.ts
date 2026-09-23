import { describe, expect, it } from 'vitest';
import { renderResumeLatex } from '../src/resume-latex.js';

describe('fixed resume LaTeX rendering', () => {
  it('escapes accepted changes without accepting arbitrary commands', () => {
    const result = renderResumeLatex(
      { userId: 'student', profileId: 'profile', name: 'Technical % base', tags: [], bankItemIds: [], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', contact: { name: 'Ada % Lovelace', email: 'ada@example.test', phone: '+1 555 0100' }, location: 'Ithaca, NY', workAuthorization: 'US', links: { portfolio: 'https://example.test/a_b' }, education: [], reusableAnswers: {}, updatedAt: 'now' },
      { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [{ changeId: 'change', type: 'add', target: { kind: 'project', bankItemId: 'bank' }, section: 'Projects', suggestion: 'Used C#_50%', evidenceIds: ['bank'], reason: 'fit', decision: 'accepted' }], revision: 0, status: 'finalized', createdAt: 'now', updatedAt: 'now' },
    );
    expect(result.tex).toContain('Ada \\% Lovelace');
    expect(result.tex).toContain('ada@example.test');
    expect(result.tex).toContain('https://example.test/a\\_b');
    expect(result.tex).not.toContain('Technical \\% base');
    expect(result.tex).toContain('C\\#\\_50\\%');
    expect(result.resumeSpecHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('renders only reviewed job-specific selections from the full Technical base', () => {
    const profile = { userId: 'student', profileId: 'profile', name: 'Candidate', tags: [], bankItemIds: ['role', 'project', 'skill', 'unused'], sectionOrder: ['Experience', 'Projects', 'Skills'], template: 'clean-standard' as const, approvedWording: { Education: 'Cornell University' }, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const draft = { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [
      { changeId: 'remove', type: 'remove' as const, target: { kind: 'role' as const, bankItemId: 'role' }, section: 'Experience', original: 'Old role', evidenceIds: ['role'], reason: 'irrelevant', decision: 'accepted' as const },
      { changeId: 'move', type: 'move' as const, target: { kind: 'skill' as const, bankItemId: 'skill' }, section: 'Experience', original: 'TypeScript', evidenceIds: ['skill'], reason: 'surface it', decision: 'accepted' as const },
      { changeId: 'rewrite', type: 'rewrite' as const, target: { kind: 'project' as const, bankItemId: 'project' }, section: 'Projects', original: 'Built dashboard', suggestion: 'Built an accessible dashboard', evidenceIds: ['project'], reason: 'clearer', decision: 'accepted' as const },
      { changeId: 'add', type: 'add' as const, target: { kind: 'project' as const, bankItemId: 'project' }, section: 'Projects', suggestion: 'Shipped tests', evidenceIds: ['project'], reason: 'relevant', decision: 'accepted' as const },
    ], revision: 0, status: 'finalized' as const, createdAt: 'now', updatedAt: 'now' };
    const bank = [
      { userId: 'student', bankItemId: 'role', kind: 'role' as const, content: 'Old role', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'project', kind: 'project' as const, content: 'Built dashboard', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'skill', kind: 'skill' as const, content: 'TypeScript', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'unused', kind: 'project' as const, content: 'Unrelated source-bank material', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
    ];
    const applicant = { userId: 'student', contact: { name: 'Candidate', email: 'candidate@example.test' }, location: 'Remote', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' };
    const { tex } = renderResumeLatex(profile, applicant, draft, bank);
    expect(tex).toContain('Cornell University');
    expect(tex).toContain('Built an accessible dashboard');
    expect(tex).toContain('Shipped tests');
    expect(tex).toContain('TypeScript');
    expect(tex).not.toContain('Old role');
    expect(tex).not.toContain('Built dashboard');
    expect(tex).not.toContain('Unrelated source-bank material');
  });
});
