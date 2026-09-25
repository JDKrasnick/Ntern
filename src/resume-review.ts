import { buildResumeDocument } from './resume-latex.js';
import { RESUME_TEMPLATES } from './resume-templates.js';
import type { ApplicantProfile } from './types.js';
import type { ResumeBankItem, ResumeChange, ResumeDocument, ResumeDraft, ResumeProfile } from './resume.js';

export type ResumeReviewSection = 'education' | 'experience' | 'research' | 'projects' | 'skills';

/** One aligned line of the review: the original résumé on the left, the
 * proposal on the right. `changeId` is present only when accepting this line is
 * a decision the user can make. */
export interface ResumeReviewRow {
  rowId: string;
  /** Stable identity of the aligned line, independent of its text. */
  lineId: string;
  kind: 'context' | 'change';
  section: ResumeReviewSection;
  /** Entry the line belongs to, so the UI can group headings with their lines. */
  label: string;
  before?: string;
  after?: string;
  changeId?: string;
  type?: ResumeChange['type'];
  decision?: 'accepted' | 'rejected';
  /** True when the change moved the line to a different position. */
  moved?: boolean;
  note?: string;
}

interface ReviewLine {
  key: string;
  slot: string;
  /** Stable within one rendering even when duplicate text exists. */
  lineId: string;
  section: ResumeReviewSection;
  label: string;
  text: string;
}

const sections = new Set<ResumeReviewSection>(['education', 'experience', 'research', 'projects', 'skills']);
const sectionOrderFor = (profile: ResumeProfile): ResumeReviewSection[] =>
  (RESUME_TEMPLATES[profile.template] ?? RESUME_TEMPLATES['clean-standard']).sectionOrder
    .map((section) => section as ResumeReviewSection);
const toSection = (value: string): ResumeReviewSection => sections.has(value.toLowerCase() as ResumeReviewSection) ? value.toLowerCase() as ResumeReviewSection : 'experience';

function linesFor(document: ResumeDocument, order: ResumeReviewSection[]): ReviewLine[] {
  const lines: ReviewLine[] = [];
  const slotCounts = new Map<string, number>();
  const push = (section: ResumeReviewSection, label: string, slot: string, text: string | undefined) => {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return;
    const occurrence = slotCounts.get(slot) ?? 0;
    slotCounts.set(slot, occurrence + 1);
    lines.push({ key: `${slot}\u0000${trimmed}`, slot, lineId: `${slot}#${occurrence}`, section, label, text: trimmed });
  };
  for (const section of order) {
    if (section === 'education') for (const entry of document.education) {
      const slot = `${section}:${entry.id}`;
      push(section, entry.institution, `${slot}:head`, [entry.institution, entry.credential, entry.dateRange, entry.location, entry.gpa ? `GPA: ${entry.gpa}` : undefined].filter(Boolean).join(' | '));
      push(section, entry.institution, `${slot}:detail`, entry.details);
      entry.bullets.forEach((bullet) => push(section, entry.institution, `${slot}:bullet`, bullet));
    }
    if (section === 'experience') for (const entry of document.experience) {
      const slot = `${section}:${entry.id}`;
      push(section, entry.organization, `${slot}:head`, [entry.organization, entry.title, entry.dateRange, entry.location].filter(Boolean).join(' | '));
      entry.bullets.forEach((bullet) => push(section, entry.organization, `${slot}:bullet`, bullet));
    }
    if (section === 'research') for (const entry of document.research) {
      const slot = `${section}:${entry.id}`;
      push(section, entry.organization, `${slot}:head`, [entry.organization, entry.title, entry.advisor, entry.dateRange, entry.location].filter(Boolean).join(' | '));
      entry.bullets.forEach((bullet) => push(section, entry.organization, `${slot}:bullet`, bullet));
    }
    if (section === 'projects') for (const entry of document.projects) {
      const slot = `${section}:${entry.id}`;
      const parts = [entry.tagline, entry.technologies.length ? entry.technologies.join(', ') : undefined].filter(Boolean);
      push(section, entry.name, `${slot}:head`, parts.length ? `${entry.name} — ${parts.join(' · ')}` : entry.name);
      entry.bullets.forEach((bullet) => push(section, entry.name, `${slot}:bullet`, bullet));
    }
    if (section === 'skills') for (const entry of document.skills) {
      push(section, entry.category, `${section}:${entry.id}:skill`, `${entry.category}: ${entry.skills.join(', ')}`);
    }
  }
  return lines;
}

const trimmed = (value: string | undefined) => (value ?? '').trim();

/** Renders the original résumé and the fully-accepted proposal, then walks the
 * proposal line by line so every change is attached to the exact line a reviewer
 * will look at. Removed lines are reinserted at their entry, and any change the
 * rendering cannot show (for example a no-op reorder) is surfaced at the end so
 * it can still be decided before finalizing. */
export function buildResumeReviewRows(profile: ResumeProfile, applicant: ApplicantProfile, draft: ResumeDraft, bankItems: ResumeBankItem[]): ResumeReviewRow[] {
  const order = sectionOrderFor(profile);
  const base = linesFor(buildResumeDocument(profile, applicant, { ...draft, changes: [] }, bankItems), order);
  const proposed = linesFor(buildResumeDocument(profile, applicant, { ...draft, changes: draft.changes.map((change) => ({ ...change, decision: 'accepted' as const })) }, bankItems), order);

  const used = new Set<string>();
  const take = (predicate: (change: ResumeChange) => boolean): ResumeChange | undefined => {
    const change = draft.changes.find((candidate) => !used.has(candidate.changeId) && predicate(candidate));
    if (change) used.add(change.changeId);
    return change;
  };
  const row = (line: ReviewLine, change: ResumeChange | undefined, before: string | undefined, after: string | undefined, note?: string, moved?: boolean): ResumeReviewRow => ({
    rowId: line.key, lineId: line.lineId, kind: change ? 'change' : 'context', section: line.section, label: line.label,
    ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}),
    ...(change ? { changeId: change.changeId, type: change.type } : {}), ...(change?.decision ? { decision: change.decision } : {}), ...(moved ? { moved } : {}), ...(note ? { note } : {}),
  });

  const baseIndexOf = (line: ReviewLine) => base.filter((candidate) => candidate.slot === line.slot).findIndex((candidate) => candidate.text === line.text);
  const proposedIndexOf = (line: ReviewLine) => proposed.filter((candidate) => candidate.slot === line.slot).findIndex((candidate) => candidate.text === line.text);

  const rows: ResumeReviewRow[] = [];
  for (const line of proposed) {
    const addition = take((change) => change.type === 'add' && trimmed(change.suggestion) === line.text);
    if (addition) { rows.push(row(line, addition, undefined, line.text)); continue; }
    const rewrite = take((change) => change.type === 'rewrite' && trimmed(change.suggestion) === line.text && trimmed(change.original) !== line.text);
    if (rewrite) { rows.push(row(line, rewrite, trimmed(rewrite.original) || line.text, line.text)); continue; }
    const move = take((change) => change.type === 'move' && trimmed(change.original) === line.text);
    if (move) {
      const reordered = baseIndexOf(line) !== proposedIndexOf(line);
      rows.push(row(line, move, line.text, line.text, reordered ? 'Reordered' : 'No visible change', reordered));
      continue;
    }
    rows.push(row(line, undefined, line.text, line.text));
  }

  // Removed lines are absent from the proposal, so reinsert them at their entry.
  for (const line of base) {
    if (proposed.some((candidate) => candidate.slot === line.slot && candidate.text === line.text)) continue;
    const removal = take((change) => change.type === 'remove' && trimmed(change.original) === line.text);
    if (!removal) continue;
    const insertAfter = rows.reduce((found, candidate, index) => candidate.section === line.section && candidate.label === line.label ? index : found, -1);
    const removedRow = row(line, removal, line.text, undefined);
    if (insertAfter >= 0) rows.splice(insertAfter + 1, 0, removedRow);
    else rows.push(removedRow);
  }

  for (const change of draft.changes) {
    if (used.has(change.changeId)) continue;
    rows.push({
      rowId: `change:${change.changeId}`, lineId: `change:${change.changeId}`, kind: 'change', section: toSection(change.section), label: change.section,
      ...(change.original ? { before: change.original } : {}), ...(change.suggestion ? { after: change.suggestion } : {}),
      changeId: change.changeId, type: change.type, ...(change.decision ? { decision: change.decision } : {}), note: 'No visible change',
    });
  }
  return rows;
}
