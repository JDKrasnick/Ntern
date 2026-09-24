import { describe, expect, it } from 'vitest';
import { RESUME_LAYOUT_FLOORS, renderResumeLatex } from '../src/resume-latex.js';

describe('fixed resume LaTeX rendering', () => {
  it('escapes accepted changes without accepting arbitrary commands', () => {
    const result = renderResumeLatex(
      { userId: 'student', profileId: 'profile', name: 'Technical % base', tags: [], bankItemIds: ['project', 'bullet'], sectionOrder: [], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', contact: { name: 'Ada % Lovelace', email: 'ada@example.test', phone: '+1 555 0100' }, location: 'Ithaca, NY', workAuthorization: 'US', links: { portfolio: 'https://example.test/a_b' }, education: [], reusableAnswers: {}, updatedAt: 'now' },
      { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [], revision: 0, status: 'finalized', createdAt: 'now', updatedAt: 'now' },
      [
        { userId: 'student', bankItemId: 'project', kind: 'project', content: 'Compiler', details: { name: 'Compiler', technologies: ['C#'] }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
        { userId: 'student', bankItemId: 'bullet', kind: 'bullet', parent: { kind: 'project', bankItemId: 'project' }, content: 'Used C#_50%', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      ],
    );
    expect(result.tex).toContain('Ada \\% Lovelace');
    expect(result.tex).toContain('ada@example.test');
    expect(result.tex).toContain('https://example.test/a\\_b');
    expect(result.tex).not.toContain('Technical \\% base');
    expect(result.tex).toContain('C\\#\\_50\\%');
    expect(result.resumeSpecHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('renders the complete selected base while applying reviewed diffs', () => {
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
    expect(tex).toContain('Built an accessible dashboard');
    expect(tex).toContain('Shipped tests');
    expect(tex).toContain('TypeScript');
    expect(tex).not.toContain('Old role');
    expect(tex).not.toContain('Built dashboard');
    expect(tex).toContain('Unrelated source-bank material');
  });

  it('keeps bullets under their typed parent and changes section priority by template', () => {    const profile = { userId: 'student', profileId: 'profile', name: 'Technical', tags: [], bankItemIds: ['role', 'role-bullet', 'project', 'project-bullet'], sectionOrder: [], template: 'jake-technical' as const, approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const applicant = { userId: 'student', contact: { name: 'Candidate', email: 'candidate@example.test' }, location: 'Ithaca, NY', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' };
    const draft = { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', changes: [], revision: 0, status: 'finalized' as const, createdAt: 'now', updatedAt: 'now' };
    const bank = [
      { userId: 'student', bankItemId: 'role', kind: 'role' as const, content: 'Order.co', details: { organization: 'Order.co', title: 'AI Engineer Intern', location: 'New York, NY', dateRange: 'May 2026 - August 2026' }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'role-bullet', kind: 'bullet' as const, parent: { kind: 'role' as const, bankItemId: 'role' }, content: 'Raised ingestion success above 98%.', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'project', kind: 'project' as const, content: 'Ntern', details: { name: 'Ntern', tagline: 'Internship discovery platform', technologies: ['TypeScript', 'Cloudflare Workers'] }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'project-bullet', kind: 'bullet' as const, parent: { kind: 'project' as const, bankItemId: 'project' }, content: 'Maintained 99.9% metadata presence.', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
    ];
    const result = renderResumeLatex(profile, applicant, draft, bank);
    expect(result.document.experience[0]?.bullets).toEqual(['Raised ingestion success above 98%.']);
    expect(result.document.projects[0]?.bullets).toEqual(['Maintained 99.9% metadata presence.']);
    expect(result.tex).toContain('margin=0.6in');
    expect(result.tex).toContain(`\\setlength{\\itemsep}{${RESUME_LAYOUT_FLOORS.bulletGapPoints}pt}`);
    expect(result.tex).toContain(`\\end{list}\\vspace{${RESUME_LAYOUT_FLOORS.bulletBlockGapPoints}pt}`);
    expect(result.tex).toContain(`\\vspace{${RESUME_LAYOUT_FLOORS.sectionBeforePoints}pt}{\\large`);
    expect(result.tex).not.toMatch(/\\vspace\{-/u);
    expect(result.tex.indexOf('\\ResumeSection{Experience}')).toBeLessThan(result.tex.indexOf('\\ResumeSection{Projects}'));
    const projectFirst = renderResumeLatex({ ...profile, template: 'project-compact' }, applicant, draft, bank).tex;
    expect(projectFirst.indexOf('\\ResumeSection{Projects}')).toBeLessThan(projectFirst.indexOf('\\ResumeSection{Experience}'));
    for (const template of ['jake-technical', 'clean-standard', 'research-academic', 'project-compact'] as const) {
      const source = renderResumeLatex({ ...profile, template }, applicant, draft, bank).tex;
      const margin = Number(/margin=([\d.]+)in/u.exec(source)?.[1]);
      const bulletGap = Number(/\\setlength\{\\itemsep\}\{([\d.]+)pt\}/u.exec(source)?.[1]);
      const sectionGaps = /\\ResumeSection\}\[1\]\{\\vspace\{([\d.]+)pt\}.*?\\hrule\\vspace\{([\d.]+)pt\}/u.exec(source);
      expect(margin).toBeGreaterThanOrEqual(RESUME_LAYOUT_FLOORS.pageMarginInches);
      expect(bulletGap).toBeGreaterThanOrEqual(RESUME_LAYOUT_FLOORS.bulletGapPoints);
      expect(Number(sectionGaps?.[1])).toBeGreaterThanOrEqual(RESUME_LAYOUT_FLOORS.sectionBeforePoints);
      expect(Number(sectionGaps?.[2])).toBeGreaterThanOrEqual(RESUME_LAYOUT_FLOORS.sectionAfterPoints);
      expect(source).not.toMatch(/\\vspace\{-/u);
    }
  });

  it('floats accepted move changes ahead of their siblings so a reorder is visible', () => {
    const profile = { userId: 'student', profileId: 'profile', name: 'Candidate', tags: [], bankItemIds: ['project', 'bullet-a', 'bullet-b'], sectionOrder: [], template: 'clean-standard' as const, approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' };
    const applicant = { userId: 'student', contact: { name: 'Candidate', email: 'candidate@example.test' }, location: 'Ithaca, NY', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' };
    const bank = [
      { userId: 'student', bankItemId: 'project', kind: 'project' as const, content: 'Compiler Lab', details: { name: 'Compiler Lab', technologies: ['TypeScript'] }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'bullet-a', kind: 'bullet' as const, parent: { kind: 'project' as const, bankItemId: 'project' }, content: 'Built a parser', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
      { userId: 'student', bankItemId: 'bullet-b', kind: 'bullet' as const, parent: { kind: 'project' as const, bankItemId: 'project' }, content: 'Added type checking', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
    ];
    const move = { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', revision: 0, status: 'reviewing' as const, createdAt: 'now', updatedAt: 'now', changes: [
      { changeId: 'move-b', type: 'move' as const, target: { kind: 'bullet' as const, bankItemId: 'bullet-b', parent: { kind: 'project' as const, bankItemId: 'project' } }, section: 'Projects', original: 'Added type checking', evidenceIds: ['bullet-b'], reason: 'surface it', decision: 'accepted' as const },
    ] };
    expect(renderResumeLatex(profile, applicant, move, bank).document.projects[0]?.bullets).toEqual(['Added type checking', 'Built a parser']);
    // Without an accepted move the base order is preserved.
    expect(renderResumeLatex(profile, applicant, { ...move, changes: [] }, bank).document.projects[0]?.bullets).toEqual(['Built a parser', 'Added type checking']);
  });
});
