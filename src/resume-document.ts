import { unzipSync } from 'fflate';

export type ExtractedResumeItem = { kind: 'role' | 'project' | 'skill' | 'education' | 'bullet'; content: string; sourceLocation: string };

const cleanXml = (value: string) => value
  .replace(/<w:tab\/>/gu, ' ').replace(/<\/w:p>/gu, '\n').replace(/<[^>]+>/gu, '')
  .replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
  .replace(/[\t ]+/gu, ' ').replace(/\n\s*/gu, '\n').trim();

export function extractResumeBankItems(text: string, limit = 100): ExtractedResumeItem[] {
  let section: ExtractedResumeItem['kind'] = 'bullet';
  const items: ExtractedResumeItem[] = [];
  for (const [index, raw] of text.split(/\r?\n/gu).entries()) {
    const line = raw.replace(/\s+/gu, ' ').trim();
    if (!line) continue;
    const heading = line.toLowerCase().replace(/[^a-z]/gu, '');
    if (/(experience|employment|workhistory)/u.test(heading)) { section = 'role'; continue; }
    if (/(project|research)/u.test(heading)) { section = 'project'; continue; }
    if (/(skill|technology|tool)/u.test(heading)) { section = 'skill'; continue; }
    if (/(education|coursework)/u.test(heading)) { section = 'education'; continue; }
    const content = line.replace(/^(?:[-•*]|\d+[.)])\s*/u, '').trim();
    if (content.length < 2 || content.length > 2_000 || items.some((item) => item.content === content)) continue;
    items.push({ kind: section, content, sourceLocation: `line ${index + 1}` });
    if (items.length >= limit) break;
  }
  return items;
}

export async function extractResumeDocument(bytes: ArrayBuffer, contentType: string): Promise<ExtractedResumeItem[]> {
  const normalized = contentType.toLowerCase().split(';', 1)[0]!.trim();
  let text = '';
  if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const files = unzipSync(new Uint8Array(bytes));
    const documentXml = files['word/document.xml'];
    if (!documentXml) throw new Error('DOCX document text is missing');
    text = cleanXml(new TextDecoder().decode(documentXml));
  } else if (normalized === 'application/pdf') {
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdf.getDocument({ data: new Uint8Array(bytes) }).promise;
    try {
      const pages = await Promise.all(Array.from({ length: Math.min(document.numPages, 12) }, async (_, index) => {
        const content = await document.getPage(index + 1).then((page) => page.getTextContent());
        return content.items.flatMap((item) => 'str' in item && typeof item.str === 'string' ? [item.str] : []).join(' ');
      }));
      text = pages.join('\n');
    } finally { await document.destroy(); }
  } else throw new Error('Resume import accepts PDF or DOCX files');
  const items = extractResumeBankItems(text);
  if (!items.length) throw new Error('No readable resume facts were found. Add them to your Master Bank manually.');
  return items;
}
