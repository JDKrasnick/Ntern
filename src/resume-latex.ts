import { createHash } from 'node:crypto';
import type { ApplicantProfile } from './types.js';
import { escapeLatex, parseResumeBankDetails, type ResumeBankItem, type ResumeDocument, type ResumeDraft, type ResumeProfile } from './resume.js';
import { RESUME_TEMPLATES, RESUME_TEMPLATE_VERSION } from './resume-templates.js';

export { RESUME_TEMPLATE_VERSION } from './resume-templates.js';
export const RESUME_COMPILER_VERSION = 'typed-fixed-template-tex-v2';
export const RESUME_LAYOUT_FLOORS = Object.freeze({
  pageMarginInches: 0.55,
  sectionBeforePoints: 8,
  sectionAfterPoints: 4,
  entryContentGapPoints: 2,
  bulletGapPoints: 2,
  bulletBlockGapPoints: 3,
});

const sectionTitle = { education: 'Education', experience: 'Experience', research: 'Research', projects: 'Projects', skills: 'Technical Skills' } as const;

function resolvedResumeBank(profile: ResumeProfile, draft: ResumeDraft, bankItems: ResumeBankItem[]) {
  const allowed = new Set(profile.bankItemIds);
  const selected = bankItems.filter((item) => allowed.has(item.bankItemId) && item.verified);
  const byId = new Map(selected.map((item) => [item.bankItemId, item]));
  const removed = new Set<string>();
  const rewritten = new Map<string, string>();
  const added: ResumeBankItem[] = [];
  const moveRank = new Map<string, number>();
  let moveOrder = 0;
  for (const change of draft.changes) {
    if (change.decision !== 'accepted') continue;
    if (change.type === 'remove') removed.add(change.target.bankItemId);
    if (change.type === 'rewrite' && change.suggestion) rewritten.set(change.target.bankItemId, change.suggestion.trim());
    // A move only matters as order: floated items render ahead of the rest of
    // their section or parent, in the order the reviewer accepted them.
    if (change.type === 'move' && !moveRank.has(change.target.bankItemId)) moveRank.set(change.target.bankItemId, moveOrder++);
    if (change.type === 'add' && change.suggestion) {
      const target = byId.get(change.target.bankItemId);
      const parent = target?.kind === 'bullet' ? target.parent
        : target && (target.kind === 'role' || target.kind === 'research' || target.kind === 'project' || target.kind === 'education')
          ? { kind: target.kind, bankItemId: target.bankItemId } as const : undefined;
      if (parent) added.push({
        userId: profile.userId, bankItemId: `change:${change.changeId}`, kind: 'bullet', parent,
        content: change.suggestion.trim(), verified: true, revision: 0, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
      });
    }
  }
  const rankOf = (item: ResumeBankItem) => moveRank.get(item.bankItemId) ?? Number.MAX_SAFE_INTEGER;
  return [...selected, ...added]
    .filter((item) => !removed.has(item.bankItemId) && !(item.kind === 'bullet' && removed.has(item.parent.bankItemId)))
    .map((item) => rewritten.has(item.bankItemId) ? { ...item, content: rewritten.get(item.bankItemId)! } : item)
    .sort((left, right) => rankOf(left) - rankOf(right));
}

/** Turns the bank graph into the only input shape a template may render. Child
 * bullets are joined exclusively through their typed parent pointers. */
export function buildResumeDocument(profile: ResumeProfile, applicant: ApplicantProfile, draft: ResumeDraft, bankItems: ResumeBankItem[]): ResumeDocument {
  const resolved = resolvedResumeBank(profile, draft, bankItems);
  const bullets = new Map<string, string[]>();
  for (const item of resolved) {
    if (item.kind !== 'bullet') continue;
    bullets.set(item.parent.bankItemId, [...(bullets.get(item.parent.bankItemId) ?? []), item.content]);
  }
  const document: ResumeDocument = {
    name: applicant.contact.name,
    contact: [
      applicant.contact.email ? { label: 'Email', value: applicant.contact.email } : undefined,
      applicant.contact.phone ? { label: 'Phone', value: applicant.contact.phone } : undefined,
      ...Object.entries(applicant.links).map(([label, value]) => value ? { label, value } : undefined),
      applicant.location ? { label: 'Location', value: applicant.location } : undefined,
    ].filter((value): value is { label: string; value: string } => Boolean(value)),
    education: [], experience: [], research: [], projects: [], skills: [],
  };
  for (const item of resolved) {
    if (item.kind === 'bullet') continue;
    if (item.kind === 'role') document.experience.push({ id: item.bankItemId, ...(item.details ?? parseResumeBankDetails('role', undefined, item.content)), bullets: bullets.get(item.bankItemId) ?? [] });
    else if (item.kind === 'research') document.research.push({ id: item.bankItemId, ...(item.details ?? parseResumeBankDetails('research', undefined, item.content)), bullets: bullets.get(item.bankItemId) ?? [] });
    else if (item.kind === 'project') document.projects.push({ id: item.bankItemId, ...(item.details ?? parseResumeBankDetails('project', undefined, item.content)), bullets: bullets.get(item.bankItemId) ?? [] });
    else if (item.kind === 'education') document.education.push({ id: item.bankItemId, ...(item.details ?? parseResumeBankDetails('education', undefined, item.content)), bullets: bullets.get(item.bankItemId) ?? [] });
    else document.skills.push({ id: item.bankItemId, ...(item.details ?? parseResumeBankDetails('skill', undefined, item.content)) });
  }
  if (!document.education.length) {
    for (const [index, education] of applicant.education.entries()) document.education.push({
      id: `applicant-education-${index}`, institution: education.school,
      credential: [education.degree, education.field].filter(Boolean).join(' in ') || undefined,
      dateRange: education.graduationDate, bullets: [],
    });
  }
  return document;
}

const tex = (value?: string) => escapeLatex(value ?? '');
const bulletList = (items: string[]) => items.length
  ? `\\begin{ResumeBullets}\n${items.map((item) => `\\item ${tex(item)}`).join('\n')}\n\\end{ResumeBullets}` : '';

function renderEducation(document: ResumeDocument) {
  return document.education.map((entry) => {
    const heading = [entry.institution, entry.gpa ? `GPA: ${entry.gpa}` : undefined, ...(entry.testScores ?? [])].filter(Boolean).join(' | ');
    if (entry.awards?.length && !entry.location && !entry.dateRange && !entry.bullets.length) {
      return `\\ResumeEducationCompact{${tex(heading)}}{${tex([entry.credential, `Awards: ${entry.awards.join(', ')}`].filter(Boolean).join(' | '))}}`;
    }
    const details = [entry.details, entry.coursework?.length ? `Relevant Coursework: ${entry.coursework.join(', ')}` : undefined].filter(Boolean);
    return `\\ResumeHeading{${tex(heading)}}{${tex(entry.location)}}{${tex(entry.credential)}}{${tex(entry.dateRange)}}
${details.map((value) => `\\ResumeDetail{${tex(value)}}`).join('\n')}${details.length ? '\n' : ''}${bulletList(entry.bullets)}`;
  }).join('\n');
}

function renderExperience(document: ResumeDocument) {
  return document.experience.map((entry) => `\\ResumeHeading{${tex(entry.organization)}}{${tex(entry.location)}}{${tex(entry.title)}}{${tex(entry.dateRange)}}
${bulletList(entry.bullets)}`).join('\n');
}

function renderResearch(document: ResumeDocument) {
  return document.research.map((entry) => `\\ResumeHeading{${tex(entry.organization)}}{${tex(entry.location)}}{${tex(entry.title)}${entry.advisor ? `, advised by ${tex(entry.advisor)}` : ''}}{${tex(entry.dateRange)}}
${bulletList(entry.bullets)}`).join('\n');
}

function renderProjects(document: ResumeDocument) {
  return document.projects.map((entry) => {
    const parts = [entry.tagline, entry.technologies.length ? entry.technologies.join(', ') : undefined].filter(Boolean);
    const descriptor = parts.length > 1 ? `${parts[0]} (${parts[1]})` : parts[0] ?? '';
    return `\\ResumeProject{${tex(entry.name)}}{${tex(descriptor)}}{${tex(entry.url)}}\n${bulletList(entry.bullets)}`;
  }).join('\n');
}

function renderSkills(document: ResumeDocument) {
  return document.skills.map((entry) => `\\ResumeSkill{${tex(entry.category)}}{${tex(entry.skills.join(', '))}}`).join('\n');
}

const renderers = { education: renderEducation, experience: renderExperience, research: renderResearch, projects: renderProjects, skills: renderSkills };

function templatePreamble(profile: ResumeProfile) {
  const template = RESUME_TEMPLATES[profile.template];
  const comfortable = template.density === 'comfortable';
  const jake = profile.template === 'jake-technical';
  // Template density may add whitespace, but it cannot compress below these
  // readability floors. Content selection, never negative space, keeps a page short.
  const margin = `${comfortable ? 0.68 : jake ? 0.6 : RESUME_LAYOUT_FLOORS.pageMarginInches}in`;
  const itemSep = `${comfortable ? 3 : RESUME_LAYOUT_FLOORS.bulletGapPoints}pt`;
  const sectionBefore = `${comfortable ? 10 : RESUME_LAYOUT_FLOORS.sectionBeforePoints}pt`;
  const sectionAfter = `${comfortable ? 5 : RESUME_LAYOUT_FLOORS.sectionAfterPoints}pt`;
  const entryContentGap = `${RESUME_LAYOUT_FLOORS.entryContentGapPoints}pt`;
  const bulletBlockGap = `${comfortable ? 4 : RESUME_LAYOUT_FLOORS.bulletBlockGapPoints}pt`;
  return `\\documentclass[letterpaper,10pt]{article}
\\usepackage[margin=${margin}]{geometry}
\\usepackage[T1]{fontenc}
${template.typography === 'sans' ? '\\renewcommand{\\familydefault}{\\sfdefault}' : ''}
${jake ? '\\linespread{0.99}' : ''}
\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\setlength{\\tabcolsep}{0pt}
\\raggedbottom
\\raggedright
\\newcommand{\\ResumeSection}[1]{\\vspace{${sectionBefore}}{\\large\\bfseries\\MakeUppercase{#1}}\\par\\vspace{1pt}\\hrule\\vspace{${sectionAfter}}}
\\newcommand{\\ResumeHeading}[4]{\\begin{tabular*}{\\textwidth}{@{}l@{\\extracolsep{\\fill}}r@{}}\\textbf{#1} & #2 \\\\ \\textit{#3} & \\textit{#4}\\end{tabular*}\\vspace{${entryContentGap}}}
\\newcommand{\\ResumeEducationCompact}[2]{\\textbf{#1}, #2\\par\\vspace{${bulletBlockGap}}}
\\newcommand{\\ResumeProject}[3]{\\textbf{#1}${profile.template === 'clean-standard' ? ' \\textit{#2}' : ' --- #2'}\\hfill #3\\par\\vspace{${entryContentGap}}}
\\newcommand{\\ResumeDetail}[1]{#1\\par\\vspace{${entryContentGap}}}
\\newcommand{\\ResumeSkill}[2]{\\textbf{#1:} #2\\par\\vspace{${entryContentGap}}}
\\newenvironment{ResumeBullets}{\\begin{list}{$\\bullet$}{\\setlength{\\leftmargin}{1.2em}\\setlength{\\itemsep}{${itemSep}}\\setlength{\\topsep}{${entryContentGap}}\\setlength{\\parsep}{0pt}\\setlength{\\partopsep}{0pt}}}{\\end{list}\\vspace{${bulletBlockGap}}}
`;
}

/** Emits audited structure only. User values are escaped and cannot select
 * packages, commands, files, or shell options. */
export function renderResumeLatex(profile: ResumeProfile, applicant: ApplicantProfile, draft: ResumeDraft, bankItems: ResumeBankItem[] = []): { tex: string; resumeSpecHash: string; document: ResumeDocument } {
  const document = buildResumeDocument(profile, applicant, draft, bankItems);
  const template = RESUME_TEMPLATES[profile.template];
  const contact = document.contact.map(({ value }) => tex(value)).join(' $|$ ');
  const body = template.sectionOrder.flatMap((section) => {
    const rendered = renderers[section](document);
    return rendered ? [`\\ResumeSection{${sectionTitle[section]}}\n${rendered}`] : [];
  }).join('\n');
  const source = `${templatePreamble(profile)}\\begin{document}
{\\centering{\\LARGE\\bfseries ${tex(document.name)}}\\par\\vspace{2pt}
{\\small ${contact}}\\par}\\vspace{2pt}
${body || '% No selected resume content.'}
\\end{document}\n`;
  return {
    tex: source,
    document,
    // The hash must address the rendered artifact bytes, not the requesting
    // draft or profile. Otherwise identical documents from the same base
    // recompile and store duplicate PDF/TeX/preview objects. `source` already
    // encodes the template, section order, and escaped content; the versions
    // force a rebuild when the template or compiler output changes.
    resumeSpecHash: createHash('sha256').update(JSON.stringify({ source, templateVersion: RESUME_TEMPLATE_VERSION, compilerVersion: RESUME_COMPILER_VERSION })).digest('hex'),
  };
}
