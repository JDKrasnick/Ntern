import { parseCompensation } from './normalize.js';
import { providerPostingReference, type ProviderPostingReference } from '../identity/posting.js';
import type { RawListing } from '../types.js';

interface Table { headers: string[]; rows: Array<{ cells: string[]; row: number }>; }

function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let value = ''; let escaped = false;
  for (const char of body) {
    if (escaped) { value += char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (char === '|') { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}

function isSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function markdownTables(markdown: string): Table[] {
  const lines = markdown.replace(/\r/g, '').split('\n'); const result: Table[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index].includes('|') || !isSeparator(lines[index + 1])) continue;
    const headers = splitRow(lines[index]); const rows: Table['rows'] = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].includes('|') && !/^\s*$/.test(lines[cursor])) {
      const cells = splitRow(lines[cursor]);
      if (cells.length === headers.length) rows.push({ cells, row: cursor + 1 });
      cursor += 1;
    }
    result.push({ headers, rows }); index = cursor - 1;
  }
  return result;
}

function htmlCells(row: string): string[] {
  return [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => match[1].trim());
}

/** Offsets of every line start, so a byte offset maps to a 1-based line in O(log n). */
function lineStarts(markdown: string): number[] {
  const starts = [0];
  for (let index = markdown.indexOf('\n'); index >= 0; index = markdown.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}

/** Greatest line start at or before `offset`, 1-based — the line the offset sits on. */
function lineNumberAt(starts: number[], offset: number): number {
  let low = 0; let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle; else high = middle - 1;
  }
  return low + 1;
}

/** Supports source lists that use simple HTML tables while retaining their raw links. */
function htmlTables(markdown: string): Table[] {
  const result: Table[] = [];
  // One index for the whole document keeps row numbering linear; deriving it per
  // row re-scanned every preceding byte and dominated parse CPU on large boards.
  const starts = lineStarts(markdown);
  for (const table of markdown.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const body = table[1]; const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const headerAt = rows.findIndex((row) => /<th\b/i.test(row[1]));
    if (headerAt < 0) continue;
    const headers = htmlCells(rows[headerAt][1]);
    if (headers.length === 0) continue;
    const parsedRows: Table['rows'] = [];
    for (const row of rows.slice(headerAt + 1)) {
      const cells = htmlCells(row[1]);
      if (cells.length !== headers.length) continue;
      const start = (table.index ?? 0) + (row.index ?? 0);
      parsedRows.push({ cells, row: lineNumberAt(starts, start) });
    }
    result.push({ headers, rows: parsedRows });
  }
  return result;
}

function tables(markdown: string): Table[] {
  return [...markdownTables(markdown), ...htmlTables(markdown)];
}

function text(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function links(value: string): string[] {
  const values = [
    // Curated lists commonly render an Apply button as an image nested in a
    // Markdown link. Capture the outer destination before the image source.
    ...[...value.matchAll(/\[!\[[^\]]*\]\([^)]*\)\]\((https?:\/\/[^\s)]+)\)/gi)].map((m) => m[1]),
    ...[...value.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi)].map((m) => m[1]),
    ...[...value.matchAll(/<a\s+[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi)].map((m) => m[1]),
    ...[...value.matchAll(/(?<!["'(])(https?:\/\/[^\s<>)]+)/gi)].map((m) => m[1])
  ];
  return [...new Set(values.map((link) => link.replace(/&amp;/gi, '&').replace(/[),.;]+$/, '')).filter((link) => { try { return /^https?:$/.test(new URL(link).protocol); } catch { return false; } }))];
}

function indexOf(headers: string[], expressions: RegExp[]): number {
  return headers.findIndex((header) => expressions.some((expression) => expression.test(text(header).toLowerCase())));
}

export interface MarkdownParseOptions { sourceId: string; document: string; sourceUrl: string; season: string; fetchedAt?: string; }

/** Parses GFM and simple HTML tables; HTML is otherwise treated as inert text. */
export function parseInternshipMarkdown(markdown: string, options: MarkdownParseOptions): RawListing[] {
  const parsed: RawListing[] = []; let inheritedCompany = ''; let inheritedDestination: ProviderPostingReference | undefined;
  for (const table of tables(markdown)) {
    const companyAt = indexOf(table.headers, [/company|employer/]);
    const titleAt = indexOf(table.headers, [/role|position|title/]);
    const locationAt = indexOf(table.headers, [/location/]);
    // SpeedyApply calls its direct application-link column "Posting". Match
    // that exact header without treating a generic "Date Posted" column as an
    // application URL.
    const applyAt = indexOf(table.headers, [/apply|application/, /^link$/, /^posting$/]);
    const compensationAt = indexOf(table.headers, [/compensation|salary|pay/]);
    const dateAt = indexOf(table.headers, [/date|posted/]);
    if (companyAt < 0 || titleAt < 0 || applyAt < 0) continue;
    for (const row of table.rows) {
      const values = row.cells.map(text); const rawRow = row.cells.join(' ').toLowerCase();
      const closed = /\b(closed|inactive|filled|expired)\b/.test(rawRow) || rawRow.includes('🔒');
      const requirements = {
        requiresUsCitizenship: rawRow.includes('🇺🇸') || /\b(?:requires?|must be)\s+(?:a\s+)?(?:u\.?s\.?|united states)\s+citizen(?:ship)?\b/i.test(rawRow),
        advancedDegreeRequired: rawRow.includes('🎓') || /\b(?:advanced degree|master'?s|ph\.?d\.?|mba)\b/i.test(rawRow)
      };
      // The role cell sometimes carries the application link, but the row as a
      // whole must never be searched: a company cell linking to an aggregator
      // profile or an employer homepage is not an application URL.
      const title = values[titleAt] ?? ''; const applyUrl = links(row.cells[applyAt] ?? '')[0] ?? links(row.cells[titleAt] ?? '')[0];
      let company = values[companyAt] ?? '';
      const inherited = /^↳|^\u21b3/.test(company);
      let employerInheritance: RawListing['employerInheritance'];
      let currentDestination: ProviderPostingReference | undefined;
      try { if (applyUrl) currentDestination = providerPostingReference(applyUrl); } catch { /* Review handles malformed provider identity. */ }
      if (inherited) {
        company = inheritedCompany;
        employerInheritance = !inheritedDestination?.tenant || !currentDestination?.tenant
          || inheritedDestination.provider === 'unknown' || currentDestination.provider === 'unknown'
          ? 'unresolved'
          : inheritedDestination.provider === currentDestination.provider
            && inheritedDestination.tenant.toLowerCase() === currentDestination.tenant.toLowerCase()
            ? 'same-tenant' : 'conflict';
      } else if (company) {
        inheritedCompany = company;
        inheritedDestination = currentDestination;
      }
      if (!company || !title || !applyUrl) continue;
      parsed.push({
        sourceId: options.sourceId, document: options.document, sourceUrl: options.sourceUrl, row: row.row,
        company, title, location: locationAt >= 0 ? values[locationAt] || 'Unspecified' : 'Unspecified', season: options.season, applyUrl,
        employerLabelOrigin: inherited ? 'inherited' : 'explicit',
        ...(employerInheritance ? { employerInheritance } : {}),
        compensation: parseCompensation(compensationAt >= 0 ? values[compensationAt] ?? '' : ''), requirements, state: closed ? 'closed' : 'open',
        postedAt: dateAt >= 0 ? values[dateAt] || undefined : undefined, fetchedAt: options.fetchedAt ?? new Date().toISOString()
      });
    }
  }
  return parsed;
}
