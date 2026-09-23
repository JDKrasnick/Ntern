import { createHash } from 'node:crypto';
import { escapeLatex, type ResumeBankItem, type ResumeDraft, type ResumeProfile } from './resume.js';
import type { ApplicantProfile } from './types.js';

export const RESUME_TEMPLATE_VERSION = '2026-09-22.1';
export const RESUME_COMPILER_VERSION = 'fixed-template-tex-v1';

/** Emits only fixed, audited structure. User values pass through LaTeX escaping
 * and cannot select packages, commands, files, or shell escapes. */
const sectionForKind: Record<ResumeBankItem['kind'], string> = {
  role: 'Experience', project: 'Projects', skill: 'Skills', education: 'Education', bullet: 'Selected experience',
};

/** Builds a fixed-template document from the reviewed job-specific selection.
 * The profile may point at a large content bank; only evidence surfaced in the
 * draft enters the rendered resume. */
export function renderResumeLatex(profile: ResumeProfile, applicant: ApplicantProfile, draft: ResumeDraft, bankItems: ResumeBankItem[] = []): { tex: string; resumeSpecHash: string } {
  const sections = new Map<string, string[]>();
  const add = (section: string, content: string) => {
    const normalizedSection = section.trim();
    const normalizedContent = content.trim();
    if (!normalizedSection || !normalizedContent) return;
    sections.set(normalizedSection, [...(sections.get(normalizedSection) ?? []), normalizedContent]);
  };
  for (const [section, content] of Object.entries(profile.approvedWording)) {
    for (const line of content.split(/\r?\n/gu)) add(section, line);
  }
  const allowed = new Set(profile.bankItemIds);
  const bankById = new Map(bankItems.filter((item) => item.verified && allowed.has(item.bankItemId)).map((item) => [item.bankItemId, item]));
  const originalSection = (change: ResumeDraft['changes'][number]) => {
    const evidence = change.evidenceIds.map((id) => bankById.get(id)).find(Boolean);
    return evidence ? sectionForKind[evidence.kind] : change.section;
  };
  for (const change of draft.changes) {
    if (change.decision === 'rejected') {
      if (change.type !== 'add' && change.original) add(originalSection(change), change.original);
      continue;
    }
    if (change.decision !== 'accepted') continue;
    if (change.type === 'add' && change.suggestion) add(change.section, change.suggestion);
    if (change.type === 'move' && change.original) add(change.section, change.original);
    if (change.type === 'rewrite' && change.suggestion) add(change.section, change.suggestion);
  }
  const rank = new Map(profile.sectionOrder.map((section, index) => [section.toLowerCase(), index]));
  const body = [...sections.entries()]
    .filter(([, lines]) => lines.length)
    .sort(([left], [right]) => (rank.get(left.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right))
    .map(([section, lines]) => `\\section*{${escapeLatex(section)}}\n\\begin{itemize}\n${lines.map((line) => `  \\item ${escapeLatex(line)}`).join('\n')}\n\\end{itemize}`).join('\n\n');
  const contact = [applicant.location, applicant.contact.email, applicant.contact.phone, ...Object.values(applicant.links)].filter((value): value is string => Boolean(value?.trim())).map(escapeLatex).join(' $\\cdot$ ');
  const tex = `\\documentclass[10pt]{article}\n\\usepackage[margin=0.65in]{geometry}\n\\usepackage[T1]{fontenc}\n\\begin{document}\n\\begin{center}{\\Large ${escapeLatex(applicant.contact.name)}}\\\\\n${contact}\\end{center}\n${body || '% No accepted changes.'}\n\\end{document}\n`;
  const referenced = new Set(draft.changes.flatMap((change) => change.evidenceIds));
  return { tex, resumeSpecHash: createHash('sha256').update(JSON.stringify({ profileId: profile.profileId, applicant: { contact: applicant.contact, location: applicant.location, links: applicant.links }, draftId: draft.draftId, changes: draft.changes, approvedWording: profile.approvedWording, bank: bankItems.filter((item) => referenced.has(item.bankItemId) && allowed.has(item.bankItemId) && item.verified).map(({ bankItemId, kind, content, revision }) => ({ bankItemId, kind, content, revision })), template: profile.template, templateVersion: RESUME_TEMPLATE_VERSION, compilerVersion: RESUME_COMPILER_VERSION })).digest('hex') };
}
