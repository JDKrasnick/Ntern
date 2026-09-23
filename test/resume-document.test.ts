import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { extractResumeBankItems, extractResumeDocument } from '../src/resume-document.js';

function minimalPdf(lines: string[]) {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n${lines.map((line, index) => `${index ? '0 -18 Td\n' : ''}(${line.replace(/[()\\]/gu, '\\$&')}) Tj`).join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body).buffer;
}

describe('resume document extraction', () => {
  it('assigns source lines to Technical base categories', () => {
    expect(extractResumeBankItems('Experience\n• Built a TypeScript dashboard\nProjects\n• Created an accessibility audit\nSkills\nTypeScript, React\nEducation\nCornell University')).toEqual([
      { localId: 'line-2', kind: 'role', content: 'Built a TypeScript dashboard', details: { organization: 'Built a TypeScript dashboard' }, sourceLocation: 'line 2' },
      { localId: 'line-4', kind: 'project', content: 'Created an accessibility audit', details: { name: 'Created an accessibility audit', tagline: undefined, technologies: [] }, sourceLocation: 'line 4' },
      { localId: 'line-6', kind: 'skill', content: 'TypeScript, React', details: { category: 'Technical', skills: ['TypeScript', 'React'] }, sourceLocation: 'line 6' },
      { localId: 'line-8', kind: 'education', content: 'Cornell University', details: { institution: 'Cornell University' }, sourceLocation: 'line 8' },
    ]);
  });

  it('keeps multiple bullets attached to their extracted project parent', () => {
    expect(extractResumeBankItems('Projects\nCompiler Lab\n• Built a parser\n• Added type checking')).toEqual([
      { localId: 'line-2', kind: 'project', content: 'Compiler Lab', details: { name: 'Compiler Lab', tagline: undefined, technologies: [] }, sourceLocation: 'line 2' },
      { localId: 'line-3', kind: 'bullet', parent: { kind: 'project', localId: 'line-2' }, content: 'Built a parser', sourceLocation: 'line 3' },
      { localId: 'line-4', kind: 'bullet', parent: { kind: 'project', localId: 'line-2' }, content: 'Added type checking', sourceLocation: 'line 4' },
    ]);
  });

  it('extracts readable document.xml from a DOCX upload', async () => {
    const docx = zipSync({ 'word/document.xml': new TextEncoder().encode('<w:document><w:body><w:p><w:t>Projects</w:t></w:p><w:p><w:t>Built a TypeScript dashboard</w:t></w:p></w:body></w:document>') });
    await expect(extractResumeDocument(docx.buffer as ArrayBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).resolves.toEqual([
      { localId: 'line-2', kind: 'project', content: 'Built a TypeScript dashboard', details: { name: 'Built a TypeScript dashboard', tagline: undefined, technologies: [] }, sourceLocation: 'line 2' },
    ]);
  });

  it('extracts PDF text when browser geometry globals are unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrix');
    Reflect.deleteProperty(globalThis, 'DOMMatrix');
    try {
      await expect(extractResumeDocument(minimalPdf(['Projects', 'Built a production dashboard']), 'application/pdf')).resolves.toEqual([
        { localId: 'line-2', kind: 'project', content: 'Built a production dashboard', details: { name: 'Built a production dashboard', tagline: undefined, technologies: [] }, sourceLocation: 'line 2' },
      ]);
    } finally {
      if (original) Object.defineProperty(globalThis, 'DOMMatrix', original);
      else Reflect.deleteProperty(globalThis, 'DOMMatrix');
    }
  });

  it('keeps research distinct and pairs a parent heading with its typed subtitle', () => {
    expect(extractResumeBankItems('Research\nCornell University\nUndergraduate Researcher\n• Built a queueing simulator')).toEqual([
      { localId: 'line-2', kind: 'research', content: 'Cornell University | Undergraduate Researcher', details: { organization: 'Cornell University', title: 'Undergraduate Researcher' }, sourceLocation: 'line 2' },
      { localId: 'line-4', kind: 'bullet', parent: { kind: 'research', localId: 'line-2' }, content: 'Built a queueing simulator', sourceLocation: 'line 4' },
    ]);
  });
});
