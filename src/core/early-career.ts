import type { JobRequirements, RawListing } from '../types.js';

const entities: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
};

/** Decodes the small set of HTML entities ATS descriptions use, then strips markup. */
export function htmlToText(value: string | undefined): string {
  const decoded = (value ?? '').replace(/&(?:nbsp|amp|lt|gt|quot|#39|#x27|apos);/gi, (match) => entities[match.toLowerCase()] ?? match);
  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Title-led lifecycle signal. The catalog covers early-career hiring, so a
 * graduate or entry-level programme counts alongside an internship, co-op, or
 * apprenticeship. Boards post plurals ("AI Internships"), so plurals match too;
 * "internal" and "international" still fail the word boundary, and bare
 * "graduate" is excluded because it far more often marks a degree requirement
 * than a new-graduate role.
 */
export const lifecycleTitlePattern = new RegExp([
  String.raw`\b(?:interns?(?:hips?)?|co[ -]?ops?|cooperative education|apprentices?(?:hips?)?)\b`,
  String.raw`\bnew ?grad(?:uate)?s?\b`,
  String.raw`\b(?:university|campus|college)[ -](?:graduate|hire|programme?|program)\b`,
  String.raw`\bgraduate[ -](?:programme?|program|scheme|rotation(?:al)?|analyst|engineer\w*|developer|trainee|role|opportunit\w+)\b`,
  String.raw`\b(?:early[ -]career|entry[ -]level|working student|placement (?:year|student|programme?)|year in industry)\b`,
].join('|'), 'i');

export function hasLifecycleTitleSignal(title: string): boolean {
  return lifecycleTitlePattern.test(title);
}

const usCitizen = '(?:u\\.?s\\.?|united states)\\s+citizens?';
const degree = "(?:advanced degree|master'?s|ph\\.?d\\.?|doctorate|mba)";
const citizenshipPattern = new RegExp(`(?:\\b(?:must|requires?|requirement|eligible only|only)\\b[^.]{0,120}${usCitizen}|${usCitizen}[^.]{0,80}\\b(?:required|only|must)\\b)`, 'i');
const advancedDegreePattern = new RegExp(`(?:\\b(?:must|requires?|requirement|eligible only)\\b[^.]{0,120}${degree}|${degree}[^.]{0,80}\\b(?:required|must)\\b)`, 'i');

/** Conservative, source-declared citizenship/degree signals from decoded description text. */
export function earlyCareerRequirements(content: string): JobRequirements {
  return {
    requiresUsCitizenship: citizenshipPattern.test(content),
    advancedDegreeRequired: advancedDegreePattern.test(content),
  };
}

/**
 * A bare year is only a hiring season when it is plausibly one: descriptions
 * mention founding years and copyright dates, and a stray "2010" would otherwise
 * become part of the role's identity.
 */
/** Graduation requirements describe applicants, not the role's hiring season. */
export function hiringSeasonText(value: string): string {
  const graduation = /\b(?:graduat(?:es|ed|ing|ion)|graduate(?!\s+(?:students?|school|degree|program|intern|level)\b)|class of|degree completion)\b/iu;
  const hiring = /\b(?:internship|program|role|position|job)\s+(?:starts?|begins?)\b/iu;
  return value.split(/(?<=[.!?;])\s+|\n+/u).flatMap((sentence) =>
    sentence.split(/(?=\b(?:internship|program|role|position|job)\s+(?:starts?|begins?)\b)/iu),
  ).map((clause) => {
    const marker = graduation.exec(clause);
    if (!marker) return clause;
    // A start date before the graduation requirement remains role evidence.
    const start = hiring.exec(clause);
    return start && start.index < marker.index ? clause.slice(0, marker.index) : '';
  }).join('\n');
}

export function inferSeason(title: string, description: string, now = new Date()): string {
  const text = `${title} ${hiringSeasonText(description)}`;
  const multiSeason = text.match(/\b(?:winter|spring|summer|fall)\s*[/-]\s*(?:winter|spring|summer|fall)\s*(?:intern(?:ship)?\s*)?(20\d{2})\b/i);
  if (multiSeason) return `offseason-${multiSeason[1]}`;
  const season = text.match(/\b(summer|fall|spring|winter)\s*(?:intern(?:ship)?\s*)?(20\d{2})\b/i);
  if (season) return `${season[1].toLowerCase()}-${season[2]}`;
  const currentYear = now.getUTCFullYear();
  for (const match of text.matchAll(/\b(20\d{2})\b/g)) {
    const year = Number(match[1]);
    if (year >= currentYear && year <= currentYear + 3) return match[1]!;
  }
  return 'ongoing';
}

/** Month a named hiring season begins, so a cycle can be recognised as underway. */
const seasonStartMonth: Record<string, number> = { winter: 0, spring: 2, summer: 4, fall: 8 };

/**
 * A hiring cycle whose season has already begun is no longer something a student
 * can apply to, so the feed stops showing it. Seasons without a month —
 * "offseason-2026", a bare year, "ongoing" — only expire once their year has
 * passed, because they can still be filled later in that year.
 */
export function isPastSeason(season: string, now = new Date()): boolean {
  const currentYear = now.getUTCFullYear();
  const named = /^(winter|spring|summer|fall)-(20\d{2})$/i.exec(season);
  if (named) {
    const year = Number(named[2]);
    return year < currentYear || (year === currentYear && now.getUTCMonth() > seasonStartMonth[named[1]!.toLowerCase()]!);
  }
  const year = /^(?:offseason-)?(20\d{2})$/i.exec(season);
  return year ? Number(year[1]) < currentYear : false;
}

export function inferWorkMode(value: string | undefined): RawListing['workMode'] | undefined {
  if (!value) return undefined;
  if (/remote/i.test(value)) return 'remote';
  if (/hybrid/i.test(value)) return 'hybrid';
  if (/on.?site|in.?person/i.test(value)) return 'onsite';
  return undefined;
}
