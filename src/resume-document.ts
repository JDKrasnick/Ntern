import { unzipSync } from 'fflate';

export type ExtractedResumeItem = { kind: 'role' | 'project' | 'skill' | 'education' | 'bullet'; content: string; sourceLocation: string };

const cleanXml = (value: string) => value
  .replace(/<w:tab\/>/gu, ' ').replace(/<\/w:p>/gu, '\n').replace(/<[^>]+>/gu, '')
  .replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
  .replace(/[\t ]+/gu, ' ').replace(/\n\s*/gu, '\n').trim();

class TextExtractionDomMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: ArrayLike<number>) {
    if (init?.length === 6) {
      this.a = init[0] as number;
      this.b = init[1] as number;
      this.c = init[2] as number;
      this.d = init[3] as number;
      this.e = init[4] as number;
      this.f = init[5] as number;
    }
  }

  multiplySelf(other: TextExtractionDomMatrix) {
    const { a, b, c, d, e, f } = this;
    this.a = a * other.a + c * other.b;
    this.b = b * other.a + d * other.b;
    this.c = a * other.c + c * other.d;
    this.d = b * other.c + d * other.d;
    this.e = a * other.e + c * other.f + e;
    this.f = b * other.e + d * other.f + f;
    return this;
  }

  preMultiplySelf(other: TextExtractionDomMatrix) {
    const current = new TextExtractionDomMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
    const result = new TextExtractionDomMatrix([other.a, other.b, other.c, other.d, other.e, other.f]).multiplySelf(current);
    Object.assign(this, result);
    return this;
  }

  translate(x = 0, y = 0) {
    return new TextExtractionDomMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(new TextExtractionDomMatrix([1, 0, 0, 1, x, y]));
  }

  scale(x = 1, y = x) {
    return new TextExtractionDomMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(new TextExtractionDomMatrix([x, 0, 0, y, 0, 0]));
  }

  invertSelf() {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) throw new Error('Cannot invert a singular matrix');
    const { a, b, c, d, e, f } = this;
    this.a = d / determinant;
    this.b = -b / determinant;
    this.c = -c / determinant;
    this.d = a / determinant;
    this.e = (c * f - d * e) / determinant;
    this.f = (b * e - a * f) / determinant;
    return this;
  }
}

function ensurePdfTextExtractionGlobals() {
  if (!('DOMMatrix' in globalThis)) {
    Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, writable: true, value: TextExtractionDomMatrix });
  }
}

function pdfTextItemsToLines(items: readonly unknown[]) {
  const lines: string[] = [];
  let line: string[] = [];
  let lineY: number | undefined;
  const flush = () => {
    const value = line.join(' ').replace(/\s+/gu, ' ').trim();
    if (value) lines.push(value);
    line = [];
    lineY = undefined;
  };
  for (const value of items) {
    if (!value || typeof value !== 'object') continue;
    const item = value as { str?: unknown; transform?: unknown; hasEOL?: unknown };
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const transform = Array.isArray(item.transform) ? item.transform : undefined;
    const itemY = transform && typeof transform[5] === 'number' ? transform[5] : undefined;
    if (line.length && itemY !== undefined && lineY !== undefined && Math.abs(itemY - lineY) > 1) flush();
    line.push(item.str);
    if (itemY !== undefined) lineY = itemY;
    if (item.hasEOL === true) flush();
  }
  flush();
  return lines.join('\n');
}

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
    ensurePdfTextExtractionGlobals();
    const pdfWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as typeof globalThis & { pdfjsWorker?: typeof pdfWorker }).pdfjsWorker ??= pdfWorker;
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdf.getDocument({ data: new Uint8Array(bytes) }).promise;
    try {
      const pages = await Promise.all(Array.from({ length: Math.min(document.numPages, 12) }, async (_, index) => {
        const content = await document.getPage(index + 1).then((page) => page.getTextContent());
        return pdfTextItemsToLines(content.items);
      }));
      text = pages.join('\n');
    } finally { await document.destroy(); }
  } else throw new Error('Resume import accepts PDF or DOCX files');
  const items = extractResumeBankItems(text);
  if (!items.length) throw new Error('No readable resume facts were found. Add them to your Master Bank manually.');
  return items;
}
