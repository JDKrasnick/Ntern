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

  it('extracts PDF text when browser geometry globals are unavailable', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrix');
    Reflect.deleteProperty(globalThis, 'DOMMatrix');
    try {
      await expect(extractResumeDocument(minimalPdf(['Projects', 'Built a production dashboard']), 'application/pdf')).resolves.toEqual([
        { kind: 'project', content: 'Built a production dashboard', sourceLocation: 'line 2' },
      ]);
    } finally {
      if (original) Object.defineProperty(globalThis, 'DOMMatrix', original);
      else Reflect.deleteProperty(globalThis, 'DOMMatrix');
    }
  });
});
