import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { extractResumeBankItems, extractResumeDocument } from '../src/resume-document.js';

describe('resume document extraction', () => {
  it('assigns source lines to unverified Master Bank categories', () => {
    expect(extractResumeBankItems('Experience\n• Built a TypeScript dashboard\nProjects\n• Created an accessibility audit\nSkills\nTypeScript, React\nEducation\nCornell University')).toEqual([
      { kind: 'role', content: 'Built a TypeScript dashboard', sourceLocation: 'line 2' },
      { kind: 'project', content: 'Created an accessibility audit', sourceLocation: 'line 4' },
      { kind: 'skill', content: 'TypeScript, React', sourceLocation: 'line 6' },
      { kind: 'education', content: 'Cornell University', sourceLocation: 'line 8' },
    ]);
  });

  it('extracts readable document.xml from a DOCX upload', async () => {
    const docx = zipSync({ 'word/document.xml': new TextEncoder().encode('<w:document><w:body><w:p><w:t>Projects</w:t></w:p><w:p><w:t>Built a TypeScript dashboard</w:t></w:p></w:body></w:document>') });
    await expect(extractResumeDocument(docx.buffer as ArrayBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).resolves.toEqual([
      { kind: 'project', content: 'Built a TypeScript dashboard', sourceLocation: 'line 2' },
    ]);
  });
});
