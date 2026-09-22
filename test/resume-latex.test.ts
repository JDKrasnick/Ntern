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
});
