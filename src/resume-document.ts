import { unzipSync } from 'fflate';
import type { ResumeBankDetailsByKind, ResumeBankParentKind, ResumeBankRootKind } from './resume.js';

export type ExtractedResumeItem =
  | { [Kind in ResumeBankRootKind]: { localId: string; kind: Kind; content: string; details?: ResumeBankDetailsByKind[Kind]; sourceLocation: string } }[ResumeBankRootKind]
  | { localId: string; kind: 'bullet'; parent: { kind: ResumeBankParentKind; localId: string }; content: string; sourceLocation: string };

const cleanXml = (value: string) => value
  .replace(/<w:tab\/>/gu, ' ').replace(/<\/w:p>/gu, '\n').replace(/<[^>]+>/gu, '')
  .replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
  .replace(/[\t ]+/gu, ' ').replace(/\n\s*/gu, '\n').trim();

const dateRangeAtEnd = /\s+((?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Spring|Summer|Fall|Winter)\s+)?\d{4}\s*(?:[-–—]\s*(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?(?:\d{4}|Present)|\(expected\)))$/iu;

function splitTrailing(value: string, pattern: RegExp) {
  const match = value.match(pattern);
  return match ? { text: value.slice(0, match.index).trim(), trailing: match[1]!.trim() } : { text: value.trim(), trailing: undefined };
}

function splitLocationAtEnd(value: string) {
  const match = value.match(/\s+([A-Z][A-Za-z.'-]+),\s*([A-Z]{2})$/u);
  if (!match) return { text: value.trim(), location: undefined };
  let text = value.slice(0, match.index).trim();
  let city = match[1]!;
  const compound = text.match(/\b(New|San|Los|Salt|Kansas)\s*$/u);
  if (compound) {
    city = `${compound[1]} ${city}`;
    text = text.slice(0, compound.index).trim();
  }
  return { text, location: `${city}, ${match[2]}` };
}

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

export function extractResumeBankItems(text: string, limit = 500): ExtractedResumeItem[] {
  let section: ResumeBankRootKind | undefined;
  let parent: { kind: ResumeBankParentKind; localId: string } | undefined;
  let awaitingSecondary = false;
  const items: ExtractedResumeItem[] = [];
  for (const [index, raw] of text.split(/\r?\n/gu).entries()) {
    const line = raw.replace(/\s+/gu, ' ').trim();
    if (!line) continue;
    const heading = line.toLowerCase().replace(/[^a-z]/gu, '');
    if (/^(?:reviewneeded|unresolved)$/u.test(heading)) { section = undefined; parent = undefined; awaitingSecondary = false; continue; }
    if (/^(?:professional)?(?:experience|employment|workhistory)(?:bank)?$/u.test(heading)) { section = 'role'; parent = undefined; awaitingSecondary = false; continue; }
    if (/^(?:projects?)(?:bank.*)?$/u.test(heading)) { section = 'project'; parent = undefined; awaitingSecondary = false; continue; }
    if (/^(?:research)(?:bank.*)?$/u.test(heading)) { section = 'research'; parent = undefined; awaitingSecondary = false; continue; }
    if (/^(?:technical)?(?:skill|skills|technology|technologies|tools)(?:masterinventory)?$/u.test(heading)) { section = 'skill'; parent = undefined; awaitingSecondary = false; continue; }
    if (/^(?:coreprofile(?:and)?)?(?:education|coursework)(?:bank)?$/u.test(heading)) { section = 'education'; parent = undefined; awaitingSecondary = false; continue; }
    if (!section) continue;
    const isBullet = /^(?:[-•*]|\d+[.)])\s*/u.test(line);
    let content = line.replace(/^(?:[-•*]|\d+[.)])\s*/u, '').trim();
    if (content.length < 2 || content.length > 2_000 || items.some((item) => item.content === content)) continue;
    const localId = `line-${index + 1}`;
    if (isBullet && parent) { items.push({ localId, kind: 'bullet', parent, content, sourceLocation: `line ${index + 1}` }); awaitingSecondary = false; }
    else {
      const last = items.at(-1);
      if (parent && !awaitingSecondary && last?.kind === 'bullet') {
        const projectHeading = section === 'project' && /\s[-—–]{1,2}\s/u.test(content);
        const likelyParentHeading = (section === 'role' || section === 'research') && content.length < 90 && /(?:,\s*[A-Z]{2}|\b(?:Remote|University|College|Institute|Laboratory|Lab))\s*$/u.test(content);
        if (!projectHeading && !likelyParentHeading) {
          const [continuation, possibleParent] = section === 'role' && content.includes(' | ') ? content.split(/\s+\|\s+(?=[^|]+$)/u) : [content];
          last.content = `${last.content} ${continuation}`;
          if (!possibleParent) continue;
          content = possibleParent;
        }
      }
      if (section === 'education' && parent && !awaitingSecondary && /^Relevant Coursework:/iu.test(content)) {
        const root = items.find((item) => item.localId === parent?.localId);
        if (root?.kind === 'education') root.details = { ...(root.details ?? { institution: root.content }), coursework: content.replace(/^Relevant Coursework:\s*/iu, '').split(',').map((value) => value.trim()).filter(Boolean) };
        continue;
      }
      if (section === 'education' && parent && !awaitingSecondary && !/(?:University|College|Academy|School|Institute)\b/iu.test(content)) {
        const root = items.find((item) => item.localId === parent?.localId);
        if (root?.kind === 'education' && root.details?.coursework?.length) {
          const coursework = [...root.details.coursework];
          coursework[coursework.length - 1] = `${coursework.at(-1)} ${content}`;
          root.details = { ...root.details, coursework };
          continue;
        }
      }
      if (parent && awaitingSecondary && (section === 'role' || section === 'research' || section === 'education')) {
        const root = items.find((item) => item.localId === parent?.localId);
        if (root && root.kind !== 'bullet') {
          root.content = `${root.content} | ${content}`;
          const dated = splitTrailing(content, dateRangeAtEnd);
          if (root.kind === 'role') root.details = { ...(root.details ?? { organization: root.content.split(' | ')[0]! }), title: dated.text, ...(dated.trailing ? { dateRange: dated.trailing } : {}) };
          if (root.kind === 'research') {
            const [title, advisor] = dated.text.split(/,\s*advised by\s+/iu);
            root.details = { ...(root.details ?? { organization: root.content.split(' | ')[0]! }), title: title?.trim(), ...(advisor?.trim() ? { advisor: advisor.trim() } : {}), ...(dated.trailing ? { dateRange: dated.trailing } : {}) };
          }
          if (root.kind === 'education') root.details = { ...(root.details ?? { institution: root.content.split(' | ')[0]! }), credential: dated.text, ...(dated.trailing ? { dateRange: dated.trailing } : {}) };
          awaitingSecondary = false;
          continue;
        }
      }
      if (section === 'role') {
        const located = splitLocationAtEnd(content);
        items.push({ localId, kind: section, content, details: { organization: located.text, ...(located.location ? { location: located.location } : {}) }, sourceLocation: `line ${index + 1}` });
      } else if (section === 'research') {
        const located = splitLocationAtEnd(content);
        items.push({ localId, kind: section, content, details: { organization: located.text, ...(located.location ? { location: located.location } : {}) }, sourceLocation: `line ${index + 1}` });
      }
      else if (section === 'project') {
        const match = content.match(/^(.*?)\s+(?:[-—–]{1,2})\s+(.*?)(?:\s+\(([^)]+)\))?$/u);
        items.push({ localId, kind: section, content, details: { name: match?.[1]?.trim() ?? content, tagline: match?.[2]?.trim(), technologies: match?.[3]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [] }, sourceLocation: `line ${index + 1}` });
      } else if (section === 'education') {
        const [institution, ...metadata] = content.split(/\s+\|\s+/u);
        const located = splitLocationAtEnd(metadata.join(' | '));
        const compactAwards = !located.location && /^Awards:/iu.test(located.text);
        if (compactAwards) {
          const schoolParts = institution!.split(',').map((value) => value.trim()).filter(Boolean);
          items.push({ localId, kind: section, content, details: { institution: schoolParts.shift()!, ...(schoolParts.length ? { credential: schoolParts.join(', ') } : {}), awards: located.text.replace(/^Awards:\s*/iu, '').split(',').map((value) => value.trim()).filter(Boolean) }, sourceLocation: `line ${index + 1}` });
        } else {
          const gpa = located.text.match(/(?:^|\|)\s*GPA:\s*([^|]+)/iu)?.[1]?.trim();
          const testScores = [...located.text.matchAll(/(?:^|\|)\s*((?:SAT|ACT|GRE|GMAT):\s*[^|]+)/giu)].map((match) => match[1]!.trim());
          items.push({ localId, kind: section, content, details: { institution: institution!.trim(), ...(located.location ? { location: located.location } : {}), ...(gpa ? { gpa } : {}), ...(testScores.length ? { testScores } : {}), ...(!gpa && !testScores.length && located.text ? { details: located.text } : {}) }, sourceLocation: `line ${index + 1}` });
        }
      }
      else {
        const [category, ...values] = content.split(':');
        items.push({ localId, kind: section, content, details: { category: values.length ? category!.trim() : 'Technical', skills: (values.length ? values.join(':') : content).split(',').map((value) => value.trim()).filter(Boolean) }, sourceLocation: `line ${index + 1}` });
      }
      parent = section === 'skill' ? undefined : { kind: section, localId };
      awaitingSecondary = section === 'role' || section === 'research' || section === 'education';
    }
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
