import { describe, expect, it } from 'vitest';
import { buildResumeReviewRows } from '../src/resume-review.js';
import type { ApplicantProfile } from '../src/types.js';
import type { ResumeBankItem, ResumeDraft, ResumeProfile } from '../src/resume.js';

const applicant: ApplicantProfile = { userId: 'student', contact: { name: 'Student', email: 'student@example.test' }, location: 'Ithaca, NY', workAuthorization: 'US', links: {}, education: [], reusableAnswers: {}, updatedAt: 'now' };
const profile: ResumeProfile = { userId: 'student', profileId: 'profile', name: 'Base', tags: [], bankItemIds: ['project', 'bullet-a', 'bullet-b'], sectionOrder: ['projects'], template: 'clean-standard', approvedWording: {}, bankRevision: 0, revision: 0, createdAt: 'now', updatedAt: 'now' };
const bank: ResumeBankItem[] = [
  { userId: 'student', bankItemId: 'project', kind: 'project', content: 'Compiler Lab', details: { name: 'Compiler Lab', technologies: ['TypeScript'] }, verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
  { userId: 'student', bankItemId: 'bullet-a', kind: 'bullet', parent: { kind: 'project', bankItemId: 'project' }, content: 'Built a parser', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
  { userId: 'student', bankItemId: 'bullet-b', kind: 'bullet', parent: { kind: 'project', bankItemId: 'project' }, content: 'Added type checking', verified: true, revision: 0, createdAt: 'now', updatedAt: 'now' },
];

describe('resume review diff rows', () => {
  it('aligns the original résumé with the proposal and maps every change to its line', () => {
    const draft: ResumeDraft = { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', revision: 0, status: 'reviewing', createdAt: 'now', updatedAt: 'now', changes: [
      { changeId: 'rewrite-a', type: 'rewrite', target: { kind: 'bullet', bankItemId: 'bullet-a', parent: { kind: 'project', bankItemId: 'project' } }, section: 'Projects', original: 'Built a parser', suggestion: 'Built a recursive-descent parser', evidenceIds: ['bullet-a'], reason: 'fits' },
      { changeId: 'remove-b', type: 'remove', target: { kind: 'bullet', bankItemId: 'bullet-b', parent: { kind: 'project', bankItemId: 'project' } }, section: 'Projects', original: 'Added type checking', evidenceIds: ['bullet-b'], reason: 'weak' },
      { changeId: 'add-c', type: 'add', target: { kind: 'project', bankItemId: 'project' }, section: 'Projects', suggestion: 'Added type inference', evidenceIds: ['project'], reason: 'fits' },
    ] };
    const rows = buildResumeReviewRows(profile, applicant, draft, bank);

    const context = rows.find((row) => row.kind === 'context');
    expect(context).toMatchObject({ before: 'Compiler Lab — TypeScript', after: 'Compiler Lab — TypeScript', section: 'projects' });

    const rewrite = rows.find((row) => row.changeId === 'rewrite-a');
    expect(rewrite).toMatchObject({ kind: 'change', type: 'rewrite', before: 'Built a parser', after: 'Built a recursive-descent parser' });

    const removal = rows.find((row) => row.changeId === 'remove-b');
    expect(removal).toMatchObject({ kind: 'change', type: 'remove', before: 'Added type checking' });
    expect(removal?.after).toBeUndefined();

    const addition = rows.find((row) => row.changeId === 'add-c');
    expect(addition).toMatchObject({ kind: 'change', type: 'add', after: 'Added type inference' });
    expect(addition?.before).toBeUndefined();

    expect(new Set(rows.filter((row) => row.changeId).map((row) => row.changeId))).toEqual(new Set(['rewrite-a', 'remove-b', 'add-c']));
  });

  it('carries a decision onto the row and surfaces reorders as changed lines', () => {
    const draft: ResumeDraft = { userId: 'student', draftId: 'draft', profileId: 'profile', importId: 'job', revision: 1, status: 'reviewing', createdAt: 'now', updatedAt: 'now', changes: [
      { changeId: 'move-b', type: 'move', target: { kind: 'bullet', bankItemId: 'bullet-b', parent: { kind: 'project', bankItemId: 'project' } }, section: 'Projects', original: 'Added type checking', evidenceIds: ['bullet-b'], reason: 'surface it', decision: 'accepted' },
    ] };
    const rows = buildResumeReviewRows(profile, applicant, draft, bank);
    const move = rows.find((row) => row.changeId === 'move-b');
    expect(move).toMatchObject({ kind: 'change', type: 'move', before: 'Added type checking', after: 'Added type checking', note: 'Reordered', decision: 'accepted', moved: true });
    // Every row carries a stable line id independent of its text.
    expect(rows.every((row) => typeof row.lineId === 'string' && row.lineId.length > 0)).toBe(true);
    // The reordered bullet renders before its sibling.
    const bulletRows = rows.filter((row) => row.section === 'projects' && row.label === 'Compiler Lab').map((row) => row.after ?? row.before);
    expect(bulletRows.indexOf('Added type checking')).toBeLessThan(bulletRows.indexOf('Built a parser'));
  });
});
