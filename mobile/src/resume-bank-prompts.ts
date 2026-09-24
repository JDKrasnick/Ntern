export type ResumeBankPromptKind = "build" | "convert";

const outputContract = `Return the final content as plain text only. Do not use tables, JSON, Markdown headings, or code fences.

Use only these exact all-caps section headings when the section has content:
EXPERIENCE
RESEARCH
PROJECTS
EDUCATION
SKILLS

Formatting rules:
- Under EXPERIENCE, RESEARCH, and EDUCATION, start each parent with an organization or institution on its own line. Put the title or credential and date range on the next line. Put every achievement beneath that parent on a line beginning with "- ".
- Under PROJECTS, start each parent on one line as "Project name — short factual tagline (Technology 1, Technology 2)". Put every project achievement beneath that project on a line beginning with "- ".
- Under SKILLS, use "Category: comma-separated skills".
- Never put a bullet before its parent. Never move one parent’s bullet under another parent.
- Preserve distinct alternative bullets under their correct parent; do not merge facts from different roles or projects.
- Preserve dates, metrics, technologies, names, and scope exactly when supplied. Never invent a claim, metric, employer, project, skill, or credential.
- Remove duplicate wording only when the underlying fact and parent are identical.
- Keep source facts comprehensive. This is a master content bank, not a one-page résumé.
- Before exporting, ask me to resolve any fact whose parent is unclear. If I cannot resolve it, omit it from the typed sections and append it after a final REVIEW NEEDED heading as a plain, non-bulleted source line. Ntern ignores REVIEW NEEDED during import.`;

export const buildResumeBankPrompt = `Help me build a comprehensive master résumé content bank from scratch.

First, interview me one parent at a time. Ask concise questions about my education, roles, research, projects, and skills. For each role or project, ask for the organization or name, title, dates, location or technologies, responsibilities, outcomes, metrics, and alternate bullet phrasings I may want to keep. Do not suggest facts or fill gaps yourself. Mark anything uncertain and ask me to verify it.

When I say "export my bank", organize only the facts I confirmed using this contract:

${outputContract}`;

export const convertResumeBankPrompt = `Convert the résumé, CV, or career content bank I provide into a comprehensive structured master résumé bank.

Treat my source as authoritative. Keep every useful factual bullet and alternate version, but attach it only to the role, research entry, project, or education record it actually belongs to. When a bullet’s parent is ambiguous, ask me which parent owns it before exporting. If I cannot resolve it, omit it from the typed sections and place its original wording under REVIEW NEEDED as a plain, non-bulleted line with a short explanation. Never guess. Do not improve, embellish, or invent claims during conversion.

Use this output contract:

${outputContract}

After these instructions, I will paste or attach my existing material. Do not begin the conversion until I provide it.`;

export function resumeBankPrompt(kind: ResumeBankPromptKind) {
  return kind === "build" ? buildResumeBankPrompt : convertResumeBankPrompt;
}
