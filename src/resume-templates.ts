import type { ResumeTemplate, ResumeTemplateId } from './resume.js';

export interface ResumeTemplateDefinition extends ResumeTemplate {
  description: string;
  bestFor: string;
  sectionOrder: Array<'education' | 'experience' | 'research' | 'projects' | 'skills'>;
  typography: 'serif' | 'sans';
  density: 'comfortable' | 'compact' | 'dense';
}

export const RESUME_TEMPLATE_VERSION = '2026-09-23.3';

export const RESUME_TEMPLATES: Readonly<Record<ResumeTemplateId, ResumeTemplateDefinition>> = {
  'jake-technical': {
    template: 'jake-technical', version: RESUME_TEMPLATE_VERSION, displayName: "Jake's Technical",
    description: 'Single-column, ATS-safe hierarchy with compact rules and paired title/date rows.',
    bestFor: 'Software, data, ML, and infrastructure roles',
    sectionOrder: ['education', 'experience', 'research', 'projects', 'skills'], typography: 'serif', density: 'dense',
  },
  'clean-standard': {
    template: 'clean-standard', version: RESUME_TEMPLATE_VERSION, displayName: 'Clean Standard',
    description: 'A quieter single-column layout with a little more breathing room.',
    bestFor: 'General technical and product roles',
    sectionOrder: ['experience', 'projects', 'education', 'skills', 'research'], typography: 'sans', density: 'comfortable',
  },
  'research-academic': {
    template: 'research-academic', version: RESUME_TEMPLATE_VERSION, displayName: 'Research First',
    description: 'Research and education lead while projects and engineering work remain fully structured.',
    bestFor: 'Labs, research engineering, and graduate opportunities',
    sectionOrder: ['education', 'research', 'experience', 'projects', 'skills'], typography: 'serif', density: 'compact',
  },
  'project-compact': {
    template: 'project-compact', version: RESUME_TEMPLATE_VERSION, displayName: 'Project Compact',
    description: 'The densest one-page option, with projects placed before employment.',
    bestFor: 'Students with substantial independent work',
    sectionOrder: ['education', 'projects', 'experience', 'research', 'skills'], typography: 'sans', density: 'dense',
  },
};

export const resumeTemplateList = () => Object.values(RESUME_TEMPLATES);
