import { createHash } from 'node:crypto';
import { escapeLatex, type ResumeDraft, type ResumeProfile } from './resume.js';

export const RESUME_TEMPLATE_VERSION = '2026-09-22.1';
export const RESUME_COMPILER_VERSION = 'fixed-template-tex-v1';

/** Emits only fixed, audited structure. User values pass through LaTeX escaping
 * and cannot select packages, commands, files, or shell escapes. */
export function renderResumeLatex(profile: ResumeProfile, draft: ResumeDraft): { tex: string; resumeSpecHash: string } {
  const accepted = draft.changes.filter((change) => change.decision === 'accepted' && change.suggestion);
  const sections = new Map<string, string[]>();
  for (const change of accepted) sections.set(change.section, [...(sections.get(change.section) ?? []), escapeLatex(change.suggestion!)]);
  const body = [...sections.entries()].map(([section, lines]) => `\\section*{${escapeLatex(section)}}\n\\begin{itemize}\n${lines.map((line) => `  \\item ${line}`).join('\n')}\n\\end{itemize}`).join('\n\n');
  const tex = `\\documentclass[10pt]{article}\n\\usepackage[margin=0.65in]{geometry}\n\\usepackage[T1]{fontenc}\n\\begin{document}\n\\begin{center}\\Large ${escapeLatex(profile.name)}\\end{center}\n${body || '% No accepted changes.'}\n\\end{document}\n`;
  return { tex, resumeSpecHash: createHash('sha256').update(JSON.stringify({ profileId: profile.profileId, draftId: draft.draftId, changes: draft.changes, template: profile.template, templateVersion: RESUME_TEMPLATE_VERSION, compilerVersion: RESUME_COMPILER_VERSION })).digest('hex') };
}
