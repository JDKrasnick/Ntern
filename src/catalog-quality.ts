import { createHash } from 'node:crypto';
import { canonicalCompanyKey, fingerprint } from './core/normalize.js';
import { normalizeSearchTitle } from './identity/enrichment.js';
import type { Compensation, Internship, JobRequirements, ProcessedListing, SourceOccurrence } from './types.js';

const COUNT_LOCATION = /^\s*\d+\s+locations?\s*$/iu;
const SPACE = /\s+/gu;

export function boundedText(value: string, maximum: number): string {
  const clean = value.normalize('NFC').replace(SPACE, ' ').trim();
  if ([...clean].length <= maximum) return clean;
  const slice = [...clean].slice(0, maximum + 1).join('');
  const boundary = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf(' – '), slice.lastIndexOf(' - '), slice.lastIndexOf(', '));
  return [...(boundary >= Math.floor(maximum * 0.65) ? slice.slice(0, boundary) : [...slice].slice(0, maximum).join(''))].slice(0, maximum).join('').trim();
}

function badgeRequirements(company: string, title: string): Partial<JobRequirements> {
  const value = `${company} ${title}`;
  return {
    ...(/🇺🇸|(?:us|u\.s\.)\s+citizenship(?:\s+required)?/iu.test(value) ? { requiresUsCitizenship: true } : {}),
    ...(/🎓|(?:master'?s|ph\.?d\.?|advanced degree)\s+(?:degree\s+)?required/iu.test(value) ? { advancedDegreeRequired: true } : {}),
  };
}

export function cleanBadgeText(value: string): string {
  return value
    .replace(/(?:🇺🇸|🎓)/gu, ' ')
    .replace(/(?:us|u\.s\.)\s+citizenship(?:\s+required)?/giu, ' ')
    .replace(/(?:(?:master'?s|ph\.?d\.?|advanced degree)\s+(?:degree\s+)?required)/giu, ' ')
    .replace(/\s*([|·•,;])(?:\s*[|·•,;])+\s*/gu, '$1 ')
    .replace(/^[\s|·•,;{}-]+|[\s|·•,;{}-]+$/gu, '')
    .replace(SPACE, ' ')
    .trim();
}

function canonicalLocation(value: string): string {
  const clean = boundedText(value, 120).replace(/\s*\((?:location)?\s*\d+\)\s*$/iu, '').trim();
  const key = clean.toLowerCase().replace(/[().]/gu, '').replace(SPACE, ' ');
  if (/^(?:nyc|new york city|new york,? ny)$/u.test(key)) return 'New York, NY';
  if (/^(?:sf|san francisco|san francisco,? ca)$/u.test(key)) return 'San Francisco, CA';
  if (/^(?:washington dc|washington,? d c|dc)$/u.test(key)) return 'Washington, DC';
  if (/^(?:remote(?:[- ]?(?:us|usa|united states))?|us(?:a)? remote|united states remote)$/u.test(key)) return 'Remote — US';
  return clean;
}

function removeRepeatedOuterLocationComponent(value: string): string {
  const parts = value.split(/\s*,\s*/u).filter(Boolean);
  if (parts.length < 3) return value;
  const first = parts[0]!.toLocaleLowerCase('en-US');
  const last = parts.at(-1)!.toLocaleLowerCase('en-US');
  return first === last ? parts.slice(1).join(', ') : value;
}

export function normalizeLocations(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const input of values) {
    for (const part of input.split(/\s*(?:\n|\||;|•|\s\/\s)\s*/u)) {
      if (!part || COUNT_LOCATION.test(part)) continue;
      const location = removeRepeatedOuterLocationComponent(canonicalLocation(part));
      if (!location || COUNT_LOCATION.test(location)) continue;
      const key = location.toLocaleLowerCase('en-US');
      if (!seen.has(key)) { seen.add(key); result.push(location); }
      if (result.length === 12) return result;
    }
  }
  return result;
}

export function locationSummary(locations: readonly string[]): string {
  const clean = normalizeLocations(locations);
  if (!clean.length) return 'Location not specified';
  const suffix = clean.length > 2 ? ` + ${clean.length - 2} more` : '';
  return boundedText(`${clean.slice(0, 2).join(' · ')}${suffix}`, 160);
}

type PayCandidate = { raw: string; min: number; max: number; period: 'hourly' | 'annual' };

function amount(value: string, suffix?: string): number {
  const parsed = Number(value.replace(/,/gu, ''));
  return suffix?.toLowerCase() === 'k' ? parsed * 1_000 : parsed;
}

export function normalizeCompensation(value: string): Compensation {
  const compact = value.replace(SPACE, ' ').trim();
  const candidates: PayCandidate[] = [];
  const expression = /\$\s*(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*([kK])?\s*(?:(?:-|–|—|to)\s*\$?\s*(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*([kK])?)?\s*(?:\/|per\s+)?(hour|hr|year|yr|annum|annual(?:ly)?)(?:\b|$)/giu;
  for (const match of compact.matchAll(expression)) {
    const prefix = compact.slice(Math.max(0, (match.index ?? 0) - 12), match.index).toUpperCase();
    if (/\b(?:CAD|AUD|NZD|SGD|HKD|EUR|GBP|JPY|CNY|INR)\s*$/u.test(prefix)) continue;
    const first = amount(match[1]!, match[2]);
    const second = match[3] ? amount(match[3], match[4]) : first;
    const period = /^(?:hour|hr)$/iu.test(match[5]!) ? 'hourly' : 'annual';
    const min = Math.min(first, second); const max = Math.max(first, second);
    const plausible = period === 'hourly' ? min >= 5 && max <= 500 : min >= 10_000 && max <= 1_000_000;
    if (plausible) candidates.push({ raw: match[0].trim(), min, max, period });
  }
  const distinctCandidates = [...new Map(candidates.map((item) => [
    `${item.period}\0${item.min}\0${item.max}`,
    item,
  ])).values()];
  const hourly = distinctCandidates.filter((item) => item.period === 'hourly');
  const annual = distinctCandidates.filter((item) => item.period === 'annual');
  const raw = boundedText([...new Set(candidates.map((item) => item.raw))].join(' · '), 160);
  const result: Compensation = { raw };
  if (hourly.length === 1) {
    result.minHourlyUSD = hourly[0]!.min;
    result.maxHourlyUSD = hourly[0]!.max;
  }
  if (annual.length === 1) {
    result.minAnnualUSD = annual[0]!.min;
    result.maxAnnualUSD = annual[0]!.max;
    if (!hourly.length) result.maxHourlyUSD = result.maxAnnualUSD / 2080;
  }
  return result;
}

function normalizeIdentity(
  identity: Internship['internshipIdentity'] | ProcessedListing['internshipIdentity'],
  originalCompany: string,
  company: string,
  title: string,
): Internship['internshipIdentity'] | ProcessedListing['internshipIdentity'] {
  if (!identity || typeof identity !== 'object') return identity;
  const record = identity as Record<string, unknown>;
  const companyIdentity = record.company && typeof record.company === 'object' ? record.company as Record<string, unknown> : undefined;
  const titleIdentity = record.title && typeof record.title === 'object' ? record.title as Record<string, unknown> : undefined;
  if (!companyIdentity && !titleIdentity) return identity;
  const text = (value: unknown) => typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string'
      ? (value as { value: string }).value
      : undefined;
  const replaceText = (value: unknown, replacement: string, fallback?: unknown) => typeof value === 'string'
    ? replacement
    : value && typeof value === 'object'
      ? { ...value, value: replacement }
      : typeof fallback === 'string'
        ? replacement
        : fallback && typeof fallback === 'object'
          ? { ...fallback, value: replacement }
          : value;
  const oldDisplayCompany = text(record.canonicalCompanyName) ?? text(companyIdentity?.displayName) ?? originalCompany;
  const updateCanonical = (value: unknown) => typeof value === 'string' && value === canonicalCompanyKey(oldDisplayCompany)
    ? canonicalCompanyKey(company)
    : value;
  const normalized: Record<string, unknown> = {
    ...record,
    ...(record.canonicalCompanyId !== undefined ? { canonicalCompanyId: updateCanonical(record.canonicalCompanyId) } : {}),
    ...(record.canonicalCompanyName !== undefined ? { canonicalCompanyName: replaceText(record.canonicalCompanyName, company) } : {}),
  };
  if (companyIdentity) {
    normalized.company = {
      ...companyIdentity,
      ...(companyIdentity.canonicalId !== undefined ? { canonicalId: updateCanonical(companyIdentity.canonicalId) } : {}),
      displayName: replaceText(companyIdentity.displayName, company, oldDisplayCompany),
    };
  }
  if (titleIdentity) {
    normalized.title = {
      ...titleIdentity,
      display: replaceText(titleIdentity.display, title, titleIdentity.official ?? title),
      search: replaceText(titleIdentity.search, normalizeSearchTitle(title), titleIdentity.display ?? titleIdentity.official ?? title),
    };
  }
  return normalized as Internship['internshipIdentity'] | ProcessedListing['internshipIdentity'];
}

export function normalizeListing<T extends ProcessedListing | SourceOccurrence>(listing: T): T {
  const badge = badgeRequirements(listing.company, listing.title);
  const company = boundedText(cleanBadgeText(listing.company), 160) || 'Unknown company';
  const title = boundedText(cleanBadgeText(listing.title), 240) || 'Role title unavailable';
  const locations = normalizeLocations(listing.locations?.length ? listing.locations : [listing.location]);
  return {
    ...listing,
    company,
    title,
    locations,
    location: locationSummary(locations),
    compensation: listing.compensation.ranges?.length ? listing.compensation : normalizeCompensation(listing.compensation.raw),
    ...('internshipIdentity' in listing && listing.internshipIdentity
      ? { internshipIdentity: normalizeIdentity(listing.internshipIdentity, listing.company, company, title) }
      : {}),
    requirements: {
      requiresUsCitizenship: Boolean(listing.requirements?.requiresUsCitizenship || badge.requiresUsCitizenship),
      advancedDegreeRequired: Boolean(listing.requirements?.advancedDegreeRequired || badge.advancedDegreeRequired),
    },
  };
}

export function normalizeInternship(job: Internship): Internship {
  const references = job.sourceReferences.map(normalizeListing);
  const normalized = normalizeListing({ ...job, sourceReferences: references } as Internship & ProcessedListing);
  return {
    ...job,
    company: normalized.company,
    title: normalized.title,
    locations: normalized.locations,
    location: normalized.location,
    compensation: normalized.compensation,
    requirements: normalized.requirements,
    ...(normalized.internshipIdentity ? { internshipIdentity: normalized.internshipIdentity } : {}),
    sourceReferences: references,
    fingerprint: fingerprint(normalized.company, normalized.title, normalized.location, job.season),
  };
}

export function catalogQualityHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
