import { buildResumeDocument } from './resume-latex.js';
import { RESUME_TEMPLATES } from './resume-templates.js';
import type { ApplicantProfile } from './types.js';
import type { ResumeBankItem, ResumeChange, ResumeDocument, ResumeDraft, ResumeLineBox, ResumeProfile } from './resume.js';

export type ResumeReviewSection = 'education' | 'experience' | 'research' | 'projects' | 'skills';

/** A rectangle on a rendered résumé page, normalized to the page box. */
export interface ResumeReviewBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  /** Where the line renders on the original page and on the proposed page. */
  beforeBox?: ResumeReviewBox;
  afterBox?: ResumeReviewBox;
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

/** Ligature-insensitive token stream. pdfTeX's T1 fonts render `fi`/`fl`/`ff`
 * as one glyph that pdftotext can emit as a control character, so both sides of
 * the comparison drop those pairs to keep a wrapped bullet matchable. */
const lineTokens = (value: string): string[] =>
  (value.toLowerCase().match(/[a-z0-9+#.]+/gu) ?? []).map((token) => token.replace(/ffl|ffi|ff|fi|fl/gu, ''));

/** Groups rendered lines into visual rows (a bold label and its value share a
 * baseline even though poppler emits them out of order), then orders rows
 * top-to-bottom and each row left-to-right. */
export function orderResumeLineBoxes(lines: readonly ResumeLineBox[]): ResumeLineBox[] {
  const tolerance = 0.012;
  const items = lines.map((line) => ({ line, center: line.y + line.h / 2 }));
  items.sort((left, right) => left.center - right.center || left.line.x - right.line.x);
  const rows: Array<{ center: number; items: typeof items }> = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.center - item.center) <= tolerance) {
      row.center = (row.center * row.items.length + item.center) / (row.items.length + 1);
      row.items.push(item);
    } else rows.push({ center: item.center, items: [item] });
  }
  return rows.flatMap((row) => row.items.sort((left, right) => left.line.x - right.line.x).map((item) => item.line));
}

/** Points at the rendered line(s) for a review line. The first target token
 * anchors the match, then later tokens may span wrapped lines. Returns the union
 * box so a reviewer sees the whole line without hunting for it. */
export function matchResumeLineBox(lines: readonly ResumeLineBox[], text: string | undefined): Omit<ResumeReviewBox, 'page'> | undefined {
  if (!text) return undefined;
  const target = lineTokens(text);
  if (!target.length) return undefined;
  const ordered = orderResumeLineBoxes(lines);
  const tokens = ordered.map((line) => lineTokens(line.text));
  let best: { coverage: number; box: Omit<ResumeReviewBox, 'page'> } | undefined;
  for (let index = 0; index < ordered.length; index += 1) {
    if (!tokens[index]!.length || tokens[index]![0] !== target[0]) continue;
    let cursor = 0;
    let end = index;
    for (let line = index; line < ordered.length && line < index + 8; line += 1) {
      for (const token of tokens[line]!) if (cursor < target.length && token === target[cursor]) { cursor += 1; end = line; }
      if (cursor >= target.length) break;
    }
    const required = Math.max(1, Math.ceil(target.length * 0.6));
    if (cursor < required || cursor < Math.min(2, target.length)) continue;
    let x0 = 1; let y0 = 1; let x1 = 0; let y1 = 0;
    for (const line of ordered.slice(index, end + 1)) {
      x0 = Math.min(x0, line.x); y0 = Math.min(y0, line.y);
      x1 = Math.max(x1, line.x + line.w); y1 = Math.max(y1, line.y + line.h);
    }
    if (!best || cursor > best.coverage) best = { coverage: cursor, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  }
  return best?.box;
}

/** Attaches the rendered location of each change's before/after line, searching
 * the pages of the compiled original and proposal. No decision needs a recompile:
 * the boxes come from text matching against the two cached renders. */
export function attachResumeReviewBoxes(rows: ResumeReviewRow[], rawPages: readonly ResumeLineBox[][], proposedPages: readonly ResumeLineBox[][]): ResumeReviewRow[] {
  const find = (pages: readonly ResumeLineBox[][], text: string | undefined): ResumeReviewBox | undefined => {
    if (text === undefined) return undefined;
    for (const [index, lines] of pages.entries()) {
      const box = matchResumeLineBox(lines, text);
      if (box) return { page: index + 1, ...box };
    }
    return undefined;
  };
  return rows.map((row) => {
    if (!row.changeId) return row;
    const beforeBox = find(rawPages, row.before);
    const afterBox = row.after === undefined ? undefined : find(proposedPages, row.after);
    return { ...row, ...(beforeBox ? { beforeBox } : {}), ...(afterBox ? { afterBox } : {}) };
  });
}
